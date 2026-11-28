BEGIN;

-- Refuse to roll back while any sticker message exists: dropping the column
-- would turn those messages into empty text messages.
LOCK TABLE tutorhub.message_embeds IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM tutorhub.message_embeds WHERE kind = 'sticker') THEN
        RAISE EXCEPTION 'cannot roll back 000060_message_embed_stickers: sticker message embeds exist'
            USING ERRCODE = 'restrict_violation';
    END IF;
END
$$;

DELETE FROM tutorhub.tenant_feature_overrides
WHERE feature_key = 'chat_stickers';

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
            'classroom_files_tool', 'classroom_pdf_collaboration'
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
        )
        OR (
            kind = 'instant_class'
            AND media_space_id IS NOT NULL
            AND target_user_id IS NULL
        )
    );

ALTER TABLE tutorhub.message_embeds
    DROP CONSTRAINT message_embeds_sticker_id_valid;

ALTER TABLE tutorhub.message_embeds
    DROP COLUMN sticker_id;

COMMIT;
