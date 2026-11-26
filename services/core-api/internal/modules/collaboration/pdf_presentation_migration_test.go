package collaboration

import (
	"regexp"
	"strings"
	"testing"
)

const (
	pdfPresentationMigrationName     = "000057_pdf_presentations_and_annotations.up.sql"
	pdfPresentationMigrationDownName = "000057_pdf_presentations_and_annotations.down.sql"
)

var pdfPresentationTables = []string{
	"pdf_presentations",
	"pdf_presentation_generations",
	"pdf_presentation_checkpoints",
	"pdf_presentation_actor_grants",
	"pdf_presentation_mutation_receipts",
}

func TestPDFPresentationMigrationKeepsTenantBoundaryAndBounds(t *testing.T) {
	t.Parallel()

	sql := readWhiteboardMigration(t, pdfPresentationMigrationName)
	for _, table := range pdfPresentationTables {
		definition := regexp.MustCompile(
			`(?s)CREATE TABLE tutorhub\.` + regexp.QuoteMeta(table) + ` \((.*?)\n\);`,
		).FindStringSubmatch(sql)
		if len(definition) != 2 {
			t.Fatalf("PDF presentation migration is missing table %q", table)
		}
		if !strings.Contains(definition[1], "tenant_id uuid NOT NULL") {
			t.Fatalf("PDF presentation table %q is missing tenant_id", table)
		}
		if !strings.Contains(sql, "REVOKE ALL ON TABLE tutorhub."+table+" FROM PUBLIC") {
			t.Fatalf("PDF presentation table %q does not revoke PUBLIC access", table)
		}
	}
	// Exact constraint text: every fragment is the reviewed contract, not a
	// loose keyword match.
	for _, fragment := range []string{
		"'classroom_files_tool', 'classroom_pdf_collaboration'",
		"CONSTRAINT pdf_presentations_tenant_id_unique UNIQUE (tenant_id, id)",
		"CONSTRAINT pdf_presentations_source_unique\n        UNIQUE (tenant_id, media_space_id, content_file_id, file_version_id)",
		"FOREIGN KEY (tenant_id, media_space_id)\n        REFERENCES tutorhub.media_spaces (tenant_id, id)\n        ON DELETE CASCADE",
		"FOREIGN KEY (tenant_id, content_file_id)\n        REFERENCES tutorhub.content_files (tenant_id, id)\n        ON DELETE CASCADE",
		"REFERENCES tutorhub.memberships (tenant_id, user_id)",
		"length(btrim(file_version_id)) BETWEEN 1 AND 512",
		"page_count BETWEEN 1 AND 300",
		"status IN ('created', 'open', 'suspended', 'closed')",
		"UNIQUE (tenant_id, created_by, create_idempotency_key)",
		"CREATE UNIQUE INDEX pdf_presentations_one_open_per_space_idx\n    ON tutorhub.pdf_presentations (tenant_id, media_space_id)\n    WHERE status = 'open';",
		"FOREIGN KEY (tenant_id, id, current_generation)",
		"DEFERRABLE INITIALLY DEFERRED",
		"authority_kind = 'yjs' AND authority_version = '13.6.27'",
		"provider_kind = 'hocuspocus' AND provider_version = '4.6.0'",
		"provider_document_name ~ '^pd_[A-Za-z0-9_-]{22,125}$'",
		"CONSTRAINT pdf_presentation_generations_provider_name_unique\n        UNIQUE (provider_document_name)",
		"PRIMARY KEY (tenant_id, presentation_id, generation)",
		"byte_length BETWEEN 1 AND 1048576",
		"octet_length(yjs_state) = byte_length",
		"octet_length(checksum) = 32",
		"generation > 0 AND causal_watermark >= 1 AND writer_fence >= 1",
		"PRIMARY KEY (tenant_id, presentation_id, actor_user_id)",
		"expires_at >= granted_at + interval '60 seconds'",
		"expires_at <= granted_at + interval '1800 seconds'",
		"capability = 'edit'",
		"PRIMARY KEY (tenant_id, actor_user_id, idempotency_key)",
		"operation IN ('open', 'switch', 'suspend', 'resume', 'close')",
		"octet_length(request_fingerprint) = 32",
	} {
		if !strings.Contains(sql, fragment) {
			t.Fatalf("PDF presentation migration is missing %q", fragment)
		}
	}
	for _, forbidden := range []string{"'^wb_", "'^cw_"} {
		if strings.Contains(sql, forbidden) {
			t.Fatalf("pd_ provider names must never share another namespace (%s)", forbidden)
		}
	}
	if strings.Contains(strings.ToUpper(sql), "GRANT ") {
		t.Fatal("PDF presentation migration must not hardcode an environment role grant")
	}
	normalized := strings.ToLower(stripSQLLineComments(sql))
	for _, forbidden := range []string{
		"presigned", "object_key", "extracted_text", "display_name", "awareness_payload",
		"undo_stack", "participant_session_id", " json ", " jsonb ", "delete from",
	} {
		if strings.Contains(normalized, forbidden) {
			t.Fatalf("PDF presentation migration crosses the authority boundary with %q", forbidden)
		}
	}

	down := readWhiteboardMigration(t, pdfPresentationMigrationDownName)
	for _, required := range []string{
		"DROP TABLE IF EXISTS tutorhub.pdf_presentation_mutation_receipts",
		"DROP TABLE IF EXISTS tutorhub.pdf_presentation_actor_grants",
		"DROP TABLE IF EXISTS tutorhub.pdf_presentation_checkpoints",
		"DROP CONSTRAINT IF EXISTS pdf_presentations_current_generation_fk",
		"DROP TABLE IF EXISTS tutorhub.pdf_presentation_generations",
		"DROP TABLE IF EXISTS tutorhub.pdf_presentations",
		"DELETE FROM tutorhub.tenant_feature_overrides\nWHERE feature_key = 'classroom_pdf_collaboration'",
	} {
		if !strings.Contains(down, required) {
			t.Fatalf("PDF presentation rollback is missing %q", required)
		}
	}
	restored := regexp.MustCompile(`(?s)ADD CONSTRAINT tenant_feature_overrides_key_valid CHECK \((.*?)\);`).FindStringSubmatch(down)
	previous := regexp.MustCompile(`(?s)ADD CONSTRAINT tenant_feature_overrides_key_valid CHECK \((.*?)\);`).FindStringSubmatch(
		readWhiteboardMigration(t, "000056_classroom_files_and_ready_verifier.up.sql"),
	)
	if len(restored) != 2 || len(previous) != 2 ||
		strings.Join(strings.Fields(restored[1]), " ") != strings.Join(strings.Fields(previous[1]), " ") {
		t.Fatal("rollback must restore the exact 000056 feature key allowlist")
	}
}
