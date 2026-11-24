BEGIN;

LOCK TABLE tutorhub.messages IN SHARE ROW EXCLUSIVE MODE;

-- Attachment rows (and any inline development bytes) go first.
DROP TABLE tutorhub.message_attachments;
DROP TABLE tutorhub.room_conversation_settings;

-- Attachment-only messages cannot exist under the restored 1..4000 rule. They
-- become durable tombstones (not hard deletes) so receipts, ordering and
-- idempotency rows that reference them stay valid.
UPDATE tutorhub.messages
SET content = NULL,
    state = 'deleted',
    version = version + 1,
    deleted_at = greatest(updated_at, statement_timestamp()),
    updated_at = greatest(updated_at, statement_timestamp())
WHERE state = 'active' AND content = '';

ALTER TABLE tutorhub.messages
    DROP CONSTRAINT messages_content_lifecycle_valid;

ALTER TABLE tutorhub.messages
    ADD CONSTRAINT messages_content_lifecycle_valid CHECK (
        (
            state = 'active'
            AND deleted_at IS NULL
            AND content IS NOT NULL
            AND char_length(content) BETWEEN 1 AND 4000
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

COMMIT;
