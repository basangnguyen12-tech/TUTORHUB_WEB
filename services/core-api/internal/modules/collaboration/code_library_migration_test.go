package collaboration

import (
	"regexp"
	"strings"
	"testing"
)

const (
	codeLibraryMigrationName     = "000055_code_snippets_and_scratchpads.up.sql"
	codeLibraryMigrationDownName = "000055_code_snippets_and_scratchpads.down.sql"
)

func TestCodeLibraryMigrationKeepsTenantBoundaryBoundsAndNoDeleteRuntime(t *testing.T) {
	t.Parallel()

	sql := readCodeLibraryMigration(t, codeLibraryMigrationName)
	for _, table := range []string{"code_snippets", "code_scratchpads"} {
		definition := regexp.MustCompile(
			`(?s)CREATE TABLE tutorhub\.` + regexp.QuoteMeta(table) + ` \((.*?)\n\);`,
		).FindStringSubmatch(sql)
		if len(definition) != 2 {
			t.Fatalf("code library migration is missing table %q", table)
		}
		body := definition[1]
		for _, fragment := range []string{
			"tenant_id uuid NOT NULL",
			"id uuid PRIMARY KEY DEFAULT gen_random_uuid()",
			"UNIQUE (tenant_id, id)",
			"FOREIGN KEY (tenant_id)\n        REFERENCES tutorhub.tenants (id)\n        ON DELETE CASCADE",
			"FOREIGN KEY (tenant_id, owner_user_id)\n        REFERENCES tutorhub.memberships (tenant_id, user_id)",
			"version bigint NOT NULL DEFAULT 1",
			"CHECK (version > 0)",
		} {
			if !strings.Contains(body, fragment) {
				t.Fatalf("code library table %q is missing %q", table, fragment)
			}
		}
		if !strings.Contains(sql, "REVOKE ALL ON TABLE tutorhub."+table+" FROM PUBLIC") {
			t.Fatalf("code library table %q does not revoke PUBLIC access", table)
		}
	}
	for _, fragment := range []string{
		"'code_snippet_library'",
		"'code_snippets_per_member'",
		"'code_storage_bytes_per_tenant'",
		"(quota_key = 'code_snippets_per_member' AND limit_value BETWEEN 1 AND 1000)",
		"(quota_key = 'code_storage_bytes_per_tenant' AND limit_value BETWEEN 1 AND 524288000)",
		// code_snippets
		"FOREIGN KEY (tenant_id, updated_by)\n        REFERENCES tutorhub.memberships (tenant_id, user_id)",
		"FOREIGN KEY (tenant_id, class_id)\n        REFERENCES tutorhub.classes (tenant_id, id)\n        ON DELETE CASCADE",
		"visibility IN ('personal', 'class')",
		"(visibility = 'personal' AND class_id IS NULL)\n        OR (visibility = 'class' AND class_id IS NOT NULL)",
		"char_length(btrim(title)) BETWEEN 1 AND 120",
		"char_length(description) <= 280",
		"file_name ~ '^[A-Za-z0-9_.-]{1,64}$' AND file_name !~ '^[.]+$'",
		"'python', 'javascript', 'typescript', 'html', 'sql', 'c', 'cpp',\n            'java', 'css'",
		"byte_length BETWEEN 0 AND 65536 AND octet_length(content) = byte_length",
		"octet_length(content_sha256) = 32",
		"octet_length(create_request_fingerprint) = 32",
		"UNIQUE (tenant_id, owner_user_id, create_idempotency_key)",
		"deleted_at timestamptz,",
		"tenant_id, owner_user_id, updated_at DESC, id DESC\n    )\n    WHERE deleted_at IS NULL AND visibility = 'personal'",
		"tenant_id, class_id, updated_at DESC, id DESC\n    )\n    WHERE deleted_at IS NULL AND visibility = 'class'",
		// code_scratchpads
		"FOREIGN KEY (tenant_id, media_space_id)\n        REFERENCES tutorhub.media_spaces (tenant_id, id)\n        ON DELETE CASCADE",
		"UNIQUE (tenant_id, owner_user_id, media_space_id)",
		"octet_length(files_json) BETWEEN 2 AND 300000",
		"active_index BETWEEN 0 AND 7",
		"octet_length(stdin_text) <= 16384",
		"byte_length BETWEEN 0 AND 278528",
		"(shared_with_staff = false AND shared_at IS NULL)\n        OR (shared_with_staff = true AND shared_at IS NOT NULL)",
		"expires_at > updated_at\n        AND expires_at <= updated_at + interval '31 days'",
		"tenant_id, media_space_id, shared_at DESC, id DESC\n    )\n    WHERE shared_with_staff = true",
	} {
		if !strings.Contains(sql, fragment) {
			t.Fatalf("code library migration is missing %q", fragment)
		}
	}
	upper := strings.ToUpper(stripSQLLineComments(sql))
	if strings.Contains(upper, "GRANT ") {
		t.Fatal("code library migration must not hardcode an environment role grant")
	}
	if strings.Contains(upper, "DELETE FROM") {
		t.Fatal("forward code library migration must not delete data")
	}
	normalized := strings.ToLower(stripSQLLineComments(sql))
	for _, forbidden := range []string{"jsonb", "access_token", "provider_credential", "email"} {
		if strings.Contains(normalized, forbidden) {
			t.Fatalf("code library migration crosses the privacy boundary with %q", forbidden)
		}
	}
	// The scratchpad limits must stay aligned with the service bounds.
	if CodeScratchpadMaxByteLength != 278528 || CodeScratchpadMaxFilesJSONBytes != 300000 ||
		CodeSnippetMaxContentBytes != 65536 || CodeScratchpadMaxFiles != 8 ||
		CodeScratchpadMaxStdinBytes != 16384 {
		t.Fatal("service bounds drifted from the 000055 CHECK constraints")
	}
}

func TestCodeLibraryRollbackRestoresExactPreviousAllowlists(t *testing.T) {
	t.Parallel()

	down := readCodeLibraryMigration(t, codeLibraryMigrationDownName)
	scratchpadDrop := strings.Index(down, "DROP TABLE IF EXISTS tutorhub.code_scratchpads")
	snippetDrop := strings.Index(down, "DROP TABLE IF EXISTS tutorhub.code_snippets")
	if scratchpadDrop < 0 || snippetDrop < 0 || scratchpadDrop > snippetDrop {
		t.Fatal("rollback must drop code_scratchpads then code_snippets")
	}
	for _, required := range []string{
		"DELETE FROM tutorhub.tenant_feature_overrides\nWHERE feature_key = 'code_snippet_library'",
		"DELETE FROM tutorhub.tenant_quota_overrides\nWHERE quota_key IN ('code_snippets_per_member', 'code_storage_bytes_per_tenant')",
	} {
		if !strings.Contains(down, required) {
			t.Fatalf("rollback is missing %q", required)
		}
	}
	if strings.Index(down, "DELETE FROM tutorhub.tenant_feature_overrides") >
		strings.Index(down, "ADD CONSTRAINT tenant_feature_overrides_key_valid") {
		t.Fatal("rollback must delete withdrawn overrides before restoring the constraint")
	}

	featureBlock := regexp.MustCompile(`(?s)ADD CONSTRAINT tenant_feature_overrides_key_valid CHECK \((.*?)\n    \);`)
	quotaKeyBlock := regexp.MustCompile(`(?s)ADD CONSTRAINT tenant_quota_overrides_key_valid CHECK \((.*?)\n    \),`)
	quotaLimitBlock := regexp.MustCompile(`(?s)ADD CONSTRAINT tenant_quota_overrides_limit_valid CHECK \((.*?)\n    \);`)
	previousFeatures := featureBlock.FindStringSubmatch(readCodeLibraryMigration(t, "000054_code_workspace_collaboration.up.sql"))
	restoredFeatures := featureBlock.FindStringSubmatch(down)
	if len(previousFeatures) != 2 || len(restoredFeatures) != 2 ||
		collapseSQLWhitespace(previousFeatures[1]) != collapseSQLWhitespace(restoredFeatures[1]) {
		t.Fatal("rollback must restore the exact 000054 feature allowlist")
	}
	quotaSource := readCodeLibraryMigration(t, "000041_whiteboard_feature_quota_controls.up.sql")
	for name, pattern := range map[string]*regexp.Regexp{"key": quotaKeyBlock, "limit": quotaLimitBlock} {
		previous := pattern.FindStringSubmatch(quotaSource)
		restored := pattern.FindStringSubmatch(down)
		if len(previous) != 2 || len(restored) != 2 ||
			collapseSQLWhitespace(previous[1]) != collapseSQLWhitespace(restored[1]) {
			t.Fatalf("rollback must restore the exact 000041 quota %s constraint", name)
		}
		if strings.Contains(restored[1], "code_") {
			t.Fatalf("restored quota %s constraint still contains code library keys", name)
		}
	}
}

// readCodeLibraryMigration normalizes CRLF checkouts so exact multi-line
// fragments match on every OS.
func readCodeLibraryMigration(t *testing.T, name string) string {
	t.Helper()
	return strings.ReplaceAll(readWhiteboardMigration(t, name), "\r\n", "\n")
}

func collapseSQLWhitespace(value string) string {
	return strings.Join(strings.Fields(value), " ")
}
