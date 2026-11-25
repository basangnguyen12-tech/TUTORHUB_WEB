import type {
  CodeWorkspaceLanguage,
  CodeWorkspaceSnapshot,
} from "./codeWorkspaceAuthority.js";

/**
 * ROOM-TOOLS-CODE-03A (ADR-0043 §4 Slice 3): the immutable portable project
 * envelope `tutorhub.code.workspace.v1`.
 *
 * - Zero runtime dependencies: only `TextEncoder`/`TextDecoder` and
 *   `globalThis.crypto.subtle.digest("SHA-256", ...)`. The Yjs authority is
 *   imported for types only, so this module never pulls `yjs` into a bundle.
 * - Export validates every bound fail-closed, serializes with sorted keys and
 *   no insignificant whitespace, and seals the content with `contentSha256`.
 * - Import is a quarantine: size, encoding, prototype-polluting keys, exact
 *   shape, every bound and a bit-exact checksum are verified before anything
 *   is returned. Nothing in the envelope is ever executed.
 *
 * `contentSha256` is `sha256:<64 lowercase hex>` over the canonical JSON of
 * `{ format, schemaVersion, title, workspace }` (everything except the
 * checksum itself and the volatile `exportedAt`), so identical projects hash
 * identically across exports.
 */
export const PORTABLE_CODE_WORKSPACE_FORMAT =
  "tutorhub.code.workspace.v1" as const;
export const PORTABLE_CODE_WORKSPACE_SCHEMA_VERSION = 1 as const;

export const PORTABLE_CODE_WORKSPACE_LIMITS = Object.freeze({
  maxDepth: 6,
  maxEnvelopeBytes: 512 * 1024,
  maxFileBytes: 64 * 1024,
  maxFileNameLength: 64,
  maxFiles: 8,
  maxStdinBytes: 16 * 1024,
  maxTitleLength: 120,
  maxTotalBytes: 256 * 1024,
});

/** Mirrors `CODE_WORKSPACE_LANGUAGES` without importing the Yjs module. */
export const PORTABLE_CODE_WORKSPACE_LANGUAGES = Object.freeze([
  "python",
  "javascript",
  "typescript",
  "html",
  "sql",
  "c",
  "cpp",
  "java",
  "css",
] as const satisfies readonly CodeWorkspaceLanguage[]);

const FILE_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const CHECKSUM_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ENVELOPE_KEYS = [
  "contentSha256",
  "exportedAt",
  "format",
  "schemaVersion",
  "title",
  "workspace",
] as const;
const WORKSPACE_KEYS = ["activeIndex", "files", "stdin"] as const;
const FILE_KEYS = ["content", "language", "name"] as const;

export type PortableCodeWorkspaceErrorCode =
  | "active_index_invalid"
  | "checksum_mismatch"
  | "crypto_unavailable"
  | "file_content_invalid"
  | "file_duplicate_name"
  | "file_language_unsupported"
  | "file_limit"
  | "file_name_invalid"
  | "file_too_large"
  | "portable_corrupt"
  | "portable_format_unsupported"
  | "portable_too_large"
  | "portable_unsafe_key"
  | "stdin_too_large"
  | "title_invalid"
  | "workspace_too_large";

export class PortableCodeWorkspaceError extends Error {
  constructor(readonly code: PortableCodeWorkspaceErrorCode) {
    super(code);
    this.name = "PortableCodeWorkspaceError";
  }
}

export interface PortableCodeWorkspaceFile {
  readonly content: string;
  readonly language: CodeWorkspaceLanguage;
  readonly name: string;
}

/** Structurally identical to `CodeWorkspaceSnapshot`. */
export interface PortableCodeWorkspaceSnapshot {
  readonly activeIndex: number;
  readonly files: readonly PortableCodeWorkspaceFile[];
  readonly stdin: string;
}

export interface PortableCodeWorkspaceMetadata {
  /** ISO-8601 UTC timestamp; defaults to now. */
  readonly exportedAt?: string;
  /** Optional display title (at most 120 characters, single line). */
  readonly title?: string;
}

export interface PortableCodeWorkspaceEnvelopeV1 {
  readonly contentSha256: string;
  readonly exportedAt: string;
  readonly format: typeof PORTABLE_CODE_WORKSPACE_FORMAT;
  readonly schemaVersion: typeof PORTABLE_CODE_WORKSPACE_SCHEMA_VERSION;
  readonly title: string;
  readonly workspace: PortableCodeWorkspaceSnapshot;
}

export interface PortableCodeWorkspaceExport {
  readonly bytes: Uint8Array;
  readonly contentSha256: string;
  readonly envelope: PortableCodeWorkspaceEnvelopeV1;
  readonly json: string;
}

export interface PortableCodeWorkspaceImport {
  readonly contentSha256: string;
  readonly exportedAt: string;
  readonly snapshot: PortableCodeWorkspaceSnapshot;
  readonly title: string;
}

type CanonicalValue =
  | string
  | number
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

/**
 * Validates and seals a workspace snapshot. Accepts the live
 * `CodeWorkspaceSnapshot` (or a structurally identical draft).
 */
export async function exportPortableCodeWorkspace(
  snapshot: CodeWorkspaceSnapshot | PortableCodeWorkspaceSnapshot,
  metadata: PortableCodeWorkspaceMetadata = {},
): Promise<PortableCodeWorkspaceExport> {
  const workspace = validateWorkspace(snapshot);
  const exportedAt = metadata.exportedAt ?? new Date().toISOString();
  if (!isIsoTimestamp(exportedAt)) {
    throw new PortableCodeWorkspaceError("portable_corrupt");
  }
  const title = validateTitle(metadata.title ?? "");
  const contentSha256 = await checksum(title, workspace);
  const envelope: PortableCodeWorkspaceEnvelopeV1 = Object.freeze({
    contentSha256,
    exportedAt,
    format: PORTABLE_CODE_WORKSPACE_FORMAT,
    schemaVersion: PORTABLE_CODE_WORKSPACE_SCHEMA_VERSION,
    title,
    workspace,
  });
  const json = canonicalJson(envelope as unknown as CanonicalValue);
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > PORTABLE_CODE_WORKSPACE_LIMITS.maxEnvelopeBytes) {
    throw new PortableCodeWorkspaceError("portable_too_large");
  }
  return Object.freeze({ bytes, contentSha256, envelope, json });
}

/**
 * Quarantined import: rejects anything that is not a bit-exact, in-bounds
 * `tutorhub.code.workspace.v1` envelope.
 */
export async function importPortableCodeWorkspace(
  raw: string | Uint8Array | ArrayBuffer,
): Promise<PortableCodeWorkspaceImport> {
  const text = decodeEnvelope(raw);
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch {
    throw new PortableCodeWorkspaceError("portable_corrupt");
  }
  assertSafeTree(candidate, 0);
  if (!isRecord(candidate)) {
    throw new PortableCodeWorkspaceError("portable_corrupt");
  }
  if (
    candidate.format !== PORTABLE_CODE_WORKSPACE_FORMAT ||
    candidate.schemaVersion !== PORTABLE_CODE_WORKSPACE_SCHEMA_VERSION
  ) {
    throw new PortableCodeWorkspaceError("portable_format_unsupported");
  }
  if (!hasExactKeys(candidate, ENVELOPE_KEYS)) {
    throw new PortableCodeWorkspaceError("portable_corrupt");
  }
  const { contentSha256, exportedAt } = candidate;
  if (
    typeof contentSha256 !== "string" ||
    !CHECKSUM_PATTERN.test(contentSha256) ||
    typeof exportedAt !== "string" ||
    !isIsoTimestamp(exportedAt) ||
    typeof candidate.title !== "string"
  ) {
    throw new PortableCodeWorkspaceError("portable_corrupt");
  }
  const title = validateTitle(candidate.title);
  const workspace = validateWorkspace(candidate.workspace);
  if ((await checksum(title, workspace)) !== contentSha256) {
    throw new PortableCodeWorkspaceError("checksum_mismatch");
  }
  return Object.freeze({
    contentSha256,
    exportedAt,
    snapshot: workspace,
    title,
  });
}

function decodeEnvelope(raw: string | Uint8Array | ArrayBuffer): string {
  const limit = PORTABLE_CODE_WORKSPACE_LIMITS.maxEnvelopeBytes;
  if (typeof raw === "string") {
    // UTF-8 never needs fewer bytes than UTF-16 code units.
    if (raw.length > limit || utf8Length(raw) > limit) {
      throw new PortableCodeWorkspaceError("portable_too_large");
    }
    if (raw.length === 0) {
      throw new PortableCodeWorkspaceError("portable_corrupt");
    }
    return raw;
  }
  const bytes =
    raw instanceof Uint8Array
      ? raw
      : raw instanceof ArrayBuffer
        ? new Uint8Array(raw)
        : undefined;
  if (bytes === undefined || bytes.byteLength === 0) {
    throw new PortableCodeWorkspaceError("portable_corrupt");
  }
  if (bytes.byteLength > limit) {
    throw new PortableCodeWorkspaceError("portable_too_large");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PortableCodeWorkspaceError("portable_corrupt");
  }
}

function validateWorkspace(value: unknown): PortableCodeWorkspaceSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, WORKSPACE_KEYS)) {
    throw new PortableCodeWorkspaceError("portable_corrupt");
  }
  const { activeIndex, files, stdin } = value;
  if (!Array.isArray(files)) {
    throw new PortableCodeWorkspaceError("portable_corrupt");
  }
  if (
    files.length < 1 ||
    files.length > PORTABLE_CODE_WORKSPACE_LIMITS.maxFiles
  ) {
    throw new PortableCodeWorkspaceError("file_limit");
  }
  const names = new Set<string>();
  const validated: PortableCodeWorkspaceFile[] = [];
  let total = 0;
  for (const file of files as unknown[]) {
    if (!isRecord(file) || !hasExactKeys(file, FILE_KEYS)) {
      throw new PortableCodeWorkspaceError("portable_corrupt");
    }
    const { content, language, name } = file;
    if (!isValidFileName(name)) {
      throw new PortableCodeWorkspaceError("file_name_invalid");
    }
    const folded = name.toLowerCase();
    if (names.has(folded)) {
      throw new PortableCodeWorkspaceError("file_duplicate_name");
    }
    names.add(folded);
    if (!isLanguage(language)) {
      throw new PortableCodeWorkspaceError("file_language_unsupported");
    }
    if (typeof content !== "string" || !isStorableText(content)) {
      throw new PortableCodeWorkspaceError("file_content_invalid");
    }
    const bytes = utf8Length(content);
    if (bytes > PORTABLE_CODE_WORKSPACE_LIMITS.maxFileBytes) {
      throw new PortableCodeWorkspaceError("file_too_large");
    }
    total += bytes;
    if (total > PORTABLE_CODE_WORKSPACE_LIMITS.maxTotalBytes) {
      throw new PortableCodeWorkspaceError("workspace_too_large");
    }
    validated.push(Object.freeze({ content, language, name }));
  }
  if (typeof stdin !== "string" || !isStorableText(stdin)) {
    throw new PortableCodeWorkspaceError("file_content_invalid");
  }
  if (utf8Length(stdin) > PORTABLE_CODE_WORKSPACE_LIMITS.maxStdinBytes) {
    throw new PortableCodeWorkspaceError("stdin_too_large");
  }
  if (
    typeof activeIndex !== "number" ||
    !Number.isSafeInteger(activeIndex) ||
    activeIndex < 0 ||
    activeIndex >= validated.length
  ) {
    throw new PortableCodeWorkspaceError("active_index_invalid");
  }
  return Object.freeze({
    activeIndex,
    files: Object.freeze(validated),
    stdin,
  });
}

function validateTitle(value: string): string {
  if (
    typeof value !== "string" ||
    [...value].length > PORTABLE_CODE_WORKSPACE_LIMITS.maxTitleLength ||
    !isStorableText(value) ||
    hasControlCharacter(value)
  ) {
    throw new PortableCodeWorkspaceError("title_invalid");
  }
  return value;
}

async function checksum(
  title: string,
  workspace: PortableCodeWorkspaceSnapshot,
): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined || typeof subtle.digest !== "function") {
    throw new PortableCodeWorkspaceError("crypto_unavailable");
  }
  const payload = canonicalJson({
    format: PORTABLE_CODE_WORKSPACE_FORMAT,
    schemaVersion: PORTABLE_CODE_WORKSPACE_SCHEMA_VERSION,
    title,
    workspace: workspace as unknown as CanonicalValue,
  });
  const digest = new Uint8Array(
    await subtle.digest("SHA-256", new TextEncoder().encode(payload)),
  );
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return `sha256:${hex}`;
}

/** Sorted-key, whitespace-free JSON for strings, safe integers, arrays and plain objects. */
function canonicalJson(value: CanonicalValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new PortableCodeWorkspaceError("portable_corrupt");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${(value as readonly CanonicalValue[]).map(canonicalJson).join(",")}]`;
  }
  const record = value as { readonly [key: string]: CanonicalValue };
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`)
    .join(",")}}`;
}

function assertSafeTree(value: unknown, depth: number): void {
  if (depth > PORTABLE_CODE_WORKSPACE_LIMITS.maxDepth) {
    throw new PortableCodeWorkspaceError("portable_corrupt");
  }
  if (Array.isArray(value)) {
    for (const item of value) assertSafeTree(item, depth + 1);
    return;
  }
  if (isRecord(value)) {
    for (const key of Object.keys(value)) {
      if (UNSAFE_KEYS.has(key)) {
        throw new PortableCodeWorkspaceError("portable_unsafe_key");
      }
      assertSafeTree(value[key], depth + 1);
    }
  }
}

function hasExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(record).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

function isValidFileName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= PORTABLE_CODE_WORKSPACE_LIMITS.maxFileNameLength &&
    FILE_NAME_PATTERN.test(value) &&
    !/^\.+$/u.test(value)
  );
}

function isLanguage(value: unknown): value is CodeWorkspaceLanguage {
  return (
    typeof value === "string" &&
    (PORTABLE_CODE_WORKSPACE_LANGUAGES as readonly string[]).includes(value)
  );
}

/** Well-formed UTF-16 without NUL, matching the server's storage rules. */
function isStorableText(value: string): boolean {
  return !value.includes("\u0000") && !/\p{Cs}/u.test(value);
}

function hasControlCharacter(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
