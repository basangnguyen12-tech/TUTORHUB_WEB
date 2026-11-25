package collaboration

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tutorhub-v2/core-api/internal/modules/featurecontrol"
)

// PostgresCodeLibraryRepository persists the Slice 3 snippet library and
// scratchpads. Every statement is tenant-scoped, every write runs after both
// feature keys were re-checked in the same transaction, and quota usage is
// counted under advisory locks taken after the tenant control lock. The
// runtime role needs SELECT/INSERT/UPDATE on exact columns only: deletion is
// a soft delete and expired scratchpads are overwritten in place.
type PostgresCodeLibraryRepository struct {
	database     Database
	queryTimeout time.Duration
	controls     featurecontrol.Enforcer
}

func NewPostgresCodeLibraryRepository(
	database Database,
	queryTimeout time.Duration,
	controls featurecontrol.Enforcer,
) (*PostgresCodeLibraryRepository, error) {
	if database == nil {
		return nil, fmt.Errorf("code library database is required")
	}
	if controls == nil {
		// Quotas and both feature keys are mandatory; never run unguarded.
		return nil, fmt.Errorf("code library feature controls are required")
	}
	if queryTimeout <= 0 {
		queryTimeout = defaultQueryTimeout
	}
	return &PostgresCodeLibraryRepository{database: database, queryTimeout: queryTimeout, controls: controls}, nil
}

const codeSnippetSummaryColumns = `snippet.id, snippet.owner_user_id, snippet.visibility,
        snippet.class_id, snippet.title, snippet.description, snippet.file_name,
        snippet.language, snippet.byte_length, snippet.version, author.display_name,
        snippet.created_at, snippet.updated_at, snippet.deleted_at IS NOT NULL`

const codeSnippetDetailColumns = codeSnippetSummaryColumns + `,
        snippet.content, snippet.content_sha256`

const codeScratchpadColumns = `scratchpad.id, scratchpad.media_space_id, scratchpad.files_json,
        scratchpad.active_index, scratchpad.stdin_text, scratchpad.byte_length,
        scratchpad.shared_with_staff, scratchpad.shared_at, scratchpad.version,
        scratchpad.created_at, scratchpad.updated_at, scratchpad.expires_at`

func (repository *PostgresCodeLibraryRepository) begin(
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
	for _, key := range []featurecontrol.FeatureKey{
		featurecontrol.FeatureClassroomCodeTool,
		featurecontrol.FeatureCodeSnippetLibrary,
	} {
		var controlErr error
		if read {
			controlErr = repository.controls.RequireFeatureForRead(queryContext, tx, tenantID, key)
		} else {
			controlErr = repository.controls.RequireFeature(queryContext, tx, tenantID, key)
		}
		if controlErr != nil {
			rollback(tx)
			cancel()
			return nil, nil, nil, classifyCodeLibraryControlError(controlErr)
		}
	}
	return tx, queryContext, cancel, nil
}

func (repository *PostgresCodeLibraryRepository) ListSnippets(
	ctx context.Context,
	access AccessContext,
	query CodeSnippetListQuery,
) (CodeSnippetPage, error) {
	if query.Fetch < 2 || query.Fetch > CodeSnippetMaxPageSize+1 {
		return CodeSnippetPage{}, ErrInvalidRequest
	}
	tx, queryContext, cancel, err := repository.begin(ctx, access.TenantID, true)
	if err != nil {
		return CodeSnippetPage{}, err
	}
	defer cancel()
	defer rollback(tx)
	page := CodeSnippetPage{}
	arguments := []any{access.TenantID}
	placeholder := func(value any) string {
		arguments = append(arguments, value)
		return "$" + strconv.Itoa(len(arguments))
	}
	conditions := []string{"snippet.tenant_id = $1", "snippet.deleted_at IS NULL"}
	switch query.Scope {
	case CodeSnippetPersonal:
		// Literal predicates keep the partial keyset indexes usable.
		conditions = append(conditions, "snippet.visibility = 'personal'",
			"snippet.owner_user_id = "+placeholder(access.ActorID))
	case CodeSnippetClass:
		relation, err := loadCodeClassRelation(queryContext, tx, access, query.ClassID)
		if err != nil {
			return CodeSnippetPage{}, err
		}
		if !effectiveCodeClassRelation(access, relation).Member {
			return CodeSnippetPage{}, ErrNotFound
		}
		page.Relation = relation
		conditions = append(conditions, "snippet.visibility = 'class'",
			"snippet.class_id = "+placeholder(query.ClassID))
	default:
		return CodeSnippetPage{}, ErrInvalidRequest
	}
	if query.Language != "" {
		conditions = append(conditions, "snippet.language = "+placeholder(query.Language))
	}
	if query.Pattern != "" {
		pattern := placeholder(query.Pattern)
		conditions = append(conditions, "(snippet.title ILIKE "+pattern+` ESCAPE '\'`+
			" OR snippet.file_name ILIKE "+pattern+` ESCAPE '\'`+
			" OR snippet.description ILIKE "+pattern+` ESCAPE '\')`)
	}
	if query.After != nil {
		conditions = append(conditions, "(snippet.updated_at, snippet.id) < ("+
			placeholder(query.After.UpdatedAt)+"::timestamptz, "+placeholder(query.After.ID)+"::uuid)")
	}
	statement := `SELECT ` + codeSnippetSummaryColumns + `
        FROM tutorhub.code_snippets AS snippet
        JOIN tutorhub.users AS author ON author.id = snippet.owner_user_id
        WHERE ` + strings.Join(conditions, " AND ") + `
        ORDER BY snippet.updated_at DESC, snippet.id DESC
        LIMIT ` + placeholder(query.Fetch)
	rows, err := tx.Query(queryContext, statement, arguments...)
	if err != nil {
		return CodeSnippetPage{}, ErrUnavailable
	}
	defer rows.Close()
	for rows.Next() {
		record, err := scanCodeSnippet(rows, false)
		if err != nil {
			return CodeSnippetPage{}, ErrUnavailable
		}
		page.Records = append(page.Records, record)
	}
	if rows.Err() != nil {
		return CodeSnippetPage{}, ErrUnavailable
	}
	rows.Close()
	if err := tx.Commit(queryContext); err != nil {
		return CodeSnippetPage{}, ErrUnavailable
	}
	return page, nil
}

func (repository *PostgresCodeLibraryRepository) GetSnippet(
	ctx context.Context,
	access AccessContext,
	snippetID uuid.UUID,
) (CodeSnippetRecord, CodeLibraryClassRelation, error) {
	tx, queryContext, cancel, err := repository.begin(ctx, access.TenantID, true)
	if err != nil {
		return CodeSnippetRecord{}, CodeLibraryClassRelation{}, err
	}
	defer cancel()
	defer rollback(tx)
	record, relation, err := loadReadableCodeSnippet(queryContext, tx, access, snippetID, false)
	if err != nil {
		return CodeSnippetRecord{}, CodeLibraryClassRelation{}, err
	}
	if err := tx.Commit(queryContext); err != nil {
		return CodeSnippetRecord{}, CodeLibraryClassRelation{}, ErrUnavailable
	}
	return record, relation, nil
}

func (repository *PostgresCodeLibraryRepository) CreateSnippet(
	ctx context.Context,
	access AccessContext,
	command CodeSnippetCreateCommand,
) (CodeSnippetStoredResult, error) {
	if command.SnippetID == uuid.Nil || len(command.Fingerprint) != 32 || len(command.ContentSHA256) != 32 ||
		!validCodeSnippetVisibilityScope(command.Visibility, command.ClassID) {
		return CodeSnippetStoredResult{}, ErrInvalidRequest
	}
	tx, queryContext, cancel, err := repository.begin(ctx, access.TenantID, false)
	if err != nil {
		return CodeSnippetStoredResult{}, err
	}
	defer cancel()
	defer rollback(tx)
	if err := codeLibraryLock(queryContext, tx,
		"code-snippet-create:"+access.TenantID.String()+":"+access.ActorID.String()+":"+command.IdempotencyKey,
	); err != nil {
		return CodeSnippetStoredResult{}, err
	}
	var replayedID uuid.UUID
	var fingerprint []byte
	err = tx.QueryRow(queryContext, `SELECT id, create_request_fingerprint
        FROM tutorhub.code_snippets
        WHERE tenant_id = $1 AND owner_user_id = $2 AND create_idempotency_key = $3`,
		access.TenantID, access.ActorID, command.IdempotencyKey,
	).Scan(&replayedID, &fingerprint)
	if err == nil {
		if !bytes.Equal(fingerprint, command.Fingerprint) {
			return CodeSnippetStoredResult{}, ErrIdempotencyConflict
		}
		record, err := loadCodeSnippet(queryContext, tx, access.TenantID, replayedID, false, true)
		if err != nil {
			return CodeSnippetStoredResult{}, err
		}
		if record.Deleted {
			return CodeSnippetStoredResult{}, ErrIdempotencyConflict
		}
		relation, err := relationForCodeSnippet(queryContext, tx, access, record)
		if err != nil {
			return CodeSnippetStoredResult{}, err
		}
		if err := tx.Commit(queryContext); err != nil {
			return CodeSnippetStoredResult{}, ErrUnavailable
		}
		return CodeSnippetStoredResult{Record: record, Relation: relation}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return CodeSnippetStoredResult{}, ErrUnavailable
	}
	relation := CodeLibraryClassRelation{}
	if command.Visibility == CodeSnippetClass {
		relation, err = loadCodeClassRelation(queryContext, tx, access, command.ClassID)
		if err != nil {
			return CodeSnippetStoredResult{}, err
		}
	}
	if err := codeSnippetCreateDecision(access, command.Visibility, relation); err != nil {
		return CodeSnippetStoredResult{}, err
	}
	if err := codeLibraryLock(queryContext, tx,
		"code-snippets-member:"+access.TenantID.String()+":"+access.ActorID.String(),
	); err != nil {
		return CodeSnippetStoredResult{}, err
	}
	var owned int64
	if err := tx.QueryRow(queryContext, `SELECT count(*)
        FROM tutorhub.code_snippets
        WHERE tenant_id = $1 AND owner_user_id = $2 AND deleted_at IS NULL`,
		access.TenantID, access.ActorID,
	).Scan(&owned); err != nil {
		return CodeSnippetStoredResult{}, ErrUnavailable
	}
	if err := repository.requireQuota(queryContext, tx, access.TenantID,
		featurecontrol.QuotaCodeSnippetsPerMember, owned+1); err != nil {
		return CodeSnippetStoredResult{}, err
	}
	if err := repository.requireStorage(queryContext, tx, access.TenantID, uuid.Nil, uuid.Nil,
		0, int64(command.ByteLength)); err != nil {
		return CodeSnippetStoredResult{}, err
	}
	if _, err := tx.Exec(queryContext, `INSERT INTO tutorhub.code_snippets
        (id, tenant_id, owner_user_id, updated_by, visibility, class_id, title,
         description, file_name, language, content, byte_length, content_sha256,
         create_idempotency_key, create_request_fingerprint)
        VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
		command.SnippetID, access.TenantID, access.ActorID, string(command.Visibility),
		nullableCodeUUID(command.ClassID), command.Title, command.Description, command.FileName,
		command.Language, command.Content, command.ByteLength, command.ContentSHA256,
		command.IdempotencyKey, command.Fingerprint,
	); err != nil {
		return CodeSnippetStoredResult{}, classifyWriteError(err)
	}
	record, err := loadCodeSnippet(queryContext, tx, access.TenantID, command.SnippetID, false, true)
	if err != nil {
		return CodeSnippetStoredResult{}, ErrUnavailable
	}
	if err := tx.Commit(queryContext); err != nil {
		return CodeSnippetStoredResult{}, ErrUnavailable
	}
	return CodeSnippetStoredResult{Record: record, Relation: relation, Created: true}, nil
}

func (repository *PostgresCodeLibraryRepository) UpdateSnippet(
	ctx context.Context,
	access AccessContext,
	command CodeSnippetUpdateCommand,
) (CodeSnippetStoredResult, error) {
	tx, queryContext, cancel, err := repository.begin(ctx, access.TenantID, false)
	if err != nil {
		return CodeSnippetStoredResult{}, err
	}
	defer cancel()
	defer rollback(tx)
	record, relation, err := loadReadableCodeSnippet(queryContext, tx, access, command.SnippetID, true)
	if err != nil {
		return CodeSnippetStoredResult{}, err
	}
	if err := authorizeCodeSnippetUpdate(access, record, relation, command.ExpectedVersion); err != nil {
		return CodeSnippetStoredResult{}, err
	}
	next := applyCodeSnippetPatch(record, command)
	if err := repository.requireStorage(queryContext, tx, access.TenantID, record.ID, uuid.Nil,
		int64(record.ByteLength), int64(next.ByteLength)); err != nil {
		return CodeSnippetStoredResult{}, err
	}
	err = tx.QueryRow(queryContext, `UPDATE tutorhub.code_snippets SET
        title = $3, description = $4, file_name = $5, language = $6, content = $7,
        byte_length = $8, content_sha256 = $9, version = version + 1, updated_by = $10,
        updated_at = transaction_timestamp()
        WHERE tenant_id = $1 AND id = $2 AND version = $11 AND deleted_at IS NULL
        RETURNING version, updated_at`,
		access.TenantID, record.ID, next.Title, next.Description, next.FileName, next.Language,
		next.Content, next.ByteLength, next.ContentSHA256, access.ActorID, command.ExpectedVersion,
	).Scan(&next.Version, &next.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return CodeSnippetStoredResult{}, ErrVersionConflict
	}
	if err != nil {
		return CodeSnippetStoredResult{}, classifyWriteError(err)
	}
	if err := tx.Commit(queryContext); err != nil {
		return CodeSnippetStoredResult{}, ErrUnavailable
	}
	return CodeSnippetStoredResult{Record: next, Relation: relation}, nil
}

func (repository *PostgresCodeLibraryRepository) DeleteSnippet(
	ctx context.Context,
	access AccessContext,
	snippetID uuid.UUID,
) error {
	tx, queryContext, cancel, err := repository.begin(ctx, access.TenantID, false)
	if err != nil {
		return err
	}
	defer cancel()
	defer rollback(tx)
	record, relation, err := loadReadableCodeSnippet(queryContext, tx, access, snippetID, true)
	if err != nil {
		return err
	}
	if err := authorizeCodeSnippetDelete(access, record, relation); err != nil {
		return err
	}
	tag, err := tx.Exec(queryContext, `UPDATE tutorhub.code_snippets SET
        deleted_at = transaction_timestamp(), version = version + 1, updated_by = $3,
        updated_at = transaction_timestamp()
        WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
		access.TenantID, record.ID, access.ActorID,
	)
	if err != nil {
		return classifyWriteError(err)
	}
	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	if err := tx.Commit(queryContext); err != nil {
		return ErrUnavailable
	}
	return nil
}

func (repository *PostgresCodeLibraryRepository) GetScratchpad(
	ctx context.Context,
	access AccessContext,
	spaceID uuid.UUID,
) (*CodeScratchpad, error) {
	tx, queryContext, cancel, err := repository.begin(ctx, access.TenantID, true)
	if err != nil {
		return nil, err
	}
	defer cancel()
	defer rollback(tx)
	scratchpad, err := loadLiveCodeScratchpad(queryContext, tx, access, spaceID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(queryContext); err != nil {
		return nil, ErrUnavailable
	}
	return scratchpad, nil
}

func (repository *PostgresCodeLibraryRepository) PutScratchpad(
	ctx context.Context,
	access AccessContext,
	command CodeScratchpadPutCommand,
) (CodeScratchpad, error) {
	if command.MediaSpaceID == uuid.Nil || command.ExpectedVersion < 0 ||
		command.ByteLength < 0 || command.ByteLength > CodeScratchpadMaxByteLength {
		return CodeScratchpad{}, ErrInvalidRequest
	}
	tx, queryContext, cancel, err := repository.begin(ctx, access.TenantID, false)
	if err != nil {
		return CodeScratchpad{}, err
	}
	defer cancel()
	defer rollback(tx)
	if err := codeLibraryLock(queryContext, tx, "code-scratchpad:"+access.TenantID.String()+":"+
		access.ActorID.String()+":"+command.MediaSpaceID.String()); err != nil {
		return CodeScratchpad{}, err
	}
	var existingID uuid.UUID
	var existingVersion int64
	var existingBytes int64
	var live bool
	err = tx.QueryRow(queryContext, `SELECT id, version, byte_length,
            expires_at > transaction_timestamp()
        FROM tutorhub.code_scratchpads
        WHERE tenant_id = $1 AND owner_user_id = $2 AND media_space_id = $3
        FOR UPDATE`,
		access.TenantID, access.ActorID, command.MediaSpaceID,
	).Scan(&existingID, &existingVersion, &existingBytes, &live)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return CodeScratchpad{}, ErrUnavailable
	}
	if err := authorizeCodeScratchpadWrite(live, existingVersion, command.ExpectedVersion); err != nil {
		return CodeScratchpad{}, err
	}
	if !live {
		existingBytes = 0
	}
	if err := repository.requireStorage(queryContext, tx, access.TenantID, uuid.Nil, existingID,
		existingBytes, int64(command.ByteLength)); err != nil {
		return CodeScratchpad{}, err
	}
	scratchpad, err := scanCodeScratchpad(tx.QueryRow(queryContext, `INSERT INTO tutorhub.code_scratchpads
        AS scratchpad
        (tenant_id, owner_user_id, media_space_id, files_json, active_index, stdin_text,
         byte_length, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, transaction_timestamp() + interval '30 days')
        ON CONFLICT (tenant_id, owner_user_id, media_space_id) DO UPDATE SET
            files_json = EXCLUDED.files_json,
            active_index = EXCLUDED.active_index,
            stdin_text = EXCLUDED.stdin_text,
            byte_length = EXCLUDED.byte_length,
            shared_with_staff = CASE WHEN scratchpad.expires_at > transaction_timestamp()
                THEN scratchpad.shared_with_staff ELSE false END,
            shared_at = CASE WHEN scratchpad.expires_at > transaction_timestamp()
                THEN scratchpad.shared_at ELSE NULL END,
            version = scratchpad.version + 1,
            updated_at = transaction_timestamp(),
            expires_at = EXCLUDED.expires_at
        RETURNING `+codeScratchpadColumns,
		access.TenantID, access.ActorID, command.MediaSpaceID, command.FilesJSON,
		command.ActiveIndex, command.Stdin, command.ByteLength,
	))
	if err != nil {
		if errors.Is(err, ErrUnavailable) {
			return CodeScratchpad{}, err
		}
		return CodeScratchpad{}, classifyWriteError(err)
	}
	if err := tx.Commit(queryContext); err != nil {
		return CodeScratchpad{}, ErrUnavailable
	}
	return scratchpad, nil
}

func (repository *PostgresCodeLibraryRepository) ShareScratchpad(
	ctx context.Context,
	access AccessContext,
	spaceID uuid.UUID,
	shared bool,
) (*CodeScratchpad, error) {
	tx, queryContext, cancel, err := repository.begin(ctx, access.TenantID, false)
	if err != nil {
		return nil, err
	}
	defer cancel()
	defer rollback(tx)
	var result *CodeScratchpad
	if shared {
		scratchpad, err := scanCodeScratchpad(tx.QueryRow(queryContext, `UPDATE tutorhub.code_scratchpads
            AS scratchpad SET
            shared_with_staff = true,
            shared_at = COALESCE(scratchpad.shared_at, transaction_timestamp())
            WHERE scratchpad.tenant_id = $1 AND scratchpad.owner_user_id = $2
              AND scratchpad.media_space_id = $3
              AND scratchpad.expires_at > transaction_timestamp()
            RETURNING `+codeScratchpadColumns,
			access.TenantID, access.ActorID, spaceID,
		))
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrCodeScratchpadEmpty
		}
		if err != nil {
			return nil, ErrUnavailable
		}
		result = &scratchpad
	} else {
		// Revocation applies to expired rows too, so consent never lingers.
		if _, err := tx.Exec(queryContext, `UPDATE tutorhub.code_scratchpads SET
            shared_with_staff = false, shared_at = NULL
            WHERE tenant_id = $1 AND owner_user_id = $2 AND media_space_id = $3
              AND shared_with_staff = true`,
			access.TenantID, access.ActorID, spaceID,
		); err != nil {
			return nil, ErrUnavailable
		}
		result, err = loadLiveCodeScratchpad(queryContext, tx, access, spaceID)
		if err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(queryContext); err != nil {
		return nil, ErrUnavailable
	}
	return result, nil
}

func (repository *PostgresCodeLibraryRepository) DynamicCoHost(
	ctx context.Context,
	access AccessContext,
	spaceID uuid.UUID,
	roomID uuid.UUID,
) (bool, error) {
	tx, queryContext, cancel, err := repository.begin(ctx, access.TenantID, true)
	if err != nil {
		return false, err
	}
	defer cancel()
	defer rollback(tx)
	var promoted bool
	if err := tx.QueryRow(queryContext, `SELECT EXISTS (
            SELECT 1 FROM tutorhub.media_room_instances
            WHERE tenant_id = $1 AND space_id = $2 AND id = $3 AND status = 'active'
        ) AND EXISTS (
            SELECT 1 FROM tutorhub.media_room_role_assignments
            WHERE tenant_id = $1 AND space_id = $2 AND room_instance_id = $3
              AND user_id = $4 AND assigned_role = 'co_host' AND status = 'active'
        )`,
		access.TenantID, spaceID, roomID, access.ActorID,
	).Scan(&promoted); err != nil {
		return false, ErrUnavailable
	}
	if err := tx.Commit(queryContext); err != nil {
		return false, ErrUnavailable
	}
	return promoted, nil
}

const codeSharedScratchpadFrom = `FROM tutorhub.code_scratchpads AS scratchpad
        JOIN tutorhub.users AS author ON author.id = scratchpad.owner_user_id
        LEFT JOIN LATERAL (
            SELECT participant.participant_key
            FROM tutorhub.media_participant_sessions AS participant
            WHERE participant.tenant_id = scratchpad.tenant_id
              AND participant.space_id = scratchpad.media_space_id
              AND participant.room_instance_id = $3
              AND participant.user_id = scratchpad.owner_user_id
              AND participant.status IN ` + activeParticipantStatuses + `
            ORDER BY participant.participant_key
            LIMIT 1
        ) AS live ON true
        WHERE scratchpad.tenant_id = $1 AND scratchpad.media_space_id = $2
          AND scratchpad.shared_with_staff = true AND scratchpad.shared_at IS NOT NULL
          AND scratchpad.expires_at > transaction_timestamp()
          AND scratchpad.owner_user_id <> $4`

func (repository *PostgresCodeLibraryRepository) ListSharedScratchpads(
	ctx context.Context,
	access AccessContext,
	spaceID uuid.UUID,
	roomID uuid.UUID,
	limit int,
) ([]CodeSharedScratchpadSummary, error) {
	if limit < 1 || limit > codeSharedScratchpadListLimit {
		return nil, ErrInvalidRequest
	}
	tx, queryContext, cancel, err := repository.begin(ctx, access.TenantID, true)
	if err != nil {
		return nil, err
	}
	defer cancel()
	defer rollback(tx)
	rows, err := tx.Query(queryContext, `SELECT scratchpad.id, author.display_name, live.participant_key,
            json_array_length(scratchpad.files_json::json),
            COALESCE(scratchpad.files_json::json -> scratchpad.active_index ->> 'name', ''),
            COALESCE(scratchpad.files_json::json -> scratchpad.active_index ->> 'language', ''),
            scratchpad.byte_length, scratchpad.shared_at, scratchpad.updated_at
        `+codeSharedScratchpadFrom+`
        ORDER BY scratchpad.shared_at DESC, scratchpad.id DESC
        LIMIT $5`,
		access.TenantID, spaceID, nullableCodeUUID(roomID), access.ActorID, limit,
	)
	if err != nil {
		return nil, ErrUnavailable
	}
	defer rows.Close()
	items := make([]CodeSharedScratchpadSummary, 0)
	for rows.Next() {
		var item CodeSharedScratchpadSummary
		if err := rows.Scan(&item.ID, &item.AuthorDisplayName, &item.ParticipantKey, &item.FileCount,
			&item.ActiveFileName, &item.ActiveLanguage, &item.ByteLength, &item.SharedAt, &item.UpdatedAt,
		); err != nil {
			return nil, ErrUnavailable
		}
		item.SharedAt, item.UpdatedAt = item.SharedAt.UTC(), item.UpdatedAt.UTC()
		items = append(items, item)
	}
	if rows.Err() != nil {
		return nil, ErrUnavailable
	}
	rows.Close()
	if err := tx.Commit(queryContext); err != nil {
		return nil, ErrUnavailable
	}
	return items, nil
}

func (repository *PostgresCodeLibraryRepository) GetSharedScratchpad(
	ctx context.Context,
	access AccessContext,
	spaceID uuid.UUID,
	roomID uuid.UUID,
	scratchpadID uuid.UUID,
) (CodeSharedScratchpad, error) {
	tx, queryContext, cancel, err := repository.begin(ctx, access.TenantID, true)
	if err != nil {
		return CodeSharedScratchpad{}, err
	}
	defer cancel()
	defer rollback(tx)
	var result CodeSharedScratchpad
	var filesJSON string
	err = tx.QueryRow(queryContext, `SELECT scratchpad.id, author.display_name, live.participant_key,
            scratchpad.files_json, scratchpad.active_index, scratchpad.stdin_text,
            scratchpad.byte_length, scratchpad.shared_at, scratchpad.updated_at
        `+codeSharedScratchpadFrom+`
          AND scratchpad.id = $5`,
		access.TenantID, spaceID, nullableCodeUUID(roomID), access.ActorID, scratchpadID,
	).Scan(&result.ID, &result.AuthorDisplayName, &result.ParticipantKey, &filesJSON,
		&result.ActiveIndex, &result.Stdin, &result.ByteLength, &result.SharedAt, &result.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return CodeSharedScratchpad{}, ErrNotFound
	}
	if err != nil {
		return CodeSharedScratchpad{}, ErrUnavailable
	}
	files, err := decodeCodeScratchpadFiles(filesJSON, result.ActiveIndex)
	if err != nil {
		return CodeSharedScratchpad{}, err
	}
	result.Files = files
	result.FileCount = len(files)
	result.ActiveFileName = files[result.ActiveIndex].Name
	result.ActiveLanguage = files[result.ActiveIndex].Language
	result.SharedAt, result.UpdatedAt = result.SharedAt.UTC(), result.UpdatedAt.UTC()
	if err := tx.Commit(queryContext); err != nil {
		return CodeSharedScratchpad{}, ErrUnavailable
	}
	return result, nil
}

// requireQuota maps featurecontrol's bounded quota failure to the specific
// public quota error so clients can tell the two code quotas apart.
func (repository *PostgresCodeLibraryRepository) requireQuota(
	ctx context.Context,
	tx pgx.Tx,
	tenantID uuid.UUID,
	key featurecontrol.QuotaKey,
	requested int64,
) error {
	return classifyCodeLibraryControlError(repository.controls.RequireQuotaAtMost(ctx, tx, tenantID, key, requested))
}

// requireStorage enforces code_storage_bytes_per_tenant only when content
// grows. Usage counts live snippets and unexpired scratchpads, excluding the
// row being replaced; shrinking is always allowed so an over-quota tenant can
// still recover by trimming content.
func (repository *PostgresCodeLibraryRepository) requireStorage(
	ctx context.Context,
	tx pgx.Tx,
	tenantID uuid.UUID,
	excludedSnippetID uuid.UUID,
	excludedScratchpadID uuid.UUID,
	currentBytes int64,
	nextBytes int64,
) error {
	if _, enforce := codeStorageRequested(0, currentBytes, nextBytes); !enforce {
		return nil
	}
	if err := codeLibraryLock(ctx, tx, "code-storage:"+tenantID.String()); err != nil {
		return err
	}
	var used int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE((
            SELECT sum(byte_length) FROM tutorhub.code_snippets
            WHERE tenant_id = $1 AND deleted_at IS NULL AND id <> $2
        ), 0) + COALESCE((
            SELECT sum(byte_length) FROM tutorhub.code_scratchpads
            WHERE tenant_id = $1 AND expires_at > transaction_timestamp() AND id <> $3
        ), 0)`,
		tenantID, excludedSnippetID, excludedScratchpadID,
	).Scan(&used); err != nil {
		return ErrUnavailable
	}
	requested, _ := codeStorageRequested(used, currentBytes, nextBytes)
	return repository.requireQuota(ctx, tx, tenantID, featurecontrol.QuotaCodeStorageBytesPerTenant, requested)
}

func codeLibraryLock(ctx context.Context, tx pgx.Tx, key string) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, key); err != nil {
		return ErrUnavailable
	}
	return nil
}

func loadReadableCodeSnippet(
	ctx context.Context,
	tx pgx.Tx,
	access AccessContext,
	snippetID uuid.UUID,
	lock bool,
) (CodeSnippetRecord, CodeLibraryClassRelation, error) {
	record, err := loadCodeSnippet(ctx, tx, access.TenantID, snippetID, lock, true)
	if err != nil {
		return CodeSnippetRecord{}, CodeLibraryClassRelation{}, err
	}
	relation, err := relationForCodeSnippet(ctx, tx, access, record)
	if err != nil {
		return CodeSnippetRecord{}, CodeLibraryClassRelation{}, err
	}
	if !codeSnippetReadable(access, record, relation) {
		return CodeSnippetRecord{}, CodeLibraryClassRelation{}, ErrNotFound
	}
	return record, relation, nil
}

func loadCodeSnippet(
	ctx context.Context,
	tx pgx.Tx,
	tenantID uuid.UUID,
	snippetID uuid.UUID,
	lock bool,
	detail bool,
) (CodeSnippetRecord, error) {
	columns := codeSnippetSummaryColumns
	if detail {
		columns = codeSnippetDetailColumns
	}
	query := `SELECT ` + columns + `
        FROM tutorhub.code_snippets AS snippet
        JOIN tutorhub.users AS author ON author.id = snippet.owner_user_id
        WHERE snippet.tenant_id = $1 AND snippet.id = $2`
	if lock {
		query += ` FOR UPDATE OF snippet`
	}
	record, err := scanCodeSnippet(tx.QueryRow(ctx, query, tenantID, snippetID), detail)
	if errors.Is(err, pgx.ErrNoRows) {
		return CodeSnippetRecord{}, ErrNotFound
	}
	if err != nil {
		return CodeSnippetRecord{}, ErrUnavailable
	}
	return record, nil
}

func scanCodeSnippet(row pgx.Row, detail bool) (CodeSnippetRecord, error) {
	var record CodeSnippetRecord
	var visibility string
	var classID *uuid.UUID
	targets := []any{
		&record.ID, &record.OwnerUserID, &visibility, &classID, &record.Title,
		&record.Description, &record.FileName, &record.Language, &record.ByteLength,
		&record.Version, &record.AuthorDisplayName, &record.CreatedAt, &record.UpdatedAt,
		&record.Deleted,
	}
	if detail {
		targets = append(targets, &record.Content, &record.ContentSHA256)
	}
	if err := row.Scan(targets...); err != nil {
		return CodeSnippetRecord{}, err
	}
	record.Visibility = CodeSnippetVisibility(visibility)
	if classID != nil {
		record.ClassID = *classID
	}
	record.CreatedAt, record.UpdatedAt = record.CreatedAt.UTC(), record.UpdatedAt.UTC()
	return record, nil
}

func relationForCodeSnippet(
	ctx context.Context,
	tx pgx.Tx,
	access AccessContext,
	record CodeSnippetRecord,
) (CodeLibraryClassRelation, error) {
	if record.Visibility != CodeSnippetClass {
		return CodeLibraryClassRelation{}, nil
	}
	return loadCodeClassRelation(ctx, tx, access, record.ClassID)
}

// loadCodeClassRelation derives class authority from the live roster inside
// the caller's transaction: owner or active co_teacher/teaching_assistant is
// staff; any active enrollment is a member. Organization admins are lifted by
// effectiveCodeClassRelation once the class is known to exist in the tenant.
func loadCodeClassRelation(
	ctx context.Context,
	tx pgx.Tx,
	access AccessContext,
	classID uuid.UUID,
) (CodeLibraryClassRelation, error) {
	if classID == uuid.Nil {
		return CodeLibraryClassRelation{}, nil
	}
	var relation CodeLibraryClassRelation
	if err := tx.QueryRow(ctx, `SELECT
            EXISTS (
                SELECT 1 FROM tutorhub.classes WHERE tenant_id = $1 AND id = $2
            ),
            EXISTS (
                SELECT 1 FROM tutorhub.classes
                WHERE tenant_id = $1 AND id = $2 AND owner_user_id = $3
            ) OR EXISTS (
                SELECT 1 FROM tutorhub.class_enrollments
                WHERE tenant_id = $1 AND class_id = $2 AND user_id = $3
                  AND status = 'active' AND class_role IN ('co_teacher', 'teaching_assistant')
            ),
            EXISTS (
                SELECT 1 FROM tutorhub.class_enrollments
                WHERE tenant_id = $1 AND class_id = $2 AND user_id = $3 AND status = 'active'
            )`,
		access.TenantID, classID, access.ActorID,
	).Scan(&relation.Exists, &relation.Staff, &relation.Member); err != nil {
		return CodeLibraryClassRelation{}, ErrUnavailable
	}
	if relation.Staff {
		relation.Member = true
	}
	return relation, nil
}

func loadLiveCodeScratchpad(
	ctx context.Context,
	tx pgx.Tx,
	access AccessContext,
	spaceID uuid.UUID,
) (*CodeScratchpad, error) {
	scratchpad, err := scanCodeScratchpad(tx.QueryRow(ctx, `SELECT `+codeScratchpadColumns+`
        FROM tutorhub.code_scratchpads AS scratchpad
        WHERE scratchpad.tenant_id = $1 AND scratchpad.owner_user_id = $2
          AND scratchpad.media_space_id = $3
          AND scratchpad.expires_at > transaction_timestamp()`,
		access.TenantID, access.ActorID, spaceID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, ErrUnavailable
	}
	return &scratchpad, nil
}

func scanCodeScratchpad(row pgx.Row) (CodeScratchpad, error) {
	var scratchpad CodeScratchpad
	var filesJSON string
	if err := row.Scan(&scratchpad.ID, &scratchpad.MediaSpaceID, &filesJSON, &scratchpad.ActiveIndex,
		&scratchpad.Stdin, &scratchpad.ByteLength, &scratchpad.SharedWithStaff, &scratchpad.SharedAt,
		&scratchpad.Version, &scratchpad.CreatedAt, &scratchpad.UpdatedAt, &scratchpad.ExpiresAt,
	); err != nil {
		return CodeScratchpad{}, err
	}
	files, err := decodeCodeScratchpadFiles(filesJSON, scratchpad.ActiveIndex)
	if err != nil {
		return CodeScratchpad{}, ErrUnavailable
	}
	scratchpad.Files = files
	scratchpad.CreatedAt = scratchpad.CreatedAt.UTC()
	scratchpad.UpdatedAt = scratchpad.UpdatedAt.UTC()
	scratchpad.ExpiresAt = scratchpad.ExpiresAt.UTC()
	if scratchpad.SharedAt != nil {
		sharedAt := scratchpad.SharedAt.UTC()
		scratchpad.SharedAt = &sharedAt
	}
	return scratchpad, nil
}

func nullableCodeUUID(id uuid.UUID) *uuid.UUID {
	if id == uuid.Nil {
		return nil
	}
	return &id
}

func classifyCodeLibraryControlError(err error) error {
	var quota *featurecontrol.QuotaExceededError
	switch {
	case err == nil:
		return nil
	case errors.Is(err, featurecontrol.ErrFeatureDisabled):
		return ErrFeatureDisabled
	case errors.As(err, &quota) && quota.Quota == featurecontrol.QuotaCodeSnippetsPerMember:
		return ErrCodeSnippetQuotaExceeded
	case errors.As(err, &quota) && quota.Quota == featurecontrol.QuotaCodeStorageBytesPerTenant:
		return ErrCodeStorageQuotaExceeded
	case errors.Is(err, featurecontrol.ErrQuotaExceeded):
		return ErrQuotaExceeded
	case errors.Is(err, featurecontrol.ErrTenantNotFound),
		errors.Is(err, featurecontrol.ErrAccessDenied):
		return ErrNotFound
	default:
		return ErrUnavailable
	}
}
