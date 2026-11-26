package content

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/platform/objectstorage"
)

type SaveRoomChatAttachmentInput struct {
	ConversationID       uuid.UUID
	AttachmentID         uuid.UUID
	ClientRequestID      uuid.UUID
	Scope                OwnerKind
	AllowStudentDownload *bool
}

type SaveRoomChatAttachmentResult struct {
	Document RoomDocument
	Created  bool
	cleanup  roomStorageCleanup
}

type roomChatAttachment struct {
	name, mediaType, backend string
	objectKey                string
	size                     int64
	inline                   []byte
}

type chatImportStorage interface {
	Head(context.Context, string) (objectstorage.Metadata, error)
	Get(context.Context, string) (objectstorage.Object, error)
	objectstorage.VersionReader
	PutVersioned(context.Context, string, io.Reader, int64, string) (objectstorage.PutResult, error)
}

type importObjectWriter func(context.Context, string) (objectstorage.PutResult, error)

type chatImportRepository interface {
	prepareChatImport(context.Context, AccessContext, SaveRoomChatAttachmentInput, []byte) (roomChatAttachment, *RoomDocument, error)
	finishChatImport(context.Context, AccessContext, SaveRoomChatAttachmentInput, uuid.UUID, VerificationResult, importObjectWriter, time.Time) (SaveRoomChatAttachmentResult, error)
}

func (input SaveRoomChatAttachmentInput) allowDownload() bool {
	if input.AllowStudentDownload != nil {
		return *input.AllowStudentDownload
	}
	return input.Scope == OwnerKindClass
}

func (input SaveRoomChatAttachmentInput) fingerprint(spaceID uuid.UUID) []byte {
	digest := sha256.New()
	digest.Write([]byte("tutorhub.room-document-from-chat.v1\x00"))
	digest.Write(spaceID[:])
	digest.Write(input.ConversationID[:])
	digest.Write(input.AttachmentID[:])
	digest.Write([]byte(input.Scope))
	if input.allowDownload() {
		digest.Write([]byte{1})
	} else {
		digest.Write([]byte{0})
	}
	return digest.Sum(nil)
}

func (service *Service) SaveRoomChatAttachment(ctx context.Context, access AccessContext, spaceID uuid.UUID, input SaveRoomChatAttachmentInput) (SaveRoomChatAttachmentResult, error) {
	if service == nil {
		return SaveRoomChatAttachmentResult{}, ErrUnavailable
	}
	if !validAccess(access) {
		return SaveRoomChatAttachmentResult{}, ErrAccessDenied
	}
	if input.Scope == "" {
		input.Scope = OwnerKindMediaSpace
	}
	if input.AttachmentID == uuid.Nil || input.ConversationID == uuid.Nil || input.ClientRequestID == uuid.Nil ||
		(input.Scope != OwnerKindMediaSpace && input.Scope != OwnerKindClass) {
		return SaveRoomChatAttachmentResult{}, ErrInvalidInput
	}
	repo, ok := service.repository.(chatImportRepository)
	if !ok {
		return SaveRoomChatAttachmentResult{}, ErrUnavailable
	}
	access, _, err := service.roomAccess(ctx, access, spaceID)
	if err != nil {
		return SaveRoomChatAttachmentResult{}, err
	}
	if !access.room.canManage {
		return SaveRoomChatAttachmentResult{}, ErrNotFound
	}
	fingerprint := input.fingerprint(spaceID)
	// Bound all in-flight source buffers, including inline bytes read from PostgreSQL.
	select {
	case service.verifySlots <- struct{}{}:
		defer func() { <-service.verifySlots }()
	case <-ctx.Done():
		return SaveRoomChatAttachmentResult{}, ErrUnavailable
	}
	attachment, replay, err := repo.prepareChatImport(ctx, access, input, fingerprint)
	if err != nil {
		return SaveRoomChatAttachmentResult{}, normalizeRepositoryError(err)
	}
	if replay != nil {
		return SaveRoomChatAttachmentResult{Document: *replay}, nil
	}
	if !IsViewerMediaType(attachment.mediaType) || attachment.size < 1 || attachment.size > ViewerImageMaxBytes {
		return SaveRoomChatAttachmentResult{}, ErrDocumentUnsupported
	}
	name, err := normalizeDisplayName(attachment.name)
	if err != nil {
		return SaveRoomChatAttachmentResult{}, err
	}
	store, ok := service.storage.(chatImportStorage)
	if !ok {
		return SaveRoomChatAttachmentResult{}, ErrStorageUnavailable
	}
	contents, err := attachment.read(ctx, store, access.TenantID, input.AttachmentID)
	if err != nil {
		return SaveRoomChatAttachmentResult{}, err
	}
	digest := sha256.Sum256(contents)
	verified, err := VerifyViewerDocument(bytes.NewReader(contents), attachment.mediaType, attachment.size, digest[:])
	if err != nil || !verified.Ready {
		return SaveRoomChatAttachmentResult{}, ErrDocumentUnsupported
	}
	fileID, now := uuid.New(), service.now().UTC()
	command := CreateCommand{
		ID: fileID, DisplayName: name, DeclaredMediaType: attachment.mediaType,
		ExpectedSizeBytes: attachment.size, ChecksumSHA256: verified.StoredChecksum,
		ClientRequestID: input.ClientRequestID, RequestFingerprint: fingerprint,
		ObjectKey: fmt.Sprintf("tenants/%s/files/%s/original", access.TenantID, fileID),
		CreatedAt: now, UploadExpiresAt: now.Add(uploadIntentTTL), OwnerKind: input.Scope,
		DenyStudentDownload: !input.allowDownload(), RequireClassroomFiles: true,
	}
	if input.Scope == OwnerKindClass {
		command.ClassID = access.room.classID
	} else {
		expires := now.Add(roomDocumentRetention)
		command.ExpiresAt, command.MediaSpaceID = &expires, spaceID
	}
	intent, err := service.repository.CreateIntent(ctx, access, command)
	if err != nil {
		return SaveRoomChatAttachmentResult{}, normalizeRepositoryError(err)
	}
	write := func(writeCtx context.Context, key string) (objectstorage.PutResult, error) {
		return ensureChatImportObject(writeCtx, store, key, attachment.mediaType, contents, verified.StoredChecksum)
	}
	result, err := repo.finishChatImport(ctx, access, input, intent.File.ID, verified, write, service.now().UTC())
	if result.cleanup.version != "" {
		service.cleanupRoomObject(context.WithoutCancel(ctx), result.cleanup)
	}
	return result, normalizeRepositoryError(err)
}

func (attachment roomChatAttachment) read(ctx context.Context, store chatImportStorage, tenantID, attachmentID uuid.UUID) ([]byte, error) {
	if attachment.backend == "inline_dev" {
		if int64(len(attachment.inline)) != attachment.size {
			return nil, ErrStorageMismatch
		}
		return attachment.inline, nil
	}
	if attachment.backend != "b2" || attachment.objectKey != fmt.Sprintf("tenants/%s/chat-attachments/%s", tenantID, attachmentID) {
		return nil, ErrStorageMismatch
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	object, err := store.Get(ctx, attachment.objectKey)
	if err != nil || object.Body == nil {
		return nil, ErrStorageUnavailable
	}
	defer object.Body.Close()
	if object.ContentLength >= 0 && object.ContentLength != attachment.size {
		return nil, ErrStorageMismatch
	}
	contents, err := io.ReadAll(io.LimitReader(object.Body, attachment.size+1))
	if err != nil {
		return nil, ErrStorageUnavailable
	}
	if int64(len(contents)) != attachment.size {
		return nil, ErrStorageMismatch
	}
	return contents, nil
}

// A persisted intent can survive either a lost PUT response or a failed DB
// commit. Only a definite absence permits another write. If HEAD carries no
// SHA-256, hash the exact returned version before adopting it.
func ensureChatImportObject(ctx context.Context, store chatImportStorage, key, mediaType string, contents, checksum []byte) (objectstorage.PutResult, error) {
	size := int64(len(contents))
	head, err := store.Head(ctx, key)
	if errors.Is(err, objectstorage.ErrObjectNotFound) {
		proof, err := store.PutVersioned(ctx, key, bytes.NewReader(contents), size, mediaType)
		if err != nil || !validObservedStorageProof(proof.VersionID) || !validObservedStorageProof(proof.ETag) {
			return objectstorage.PutResult{}, ErrStorageUnavailable
		}
		return proof, nil
	}
	if err != nil {
		return objectstorage.PutResult{}, ErrStorageUnavailable
	}
	if head.ContentLength != size || head.ContentType != mediaType || !validObservedStorageProof(head.VersionID) || !validObservedStorageProof(head.ETag) {
		return objectstorage.PutResult{}, ErrStorageMismatch
	}
	actual := head.ChecksumSHA256
	if len(actual) == 0 {
		object, err := store.GetVersion(ctx, key, head.VersionID)
		if err != nil || object.Body == nil {
			return objectstorage.PutResult{}, ErrStorageUnavailable
		}
		defer object.Body.Close()
		if object.VersionID != head.VersionID {
			return objectstorage.PutResult{}, ErrStorageMismatch
		}
		digest := sha256.New()
		length, err := io.Copy(digest, io.LimitReader(object.Body, size+1))
		if err != nil {
			return objectstorage.PutResult{}, ErrStorageUnavailable
		}
		if length != size {
			return objectstorage.PutResult{}, ErrStorageMismatch
		}
		actual = digest.Sum(nil)
	}
	if !bytes.Equal(actual, checksum) {
		return objectstorage.PutResult{}, ErrStorageMismatch
	}
	return objectstorage.PutResult{VersionID: head.VersionID, ETag: head.ETag}, nil
}
