//go:build integration

package collaboration

import (
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tutorhub-v2/core-api/internal/modules/featurecontrol"
	"github.com/tutorhub-v2/core-api/internal/platform/migrationrunner"
	"github.com/tutorhub-v2/core-api/internal/policy"
)

// ROOM-TOOLS-FILES-02A disposable PostgreSQL gate. It exercises the exact SQL
// of PostgresPdfPresentationRepository: the atomic A -> B -> A switch that
// reuses one row/generation/checkpoint per file version, the partial unique
// index "one open presentation per room", receipts, tenant concealment and
// the three feature keys. Run only against a disposable database:
//
//	ROOM_TOOLS_FILES_02A_DISPOSABLE_CONFIRM=I_UNDERSTAND_ROOM_TOOLS_FILES_02A_DISPOSABLE_ONLY \
//	DATABASE_MIGRATION_URL=... go test -count=1 -tags=integration \
//	  -run '^TestPostgresPdfPresentationSwitchInvariants$' ./services/core-api/internal/modules/collaboration
const roomToolsFiles02ADisposableConfirmation = "I_UNDERSTAND_ROOM_TOOLS_FILES_02A_DISPOSABLE_ONLY"

func TestPostgresPdfPresentationSwitchInvariants(t *testing.T) {
	if strings.TrimSpace(os.Getenv("ROOM_TOOLS_FILES_02A_DISPOSABLE_CONFIRM")) != roomToolsFiles02ADisposableConfirmation {
		t.Skip("ROOM_TOOLS_FILES_02A_DISPOSABLE_CONFIRM is not set to the disposable-only confirmation")
	}
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_MIGRATION_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_MIGRATION_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	if err := migrationrunner.Up(ctx, databaseURL); err != nil {
		t.Fatalf("apply ROOM-TOOLS-FILES-02A migrations: %v", err)
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal("open ROOM-TOOLS-FILES-02A pool")
	}
	t.Cleanup(pool.Close)

	fixture := seedWhiteboardPostgresFixture(t, ctx, pool)
	t.Cleanup(func() { cleanupPdfPresentationFixture(t, pool, fixture) })
	var spaceID, classID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT id, class_id FROM tutorhub.media_spaces WHERE tenant_id = $1`,
		fixture.tenantID).Scan(&spaceID, &classID); err != nil {
		t.Fatalf("load ROOM-TOOLS-FILES-02A media space: %v", err)
	}
	fileA := seedReadyPdfFile(t, ctx, pool, fixture, classID, "version-a")
	fileB := seedReadyPdfFile(t, ctx, pool, fixture, classID, "version-b")

	controls, err := featurecontrol.NewPostgresRepository(pool, 10*time.Second, policy.NewEngine(), featurecontrol.NewDefaultCatalog())
	if err != nil {
		t.Fatal("build ROOM-TOOLS-FILES-02A feature controls")
	}
	repository, err := NewPostgresPdfPresentationRepository(pool, 10*time.Second, PostgresRepositoryConfig{Controls: controls})
	if err != nil {
		t.Fatal("build ROOM-TOOLS-FILES-02A repository")
	}
	access := AccessContext{
		TenantID: fixture.tenantID, ActorID: fixture.actorID, SessionID: uuid.New(),
		MembershipActive: true, OrganizationRoles: []policy.OrganizationRole{policy.OrganizationRoleTeacher},
	}
	present := func(fileID uuid.UUID, version, key string) (PdfPresentResult, error) {
		id := uuid.New()
		return repository.Present(ctx, access, PdfPresentCommand{
			PresentationID: id, MediaSpaceID: spaceID, FileID: fileID, VersionID: version, PageCount: 4,
			ProviderDocumentName: opaquePdfAnnotationsProviderName(id), IdempotencyKey: key,
			Fingerprint: pdfPresentFingerprint(spaceID, fileID), OccurredAt: time.Now().UTC(),
		})
	}

	if _, err := present(fileA, "version-a", "pdf-integration-feature-off"); !errors.Is(err, ErrFeatureDisabled) {
		t.Fatalf("classroom_pdf_collaboration must default off: %v", err)
	}
	for _, key := range []string{"classroom_files_tool", "classroom_pdf_collaboration"} {
		if _, err := pool.Exec(ctx, `INSERT INTO tutorhub.tenant_feature_overrides
            (tenant_id, feature_key, enabled, updated_by, created_at, updated_at)
            VALUES ($1, $2, true, $3, now(), now())`, fixture.tenantID, key, fixture.actorID); err != nil {
			t.Fatalf("enable %s: %v", key, err)
		}
	}

	first, err := present(fileA, "version-a", "pdf-integration-present-a-1")
	if err != nil || !first.Created || first.Presentation.Status != DocumentOpen {
		t.Fatalf("present A = %+v err=%v", first, err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO tutorhub.pdf_presentation_checkpoints
        (tenant_id, presentation_id, generation, provider_document_name, schema_version,
         provider_version, causal_watermark, yjs_state, byte_length, checksum, writer_fence)
        SELECT $1, $2, 1, provider_document_name, 1, 'hocuspocus@4.6.0+yjs@13.6.27', 1,
               '\x01'::bytea, 1, $3, 1
        FROM tutorhub.pdf_presentation_generations
        WHERE tenant_id = $1 AND presentation_id = $2 AND generation = 1`,
		fixture.tenantID, first.Presentation.ID, pdfChecksum([]byte{1})); err != nil {
		t.Fatalf("seed A checkpoint: %v", err)
	}
	replayed, err := present(fileA, "version-a", "pdf-integration-present-a-1")
	if err != nil || replayed.Created || replayed.Presentation.ID != first.Presentation.ID {
		t.Fatalf("idempotent replay = %+v err=%v", replayed, err)
	}
	if _, err := present(fileB, "version-b", "pdf-integration-present-a-1"); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("reused key for another file error = %v, want idempotency conflict", err)
	}

	second, err := present(fileB, "version-b", "pdf-integration-present-b-1")
	if err != nil || !second.Created || len(second.Suspended) != 1 || second.Suspended[0] != first.Presentation.ID {
		t.Fatalf("switch to B = %+v err=%v", second, err)
	}
	suspendedA, err := repository.Get(ctx, access, first.Presentation.ID)
	if err != nil || suspendedA.Status != DocumentSuspended || suspendedA.RevokeGeneration != 2 {
		t.Fatalf("A after switch = %+v err=%v", suspendedA, err)
	}

	back, err := present(fileA, "version-a", "pdf-integration-present-a-2")
	if err != nil || back.Created || back.Presentation.ID != first.Presentation.ID ||
		back.Presentation.CurrentGeneration != 1 || back.Presentation.Status != DocumentOpen ||
		len(back.Suspended) != 1 || back.Suspended[0] != second.Presentation.ID {
		t.Fatalf("return to A = %+v err=%v", back, err)
	}
	var checkpoints, openCount int
	if err := pool.QueryRow(ctx, `SELECT
        (SELECT count(*) FROM tutorhub.pdf_presentation_checkpoints WHERE tenant_id = $1 AND presentation_id = $2),
        (SELECT count(*) FROM tutorhub.pdf_presentations WHERE tenant_id = $1 AND media_space_id = $3 AND status = 'open')`,
		fixture.tenantID, first.Presentation.ID, spaceID).Scan(&checkpoints, &openCount); err != nil {
		t.Fatalf("inspect switch invariants: %v", err)
	}
	if checkpoints != 1 || openCount != 1 {
		t.Fatalf("A checkpoint=%d open=%d, want 1 and 1", checkpoints, openCount)
	}
	_, err = pool.Exec(ctx, `UPDATE tutorhub.pdf_presentations SET status = 'open', updated_at = now()
        WHERE tenant_id = $1 AND id = $2`, fixture.tenantID, second.Presentation.ID)
	var postgresError *pgconn.PgError
	if !errors.As(err, &postgresError) || postgresError.Code != "23505" ||
		postgresError.ConstraintName != "pdf_presentations_one_open_per_space_idx" {
		t.Fatalf("a second open presentation must violate the partial unique index: %v", err)
	}

	resumed, err := repository.Transition(ctx, access, TransitionCommand{
		DocumentID: second.Presentation.ID, Operation: "resume", ExpectedVersion: 2,
		IdempotencyKey: "pdf-integration-resume-b-1",
		Fingerprint:    pdfTransitionFingerprint("resume", second.Presentation.ID, 2), OccurredAt: time.Now().UTC(),
	})
	if err != nil || resumed.Presentation.Status != DocumentOpen || len(resumed.Suspended) != 1 ||
		resumed.Suspended[0] != first.Presentation.ID {
		t.Fatalf("resume B = %+v err=%v", resumed, err)
	}
	closed, err := repository.Transition(ctx, access, TransitionCommand{
		DocumentID: second.Presentation.ID, Operation: "close", ExpectedVersion: resumed.Presentation.Version,
		IdempotencyKey: "pdf-integration-close-b-1",
		Fingerprint:    pdfTransitionFingerprint("close", second.Presentation.ID, resumed.Presentation.Version), OccurredAt: time.Now().UTC(),
	})
	if err != nil || closed.Presentation.Status != DocumentClosed {
		t.Fatalf("close B = %+v err=%v", closed, err)
	}
	current, err := repository.Current(ctx, access, spaceID)
	if err != nil || current.ID != first.Presentation.ID || current.Status != DocumentSuspended {
		t.Fatalf("current after closing B = %+v err=%v", current, err)
	}
	reopened, err := present(fileB, "version-b", "pdf-integration-present-b-2")
	if err != nil || reopened.Created || reopened.Presentation.ID != second.Presentation.ID ||
		reopened.Presentation.Status != DocumentOpen {
		t.Fatalf("re-presenting closed B = %+v err=%v", reopened, err)
	}

	foreign := access
	foreign.TenantID = uuid.New()
	if _, err := repository.Get(ctx, foreign, first.Presentation.ID); err == nil {
		t.Fatal("a foreign tenant must never load the presentation")
	}
}

func seedReadyPdfFile(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	fixture whiteboardPostgresFixture,
	classID uuid.UUID,
	versionID string,
) uuid.UUID {
	t.Helper()
	fileID := uuid.New()
	checksum := pdfChecksum([]byte(versionID))
	if _, err := pool.Exec(ctx, `INSERT INTO tutorhub.content_files
        (id, tenant_id, class_id, creator_user_id, client_request_id, request_fingerprint,
         object_key, display_name, declared_media_type, expected_size_bytes, expected_checksum_sha256,
         status, upload_expires_at, stored_size_bytes, stored_media_type, stored_checksum_sha256,
         storage_etag, storage_version_id, uploaded_at, ready_at, page_count, first_page_aspect)
        VALUES ($1, $2, $3, $4, $5, $6,
                'tenants/' || $2::text || '/files/' || $1::text || '/original', 'worksheet.pdf',
                'application/pdf', 1024, $7, 'ready', now() + interval '1 hour', 1024,
                'application/pdf', $7, 'etag', $8, now(), now(), 4, 0.7071)`,
		fileID, fixture.tenantID, classID, fixture.actorID, uuid.New(), make([]byte, 32), checksum, versionID,
	); err != nil {
		t.Fatalf("seed ready PDF: %v", err)
	}
	return fileID
}

func pdfChecksum(value []byte) []byte {
	digest := sha256.Sum256(value)
	return digest[:]
}

func cleanupPdfPresentationFixture(t *testing.T, pool *pgxpool.Pool, fixture whiteboardPostgresFixture) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	for _, statement := range []string{
		`DELETE FROM tutorhub.pdf_presentation_mutation_receipts WHERE tenant_id = $1`,
		`DELETE FROM tutorhub.pdf_presentation_actor_grants WHERE tenant_id = $1`,
		`DELETE FROM tutorhub.pdf_presentation_checkpoints WHERE tenant_id = $1`,
		`DELETE FROM tutorhub.pdf_presentations WHERE tenant_id = $1`,
		`DELETE FROM tutorhub.content_files WHERE tenant_id = $1`,
		`DELETE FROM tutorhub.tenant_feature_overrides WHERE tenant_id = $1`,
		`DELETE FROM tutorhub.tenant_feature_control_revisions WHERE tenant_id = $1`,
	} {
		if _, err := pool.Exec(ctx, statement, fixture.tenantID); err != nil {
			t.Errorf("cleanup ROOM-TOOLS-FILES-02A fixture: %v", err)
			return
		}
	}
	cleanupWhiteboardPostgresFixture(t, pool, fixture)
}
