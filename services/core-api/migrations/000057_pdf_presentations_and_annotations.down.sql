BEGIN;

DROP TABLE IF EXISTS tutorhub.pdf_presentation_mutation_receipts;
DROP TABLE IF EXISTS tutorhub.pdf_presentation_actor_grants;
DROP TABLE IF EXISTS tutorhub.pdf_presentation_checkpoints;

ALTER TABLE IF EXISTS tutorhub.pdf_presentations
    DROP CONSTRAINT IF EXISTS pdf_presentations_current_generation_fk;

DROP TABLE IF EXISTS tutorhub.pdf_presentation_generations;
DROP TABLE IF EXISTS tutorhub.pdf_presentations;

DELETE FROM tutorhub.tenant_feature_overrides
WHERE feature_key = 'classroom_pdf_collaboration';

ALTER TABLE tutorhub.tenant_feature_overrides
    DROP CONSTRAINT tenant_feature_overrides_key_valid;

ALTER TABLE tutorhub.tenant_feature_overrides
    ADD CONSTRAINT tenant_feature_overrides_key_valid CHECK (
        feature_key IN (
            'membership_invitations', 'class_management', 'class_invite_links',
            'class_session_scheduling', 'class_session_recurrence',
            'in_app_notifications', 'availability_polls', 'conversations',
            'file_uploads', 'classroom_media_rooms', 'instant_study_rooms',
            'classroom_whiteboards', 'classroom_code_tool',
            'classroom_code_collaboration', 'code_snippet_library',
            'classroom_files_tool'
        )
    );

COMMIT;
