package content

import (
	"bytes"
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tutorhub-v2/core-api/internal/policy"
)

// The composite FK in 000053 binds a nonnull message_id to the same tenant
// and conversation. The room must own that conversation (000034).
const chatImportSource = ` FROM tutorhub.message_attachments a
JOIN tutorhub.conversations c ON (c.tenant_id,c.id) = (a.tenant_id,a.conversation_id)
WHERE a.tenant_id=$1 AND c.media_space_id=$2 AND c.kind='room'
  AND a.conversation_id=$3 AND a.id=$4 AND a.state='attached' AND a.message_id IS NOT NULL`

func (repo *PostgresRepository) checkChatUploadRoom(ctx context.Context, tx pgx.Tx, access AccessContext, scope OwnerKind) (roomClassAuthorization, error) {
	grant := access.room
	if grant == nil || !grant.canManage {
		return roomClassAuthorization{}, ErrNotFound
	}
	var status string
	err := tx.QueryRow(ctx, `SELECT status FROM tutorhub.media_spaces WHERE tenant_id=$1 AND id=$2`, access.TenantID, grant.spaceID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return roomClassAuthorization{}, ErrNotFound
	}
	if err != nil {
		return roomClassAuthorization{}, err
	}
	if !grant.writable || (status != "scheduled" && status != "open") {
		return roomClassAuthorization{}, ErrReadOnly
	}
	if grant.classID == uuid.Nil {
		if scope == OwnerKindClass {
			return roomClassAuthorization{}, ErrInvalidInput
		}
		return roomClassAuthorization{}, nil
	}
	class, roles, err := lockClassAccess(ctx, tx, access, grant.classID)
	if err != nil {
		return roomClassAuthorization{}, err
	}
	if class.Status == policy.ResourceStateArchived {
		return roomClassAuthorization{}, ErrReadOnly
	}
	if scope == OwnerKindClass {
		if err := repo.authorizeClassResource(access, grant.classID, class.Status, roles, policy.ActionFileUpload); err != nil {
			return roomClassAuthorization{}, err
		}
		return roomClassAuthorization{view: true, staff: true, canUpload: true}, nil
	}
	return roomClassAuthorization{}, nil
}

func (repo *PostgresRepository) prepareChatImport(ctx context.Context, access AccessContext, input SaveRoomChatAttachmentInput, fingerprint []byte) (roomChatAttachment, *RoomDocument, error) {
	ctx, cancel := context.WithTimeout(ctx, repo.queryTimeout)
	defer cancel()
	tx, err := repo.database.Begin(ctx)
	if err != nil {
		return roomChatAttachment{}, nil, err
	}
	defer rollback(tx)
	access, grant, err := repo.requireRoomDocuments(ctx, tx, access, access.room.spaceID, false)
	if err != nil {
		return roomChatAttachment{}, nil, err
	}
	class, err := repo.checkChatUploadRoom(ctx, tx, access, input.Scope)
	if err != nil {
		return roomChatAttachment{}, nil, err
	}
	existing, err := loadFileByClientRequest(ctx, tx, access.TenantID, access.ActorID, input.ClientRequestID, false)
	found := err == nil
	if !found && !errors.Is(err, pgx.ErrNoRows) {
		return roomChatAttachment{}, nil, err
	}
	if found && !bytes.Equal(existing.RequestFingerprint, fingerprint) {
		return roomChatAttachment{}, nil, ErrIdempotencyConflict
	}
	now := time.Now().UTC()
	if found && (existing.DeletedAt.Valid || (existing.ExpiresAt.Valid && !now.Before(existing.ExpiresAt.Time))) {
		return roomChatAttachment{}, nil, ErrNotFound
	}
	ready := found && existing.Status == StatusReady
	var attachment roomChatAttachment
	err = tx.QueryRow(ctx, `SELECT a.display_name, a.media_type, a.size_bytes, a.storage_backend,
 COALESCE(a.object_key,''), CASE WHEN NOT $5::boolean THEN a.inline_bytes END`+chatImportSource,
		access.TenantID, grant.spaceID, input.ConversationID, input.AttachmentID, ready).
		Scan(&attachment.name, &attachment.mediaType, &attachment.size, &attachment.backend, &attachment.objectKey, &attachment.inline)
	if errors.Is(err, pgx.ErrNoRows) {
		return roomChatAttachment{}, nil, ErrNotFound
	}
	if err != nil {
		return roomChatAttachment{}, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return roomChatAttachment{}, nil, err
	}
	if ready {
		doc := projectRoomDocument(existing, access, grant, class, now)
		return roomChatAttachment{}, &doc, nil
	}
	return attachment, nil, nil
}

// Lock the durable intent across the bounded destination HEAD/PUT. Different
// API instances serialize only on this file. The feature locks acquired in
// prepareChatImport and CreateIntent have been released before object I/O.
func (repo *PostgresRepository) finishChatImport(ctx context.Context, access AccessContext, input SaveRoomChatAttachmentInput, fileID uuid.UUID, verified VerificationResult, write importObjectWriter, now time.Time) (SaveRoomChatAttachmentResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second+repo.queryTimeout)
	defer cancel()
	tx, err := repo.database.Begin(ctx)
	if err != nil {
		return SaveRoomChatAttachmentResult{}, err
	}
	defer rollback(tx)
	row, err := loadFile(ctx, tx, access.TenantID, fileID, true)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (row.CreatorUserID != access.ActorID || row.DeletedAt.Valid)) {
		return SaveRoomChatAttachmentResult{}, ErrNotFound
	}
	if err != nil {
		return SaveRoomChatAttachmentResult{}, err
	}
	if !bytes.Equal(row.RequestFingerprint, input.fingerprint(access.room.spaceID)) || !bytes.Equal(row.ExpectedChecksumSHA256, verified.StoredChecksum) {
		return SaveRoomChatAttachmentResult{}, ErrIdempotencyConflict
	}
	class, err := repo.checkChatImportSource(ctx, tx, access, input)
	if err != nil {
		return SaveRoomChatAttachmentResult{}, err
	}
	if row.Status == StatusReady {
		return SaveRoomChatAttachmentResult{Document: projectRoomDocument(row, access, access.room, class, now)}, tx.Commit(ctx)
	}
	if row.Status != StatusPending {
		return SaveRoomChatAttachmentResult{}, ErrVersionConflict
	}
	if !now.Before(row.UploadExpiresAt) {
		return SaveRoomChatAttachmentResult{}, ErrIntentExpired
	}
	proof, err := write(ctx, row.ObjectKey)
	if err != nil {
		// Rollback keeps the reservation and stable destination key for retries.
		return SaveRoomChatAttachmentResult{}, err
	}
	// The attachment may have been retracted or the room closed while B2
	// was writing. Retire a revoked pending intent under its existing lock,
	// returning the proof for deletion only if the tombstone committed.
	class, err = repo.checkChatImportSource(ctx, tx, access, input)
	if errors.Is(err, ErrNotFound) || errors.Is(err, ErrReadOnly) {
		if retireErr := retirePendingFile(ctx, tx, row, now, "chat_source_unavailable"); retireErr != nil {
			return SaveRoomChatAttachmentResult{}, retireErr
		}
		if commitErr := tx.Commit(ctx); commitErr != nil {
			return SaveRoomChatAttachmentResult{}, commitErr
		}
		return SaveRoomChatAttachmentResult{cleanup: roomStorageCleanup{key: row.ObjectKey, version: proof.VersionID}}, err
	}
	if err != nil {
		return SaveRoomChatAttachmentResult{}, err
	}
	// Reuse the finalize and verifier transitions, keeping their quota, version
	// and proof updates atomic for this already-verified source.
	if _, err := persistFinalizeProof(ctx, tx, row, FinalizeProof{
		ExpectedVersion: row.Version, ContentType: row.DeclaredMediaType, ContentLength: row.ExpectedSizeBytes,
		ETag: proof.ETag, VersionID: proof.VersionID, FinalizedAt: now,
	}); err != nil {
		return SaveRoomChatAttachmentResult{}, err
	}
	target, claimed, err := claimVerificationTx(ctx, tx, row.TenantID, fileID, now)
	if err != nil {
		return SaveRoomChatAttachmentResult{}, err
	}
	if !claimed {
		return SaveRoomChatAttachmentResult{}, ErrVersionConflict
	}
	completed, err := completeVerificationTx(ctx, tx, target, verified, now)
	if err != nil {
		return SaveRoomChatAttachmentResult{}, err
	}
	if !completed {
		return SaveRoomChatAttachmentResult{}, ErrVersionConflict
	}
	row, err = loadFile(ctx, tx, row.TenantID, fileID, false)
	if err != nil {
		return SaveRoomChatAttachmentResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SaveRoomChatAttachmentResult{}, err
	}
	return SaveRoomChatAttachmentResult{Document: projectRoomDocument(row, access, access.room, class, now), Created: true}, nil
}

func (repo *PostgresRepository) checkChatImportSource(ctx context.Context, tx pgx.Tx, access AccessContext, input SaveRoomChatAttachmentInput) (roomClassAuthorization, error) {
	class, err := repo.checkChatUploadRoom(ctx, tx, access, input.Scope)
	if err != nil {
		return roomClassAuthorization{}, err
	}
	var attached bool
	err = tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1`+chatImportSource+`)`, access.TenantID, access.room.spaceID,
		input.ConversationID, input.AttachmentID).Scan(&attached)
	if err != nil {
		return roomClassAuthorization{}, err
	}
	if !attached {
		return roomClassAuthorization{}, ErrNotFound
	}
	return class, nil
}
