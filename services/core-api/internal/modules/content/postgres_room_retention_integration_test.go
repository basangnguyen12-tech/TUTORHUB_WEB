//go:build integration

package content

import (
	"context"
	"errors"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tutorhub-v2/core-api/migrations"
)

func TestPostgresRoomDocumentMigration58RoundTrip(t *testing.T) {
	// The owner explicitly supplies a separate, disposable loopback database:
	// this test actually drops the note table while exercising the down script.
	rawURL := os.Getenv("ROOM_DOCUMENT_MIGRATION_TEST_URL")
	if rawURL == "" {
		t.Skip("requires a disposable ROOM_DOCUMENT_MIGRATION_TEST_URL")
	}
	u, err := url.Parse(rawURL)
	if err != nil || (u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" && u.Hostname() != "::1") {
		t.Fatal("migration round trip requires a loopback PostgreSQL database")
	}
	src, err := iofs.New(migrations.Files, ".")
	if err != nil {
		t.Fatal(err)
	}
	query := u.Query()
	query.Set("x-migrations-table", "tutorhub_schema_migrations")
	u.RawQuery = query.Encode()
	runner, err := migrate.NewWithSourceInstance("iofs", src, u.String())
	if err != nil {
		t.Fatal("open disposable migration runner")
	}
	defer runner.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool := openContentPool(t, ctx, rawURL)
	defer pool.Close()
	for _, target := range []uint{57, 58, 57, 58} {
		if err := runner.Migrate(target); err != nil && !errors.Is(err, migrate.ErrNoChange) {
			t.Fatalf("migrate to %d: %v", target, err)
		}
		v, dirty, err := runner.Version()
		if err != nil || v != target || dirty {
			t.Fatalf("migration ledger: got %d dirty=%v err=%v", v, dirty, err)
		}
		for _, name := range []string{"document_study_notes", "document_study_notes_owner_updated_idx",
			"content_files_media_space_retention_idx", "media_spaces_document_retention_closed_idx"} {
			var present bool
			if err := pool.QueryRow(ctx, "SELECT to_regclass($1) IS NOT NULL", "tutorhub."+name).Scan(&present); err != nil || present != (v == 58) {
				t.Fatalf("%s at %d: present=%v err=%v", name, v, present, err)
			}
		}
	}
}

func TestPostgresRoomRetentionAnchorAndConcurrentPurge(t *testing.T) {
	owner, runtime, a, roomA := newRoom03Fixture(t)
	_, _, b, roomB := newRoom03Fixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	repo := &PostgresRepository{database: runtime, queryTimeout: 5 * time.Second}
	// Both close dates are the same, independent of the order that UUIDs sort in.
	closed := time.Now().UTC().Add(time.Minute).Truncate(time.Microsecond)
	seedRetentionFile(t, owner, a, roomA, closed, true)
	seedRetentionFile(t, owner, b, roomB, closed, false)
	if n, err := repo.AnchorClosedRoomDocuments(ctx, 1); err != nil || n != 1 {
		t.Fatalf("first anchor batch = %d, %v", n, err)
	}
	if targets, err := repo.PurgeExpiredRoomDocuments(ctx, closed, 2); err != nil || len(targets) != 0 {
		t.Fatalf("early purge while a file still needs anchoring = %d, %v", len(targets), err)
	}
	for _, want := range []int{1, 0} {
		if n, err := repo.AnchorClosedRoomDocuments(ctx, 1); err != nil || n != want {
			t.Fatalf("anchor batch: got %d, %v, want %d", n, err, want)
		}
	}
	expires := closed.Add(30 * 24 * time.Hour)
	for _, tenant := range []uuid.UUID{a.tenantID, b.tenantID} {
		var expiry time.Time
		if err := owner.QueryRow(ctx, "SELECT expires_at FROM tutorhub.content_files WHERE tenant_id = $1", tenant).Scan(&expiry); err != nil || !expiry.Equal(expires) {
			t.Fatalf("anchored expiry = %s, want %s, err=%v", expiry, expires, err)
		}
	}

	// First transaction completes its SQL while retaining its file and usage
	// locks. A second transaction must take the other file and can commit first.
	tx1, err := runtime.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer rollback(tx1)
	first, err := purgeRoomDocumentsTx(ctx, tx1, expires, 1)
	if err != nil || len(first) != 1 {
		t.Fatalf("first purge = %d, %v", len(first), err)
	}
	second, err := repo.PurgeExpiredRoomDocuments(ctx, expires, 1)
	if err != nil || len(second) != 1 || second[0].key == first[0].key {
		t.Fatalf("second transaction must claim exactly one distinct file: len=%d err=%v", len(second), err)
	}
	if err := tx1.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	got := append(first, second...)
	if !((got[0].version == "retention-version" && got[1].upload == "retention-upload") ||
		(got[1].version == "retention-version" && got[0].upload == "retention-upload")) {
		t.Fatal("missing committed version or expired multipart cleanup target")
	}
	for _, tenant := range []uuid.UUID{a.tenantID, b.tenantID} {
		var ok bool
		if err := owner.QueryRow(ctx, `
SELECT f.deleted_at = $2 AND f.updated_at = $2 AND f.version = 2
    AND f.deletion_reason = 'retention_expired'
    AND u.file_count = 0 AND u.committed_bytes = 0 AND u.reserved_bytes = 0
FROM tutorhub.content_files f JOIN tutorhub.tenant_file_usage u USING (tenant_id)
WHERE f.tenant_id = $1`, tenant, expires).Scan(&ok); err != nil || !ok {
			t.Fatalf("retention tombstone and usage: ok=%v err=%v", ok, err)
		}
	}
	var expired bool
	if err := owner.QueryRow(ctx, `SELECT status = 'expired' AND aborted_at = $2 AND updated_at = $2
FROM tutorhub.content_file_multipart_uploads WHERE tenant_id = $1`, a.tenantID, expires).Scan(&expired); err != nil || !expired {
		t.Fatalf("pending multipart must expire: %v, %v", expired, err)
	}
	if targets, err := repo.PurgeExpiredRoomDocuments(ctx, expires, 100); err != nil || len(targets) != 0 {
		t.Fatalf("cleanup replay = %d, %v", len(targets), err)
	}
}

func seedRetentionFile(t *testing.T, pool *pgxpool.Pool, fixture contentIntegrationFixture, room roomDocumentFixture, closed time.Time, pending bool) {
	t.Helper()
	ctx := context.Background()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	id := uuid.New()
	exec(`INSERT INTO tutorhub.content_files
    (id, tenant_id, media_space_id, owner_kind, creator_user_id, client_request_id, request_fingerprint,
     object_key, display_name, declared_media_type, expected_size_bytes, expected_checksum_sha256,
     created_at, updated_at, expires_at, upload_expires_at)
VALUES ($1, $2, $3, 'media_space', $4, gen_random_uuid(), decode(repeat('12',32),'hex'),
    'tenants/' || $2::uuid::text || '/files/' || $1::uuid::text || '/original', 'notes.pdf', 'application/pdf', 13,
    decode(repeat('34',32),'hex'), $5::timestamptz - interval '35 days', $5::timestamptz - interval '35 days',
    $5::timestamptz - interval '5 days', $5::timestamptz - interval '34 days')`,
		id, fixture.tenantID, room.spaceID, fixture.ownerID, closed)
	if pending {
		exec(`UPDATE tutorhub.media_spaces SET status = 'ended', ended_at = $2, updated_at = $2,
    ended_by = created_by, locked = false WHERE id = $1`, room.spaceID, closed)
		exec(`INSERT INTO tutorhub.content_file_multipart_uploads
    (id, tenant_id, file_id, creator_user_id, provider_upload_id, expected_file_version, expires_at)
VALUES (gen_random_uuid(), $1, $2, $3, 'retention-upload', 1, now() + interval '1 hour')`, fixture.tenantID, id, fixture.ownerID)
		exec(`INSERT INTO tutorhub.tenant_file_usage (tenant_id, file_count, reserved_bytes) VALUES ($1, 1, 13)`, fixture.tenantID)
	} else {
		exec(`UPDATE tutorhub.media_spaces SET status = 'cancelled', cancelled_at = $2, updated_at = $2,
    cancelled_by = created_by, opened_by = NULL, opened_at = NULL, locked = false WHERE id = $1`, room.spaceID, closed)
		exec(`UPDATE tutorhub.content_files SET status = 'uploaded', uploaded_at = updated_at,
    stored_media_type = declared_media_type, stored_size_bytes = expected_size_bytes,
    storage_version_id = 'retention-version', storage_etag = 'etag' WHERE id = $1`, id)
		exec(`INSERT INTO tutorhub.tenant_file_usage (tenant_id, file_count, committed_bytes) VALUES ($1, 1, 13)`, fixture.tenantID)
	}
}
