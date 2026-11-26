import { createHash, timingSafeEqual } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type {
  CheckpointStore,
  CollaborationScope,
  StoredCheckpoint,
} from "./contracts.js";
import { MAX_DURABLE_DOCUMENT_BYTES } from "./contracts.js";
import {
  CheckpointCompactionError,
  compactCheckpointState,
} from "./checkpointCompaction.js";
import {
  CODE_WORKSPACE_DOCUMENT_KIND,
  CODE_WORKSPACE_MAX_DOCUMENT_BYTES,
  documentKindForName,
  PDF_ANNOTATIONS_DOCUMENT_KIND,
  PDF_ANNOTATIONS_MAX_DOCUMENT_BYTES,
  scopeDocumentKind,
} from "./documentKind.js";

const CHECKPOINT_SCHEMA_VERSION = 1;
const PROVIDER_VERSION = "hocuspocus@4.6.0+yjs@13.6.27";

/**
 * One static, reviewed SQL target per document kind. Table and column names
 * are never derived from runtime input.
 */
interface CheckpointTarget {
  readonly documentColumn: "document_id" | "presentation_id" | "workspace_id";
  readonly maxBytes: number;
  readonly table:
    | "code_workspace_checkpoints"
    | "pdf_presentation_checkpoints"
    | "whiteboard_document_checkpoints";
}

const WHITEBOARD_CHECKPOINTS: CheckpointTarget = {
  documentColumn: "document_id",
  maxBytes: MAX_DURABLE_DOCUMENT_BYTES,
  table: "whiteboard_document_checkpoints",
};

const CODE_WORKSPACE_CHECKPOINTS: CheckpointTarget = {
  documentColumn: "workspace_id",
  maxBytes: CODE_WORKSPACE_MAX_DOCUMENT_BYTES,
  table: "code_workspace_checkpoints",
};

const PDF_ANNOTATIONS_CHECKPOINTS: CheckpointTarget = {
  documentColumn: "presentation_id",
  maxBytes: PDF_ANNOTATIONS_MAX_DOCUMENT_BYTES,
  table: "pdf_presentation_checkpoints",
};

/**
 * Optional per-kind checkpoint tables introduced after the whiteboard table.
 * Before their migration runs they are absent and whiteboard readiness is
 * unaffected; once present, the runtime role must read and write them.
 */
const ROLLOUT_CHECKPOINT_TABLES = [
  CODE_WORKSPACE_CHECKPOINTS.table,
  PDF_ANNOTATIONS_CHECKPOINTS.table,
] as const;

export function checkpointTargetFor(
  scope: CollaborationScope,
): CheckpointTarget {
  const kind = scopeDocumentKind(scope);
  if (documentKindForName(scope.providerDocumentName) !== kind) {
    throw new CheckpointStoreError("checkpoint_corrupt");
  }
  if (kind === CODE_WORKSPACE_DOCUMENT_KIND) return CODE_WORKSPACE_CHECKPOINTS;
  if (kind === PDF_ANNOTATIONS_DOCUMENT_KIND)
    return PDF_ANNOTATIONS_CHECKPOINTS;
  return WHITEBOARD_CHECKPOINTS;
}

export class CheckpointStoreError extends Error {
  constructor(
    readonly code:
      | "checkpoint_corrupt"
      | "checkpoint_schema_unavailable"
      | "checkpoint_stale_writer"
      | "checkpoint_too_large"
      | "checkpoint_unavailable",
  ) {
    super(code);
    this.name = "CheckpointStoreError";
  }
}

export class NeonCheckpointStore implements CheckpointStore {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      allowExitOnIdle: true,
      connectionString: databaseUrl,
      connectionTimeoutMillis: 2_000,
      idleTimeoutMillis: 10_000,
      max: 4,
      statement_timeout: 5_000,
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async probe(): Promise<void> {
    try {
      const result = await this.pool.query<{
        allowed: boolean | null;
        table_exists: boolean;
      }>(`
        SELECT
          to_regclass('tutorhub.whiteboard_document_checkpoints') IS NOT NULL AS table_exists,
          has_table_privilege(
            current_user,
            'tutorhub.whiteboard_document_checkpoints',
            'SELECT'
          )
          AND has_table_privilege(
            current_user,
            'tutorhub.whiteboard_document_checkpoints',
            'INSERT'
          )
          AND has_table_privilege(
            current_user,
            'tutorhub.whiteboard_document_checkpoints',
            'UPDATE'
          ) AS allowed
      `);
      const row = result.rows[0];
      if (!row?.table_exists || row.allowed !== true) {
        throw new CheckpointStoreError("checkpoint_schema_unavailable");
      }
      // Rollout compatibility: before migrations 000054 (code) and 000057
      // (PDF annotations) their checkpoint tables are absent and whiteboard
      // readiness is unaffected; once a table exists, the runtime role must be
      // able to read and write it. Table names come from a static allowlist.
      for (const table of ROLLOUT_CHECKPOINT_TABLES) {
        await assertOptionalCheckpointTable(this.pool, table);
      }
    } catch (error) {
      if (error instanceof CheckpointStoreError) throw error;
      throw new CheckpointStoreError("checkpoint_unavailable");
    }
  }

  async load(scope: CollaborationScope): Promise<StoredCheckpoint | null> {
    const target = checkpointTargetFor(scope);
    try {
      const result = await this.pool.query<{
        byte_length: number;
        causal_watermark: string;
        checksum: string;
        provider_version: string;
        schema_version: number;
        yjs_state: Buffer;
      }>(
        `
          SELECT
            schema_version,
            provider_version,
            causal_watermark,
            yjs_state,
            byte_length,
            encode(checksum, 'hex') AS checksum
          FROM tutorhub.${target.table}
          WHERE tenant_id = $1
            AND ${target.documentColumn} = $2
            AND generation = $3
            AND provider_document_name = $4
          LIMIT 1
        `,
        [
          scope.tenantId,
          scope.documentId,
          scope.generation,
          scope.providerDocumentName,
        ],
      );
      const row = result.rows[0];
      if (!row) return null;
      const watermark = Number(row.causal_watermark);
      if (
        row.schema_version !== CHECKPOINT_SCHEMA_VERSION ||
        row.provider_version !== PROVIDER_VERSION ||
        !Number.isSafeInteger(watermark) ||
        watermark < 1 ||
        row.byte_length !== row.yjs_state.byteLength ||
        row.byte_length > target.maxBytes ||
        !checksumMatches(row.yjs_state, row.checksum)
      ) {
        throw new CheckpointStoreError("checkpoint_corrupt");
      }
      const compacted = compactCheckpointState(
        new Uint8Array(row.yjs_state),
        target.maxBytes,
      );
      return {
        checksum: sha256(compacted.state),
        state: compacted.state,
        watermark,
      };
    } catch (error) {
      if (error instanceof CheckpointStoreError) throw error;
      if (error instanceof CheckpointCompactionError) {
        throw new CheckpointStoreError(
          error.code === "checkpoint_too_large"
            ? "checkpoint_too_large"
            : "checkpoint_corrupt",
        );
      }
      throw new CheckpointStoreError("checkpoint_unavailable");
    }
  }

  async store(scope: CollaborationScope, state: Uint8Array): Promise<number> {
    const target = checkpointTargetFor(scope);
    let compacted: Uint8Array;
    try {
      compacted = compactCheckpointState(state, target.maxBytes).state;
    } catch (error) {
      if (error instanceof CheckpointCompactionError) {
        throw new CheckpointStoreError(
          error.code === "checkpoint_too_large"
            ? "checkpoint_too_large"
            : "checkpoint_corrupt",
        );
      }
      throw error;
    }
    const checksum = sha256(compacted);
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      const result = await client.query<{ causal_watermark: string }>(
        `
          INSERT INTO tutorhub.${target.table} (
            tenant_id,
            ${target.documentColumn},
            generation,
            provider_document_name,
            schema_version,
            provider_version,
            causal_watermark,
            yjs_state,
            byte_length,
            checksum,
            writer_fence,
            updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, decode($9, 'hex'), $10, NOW())
          ON CONFLICT (tenant_id, ${target.documentColumn}, generation)
          DO UPDATE SET
            provider_document_name = EXCLUDED.provider_document_name,
            schema_version = EXCLUDED.schema_version,
            provider_version = EXCLUDED.provider_version,
            causal_watermark = ${target.table}.causal_watermark + 1,
            yjs_state = EXCLUDED.yjs_state,
            byte_length = EXCLUDED.byte_length,
            checksum = EXCLUDED.checksum,
            writer_fence = EXCLUDED.writer_fence,
            updated_at = NOW()
          WHERE ${target.table}.writer_fence <= EXCLUDED.writer_fence
            AND ${target.table}.provider_document_name = EXCLUDED.provider_document_name
          RETURNING causal_watermark
        `,
        [
          scope.tenantId,
          scope.documentId,
          scope.generation,
          scope.providerDocumentName,
          CHECKPOINT_SCHEMA_VERSION,
          PROVIDER_VERSION,
          Buffer.from(compacted),
          compacted.byteLength,
          checksum,
          scope.writerFence,
        ],
      );
      const watermark = Number(result.rows[0]?.causal_watermark);
      if (!Number.isSafeInteger(watermark) || watermark < 1) {
        throw new CheckpointStoreError("checkpoint_stale_writer");
      }
      await client.query("COMMIT");
      return watermark;
    } catch (error) {
      if (client) await rollbackQuietly(client);
      if (error instanceof CheckpointStoreError) throw error;
      throw new CheckpointStoreError("checkpoint_unavailable");
    } finally {
      client?.release();
    }
  }
}

async function assertOptionalCheckpointTable(
  pool: Pool,
  table: (typeof ROLLOUT_CHECKPOINT_TABLES)[number],
): Promise<void> {
  const qualified = `tutorhub.${table}`;
  const result = await pool.query<{
    allowed: boolean | null;
    table_exists: boolean;
  }>(
    `
      SELECT
        to_regclass($1) IS NOT NULL AS table_exists,
        CASE
          WHEN to_regclass($1) IS NULL THEN NULL
          ELSE has_table_privilege(current_user, $1, 'SELECT')
            AND has_table_privilege(current_user, $1, 'INSERT')
            AND has_table_privilege(current_user, $1, 'UPDATE')
        END AS allowed
    `,
    [qualified],
  );
  const row = result.rows[0];
  if (row?.table_exists && row.allowed !== true) {
    throw new CheckpointStoreError("checkpoint_schema_unavailable");
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function checksumMatches(value: Uint8Array, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expected)) return false;
  return timingSafeEqual(
    Buffer.from(sha256(value), "hex"),
    Buffer.from(expected, "hex"),
  );
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The bounded public error is emitted by the caller; raw database errors are never logged.
  }
}
