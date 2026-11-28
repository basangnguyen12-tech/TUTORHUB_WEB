BEGIN;

-- MSG-COMPOSER-TOOLS-01: server-authored structured message embeds.
-- A contact card names a tenant member; an instant-class card names an
-- instant StudyMeeting media space owned by the sender. The Core API validates
-- both when the message is sent and resolves the visible projection for each
-- reader at read time, so a card can never be forged from message text.
-- Rows are insert-only for the runtime: a tombstoned message hides its embed,
-- and the row is removed only with its message.
CREATE TABLE tutorhub.message_embeds (
    tenant_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    message_id uuid NOT NULL,
    kind text NOT NULL,
    target_user_id uuid,
    media_space_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT message_embeds_pkey PRIMARY KEY (tenant_id, message_id),
    CONSTRAINT message_embeds_message_fk
        FOREIGN KEY (tenant_id, conversation_id, message_id)
        REFERENCES tutorhub.messages (tenant_id, conversation_id, id)
        ON DELETE CASCADE,
    CONSTRAINT message_embeds_target_membership_fk
        FOREIGN KEY (tenant_id, target_user_id)
        REFERENCES tutorhub.memberships (tenant_id, user_id),
    CONSTRAINT message_embeds_media_space_fk
        FOREIGN KEY (tenant_id, media_space_id)
        REFERENCES tutorhub.media_spaces (tenant_id, id),
    CONSTRAINT message_embeds_kind_valid CHECK (
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
    )
);

CREATE INDEX message_embeds_conversation_idx
    ON tutorhub.message_embeds (tenant_id, conversation_id, message_id);

CREATE INDEX message_embeds_media_space_idx
    ON tutorhub.message_embeds (tenant_id, media_space_id)
    WHERE media_space_id IS NOT NULL;

-- Environment-specific Core API grants are provisioned separately:
-- SELECT, INSERT only (no UPDATE, DELETE or TRUNCATE).
REVOKE ALL ON tutorhub.message_embeds FROM PUBLIC;

COMMIT;
