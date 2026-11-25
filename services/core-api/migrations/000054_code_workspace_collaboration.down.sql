BEGIN;

DROP TABLE IF EXISTS tutorhub.code_workspace_mutation_receipts;
DROP TABLE IF EXISTS tutorhub.code_workspace_actor_grants;
DROP TABLE IF EXISTS tutorhub.code_workspace_checkpoints;

ALTER TABLE IF EXISTS tutorhub.code_workspaces
    DROP CONSTRAINT IF EXISTS code_workspaces_current_generation_fk;

DROP TABLE IF EXISTS tutorhub.code_workspace_generations;
DROP TABLE IF EXISTS tutorhub.code_workspaces;

DELETE FROM tutorhub.tenant_feature_overrides
WHERE feature_key IN ('classroom_code_tool', 'classroom_code_collaboration');

ALTER TABLE tutorhub.tenant_feature_overrides
    DROP CONSTRAINT tenant_feature_overrides_key_valid;

ALTER TABLE tutorhub.tenant_feature_overrides
    ADD CONSTRAINT tenant_feature_overrides_key_valid CHECK (
        feature_key IN (
            'membership_invitations', 'class_management', 'class_invite_links',
            'class_session_scheduling', 'class_session_recurrence',
            'in_app_notifications', 'availability_polls', 'conversations',
            'file_uploads', 'classroom_media_rooms', 'instant_study_rooms',
            'classroom_whiteboards'
        )
    );

COMMIT;
