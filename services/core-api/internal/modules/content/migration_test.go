package content

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestContentFileMigrationLocksTenantLifecycleQuotaAndPrivacy(t *testing.T) {
	t.Parallel()
	contents, err := os.ReadFile(filepath.Join(
		"..", "..", "..", "migrations", "000026_content_files.up.sql",
	))
	if err != nil {
		t.Fatalf("read content file migration: %v", err)
	}
	sql := string(contents)
	for _, required := range []string{
		"'file_uploads'", "DROP CONSTRAINT tenant_feature_overrides_key_valid",
		"'files_per_tenant'", "'file_bytes_per_tenant'", "'single_file_bytes'",
		"'file_upload_intents_per_hour'", "CREATE TABLE tutorhub.content_files",
		"CREATE TABLE tutorhub.tenant_file_usage", "FOREIGN KEY (tenant_id, class_id)",
		"FOREIGN KEY (tenant_id, creator_user_id)",
		"UNIQUE (tenant_id, creator_user_id, client_request_id)",
		"UNIQUE (object_key)", "octet_length(request_fingerprint) = 32",
		"display_name !~ '[[:cntrl:]]'",
		"octet_length(expected_checksum_sha256) = 32",
		"status IN ('pending', 'uploaded', 'processing', 'ready', 'rejected')",
		"stored_checksum_sha256 = expected_checksum_sha256",
		"content_files_pending_expiry_idx", "reserved_bytes >= 0",
		"committed_bytes >= 0", "REVOKE ALL ON tutorhub.content_files FROM PUBLIC",
		"REVOKE ALL ON tutorhub.tenant_file_usage FROM PUBLIC",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("content migration is missing %q", required)
		}
	}
	for _, forbidden := range []string{
		"GRANT ", "INSERT INTO tutorhub.audit_events", "INSERT INTO tutorhub.outbox_events",
	} {
		if strings.Contains(sql, forbidden) {
			t.Fatalf("content migration must not contain %q", forbidden)
		}
	}
}

func TestContentFileDownMigrationRestoresPersistentMessageQuotaShape(t *testing.T) {
	t.Parallel()
	contents, err := os.ReadFile(filepath.Join(
		"..", "..", "..", "migrations", "000026_content_files.down.sql",
	))
	if err != nil {
		t.Fatalf("read content file down migration: %v", err)
	}
	sql := string(contents)
	fileDrop := strings.Index(sql, "DROP TABLE tutorhub.content_files")
	usageDrop := strings.Index(sql, "DROP TABLE tutorhub.tenant_file_usage")
	if fileDrop < 0 || usageDrop < 0 || fileDrop > usageDrop {
		t.Fatal("content files must be dropped before tenant file usage")
	}
	for _, required := range []string{
		"WHERE feature_key = 'file_uploads'",
		"WHERE quota_key = 'file_upload_intents_per_hour'",
		"'messages_per_tenant'", "'message_sends_per_hour'",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("content down migration is missing %q", required)
		}
	}
	overrides := sql[strings.Index(sql, "ADD CONSTRAINT tenant_quota_overrides_key_valid"):]
	for _, removed := range []string{
		"'files_per_tenant'", "'file_bytes_per_tenant'", "'single_file_bytes'",
		"'file_upload_intents_per_hour'",
	} {
		if strings.Contains(overrides, removed) {
			t.Fatalf("content down migration must remove %s", removed)
		}
	}
}

func TestVersionBoundFinalizeMigrationDefersSHA256UntilReady(t *testing.T) {
	t.Parallel()
	upContents, err := os.ReadFile(filepath.Join(
		"..", "..", "..", "migrations", "000027_version_bound_file_finalize.up.sql",
	))
	if err != nil {
		t.Fatalf("read version-bound finalize migration: %v", err)
	}
	upSQL := string(upContents)
	for _, required := range []string{
		"DROP CONSTRAINT content_files_storage_proof_consistent",
		"status IN ('uploaded', 'processing')",
		"stored_checksum_sha256 IS NULL",
		"status = 'ready'",
		"stored_checksum_sha256 = expected_checksum_sha256",
		"status = 'rejected'",
	} {
		if !strings.Contains(upSQL, required) {
			t.Fatalf("version-bound finalize migration is missing %q", required)
		}
	}
	for _, forbidden := range []string{"GRANT "} {
		if strings.Contains(upSQL, forbidden) {
			t.Fatalf("version-bound finalize migration must not contain %q", forbidden)
		}
	}
	if !strings.Contains(upSQL, "WHERE status IN ('uploaded', 'processing')") ||
		!strings.Contains(upSQL, "SET stored_checksum_sha256 = NULL") {
		t.Fatal("version-bound finalize migration must remove unverified pre-ready checksum claims")
	}

	downContents, err := os.ReadFile(filepath.Join(
		"..", "..", "..", "migrations", "000027_version_bound_file_finalize.down.sql",
	))
	if err != nil {
		t.Fatalf("read version-bound finalize down migration: %v", err)
	}
	downSQL := string(downContents)
	if !strings.Contains(downSQL, "cannot downgrade version-bound finalize") ||
		!strings.Contains(downSQL, "stored_checksum_sha256 IS NULL") {
		t.Fatal("version-bound finalize down migration must fail closed before restoring SHA-256 invariant")
	}
}

func TestMultipartMigrationOwnsProviderUploadsPartsAndExpiryPrivately(t *testing.T) {
	t.Parallel()
	upContents, err := os.ReadFile(filepath.Join(
		"..", "..", "..", "migrations", "000028_content_file_multipart_uploads.up.sql",
	))
	if err != nil {
		t.Fatalf("read multipart migration: %v", err)
	}
	upSQL := string(upContents)
	for _, required := range []string{
		"CREATE TABLE tutorhub.content_file_multipart_uploads",
		"CREATE TABLE tutorhub.content_file_multipart_parts",
		"provider_upload_id text NOT NULL",
		"FOREIGN KEY (tenant_id, file_id)",
		"FOREIGN KEY (tenant_id, multipart_upload_id)",
		"status IN ('active', 'completing', 'completed', 'aborted', 'expired')",
		"part_number BETWEEN 1 AND 10000",
		"content_length_bytes BETWEEN 1 AND 5368709120",
		"content_file_multipart_uploads_one_active_idx",
		"content_file_multipart_uploads_expiry_idx",
		"REVOKE ALL ON tutorhub.content_file_multipart_uploads FROM PUBLIC",
		"REVOKE ALL ON tutorhub.content_file_multipart_parts FROM PUBLIC",
	} {
		if !strings.Contains(upSQL, required) {
			t.Fatalf("multipart migration is missing %q", required)
		}
	}
	if strings.Contains(upSQL, "GRANT ") {
		t.Fatal("multipart migration must not hardcode an environment runtime role")
	}

	downContents, err := os.ReadFile(filepath.Join(
		"..", "..", "..", "migrations", "000028_content_file_multipart_uploads.down.sql",
	))
	if err != nil {
		t.Fatalf("read multipart down migration: %v", err)
	}
	downSQL := string(downContents)
	partsDrop := strings.Index(downSQL, "DROP TABLE tutorhub.content_file_multipart_parts")
	uploadDrop := strings.Index(downSQL, "DROP TABLE tutorhub.content_file_multipart_uploads")
	if partsDrop < 0 || uploadDrop < 0 || partsDrop > uploadDrop {
		t.Fatal("multipart parts must be dropped before upload ownership")
	}
}

func TestClassroomFilesMigrationAddsOwnerUnionVerifierMetadataAndPrivacy(t *testing.T) {
	t.Parallel()
	upContents, err := os.ReadFile(filepath.Join(
		"..", "..", "..", "migrations", "000056_classroom_files_and_ready_verifier.up.sql",
	))
	if err != nil {
		t.Fatalf("read classroom files migration: %v", err)
	}
	upSQL := string(upContents)
	for _, required := range []string{
		"ADD COLUMN owner_kind text NOT NULL DEFAULT 'class'",
		"ADD COLUMN media_space_id uuid",
		"ALTER COLUMN class_id DROP NOT NULL",
		"owner_kind IN ('class', 'media_space')",
		"(owner_kind = 'class' AND class_id IS NOT NULL AND media_space_id IS NULL)",
		"OR (owner_kind = 'media_space' AND media_space_id IS NOT NULL AND class_id IS NULL)",
		"FOREIGN KEY (tenant_id, media_space_id)",
		"REFERENCES tutorhub.media_spaces (tenant_id, id)",
		"ON DELETE CASCADE",
		"ADD COLUMN allow_student_download boolean NOT NULL DEFAULT true",
		"expires_at IS NULL OR expires_at > created_at",
		"page_count IS NULL OR page_count BETWEEN 1 AND 300",
		"(first_page_aspect >= 0.1 AND first_page_aspect <= 10.0)",
		"ADD COLUMN active_content boolean NOT NULL DEFAULT false",
		"(rejection_reason ~ '^[a-z0-9_]{3,64}$' AND status = 'rejected')",
		"stored_checksum_sha256 = expected_checksum_sha256",
		"AND octet_length(stored_checksum_sha256) = 32",
		"content_files_media_space_created_idx",
		"(tenant_id, media_space_id, created_at DESC, id DESC)",
		"WHERE deleted_at IS NULL AND owner_kind = 'media_space'",
		"content_files_verifier_recovery_idx",
		"(updated_at ASC, id ASC)",
		"WHERE deleted_at IS NULL AND status IN ('uploaded', 'processing')",
		"REVOKE ALL ON tutorhub.content_files FROM PUBLIC",
	} {
		if !strings.Contains(upSQL, required) {
			t.Fatalf("classroom files migration is missing %q", required)
		}
	}
	for _, forbidden := range []string{
		"GRANT ", "DELETE FROM", "INSERT INTO tutorhub.audit_events",
		"INSERT INTO tutorhub.outbox_events", "DROP TABLE",
	} {
		if strings.Contains(upSQL, forbidden) {
			t.Fatalf("classroom files migration must not contain %q", forbidden)
		}
	}
	// The 000027 storage proof must survive verbatim inside the rewritten
	// constraint, so ready still requires a verified 32-byte SHA-256.
	proof027 := storageProofConstraint(t, readMigration(t, "000027_version_bound_file_finalize.up.sql"))
	proof056 := storageProofConstraint(t, upSQL)
	if proof056 != proof027 {
		t.Fatalf("000056 must keep the exact 000027 storage proof:\n got %s\nwant %s", proof056, proof027)
	}
}

func TestClassroomFilesDownMigrationFailsClosedAndRestores000027(t *testing.T) {
	t.Parallel()
	downSQL := readMigration(t, "000056_classroom_files_and_ready_verifier.down.sql")
	guard := strings.Index(downSQL, "cannot downgrade classroom files while media_space-owned files exist")
	notNull := strings.Index(downSQL, "ALTER COLUMN class_id SET NOT NULL")
	if guard < 0 || notNull < 0 || guard > notNull {
		t.Fatal("rollback must fail closed on media_space files before restoring class_id NOT NULL")
	}
	for _, required := range []string{
		"DROP INDEX IF EXISTS tutorhub.content_files_verifier_recovery_idx",
		"DROP INDEX IF EXISTS tutorhub.content_files_media_space_created_idx",
		"DROP CONSTRAINT IF EXISTS content_files_owner_union_valid",
		"DROP CONSTRAINT IF EXISTS content_files_media_space_fk",
		"DROP COLUMN owner_kind", "DROP COLUMN media_space_id",
		"DROP COLUMN allow_student_download", "DROP COLUMN expires_at",
		"DROP COLUMN page_count", "DROP COLUMN first_page_aspect",
		"DROP COLUMN active_content", "DROP COLUMN rejection_reason",
	} {
		if !strings.Contains(downSQL, required) {
			t.Fatalf("classroom files rollback is missing %q", required)
		}
	}
	restored := storageProofConstraint(t, downSQL)
	original := storageProofConstraint(t, readMigration(t, "000027_version_bound_file_finalize.up.sql"))
	if restored != original {
		t.Fatalf("rollback must restore the exact 000027 storage proof:\n got %s\nwant %s", restored, original)
	}
	if strings.Contains(downSQL, "GRANT ") {
		t.Fatal("classroom files rollback must not hardcode an environment runtime role")
	}
}

func readMigration(t *testing.T, name string) string {
	t.Helper()
	contents, err := os.ReadFile(filepath.Join("..", "..", "..", "migrations", name))
	if err != nil {
		t.Fatalf("read migration %s: %v", name, err)
	}
	return string(contents)
}

// storageProofConstraint returns the whitespace-normalized CHECK body of the
// last content_files_storage_proof_consistent definition in a migration.
func storageProofConstraint(t *testing.T, sql string) string {
	t.Helper()
	marker := "ADD CONSTRAINT content_files_storage_proof_consistent CHECK ("
	start := strings.LastIndex(sql, marker)
	if start < 0 {
		t.Fatal("migration is missing content_files_storage_proof_consistent")
	}
	rest := sql[start+len(marker):]
	depth := 1
	for index, character := range rest {
		switch character {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return strings.Join(strings.Fields(rest[:index]), " ")
			}
		}
	}
	t.Fatal("content_files_storage_proof_consistent is not terminated")
	return ""
}
