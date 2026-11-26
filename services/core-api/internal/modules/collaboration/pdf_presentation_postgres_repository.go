package collaboration

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tutorhub-v2/core-api/internal/modules/featurecontrol"
)

// PostgresPdfPresentationRepository stores only control-plane metadata for
// classroom PDF presentations. Strokes live in the collaboration data plane
// (Yjs) and its bounded checkpoint; PDF bytes and URLs never enter these
// queries.
type PostgresPdfPresentationRepository struct {
	database     Database
	queryTimeout time.Duration
	controls     featurecontrol.Enforcer
	quotas       featurecontrol.QuotaResolver
}

func NewPostgresPdfPresentationRepository(
	database Database,
	queryTimeout time.Duration,
	configs ...PostgresRepositoryConfig,
) (*PostgresPdfPresentationRepository, error) {
	if database == nil {
		return nil, fmt.Errorf("pdf presentation database is required")
	}
	if queryTimeout <= 0 {
		queryTimeout = defaultQueryTimeout
	}
	var config PostgresRepositoryConfig
	if len(configs) > 0 {
		config = configs[0]
	}
	return &PostgresPdfPresentationRepository{
		database: database, queryTimeout: queryTimeout,
		controls: config.Controls, quotas: config.Quotas,
	}, nil
}

const pdfPresentationColumns = `id, media_space_id, content_file_id, file_version_id, page_count,
        status, version, current_generation, revoke_generation, created_at, updated_at`

// The admitted RoomInstance statuses that count as "in the room" for viewing
// and annotating (same set as the room document library).
const pdfActiveParticipantStatuses = `('admitted', 'joining', 'connected', 'reconnecting')`

func (repository *PostgresPdfPresentationRepository) begin(
	ctx context.Context,
	tenantID uuid.UUID,
	read bool,
) (pgx.Tx, context.Context, context.CancelFunc, error) {
	queryContext, cancel := context.WithTimeout(ctx, repository.queryTimeout)
	tx, err := repository.database.Begin(queryContext)
	if err != nil {
		cancel()
		return nil, nil, nil, ErrUnavailable
	}
	if err := repository.requireFeatures(queryContext, tx, tenantID, read); err != nil {
		rollback(tx)
		cancel()
		return nil, nil, nil, err
	}
	return tx, queryContext, cancel, nil
}

func lockPdfPresentationSpace(ctx context.Context, tx pgx.Tx, tenantID, spaceID uuid.UUID) error {
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		"pdf-presentation-space:"+tenantID.String()+":"+spaceID.String(),
	); err != nil {
		return ErrUnavailable
	}
	return nil
}

// Present atomically opens (or switches to) the presentation of one file
// version: any other open presentation of the room is suspended in the same
// transaction, the partial unique index keeps "at most one open per room".
func (repository *PostgresPdfPresentationRepository) Present(
	ctx context.Context,
	access AccessContext,
	command PdfPresentCommand,
) (PdfPresentResult, error) {
	if command.PresentationID == uuid.Nil || command.MediaSpaceID == uuid.Nil || command.FileID == uuid.Nil ||
		command.PageCount < 1 || command.PageCount > PdfPresentationMaximumPages ||
		command.VersionID == "" || len(command.VersionID) > pdfPresentationMaximumVersionLength ||
		len(command.Fingerprint) != 32 {
		return PdfPresentResult{}, ErrInvalidRequest
	}
	tx, queryContext, cancel, err := repository.begin(ctx, access.TenantID, false)
	if err != nil {
		return PdfPresentResult{}, err
	}
	defer cancel()
	defer rollback(tx)
	if err := lockPdfPresentationSpace(queryContext, tx, access.TenantID, command.MediaSpaceID); err != nil {
		return PdfPresentResult{}, err
	}
	replayed, found, err := loadPdfMutationReplay(queryContext, tx, access, command.IdempotencyKey,
		[]string{"open", "switch"}, command.Fingerprint, uuid.Nil)
	if err != nil {
		return PdfPresentResult{}, err
	}
	if found {
		if replayed.MediaSpaceID != command.MediaSpaceID || replayed.FileID != command.FileID {
			return PdfPresentResult{}, ErrIdempotencyConflict
		}
		if err := tx.Commit(queryContext); err != nil {
			return PdfPresentResult{}, ErrUnavailable
		}
		return PdfPresentResult{Presentation: replayed}, nil
	}

	target, err := loadPdfPresentationBySource(queryContext, tx, access.TenantID, command)
	targetExists := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return PdfPresentResult{}, ErrUnavailable
	}
	suspended, err := suspendOtherOpenPresentations(queryContext, tx, access, command.MediaSpaceID, target.ID)
	if err != nil {
		return PdfPresentResult{}, err
	}
	operation := "open"
	if len(suspended) > 0 {
		operation = "switch"
	}
	result := PdfPresentResult{Suspended: suspended}
	switch {
	case !targetExists:
		if _, err := tx.Exec(queryContext, `INSERT INTO tutorhub.pdf_presentations
            (id, tenant_id, media_space_id, content_file_id, file_version_id, page_count, status,
             create_idempotency_key, create_request_fingerprint, created_by, updated_by,
             opened_at, opened_by)
            VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $9, $9, transaction_timestamp(), $9)`,
			command.PresentationID, access.TenantID, command.MediaSpaceID, command.FileID,
			command.VersionID, command.PageCount, command.IdempotencyKey, command.Fingerprint,
			access.ActorID,
		); err != nil {
			return PdfPresentResult{}, classifyWriteError(err)
		}
		if _, err := tx.Exec(queryContext, `INSERT INTO tutorhub.pdf_presentation_generations
            (tenant_id, presentation_id, generation, provider_document_name, reason, created_by)
            VALUES ($1, $2, 1, $3, 'initial', $4)`,
			access.TenantID, command.PresentationID, command.ProviderDocumentName, access.ActorID,
		); err != nil {
			return PdfPresentResult{}, classifyWriteError(err)
		}
		target, err = loadPdfPresentation(queryContext, tx, access.TenantID, command.PresentationID, false)
		if err != nil {
			return PdfPresentResult{}, ErrUnavailable
		}
		result.Created = true
	case target.Status == DocumentOpen:
		// Re-presenting the already open document is an idempotent no-op.
	default:
		// created/suspended/closed -> open reuses the same row, generation and
		// checkpoint, so earlier strokes are preserved.
		err = scanPdfPresentation(tx.QueryRow(queryContext, `UPDATE tutorhub.pdf_presentations SET
            status = 'open', version = version + 1,
            updated_by = $3, updated_at = transaction_timestamp(),
            opened_at = COALESCE(opened_at, transaction_timestamp()),
            opened_by = COALESCE(opened_by, $3),
            resumed_at = CASE WHEN status = 'created' THEN resumed_at ELSE transaction_timestamp() END,
            resumed_by = CASE WHEN status = 'created' THEN resumed_by ELSE $3 END,
            closed_at = NULL, closed_by = NULL
            WHERE tenant_id = $1 AND id = $2 AND status <> 'open'
            RETURNING `+pdfPresentationColumns,
			access.TenantID, target.ID, access.ActorID,
		), &target)
		if errors.Is(err, pgx.ErrNoRows) {
			return PdfPresentResult{}, ErrVersionConflict
		}
		if err != nil {
			return PdfPresentResult{}, classifyWriteError(err)
		}
	}
	if err := insertPdfMutationReceipt(queryContext, tx, access, command.IdempotencyKey,
		command.Fingerprint, operation, target); err != nil {
		return PdfPresentResult{}, err
	}
	if err := tx.Commit(queryContext); err != nil {
		return PdfPresentResult{}, classifyWriteError(err)
	}
	result.Presentation = target
	return result, nil
}

func suspendOtherOpenPresentations(
	ctx context.Context,
	tx pgx.Tx,
	access AccessContext,
	spaceID uuid.UUID,
	keepID uuid.UUID,
) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx, `UPDATE tutorhub.pdf_presentations SET
        status = 'suspended', version = version + 1, revoke_generation = revoke_generation + 1,
        updated_by = $3, updated_at = transaction_timestamp(),
        suspended_at = transaction_timestamp(), suspended_by = $3
        WHERE tenant_id = $1 AND media_space_id = $2 AND status = 'open' AND id <> $4
        RETURNING id`,
		access.TenantID, spaceID, access.ActorID, keepID,
	)
	if err != nil {
		return nil, ErrUnavailable
	}
	defer rows.Close()
	suspended := make([]uuid.UUID, 0, 1)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, ErrUnavailable
		}
		suspended = append(suspended, id)
	}
	if rows.Err() != nil {
		return nil, ErrUnavailable
	}
	return suspended, nil
}

func (repository *PostgresPdfPresentationRepository) Get(
	ctx context.Context,
	access AccessContext,
	presentationID uuid.UUID,
) (PdfPresentation, error) {
	tx, queryContext, cancel, err := repository.begin(ctx, access.TenantID, true)
	if err != nil {
		return PdfPresentation{}, err
	}
	defer cancel()
	defer rollback(tx)
	presentation, err := loadPdfPresentation(queryContext, tx, access.TenantID, presentationID, false)
	if errors.Is(err, pgx.ErrNoRows) {
		return PdfPresentation{}, ErrNotFound
	}
	if err != nil {
		return PdfPresentation{}, ErrUnavailable
	}
	if err := tx.Commit(queryContext); err != nil {
		return PdfPresentation{}, ErrUnavailable
	}
	return presentation, nil
}

// Current returns the open presentation of a room or, without one, the most
// recently updated suspended presentation. Closed rows are never projected.
func (repository *PostgresPdfPresentationRepository) Current(
	ctx context.Context,
	access AccessContext,
	spaceID uuid.UUID,
) (PdfPresentation, error) {
	tx, queryContext, cancel, err := repository.begin(ctx, access.TenantID, true)
	if err != nil {
		return PdfPresentation{}, err
	}
	defer cancel()
	defer rollback(tx)
	var presentation PdfPresentation
	err = scanPdfPresentation(tx.QueryRow(queryContext, `SELECT `+pdfPresentationColumns+`
        FROM tutorhub.pdf_presentations
        WHERE tenant_id = $1 AND media_space_id = $2 AND status IN ('open', 'suspended')
        ORDER BY (status = 'open') DESC, updated_at DESC, id DESC
        LIMIT 1`,
		access.TenantID, spaceID,
	), &presentation)
	if errors.Is(err, pgx.ErrNoRows) {
		return PdfPresentation{}, ErrNotFound
	}
	if err != nil {
		return PdfPresentation{}, ErrUnavailable
	}
	if err := tx.Commit(queryContext); err != nil {
		return PdfPresentation{}, ErrUnavailable
	}
	return presentation, nil
}

func (repository *PostgresPdfPresentationRepository) GrantAuthority(
	ctx context.Context,
	access AccessContext,
	presentationID uuid.UUID,
) (GrantAuthority, error) {
	tx, queryContext, cancel, err := repository.begin(ctx, access.TenantID, true)
	if err != nil {
		return GrantAuthority{}, err
	}
	defer cancel()
	defer rollback(tx)
	var authority GrantAuthority
	err = tx.QueryRow(queryContext, `SELECT presentation.id, presentation.media_space_id,
        presentation.status, presentation.version, presentation.current_generation,
        presentation.revoke_generation, presentation.created_at, presentation.updated_at,
        generation.provider_document_name
        FROM tutorhub.pdf_presentations AS presentation
        JOIN tutorhub.pdf_presentation_generations AS generation
          ON generation.tenant_id = presentation.tenant_id
         AND generation.presentation_id = presentation.id
         AND generation.generation = presentation.current_generation
        WHERE presentation.tenant_id = $1 AND presentation.id = $2`,
		access.TenantID, presentationID,
	).Scan(
		&authority.Document.ID, &authority.Document.MediaSpaceID,
		&authority.Document.Status, &authority.Document.Version,
		&authority.Document.CurrentGeneration, &authority.Document.RevokeGeneration,
		&authority.Document.CreatedAt, &authority.Document.UpdatedAt,
		&authority.ProviderDocumentName,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return GrantAuthority{}, ErrNotFound
	}
	if err != nil {
		return GrantAuthority{}, ErrUnavailable
	}
	authority.DocumentKind = DocumentKindPDFAnnotations
	authority.WriterFence = authority.Document.RevokeGeneration
	if repository.quotas != nil {
		// PDF annotation connections share the tenant runtime clamp already
		// enforced for whiteboards and code workspaces (ADR-0037).
		limits := RuntimeLimits{}
		for key, target := range map[featurecontrol.QuotaKey]*int64{
			featurecontrol.QuotaWhiteboardConnectionsPerTenant:  &limits.MaxConnectionsPerTenant,
			featurecontrol.QuotaWhiteboardOperationsPerMinute:   &limits.MaxOperationsPerMinute,
			featurecontrol.QuotaWhiteboardStorageBytesPerTenant: &limits.MaxStorageBytesPerTenant,
		} {
			quota, quotaErr := repository.quotas.ResolveQuota(queryContext, tx, access.TenantID, key)
			if quotaErr != nil {
				return GrantAuthority{}, classifyCodeControlError(quotaErr)
			}
			*target = quota.Limit
		}
		authority.RuntimeLimits = limits
	}
	if err := tx.Commit(queryContext); err != nil {
		return GrantAuthority{}, ErrUnavailable
	}
	return authority, nil
}

// Transition applies suspend/resume/close with CAS and idempotency. Resume
// suspends any other open presentation of the same room first, preserving the
// "at most one open per room" invariant.
func (repository *PostgresPdfPresentationRepository) Transition(
	ctx context.Context,
	access AccessContext,
	command TransitionCommand,
) (PdfPresentationTransitionResult, error) {
	tx, queryContext, cancel, err := repository.begin(ctx, access.TenantID, false)
	if err != nil {
		return PdfPresentationTransitionResult{}, err
	}
	defer cancel()
	defer rollback(tx)
	var spaceID uuid.UUID
	err = tx.QueryRow(queryContext, `SELECT media_space_id FROM tutorhub.pdf_presentations
        WHERE tenant_id = $1 AND id = $2`, access.TenantID, command.DocumentID).Scan(&spaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return PdfPresentationTransitionResult{}, ErrNotFound
	}
	if err != nil {
		return PdfPresentationTransitionResult{}, ErrUnavailable
	}
	if err := lockPdfPresentationSpace(queryContext, tx, access.TenantID, spaceID); err != nil {
		return PdfPresentationTransitionResult{}, err
	}
	replayed, found, err := loadPdfMutationReplay(queryContext, tx, access, command.IdempotencyKey,
		[]string{command.Operation}, command.Fingerprint, command.DocumentID)
	if err != nil {
		return PdfPresentationTransitionResult{}, err
	}
	if found {
		if err := tx.Commit(queryContext); err != nil {
			return PdfPresentationTransitionResult{}, ErrUnavailable
		}
		return PdfPresentationTransitionResult{Presentation: replayed}, nil
	}
	presentation, err := loadPdfPresentation(queryContext, tx, access.TenantID, command.DocumentID, true)
	if errors.Is(err, pgx.ErrNoRows) {
		return PdfPresentationTransitionResult{}, ErrNotFound
	}
	if err != nil {
		return PdfPresentationTransitionResult{}, ErrUnavailable
	}
	if presentation.Version != command.ExpectedVersion {
		return PdfPresentationTransitionResult{}, ErrVersionConflict
	}
	nextStatus, valid := pdfTransitionStatus(presentation.Status, command.Operation)
	if !valid {
		return PdfPresentationTransitionResult{}, ErrTransitionConflict
	}
	result := PdfPresentationTransitionResult{}
	if command.Operation == "resume" {
		result.Suspended, err = suspendOtherOpenPresentations(queryContext, tx, access, presentation.MediaSpaceID, presentation.ID)
		if err != nil {
			return PdfPresentationTransitionResult{}, err
		}
	}
	revokeIncrement := int64(0)
	if command.Operation == "suspend" || command.Operation == "close" {
		revokeIncrement = 1
	}
	err = scanPdfPresentation(tx.QueryRow(queryContext, `UPDATE tutorhub.pdf_presentations SET
        status = $3, version = version + 1, revoke_generation = revoke_generation + $4,
        updated_by = $5, updated_at = transaction_timestamp(),
        suspended_at = CASE WHEN $6 = 'suspend' THEN transaction_timestamp() ELSE suspended_at END,
        suspended_by = CASE WHEN $6 = 'suspend' THEN $5 ELSE suspended_by END,
        resumed_at = CASE WHEN $6 = 'resume' THEN transaction_timestamp() ELSE resumed_at END,
        resumed_by = CASE WHEN $6 = 'resume' THEN $5 ELSE resumed_by END,
        closed_at = CASE WHEN $6 = 'close' THEN transaction_timestamp() ELSE closed_at END,
        closed_by = CASE WHEN $6 = 'close' THEN $5 ELSE closed_by END
        WHERE tenant_id = $1 AND id = $2 AND version = $7
        RETURNING `+pdfPresentationColumns,
		access.TenantID, presentation.ID, nextStatus, revokeIncrement, access.ActorID,
		command.Operation, command.ExpectedVersion,
	), &result.Presentation)
	if errors.Is(err, pgx.ErrNoRows) {
		return PdfPresentationTransitionResult{}, ErrVersionConflict
	}
	if err != nil {
		return PdfPresentationTransitionResult{}, classifyWriteError(err)
	}
	if err := insertPdfMutationReceipt(queryContext, tx, access, command.IdempotencyKey,
		command.Fingerprint, command.Operation, result.Presentation); err != nil {
		return PdfPresentationTransitionResult{}, err
	}
	if err := tx.Commit(queryContext); err != nil {
		return PdfPresentationTransitionResult{}, classifyWriteError(err)
	}
	return result, nil
}

func pdfTransitionStatus(current DocumentStatus, operation string) (DocumentStatus, bool) {
	switch operation {
	case "suspend":
		return DocumentSuspended, current == DocumentOpen
	case "resume":
		return DocumentOpen, current == DocumentSuspended
	case "close":
		return DocumentClosed, current != DocumentClosed
	default:
		return "", false
	}
}

func (repository *PostgresPdfPresentationRepository) ViewerState(
	ctx context.Context,
	access AccessContext,
	presentationID uuid.UUID,
	spaceID uuid.UUID,
	roomID uuid.UUID,
) (PdfPresentationViewerState, error) {
	tx, queryContext, cancel, err := repository.begin(ctx, access.TenantID, true)
	if err != nil {
		return PdfPresentationViewerState{}, err
	}
	defer cancel()
	defer rollback(tx)
	var roomActive bool
	var state PdfPresentationViewerState
	err = tx.QueryRow(queryContext, `SELECT
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
              AND user_id = $4 AND status IN `+pdfActiveParticipantStatuses+`
        ),
        EXISTS (
            SELECT 1 FROM tutorhub.pdf_presentation_actor_grants AS actor_grant
            JOIN tutorhub.pdf_presentations AS presentation
              ON presentation.tenant_id = actor_grant.tenant_id
             AND presentation.id = actor_grant.presentation_id
             AND presentation.media_space_id = $2
            WHERE actor_grant.tenant_id = $1 AND actor_grant.presentation_id = $5
              AND actor_grant.actor_user_id = $4
              AND actor_grant.revoked_at IS NULL
              AND actor_grant.expires_at > transaction_timestamp()
        )`,
		access.TenantID, spaceID, roomID, access.ActorID, presentationID,
	).Scan(&roomActive, &state.DynamicCoHost, &state.ActiveParticipant, &state.ActiveAnnotateGrant)
	if err != nil {
		return PdfPresentationViewerState{}, ErrUnavailable
	}
	if err := tx.Commit(queryContext); err != nil {
		return PdfPresentationViewerState{}, ErrUnavailable
	}
	if !roomActive {
		return PdfPresentationViewerState{}, errPdfPresentationNoRoomRun
	}
	return state, nil
}

func (repository *PostgresPdfPresentationRepository) ActiveAnnotatorGrants(
	ctx context.Context,
	access AccessContext,
	presentationID uuid.UUID,
	spaceID uuid.UUID,
	roomID uuid.UUID,
) ([]PdfAnnotatorGrant, error) {
	tx, queryContext, cancel, err := repository.begin(ctx, access.TenantID, true)
	if err != nil {
		return nil, err
	}
	defer cancel()
	defer rollback(tx)
	rows, err := tx.Query(queryContext, `SELECT participant.participant_key, actor_grant.expires_at
        FROM tutorhub.pdf_presentation_actor_grants AS actor_grant
        JOIN tutorhub.pdf_presentations AS presentation
          ON presentation.tenant_id = actor_grant.tenant_id
         AND presentation.id = actor_grant.presentation_id
         AND presentation.media_space_id = $2
        JOIN tutorhub.media_participant_sessions AS participant
          ON participant.tenant_id = actor_grant.tenant_id
         AND participant.space_id = $2
         AND participant.room_instance_id = $3
         AND participant.user_id = actor_grant.actor_user_id
         AND participant.status IN `+pdfActiveParticipantStatuses+`
        WHERE actor_grant.tenant_id = $1 AND actor_grant.presentation_id = $4
          AND actor_grant.revoked_at IS NULL
          AND actor_grant.expires_at > transaction_timestamp()
        ORDER BY actor_grant.expires_at, participant.participant_key
        LIMIT $5`,
		access.TenantID, spaceID, roomID, presentationID, pdfPresentationMaximumGrantResult,
	)
	if err != nil {
		return nil, ErrUnavailable
	}
	defer rows.Close()
	grants := make([]PdfAnnotatorGrant, 0, PdfPresentationMaxActiveAnnotators)
	seen := make(map[uuid.UUID]bool, PdfPresentationMaxActiveAnnotators)
	for rows.Next() {
		var grant PdfAnnotatorGrant
		if err := rows.Scan(&grant.ParticipantKey, &grant.ExpiresAt); err != nil {
			return nil, ErrUnavailable
		}
		if seen[grant.ParticipantKey] {
			continue
		}
		seen[grant.ParticipantKey] = true
		grants = append(grants, grant)
	}
	if rows.Err() != nil {
		return nil, ErrUnavailable
	}
	if err := tx.Commit(queryContext); err != nil {
		return nil, ErrUnavailable
	}
	return grants, nil
}

func (repository *PostgresPdfPresentationRepository) PutAnnotatorGrant(
	ctx context.Context,
	access AccessContext,
	command PdfAnnotatorGrantCommand,
) (PdfAnnotatorGrantResult, error) {
	ttlSeconds := int64(command.TTL / time.Second)
	if ttlSeconds < int64(PdfPresentationMinimumAnnotatorTTL/time.Second) ||
		ttlSeconds > int64(PdfPresentationMaximumAnnotatorTTL/time.Second) {
		return PdfAnnotatorGrantResult{}, ErrInvalidRequest
	}
	tx, queryContext, cancel, err := repository.begin(ctx, access.TenantID, false)
	if err != nil {
		return PdfAnnotatorGrantResult{}, err
	}
	defer cancel()
	defer rollback(tx)
	if err := lockPdfPresentationForGrants(queryContext, tx, access, command.PresentationID, command.MediaSpaceID, command.RoomInstanceID, true); err != nil {
		return PdfAnnotatorGrantResult{}, err
	}
	target, err := loadPdfGrantTarget(queryContext, tx, access.TenantID, command.MediaSpaceID, command.RoomInstanceID, command.ParticipantKey)
	if err != nil {
		return PdfAnnotatorGrantResult{}, err
	}
	if target.effectiveRole != "attendee" || target.userID == access.ActorID {
		return PdfAnnotatorGrantResult{}, ErrGrantTargetIneligible
	}
	// Grants of actors who left the active RoomInstance are withdrawn before
	// counting, so a departed student never pins one of the three slots.
	rows, err := tx.Query(queryContext, `UPDATE tutorhub.pdf_presentation_actor_grants AS actor_grant
        SET revoked_at = transaction_timestamp(), revoked_by = $5, version = actor_grant.version + 1
        WHERE actor_grant.tenant_id = $1 AND actor_grant.presentation_id = $2
          AND actor_grant.revoked_at IS NULL
          AND actor_grant.expires_at > transaction_timestamp()
          AND NOT EXISTS (
              SELECT 1 FROM tutorhub.media_participant_sessions AS participant
              WHERE participant.tenant_id = actor_grant.tenant_id
                AND participant.space_id = $3
                AND participant.room_instance_id = $4
                AND participant.user_id = actor_grant.actor_user_id
                AND participant.status IN `+pdfActiveParticipantStatuses+`
          )
        RETURNING actor_grant.actor_user_id`,
		access.TenantID, command.PresentationID, command.MediaSpaceID, command.RoomInstanceID, access.ActorID,
	)
	if err != nil {
		return PdfAnnotatorGrantResult{}, ErrUnavailable
	}
	revoked := make([]uuid.UUID, 0, PdfPresentationMaxActiveAnnotators)
	for rows.Next() {
		var actorID uuid.UUID
		if err := rows.Scan(&actorID); err != nil {
			rows.Close()
			return PdfAnnotatorGrantResult{}, ErrUnavailable
		}
		revoked = append(revoked, actorID)
	}
	rows.Close()
	if rows.Err() != nil {
		return PdfAnnotatorGrantResult{}, ErrUnavailable
	}
	var others int64
	if err := tx.QueryRow(queryContext, `SELECT count(*)
        FROM tutorhub.pdf_presentation_actor_grants
        WHERE tenant_id = $1 AND presentation_id = $2 AND actor_user_id <> $3
          AND revoked_at IS NULL AND expires_at > transaction_timestamp()`,
		access.TenantID, command.PresentationID, target.userID,
	).Scan(&others); err != nil {
		return PdfAnnotatorGrantResult{}, ErrUnavailable
	}
	if others >= PdfPresentationMaxActiveAnnotators {
		return PdfAnnotatorGrantResult{}, ErrAnnotatorLimitReached
	}
	result := PdfAnnotatorGrantResult{ActorID: target.userID, RevokedActors: revoked}
	err = tx.QueryRow(queryContext, `INSERT INTO tutorhub.pdf_presentation_actor_grants
        (tenant_id, presentation_id, actor_user_id, capability, granted_by, granted_at, expires_at)
        VALUES ($1, $2, $3, 'edit', $4, transaction_timestamp(),
                transaction_timestamp() + ($5::bigint * interval '1 second'))
        ON CONFLICT (tenant_id, presentation_id, actor_user_id) DO UPDATE SET
            granted_by = EXCLUDED.granted_by,
            granted_at = EXCLUDED.granted_at,
            expires_at = EXCLUDED.expires_at,
            revoked_at = NULL,
            revoked_by = NULL,
            version = pdf_presentation_actor_grants.version + 1
        RETURNING expires_at`,
		access.TenantID, command.PresentationID, target.userID, access.ActorID, ttlSeconds,
	).Scan(&result.Grant.ExpiresAt)
	if err != nil {
		return PdfAnnotatorGrantResult{}, classifyWriteError(err)
	}
	result.Grant.ParticipantKey = target.participantKey
	if err := tx.Commit(queryContext); err != nil {
		return PdfAnnotatorGrantResult{}, ErrUnavailable
	}
	return result, nil
}

func (repository *PostgresPdfPresentationRepository) RevokeAnnotatorGrant(
	ctx context.Context,
	access AccessContext,
	command PdfAnnotatorRevokeCommand,
) (PdfAnnotatorRevokeResult, error) {
	tx, queryContext, cancel, err := repository.begin(ctx, access.TenantID, false)
	if err != nil {
		return PdfAnnotatorRevokeResult{}, err
	}
	defer cancel()
	defer rollback(tx)
	if err := lockPdfPresentationForGrants(queryContext, tx, access, command.PresentationID, command.MediaSpaceID, command.RoomInstanceID, false); err != nil {
		return PdfAnnotatorRevokeResult{}, err
	}
	target, err := loadPdfGrantTarget(queryContext, tx, access.TenantID, command.MediaSpaceID, command.RoomInstanceID, command.ParticipantKey)
	if err != nil {
		return PdfAnnotatorRevokeResult{}, err
	}
	tag, err := tx.Exec(queryContext, `UPDATE tutorhub.pdf_presentation_actor_grants
        SET revoked_at = transaction_timestamp(), revoked_by = $4, version = version + 1
        WHERE tenant_id = $1 AND presentation_id = $2 AND actor_user_id = $3
          AND revoked_at IS NULL`,
		access.TenantID, command.PresentationID, target.userID, access.ActorID,
	)
	if err != nil {
		return PdfAnnotatorRevokeResult{}, classifyWriteError(err)
	}
	if err := tx.Commit(queryContext); err != nil {
		return PdfAnnotatorRevokeResult{}, ErrUnavailable
	}
	return PdfAnnotatorRevokeResult{ActorID: target.userID, Revoked: tag.RowsAffected() > 0}, nil
}

// lockPdfPresentationForGrants serializes grant mutations per presentation and
// re-checks, inside the transaction, that it still belongs to the authorized
// MediaSpace and that the RoomInstance is still active.
func lockPdfPresentationForGrants(
	ctx context.Context,
	tx pgx.Tx,
	access AccessContext,
	presentationID, spaceID, roomID uuid.UUID,
	requireOpen bool,
) error {
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		"pdf-presentation-annotators:"+access.TenantID.String()+":"+presentationID.String(),
	); err != nil {
		return ErrUnavailable
	}
	var status DocumentStatus
	var roomActive bool
	err := tx.QueryRow(ctx, `SELECT presentation.status, EXISTS (
            SELECT 1 FROM tutorhub.media_room_instances
            WHERE tenant_id = presentation.tenant_id AND space_id = presentation.media_space_id
              AND id = $4 AND status = 'active'
        )
        FROM tutorhub.pdf_presentations AS presentation
        WHERE presentation.tenant_id = $1 AND presentation.id = $2 AND presentation.media_space_id = $3
        FOR UPDATE OF presentation`,
		access.TenantID, presentationID, spaceID, roomID,
	).Scan(&status, &roomActive)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return ErrUnavailable
	}
	if !roomActive {
		if requireOpen {
			return ErrTransitionConflict
		}
		return ErrNotFound
	}
	if requireOpen && status != DocumentOpen {
		return ErrTransitionConflict
	}
	return nil
}

type pdfGrantTarget struct {
	userID         uuid.UUID
	participantKey uuid.UUID
	effectiveRole  string
}

func loadPdfGrantTarget(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, spaceID, roomID, participantKey uuid.UUID,
) (pdfGrantTarget, error) {
	var target pdfGrantTarget
	err := tx.QueryRow(ctx, `SELECT participant.user_id, participant.participant_key,
            COALESCE(role_assignment.assigned_role, participant.instance_role)
        FROM tutorhub.media_participant_sessions AS participant
        LEFT JOIN tutorhub.media_room_role_assignments AS role_assignment
          ON role_assignment.tenant_id = participant.tenant_id
         AND role_assignment.space_id = participant.space_id
         AND role_assignment.room_instance_id = participant.room_instance_id
         AND role_assignment.user_id = participant.user_id
         AND role_assignment.assigned_role = 'co_host'
         AND role_assignment.status = 'active'
        WHERE participant.tenant_id = $1 AND participant.space_id = $2
          AND participant.room_instance_id = $3 AND participant.participant_key = $4
          AND participant.status IN `+pdfActiveParticipantStatuses+`
        LIMIT 1`,
		tenantID, spaceID, roomID, participantKey,
	).Scan(&target.userID, &target.participantKey, &target.effectiveRole)
	if errors.Is(err, pgx.ErrNoRows) {
		return pdfGrantTarget{}, ErrNotFound
	}
	if err != nil {
		return pdfGrantTarget{}, ErrUnavailable
	}
	return target, nil
}

func loadPdfPresentation(
	ctx context.Context,
	tx pgx.Tx,
	tenantID uuid.UUID,
	presentationID uuid.UUID,
	lock bool,
) (PdfPresentation, error) {
	query := `SELECT ` + pdfPresentationColumns + `
        FROM tutorhub.pdf_presentations WHERE tenant_id = $1 AND id = $2`
	if lock {
		query += ` FOR UPDATE`
	}
	var presentation PdfPresentation
	return presentation, scanPdfPresentation(tx.QueryRow(ctx, query, tenantID, presentationID), &presentation)
}

func loadPdfPresentationBySource(
	ctx context.Context,
	tx pgx.Tx,
	tenantID uuid.UUID,
	command PdfPresentCommand,
) (PdfPresentation, error) {
	var presentation PdfPresentation
	err := scanPdfPresentation(tx.QueryRow(ctx, `SELECT `+pdfPresentationColumns+`
        FROM tutorhub.pdf_presentations
        WHERE tenant_id = $1 AND media_space_id = $2 AND content_file_id = $3 AND file_version_id = $4
        FOR UPDATE`,
		tenantID, command.MediaSpaceID, command.FileID, command.VersionID,
	), &presentation)
	return presentation, err
}

func scanPdfPresentation(row pgx.Row, presentation *PdfPresentation) error {
	return row.Scan(&presentation.ID, &presentation.MediaSpaceID, &presentation.FileID,
		&presentation.VersionID, &presentation.PageCount, &presentation.Status,
		&presentation.Version, &presentation.CurrentGeneration, &presentation.RevokeGeneration,
		&presentation.CreatedAt, &presentation.UpdatedAt)
}

func insertPdfMutationReceipt(
	ctx context.Context,
	tx pgx.Tx,
	access AccessContext,
	idempotencyKey string,
	fingerprint []byte,
	operation string,
	presentation PdfPresentation,
) error {
	if _, err := tx.Exec(ctx, `INSERT INTO tutorhub.pdf_presentation_mutation_receipts
        (tenant_id, actor_user_id, idempotency_key, request_fingerprint, operation,
         presentation_id, result_presentation_version, result_generation,
         result_revoke_generation, result_status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		access.TenantID, access.ActorID, idempotencyKey, fingerprint, operation,
		presentation.ID, presentation.Version, presentation.CurrentGeneration,
		presentation.RevokeGeneration, presentation.Status,
	); err != nil {
		return classifyWriteError(err)
	}
	return nil
}

// loadPdfMutationReplay returns the stored result of an idempotent command.
// The result fields come from the receipt; descriptive fields from the row.
func loadPdfMutationReplay(
	ctx context.Context,
	tx pgx.Tx,
	access AccessContext,
	idempotencyKey string,
	operations []string,
	fingerprint []byte,
	presentationID uuid.UUID,
) (PdfPresentation, bool, error) {
	var storedFingerprint []byte
	var storedOperation string
	var presentation PdfPresentation
	err := tx.QueryRow(ctx, `SELECT receipt.request_fingerprint, receipt.operation,
               receipt.presentation_id, presentation.media_space_id, presentation.content_file_id,
               presentation.file_version_id, presentation.page_count, receipt.result_status,
               receipt.result_presentation_version, receipt.result_generation,
               receipt.result_revoke_generation, presentation.created_at, receipt.created_at
        FROM tutorhub.pdf_presentation_mutation_receipts AS receipt
        JOIN tutorhub.pdf_presentations AS presentation
          ON presentation.tenant_id = receipt.tenant_id AND presentation.id = receipt.presentation_id
        WHERE receipt.tenant_id = $1 AND receipt.actor_user_id = $2
          AND receipt.idempotency_key = $3`,
		access.TenantID, access.ActorID, idempotencyKey,
	).Scan(
		&storedFingerprint, &storedOperation, &presentation.ID, &presentation.MediaSpaceID,
		&presentation.FileID, &presentation.VersionID, &presentation.PageCount,
		&presentation.Status, &presentation.Version, &presentation.CurrentGeneration,
		&presentation.RevokeGeneration, &presentation.CreatedAt, &presentation.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return PdfPresentation{}, false, nil
	}
	if err != nil {
		return PdfPresentation{}, false, ErrUnavailable
	}
	allowed := false
	for _, operation := range operations {
		if storedOperation == operation {
			allowed = true
		}
	}
	if !allowed || !bytes.Equal(storedFingerprint, fingerprint) ||
		(presentationID != uuid.Nil && presentation.ID != presentationID) {
		return PdfPresentation{}, false, ErrIdempotencyConflict
	}
	return presentation, true, nil
}

// requireFeatures enforces all three Slice 2 keys in the same transaction:
// file storage, the classroom Files / PDF tool and the PDF collaboration
// rollout. A missing key fails closed with feature_disabled.
func (repository *PostgresPdfPresentationRepository) requireFeatures(
	ctx context.Context,
	tx pgx.Tx,
	tenantID uuid.UUID,
	read bool,
) error {
	if repository.controls == nil {
		return nil
	}
	for _, key := range []featurecontrol.FeatureKey{
		featurecontrol.FeatureFileUploads,
		featurecontrol.FeatureClassroomFilesTool,
		featurecontrol.FeatureClassroomPDFCollaboration,
	} {
		var err error
		if read {
			err = repository.controls.RequireFeatureForRead(ctx, tx, tenantID, key)
		} else {
			err = repository.controls.RequireFeature(ctx, tx, tenantID, key)
		}
		if err != nil {
			return classifyCodeControlError(err)
		}
	}
	return nil
}
