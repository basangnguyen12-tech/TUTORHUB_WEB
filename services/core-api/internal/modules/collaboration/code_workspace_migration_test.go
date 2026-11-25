package collaboration

import (
	"regexp"
	"strings"
	"testing"
)

const (
	codeWorkspaceMigrationName     = "000054_code_workspace_collaboration.up.sql"
	codeWorkspaceMigrationDownName = "000054_code_workspace_collaboration.down.sql"
)

func TestCodeWorkspaceMigrationKeepsTenantBoundaryAndBounds(t *testing.T) {
	t.Parallel()

	sql := readWhiteboardMigration(t, codeWorkspaceMigrationName)
	for _, table := range []string{
		"code_workspaces",
		"code_workspace_generations",
		"code_workspace_checkpoints",
		"code_workspace_actor_grants",
		"code_workspace_mutation_receipts",
	} {
		definition := regexp.MustCompile(
			`(?s)CREATE TABLE tutorhub\.` + regexp.QuoteMeta(table) + ` \((.*?)\n\);`,
		).FindStringSubmatch(sql)
		if len(definition) != 2 {
			t.Fatalf("code workspace migration is missing table %q", table)
		}
		if !strings.Contains(definition[1], "tenant_id uuid NOT NULL") {
			t.Fatalf("code workspace table %q is missing tenant_id", table)
		}
		if !strings.Contains(sql, "REVOKE ALL ON TABLE tutorhub."+table+" FROM PUBLIC") {
			t.Fatalf("code workspace table %q does not revoke PUBLIC access", table)
		}
	}
	for _, fragment := range []string{
		"'classroom_code_tool'",
		"'classroom_code_collaboration'",
		"CONSTRAINT code_workspaces_source_unique UNIQUE (tenant_id, media_space_id)",
		"REFERENCES tutorhub.media_spaces (tenant_id, id)",
		"status IN ('created', 'open', 'suspended', 'closed')",
		"UNIQUE (tenant_id, created_by, create_idempotency_key)",
		"FOREIGN KEY (tenant_id, id, current_generation)",
		"DEFERRABLE INITIALLY DEFERRED",
		"authority_kind = 'yjs' AND authority_version = '13.6.27'",
		"provider_kind = 'hocuspocus' AND provider_version = '4.6.0'",
		"provider_document_name ~ '^cw_[A-Za-z0-9_-]{22,125}$'",
		"PRIMARY KEY (tenant_id, workspace_id, generation)",
		"byte_length BETWEEN 1 AND 524288",
		"octet_length(checksum) = 32",
		"writer_fence > 0",
		"ON DELETE CASCADE",
		"PRIMARY KEY (tenant_id, workspace_id, actor_user_id)",
		"expires_at > granted_at",
		"expires_at <= granted_at + interval '30 minutes'",
		"capability = 'edit'",
		"PRIMARY KEY (tenant_id, actor_user_id, idempotency_key)",
		"octet_length(request_fingerprint) = 32",
	} {
		if !strings.Contains(sql, fragment) {
			t.Fatalf("code workspace migration is missing %q", fragment)
		}
	}
	if strings.Contains(sql, "'^wb_") {
		t.Fatal("code workspace provider names must never share the whiteboard namespace")
	}
	if strings.Contains(strings.ToUpper(sql), "GRANT ") {
		t.Fatal("code workspace migration must not hardcode an environment role grant")
	}
	normalized := strings.ToLower(stripSQLLineComments(sql))
	for _, forbidden := range []string{
		"source_code", "file_content", "awareness_payload", "undo_stack",
		"participant_session_id", " json ", " jsonb ", "delete from",
	} {
		if strings.Contains(normalized, forbidden) {
			t.Fatalf("code workspace migration crosses the authority boundary with %q", forbidden)
		}
	}

	down := readWhiteboardMigration(t, codeWorkspaceMigrationDownName)
	for _, required := range []string{
		"DROP TABLE IF EXISTS tutorhub.code_workspace_mutation_receipts",
		"DROP TABLE IF EXISTS tutorhub.code_workspace_actor_grants",
		"DROP TABLE IF EXISTS tutorhub.code_workspace_checkpoints",
		"DROP TABLE IF EXISTS tutorhub.code_workspace_generations",
		"DROP TABLE IF EXISTS tutorhub.code_workspaces",
		"DELETE FROM tutorhub.tenant_feature_overrides",
		"'classroom_whiteboards'",
	} {
		if !strings.Contains(down, required) {
			t.Fatalf("code workspace rollback is missing %q", required)
		}
	}
	restored := regexp.MustCompile(`(?s)ADD CONSTRAINT tenant_feature_overrides_key_valid CHECK \((.*?)\);`).FindStringSubmatch(down)
	if len(restored) != 2 || strings.Contains(restored[1], "classroom_code") {
		t.Fatal("rollback must restore the pre-000054 feature key allowlist")
	}
}
