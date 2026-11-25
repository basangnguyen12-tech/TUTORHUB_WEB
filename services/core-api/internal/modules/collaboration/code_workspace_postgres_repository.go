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

// PostgresCodeWorkspaceRepository stores only control-plane metadata for the
// shared code workspace. Workspace text lives in the collaboration data
// plane (Yjs) and its bounded checkpoint, never in these queries.
type PostgresCodeWorkspaceRepository struct {
	database     Database
	queryTimeout time.Duration
	controls     featurecontrol.Enforcer
	quotas       featurecontrol.QuotaResolver
}

func NewPostgresCodeWorkspaceRepository(
	database Database,
	queryTimeout time.Duration,
	configs ...PostgresRepositoryConfig,
) (*PostgresCodeWorkspaceRepository, error) {
	if database == nil {
		return nil, fmt.Errorf("code workspace database is required")
	}
	if queryTimeout <= 0 {
		queryTimeout = defaultQueryTimeout
	}
	var config PostgresRepositoryConfig
	if len(configs) > 0 {
		config = configs[0]
	}
	return &PostgresCodeWorkspaceRepository{
		database: database, queryTimeout: queryTimeout,
		controls: config.Controls, quotas: config.Quotas,
	}, nil
}

const codeWorkspaceColumns = `id, media_space_id, status, version, current_generation,
        revoke_generation, created_at, updated_at`

const activeParticipantStatuses = `('joining', 'connected', 'reconnecting')`

func (repository *PostgresCodeWorkspaceRepository) begin(
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

func (repository *PostgresCodeWorkspaceRepository) Create(
	ctx context.Context,
	access AccessContext,
	command CodeWorkspaceCreateCommand,
) (CodeWorkspaceCreateResult, error) {
	tx, queryContext, cancel, err := repository.begin(ctx, access.TenantID, false)
	if err != nil {
		return CodeWorkspaceCreateResult{}, err
	}
	defer cancel()
	defer rollback(tx)
	if _, err := tx.Exec(queryContext,
		`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		"code-workspace-create:"+access.TenantID.String()+":"+access.ActorID.String()+":"+command.IdempotencyKey,
	); err != nil {
		return CodeWorkspaceCreateResult{}, ErrUnavailable
	}
	var replayed CodeWorkspace
	var fingerprint []byte
	err = tx.QueryRow(queryContext, `SELECT `+codeWorkspaceColumns+`, create_request_fingerprint
        FROM tutorhub.code_workspaces
        WHERE tenant_id = $1 AND created_by = $2 AND create_idempotency_key = $3`,
		access.TenantID, access.ActorID, command.IdempotencyKey,
	).Scan(&replayed.ID, &replayed.MediaSpaceID, &replayed.Status, &replayed.Version,
		&replayed.CurrentGeneration, &replayed.RevokeGeneration, &replayed.CreatedAt,
		&replayed.UpdatedAt, &fingerprint)
	if err == nil {
		if !bytes.Equal(fingerprint, command.Fingerprint) {
			return CodeWorkspaceCreateResult{}, ErrIdempotencyConflict
		}
		if err := tx.Commit(queryContext); err != nil {
			return CodeWorkspaceCreateResult{}, ErrUnavailable
		}
		return CodeWorkspaceCreateResult{Workspace: replayed}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return CodeWorkspaceCreateResult{}, ErrUnavailable
	}
	if _, err := tx.Exec(queryContext,
		`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		"code-workspace-space:"+access.TenantID.String()+":"+command.MediaSpaceID.String(),
	); err != nil {
		return CodeWorkspaceCreateResult{}, ErrUnavailable
	}
	existing, err := loadCodeWorkspace(queryContext, tx, `media_space_id`, access.TenantID, command.MediaSpaceID, false)
	if err == nil {
		if err := tx.Commit(queryContext); err != nil {
			return CodeWorkspaceCreateResult{}, ErrUnavailable
		}
		return CodeWorkspaceCreateResult{Workspace: existing}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return CodeWorkspaceCreateResult{}, ErrUnavailable
	}
	if _, err := tx.Exec(queryContext, `INSERT INTO tutorhub.code_workspaces
        (id, tenant_id, media_space_id, create_idempotency_key,
         create_request_fingerprint, created_by, updated_by)
        VALUES ($1, $2, $3, $4, $5, $6, $6)`,
		command.WorkspaceID, access.TenantID, command.MediaSpaceID, command.IdempotencyKey,
		command.Fingerprint, access.ActorID,
	); err != nil {
		return CodeWorkspaceCreateResult{}, classifyWriteError(err)
	}
	if _, err := tx.Exec(queryContext, `INSERT INTO tutorhub.code_workspace_generations
        (tenant_id, workspace_id, generation, provider_document_name, reason, created_by)
        VALUES ($1, $2, 1, $3, 'initial', $4)`,
		access.TenantID, command.WorkspaceID, command.ProviderDocumentName, access.ActorID,
	); err != nil {
		return CodeWorkspaceCreateResult{}, classifyWriteError(err)
	}
	workspace, err := loadCodeWorkspace(queryContext, tx, `id`, access.TenantID, command.WorkspaceID, false)
	if err != nil {
		return CodeWorkspaceCreateResult{}, ErrUnavailable
	}
	if err := tx.Commit(queryContext); err != nil {
		return CodeWorkspaceCreateResult{}, ErrUnavailable
	}
	return CodeWorkspaceCreateResult{Workspace: workspace, Created: true}, nil
}

func (repository *PostgresCodeWorkspaceRepository) Get(
	ctx context.Context,
	access AccessContext,
	workspaceID uuid.UUID,
) (CodeWorkspace, error) {
	return repository.loadOne(ctx, access, `id`, workspaceID)
}

func (repository *PostgresCodeWorkspaceRepository) GetByMediaSpace(
	ctx context.Context,
	access AccessContext,
	mediaSpaceID uuid.UUID,
) (CodeWorkspace, error) {
	return repository.loadOne(ctx, access, `media_space_id`, mediaSpaceID)
}

func (repository *PostgresCodeWorkspaceRepository) loadOne(
	ctx context.Context,
	access AccessContext,
	column string,
	value uuid.UUID,
) (CodeWorkspace, error) {
	tx, queryContext, cancel, err := repository.begin(ctx, access.TenantID, true)
	if err != nil {
		return CodeWorkspace{}, err
	}
	defer cancel()
	defer rollback(tx)
	workspace, err := loadCodeWorkspace(queryContext, tx, column, access.TenantID, value, false)
	if errors.Is(err, pgx.ErrNoRows) {
		return CodeWorkspace{}, ErrNotFound
	}
	if err != nil {
		return CodeWorkspace{}, ErrUnavailable
	}
	if err := tx.Commit(queryContext); err != nil {
		return CodeWorkspace{}, ErrUnavailable
	}
	return workspace, nil
}

func (repository *PostgresCodeWorkspaceRepository) GrantAuthority(
	ctx context.Context,
	access AccessContext,
	workspaceID uuid.UUID,
) (GrantAuthority, error) {
	tx, queryContext, cancel, err := repository.begin(ctx, access.TenantID, true)
	if err != nil {
		return GrantAuthority{}, err
	}
	defer cancel()
	defer rollback(tx)
	var authority GrantAuthority
	err = tx.QueryRow(queryContext, `SELECT workspace.id, workspace.media_space_id,
        workspace.status, workspace.version, workspace.current_generation,
        workspace.revoke_generation, workspace.created_at, workspace.updated_at,
        generation.provider_document_name
        FROM tutorhub.code_workspaces AS workspace
        JOIN tutorhub.code_workspace_generations AS generation
          ON generation.tenant_id = workspace.tenant_id
         AND generation.workspace_id = workspace.id
         AND generation.generation = workspace.current_generation
        WHERE workspace.tenant_id = $1 AND workspace.id = $2`,
		access.TenantID, workspaceID,
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
	authority.DocumentKind = DocumentKindCodeWorkspace
	authority.WriterFence = authority.Document.RevokeGeneration
	if repository.quotas != nil {
		// ADR-0043 §4 / RESEARCH-00 §3.7: code connections share the tenant
		// runtime clamp already enforced for whiteboards (ADR-0037).
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

func (repository *PostgresCodeWorkspaceRepository) Transition(
	ctx context.Context,
	access AccessContext,
	command TransitionCommand,
) (CodeWorkspace, error) {
	tx, queryContext, cancel, err := repository.begin(ctx, access.TenantID, false)
	if err != nil {
		return CodeWorkspace{}, err
	}
	defer cancel()
	defer rollback(tx)
	replayed, found, err := loadCodeWorkspaceMutationReplay(queryContext, tx, access, command)
	if err != nil {
		return CodeWorkspace{}, err
	}
	if found {
		if err := tx.Commit(queryContext); err != nil {
			return CodeWorkspace{}, ErrUnavailable
		}
		return replayed, nil
	}
	workspace, err := loadCodeWorkspace(queryContext, tx, `id`, access.TenantID, command.DocumentID, true)
	if errors.Is(err, pgx.ErrNoRows) {
		return CodeWorkspace{}, ErrNotFound
	}
	if err != nil {
		return CodeWorkspace{}, ErrUnavailable
	}
	if workspace.Version != command.ExpectedVersion {
		return CodeWorkspace{}, ErrVersionConflict
	}
	nextStatus, valid := transitionStatus(workspace.Status, command.Operation)
	if !valid {
		return CodeWorkspace{}, ErrTransitionConflict
	}
	revokeIncrement := int64(0)
	if command.Operation == "suspend" || command.Operation == "close" {
		revokeIncrement = 1
	}
	var result CodeWorkspace
	err = scanCodeWorkspace(tx.QueryRow(queryContext, `UPDATE tutorhub.code_workspaces SET
        status = $3, version = version + 1, revoke_generation = revoke_generation + $4,
        updated_by = $5, updated_at = transaction_timestamp(),
        opened_at = CASE WHEN $6 = 'open' AND status = 'created' THEN transaction_timestamp() ELSE opened_at END,
        opened_by = CASE WHEN $6 = 'open' AND status = 'created' THEN $5 ELSE opened_by END,
        suspended_at = CASE WHEN $6 = 'suspend' THEN transaction_timestamp() ELSE suspended_at END,
        suspended_by = CASE WHEN $6 = 'suspend' THEN $5 ELSE suspended_by END,
        resumed_at = CASE WHEN $6 = 'resume' THEN transaction_timestamp() ELSE resumed_at END,
        resumed_by = CASE WHEN $6 = 'resume' THEN $5 ELSE resumed_by END,
        closed_at = CASE WHEN $6 = 'close' THEN transaction_timestamp() ELSE closed_at END,
        closed_by = CASE WHEN $6 = 'close' THEN $5 ELSE closed_by END
        WHERE tenant_id = $1 AND id = $2 AND version = $7
        RETURNING `+codeWorkspaceColumns,
		access.TenantID, workspace.ID, nextStatus, revokeIncrement, access.ActorID,
		command.Operation, command.ExpectedVersion,
	), &result)
	if errors.Is(err, pgx.ErrNoRows) {
		return CodeWorkspace{}, ErrVersionConflict
	}
	if err != nil {
		return CodeWorkspace{}, ErrUnavailable
	}
	if _, err := tx.Exec(queryContext, `INSERT INTO tutorhub.code_workspace_mutation_receipts
        (tenant_id, actor_user_id, idempotency_key, request_fingerprint, operation,
         workspace_id, result_workspace_version, result_generation,
         result_revoke_generation, result_status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		access.TenantID, access.ActorID, command.IdempotencyKey, command.Fingerprint,
		command.Operation, result.ID, result.Version, result.CurrentGeneration,
		result.RevokeGeneration, result.Status,
	); err != nil {
		return CodeWorkspace{}, classifyWriteError(err)
	}
	if err := tx.Commit(queryContext); err != nil {
		return CodeWorkspace{}, ErrUnavailable
	}
	return result, nil
}

func (repository *PostgresCodeWorkspaceRepository) ViewerState(
	ctx context.Context,
	access AccessContext,
	workspaceID uuid.UUID,
	spaceID uuid.UUID,
	roomID uuid.UUID,
) (CodeWorkspaceViewerState, error) {
	tx, queryContext, cancel, err := repository.begin(ctx, access.TenantID, true)
	if err != nil {
		return CodeWorkspaceViewerState{}, err
	}
	defer cancel()
	defer rollback(tx)
	var roomActive bool
	var state CodeWorkspaceViewerState
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
              AND user_id = $4 AND status IN `+activeParticipantStatuses+`
        ),
        EXISTS (
            SELECT 1 FROM tutorhub.code_workspace_actor_grants
            WHERE tenant_id = $1 AND workspace_id = $5 AND actor_user_id = $4
              AND revoked_at IS NULL AND expires_at > transaction_timestamp()
        )`,
		access.TenantID, spaceID, roomID, access.ActorID, workspaceID,
	).Scan(&roomActive, &state.DynamicCoHost, &state.ActiveParticipant, &state.ActiveEditGrant)
	if err != nil {
		return CodeWorkspaceViewerState{}, ErrUnavailable
	}
	if err := tx.Commit(queryContext); err != nil {
		return CodeWorkspaceViewerState{}, ErrUnavailable
	}
	if !roomActive {
		return CodeWorkspaceViewerState{}, errCodeWorkspaceNoRoomRun
	}
	return state, nil
}

func (repository *PostgresCodeWorkspaceRepository) ActiveEditorGrants(
	ctx context.Context,
	access AccessContext,
	workspaceID uuid.UUID,
	spaceID uuid.UUID,
	roomID uuid.UUID,
) ([]CodeWorkspaceEditorGrant, error) {
	tx, queryContext, cancel, err := repository.begin(ctx, access.TenantID, true)
	if err != nil {
		return nil, err
	}
	defer cancel()
	defer rollback(tx)
	rows, err := tx.Query(queryContext, `SELECT participant.participant_key, actor_grant.expires_at
        FROM tutorhub.code_workspace_actor_grants AS actor_grant
        JOIN tutorhub.code_workspaces AS workspace
          ON workspace.tenant_id = actor_grant.tenant_id
         AND workspace.id = actor_grant.workspace_id
         AND workspace.media_space_id = $2
        JOIN tutorhub.media_participant_sessions AS participant
          ON participant.tenant_id = actor_grant.tenant_id
         AND participant.space_id = $2
         AND participant.room_instance_id = $3
         AND participant.user_id = actor_grant.actor_user_id
         AND participant.status IN `+activeParticipantStatuses+`
        WHERE actor_grant.tenant_id = $1 AND actor_grant.workspace_id = $4
          AND actor_grant.revoked_at IS NULL
          AND actor_grant.expires_at > transaction_timestamp()
        ORDER BY actor_grant.expires_at, participant.participant_key
        LIMIT $5`,
		access.TenantID, spaceID, roomID, workspaceID, codeWorkspaceMaximumGrantResult,
	)
	if err != nil {
		return nil, ErrUnavailable
	}
	defer rows.Close()
	grants := make([]CodeWorkspaceEditorGrant, 0, CodeWorkspaceMaxActiveEditors)
	for rows.Next() {
		var grant CodeWorkspaceEditorGrant
		if err := rows.Scan(&grant.ParticipantKey, &grant.ExpiresAt); err != nil {
			return nil, ErrUnavailable
		}
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

func (repository *PostgresCodeWorkspaceRepository) PutEditorGrant(
	ctx context.Context,
	access AccessContext,
	command CodeWorkspaceEditorGrantCommand,
) (CodeWorkspaceEditorGrantResult, error) {
	ttlSeconds := int64(command.TTL / time.Second)
	if ttlSeconds < int64(CodeWorkspaceMinimumEditorTTL/time.Second) ||
		ttlSeconds > int64(CodeWorkspaceMaximumEditorTTL/time.Second) {
		return CodeWorkspaceEditorGrantResult{}, ErrInvalidRequest
	}
	tx, queryContext, cancel, err := repository.begin(ctx, access.TenantID, false)
	if err != nil {
		return CodeWorkspaceEditorGrantResult{}, err
	}
	defer cancel()
	defer rollback(tx)
	if err := lockCodeWorkspaceForGrants(queryContext, tx, access, command.WorkspaceID, command.MediaSpaceID, command.RoomInstanceID, true); err != nil {
		return CodeWorkspaceEditorGrantResult{}, err
	}
	target, err := loadCodeWorkspaceGrantTarget(queryContext, tx, access.TenantID, command.MediaSpaceID, command.RoomInstanceID, command.ParticipantKey)
	if err != nil {
		return CodeWorkspaceEditorGrantResult{}, err
	}
	if target.effectiveRole != "attendee" || target.userID == access.ActorID {
		return CodeWorkspaceEditorGrantResult{}, ErrGrantTargetIneligible
	}
	// Grants of actors who left the active RoomInstance are withdrawn before
	// counting, so the "at most three effective editors" invariant holds and a
	// departed student never pins a slot.
	rows, err := tx.Query(queryContext, `UPDATE tutorhub.code_workspace_actor_grants AS actor_grant
        SET revoked_at = transaction_timestamp(), revoked_by = $5, version = actor_grant.version + 1
        WHERE actor_grant.tenant_id = $1 AND actor_grant.workspace_id = $2
          AND actor_grant.revoked_at IS NULL
          AND actor_grant.expires_at > transaction_timestamp()
          AND NOT EXISTS (
              SELECT 1 FROM tutorhub.media_participant_sessions AS participant
              WHERE participant.tenant_id = actor_grant.tenant_id
                AND participant.space_id = $3
                AND participant.room_instance_id = $4
                AND participant.user_id = actor_grant.actor_user_id
                AND participant.status IN `+activeParticipantStatuses+`
          )
        RETURNING actor_grant.actor_user_id`,
		access.TenantID, command.WorkspaceID, command.MediaSpaceID, command.RoomInstanceID, access.ActorID,
	)
	if err != nil {
		return CodeWorkspaceEditorGrantResult{}, ErrUnavailable
	}
	revoked := make([]uuid.UUID, 0, CodeWorkspaceMaxActiveEditors)
	for rows.Next() {
		var actorID uuid.UUID
		if err := rows.Scan(&actorID); err != nil {
			rows.Close()
			return CodeWorkspaceEditorGrantResult{}, ErrUnavailable
		}
		revoked = append(revoked, actorID)
	}
	rows.Close()
	if rows.Err() != nil {
		return CodeWorkspaceEditorGrantResult{}, ErrUnavailable
	}
	var others int64
	if err := tx.QueryRow(queryContext, `SELECT count(*)
        FROM tutorhub.code_workspace_actor_grants
        WHERE tenant_id = $1 AND workspace_id = $2 AND actor_user_id <> $3
          AND revoked_at IS NULL AND expires_at > transaction_timestamp()`,
		access.TenantID, command.WorkspaceID, target.userID,
	).Scan(&others); err != nil {
		return CodeWorkspaceEditorGrantResult{}, ErrUnavailable
	}
	if others >= CodeWorkspaceMaxActiveEditors {
		return CodeWorkspaceEditorGrantResult{}, ErrEditorLimitReached
	}
	result := CodeWorkspaceEditorGrantResult{ActorID: target.userID, RevokedActors: revoked}
	err = tx.QueryRow(queryContext, `INSERT INTO tutorhub.code_workspace_actor_grants
        (tenant_id, workspace_id, actor_user_id, capability, granted_by, granted_at, expires_at)
        VALUES ($1, $2, $3, 'edit', $4, transaction_timestamp(),
                transaction_timestamp() + ($5::bigint * interval '1 second'))
        ON CONFLICT (tenant_id, workspace_id, actor_user_id) DO UPDATE SET
            granted_by = EXCLUDED.granted_by,
            granted_at = EXCLUDED.granted_at,
            expires_at = EXCLUDED.expires_at,
            revoked_at = NULL,
            revoked_by = NULL,
            version = code_workspace_actor_grants.version + 1
        RETURNING expires_at`,
		access.TenantID, command.WorkspaceID, target.userID, access.ActorID, ttlSeconds,
	).Scan(&result.Grant.ExpiresAt)
	if err != nil {
		return CodeWorkspaceEditorGrantResult{}, classifyWriteError(err)
	}
	result.Grant.ParticipantKey = target.participantKey
	if err := tx.Commit(queryContext); err != nil {
		return CodeWorkspaceEditorGrantResult{}, ErrUnavailable
	}
	return result, nil
}

func (repository *PostgresCodeWorkspaceRepository) RevokeEditorGrant(
	ctx context.Context,
	access AccessContext,
	command CodeWorkspaceEditorRevokeCommand,
) (CodeWorkspaceEditorRevokeResult, error) {
	tx, queryContext, cancel, err := repository.begin(ctx, access.TenantID, false)
	if err != nil {
		return CodeWorkspaceEditorRevokeResult{}, err
	}
	defer cancel()
	defer rollback(tx)
	if err := lockCodeWorkspaceForGrants(queryContext, tx, access, command.WorkspaceID, command.MediaSpaceID, command.RoomInstanceID, false); err != nil {
		return CodeWorkspaceEditorRevokeResult{}, err
	}
	target, err := loadCodeWorkspaceGrantTarget(queryContext, tx, access.TenantID, command.MediaSpaceID, command.RoomInstanceID, command.ParticipantKey)
	if err != nil {
		return CodeWorkspaceEditorRevokeResult{}, err
	}
	tag, err := tx.Exec(queryContext, `UPDATE tutorhub.code_workspace_actor_grants
        SET revoked_at = transaction_timestamp(), revoked_by = $4, version = version + 1
        WHERE tenant_id = $1 AND workspace_id = $2 AND actor_user_id = $3
          AND revoked_at IS NULL`,
		access.TenantID, command.WorkspaceID, target.userID, access.ActorID,
	)
	if err != nil {
		return CodeWorkspaceEditorRevokeResult{}, classifyWriteError(err)
	}
	if err := tx.Commit(queryContext); err != nil {
		return CodeWorkspaceEditorRevokeResult{}, ErrUnavailable
	}
	return CodeWorkspaceEditorRevokeResult{ActorID: target.userID, Revoked: tag.RowsAffected() > 0}, nil
}

type codeWorkspaceGrantTarget struct {
	userID         uuid.UUID
	participantKey uuid.UUID
	effectiveRole  string
}

// lockCodeWorkspaceForGrants serializes grant mutations per workspace and
// re-checks, inside the transaction, that the workspace still belongs to the
// authorized MediaSpace and that the RoomInstance is still active.
func lockCodeWorkspaceForGrants(
	ctx context.Context,
	tx pgx.Tx,
	access AccessContext,
	workspaceID, spaceID, roomID uuid.UUID,
	requireOpen bool,
) error {
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		"code-workspace-editors:"+access.TenantID.String()+":"+workspaceID.String(),
	); err != nil {
		return ErrUnavailable
	}
	var status DocumentStatus
	var roomActive bool
	err := tx.QueryRow(ctx, `SELECT workspace.status, EXISTS (
            SELECT 1 FROM tutorhub.media_room_instances
            WHERE tenant_id = workspace.tenant_id AND space_id = workspace.media_space_id
              AND id = $4 AND status = 'active'
        )
        FROM tutorhub.code_workspaces AS workspace
        WHERE workspace.tenant_id = $1 AND workspace.id = $2 AND workspace.media_space_id = $3
        FOR UPDATE OF workspace`,
		access.TenantID, workspaceID, spaceID, roomID,
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

func loadCodeWorkspaceGrantTarget(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, spaceID, roomID, participantKey uuid.UUID,
) (codeWorkspaceGrantTarget, error) {
	var target codeWorkspaceGrantTarget
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
          AND participant.status IN `+activeParticipantStatuses+`
        LIMIT 1`,
		tenantID, spaceID, roomID, participantKey,
	).Scan(&target.userID, &target.participantKey, &target.effectiveRole)
	if errors.Is(err, pgx.ErrNoRows) {
		return codeWorkspaceGrantTarget{}, ErrNotFound
	}
	if err != nil {
		return codeWorkspaceGrantTarget{}, ErrUnavailable
	}
	return target, nil
}

func loadCodeWorkspace(
	ctx context.Context,
	tx pgx.Tx,
	column string,
	tenantID uuid.UUID,
	value uuid.UUID,
	lock bool,
) (CodeWorkspace, error) {
	if column != `id` && column != `media_space_id` {
		return CodeWorkspace{}, ErrInvalidRequest
	}
	query := `SELECT ` + codeWorkspaceColumns + `
        FROM tutorhub.code_workspaces WHERE tenant_id = $1 AND ` + column + ` = $2`
	if lock {
		query += ` FOR UPDATE`
	}
	var workspace CodeWorkspace
	return workspace, scanCodeWorkspace(tx.QueryRow(ctx, query, tenantID, value), &workspace)
}

func scanCodeWorkspace(row pgx.Row, workspace *CodeWorkspace) error {
	return row.Scan(&workspace.ID, &workspace.MediaSpaceID, &workspace.Status, &workspace.Version,
		&workspace.CurrentGeneration, &workspace.RevokeGeneration,
		&workspace.CreatedAt, &workspace.UpdatedAt)
}

func loadCodeWorkspaceMutationReplay(
	ctx context.Context,
	tx pgx.Tx,
	access AccessContext,
	command TransitionCommand,
) (CodeWorkspace, bool, error) {
	var storedFingerprint []byte
	var storedOperation string
	var workspace CodeWorkspace
	err := tx.QueryRow(ctx, `SELECT receipt.request_fingerprint, receipt.operation,
               receipt.workspace_id, workspace.media_space_id, receipt.result_status,
               receipt.result_workspace_version, receipt.result_generation,
               receipt.result_revoke_generation, workspace.created_at, receipt.created_at
        FROM tutorhub.code_workspace_mutation_receipts AS receipt
        JOIN tutorhub.code_workspaces AS workspace
          ON workspace.tenant_id = receipt.tenant_id AND workspace.id = receipt.workspace_id
        WHERE receipt.tenant_id = $1 AND receipt.actor_user_id = $2
          AND receipt.idempotency_key = $3`,
		access.TenantID, access.ActorID, command.IdempotencyKey,
	).Scan(
		&storedFingerprint, &storedOperation, &workspace.ID, &workspace.MediaSpaceID,
		&workspace.Status, &workspace.Version, &workspace.CurrentGeneration,
		&workspace.RevokeGeneration, &workspace.CreatedAt, &workspace.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return CodeWorkspace{}, false, nil
	}
	if err != nil {
		return CodeWorkspace{}, false, ErrUnavailable
	}
	if storedOperation != command.Operation || !bytes.Equal(storedFingerprint, command.Fingerprint) ||
		workspace.ID != command.DocumentID {
		return CodeWorkspace{}, false, ErrIdempotencyConflict
	}
	return workspace, true, nil
}

// requireFeatures enforces both Slice 2 keys in the same transaction: the
// personal Code tool (ops kill-switch) and the shared collaboration rollout.
func (repository *PostgresCodeWorkspaceRepository) requireFeatures(
	ctx context.Context,
	tx pgx.Tx,
	tenantID uuid.UUID,
	read bool,
) error {
	if repository.controls == nil {
		return nil
	}
	for _, key := range []featurecontrol.FeatureKey{
		featurecontrol.FeatureClassroomCodeTool,
		featurecontrol.FeatureClassroomCodeCollaboration,
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

func classifyCodeControlError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, featurecontrol.ErrFeatureDisabled):
		return ErrFeatureDisabled
	case errors.Is(err, featurecontrol.ErrTenantNotFound),
		errors.Is(err, featurecontrol.ErrAccessDenied):
		return ErrNotFound
	case errors.Is(err, featurecontrol.ErrQuotaExceeded):
		return ErrQuotaExceeded
	default:
		return ErrUnavailable
	}
}
