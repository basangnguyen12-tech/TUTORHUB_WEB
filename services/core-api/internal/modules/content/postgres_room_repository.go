package content

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tutorhub-v2/core-api/internal/modules/featurecontrol"
	"github.com/tutorhub-v2/core-api/internal/policy"
)

// ROOM-TOOLS-FILES-01A (ADR-0045 §2): room document library persistence and
// the P3-10-PDF/Image verifier lifecycle. Every statement is bounded by
// tenant_id; deletions are soft deletes (no DELETE privilege required).

const viewerMediaTypesSQL = `('application/pdf', 'image/png', 'image/jpeg', 'image/webp')`

// activeRoomParticipantStatuses are the media_participant_sessions states of
// a participant admitted to the current RoomInstance.
const activeRoomParticipantStatuses = `('admitted', 'joining', 'connected', 'reconnecting')`

func (repository *PostgresRepository) FileOwner(
	ctx context.Context,
	tenantID uuid.UUID,
	fileID uuid.UUID,
) (FileOwner, error) {
	if tenantID == uuid.Nil || fileID == uuid.Nil {
		return FileOwner{}, ErrNotFound
	}
	queryContext, cancel := context.WithTimeout(ctx, repository.queryTimeout)
	defer cancel()
	transaction, err := repository.database.Begin(queryContext)
	if err != nil {
		return FileOwner{}, fmt.Errorf("begin file owner lookup: %w", err)
	}
	defer rollback(transaction)
	var owner FileOwner
	var spaceID uuid.NullUUID
	err = transaction.QueryRow(
		queryContext,
		`SELECT owner_kind, media_space_id
FROM tutorhub.content_files
WHERE tenant_id = $1 AND id = $2`,
		tenantID, fileID,
	).Scan(&owner.Kind, &spaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return FileOwner{}, ErrNotFound
	}
	if err != nil {
		return FileOwner{}, fmt.Errorf("query file owner: %w", err)
	}
	if err := transaction.Commit(queryContext); err != nil {
		return FileOwner{}, fmt.Errorf("commit file owner lookup: %w", err)
	}
	if spaceID.Valid {
		owner.MediaSpaceID = spaceID.UUID
	}
	return owner, nil
}

func (repository *PostgresRepository) RoomViewerState(
	ctx context.Context,
	access AccessContext,
	spaceID uuid.UUID,
	roomInstanceID uuid.UUID,
	classID uuid.UUID,
) (RoomViewerState, error) {
	queryContext, cancel := context.WithTimeout(ctx, repository.queryTimeout)
	defer cancel()
	transaction, err := repository.database.Begin(queryContext)
	if err != nil {
		return RoomViewerState{}, fmt.Errorf("begin room viewer state: %w", err)
	}
	defer rollback(transaction)
	access, err = repository.requireActiveScope(queryContext, transaction, access)
	if err != nil {
		return RoomViewerState{}, err
	}
	var state RoomViewerState
	for _, role := range access.OrganizationRoles {
		if role == policy.OrganizationRoleAdmin {
			state.OrganizationAdmin = true
		}
	}
	if roomInstanceID != uuid.Nil {
		if err := transaction.QueryRow(
			queryContext,
			`SELECT
    EXISTS (
        SELECT 1 FROM tutorhub.media_room_instances
        WHERE tenant_id = $1 AND space_id = $2 AND id = $3 AND status = 'active'
    ),
    EXISTS (
        SELECT 1 FROM tutorhub.media_room_role_assignments
        WHERE tenant_id = $1 AND space_id = $2 AND room_instance_id = $3
          AND user_id = $4 AND assigned_role = 'co_host' AND status = 'active'
    ),
    EXISTS (
        SELECT 1 FROM tutorhub.media_participant_sessions
        WHERE tenant_id = $1 AND space_id = $2 AND room_instance_id = $3
          AND user_id = $4 AND status IN `+activeRoomParticipantStatuses+`
    )`,
			access.TenantID, spaceID, roomInstanceID, access.ActorID,
		).Scan(&state.RoomActive, &state.DynamicCoHost, &state.ActiveParticipant); err != nil {
			return RoomViewerState{}, fmt.Errorf("query room viewer state: %w", err)
		}
		if !state.RoomActive {
			state.DynamicCoHost, state.ActiveParticipant = false, false
		}
	}
	if classID != uuid.Nil {
		_, classRoles, err := lockClassAccess(queryContext, transaction, access, classID)
		if err != nil && !errors.Is(err, ErrNotFound) {
			return RoomViewerState{}, err
		}
		if err == nil {
			state.ClassStaff = repository.authorizeClassResource(
				access, classID, policy.ResourceStateActive, classRoles, policy.ActionFileUpload,
			) == nil
		}
	}
	if err := transaction.Commit(queryContext); err != nil {
		return RoomViewerState{}, fmt.Errorf("commit room viewer state: %w", err)
	}
	return state, nil
}

// requireRoomDocuments applies the room endpoint feature gate and binds the
// server-derived room grant to the requested MediaSpace. Read paths use
// RequireFeatureForRead so concurrent classroom viewers share the tenant
// control lock instead of serializing behind an exclusive advisory lock.
func (repository *PostgresRepository) requireRoomDocuments(
	ctx context.Context,
	transaction pgx.Tx,
	access AccessContext,
	spaceID uuid.UUID,
	read bool,
) (AccessContext, *roomGrant, error) {
	for _, feature := range []featurecontrol.FeatureKey{
		featurecontrol.FeatureFileUploads, featurecontrol.FeatureClassroomFilesTool,
	} {
		var err error
		if read {
			err = repository.controls.RequireFeatureForRead(ctx, transaction, access.TenantID, feature)
		} else {
			err = repository.controls.RequireFeature(ctx, transaction, access.TenantID, feature)
		}
		if err != nil {
			return AccessContext{}, nil, err
		}
	}
	grant := access.room
	scoped, err := repository.requireActiveScope(ctx, transaction, access)
	if err != nil {
		return AccessContext{}, nil, err
	}
	scoped.room = grant
	if grant == nil || spaceID == uuid.Nil || grant.spaceID != spaceID || !grant.canView {
		return AccessContext{}, nil, ErrNotFound
	}
	return scoped, grant, nil
}

// roomClassAuthorization evaluates the linked class for room-visible class
// files: view requires class file.view, staff requires class file.upload as
// if active, and canUpload requires the current class state.
type roomClassAuthorization struct {
	view      bool
	staff     bool
	canUpload bool
}

func (repository *PostgresRepository) roomClassAccess(
	ctx context.Context,
	transaction pgx.Tx,
	access AccessContext,
	grant *roomGrant,
) (roomClassAuthorization, error) {
	if grant.classID == uuid.Nil {
		return roomClassAuthorization{}, nil
	}
	class, classRoles, err := lockClassAccess(ctx, transaction, access, grant.classID)
	if errors.Is(err, ErrNotFound) {
		return roomClassAuthorization{}, nil
	}
	if err != nil {
		return roomClassAuthorization{}, err
	}
	allowed := func(state policy.ResourceState, action policy.Action) bool {
		return repository.authorizeClassResource(access, grant.classID, state, classRoles, action) == nil
	}
	return roomClassAuthorization{
		view:      allowed(class.Status, policy.ActionFileView),
		staff:     allowed(policy.ResourceStateActive, policy.ActionFileUpload),
		canUpload: allowed(class.Status, policy.ActionFileUpload),
	}, nil
}

func (repository *PostgresRepository) ListRoomDocuments(
	ctx context.Context,
	access AccessContext,
	params RoomDocumentListParams,
) (RoomDocumentListResult, error) {
	if params.SpaceID == uuid.Nil || params.Limit < 1 || params.Limit > maximumFileListLimit ||
		(params.After != nil && (params.After.ID == uuid.Nil || params.After.CreatedAt.IsZero())) {
		return RoomDocumentListResult{}, ErrInvalidInput
	}
	queryContext, cancel := context.WithTimeout(ctx, repository.queryTimeout)
	defer cancel()
	transaction, err := repository.database.Begin(queryContext)
	if err != nil {
		return RoomDocumentListResult{}, fmt.Errorf("begin room document list: %w", err)
	}
	defer rollback(transaction)
	access, grant, err := repository.requireRoomDocuments(queryContext, transaction, access, params.SpaceID, true)
	if err != nil {
		return RoomDocumentListResult{}, err
	}
	class, err := repository.roomClassAccess(queryContext, transaction, access, grant)
	if err != nil {
		return RoomDocumentListResult{}, err
	}
	now := params.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	query := `SELECT ` + fileReturning + `
FROM tutorhub.content_files
WHERE tenant_id = $1 AND deleted_at IS NULL
  AND declared_media_type IN ` + viewerMediaTypesSQL + `
  AND (
    (
      owner_kind = 'media_space' AND media_space_id = $2
      AND (expires_at IS NULL OR expires_at > $3)
      AND ($4::boolean OR status = 'ready' OR creator_user_id = $5)
    )
    OR (
      $6::boolean AND owner_kind = 'class' AND class_id = $7
      AND ($8::boolean OR status = 'ready' OR creator_user_id = $5)
    )
  )`
	arguments := []any{
		access.TenantID, params.SpaceID, now, grant.canManage, access.ActorID,
		class.view, nullableClassID(grant.classID), class.staff,
	}
	if params.After != nil {
		query += " AND (created_at, id) < ($9, $10)"
		arguments = append(arguments, params.After.CreatedAt, params.After.ID)
	}
	query += fmt.Sprintf(" ORDER BY created_at DESC, id DESC LIMIT $%d", len(arguments)+1)
	arguments = append(arguments, params.Limit+1)
	rows, err := transaction.Query(queryContext, query, arguments...)
	if err != nil {
		return RoomDocumentListResult{}, fmt.Errorf("query room documents: %w", err)
	}
	defer rows.Close()
	items := make([]RoomDocument, 0, params.Limit)
	fetched := 0
	for rows.Next() {
		row, err := scanFileRow(rows)
		if err != nil {
			return RoomDocumentListResult{}, fmt.Errorf("scan room document: %w", err)
		}
		fetched++
		if len(items) < params.Limit {
			items = append(items, projectRoomDocument(row, access, grant, class, now))
		}
	}
	if err := rows.Err(); err != nil {
		return RoomDocumentListResult{}, fmt.Errorf("iterate room documents: %w", err)
	}
	if err := transaction.Commit(queryContext); err != nil {
		return RoomDocumentListResult{}, fmt.Errorf("commit room document list: %w", err)
	}
	upload := grant.canManage && grant.writable
	return RoomDocumentListResult{
		Items: items, HasMore: fetched > params.Limit,
		ViewerAccess: RoomDocumentLibraryAccess{
			CanUpload: upload, CanUploadToClass: upload && class.canUpload,
			CanPresent: grant.canManage, CanManage: grant.canManage,
		},
	}, nil
}

func nullableClassID(classID uuid.UUID) uuid.NullUUID {
	return uuid.NullUUID{UUID: classID, Valid: classID != uuid.Nil}
}

// projectRoomDocument maps one authorized row to the room plane without
// creator identifiers, object keys or checksums.
func projectRoomDocument(
	row fileRow,
	access AccessContext,
	grant *roomGrant,
	class roomClassAuthorization,
	now time.Time,
) RoomDocument {
	staff := grant.canManage
	view := grant.canView
	if row.OwnerKind == OwnerKindClass {
		staff = class.staff && grant.canManage
		view = view && class.view
	}
	creator := row.CreatorUserID == access.ActorID
	document := RoomDocument{
		ID: row.ID, OwnerKind: row.OwnerKind, DisplayName: row.DisplayName,
		DeclaredMediaType: row.DeclaredMediaType, ExpectedSizeBytes: row.ExpectedSizeBytes,
		Status: row.Status, Version: row.Version, ActiveContent: row.ActiveContent,
		AllowStudentDownload: row.AllowStudentDownload, UploadedByViewer: creator,
		CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
		MediaSpaceID: nullUUIDPointer(row.MediaSpaceID), ClassID: nullUUIDPointer(row.ClassID),
		ViewerAccess: RoomDocumentViewerAccess{
			CanView: view && row.Status == StatusReady,
			CanDownloadOriginal: row.Status == StatusReady &&
				canDownloadOriginal(row, access, fileAuthorization{staff: staff}),
			CanManage: staff,
			CanRetryUpload: creator && grant.canManage && grant.writable &&
				row.Status == StatusPending && now.Before(row.UploadExpiresAt),
		},
	}
	document.ExpiresAt, document.PageCount, document.FirstPageAspect, document.RejectionReason =
		verifierProjection(row)
	return document
}

// loadRoomDocument locks or reads one row and proves it belongs to the room
// (or to the room's linked class) before any further decision.
func (repository *PostgresRepository) loadRoomDocument(
	ctx context.Context,
	transaction pgx.Tx,
	access AccessContext,
	grant *roomGrant,
	fileID uuid.UUID,
	now time.Time,
	lock bool,
) (fileRow, roomClassAuthorization, bool, error) {
	row, err := loadFile(ctx, transaction, access.TenantID, fileID, lock)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && row.DeletedAt.Valid) {
		return fileRow{}, roomClassAuthorization{}, false, ErrNotFound
	}
	if err != nil {
		return fileRow{}, roomClassAuthorization{}, false, fmt.Errorf("load room document: %w", err)
	}
	if !IsViewerMediaType(row.DeclaredMediaType) {
		return fileRow{}, roomClassAuthorization{}, false, ErrNotFound
	}
	switch row.OwnerKind {
	case OwnerKindMediaSpace:
		if !row.MediaSpaceID.Valid || row.MediaSpaceID.UUID != grant.spaceID ||
			(row.ExpiresAt.Valid && !now.Before(row.ExpiresAt.Time)) {
			return fileRow{}, roomClassAuthorization{}, false, ErrNotFound
		}
		return row, roomClassAuthorization{}, grant.canManage, nil
	case OwnerKindClass:
		if grant.classID == uuid.Nil || !row.ClassID.Valid || row.ClassID.UUID != grant.classID {
			return fileRow{}, roomClassAuthorization{}, false, ErrNotFound
		}
		class, err := repository.roomClassAccess(ctx, transaction, access, grant)
		if err != nil {
			return fileRow{}, roomClassAuthorization{}, false, err
		}
		if !class.view {
			return fileRow{}, roomClassAuthorization{}, false, ErrNotFound
		}
		return row, class, class.staff && grant.canManage, nil
	default:
		return fileRow{}, roomClassAuthorization{}, false, ErrNotFound
	}
}

func (repository *PostgresRepository) PrepareRoomView(
	ctx context.Context,
	access AccessContext,
	spaceID uuid.UUID,
	fileID uuid.UUID,
	now time.Time,
) (RoomViewTarget, error) {
	queryContext, cancel := context.WithTimeout(ctx, repository.queryTimeout)
	defer cancel()
	transaction, err := repository.database.Begin(queryContext)
	if err != nil {
		return RoomViewTarget{}, fmt.Errorf("begin room view capability preparation: %w", err)
	}
	defer rollback(transaction)
	access, grant, err := repository.requireRoomDocuments(queryContext, transaction, access, spaceID, true)
	if err != nil {
		return RoomViewTarget{}, err
	}
	row, _, staff, err := repository.loadRoomDocument(
		queryContext, transaction, access, grant, fileID, now, false,
	)
	if err != nil {
		return RoomViewTarget{}, err
	}
	if row.Status != StatusReady {
		if staff || row.CreatorUserID == access.ActorID {
			return RoomViewTarget{}, ErrNotReady
		}
		return RoomViewTarget{}, ErrNotFound
	}
	if !hasRoomViewProof(row) {
		return RoomViewTarget{}, ErrStorageUnavailable
	}
	if err := transaction.Commit(queryContext); err != nil {
		return RoomViewTarget{}, fmt.Errorf("commit room view capability preparation: %w", err)
	}
	return RoomViewTarget{
		ObjectKey: row.ObjectKey, VersionID: strings.TrimSpace(row.StorageVersionID.String),
		MediaType: strings.TrimSpace(row.StoredMediaType.String), ContentLengthBytes: row.ExpectedSizeBytes,
		SHA256: append([]byte(nil), row.StoredChecksumSHA256...), PageCount: int(row.PageCount.Int32),
		FirstPageAspect: row.FirstPageAspect.Float64, ActiveContent: row.ActiveContent,
		DisplayName: row.DisplayName, AllowStudentDownload: row.AllowStudentDownload,
	}, nil
}

func hasRoomViewProof(row fileRow) bool {
	return row.StorageVersionID.Valid && strings.TrimSpace(row.StorageVersionID.String) != "" &&
		row.StoredMediaType.Valid && len(row.StoredChecksumSHA256) == 32 &&
		row.PageCount.Valid && row.FirstPageAspect.Valid
}

func (repository *PostgresRepository) UpdateRoomDocument(
	ctx context.Context,
	access AccessContext,
	spaceID uuid.UUID,
	fileID uuid.UUID,
	input UpdateRoomDocumentInput,
	now time.Time,
) (UpdateRoomDocumentResult, error) {
	if input.ExpectedVersion < 1 || (input.Deleted == (input.AllowStudentDownload != nil)) {
		return UpdateRoomDocumentResult{}, ErrInvalidInput
	}
	queryContext, cancel := context.WithTimeout(ctx, repository.queryTimeout)
	defer cancel()
	transaction, err := repository.database.Begin(queryContext)
	if err != nil {
		return UpdateRoomDocumentResult{}, fmt.Errorf("begin room document update: %w", err)
	}
	defer rollback(transaction)
	access, grant, err := repository.requireRoomDocuments(queryContext, transaction, access, spaceID, false)
	if err != nil {
		return UpdateRoomDocumentResult{}, err
	}
	if !grant.canManage {
		return UpdateRoomDocumentResult{}, ErrNotFound
	}
	row, class, staff, err := repository.loadRoomDocument(
		queryContext, transaction, access, grant, fileID, now, true,
	)
	if err != nil {
		return UpdateRoomDocumentResult{}, err
	}
	if !staff {
		return UpdateRoomDocumentResult{}, ErrNotFound
	}
	if input.Deleted && row.OwnerKind != OwnerKindMediaSpace {
		return UpdateRoomDocumentResult{}, ErrInvalidInput
	}
	if row.Version != input.ExpectedVersion {
		return UpdateRoomDocumentResult{}, ErrVersionConflict
	}
	if input.Deleted {
		if err := softDeleteRoomDocument(queryContext, transaction, row); err != nil {
			return UpdateRoomDocumentResult{}, err
		}
		if err := transaction.Commit(queryContext); err != nil {
			return UpdateRoomDocumentResult{}, fmt.Errorf("commit room document deletion: %w", err)
		}
		return UpdateRoomDocumentResult{
			Deleted: true, cleanup: roomStorageCleanup{key: row.ObjectKey, version: row.StorageVersionID.String},
		}, nil
	}
	updated, err := scanFileRow(transaction.QueryRow(
		queryContext,
		`UPDATE tutorhub.content_files
SET allow_student_download = $3,
    version = version + 1,
    updated_at = GREATEST($5, updated_at)
WHERE tenant_id = $1 AND id = $2 AND version = $4 AND deleted_at IS NULL
RETURNING `+fileReturning,
		access.TenantID, fileID, *input.AllowStudentDownload, input.ExpectedVersion, now,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return UpdateRoomDocumentResult{}, ErrVersionConflict
	}
	if err != nil {
		return UpdateRoomDocumentResult{}, fmt.Errorf("persist room document update: %w", err)
	}
	if err := transaction.Commit(queryContext); err != nil {
		return UpdateRoomDocumentResult{}, fmt.Errorf("commit room document update: %w", err)
	}
	return UpdateRoomDocumentResult{
		Document: projectRoomDocument(updated, access, grant, class, now),
	}, nil
}

// softDeleteRoomDocument tombstones one room-owned file and releases its
// reserved (pending) or committed (finalized) bytes in the same transaction.
func softDeleteRoomDocument(ctx context.Context, transaction pgx.Tx, row fileRow) error {
	if _, err := lockFileUsage(ctx, transaction, row.TenantID, time.Now().UTC()); err != nil {
		return err
	}
	commandTag, err := transaction.Exec(
		ctx,
		`UPDATE tutorhub.content_files
SET deleted_at = GREATEST(transaction_timestamp(), created_at, updated_at),
    deletion_reason = 'room_staff_deleted',
    version = version + 1,
    updated_at = GREATEST(transaction_timestamp(), created_at, updated_at)
WHERE tenant_id = $1 AND id = $2 AND version = $3 AND deleted_at IS NULL
  AND owner_kind = 'media_space'`,
		row.TenantID, row.ID, row.Version,
	)
	if err != nil {
		return fmt.Errorf("soft delete room document: %w", err)
	}
	if commandTag.RowsAffected() != 1 {
		return ErrVersionConflict
	}
	usageColumn := "committed_bytes"
	if row.Status == StatusPending {
		usageColumn = "reserved_bytes"
	}
	commandTag, err = transaction.Exec(
		ctx,
		`UPDATE tutorhub.tenant_file_usage
SET file_count = file_count - 1,
    `+usageColumn+` = `+usageColumn+` - $2,
    updated_at = GREATEST(transaction_timestamp(), updated_at)
WHERE tenant_id = $1 AND file_count >= 1 AND `+usageColumn+` >= $2`,
		row.TenantID, row.ExpectedSizeBytes,
	)
	if err != nil {
		return fmt.Errorf("release room document quota: %w", err)
	}
	if commandTag.RowsAffected() != 1 {
		return fmt.Errorf("release room document quota: usage invariant failed")
	}
	return nil
}

const verificationTargetReturning = `tenant_id, id, version, object_key,
storage_version_id, declared_media_type, expected_size_bytes, expected_checksum_sha256`

func scanVerificationTarget(row rowScanner) (VerificationTarget, error) {
	var target VerificationTarget
	var versionID *string
	err := row.Scan(
		&target.TenantID, &target.FileID, &target.Version, &target.ObjectKey,
		&versionID, &target.DeclaredMediaType, &target.ExpectedSizeBytes, &target.ExpectedChecksum,
	)
	if err == nil && versionID != nil {
		target.StorageVersionID = strings.TrimSpace(*versionID)
	}
	return target, err
}

// ClaimVerification moves one finalized viewer file uploaded -> processing
// under compare-and-set so only one verifier run owns it.
func (repository *PostgresRepository) ClaimVerification(
	ctx context.Context,
	tenantID uuid.UUID,
	fileID uuid.UUID,
	now time.Time,
) (VerificationTarget, bool, error) {
	queryContext, cancel := context.WithTimeout(ctx, repository.queryTimeout)
	defer cancel()
	transaction, err := repository.database.Begin(queryContext)
	if err != nil {
		return VerificationTarget{}, false, fmt.Errorf("begin verification claim: %w", err)
	}
	defer rollback(transaction)
	target, claimed, err := claimVerificationTx(queryContext, transaction, tenantID, fileID, now)
	if err != nil || !claimed {
		return VerificationTarget{}, false, err
	}
	if err := transaction.Commit(queryContext); err != nil {
		return VerificationTarget{}, false, fmt.Errorf("commit verification claim: %w", err)
	}
	return target, true, nil
}

func claimVerificationTx(ctx context.Context, transaction pgx.Tx, tenantID, fileID uuid.UUID, now time.Time) (VerificationTarget, bool, error) {
	target, err := scanVerificationTarget(transaction.QueryRow(
		ctx,
		`UPDATE tutorhub.content_files
SET status = 'processing',
    processing_at = GREATEST($3, uploaded_at, updated_at),
    version = version + 1,
    updated_at = GREATEST($3, uploaded_at, updated_at)
WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL AND status = 'uploaded'
  AND declared_media_type IN `+viewerMediaTypesSQL+`
RETURNING `+verificationTargetReturning,
		tenantID, fileID, now,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return VerificationTarget{}, false, nil
	}
	if err != nil {
		return VerificationTarget{}, false, fmt.Errorf("claim verification: %w", err)
	}
	return target, true, nil
}

// ClaimStaleVerifications recovers rows left uploaded/processing by a crash
// or transient storage failure. SKIP LOCKED keeps concurrent API instances
// from verifying the same row.
func (repository *PostgresRepository) ClaimStaleVerifications(
	ctx context.Context,
	limit int,
	staleBefore time.Time,
	now time.Time,
) ([]VerificationTarget, error) {
	if limit < 1 || limit > 100 {
		return nil, ErrInvalidInput
	}
	queryContext, cancel := context.WithTimeout(ctx, repository.queryTimeout)
	defer cancel()
	transaction, err := repository.database.Begin(queryContext)
	if err != nil {
		return nil, fmt.Errorf("begin stale verification claim: %w", err)
	}
	defer rollback(transaction)
	rows, err := transaction.Query(
		queryContext,
		`WITH candidates AS (
    SELECT tenant_id, id
    FROM tutorhub.content_files
    WHERE deleted_at IS NULL AND status IN ('uploaded', 'processing')
      AND declared_media_type IN `+viewerMediaTypesSQL+`
      AND updated_at <= $1
    ORDER BY updated_at ASC, id ASC
    LIMIT $2
    FOR UPDATE SKIP LOCKED
)
UPDATE tutorhub.content_files AS file
SET status = 'processing',
    processing_at = GREATEST($3, file.uploaded_at, file.updated_at),
    version = file.version + 1,
    updated_at = GREATEST($3, file.uploaded_at, file.updated_at)
FROM candidates
WHERE file.tenant_id = candidates.tenant_id AND file.id = candidates.id
RETURNING file.tenant_id, file.id, file.version, file.object_key,
    file.storage_version_id, file.declared_media_type, file.expected_size_bytes,
    file.expected_checksum_sha256`,
		staleBefore, limit, now,
	)
	if err != nil {
		return nil, fmt.Errorf("claim stale verifications: %w", err)
	}
	targets := make([]VerificationTarget, 0, limit)
	for rows.Next() {
		target, err := scanVerificationTarget(rows)
		if err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan stale verification: %w", err)
		}
		targets = append(targets, target)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate stale verifications: %w", err)
	}
	if err := transaction.Commit(queryContext); err != nil {
		return nil, fmt.Errorf("commit stale verification claim: %w", err)
	}
	return targets, nil
}

// CompleteVerification persists ready (with verified SHA-256 and page
// metadata) or rejected (with a bounded reason) for the claimed version.
func (repository *PostgresRepository) CompleteVerification(
	ctx context.Context,
	target VerificationTarget,
	result VerificationResult,
	now time.Time,
) (bool, error) {
	queryContext, cancel := context.WithTimeout(ctx, repository.queryTimeout)
	defer cancel()
	transaction, err := repository.database.Begin(queryContext)
	if err != nil {
		return false, fmt.Errorf("begin verification completion: %w", err)
	}
	defer rollback(transaction)
	completed, err := completeVerificationTx(queryContext, transaction, target, result, now)
	if err != nil || !completed {
		return false, err
	}
	if err := transaction.Commit(queryContext); err != nil {
		return false, fmt.Errorf("commit verification outcome: %w", err)
	}
	return true, nil
}

func completeVerificationTx(ctx context.Context, transaction pgx.Tx, target VerificationTarget, result VerificationResult, now time.Time) (bool, error) {
	var commandTag interface{ RowsAffected() int64 }
	var err error
	if result.Ready {
		if len(result.StoredChecksum) != 32 || result.PageCount < 1 || result.PageCount > ViewerMaxPages ||
			result.FirstPageAspect < minimumPageAspect || result.FirstPageAspect > maximumPageAspect {
			return false, ErrInvalidInput
		}
		commandTag, err = transaction.Exec(
			ctx,
			`UPDATE tutorhub.content_files
SET status = 'ready',
    version = version + 1,
    stored_checksum_sha256 = $4,
    page_count = $5,
    first_page_aspect = $6,
    active_content = $7,
    rejection_reason = NULL,
    ready_at = GREATEST($3, processing_at),
    updated_at = GREATEST($3, processing_at, updated_at)
WHERE tenant_id = $1 AND id = $2 AND status = 'processing' AND version = $8
  AND deleted_at IS NULL AND stored_checksum_sha256 IS NULL
  AND expected_checksum_sha256 = $4`,
			target.TenantID, target.FileID, now, result.StoredChecksum, result.PageCount,
			result.FirstPageAspect, result.ActiveContent, target.Version,
		)
	} else {
		reason := string(result.RejectionReason)
		if !validRejectionReason(reason) {
			return false, ErrInvalidInput
		}
		commandTag, err = transaction.Exec(
			ctx,
			`UPDATE tutorhub.content_files
SET status = 'rejected',
    version = version + 1,
    rejection_reason = $4,
    rejected_at = GREATEST($3, processing_at),
    updated_at = GREATEST($3, processing_at, updated_at)
WHERE tenant_id = $1 AND id = $2 AND status = 'processing' AND version = $5
  AND deleted_at IS NULL`,
			target.TenantID, target.FileID, now, reason, target.Version,
		)
	}
	if err != nil {
		return false, fmt.Errorf("persist verification outcome: %w", err)
	}
	if commandTag.RowsAffected() != 1 {
		return false, nil
	}
	return true, nil
}

func validRejectionReason(value string) bool {
	if len(value) < 3 || len(value) > 64 {
		return false
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '_' {
			return false
		}
	}
	return true
}
