import type { CodeOutputStream } from "./outputBuffer";

/**
 * ROOM-TOOLS-CODE-01 sandbox wire protocol (ADR-0043 §3). The parent and the
 * opaque-origin runner talk only through one transferred `MessageChannel`
 * port. Everything arriving from the sandbox is untrusted: these validators
 * accept only the exact shapes below with bounded sizes. Nothing that
 * identifies the user (token, cookie, email, tenant) is ever sent in.
 */
export const SANDBOX_PROTOCOL = "tutorhub-code-sandbox";
export const SANDBOX_PROTOCOL_VERSION = 1;

export type SandboxLanguage = "javascript" | "python" | "sql";
export type SandboxRuntimeName = "python" | "sql";
export type SandboxRunStatus = "ok" | "error" | "truncated";

export const SQL_MAX_ROWS = 500;
export const SQL_MAX_COLUMNS = 50;
export const SQL_MAX_TABLES = 20;
const MAX_ID_LENGTH = 64;
const MAX_TEXT_CHUNK = 70_000;
const MAX_CELL_LENGTH = 4_096;
const MAX_CHUNKS = 256;

export type SqlCell = string | number | null;

export interface SqlResultTable {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly SqlCell[])[];
  readonly truncated: boolean;
}

export type SandboxInbound =
  | { readonly type: "ready" }
  | {
      readonly type: "phase";
      readonly id: string;
      readonly phase: "initializing" | "running";
    }
  | {
      readonly type: "output";
      readonly id: string;
      readonly chunks: readonly {
        readonly stream: CodeOutputStream;
        readonly text: string;
      }[];
    }
  | {
      readonly type: "table";
      readonly id: string;
      readonly table: SqlResultTable;
    }
  | {
      readonly type: "sql-summary";
      readonly id: string;
      readonly changes: number;
    }
  | {
      readonly type: "done";
      readonly id: string;
      readonly status: SandboxRunStatus;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRunID(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function parseCell(value: unknown): SqlCell | undefined {
  if (value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value.slice(0, MAX_CELL_LENGTH);
  return undefined;
}

export function parseSqlTable(value: unknown): SqlResultTable | null {
  if (!isRecord(value)) return null;
  const { columns, rows, truncated } = value;
  if (!Array.isArray(columns) || !Array.isArray(rows)) return null;
  if (columns.length > SQL_MAX_COLUMNS || rows.length > SQL_MAX_ROWS) {
    return null;
  }
  const parsedColumns: string[] = [];
  for (const column of columns) {
    if (typeof column !== "string") return null;
    parsedColumns.push(column.slice(0, 256));
  }
  const parsedRows: SqlCell[][] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length > SQL_MAX_COLUMNS) return null;
    const cells: SqlCell[] = [];
    for (const cell of row) {
      const parsed = parseCell(cell);
      if (parsed === undefined) return null;
      cells.push(parsed);
    }
    parsedRows.push(cells);
  }
  return {
    columns: parsedColumns,
    rows: parsedRows,
    truncated: truncated === true,
  };
}

/** Returns the message when it is a valid runner message, else `null`. */
export function parseSandboxInbound(value: unknown): SandboxInbound | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "ready":
      return { type: "ready" };
    case "phase":
      return isRunID(value.id) &&
        (value.phase === "initializing" || value.phase === "running")
        ? { id: value.id, phase: value.phase, type: "phase" }
        : null;
    case "output": {
      if (!isRunID(value.id) || !Array.isArray(value.chunks)) return null;
      if (value.chunks.length > MAX_CHUNKS) return null;
      const chunks: { stream: CodeOutputStream; text: string }[] = [];
      for (const chunk of value.chunks) {
        if (
          !isRecord(chunk) ||
          (chunk.stream !== "stdout" && chunk.stream !== "stderr") ||
          typeof chunk.text !== "string" ||
          chunk.text.length > MAX_TEXT_CHUNK
        ) {
          return null;
        }
        chunks.push({ stream: chunk.stream, text: chunk.text });
      }
      return { chunks, id: value.id, type: "output" };
    }
    case "table": {
      const table = parseSqlTable(value.table);
      return isRunID(value.id) && table
        ? { id: value.id, table, type: "table" }
        : null;
    }
    case "sql-summary":
      return isRunID(value.id) &&
        typeof value.changes === "number" &&
        Number.isSafeInteger(value.changes) &&
        value.changes >= 0
        ? { changes: value.changes, id: value.id, type: "sql-summary" }
        : null;
    case "done":
      return isRunID(value.id) &&
        (value.status === "ok" ||
          value.status === "error" ||
          value.status === "truncated")
        ? { id: value.id, status: value.status, type: "done" }
        : null;
    default:
      return null;
  }
}
