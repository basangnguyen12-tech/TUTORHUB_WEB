BEGIN;

-- Room-owned documents cannot be represented once class_id is NOT NULL again.
-- Fail closed instead of silently deleting tenant data; operators must purge
-- media_space files explicitly before rolling back.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM tutorhub.content_files
        WHERE owner_kind = 'media_space' OR class_id IS NULL
    ) THEN
        RAISE EXCEPTION
            'cannot downgrade classroom files while media_space-owned files exist';
    END IF;
END
$$;

DROP INDEX IF EXISTS tutorhub.content_files_verifier_recovery_idx;
DROP INDEX IF EXISTS tutorhub.content_files_media_space_created_idx;

ALTER TABLE tutorhub.content_files
    DROP CONSTRAINT IF EXISTS content_files_media_space_viewer_type_valid,
    DROP CONSTRAINT IF EXISTS content_files_verifier_output_consistent,
    DROP CONSTRAINT IF EXISTS content_files_rejection_reason_valid,
    DROP CONSTRAINT IF EXISTS content_files_first_page_aspect_valid,
    DROP CONSTRAINT IF EXISTS content_files_page_count_valid,
    DROP CONSTRAINT IF EXISTS content_files_expires_after_created,
    DROP CONSTRAINT IF EXISTS content_files_media_space_fk,
    DROP CONSTRAINT IF EXISTS content_files_owner_union_valid,
    DROP CONSTRAINT IF EXISTS content_files_owner_kind_valid;

ALTER TABLE tutorhub.content_files
    DROP COLUMN rejection_reason,
    DROP COLUMN active_content,
    DROP COLUMN first_page_aspect,
    DROP COLUMN page_count,
    DROP COLUMN expires_at,
    DROP COLUMN allow_student_download,
    DROP COLUMN media_space_id,
    DROP COLUMN owner_kind,
    ALTER COLUMN class_id SET NOT NULL;

-- Restore the exact 000027 storage proof constraint.
ALTER TABLE tutorhub.content_files
    DROP CONSTRAINT content_files_storage_proof_consistent;

ALTER TABLE tutorhub.content_files
    ADD CONSTRAINT content_files_storage_proof_consistent CHECK (
        (
            status = 'pending'
            AND stored_size_bytes IS NULL
            AND stored_media_type IS NULL
            AND stored_checksum_sha256 IS NULL
            AND storage_etag IS NULL
            AND storage_version_id IS NULL
            AND uploaded_at IS NULL
        )
        OR (
            status IN ('uploaded', 'processing')
            AND stored_size_bytes = expected_size_bytes
            AND stored_media_type = declared_media_type
            AND stored_checksum_sha256 IS NULL
            AND length(btrim(storage_etag)) BETWEEN 1 AND 512
            AND length(btrim(storage_version_id)) BETWEEN 1 AND 512
            AND uploaded_at IS NOT NULL
            AND uploaded_at >= created_at
            AND uploaded_at <= updated_at
        )
        OR (
            status = 'ready'
            AND stored_size_bytes = expected_size_bytes
            AND stored_media_type = declared_media_type
            AND stored_checksum_sha256 = expected_checksum_sha256
            AND octet_length(stored_checksum_sha256) = 32
            AND length(btrim(storage_etag)) BETWEEN 1 AND 512
            AND length(btrim(storage_version_id)) BETWEEN 1 AND 512
            AND uploaded_at IS NOT NULL
            AND uploaded_at >= created_at
            AND uploaded_at <= updated_at
        )
        OR (
            status = 'rejected'
            AND stored_size_bytes = expected_size_bytes
            AND stored_media_type = declared_media_type
            AND (
                stored_checksum_sha256 IS NULL
                OR octet_length(stored_checksum_sha256) = 32
            )
            AND length(btrim(storage_etag)) BETWEEN 1 AND 512
            AND length(btrim(storage_version_id)) BETWEEN 1 AND 512
            AND uploaded_at IS NOT NULL
            AND uploaded_at >= created_at
            AND uploaded_at <= updated_at
        )
    );

DELETE FROM tutorhub.tenant_feature_overrides
WHERE feature_key = 'classroom_files_tool';

-- Restore the exact 000055 feature allowlist.
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
            'classroom_code_collaboration', 'code_snippet_library'
        )
    );

COMMIT;
