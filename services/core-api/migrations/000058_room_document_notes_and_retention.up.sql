BEGIN;

CREATE TABLE tutorhub.document_study_notes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tutorhub.tenants (id) ON DELETE CASCADE,
    owner_user_id uuid NOT NULL,
    media_space_id uuid NOT NULL,
    content_file_id uuid NOT NULL,
    notes_json text NOT NULL CHECK (octet_length(notes_json) BETWEEN 2 AND 98304),
    byte_length integer NOT NULL CHECK (byte_length BETWEEN 0 AND 65536),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now() CHECK (updated_at >= created_at),
    expires_at timestamptz NOT NULL CHECK (
        expires_at > updated_at AND expires_at <= updated_at + interval '31 days'
    ),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, owner_user_id, media_space_id, content_file_id),
    FOREIGN KEY (tenant_id, owner_user_id) REFERENCES tutorhub.memberships (tenant_id, user_id),
    FOREIGN KEY (tenant_id, media_space_id) REFERENCES tutorhub.media_spaces (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, content_file_id) REFERENCES tutorhub.content_files (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX document_study_notes_owner_updated_idx
    ON tutorhub.document_study_notes (tenant_id, owner_user_id, expires_at DESC, updated_at DESC);

CREATE INDEX content_files_media_space_retention_idx
    ON tutorhub.content_files (expires_at ASC, tenant_id ASC, id ASC)
    WHERE deleted_at IS NULL AND owner_kind = 'media_space';

-- The anchor scan joins these rooms to content_files_media_space_created_idx.
CREATE INDEX media_spaces_document_retention_closed_idx
    ON tutorhub.media_spaces (tenant_id, id)
    WHERE status IN ('ended', 'cancelled');

REVOKE ALL ON TABLE tutorhub.document_study_notes FROM PUBLIC;

COMMIT;
