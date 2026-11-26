//go:build integration

package content

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tutorhub-v2/core-api/internal/modules/featurecontrol"
	"github.com/tutorhub-v2/core-api/internal/modules/media"
	"github.com/tutorhub-v2/core-api/internal/platform/migrationrunner"
	"github.com/tutorhub-v2/core-api/internal/platform/objectstorage"
	"github.com/tutorhub-v2/core-api/internal/policy"
)

// ROOM-TOOLS-FILES-01A: end-to-end PostgreSQL proof for a study_meeting room
// (class_id IS NULL): feature gate, room-scoped intent, one-call verifier,
// admitted-student view without raw download, cross-tenant/left concealment,
// download toggle and soft delete with usage release.
func TestPostgresRoomDocumentsVerifierAuthorizationAndSoftDelete(t *testing.T) {
	migrationURL := requireContentEnvironment(t, "DATABASE_MIGRATION_URL")
	poolURL := requireContentEnvironment(t, "DATABASE_POOL_URL")
	runtimeURL := strings.TrimSpace(os.Getenv("DATABASE_CONVERSATION_ACL_TEST_URL"))
	if runtimeURL == "" {
		runtimeURL = poolURL
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	if err := migrationrunner.Up(ctx, migrationURL); err != nil {
		t.Fatalf("apply content migrations: %v", err)
	}
	migrationPool := openContentPool(t, ctx, migrationURL)
	t.Cleanup(migrationPool.Close)
	if strings.EqualFold(strings.TrimSpace(os.Getenv("CONVERSATION_ACL_TEST_BOOTSTRAP")), "true") {
		provisionContentACLTestRole(t, ctx, migrationPool)
	}
	runtimePool := openContentPool(t, ctx, runtimeURL)
	t.Cleanup(runtimePool.Close)
	fixture := seedContentFixture(t, ctx, migrationPool)
	room := seedRoomDocumentSpace(t, ctx, migrationPool, fixture)
	t.Cleanup(func() {
		cleanupRoomDocumentSpace(t, migrationPool, fixture, room)
		cleanupContentFixture(t, migrationPool, fixture)
	})

	controls, err := featurecontrol.NewPostgresRepository(
		runtimePool, 10*time.Second, policy.NewEngine(), featurecontrol.NewDefaultCatalog(),
	)
	if err != nil {
		t.Fatalf("create room document controls: %v", err)
	}
	repository, err := NewPostgresRepository(runtimePool, 10*time.Second, policy.NewEngine(), controls)
	if err != nil {
		t.Fatalf("create room document repository: %v", err)
	}
	pdf := buildPDF(pdfFixtureOptions{pages: 2, catalogExtra: "/OpenAction 50 0 R",
		extraObjects: []string{"50 0 obj\n<< /S /JavaScript /JS (app.alert\\(1\\)) >>\nendobj"}})
	digest := sha256.Sum256(pdf)
	storage := &integrationVersionStorage{
		integrationMetadataReader: &integrationMetadataReader{metadata: objectstorage.Metadata{
			ContentLength: int64(len(pdf)), ContentType: MediaTypePDF, ETag: "etag-room", VersionID: "version-room",
		}},
		objects: map[string][]byte{"version-room": pdf},
	}
	service, err := NewService(repository, storage)
	if err != nil {
		t.Fatalf("create room document service: %v", err)
	}
	service.UseSpaceAuthority(&integrationSpaces{
		tenantID: fixture.tenantID, spaceID: room.spaceID, roomID: room.roomID,
		roles: map[uuid.UUID]media.InstanceRole{
			fixture.ownerID: media.InstanceRoleHost, fixture.studentID: media.InstanceRoleAttendee,
		},
	})
	host := integrationContentAccess(fixture.tenantID, fixture.ownerID, policy.OrganizationRoleTeacher)
	student := integrationContentAccess(fixture.tenantID, fixture.studentID, policy.OrganizationRoleStudent)
	foreign := integrationContentAccess(fixture.foreignTenantID, fixture.foreignOwnerID, policy.OrganizationRoleTeacher)

	if _, err := service.ListRoomDocuments(ctx, host, room.spaceID, ListFilesInput{}); !errors.Is(err, featurecontrol.ErrFeatureDisabled) {
		t.Fatalf("classroom_files_tool must default off: %v", err)
	}
	if _, err := migrationPool.Exec(ctx, `
INSERT INTO tutorhub.tenant_feature_overrides (
    tenant_id, feature_key, enabled, updated_by, created_at, updated_at
)
VALUES ($1, 'classroom_files_tool', true, $2, now(), now())`, fixture.tenantID, fixture.ownerID); err != nil {
		t.Fatalf("enable classroom files tool: %v", err)
	}

	intent := RoomDocumentIntentInput{
		DisplayName: "worksheet.pdf", DeclaredMediaType: MediaTypePDF,
		ExpectedSizeBytes: int64(len(pdf)), ChecksumSHA256: hex.EncodeToString(digest[:]),
		ClientRequestID: uuid.New(),
	}
	if _, err := service.CreateRoomDocumentIntent(ctx, student, room.spaceID, intent); !errors.Is(err, ErrNotFound) {
		t.Fatalf("attendees must not upload room documents: %v", err)
	}
	created, err := service.CreateRoomDocumentIntent(ctx, host, room.spaceID, intent)
	if err != nil {
		t.Fatalf("create room document intent: %v", err)
	}
	if !created.Created || created.File.OwnerKind != OwnerKindMediaSpace || created.File.ClassID != nil ||
		created.File.MediaSpaceID == nil || *created.File.MediaSpaceID != room.spaceID ||
		created.File.AllowStudentDownload || created.File.ExpiresAt == nil {
		t.Fatalf("unexpected room intent: %+v", created.File)
	}
	if _, err := service.CreateRoomDocumentIntent(ctx, host, room.spaceID, intent); err != nil {
		t.Fatalf("idempotent room intent replay: %v", err)
	}

	finalized, err := service.Finalize(ctx, host, created.File.ID, FinalizeInput{
		ExpectedVersion: created.File.Version, StorageVersionID: "version-room",
	})
	if err != nil {
		t.Fatalf("finalize room document: %v", err)
	}
	if finalized.Status != StatusReady || finalized.PageCount == nil || *finalized.PageCount != 2 ||
		!finalized.ActiveContent || storage.getVersion != "version-room" {
		t.Fatalf("finalize must verify in one call: %+v (read %q)", finalized, storage.getVersion)
	}
	var stored []byte
	if err := migrationPool.QueryRow(ctx, `SELECT stored_checksum_sha256 FROM tutorhub.content_files
WHERE tenant_id = $1 AND id = $2`, fixture.tenantID, created.File.ID).Scan(&stored); err != nil ||
		!bytes.Equal(stored, digest[:]) {
		t.Fatalf("ready must persist the verified digest: %x err=%v", stored, err)
	}
	replayed, err := service.Finalize(ctx, host, created.File.ID, FinalizeInput{
		ExpectedVersion: created.File.Version, StorageVersionID: "version-room",
	})
	if err != nil || replayed.Status != StatusReady {
		t.Fatalf("finalize replay after verification: %+v err=%v", replayed, err)
	}

	page, err := service.ListRoomDocuments(ctx, student, room.spaceID, ListFilesInput{})
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("admitted student list: %+v err=%v", page, err)
	}
	if access := page.Items[0].ViewerAccess; !access.CanView || access.CanDownloadOriginal || access.CanManage ||
		page.ViewerAccess.CanUpload {
		t.Fatalf("student room access = %+v / %+v", access, page.ViewerAccess)
	}
	if _, err := service.IssueRoomDocumentViewCapability(ctx, student, room.spaceID, created.File.ID); err != nil {
		t.Fatalf("students must view even when downloads are disabled: %v", err)
	}
	if storage.downloadVersionID != "version-room" {
		t.Fatalf("view capability must sign the verified version, got %q", storage.downloadVersionID)
	}
	if _, err := service.IssueDownloadCapability(ctx, student, created.File.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("raw download must stay concealed from students: %v", err)
	}
	if _, err := service.IssueDownloadCapability(ctx, host, created.File.ID); err != nil {
		t.Fatalf("hosts may download the original: %v", err)
	}
	for name, err := range map[string]error{
		"foreign list": func() error {
			_, err := service.ListRoomDocuments(ctx, foreign, room.spaceID, ListFilesInput{})
			return err
		}(),
		"foreign view": func() error {
			_, err := service.IssueRoomDocumentViewCapability(ctx, foreign, room.spaceID, created.File.ID)
			return err
		}(),
		"foreign metadata": func() error {
			_, err := service.Get(ctx, foreign, created.File.ID)
			return err
		}(),
	} {
		if !errors.Is(err, ErrNotFound) {
			t.Fatalf("%s must be concealed: %v", name, err)
		}
	}

	toggled, err := service.UpdateRoomDocument(ctx, host, room.spaceID, created.File.ID, UpdateRoomDocumentInput{
		ExpectedVersion: finalized.Version, AllowStudentDownload: boolPointer(true),
	})
	if err != nil || !toggled.Document.AllowStudentDownload {
		t.Fatalf("toggle student download: %+v err=%v", toggled, err)
	}
	if _, err := service.UpdateRoomDocument(ctx, host, room.spaceID, created.File.ID, UpdateRoomDocumentInput{
		ExpectedVersion: finalized.Version, AllowStudentDownload: boolPointer(false),
	}); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("stale PATCH must conflict: %v", err)
	}
	if _, err := service.IssueDownloadCapability(ctx, student, created.File.ID); err != nil {
		t.Fatalf("allowed student download: %v", err)
	}

	if _, err := migrationPool.Exec(ctx, `
UPDATE tutorhub.media_participant_sessions
SET status = 'left', capacity_reserved = false, terminal_at = now(),
    updated_at = now(), version = version + 1
WHERE tenant_id = $1 AND id = $2`, fixture.tenantID, room.studentSessionID); err != nil {
		t.Fatalf("leave room: %v", err)
	}
	if _, err := service.ListRoomDocuments(ctx, student, room.spaceID, ListFilesInput{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("students who left must be concealed: %v", err)
	}
	if _, err := service.IssueRoomDocumentViewCapability(ctx, student, room.spaceID, created.File.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("students who left must not view: %v", err)
	}

	html := []byte("<!DOCTYPE html><html><script>alert(1)</script>%PDF-1.4\n%%EOF\n")
	htmlDigest := sha256.Sum256(html)
	storage.metadata = objectstorage.Metadata{
		ContentLength: int64(len(html)), ContentType: MediaTypePDF, ETag: "etag-html", VersionID: "version-html",
	}
	storage.objects["version-html"] = html
	disguised, err := service.CreateRoomDocumentIntent(ctx, host, room.spaceID, RoomDocumentIntentInput{
		DisplayName: "fake.pdf", DeclaredMediaType: MediaTypePDF, ExpectedSizeBytes: int64(len(html)),
		ChecksumSHA256: hex.EncodeToString(htmlDigest[:]), ClientRequestID: uuid.New(),
	})
	if err != nil {
		t.Fatalf("create disguised intent: %v", err)
	}
	rejectedFile, err := service.Finalize(ctx, host, disguised.File.ID, FinalizeInput{
		ExpectedVersion: disguised.File.Version, StorageVersionID: "version-html",
	})
	if err != nil || rejectedFile.Status != StatusRejected || rejectedFile.RejectionReason == nil ||
		*rejectedFile.RejectionReason != string(RejectMediaTypeMismatch) {
		t.Fatalf("disguised HTML must be rejected: %+v err=%v", rejectedFile, err)
	}

	storage.deleteVersion = func(ctx context.Context, key, version string) error {
		var committed bool
		if err := migrationPool.QueryRow(ctx, `SELECT deleted_at IS NOT NULL
FROM tutorhub.content_files WHERE tenant_id = $1 AND object_key = $2 AND storage_version_id = $3`,
			fixture.tenantID, key, version).Scan(&committed); err != nil || !committed {
			t.Fatalf("storage deletion must follow the exact version's database commit: %v", err)
		}
		return errors.New("test provider is unavailable")
	}
	for _, fileID := range []uuid.UUID{toggled.Document.ID, rejectedFile.ID} {
		current, err := service.Get(ctx, host, fileID)
		if err != nil {
			t.Fatalf("reload before delete: %v", err)
		}
		deleted, err := service.UpdateRoomDocument(ctx, host, room.spaceID, fileID, UpdateRoomDocumentInput{
			ExpectedVersion: current.Version, Deleted: true,
		})
		if err != nil || !deleted.Deleted {
			t.Fatalf("soft delete room document: %+v err=%v", deleted, err)
		}
	}
	if storage.deleteCalls != 2 {
		t.Fatalf("expected two best-effort version deletes, got %d", storage.deleteCalls)
	}
	var fileCount, reserved, committed int64
	if err := migrationPool.QueryRow(ctx, `SELECT file_count, reserved_bytes, committed_bytes
FROM tutorhub.tenant_file_usage WHERE tenant_id = $1`, fixture.tenantID).Scan(
		&fileCount, &reserved, &committed,
	); err != nil {
		t.Fatalf("read file usage: %v", err)
	}
	if fileCount != 0 || reserved != 0 || committed != 0 {
		t.Fatalf("soft delete must release usage: count=%d reserved=%d committed=%d", fileCount, reserved, committed)
	}
	var reason string
	if err := migrationPool.QueryRow(ctx, `SELECT deletion_reason FROM tutorhub.content_files
WHERE tenant_id = $1 AND id = $2`, fixture.tenantID, created.File.ID).Scan(&reason); err != nil ||
		reason != "room_staff_deleted" {
		t.Fatalf("deletion reason=%q err=%v", reason, err)
	}
	if _, err := service.Get(ctx, host, created.File.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted documents must be concealed: %v", err)
	}
}

func boolPointer(value bool) *bool { return &value }

type roomDocumentFixture struct {
	meetingID        uuid.UUID
	spaceID          uuid.UUID
	roomID           uuid.UUID
	studentSessionID uuid.UUID
}

func seedRoomDocumentSpace(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	fixture contentIntegrationFixture,
) roomDocumentFixture {
	t.Helper()
	room := roomDocumentFixture{
		meetingID: uuid.New(), spaceID: uuid.New(), roomID: uuid.New(), studentSessionID: uuid.New(),
	}
	transaction, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin room document fixture: %v", err)
	}
	defer func() { _ = transaction.Rollback(context.Background()) }()
	compact := func() string { return strings.ReplaceAll(uuid.NewString(), "-", "") }
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO tutorhub.study_meetings (
    id, tenant_id, owner_user_id, title, starts_at, ends_at, timezone,
    status, create_idempotency_key, create_request_fingerprint
)
VALUES ($1, $2, $3, 'FILES-01A room', now(), now() + interval '1 hour',
    'Asia/Ho_Chi_Minh', 'scheduled', $4, decode(repeat('41', 32), 'hex'))`,
			[]any{room.meetingID, fixture.tenantID, fixture.ownerID, "files-study-" + uuid.NewString()}},
		{`INSERT INTO tutorhub.media_spaces (
    id, tenant_id, source_kind, source_study_meeting_id, status, version,
    lobby_enabled, locked, create_idempotency_key, create_request_fingerprint,
    created_by, updated_by, opened_at, opened_by
)
VALUES ($1, $2, 'study_meeting', $3, 'open', 2, true, false, $4,
    decode(repeat('42', 32), 'hex'), $5, $5, now(), $5)`,
			[]any{room.spaceID, fixture.tenantID, room.meetingID, "files-space-" + uuid.NewString(), fixture.ownerID}},
		{`INSERT INTO tutorhub.media_room_instances (
    id, tenant_id, space_id, attempt_number, status, version, provider_kind,
    provider_room_name, provider_room_sid, created_by, updated_by, activated_at
)
VALUES ($1, $2, $3, 1, 'active', 2, 'livekit', $4, $5, $6, $6, now())`,
			[]any{room.roomID, fixture.tenantID, room.spaceID, "files_room_" + compact(), "RM_" + compact(), fixture.ownerID}},
		{`INSERT INTO tutorhub.media_participant_sessions (
    id, tenant_id, space_id, room_instance_id, user_id, join_attempt_id,
    provider_participant_identity, instance_role, status, capacity_reserved,
    admitted_at, joining_at, connected_at, roster_sequence
)
VALUES ($1, $2, $3, $4, $5, $6, $7, 'attendee', 'connected', true,
    now() - interval '2 seconds', now() - interval '1 second', now(), 1)`,
			[]any{room.studentSessionID, fixture.tenantID, room.spaceID, room.roomID, fixture.studentID,
				uuid.New(), "files_student_" + compact()}},
	} {
		if _, err := transaction.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatalf("seed room document fixture: %v", err)
		}
	}
	if err := transaction.Commit(ctx); err != nil {
		t.Fatalf("commit room document fixture: %v", err)
	}
	return room
}

func cleanupRoomDocumentSpace(
	t *testing.T,
	pool *pgxpool.Pool,
	fixture contentIntegrationFixture,
	room roomDocumentFixture,
) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	for _, statement := range []string{
		`DELETE FROM tutorhub.content_files WHERE tenant_id = $1`,
		`DELETE FROM tutorhub.media_participant_sessions WHERE tenant_id = $1`,
		`DELETE FROM tutorhub.media_room_instances WHERE tenant_id = $1`,
		`DELETE FROM tutorhub.media_spaces WHERE tenant_id = $1`,
		`DELETE FROM tutorhub.study_meetings WHERE tenant_id = $1`,
		`DELETE FROM tutorhub.tenant_feature_overrides WHERE tenant_id = $1`,
	} {
		if _, err := pool.Exec(ctx, statement, fixture.tenantID); err != nil {
			t.Errorf("cleanup room document fixture: %v", err)
		}
	}
	_ = room
}

type integrationSpaces struct {
	tenantID uuid.UUID
	spaceID  uuid.UUID
	roomID   uuid.UUID
	roles    map[uuid.UUID]media.InstanceRole
}

func (spaces *integrationSpaces) GetSpace(
	_ context.Context,
	access media.AccessContext,
	spaceID uuid.UUID,
) (media.MediaSpace, error) {
	role, ok := spaces.roles[access.ActorID]
	if access.TenantID != spaces.tenantID || spaceID != spaces.spaceID || !ok {
		return media.MediaSpace{}, media.ErrSpaceNotFound
	}
	return media.MediaSpace{
		ID: spaces.spaceID, Status: media.SpaceStatusOpen, ViewerRole: role,
		Source:             media.SourceReference{Kind: media.SourceStudyMeeting},
		ActiveRoomInstance: &media.RoomInstance{ID: spaces.roomID, Status: media.RoomInstanceActive},
	}, nil
}

type integrationVersionStorage struct {
	*integrationMetadataReader
	objects       map[string][]byte
	getVersion    string
	deleteCalls   int
	deleteVersion func(context.Context, string, string) error
}

func (storage *integrationVersionStorage) DeleteVersion(ctx context.Context, key, version string) error {
	storage.deleteCalls++
	if storage.deleteVersion != nil {
		return storage.deleteVersion(ctx, key, version)
	}
	return nil
}

func (storage *integrationVersionStorage) GetVersion(
	_ context.Context,
	_ string,
	versionID string,
) (objectstorage.Object, error) {
	storage.getVersion = versionID
	body, ok := storage.objects[versionID]
	if !ok {
		return objectstorage.Object{}, errors.New("missing object version")
	}
	return objectstorage.Object{
		Body: io.NopCloser(bytes.NewReader(body)), ContentLength: int64(len(body)), VersionID: versionID,
	}, nil
}
