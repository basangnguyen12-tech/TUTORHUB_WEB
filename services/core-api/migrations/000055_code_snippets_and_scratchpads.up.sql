BEGIN;

-- ROOM-TOOLS-CODE-03A (ADR-0043 §4 Slice 3): durable tenant/class-scoped code
-- snippets and per-room scratchpads with explicit student consent for staff
-- review. Deletion is a soft delete and expired scratchpads are overwritten in
-- place, so the Core API runtime role never needs DELETE. Source code, stdin
-- and file names never enter audit, outbox or mutation receipts.
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

ALTER TABLE tutorhub.tenant_quota_overrides
    DROP CONSTRAINT tenant_quota_overrides_key_valid,
    DROP CONSTRAINT tenant_quota_overrides_limit_valid;

ALTER TABLE tutorhub.tenant_quota_overrides
    ADD CONSTRAINT tenant_quota_overrides_key_valid CHECK (
        quota_key IN (
            'members', 'active_classes', 'invite_creations_per_hour',
            'active_availability_polls', 'availability_poll_range_days',
            'availability_poll_slots', 'availability_poll_participants',
            'availability_poll_creations_per_hour',
            'availability_poll_capability_creations_per_hour',
            'active_study_meetings', 'study_meeting_creations_per_hour',
            'messages_per_tenant', 'message_sends_per_hour', 'files_per_tenant',
            'file_bytes_per_tenant', 'single_file_bytes',
            'file_upload_intents_per_hour', 'active_media_spaces',
            'media_participants_per_space', 'active_media_participants',
            'media_space_starts_per_hour', 'whiteboard_documents_per_tenant',
            'whiteboard_connections_per_tenant',
            'whiteboard_storage_bytes_per_tenant',
            'whiteboard_operations_per_minute', 'code_snippets_per_member',
            'code_storage_bytes_per_tenant'
        )
    ),
    ADD CONSTRAINT tenant_quota_overrides_limit_valid CHECK (
        (quota_key = 'members' AND limit_value BETWEEN 1 AND 10000)
        OR (quota_key = 'active_classes' AND limit_value BETWEEN 1 AND 1000)
        OR (quota_key = 'invite_creations_per_hour' AND limit_value BETWEEN 1 AND 10000)
        OR (quota_key = 'active_availability_polls' AND limit_value BETWEEN 1 AND 200)
        OR (quota_key = 'availability_poll_range_days' AND limit_value BETWEEN 1 AND 90)
        OR (quota_key = 'availability_poll_slots' AND limit_value BETWEEN 1 AND 1000)
        OR (quota_key = 'availability_poll_participants' AND limit_value BETWEEN 1 AND 500)
        OR (quota_key = 'availability_poll_creations_per_hour' AND limit_value BETWEEN 1 AND 200)
        OR (quota_key = 'availability_poll_capability_creations_per_hour' AND limit_value BETWEEN 1 AND 1000)
        OR (quota_key = 'active_study_meetings' AND limit_value BETWEEN 1 AND 200)
        OR (quota_key = 'study_meeting_creations_per_hour' AND limit_value BETWEEN 1 AND 200)
        OR (quota_key = 'messages_per_tenant' AND limit_value BETWEEN 1 AND 10000000)
        OR (quota_key = 'message_sends_per_hour' AND limit_value BETWEEN 1 AND 100000)
        OR (quota_key = 'files_per_tenant' AND limit_value BETWEEN 1 AND 1000000)
        OR (quota_key = 'file_bytes_per_tenant' AND limit_value BETWEEN 1 AND 10995116277760)
        OR (quota_key = 'single_file_bytes' AND limit_value BETWEEN 1 AND 5368709120)
        OR (quota_key = 'file_upload_intents_per_hour' AND limit_value BETWEEN 1 AND 100000)
        OR (quota_key = 'active_media_spaces' AND limit_value BETWEEN 1 AND 100)
        OR (quota_key = 'media_participants_per_space' AND limit_value BETWEEN 1 AND 50)
        OR (quota_key = 'active_media_participants' AND limit_value BETWEEN 1 AND 500)
        OR (quota_key = 'media_space_starts_per_hour' AND limit_value BETWEEN 1 AND 200)
        OR (quota_key = 'whiteboard_documents_per_tenant' AND limit_value BETWEEN 1 AND 100)
        OR (quota_key = 'whiteboard_connections_per_tenant' AND limit_value BETWEEN 1 AND 100)
        OR (quota_key = 'whiteboard_storage_bytes_per_tenant' AND limit_value BETWEEN 1 AND 10737418240)
        OR (quota_key = 'whiteboard_operations_per_minute' AND limit_value BETWEEN 1 AND 60000)
        OR (quota_key = 'code_snippets_per_member' AND limit_value BETWEEN 1 AND 1000)
        OR (quota_key = 'code_storage_bytes_per_tenant' AND limit_value BETWEEN 1 AND 524288000)
    );

-- Personal (owner only) or class-shared (class members read; owner, class
-- staff and organization admins edit) code snippets. One file per snippet.
CREATE TABLE tutorhub.code_snippets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    updated_by uuid NOT NULL,
    visibility text NOT NULL,
    class_id uuid,
    title text NOT NULL,
    description text NOT NULL DEFAULT '',
    file_name text NOT NULL,
    language text NOT NULL,
    content text NOT NULL,
    byte_length integer NOT NULL,
    content_sha256 bytea NOT NULL,
    create_idempotency_key text NOT NULL,
    create_request_fingerprint bytea NOT NULL,
    version bigint NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT code_snippets_tenant_id_unique UNIQUE (tenant_id, id),
    CONSTRAINT code_snippets_tenant_fk
        FOREIGN KEY (tenant_id)
        REFERENCES tutorhub.tenants (id)
        ON DELETE CASCADE,
    CONSTRAINT code_snippets_owner_membership_fk
        FOREIGN KEY (tenant_id, owner_user_id)
        REFERENCES tutorhub.memberships (tenant_id, user_id),
    CONSTRAINT code_snippets_updater_membership_fk
        FOREIGN KEY (tenant_id, updated_by)
        REFERENCES tutorhub.memberships (tenant_id, user_id),
    CONSTRAINT code_snippets_class_fk
        FOREIGN KEY (tenant_id, class_id)
        REFERENCES tutorhub.classes (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT code_snippets_visibility_valid CHECK (
        visibility IN ('personal', 'class')
    ),
    CONSTRAINT code_snippets_visibility_scope_consistent CHECK (
        (visibility = 'personal' AND class_id IS NULL)
        OR (visibility = 'class' AND class_id IS NOT NULL)
    ),
    CONSTRAINT code_snippets_title_valid CHECK (
        char_length(btrim(title)) BETWEEN 1 AND 120
    ),
    CONSTRAINT code_snippets_description_valid CHECK (
        char_length(description) <= 280
    ),
    CONSTRAINT code_snippets_file_name_valid CHECK (
        file_name ~ '^[A-Za-z0-9_.-]{1,64}$' AND file_name !~ '^[.]+$'
    ),
    CONSTRAINT code_snippets_language_valid CHECK (
        language IN (
            'python', 'javascript', 'typescript', 'html', 'sql', 'c', 'cpp',
            'java', 'css'
        )
    ),
    CONSTRAINT code_snippets_content_bounded CHECK (
        byte_length BETWEEN 0 AND 65536 AND octet_length(content) = byte_length
    ),
    CONSTRAINT code_snippets_content_sha256_valid CHECK (
        octet_length(content_sha256) = 32
    ),
    CONSTRAINT code_snippets_create_idempotency_valid CHECK (
        length(create_idempotency_key) BETWEEN 16 AND 128
        AND create_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
        AND octet_length(create_request_fingerprint) = 32
    ),
    CONSTRAINT code_snippets_create_idempotency_unique
        UNIQUE (tenant_id, owner_user_id, create_idempotency_key),
    CONSTRAINT code_snippets_version_positive CHECK (version > 0),
    CONSTRAINT code_snippets_updated_after_created CHECK (
        updated_at >= created_at
    ),
    CONSTRAINT code_snippets_deleted_after_created CHECK (
        deleted_at IS NULL OR deleted_at >= created_at
    )
);

CREATE INDEX code_snippets_personal_keyset_idx
    ON tutorhub.code_snippets (
        tenant_id, owner_user_id, updated_at DESC, id DESC
    )
    WHERE deleted_at IS NULL AND visibility = 'personal';

CREATE INDEX code_snippets_class_keyset_idx
    ON tutorhub.code_snippets (
        tenant_id, class_id, updated_at DESC, id DESC
    )
    WHERE deleted_at IS NULL AND visibility = 'class';

-- One durable scratchpad per (tenant, owner, MediaSpace). The files array is
-- canonicalized and bounded by the service (1..8 files, <= 64 KiB each,
-- <= 256 KiB in total); byte_length is the UTF-8 size of every file plus
-- stdin and feeds the code_storage_bytes_per_tenant quota. Staff can read a
-- scratchpad only while the owner keeps shared_with_staff enabled.
CREATE TABLE tutorhub.code_scratchpads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    media_space_id uuid NOT NULL,
    files_json text NOT NULL,
    active_index integer NOT NULL DEFAULT 0,
    stdin_text text NOT NULL DEFAULT '',
    byte_length integer NOT NULL,
    shared_with_staff boolean NOT NULL DEFAULT false,
    shared_at timestamptz,
    version bigint NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    CONSTRAINT code_scratchpads_tenant_id_unique UNIQUE (tenant_id, id),
    CONSTRAINT code_scratchpads_owner_space_unique
        UNIQUE (tenant_id, owner_user_id, media_space_id),
    CONSTRAINT code_scratchpads_tenant_fk
        FOREIGN KEY (tenant_id)
        REFERENCES tutorhub.tenants (id)
        ON DELETE CASCADE,
    CONSTRAINT code_scratchpads_owner_membership_fk
        FOREIGN KEY (tenant_id, owner_user_id)
        REFERENCES tutorhub.memberships (tenant_id, user_id),
    CONSTRAINT code_scratchpads_media_space_fk
        FOREIGN KEY (tenant_id, media_space_id)
        REFERENCES tutorhub.media_spaces (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT code_scratchpads_files_bounded CHECK (
        octet_length(files_json) BETWEEN 2 AND 300000
    ),
    CONSTRAINT code_scratchpads_active_index_valid CHECK (
        active_index BETWEEN 0 AND 7
    ),
    CONSTRAINT code_scratchpads_stdin_bounded CHECK (
        octet_length(stdin_text) <= 16384
    ),
    CONSTRAINT code_scratchpads_byte_length_valid CHECK (
        byte_length BETWEEN 0 AND 278528
    ),
    CONSTRAINT code_scratchpads_share_consistent CHECK (
        (shared_with_staff = false AND shared_at IS NULL)
        OR (shared_with_staff = true AND shared_at IS NOT NULL)
    ),
    CONSTRAINT code_scratchpads_version_positive CHECK (version > 0),
    CONSTRAINT code_scratchpads_updated_after_created CHECK (
        updated_at >= created_at
    ),
    CONSTRAINT code_scratchpads_expiry_valid CHECK (
        expires_at > updated_at
        AND expires_at <= updated_at + interval '31 days'
    )
);

CREATE INDEX code_scratchpads_shared_staff_idx
    ON tutorhub.code_scratchpads (
        tenant_id, media_space_id, shared_at DESC, id DESC
    )
    WHERE shared_with_staff = true;

-- Environment-specific runtime grants are provisioned after the migration by
-- the reviewed acceptance harness; nothing is granted to PUBLIC.
REVOKE ALL ON TABLE tutorhub.code_snippets FROM PUBLIC;
REVOKE ALL ON TABLE tutorhub.code_scratchpads FROM PUBLIC;

COMMIT;
