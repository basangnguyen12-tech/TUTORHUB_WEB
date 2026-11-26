package content

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/modules/media"
	"github.com/tutorhub-v2/core-api/internal/platform/objectstorage"
)

// ROOM-TOOLS-FILES-01A (ADR-0045 §2): room document library and the
// P3-10-PDF/Image readiness verifier lifecycle.
const (
	roomDocumentRetention          = 30 * 24 * time.Hour
	roomViewCapabilityTTL          = 5 * time.Minute
	verificationTimeout            = 90 * time.Second
	verificationStaleAfter         = 2 * time.Minute
	maximumConcurrentVerifications = 2
	maximumVerificationBatch       = 25
	roomDocumentCursorPrefix       = "thrd1_"
)

// withFileRoom attaches the server-derived room grant when a file is owned by
// a MediaSpace. Class files keep the class policy path unchanged; an unknown
// file proceeds without a grant so the repository conceals it uniformly.
func (service *Service) withFileRoom(
	ctx context.Context,
	access AccessContext,
	fileID uuid.UUID,
) (AccessContext, error) {
	access.room = nil
	if service.rooms == nil || service.spaces == nil {
		return access, nil
	}
	owner, err := service.rooms.FileOwner(ctx, access.TenantID, fileID)
	if errors.Is(err, ErrNotFound) {
		return access, nil
	}
	if err != nil {
		return AccessContext{}, ErrUnavailable
	}
	if owner.Kind != OwnerKindMediaSpace || owner.MediaSpaceID == uuid.Nil {
		return access, nil
	}
	scoped, _, err := service.roomAccess(ctx, access, owner.MediaSpaceID)
	if errors.Is(err, ErrNotFound) {
		return access, nil
	}
	return scoped, err
}

// roomAccess re-derives room authority from the current MediaSpace (which
// already conceals spaces the actor cannot see), its active RoomInstance,
// dynamic co-host assignments, admitted participant sessions and the linked
// class roles.
func (service *Service) roomAccess(
	ctx context.Context,
	access AccessContext,
	spaceID uuid.UUID,
) (AccessContext, media.MediaSpace, error) {
	access.room = nil
	if service.rooms == nil || service.spaces == nil {
		return AccessContext{}, media.MediaSpace{}, ErrUnavailable
	}
	if spaceID == uuid.Nil {
		return AccessContext{}, media.MediaSpace{}, ErrNotFound
	}
	space, err := service.spaces.GetSpace(ctx, media.AccessContext{
		TenantID: access.TenantID, ActorID: access.ActorID,
		MembershipActive: access.MembershipActive, OrganizationRoles: access.OrganizationRoles,
	}, spaceID)
	if err != nil {
		if errors.Is(err, media.ErrSpaceNotFound) || errors.Is(err, media.ErrSpaceAccessDenied) ||
			errors.Is(err, media.ErrSourceUnavailable) || errors.Is(err, media.ErrInvalidSpaceRequest) {
			return AccessContext{}, media.MediaSpace{}, ErrNotFound
		}
		return AccessContext{}, media.MediaSpace{}, ErrUnavailable
	}
	if space.ID != spaceID {
		return AccessContext{}, media.MediaSpace{}, ErrNotFound
	}
	roomID := activeRoomID(space)
	classID := linkedClassID(space)
	state, err := service.rooms.RoomViewerState(ctx, access, spaceID, roomID, classID)
	if err != nil {
		return AccessContext{}, media.MediaSpace{}, normalizeRepositoryError(err)
	}
	grant := computeRoomGrant(space, state)
	access.room = &grant
	return access, space, nil
}

// computeRoomGrant is the fixed ADR-0045 matrix: organization admins, hosts,
// co-hosts (original or promoted in the active RoomInstance), teaching
// assistants and linked-class teaching staff manage room documents; other
// participants view only while admitted to the active RoomInstance.
func computeRoomGrant(space media.MediaSpace, state RoomViewerState) roomGrant {
	operations := space.ViewerOperations
	manage := state.OrganizationAdmin || state.ClassStaff ||
		space.ViewerRole == media.InstanceRoleHost || space.ViewerRole == media.InstanceRoleCoHost ||
		space.ViewerRole == media.InstanceRoleTeachingAssistant ||
		(state.RoomActive && state.DynamicCoHost) ||
		operations.CanStart || operations.CanEnd || operations.CanCancel ||
		operations.CanManageAdmissions || operations.CanManageInvites
	view := manage || (activeRoomID(space) != uuid.Nil && state.RoomActive && state.ActiveParticipant)
	return roomGrant{
		spaceID: space.ID, classID: linkedClassID(space), canManage: manage, canView: view,
		writable: space.Status == media.SpaceStatusScheduled || space.Status == media.SpaceStatusOpen,
	}
}

func activeRoomID(space media.MediaSpace) uuid.UUID {
	if space.ActiveRoomInstance == nil || space.ActiveRoomInstance.Status != media.RoomInstanceActive {
		return uuid.Nil
	}
	return space.ActiveRoomInstance.ID
}

func linkedClassID(space media.MediaSpace) uuid.UUID {
	if space.Source.ClassID == nil {
		return uuid.Nil
	}
	return *space.Source.ClassID
}

func (service *Service) ListRoomDocuments(
	ctx context.Context,
	access AccessContext,
	spaceID uuid.UUID,
	input ListFilesInput,
) (RoomDocumentPage, error) {
	if service == nil {
		return RoomDocumentPage{}, fmt.Errorf("list room documents: service is unavailable")
	}
	if !validAccess(access) {
		return RoomDocumentPage{}, ErrAccessDenied
	}
	if input.Limit == 0 {
		input.Limit = defaultFileListLimit
	}
	if input.Limit < 1 || input.Limit > maximumFileListLimit {
		return RoomDocumentPage{}, ErrInvalidInput
	}
	after, err := decodeRoomDocumentCursor(strings.TrimSpace(input.Cursor), access.TenantID, spaceID)
	if err != nil {
		return RoomDocumentPage{}, err
	}
	access, _, err = service.roomAccess(ctx, access, spaceID)
	if err != nil {
		return RoomDocumentPage{}, err
	}
	result, err := service.rooms.ListRoomDocuments(ctx, access, RoomDocumentListParams{
		SpaceID: spaceID, Limit: input.Limit, After: after, Now: service.now().UTC(),
	})
	if err != nil {
		return RoomDocumentPage{}, normalizeRepositoryError(err)
	}
	page := RoomDocumentPage{Items: result.Items, ViewerAccess: result.ViewerAccess}
	if page.Items == nil {
		page.Items = []RoomDocument{}
	}
	if result.HasMore && len(result.Items) > 0 {
		last := result.Items[len(result.Items)-1]
		page.NextCursor, err = encodeRoomDocumentCursor(
			FileCursor{CreatedAt: last.CreatedAt, ID: last.ID}, access.TenantID, spaceID,
		)
		if err != nil {
			return RoomDocumentPage{}, fmt.Errorf("encode next room document cursor: %w", err)
		}
	}
	return page, nil
}

func (service *Service) CreateRoomDocumentIntent(
	ctx context.Context,
	access AccessContext,
	spaceID uuid.UUID,
	input RoomDocumentIntentInput,
) (CreateIntentResult, error) {
	if service == nil {
		return CreateIntentResult{}, fmt.Errorf("create room document intent: service is unavailable")
	}
	if !validAccess(access) {
		return CreateIntentResult{}, ErrAccessDenied
	}
	if input.Scope == "" {
		input.Scope = OwnerKindMediaSpace
	}
	if (input.Scope != OwnerKindMediaSpace && input.Scope != OwnerKindClass) ||
		input.ClientRequestID == uuid.Nil || input.ExpectedSizeBytes < 1 {
		return CreateIntentResult{}, ErrInvalidInput
	}
	displayName, err := normalizeDisplayName(input.DisplayName)
	if err != nil {
		return CreateIntentResult{}, err
	}
	mediaType, err := normalizeMediaType(input.DeclaredMediaType)
	if err != nil {
		return CreateIntentResult{}, err
	}
	limit, viewer := viewerSizeLimit(mediaType)
	if !viewer || input.ExpectedSizeBytes > limit {
		return CreateIntentResult{}, ErrDocumentUnsupported
	}
	checksum, err := decodeChecksum(input.ChecksumSHA256)
	if err != nil {
		return CreateIntentResult{}, err
	}
	access, space, err := service.roomAccess(ctx, access, spaceID)
	if err != nil {
		return CreateIntentResult{}, err
	}
	if !access.room.canManage {
		return CreateIntentResult{}, ErrNotFound
	}
	fileID := uuid.New()
	now := service.now().UTC()
	command := CreateCommand{
		ID: fileID, DisplayName: displayName, DeclaredMediaType: mediaType,
		ExpectedSizeBytes: input.ExpectedSizeBytes, ChecksumSHA256: checksum,
		ClientRequestID: input.ClientRequestID,
		ObjectKey:       fmt.Sprintf("tenants/%s/files/%s/original", access.TenantID, fileID),
		CreatedAt:       now, UploadExpiresAt: now.Add(uploadIntentTTL),
		OwnerKind: input.Scope, RequireClassroomFiles: true,
	}
	if input.Scope == OwnerKindClass {
		classID := linkedClassID(space)
		if classID == uuid.Nil {
			return CreateIntentResult{}, ErrInvalidInput
		}
		command.ClassID = classID
		command.DenyStudentDownload = input.AllowStudentDownload != nil && !*input.AllowStudentDownload
	} else {
		command.MediaSpaceID = spaceID
		command.DenyStudentDownload = input.AllowStudentDownload == nil || !*input.AllowStudentDownload
		expiresAt := now.Add(roomDocumentRetention)
		command.ExpiresAt = &expiresAt
	}
	command.RequestFingerprint = roomDocumentRequestFingerprint(command, spaceID)
	result, err := service.repository.CreateIntent(ctx, access, command)
	return result, normalizeRepositoryError(err)
}

// roomDocumentRequestFingerprint binds an idempotent room intent to its room,
// owner scope and download policy in a domain separate from class intents.
func roomDocumentRequestFingerprint(command CreateCommand, spaceID uuid.UUID) []byte {
	digest := sha256.New()
	_, _ = digest.Write([]byte("tutorhub.room-document.v1\x00"))
	_, _ = digest.Write(spaceID[:])
	_, _ = digest.Write([]byte(command.OwnerKind))
	_, _ = digest.Write([]byte{0})
	if command.DenyStudentDownload {
		_, _ = digest.Write([]byte{0})
	} else {
		_, _ = digest.Write([]byte{1})
	}
	_, _ = digest.Write(requestFingerprint(command))
	return digest.Sum(nil)
}

func (service *Service) IssueRoomDocumentViewCapability(
	ctx context.Context,
	access AccessContext,
	spaceID uuid.UUID,
	fileID uuid.UUID,
) (RoomDocumentViewCapability, error) {
	if service == nil {
		return RoomDocumentViewCapability{}, fmt.Errorf("issue room view capability: service is unavailable")
	}
	if !validAccess(access) {
		return RoomDocumentViewCapability{}, ErrAccessDenied
	}
	if fileID == uuid.Nil {
		return RoomDocumentViewCapability{}, ErrNotFound
	}
	access, _, err := service.roomAccess(ctx, access, spaceID)
	if err != nil {
		return RoomDocumentViewCapability{}, err
	}
	now := service.now().UTC()
	target, err := service.rooms.PrepareRoomView(ctx, access, spaceID, fileID, now)
	if err != nil {
		return RoomDocumentViewCapability{}, normalizeRepositoryError(err)
	}
	presigned, err := service.storage.PresignDownload(ctx, objectstorage.DownloadPresignInput{
		Key: target.ObjectKey, VersionID: target.VersionID, ContentType: target.MediaType,
		ContentDisposition: "inline", Expires: roomViewCapabilityTTL,
	})
	if err != nil {
		return RoomDocumentViewCapability{}, fmt.Errorf("%w: presign room view", ErrStorageUnavailable)
	}
	if presigned.Method != http.MethodGet || strings.TrimSpace(presigned.URL) == "" {
		return RoomDocumentViewCapability{}, fmt.Errorf("%w: invalid room view capability", ErrStorageUnavailable)
	}
	return RoomDocumentViewCapability{
		Method: presigned.Method, URL: presigned.URL, ExpiresAt: now.Add(roomViewCapabilityTTL),
		VersionID: target.VersionID, ContentLengthBytes: target.ContentLengthBytes,
		SHA256: hex.EncodeToString(target.SHA256), MediaType: target.MediaType,
		PageCount: target.PageCount, FirstPageAspect: target.FirstPageAspect,
		ActiveContent: target.ActiveContent,
	}, nil
}

// DescribeRoomDocument returns the bounded metadata of one ready room viewer
// document under exactly the same authorization as
// IssueRoomDocumentViewCapability, without presigning any storage URL.
func (service *Service) DescribeRoomDocument(
	ctx context.Context,
	access AccessContext,
	spaceID uuid.UUID,
	fileID uuid.UUID,
) (RoomDocumentDescriptor, error) {
	if service == nil {
		return RoomDocumentDescriptor{}, fmt.Errorf("describe room document: service is unavailable")
	}
	if !validAccess(access) {
		return RoomDocumentDescriptor{}, ErrAccessDenied
	}
	if fileID == uuid.Nil {
		return RoomDocumentDescriptor{}, ErrNotFound
	}
	access, _, err := service.roomAccess(ctx, access, spaceID)
	if err != nil {
		return RoomDocumentDescriptor{}, err
	}
	target, err := service.rooms.PrepareRoomView(ctx, access, spaceID, fileID, service.now().UTC())
	if err != nil {
		return RoomDocumentDescriptor{}, normalizeRepositoryError(err)
	}
	return RoomDocumentDescriptor{
		FileID: fileID, VersionID: target.VersionID, DisplayName: target.DisplayName,
		MediaType: target.MediaType, ContentLengthBytes: target.ContentLengthBytes,
		PageCount: target.PageCount, FirstPageAspect: target.FirstPageAspect,
		ActiveContent: target.ActiveContent, AllowStudentDownload: target.AllowStudentDownload,
	}, nil
}

func (service *Service) UpdateRoomDocument(
	ctx context.Context,
	access AccessContext,
	spaceID uuid.UUID,
	fileID uuid.UUID,
	input UpdateRoomDocumentInput,
) (UpdateRoomDocumentResult, error) {
	if service == nil {
		return UpdateRoomDocumentResult{}, fmt.Errorf("update room document: service is unavailable")
	}
	if !validAccess(access) {
		return UpdateRoomDocumentResult{}, ErrAccessDenied
	}
	if fileID == uuid.Nil {
		return UpdateRoomDocumentResult{}, ErrNotFound
	}
	if input.ExpectedVersion < 1 || input.Deleted == (input.AllowStudentDownload != nil) {
		return UpdateRoomDocumentResult{}, ErrInvalidInput
	}
	access, _, err := service.roomAccess(ctx, access, spaceID)
	if err != nil {
		return UpdateRoomDocumentResult{}, err
	}
	if !access.room.canManage {
		return UpdateRoomDocumentResult{}, ErrNotFound
	}
	result, err := service.rooms.UpdateRoomDocument(ctx, access, spaceID, fileID, input, service.now().UTC())
	return result, normalizeRepositoryError(err)
}

// verifyFinalized runs the readiness verifier for viewer media types right
// after finalize so the caller receives ready or rejected in one round trip.
// Transient failures keep the committed file and leave recovery to
// VerifyPendingBatch; finalize itself never fails because of verification.
func (service *Service) verifyFinalized(ctx context.Context, access AccessContext, file File) File {
	if file.Status != StatusUploaded || !IsViewerMediaType(file.DeclaredMediaType) ||
		service.verifications == nil || service.versions == nil {
		return file
	}
	target, claimed, err := service.verifications.ClaimVerification(
		ctx, access.TenantID, file.ID, service.now().UTC(),
	)
	if err != nil || !claimed {
		return service.refreshFile(ctx, access, file)
	}
	_ = service.verifyTarget(ctx, target)
	return service.refreshFile(ctx, access, file)
}

func (service *Service) refreshFile(ctx context.Context, access AccessContext, file File) File {
	refreshed, err := service.repository.Get(ctx, access, file.ID)
	if err != nil {
		return file
	}
	return refreshed
}

// verifyTarget streams the exact persisted version and records the outcome.
// It returns an error only for transient failures; the row then stays
// processing until the recovery batch reclaims it.
func (service *Service) verifyTarget(ctx context.Context, target VerificationTarget) error {
	if service.verifications == nil || service.versions == nil {
		return ErrUnavailable
	}
	verifyContext, cancel := context.WithTimeout(ctx, verificationTimeout)
	defer cancel()
	result, err := service.inspectTarget(verifyContext, target)
	if err != nil {
		return err
	}
	_, err = service.verifications.CompleteVerification(verifyContext, target, result, service.now().UTC())
	return err
}

func (service *Service) inspectTarget(ctx context.Context, target VerificationTarget) (VerificationResult, error) {
	limit, ok := viewerSizeLimit(target.DeclaredMediaType)
	if !ok {
		return VerificationResult{}, errNotViewerMediaType
	}
	if target.ExpectedSizeBytes > limit {
		return rejected(RejectFileTooLargeForViewer), nil
	}
	if target.StorageVersionID == "" || target.ObjectKey == "" {
		return VerificationResult{}, ErrStorageUnavailable
	}
	select {
	case service.verifySlots <- struct{}{}:
		defer func() { <-service.verifySlots }()
	case <-ctx.Done():
		return VerificationResult{}, ctx.Err()
	}
	object, err := service.versions.GetVersion(ctx, target.ObjectKey, target.StorageVersionID)
	if err != nil {
		return VerificationResult{}, fmt.Errorf("%w: read object version", ErrStorageUnavailable)
	}
	defer object.Body.Close()
	if object.VersionID != "" && object.VersionID != target.StorageVersionID {
		return VerificationResult{}, ErrStorageMismatch
	}
	return VerifyViewerDocument(
		object.Body, target.DeclaredMediaType, target.ExpectedSizeBytes, target.ExpectedChecksum,
	)
}

// VerifyPendingBatch recovers viewer files stuck in uploaded/processing (for
// example after a restart). It returns how many outcomes were persisted.
func (service *Service) VerifyPendingBatch(ctx context.Context, limit int) (int, error) {
	if service == nil || service.verifications == nil || service.versions == nil {
		return 0, nil
	}
	if limit < 1 || limit > maximumVerificationBatch {
		limit = maximumVerificationBatch
	}
	now := service.now().UTC()
	targets, err := service.verifications.ClaimStaleVerifications(
		ctx, limit, now.Add(-verificationStaleAfter), now,
	)
	if err != nil {
		return 0, err
	}
	completed := 0
	var firstErr error
	for _, target := range targets {
		if err := service.verifyTarget(ctx, target); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		completed++
	}
	return completed, firstErr
}

// RunVerificationRecovery drives VerifyPendingBatch until ctx is done.
// onError receives only bounded error values (never object keys or URLs).
func (service *Service) RunVerificationRecovery(
	ctx context.Context,
	interval time.Duration,
	onError func(error),
) {
	if service == nil || service.verifications == nil || service.versions == nil {
		return
	}
	if interval <= 0 {
		interval = time.Minute
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := service.VerifyPendingBatch(ctx, maximumVerificationBatch); err != nil &&
				onError != nil && ctx.Err() == nil {
				onError(err)
			}
		}
	}
}

type roomDocumentCursorPayload struct {
	CreatedAt string `json:"created_at"`
	ID        string `json:"id"`
	ScopeHash string `json:"scope_hash"`
}

func roomDocumentScopeHash(tenantID, spaceID uuid.UUID) string {
	digest := sha256.New()
	_, _ = digest.Write([]byte("room-documents\x00"))
	_, _ = digest.Write(tenantID[:])
	_, _ = digest.Write(spaceID[:])
	return base64.RawURLEncoding.EncodeToString(digest.Sum(nil))
}

func encodeRoomDocumentCursor(cursor FileCursor, tenantID, spaceID uuid.UUID) (string, error) {
	if cursor.ID == uuid.Nil || cursor.CreatedAt.IsZero() {
		return "", ErrInvalidInput
	}
	contents, err := json.Marshal(roomDocumentCursorPayload{
		CreatedAt: cursor.CreatedAt.UTC().Format(time.RFC3339Nano),
		ID:        cursor.ID.String(), ScopeHash: roomDocumentScopeHash(tenantID, spaceID),
	})
	if err != nil {
		return "", err
	}
	return roomDocumentCursorPrefix + base64.RawURLEncoding.EncodeToString(contents), nil
}

func decodeRoomDocumentCursor(value string, tenantID, spaceID uuid.UUID) (*FileCursor, error) {
	if value == "" {
		return nil, nil
	}
	if len(value) > maximumFileCursorLength || !strings.HasPrefix(value, roomDocumentCursorPrefix) {
		return nil, ErrInvalidInput
	}
	contents, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(value, roomDocumentCursorPrefix))
	if err != nil {
		return nil, ErrInvalidInput
	}
	var payload roomDocumentCursorPayload
	decoder := json.NewDecoder(bytes.NewReader(contents))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return nil, ErrInvalidInput
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, ErrInvalidInput
	}
	createdAt, err := time.Parse(time.RFC3339Nano, payload.CreatedAt)
	if err != nil || createdAt.IsZero() || payload.ScopeHash != roomDocumentScopeHash(tenantID, spaceID) {
		return nil, ErrInvalidInput
	}
	id, err := uuid.Parse(payload.ID)
	if err != nil || id == uuid.Nil {
		return nil, ErrInvalidInput
	}
	return &FileCursor{CreatedAt: createdAt.UTC(), ID: id}, nil
}
