package featurecontrol

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFeatureControlMigrationKeepsTypedNormalizedAndHashedStorage(t *testing.T) {
	t.Parallel()

	contents, err := os.ReadFile(filepath.Join(
		"..", "..", "..", "migrations", "000012_tenant_feature_controls.up.sql",
	))
	if err != nil {
		t.Fatalf("read feature control migration: %v", err)
	}
	sql := string(contents)
	for _, required := range []string{
		"tenant_feature_control_revisions",
		"tenant_feature_overrides",
		"tenant_quota_overrides",
		"tenant_quota_windows",
		"rate_limit_windows",
		"octet_length(bucket_hash) = 32",
		"membership_invitations",
		"class_management",
		"class_invite_links",
		"invite_creations_per_hour",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("migration is missing %q", required)
		}
	}
	if strings.Contains(sql, "ip_address") || strings.Contains(sql, "remote_addr") {
		t.Fatal("rate-limit migration must not persist raw client addresses")
	}
}

func TestWhiteboardFeatureQuotaMigrationIsForwardOnlyAndBounded(t *testing.T) {
	t.Parallel()

	migrations := filepath.Join("..", "..", "..", "migrations")
	upContents, err := os.ReadFile(filepath.Join(
		migrations, "000041_whiteboard_feature_quota_controls.up.sql",
	))
	if err != nil {
		t.Fatalf("read whiteboard feature quota migration: %v", err)
	}
	downContents, err := os.ReadFile(filepath.Join(
		migrations, "000041_whiteboard_feature_quota_controls.down.sql",
	))
	if err != nil {
		t.Fatalf("read whiteboard feature quota rollback: %v", err)
	}
	up := string(upContents)
	down := string(downContents)
	for _, required := range []string{
		"classroom_whiteboards",
		"whiteboard_documents_per_tenant",
		"whiteboard_connections_per_tenant",
		"whiteboard_storage_bytes_per_tenant",
		"whiteboard_operations_per_minute",
		"limit_value BETWEEN 1 AND 100",
		"limit_value BETWEEN 1 AND 10737418240",
		"limit_value BETWEEN 1 AND 60000",
	} {
		if !strings.Contains(up, required) {
			t.Fatalf("whiteboard feature quota migration is missing %q", required)
		}
	}
	if strings.Contains(strings.ToUpper(up), "DELETE FROM") {
		t.Fatal("forward whiteboard feature quota migration must not delete data")
	}
	for _, forbidden := range []string{
		"document_content", "provider_credential", "user_id", "access_token",
	} {
		if strings.Contains(strings.ToLower(up), forbidden) {
			t.Fatalf("whiteboard feature quota migration contains forbidden field %q", forbidden)
		}
	}
	for _, required := range []string{
		"DELETE FROM tutorhub.tenant_feature_overrides",
		"DELETE FROM tutorhub.tenant_quota_overrides",
		"classroom_whiteboards",
		"whiteboard_operations_per_minute",
	} {
		if !strings.Contains(down, required) {
			t.Fatalf("whiteboard feature quota rollback is missing %q", required)
		}
	}
}

func TestCodeWorkspaceFeatureMigrationExtendsAndRestoresFeatureAllowlist(t *testing.T) {
	t.Parallel()

	migrations := filepath.Join("..", "..", "..", "migrations")
	upContents, err := os.ReadFile(filepath.Join(migrations, "000054_code_workspace_collaboration.up.sql"))
	if err != nil {
		t.Fatalf("read code workspace feature migration: %v", err)
	}
	downContents, err := os.ReadFile(filepath.Join(migrations, "000054_code_workspace_collaboration.down.sql"))
	if err != nil {
		t.Fatalf("read code workspace feature rollback: %v", err)
	}
	up := string(upContents)
	down := string(downContents)
	for _, key := range []FeatureKey{FeatureClassroomCodeTool, FeatureClassroomCodeCollaboration} {
		if _, ok := NewDefaultCatalog().FeatureDefinition(key); !ok {
			t.Fatalf("catalog is missing %q", key)
		}
		if !strings.Contains(up, "'"+string(key)+"'") {
			t.Fatalf("feature override allowlist is missing %q", key)
		}
	}
	for _, required := range []string{
		"DROP CONSTRAINT tenant_feature_overrides_key_valid",
		"ADD CONSTRAINT tenant_feature_overrides_key_valid CHECK",
		"'classroom_whiteboards'",
	} {
		if !strings.Contains(up, required) || !strings.Contains(down, required) {
			t.Fatalf("code workspace feature migration pair is missing %q", required)
		}
	}
	if strings.Contains(strings.ToUpper(up), "DELETE FROM") {
		t.Fatal("forward code workspace migration must not delete data")
	}
	if !strings.Contains(down, "DELETE FROM tutorhub.tenant_feature_overrides") {
		t.Fatal("rollback must remove overrides for the withdrawn feature keys")
	}
}
