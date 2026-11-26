package content

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const closedRoomFileExpirySQL = `GREATEST(cf.created_at + interval '1 second',
    COALESCE(ms.ended_at, ms.cancelled_at, ms.updated_at) + interval '30 days')`

func (repository *PostgresRepository) AnchorClosedRoomDocuments(ctx context.Context, limit int) (int, error) {
	if limit < 1 || limit > 100 {
		return 0, ErrInvalidInput
	}
	ctx, cancel := context.WithTimeout(ctx, repository.queryTimeout)
	defer cancel()
	tx, err := repository.database.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer rollback(tx)
	tag, err := tx.Exec(ctx, `
WITH candidates AS (
    SELECT cf.tenant_id, cf.id, `+closedRoomFileExpirySQL+` AS expiry
    FROM tutorhub.media_spaces ms
    JOIN tutorhub.content_files cf ON cf.tenant_id = ms.tenant_id AND cf.media_space_id = ms.id
    WHERE ms.status IN ('ended', 'cancelled')
      AND cf.deleted_at IS NULL AND cf.owner_kind = 'media_space'
      AND cf.expires_at IS DISTINCT FROM `+closedRoomFileExpirySQL+`
    ORDER BY cf.expires_at, cf.tenant_id, cf.id
    LIMIT $1 FOR UPDATE OF cf SKIP LOCKED
)
UPDATE tutorhub.content_files f SET expires_at = c.expiry
FROM candidates c WHERE f.tenant_id = c.tenant_id AND f.id = c.id`, limit)
	if err != nil {
		return 0, fmt.Errorf("anchor closed room file retention: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

// purgeRoomDocumentsTx tombstones a batch, retires active multipart uploads
// and releases quota. Its caller can use the storage targets only after commit.
func purgeRoomDocumentsTx(ctx context.Context, tx pgx.Tx, now time.Time, limit int) ([]roomStorageCleanup, error) {
	rows, err := tx.Query(ctx, `
WITH candidates AS (
    SELECT cf.tenant_id, cf.id
    FROM tutorhub.content_files cf
    JOIN tutorhub.media_spaces ms ON ms.tenant_id = cf.tenant_id AND ms.id = cf.media_space_id
    WHERE cf.deleted_at IS NULL AND cf.owner_kind = 'media_space'
      AND cf.expires_at IS NOT NULL AND cf.expires_at <= $1
      -- A closed room may still have more rows to anchor than fit in one batch.
      AND (ms.status NOT IN ('ended','cancelled') OR cf.expires_at = `+closedRoomFileExpirySQL+`)
    ORDER BY cf.expires_at, cf.tenant_id, cf.id
    LIMIT $2 FOR UPDATE OF cf SKIP LOCKED
), expired AS (
    UPDATE tutorhub.content_files f
    SET deleted_at = GREATEST($1, f.created_at, f.updated_at), deletion_reason = 'retention_expired',
        version = f.version + 1, updated_at = GREATEST($1, f.created_at, f.updated_at)
    FROM candidates c WHERE f.tenant_id = c.tenant_id AND f.id = c.id
    RETURNING f.tenant_id, f.id, f.status, f.expected_size_bytes, f.object_key, f.storage_version_id
), uploads AS (
    UPDATE tutorhub.content_file_multipart_uploads u
    SET status = 'expired', aborted_at = $1, updated_at = $1
    FROM expired e WHERE u.tenant_id = e.tenant_id AND u.file_id = e.id
      AND e.status = 'pending' AND u.status = 'active'
    RETURNING u.tenant_id, u.file_id, u.provider_upload_id
)
SELECT e.tenant_id, e.status, e.expected_size_bytes, e.object_key,
       COALESCE(e.storage_version_id, ''), COALESCE(u.provider_upload_id, '')
FROM expired e LEFT JOIN uploads u ON u.tenant_id = e.tenant_id AND u.file_id = e.id
ORDER BY e.tenant_id ASC, e.id ASC`, now, limit)
	if err != nil {
		return nil, fmt.Errorf("claim expired room files: %w", err)
	}
	defer rows.Close()
	// The sorted result gives every transaction the same tenant usage lock order.
	type quotaRelease struct {
		tenant uuid.UUID
		fileUsage
	}
	var releases []quotaRelease
	var targets []roomStorageCleanup
	for rows.Next() {
		var tenant uuid.UUID
		var status Status
		var size int64
		var target roomStorageCleanup
		if err := rows.Scan(&tenant, &status, &size, &target.key, &target.version, &target.upload); err != nil {
			return nil, err
		}
		if len(releases) == 0 || releases[len(releases)-1].tenant != tenant {
			releases = append(releases, quotaRelease{tenant: tenant})
		}
		usage := &releases[len(releases)-1]
		usage.FileCount++
		if status == StatusPending {
			usage.ReservedBytes += size
		} else {
			usage.CommittedBytes += size
		}
		targets = append(targets, target)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, release := range releases {
		tag, err := tx.Exec(ctx, `
UPDATE tutorhub.tenant_file_usage
SET file_count = file_count - $2, reserved_bytes = reserved_bytes - $3,
    committed_bytes = committed_bytes - $4, updated_at = GREATEST(updated_at, $5)
WHERE tenant_id = $1 AND file_count >= $2 AND reserved_bytes >= $3 AND committed_bytes >= $4`,
			release.tenant, release.FileCount, release.ReservedBytes, release.CommittedBytes, now)
		if err != nil {
			return nil, fmt.Errorf("release expired room file quota: %w", err)
		}
		if tag.RowsAffected() != 1 {
			return nil, fmt.Errorf("release expired room file quota: usage invariant failed")
		}
	}
	return targets, nil
}

func (repository *PostgresRepository) PurgeExpiredRoomDocuments(ctx context.Context, now time.Time, limit int) ([]roomStorageCleanup, error) {
	if limit < 1 || limit > 100 {
		return nil, ErrInvalidInput
	}
	ctx, cancel := context.WithTimeout(ctx, repository.queryTimeout)
	defer cancel()
	tx, err := repository.database.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer rollback(tx)
	targets, err := purgeRoomDocumentsTx(ctx, tx, now, limit)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return targets, nil
}
