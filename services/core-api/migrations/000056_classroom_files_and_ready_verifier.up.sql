BEGIN;

-- ROOM-TOOLS-FILES-01A (ADR-0045 §2 Slice 1A): classroom Files / PDF tool.
-- content_files gains an owner union (class | media_space) so standalone
-- study_meeting rooms get a private room document library, plus bounded
-- P3-10-PDF/Image verifier metadata. Room documents are soft-deleted via
-- deleted_at, so the Core API runtime role never needs DELETE. Object keys
-- stay tenants/{tenant_id}/files/{file_id}/original; discovery keeps joining
-- authorized classes, so class_id IS NULL rows never leak into search.
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

ALTER TABLE tutorhub.content_files
    ADD COLUMN owner_kind text NOT NULL DEFAULT 'class',
    ADD COLUMN media_space_id uuid,
    ADD COLUMN allow_student_download boolean NOT NULL DEFAULT true,
    ADD COLUMN expires_at timestamptz,
    ADD COLUMN page_count integer,
    ADD COLUMN first_page_aspect double precision,
    ADD COLUMN active_content boolean NOT NULL DEFAULT false,
    ADD COLUMN rejection_reason text,
    ALTER COLUMN class_id DROP NOT NULL;

ALTER TABLE tutorhub.content_files
    ADD CONSTRAINT content_files_owner_kind_valid CHECK (
        owner_kind IN ('class', 'media_space')
    ),
    ADD CONSTRAINT content_files_owner_union_valid CHECK (
        (owner_kind = 'class' AND class_id IS NOT NULL AND media_space_id IS NULL)
        OR (owner_kind = 'media_space' AND media_space_id IS NOT NULL AND class_id IS NULL)
    ),
    ADD CONSTRAINT content_files_media_space_fk
        FOREIGN KEY (tenant_id, media_space_id)
        REFERENCES tutorhub.media_spaces (tenant_id, id)
        ON DELETE CASCADE,
    ADD CONSTRAINT content_files_expires_after_created CHECK (
        expires_at IS NULL OR expires_at > created_at
    ),
    ADD CONSTRAINT content_files_page_count_valid CHECK (
        page_count IS NULL OR page_count BETWEEN 1 AND 300
    ),
    ADD CONSTRAINT content_files_first_page_aspect_valid CHECK (
        first_page_aspect IS NULL
        OR (first_page_aspect >= 0.1 AND first_page_aspect <= 10.0)
    ),
    ADD CONSTRAINT content_files_rejection_reason_valid CHECK (
        rejection_reason IS NULL
        OR (rejection_reason ~ '^[a-z0-9_]{3,64}$' AND status = 'rejected')
    );

-- Keep the exact 000027 lifecycle proof and add the verifier contract:
-- non-ready rows never claim verifier output (only rejected rows carry the
-- bounded rejection reason). The verifier always writes page metadata when it
-- marks a viewer file ready; the room view capability fails closed without it.
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
    ),
    ADD CONSTRAINT content_files_verifier_output_consistent CHECK (
        status = 'ready'
        OR (
            page_count IS NULL
            AND first_page_aspect IS NULL
            AND active_content = false
        )
    ),
    ADD CONSTRAINT content_files_media_space_viewer_type_valid CHECK (
        owner_kind <> 'media_space'
        OR (
            expires_at IS NOT NULL
            AND (
                (declared_media_type = 'application/pdf' AND expected_size_bytes <= 52428800)
                OR (
                    declared_media_type IN ('image/png', 'image/jpeg', 'image/webp')
                    AND expected_size_bytes <= 10485760
                )
            )
        )
    );

CREATE INDEX content_files_media_space_created_idx
    ON tutorhub.content_files (tenant_id, media_space_id, created_at DESC, id DESC)
    WHERE deleted_at IS NULL AND owner_kind = 'media_space';

CREATE INDEX content_files_verifier_recovery_idx
    ON tutorhub.content_files (updated_at ASC, id ASC)
    WHERE deleted_at IS NULL AND status IN ('uploaded', 'processing');

-- Environment-specific Core API column grants are provisioned separately
-- (docs/DATABASE.md "ROOM-TOOLS-FILES-01A"); PUBLIC stays denied.
REVOKE ALL ON tutorhub.content_files FROM PUBLIC;

COMMIT;
