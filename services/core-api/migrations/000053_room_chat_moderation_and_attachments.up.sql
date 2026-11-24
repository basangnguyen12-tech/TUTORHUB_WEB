BEGIN;

-- ROOM-CHAT-01 / ADR-0042: host posting moderation for the canonical room
-- conversation. A child table keeps the exact column-level UPDATE contract on
-- tutorhub.conversations unchanged.
CREATE TABLE tutorhub.room_conversation_settings (
    tenant_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    participant_chat_enabled boolean NOT NULL DEFAULT true,
    updated_by_user_id uuid NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, conversation_id),
    CONSTRAINT room_conversation_settings_conversation_fk
        FOREIGN KEY (tenant_id, conversation_id)
        REFERENCES tutorhub.conversations (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT room_conversation_settings_updater_membership_fk
        FOREIGN KEY (tenant_id, updated_by_user_id)
        REFERENCES tutorhub.memberships (tenant_id, user_id)
);

-- Bounded image/file attachments owned by one conversation and, once sent,
-- one message. Bytes live in object storage (opaque key) or, only in
-- development/test, inline. Names and bytes never enter audit or outbox rows.
CREATE TABLE tutorhub.message_attachments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    message_id uuid,
    uploader_user_id uuid NOT NULL,
    client_attachment_id uuid NOT NULL,
    request_fingerprint bytea NOT NULL,
    kind text NOT NULL,
    display_name text NOT NULL,
    media_type text NOT NULL,
    size_bytes bigint NOT NULL,
    width_px integer,
    height_px integer,
    storage_backend text NOT NULL,
    object_key text,
    inline_bytes bytea,
    state text NOT NULL DEFAULT 'staged',
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT message_attachments_tenant_id_unique UNIQUE (tenant_id, id),
    CONSTRAINT message_attachments_client_idempotency_unique
        UNIQUE (tenant_id, uploader_user_id, client_attachment_id),
    CONSTRAINT message_attachments_conversation_fk
        FOREIGN KEY (tenant_id, conversation_id)
        REFERENCES tutorhub.conversations (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT message_attachments_message_fk
        FOREIGN KEY (tenant_id, conversation_id, message_id)
        REFERENCES tutorhub.messages (tenant_id, conversation_id, id)
        ON DELETE CASCADE,
    CONSTRAINT message_attachments_uploader_membership_fk
        FOREIGN KEY (tenant_id, uploader_user_id)
        REFERENCES tutorhub.memberships (tenant_id, user_id),
    CONSTRAINT message_attachments_request_fingerprint_valid CHECK (
        octet_length(request_fingerprint) = 32
    ),
    CONSTRAINT message_attachments_kind_valid CHECK (kind IN ('image', 'file')),
    CONSTRAINT message_attachments_display_name_valid CHECK (
        char_length(display_name) BETWEEN 1 AND 255
    ),
    CONSTRAINT message_attachments_media_type_valid CHECK (
        char_length(media_type) BETWEEN 3 AND 127
    ),
    CONSTRAINT message_attachments_size_valid CHECK (
        size_bytes BETWEEN 1 AND 10485760
    ),
    CONSTRAINT message_attachments_width_valid CHECK (
        width_px IS NULL OR width_px BETWEEN 1 AND 16384
    ),
    CONSTRAINT message_attachments_height_valid CHECK (
        height_px IS NULL OR height_px BETWEEN 1 AND 16384
    ),
    CONSTRAINT message_attachments_storage_backend_valid CHECK (
        storage_backend IN ('b2', 'inline_dev')
    ),
    CONSTRAINT message_attachments_state_valid CHECK (
        state IN ('staged', 'attached', 'deleted')
    ),
    CONSTRAINT message_attachments_binding_valid CHECK (
        (state = 'staged' AND message_id IS NULL)
        OR (state = 'attached' AND message_id IS NOT NULL)
        OR state = 'deleted'
    ),
    CONSTRAINT message_attachments_deleted_bytes_cleared CHECK (
        state <> 'deleted' OR inline_bytes IS NULL
    ),
    CONSTRAINT message_attachments_inline_bytes_valid CHECK (
        storage_backend <> 'inline_dev'
        OR state = 'deleted'
        OR (
            inline_bytes IS NOT NULL
            AND octet_length(inline_bytes) = size_bytes
            AND object_key IS NULL
        )
    ),
    CONSTRAINT message_attachments_object_key_valid CHECK (
        storage_backend <> 'b2'
        OR (
            object_key IS NOT NULL
            AND char_length(object_key) BETWEEN 1 AND 1024
            AND inline_bytes IS NULL
        )
    ),
    CONSTRAINT message_attachments_updated_after_created CHECK (
        updated_at >= created_at
    )
);

CREATE INDEX message_attachments_message_idx
    ON tutorhub.message_attachments (tenant_id, conversation_id, message_id);

CREATE INDEX message_attachments_uploader_idx
    ON tutorhub.message_attachments (tenant_id, uploader_user_id, created_at DESC);

-- An active message may now carry only attachments (content = ''). The Core
-- API requires at least one bound attachment whenever content is empty.
ALTER TABLE tutorhub.messages
    DROP CONSTRAINT messages_content_lifecycle_valid;

ALTER TABLE tutorhub.messages
    ADD CONSTRAINT messages_content_lifecycle_valid CHECK (
        (
            state = 'active'
            AND deleted_at IS NULL
            AND content IS NOT NULL
            AND (
                content = ''
                OR char_length(content) BETWEEN 1 AND 4000
            )
            AND octet_length(content) <= 16384
            AND position(E'\r' IN content) = 0
            AND content = btrim(content, E' \t\n\r')
        )
        OR (
            state = 'deleted'
            AND deleted_at IS NOT NULL
            AND content IS NULL
        )
    );

-- Environment-specific Core API grants are provisioned separately.
REVOKE ALL ON tutorhub.room_conversation_settings FROM PUBLIC;
REVOKE ALL ON tutorhub.message_attachments FROM PUBLIC;

COMMIT;
