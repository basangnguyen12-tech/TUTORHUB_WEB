//go:build integration

package content

import (
	"context"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tutorhub-v2/core-api/internal/modules/featurecontrol"
	"github.com/tutorhub-v2/core-api/internal/modules/media"
	"github.com/tutorhub-v2/core-api/internal/platform/migrationrunner"
	"github.com/tutorhub-v2/core-api/internal/policy"
)

func newRoom03Fixture(t *testing.T) (*pgxpool.Pool, *pgxpool.Pool, contentIntegrationFixture, roomDocumentFixture) {
	t.Helper()
	ctx := t.Context()
	migrationURL := requireContentEnvironment(t, "DATABASE_MIGRATION_URL")
	runtimeURL := strings.TrimSpace(os.Getenv("DATABASE_CONVERSATION_ACL_TEST_URL"))
	if runtimeURL == "" {
		runtimeURL = requireContentEnvironment(t, "DATABASE_POOL_URL")
	}
	if err := migrationrunner.Up(ctx, migrationURL); err != nil {
		t.Fatalf("migrate room document fixture: %v", err)
	}
	owner := openContentPool(t, ctx, migrationURL)
	t.Cleanup(owner.Close)
	if strings.EqualFold(strings.TrimSpace(os.Getenv("CONVERSATION_ACL_TEST_BOOTSTRAP")), "true") {
		requireContentACLBootstrapDatabase(t, migrationURL)
		provisionContentACLTestRole(t, ctx, owner)
	}
	runtime := openContentPool(t, ctx, runtimeURL)
	t.Cleanup(runtime.Close)
	f := seedContentFixture(t, ctx, owner)
	t.Cleanup(func() { cleanupContentFixture(t, owner, f) })
	r := seedRoomDocumentSpace(t, ctx, owner, f)
	t.Cleanup(func() { cleanupRoomDocumentSpace(t, owner, f, r) })
	if _, err := owner.Exec(ctx, `INSERT INTO tutorhub.tenant_feature_overrides
 (tenant_id, feature_key, enabled, updated_by, created_at, updated_at)
 VALUES ($1, 'classroom_files_tool', true, $2, now(), now())`, f.tenantID, f.ownerID); err != nil {
		t.Fatalf("enable room document fixture: %v", err)
	}
	return owner, runtime, f, r
}

func seedStudyNoteDocuments(t *testing.T, owner *pgxpool.Pool, f contentIntegrationFixture, r roomDocumentFixture, count int) []uuid.UUID {
	t.Helper()
	rows, err := owner.Query(t.Context(), `
INSERT INTO tutorhub.content_files
 (id, tenant_id, owner_kind, media_space_id, creator_user_id, client_request_id, request_fingerprint,
 object_key, display_name, declared_media_type, expected_size_bytes, expected_checksum_sha256,
 status, upload_expires_at, expires_at, stored_size_bytes, stored_media_type, stored_checksum_sha256,
 storage_etag, storage_version_id, uploaded_at, processing_at, ready_at, page_count, first_page_aspect)
SELECT id, $1, 'media_space', $2, $3, gen_random_uuid(), digest, 'tenants/' || $1::uuid || '/files/' || id || '/original',
 'practice.pdf', 'application/pdf', 8, digest, 'ready', now() + interval '1 hour', now() + interval '30 days',
 8, 'application/pdf', digest, 'etag', 'fixture-version', now(), now(), now(), 2, 0.7
FROM (SELECT gen_random_uuid() AS id, decode(repeat('a1',32),'hex') AS digest FROM generate_series(1,$4::integer)) docs
RETURNING id`, f.tenantID, r.spaceID, f.ownerID, count)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	if rows.Err() != nil || len(ids) != count {
		t.Fatalf("seed docs: count=%d err=%v", len(ids), rows.Err())
	}
	return ids
}

type studyNoteTestAuthority struct {
	integrationSpaces
	closed bool
}

func (authority *studyNoteTestAuthority) GetSpace(ctx context.Context, access media.AccessContext, id uuid.UUID) (media.MediaSpace, error) {
	space, err := authority.integrationSpaces.GetSpace(ctx, access, id)
	if authority.closed {
		space.Status = media.SpaceStatusEnded
		space.ActiveRoomInstance = nil
	}
	return space, err
}

func TestPostgresRoomStudyNotePrivacyCASExpiryAndCap(t *testing.T) {
	owner, runtime, f, r := newRoom03Fixture(t)
	ctx := t.Context()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := owner.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	// One identity has distinct memberships in two tenants.
	exec(`INSERT INTO tutorhub.memberships (tenant_id,user_id,role,status,joined_at)
VALUES ($1,$2,'student','active',now())`, f.tenantID, f.foreignOwnerID)
	exec(`INSERT INTO tutorhub.media_participant_sessions
 (id,tenant_id,space_id,room_instance_id,user_id,join_attempt_id,provider_participant_identity,
 instance_role,status,capacity_reserved,admitted_at,joining_at,connected_at,roster_sequence)
 SELECT gen_random_uuid(),tenant_id,space_id,room_instance_id,$2,gen_random_uuid(),'files_student_' || gen_random_uuid(),
 instance_role,status,capacity_reserved,admitted_at,joining_at,connected_at,2
 FROM tutorhub.media_participant_sessions WHERE id = $1`, r.studentSessionID, f.foreignOwnerID)
	controls, err := featurecontrol.NewPostgresRepository(runtime, 10*time.Second, policy.NewEngine(), featurecontrol.NewDefaultCatalog())
	if err != nil {
		t.Fatal(err)
	}
	repo, err := NewPostgresRepository(runtime, 10*time.Second, policy.NewEngine(), controls)
	if err != nil {
		t.Fatal(err)
	}
	svc, err := NewService(repo, &integrationMetadataReader{})
	if err != nil {
		t.Fatal(err)
	}
	authority := &studyNoteTestAuthority{integrationSpaces: integrationSpaces{
		tenantID: f.tenantID, spaceID: r.spaceID, roomID: r.roomID,
		roles: map[uuid.UUID]media.InstanceRole{f.ownerID: media.InstanceRoleHost, f.studentID: media.InstanceRoleAttendee, f.foreignOwnerID: media.InstanceRoleAttendee},
	}}
	svc.UseSpaceAuthority(authority)
	a := integrationContentAccess(f.tenantID, f.studentID, policy.OrganizationRoleStudent)
	b := integrationContentAccess(f.tenantID, f.foreignOwnerID, policy.OrganizationRoleStudent)
	teacher := integrationContentAccess(f.tenantID, f.ownerID, policy.OrganizationRoleTeacher)
	foreign := integrationContentAccess(f.foreignTenantID, f.foreignOwnerID, policy.OrganizationRoleTeacher)
	files := seedStudyNoteDocuments(t, owner, f, r, maxActiveStudyNotes+1)
	fileID := files[0]
	entries := []StudyNoteEntry{{2, "ghi chú"}}
	get := func(access AccessContext) (RoomStudyNote, error) {
		return svc.GetRoomStudyNote(ctx, access, r.spaceID, fileID)
	}
	put := func(access AccessContext, expected int64, input []StudyNoteEntry) (RoomStudyNote, error) {
		return svc.PutRoomStudyNote(ctx, access, r.spaceID, fileID, PutRoomStudyNoteInput{expected, input})
	}
	assertEmpty := func(actor AccessContext) {
		t.Helper()
		n, err := get(actor)
		if err != nil || !reflect.DeepEqual(n, RoomStudyNote{FileID: fileID, Entries: []StudyNoteEntry{}}) {
			t.Fatalf("empty note=%+v err=%v", n, err)
		}
	}
	assertEmpty(a)
	if _, err := put(a, 1, entries); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("initial expected_version must be zero: %v", err)
	}
	if _, err := put(a, 0, []StudyNoteEntry{{3, "outside actual page count"}}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("actual page count not enforced: %v", err)
	}
	note, err := put(a, 0, entries)
	if err != nil || note.Version != 1 || note.ByteLength != len(entries[0].Text) || note.UpdatedAt == nil ||
		note.ExpiresAt == nil || note.ExpiresAt.Sub(*note.UpdatedAt) != 30*24*time.Hour || !reflect.DeepEqual(note.Entries, entries) {
		t.Fatalf("create note=%+v err=%v", note, err)
	}
	assertEmpty(b)
	assertEmpty(teacher)
	if _, err := put(b, 0, []StudyNoteEntry{{1, "note B"}}); err != nil {
		t.Fatalf("independent second student: %v", err)
	}
	other, err := get(a)
	if err != nil || !reflect.DeepEqual(other, note) {
		t.Fatalf("student A's note changed: %+v err=%v", other, err)
	}
	if _, err := get(foreign); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign reader: %v", err)
	}
	if _, err := put(foreign, 0, entries); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign writer: %v", err)
	}
	if _, err := put(a, 0, entries); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("live version mismatch: %v", err)
	}
	expire := func() {
		exec(`UPDATE tutorhub.document_study_notes SET created_at=now()-interval '32 days',
updated_at=now()-interval '31 days', expires_at=now()-interval '1 day'
WHERE tenant_id=$1 AND owner_user_id=$2 AND content_file_id=$3`, f.tenantID, f.studentID, fileID)
	}
	for i, expected := range []int64{0, 2} {
		expire()
		assertEmpty(a)
		if _, err := put(a, 99, entries); !errors.Is(err, ErrVersionConflict) {
			t.Fatalf("expired version mismatch: %v", err)
		}
		n, err := put(a, expected, entries)
		if err != nil || n.Version != int64(i+2) {
			t.Fatalf("revive with %d: version=%d err=%v", expected, n.Version, err)
		}
	}
	// Fill the remaining active slots. An existing nonempty note may still
	// change or be emptied at the cap.
	exec(`INSERT INTO tutorhub.document_study_notes
 (tenant_id,owner_user_id,media_space_id,content_file_id,notes_json,byte_length,expires_at)
 SELECT $1,$2,$3,id,'[{"page":1,"text":"x"}]',1,now()+interval '30 days' FROM unnest($4::uuid[]) AS id`,
		f.tenantID, f.studentID, r.spaceID, files[1:maxActiveStudyNotes])
	if _, err := svc.PutRoomStudyNote(ctx, a, r.spaceID, files[maxActiveStudyNotes], PutRoomStudyNoteInput{0, entries}); !errors.Is(err, ErrStudyNoteLimitExceeded) {
		t.Fatalf("201st document: %v", err)
	}
	note, err = put(a, 3, []StudyNoteEntry{})
	if err != nil || note.Version != 4 || note.ByteLength != 0 || len(note.Entries) != 0 {
		t.Fatalf("clear at cap: %+v err=%v", note, err)
	}
	if _, err := svc.PutRoomStudyNote(ctx, a, r.spaceID, files[maxActiveStudyNotes], PutRoomStudyNoteInput{0, entries}); err != nil {
		t.Fatalf("clearing frees a slot: %v", err)
	}
	if _, err := put(a, 4, entries); !errors.Is(err, ErrStudyNoteLimitExceeded) {
		t.Fatalf("reactivating an empty note bypassed cap: %v", err)
	}
	authority.closed = true
	if _, err := get(a); !errors.Is(err, ErrNotFound) {
		t.Fatalf("closed room student read: %v", err)
	}
	if _, err := put(teacher, 0, entries); err != nil {
		t.Fatalf("staff may keep their own notes in closed rooms: %v", err)
	}
	results := make(chan error, 2)
	start := make(chan struct{})
	for i := 0; i < 2; i++ {
		go func() {
			<-start
			_, err := put(teacher, 1, entries)
			results <- err
		}()
	}
	close(start)
	success, conflict := 0, 0
	for i := 0; i < 2; i++ {
		switch err := <-results; {
		case err == nil:
			success++
		case errors.Is(err, ErrVersionConflict):
			conflict++
		default:
			t.Fatalf("concurrent note CAS: %v", err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("concurrent note CAS: successes=%d conflicts=%d", success, conflict)
	}
	for _, key := range []string{"file_uploads", "classroom_files_tool"} {
		exec(`INSERT INTO tutorhub.tenant_feature_overrides
 (tenant_id, feature_key, enabled, updated_by, created_at, updated_at)
 VALUES ($1,$2,false,$3,now(),now()) ON CONFLICT (tenant_id,feature_key) DO UPDATE SET enabled=false`, f.tenantID, key, f.ownerID)
		if _, err := get(teacher); !errors.Is(err, featurecontrol.ErrFeatureDisabled) {
			t.Fatalf("GET with %s off: %v", key, err)
		}
		if _, err := put(teacher, 1, entries); !errors.Is(err, featurecontrol.ErrFeatureDisabled) {
			t.Fatalf("PUT with %s off: %v", key, err)
		}
		exec(`UPDATE tutorhub.tenant_feature_overrides SET enabled=true WHERE tenant_id=$1 AND feature_key=$2`, f.tenantID, key)
	}
}
