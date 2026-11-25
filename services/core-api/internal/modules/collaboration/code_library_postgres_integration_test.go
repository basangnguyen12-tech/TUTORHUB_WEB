//go:build integration

package collaboration

import (
	"context"
	"errors"
	"os"
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

// ROOM-TOOLS-CODE-03A disposable PostgreSQL gate. It exercises the exact SQL
// of PostgresCodeLibraryRepository (tenant scoping, class roster authority,
// advisory-locked quotas, CAS, soft delete and consent-gated staff reads).
// Run only against a disposable database:
//
//	ROOM_TOOLS_CODE_03A_DISPOSABLE_CONFIRM=I_UNDERSTAND_ROOM_TOOLS_CODE_03A_DISPOSABLE_ONLY \
//	DATABASE_MIGRATION_URL=... go test -count=1 -tags=integration \
//	  -run '^TestPostgresCodeLibraryAuthorityQuotaAndConsent$' ./services/core-api/internal/modules/collaboration
const roomToolsCode03ADisposableConfirmation = "I_UNDERSTAND_ROOM_TOOLS_CODE_03A_DISPOSABLE_ONLY"

func TestPostgresCodeLibraryAuthorityQuotaAndConsent(t *testing.T) {
	if strings.TrimSpace(os.Getenv("ROOM_TOOLS_CODE_03A_DISPOSABLE_CONFIRM")) != roomToolsCode03ADisposableConfirmation {
		t.Skip("ROOM_TOOLS_CODE_03A_DISPOSABLE_CONFIRM is not set to the disposable-only confirmation")
	}
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_MIGRATION_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_MIGRATION_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	if err := migrationrunner.Up(ctx, databaseURL); err != nil {
		t.Fatalf("apply ROOM-TOOLS-CODE-03A migrations: %v", err)
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal("open ROOM-TOOLS-CODE-03A pool")
	}
	t.Cleanup(pool.Close)

	fixture := seedWhiteboardPostgresFixture(t, ctx, pool)
	teacherID := fixture.actorID
	studentID, outsiderID := uuid.New(), uuid.New()
	var spaceID, classID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT id, class_id FROM tutorhub.media_spaces WHERE tenant_id = $1`,
		fixture.tenantID).Scan(&spaceID, &classID); err != nil {
		t.Fatalf("load ROOM-TOOLS-CODE-03A media space: %v", err)
	}
	t.Cleanup(func() { cleanupCodeLibraryFixture(t, pool, fixture, studentID, outsiderID) })
	seedCodeLibraryFixture(t, ctx, pool, fixture.tenantID, teacherID, studentID, outsiderID, classID)

	controls, err := featurecontrol.NewPostgresRepository(pool, 10*time.Second, policy.NewEngine(), featurecontrol.NewDefaultCatalog())
	if err != nil {
		t.Fatal("build ROOM-TOOLS-CODE-03A feature controls")
	}
	repository, err := NewPostgresCodeLibraryRepository(pool, 10*time.Second, controls)
	if err != nil {
		t.Fatal("build ROOM-TOOLS-CODE-03A repository")
	}
	spaces := &codeLibrarySpaces{spaces: map[uuid.UUID]media.MediaSpace{
		teacherID: {ID: spaceID, ViewerRole: media.InstanceRoleHost},
		studentID: {ID: spaceID, ViewerRole: media.InstanceRoleAttendee},
	}}
	service, err := NewCodeLibraryService(repository, spaces)
	if err != nil {
		t.Fatal("build ROOM-TOOLS-CODE-03A service")
	}
	teacher := codeLibraryAccess(fixture.tenantID, teacherID, policy.OrganizationRoleTeacher)
	student := codeLibraryAccess(fixture.tenantID, studentID, policy.OrganizationRoleStudent)
	outsider := codeLibraryAccess(fixture.tenantID, outsiderID, policy.OrganizationRoleStudent)
	foreign := codeLibraryAccess(uuid.New(), teacherID, policy.OrganizationRoleAdmin)

	// Class authority comes from the live roster.
	classInput := codeSnippetInput("rtc03a-class-000001", CodeSnippetClass, classID)
	classInput.Title, classInput.Content = "Lớp 50% off", strings.Repeat("c", 30)
	classSnippet, err := service.CreateSnippet(ctx, teacher, classInput)
	if err != nil || !classSnippet.Created {
		t.Fatalf("teacher class snippet: %+v %v", classSnippet, err)
	}
	if _, err := service.CreateSnippet(ctx, student, codeSnippetInput("rtc03a-class-000002", CodeSnippetClass, classID)); !errors.Is(err, ErrCodeLibraryForbidden) {
		t.Fatalf("student class snippet must be 403, got %v", err)
	}
	if _, err := service.CreateSnippet(ctx, outsider, codeSnippetInput("rtc03a-class-000003", CodeSnippetClass, classID)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outsider class snippet must be 404, got %v", err)
	}
	if _, err := service.ListSnippets(ctx, outsider, CodeSnippetListInput{Scope: CodeSnippetClass, ClassID: classID}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outsider class list must be 404, got %v", err)
	}
	if _, err := service.GetSnippet(ctx, foreign, classSnippet.Snippet.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign tenant read must be 404, got %v", err)
	}

	// code_snippets_per_member = 2 and code_storage_bytes_per_tenant = 64.
	first := codeSnippetInput("rtc03a-personal-0001", CodeSnippetPersonal, uuid.Nil)
	first.Content = strings.Repeat("a", 10)
	firstSnippet, err := service.CreateSnippet(ctx, student, first)
	if err != nil {
		t.Fatalf("first personal snippet: %v", err)
	}
	second := codeSnippetInput("rtc03a-personal-0002", CodeSnippetPersonal, uuid.Nil)
	second.Title, second.Content = "snake_case", strings.Repeat("b", 10)
	if _, err := service.CreateSnippet(ctx, student, second); err != nil {
		t.Fatalf("second personal snippet: %v", err)
	}
	third := codeSnippetInput("rtc03a-personal-0003", CodeSnippetPersonal, uuid.Nil)
	third.Content = strings.Repeat("d", 10)
	if _, err := service.CreateSnippet(ctx, student, third); !errors.Is(err, ErrCodeSnippetQuotaExceeded) {
		t.Fatalf("third personal snippet must exceed the member quota, got %v", err)
	}
	if _, err := service.PutScratchpad(ctx, student, spaceID, CodeScratchpadPutInput{
		Files: []CodeScratchpadFile{{Name: "main.py", Language: "python", Content: strings.Repeat("s", 20)}},
	}); !errors.Is(err, ErrCodeStorageQuotaExceeded) {
		t.Fatalf("30+10+10+20 bytes must exceed the 64-byte storage quota, got %v", err)
	}

	// Literal search and keyset pagination run against the partial indexes.
	for query, want := range map[string]int{"%": 0, "_": 1, "snake": 1, "SNAKE_CASE": 1} {
		list, err := service.ListSnippets(ctx, student, CodeSnippetListInput{Scope: CodeSnippetPersonal, Query: query})
		if err != nil || len(list.Items) != want {
			t.Fatalf("search %q returned %d items (err=%v), want %d", query, len(list.Items), err, want)
		}
	}
	page, err := service.ListSnippets(ctx, student, CodeSnippetListInput{Scope: CodeSnippetPersonal, Limit: 1})
	if err != nil || len(page.Items) != 1 || page.NextCursor == nil {
		t.Fatalf("first keyset page: %+v %v", page, err)
	}
	next, err := service.ListSnippets(ctx, student, CodeSnippetListInput{Scope: CodeSnippetPersonal, Limit: 1, Cursor: *page.NextCursor})
	if err != nil || len(next.Items) != 1 || next.Items[0].ID == page.Items[0].ID || next.NextCursor != nil {
		t.Fatalf("second keyset page: %+v %v", next, err)
	}
	classList, err := service.ListSnippets(ctx, student, CodeSnippetListInput{Scope: CodeSnippetClass, ClassID: classID, Query: "50%"})
	if err != nil || len(classList.Items) != 1 || classList.Items[0].Viewer.CanEdit ||
		classList.Items[0].AuthorDisplayName != "P5-COLLAB-02 actor" {
		t.Fatalf("student class list: %+v %v", classList, err)
	}

	// CAS and soft delete release both quotas.
	renamed := "Renamed"
	if _, err := service.UpdateSnippet(ctx, student, firstSnippet.Snippet.ID, CodeSnippetUpdateInput{ExpectedVersion: 2, Title: &renamed}); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("stale snippet version must conflict, got %v", err)
	}
	if _, err := service.UpdateSnippet(ctx, student, classSnippet.Snippet.ID, CodeSnippetUpdateInput{ExpectedVersion: 1, Title: &renamed}); !errors.Is(err, ErrCodeLibraryForbidden) {
		t.Fatalf("student edit of a class snippet must be 403, got %v", err)
	}
	if err := service.DeleteSnippet(ctx, student, firstSnippet.Snippet.ID); err != nil {
		t.Fatalf("soft delete: %v", err)
	}
	if _, err := service.GetSnippet(ctx, student, firstSnippet.Snippet.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted snippet must be 404, got %v", err)
	}
	if _, err := service.CreateSnippet(ctx, student, third); err != nil {
		t.Fatalf("soft delete must release the member quota: %v", err)
	}
	var deleted int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM tutorhub.code_snippets
        WHERE tenant_id = $1 AND deleted_at IS NOT NULL AND version = 2`, fixture.tenantID).Scan(&deleted); err != nil || deleted != 1 {
		t.Fatalf("soft-deleted rows=%d err=%v", deleted, err)
	}

	// Scratchpad CAS and consent-gated staff reads.
	draft, err := service.PutScratchpad(ctx, student, spaceID, CodeScratchpadPutInput{
		Files: []CodeScratchpadFile{{Name: "main.py", Language: "python", Content: "print(1)"}}, Stdin: "1",
	})
	if err != nil || draft.Version != 1 {
		t.Fatalf("first draft: %+v %v", draft, err)
	}
	if _, err := service.PutScratchpad(ctx, student, spaceID, CodeScratchpadPutInput{
		Files: []CodeScratchpadFile{{Name: "main.py", Language: "python", Content: "print(2)"}},
	}); !errors.Is(err, ErrCodeScratchpadVersionConflict) {
		t.Fatalf("blind overwrite must conflict, got %v", err)
	}
	if _, err := service.GetSharedScratchpad(ctx, teacher, spaceID, draft.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unshared draft must be 404 for staff, got %v", err)
	}
	if _, err := service.ShareScratchpad(ctx, student, spaceID, true); err != nil {
		t.Fatalf("share: %v", err)
	}
	shared, err := service.ListSharedScratchpads(ctx, teacher, spaceID)
	if err != nil || len(shared.Items) != 1 || shared.Items[0].FileCount != 1 ||
		shared.Items[0].ActiveFileName != "main.py" || shared.Items[0].ParticipantKey != nil {
		t.Fatalf("staff shared list: %+v %v", shared, err)
	}
	detail, err := service.GetSharedScratchpad(ctx, teacher, spaceID, draft.ID)
	if err != nil || detail.Stdin != "1" || detail.Files[0].Content != "print(1)" {
		t.Fatalf("staff shared detail: %+v %v", detail, err)
	}
	if _, err := service.ListSharedScratchpads(ctx, student, spaceID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("student staff list must be 404, got %v", err)
	}
	if _, err := service.ShareScratchpad(ctx, student, spaceID, false); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, err := service.GetSharedScratchpad(ctx, teacher, spaceID, draft.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revoked draft must be 404 immediately, got %v", err)
	}

	// Disabling code_snippet_library fails closed for reads and writes.
	if _, err := pool.Exec(ctx, `UPDATE tutorhub.tenant_feature_overrides SET enabled = false
        WHERE tenant_id = $1 AND feature_key = 'code_snippet_library'`, fixture.tenantID); err != nil {
		t.Fatalf("disable code_snippet_library: %v", err)
	}
	if _, err := service.ListSnippets(ctx, student, CodeSnippetListInput{Scope: CodeSnippetPersonal}); !errors.Is(err, ErrFeatureDisabled) {
		t.Fatalf("disabled library list must be feature_disabled, got %v", err)
	}
}

func seedCodeLibraryFixture(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	tenantID, teacherID, studentID, outsiderID, classID uuid.UUID,
) {
	t.Helper()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal("begin ROOM-TOOLS-CODE-03A fixture")
	}
	defer rollback(tx)
	statements := []struct {
		name string
		sql  string
		args []any
	}{
		{"student user", `INSERT INTO tutorhub.users (id, email, display_name) VALUES ($1, $2, 'RTC03A student')`,
			[]any{studentID, "rtc03a-" + strings.ReplaceAll(studentID.String(), "-", "") + "@example.test"}},
		{"outsider user", `INSERT INTO tutorhub.users (id, email, display_name) VALUES ($1, $2, 'RTC03A outsider')`,
			[]any{outsiderID, "rtc03a-" + strings.ReplaceAll(outsiderID.String(), "-", "") + "@example.test"}},
		{"student membership", `INSERT INTO tutorhub.memberships (tenant_id, user_id, role, status, joined_at)
            VALUES ($1, $2, 'student', 'active', now())`, []any{tenantID, studentID}},
		{"outsider membership", `INSERT INTO tutorhub.memberships (tenant_id, user_id, role, status, joined_at)
            VALUES ($1, $2, 'student', 'active', now())`, []any{tenantID, outsiderID}},
		{"student enrollment", `INSERT INTO tutorhub.class_enrollments
            (tenant_id, class_id, user_id, class_role, status, enrolled_by, joined_at)
            VALUES ($1, $2, $3, 'student', 'active', $4, now())`, []any{tenantID, classID, studentID, teacherID}},
		{"control revision", `INSERT INTO tutorhub.tenant_feature_control_revisions (tenant_id, version, updated_by)
            VALUES ($1, 1, $2)
            ON CONFLICT (tenant_id) DO UPDATE SET version = 1, updated_by = EXCLUDED.updated_by, updated_at = now()`,
			[]any{tenantID, teacherID}},
		{"library feature", `INSERT INTO tutorhub.tenant_feature_overrides (tenant_id, feature_key, enabled, updated_by)
            VALUES ($1, 'code_snippet_library', true, $2)`, []any{tenantID, teacherID}},
		{"member quota", `INSERT INTO tutorhub.tenant_quota_overrides (tenant_id, quota_key, limit_value, updated_by)
            VALUES ($1, 'code_snippets_per_member', 2, $2)`, []any{tenantID, teacherID}},
		{"storage quota", `INSERT INTO tutorhub.tenant_quota_overrides (tenant_id, quota_key, limit_value, updated_by)
            VALUES ($1, 'code_storage_bytes_per_tenant', 64, $2)`, []any{tenantID, teacherID}},
	}
	for _, statement := range statements {
		if _, err := tx.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatalf("insert ROOM-TOOLS-CODE-03A %s: %v", statement.name, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit ROOM-TOOLS-CODE-03A fixture: %v", err)
	}
}

func cleanupCodeLibraryFixture(
	t *testing.T,
	pool *pgxpool.Pool,
	fixture whiteboardPostgresFixture,
	userIDs ...uuid.UUID,
) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	for _, statement := range []string{
		`DELETE FROM tutorhub.code_scratchpads WHERE tenant_id = $1`,
		`DELETE FROM tutorhub.code_snippets WHERE tenant_id = $1`,
		`DELETE FROM tutorhub.class_enrollments WHERE tenant_id = $1`,
		`DELETE FROM tutorhub.tenant_quota_overrides WHERE tenant_id = $1`,
		`DELETE FROM tutorhub.tenant_feature_overrides WHERE tenant_id = $1`,
		`DELETE FROM tutorhub.tenant_feature_control_revisions WHERE tenant_id = $1`,
	} {
		if _, err := pool.Exec(ctx, statement, fixture.tenantID); err != nil {
			t.Errorf("cleanup ROOM-TOOLS-CODE-03A fixture: %v", err)
			return
		}
	}
	cleanupWhiteboardPostgresFixture(t, pool, fixture)
	for _, userID := range userIDs {
		if _, err := pool.Exec(ctx, `DELETE FROM tutorhub.users WHERE id = $1`, userID); err != nil {
			t.Errorf("cleanup ROOM-TOOLS-CODE-03A user: %v", err)
		}
	}
}
