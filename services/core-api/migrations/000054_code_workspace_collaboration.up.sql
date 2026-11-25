BEGIN;

-- ROOM-TOOLS-CODE-02A (ADR-0043 §4 Slice 2) adds the shared classroom code
-- workspace control plane. These tables hold lifecycle metadata, the bounded
-- data-plane checkpoint and temporary per-actor edit grants only. Source code
-- never enters audit, outbox or mutation receipts.
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
            'classroom_code_collaboration'
        )
    );

CREATE TABLE tutorhub.code_workspaces (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    media_space_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'created',
    version bigint NOT NULL DEFAULT 1,
    current_generation bigint NOT NULL DEFAULT 1,
    revoke_generation bigint NOT NULL DEFAULT 1,
    create_idempotency_key text NOT NULL,
    create_request_fingerprint bytea NOT NULL,
    created_by uuid NOT NULL,
    updated_by uuid NOT NULL,
    opened_at timestamptz,
    opened_by uuid,
    suspended_at timestamptz,
    suspended_by uuid,
    resumed_at timestamptz,
    resumed_by uuid,
    closed_at timestamptz,
    closed_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT code_workspaces_tenant_id_unique UNIQUE (tenant_id, id),
    CONSTRAINT code_workspaces_source_unique UNIQUE (tenant_id, media_space_id),
    CONSTRAINT code_workspaces_tenant_fk
        FOREIGN KEY (tenant_id)
        REFERENCES tutorhub.tenants (id)
        ON DELETE CASCADE,
    CONSTRAINT code_workspaces_media_space_fk
        FOREIGN KEY (tenant_id, media_space_id)
        REFERENCES tutorhub.media_spaces (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT code_workspaces_creator_membership_fk
        FOREIGN KEY (tenant_id, created_by)
        REFERENCES tutorhub.memberships (tenant_id, user_id),
    CONSTRAINT code_workspaces_updater_membership_fk
        FOREIGN KEY (tenant_id, updated_by)
        REFERENCES tutorhub.memberships (tenant_id, user_id),
    CONSTRAINT code_workspaces_opener_membership_fk
        FOREIGN KEY (tenant_id, opened_by)
        REFERENCES tutorhub.memberships (tenant_id, user_id),
    CONSTRAINT code_workspaces_suspender_membership_fk
        FOREIGN KEY (tenant_id, suspended_by)
        REFERENCES tutorhub.memberships (tenant_id, user_id),
    CONSTRAINT code_workspaces_resumer_membership_fk
        FOREIGN KEY (tenant_id, resumed_by)
        REFERENCES tutorhub.memberships (tenant_id, user_id),
    CONSTRAINT code_workspaces_closer_membership_fk
        FOREIGN KEY (tenant_id, closed_by)
        REFERENCES tutorhub.memberships (tenant_id, user_id),
    CONSTRAINT code_workspaces_status_valid CHECK (
        status IN ('created', 'open', 'suspended', 'closed')
    ),
    CONSTRAINT code_workspaces_version_positive CHECK (version > 0),
    CONSTRAINT code_workspaces_generation_positive CHECK (
        current_generation > 0 AND revoke_generation > 0
    ),
    CONSTRAINT code_workspaces_create_idempotency_valid CHECK (
        length(create_idempotency_key) BETWEEN 16 AND 128
        AND create_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
        AND octet_length(create_request_fingerprint) = 32
    ),
    CONSTRAINT code_workspaces_create_idempotency_unique
        UNIQUE (tenant_id, created_by, create_idempotency_key),
    CONSTRAINT code_workspaces_updated_after_created CHECK (
        updated_at >= created_at
    ),
    CONSTRAINT code_workspaces_lifecycle_consistent CHECK (
        (
            status = 'created'
            AND opened_at IS NULL AND opened_by IS NULL
            AND suspended_at IS NULL AND suspended_by IS NULL
            AND resumed_at IS NULL AND resumed_by IS NULL
            AND closed_at IS NULL AND closed_by IS NULL
        )
        OR (
            status = 'open'
            AND opened_at IS NOT NULL AND opened_by IS NOT NULL
            AND opened_at >= created_at AND opened_at <= updated_at
            AND closed_at IS NULL AND closed_by IS NULL
            AND (
                (
                    suspended_at IS NULL AND suspended_by IS NULL
                    AND resumed_at IS NULL AND resumed_by IS NULL
                )
                OR (
                    suspended_at IS NOT NULL AND suspended_by IS NOT NULL
                    AND resumed_at IS NOT NULL AND resumed_by IS NOT NULL
                    AND suspended_at >= opened_at
                    AND resumed_at >= suspended_at
                    AND resumed_at <= updated_at
                )
            )
        )
        OR (
            status = 'suspended'
            AND opened_at IS NOT NULL AND opened_by IS NOT NULL
            AND suspended_at IS NOT NULL AND suspended_by IS NOT NULL
            AND opened_at >= created_at
            AND suspended_at >= opened_at
            AND suspended_at <= updated_at
            AND closed_at IS NULL AND closed_by IS NULL
            AND (
                (resumed_at IS NULL AND resumed_by IS NULL)
                OR (
                    resumed_at IS NOT NULL AND resumed_by IS NOT NULL
                    AND resumed_at >= opened_at
                    AND suspended_at >= resumed_at
                )
            )
        )
        OR (
            status = 'closed'
            AND closed_at IS NOT NULL AND closed_by IS NOT NULL
            AND closed_at >= created_at AND closed_at <= updated_at
            AND (
                (opened_at IS NULL AND opened_by IS NULL)
                OR (
                    opened_at IS NOT NULL AND opened_by IS NOT NULL
                    AND opened_at >= created_at AND closed_at >= opened_at
                )
            )
            AND (
                (suspended_at IS NULL AND suspended_by IS NULL)
                OR (
                    suspended_at IS NOT NULL AND suspended_by IS NOT NULL
                    AND opened_at IS NOT NULL AND suspended_at >= opened_at
                    AND suspended_at <= closed_at
                )
            )
            AND (
                (resumed_at IS NULL AND resumed_by IS NULL)
                OR (
                    resumed_at IS NOT NULL AND resumed_by IS NOT NULL
                    AND suspended_at IS NOT NULL
                    AND resumed_at >= suspended_at AND resumed_at <= closed_at
                )
            )
        )
    )
);

CREATE INDEX code_workspaces_tenant_status_updated_idx
    ON tutorhub.code_workspaces (tenant_id, status, updated_at DESC, id DESC);

-- One immutable canonical generation descriptor per row. The provider name
-- is opaque and server-generated; the `cw_` prefix keeps it disjoint from the
-- whiteboard namespace so the shared runtime can never cross-load a kind.
CREATE TABLE tutorhub.code_workspace_generations (
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    generation bigint NOT NULL,
    authority_kind text NOT NULL DEFAULT 'yjs',
    authority_version text NOT NULL DEFAULT '13.6.27',
    provider_kind text NOT NULL DEFAULT 'hocuspocus',
    provider_version text NOT NULL DEFAULT '4.6.0',
    provider_document_name text NOT NULL,
    reason text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, workspace_id, generation),
    CONSTRAINT code_workspace_generations_workspace_fk
        FOREIGN KEY (tenant_id, workspace_id)
        REFERENCES tutorhub.code_workspaces (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT code_workspace_generations_creator_membership_fk
        FOREIGN KEY (tenant_id, created_by)
        REFERENCES tutorhub.memberships (tenant_id, user_id),
    CONSTRAINT code_workspace_generations_generation_positive CHECK (generation > 0),
    CONSTRAINT code_workspace_generations_authority_exact CHECK (
        authority_kind = 'yjs' AND authority_version = '13.6.27'
    ),
    CONSTRAINT code_workspace_generations_provider_exact CHECK (
        provider_kind = 'hocuspocus' AND provider_version = '4.6.0'
    ),
    CONSTRAINT code_workspace_generations_provider_name_valid CHECK (
        length(provider_document_name) BETWEEN 25 AND 128
        AND provider_document_name ~ '^cw_[A-Za-z0-9_-]{22,125}$'
    ),
    CONSTRAINT code_workspace_generations_provider_name_unique
        UNIQUE (provider_kind, provider_document_name),
    CONSTRAINT code_workspace_generations_reason_valid CHECK (
        reason IN ('initial', 'provider_migration')
    ),
    CONSTRAINT code_workspace_generations_reason_shape_valid CHECK (
        (reason = 'initial' AND generation = 1)
        OR (reason = 'provider_migration' AND generation > 1)
    )
);

ALTER TABLE tutorhub.code_workspaces
    ADD CONSTRAINT code_workspaces_current_generation_fk
        FOREIGN KEY (tenant_id, id, current_generation)
        REFERENCES tutorhub.code_workspace_generations (
            tenant_id, workspace_id, generation
        )
        DEFERRABLE INITIALLY DEFERRED;

-- The collaboration runtime owns this single bounded Yjs checkpoint per
-- generation. The 512 KiB ceiling is the hard data-plane cap for
-- `code.workspace.v1` (8 files, <= 256 KB UTF-8 text plus CRDT metadata).
CREATE TABLE tutorhub.code_workspace_checkpoints (
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    generation bigint NOT NULL,
    provider_document_name text NOT NULL,
    schema_version integer NOT NULL,
    provider_version text NOT NULL,
    causal_watermark bigint NOT NULL,
    yjs_state bytea NOT NULL,
    byte_length integer NOT NULL,
    checksum bytea NOT NULL,
    writer_fence bigint NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, workspace_id, generation),
    CONSTRAINT code_workspace_checkpoints_generation_fk
        FOREIGN KEY (tenant_id, workspace_id, generation)
        REFERENCES tutorhub.code_workspace_generations (
            tenant_id, workspace_id, generation
        )
        ON DELETE CASCADE,
    CONSTRAINT code_workspace_checkpoints_provider_unique
        UNIQUE (provider_document_name),
    CONSTRAINT code_workspace_checkpoints_provider_valid CHECK (
        provider_document_name ~ '^cw_[A-Za-z0-9_-]{22,125}$'
    ),
    CONSTRAINT code_workspace_checkpoints_version_valid CHECK (
        schema_version = 1
        AND provider_version = 'hocuspocus@4.6.0+yjs@13.6.27'
    ),
    CONSTRAINT code_workspace_checkpoints_state_valid CHECK (
        byte_length BETWEEN 1 AND 524288
        AND octet_length(yjs_state) = byte_length
        AND octet_length(checksum) = 32
    ),
    CONSTRAINT code_workspace_checkpoints_fence_valid CHECK (
        generation > 0 AND causal_watermark > 0 AND writer_fence > 0
    )
);

-- Temporary per-actor edit grants. The public API only ever addresses a
-- RoomInstance-scoped participant_key; the server resolves it to this
-- internal actor and never projects actor_user_id.
CREATE TABLE tutorhub.code_workspace_actor_grants (
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    actor_user_id uuid NOT NULL,
    capability text NOT NULL DEFAULT 'edit',
    granted_by uuid NOT NULL,
    granted_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    revoked_by uuid,
    version bigint NOT NULL DEFAULT 1,
    PRIMARY KEY (tenant_id, workspace_id, actor_user_id),
    CONSTRAINT code_workspace_actor_grants_workspace_fk
        FOREIGN KEY (tenant_id, workspace_id)
        REFERENCES tutorhub.code_workspaces (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT code_workspace_actor_grants_actor_membership_fk
        FOREIGN KEY (tenant_id, actor_user_id)
        REFERENCES tutorhub.memberships (tenant_id, user_id),
    CONSTRAINT code_workspace_actor_grants_granter_membership_fk
        FOREIGN KEY (tenant_id, granted_by)
        REFERENCES tutorhub.memberships (tenant_id, user_id),
    CONSTRAINT code_workspace_actor_grants_revoker_membership_fk
        FOREIGN KEY (tenant_id, revoked_by)
        REFERENCES tutorhub.memberships (tenant_id, user_id),
    CONSTRAINT code_workspace_actor_grants_capability_exact CHECK (
        capability = 'edit'
    ),
    CONSTRAINT code_workspace_actor_grants_ttl_valid CHECK (
        expires_at > granted_at
        AND expires_at <= granted_at + interval '30 minutes'
    ),
    CONSTRAINT code_workspace_actor_grants_revocation_consistent CHECK (
        (revoked_at IS NULL AND revoked_by IS NULL)
        OR (
            revoked_at IS NOT NULL AND revoked_by IS NOT NULL
            AND revoked_at >= granted_at
        )
    ),
    CONSTRAINT code_workspace_actor_grants_version_positive CHECK (version > 0)
);

CREATE INDEX code_workspace_actor_grants_active_idx
    ON tutorhub.code_workspace_actor_grants (
        tenant_id, workspace_id, expires_at
    )
    WHERE revoked_at IS NULL;

-- Bounded business-command idempotency receipts for lifecycle transitions.
-- They are not a live operation log and contain no workspace content.
CREATE TABLE tutorhub.code_workspace_mutation_receipts (
    tenant_id uuid NOT NULL,
    actor_user_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    request_fingerprint bytea NOT NULL,
    operation text NOT NULL,
    workspace_id uuid NOT NULL,
    result_workspace_version bigint NOT NULL,
    result_generation bigint NOT NULL,
    result_revoke_generation bigint NOT NULL,
    result_status text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, actor_user_id, idempotency_key),
    CONSTRAINT code_workspace_mutation_receipts_workspace_fk
        FOREIGN KEY (tenant_id, workspace_id)
        REFERENCES tutorhub.code_workspaces (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT code_workspace_mutation_receipts_generation_fk
        FOREIGN KEY (tenant_id, workspace_id, result_generation)
        REFERENCES tutorhub.code_workspace_generations (
            tenant_id, workspace_id, generation
        ),
    CONSTRAINT code_workspace_mutation_receipts_actor_membership_fk
        FOREIGN KEY (tenant_id, actor_user_id)
        REFERENCES tutorhub.memberships (tenant_id, user_id),
    CONSTRAINT code_workspace_mutation_receipts_idempotency_valid CHECK (
        length(idempotency_key) BETWEEN 16 AND 128
        AND idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
        AND octet_length(request_fingerprint) = 32
    ),
    CONSTRAINT code_workspace_mutation_receipts_operation_valid CHECK (
        operation IN ('open', 'suspend', 'resume', 'close')
    ),
    CONSTRAINT code_workspace_mutation_receipts_result_positive CHECK (
        result_workspace_version > 0
        AND result_generation > 0
        AND result_revoke_generation > 0
    ),
    CONSTRAINT code_workspace_mutation_receipts_status_valid CHECK (
        result_status IN ('created', 'open', 'suspended', 'closed')
    )
);

CREATE INDEX code_workspace_mutation_receipts_workspace_created_idx
    ON tutorhub.code_workspace_mutation_receipts (
        tenant_id, workspace_id, created_at DESC, actor_user_id, idempotency_key
    );

-- Environment-specific runtime grants are provisioned after the migration by
-- the reviewed acceptance harness; nothing is granted to PUBLIC.
REVOKE ALL ON TABLE tutorhub.code_workspaces FROM PUBLIC;
REVOKE ALL ON TABLE tutorhub.code_workspace_generations FROM PUBLIC;
REVOKE ALL ON TABLE tutorhub.code_workspace_checkpoints FROM PUBLIC;
REVOKE ALL ON TABLE tutorhub.code_workspace_actor_grants FROM PUBLIC;
REVOKE ALL ON TABLE tutorhub.code_workspace_mutation_receipts FROM PUBLIC;

COMMIT;
