BEGIN;

-- MSG-STICKER-01 (ADR-0047): a sticker message names one entry of the
-- platform sticker catalog embedded in the Core API binary. The catalog is
-- reference data, so there is no foreign key: the API validates the ID
-- against the catalog when the message is sent and resolves the asset at
-- read time. The table stays insert-only for the runtime (SELECT, INSERT).
ALTER TABLE tutorhub.message_embeds
    ADD COLUMN sticker_id text;

ALTER TABLE tutorhub.message_embeds
    ADD CONSTRAINT message_embeds_sticker_id_valid CHECK (
        sticker_id IS NULL
        OR (
            char_length(sticker_id) BETWEEN 3 AND 97
            AND sticker_id ~ '^[a-z0-9_]{1,32}:[a-z0-9_-]{1,64}$'
        )
    );

ALTER TABLE tutorhub.message_embeds
    DROP CONSTRAINT message_embeds_kind_valid;

ALTER TABLE tutorhub.message_embeds
    ADD CONSTRAINT message_embeds_kind_valid CHECK (
        (
            kind = 'contact_card'
            AND target_user_id IS NOT NULL
            AND media_space_id IS NULL
            AND sticker_id IS NULL
        )
        OR (
            kind = 'instant_class'
            AND media_space_id IS NOT NULL
            AND target_user_id IS NULL
            AND sticker_id IS NULL
        )
        OR (
            kind = 'sticker'
            AND sticker_id IS NOT NULL
            AND target_user_id IS NULL
            AND media_space_id IS NULL
        )
    );

-- chat_stickers is a tenant-controllable feature (default on in the catalog).
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
            'classroom_files_tool', 'classroom_pdf_collaboration', 'chat_stickers'
        )
    );

-- Runtime grants on tutorhub.message_embeds are unchanged: SELECT, INSERT only.

COMMIT;
