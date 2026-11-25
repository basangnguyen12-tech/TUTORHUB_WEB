import * as Y from "yjs";

/**
 * ROOM-TOOLS-CODE-02A (ADR-0043 §4, RESEARCH-00 §3.3): the single canonical
 * client authority for a `code.workspace.v1` Yjs document.
 *
 * Y.Doc
 * ├─ meta:  Y.Map { schemaVersion: 1, activeFileId, presenterFileId? }
 * └─ files: Y.Map<fileId, Y.Map { id, name, language, order, text: Y.Text }>
 *
 * Bounds are enforced fail-closed: authority mutations validate before they
 * write, and any transaction that leaves the workspace above its caps (a
 * paste through the editor binding or a remote peer) is rolled back by an
 * editing client. A read-only client never writes; it reports the violation
 * instead. The collaboration runtime separately caps the document at 512 KiB
 * and each update at 32 KiB.
 */
export const CODE_WORKSPACE_SCHEMA_VERSION = 1 as const;

export const CODE_WORKSPACE_LIMITS = Object.freeze({
  maxFileBytes: 64 * 1024,
  maxFileNameLength: 64,
  maxFiles: 8,
  maxTotalBytes: 256 * 1024,
});

export const CODE_WORKSPACE_LANGUAGES = [
  "python",
  "javascript",
  "typescript",
  "html",
  "sql",
  "c",
  "cpp",
  "java",
  "css",
] as const;

export type CodeWorkspaceLanguage = (typeof CODE_WORKSPACE_LANGUAGES)[number];

export const CODE_WORKSPACE_FILE_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export type CodeWorkspaceErrorCode =
  | "authority_already_initialized"
  | "authority_not_initialized"
  | "authority_read_only"
  | "authority_scope_invalid"
  | "file_duplicate_name"
  | "file_invalid"
  | "file_language_unsupported"
  | "file_last"
  | "file_limit"
  | "file_name_invalid"
  | "file_not_found"
  | "file_too_large"
  | "workspace_corrupt"
  | "workspace_schema_unsupported"
  | "workspace_too_large";

export class CodeWorkspaceAuthorityError extends Error {
  constructor(readonly code: CodeWorkspaceErrorCode) {
    super(code);
    this.name = "CodeWorkspaceAuthorityError";
  }
}

export interface CodeWorkspaceAuthorityScope {
  documentId: string;
  generation: number;
  tenantId: string;
}

export interface CodeWorkspaceFileInput {
  content: string;
  language: CodeWorkspaceLanguage;
  name: string;
}

export interface CodeWorkspaceFileView {
  readonly bytes: number;
  readonly id: string;
  readonly language: CodeWorkspaceLanguage;
  readonly name: string;
  readonly order: number;
}

/**
 * Structurally identical to the web `ClassroomCodeWorkspaceSnapshot`, so a
 * student can fork the shared workspace into a personal draft (02B).
 */
export interface CodeWorkspaceSnapshot {
  readonly activeIndex: number;
  readonly files: readonly {
    readonly content: string;
    readonly language: CodeWorkspaceLanguage;
    readonly name: string;
  }[];
  readonly stdin: string;
}

export interface CodeWorkspaceUsage {
  readonly fileCount: number;
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly totalBytes: number;
}

export interface CodeWorkspaceAuthorityOptions {
  /** Read-only (`view`) clients never write, not even a rollback. */
  readOnly?: boolean;
  newFileId?: () => string;
}

const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const BOOTSTRAP_ORIGIN = Object.freeze({ kind: "code-workspace-bootstrap" });
/**
 * Large text is written in several transactions so no single provider update
 * exceeds the runtime's 32 KiB `code.workspace.v1` update budget. 4,096
 * UTF-16 units encode to at most 12 KiB of UTF-8.
 */
const TEXT_CHUNK_UNITS = 4_096;
const GUARD_ORIGIN = Object.freeze({ kind: "code-workspace-guard" });
const encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function isCodeWorkspaceLanguage(
  value: unknown,
): value is CodeWorkspaceLanguage {
  return (
    typeof value === "string" &&
    (CODE_WORKSPACE_LANGUAGES as readonly string[]).includes(value)
  );
}

export function isValidCodeWorkspaceFileName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    CODE_WORKSPACE_FILE_NAME_PATTERN.test(name) &&
    !/^\.+$/u.test(name)
  );
}

type FileEntry = Y.Map<unknown>;

interface InsertedRange {
  index: number;
  length: number;
}

export class CanonicalCodeWorkspaceAuthority {
  private readonly localOrigin: Readonly<{
    actorId: string;
    kind: "code-workspace-local";
  }>;
  private readonly meta: Y.Map<unknown>;
  private readonly files: Y.Map<unknown>;
  private readonly readOnly: boolean;
  private readonly newFileId: () => string;
  private readonly undoManagers = new Map<string, Y.UndoManager>();
  private readonly violationListeners = new Set<
    (code: CodeWorkspaceErrorCode) => void
  >();
  private violationCode: CodeWorkspaceErrorCode | null = null;
  private destroyed = false;

  constructor(
    private readonly document: Y.Doc,
    readonly scope: CodeWorkspaceAuthorityScope,
    readonly actorId: string,
    options: CodeWorkspaceAuthorityOptions = {},
  ) {
    validateScope(scope);
    if (!FILE_ID_PATTERN.test(actorId) && !isUuid(actorId)) {
      throw new CodeWorkspaceAuthorityError("authority_scope_invalid");
    }
    this.localOrigin = Object.freeze({ actorId, kind: "code-workspace-local" });
    this.meta = document.getMap<unknown>("meta");
    this.files = document.getMap<unknown>("files");
    this.readOnly = options.readOnly === true;
    this.newFileId = options.newFileId ?? defaultFileId;
    this.files.observeDeep(this.handleDeepChange);
    this.meta.observe(this.handleMetaChange);
    if (this.isInitialized()) this.refreshViolation();
  }

  isInitialized(): boolean {
    return this.meta.has("schemaVersion");
  }

  initialize(
    files: readonly CodeWorkspaceFileInput[],
    activeIndex = 0,
  ): string[] {
    this.assertWritable();
    if (this.isInitialized()) {
      throw new CodeWorkspaceAuthorityError("authority_already_initialized");
    }
    if (files.length < 1 || files.length > CODE_WORKSPACE_LIMITS.maxFiles) {
      throw new CodeWorkspaceAuthorityError("file_limit");
    }
    const names = new Set<string>();
    let total = 0;
    for (const file of files) {
      validateFileInput(file);
      const folded = file.name.toLowerCase();
      if (names.has(folded)) {
        throw new CodeWorkspaceAuthorityError("file_duplicate_name");
      }
      names.add(folded);
      total += utf8ByteLength(file.content);
    }
    if (total > CODE_WORKSPACE_LIMITS.maxTotalBytes) {
      throw new CodeWorkspaceAuthorityError("workspace_too_large");
    }
    const ids = files.map(() => this.allocateFileId());
    const active = ids[Math.min(Math.max(0, activeIndex), ids.length - 1)];
    this.document.transact(() => {
      files.forEach((file, index) => {
        this.files.set(
          ids[index] as string,
          createFileEntry(ids[index] as string, file, index),
        );
      });
      this.meta.set("activeFileId", active);
      this.meta.set("schemaVersion", CODE_WORKSPACE_SCHEMA_VERSION);
    }, BOOTSTRAP_ORIGIN);
    files.forEach((file, index) => {
      this.appendChunks(
        this.text(ids[index] as string),
        file.content,
        BOOTSTRAP_ORIGIN,
      );
    });
    this.refreshViolation();
    return ids;
  }

  listFiles(): CodeWorkspaceFileView[] {
    this.assertInitialized();
    return sortedEntries(this.files).map(([id, entry]) => {
      const text = entry.get("text");
      return {
        bytes: text instanceof Y.Text ? utf8ByteLength(text.toString()) : 0,
        id,
        language: entry.get("language") as CodeWorkspaceLanguage,
        name: entry.get("name") as string,
        order: entry.get("order") as number,
      };
    });
  }

  activeFileId(): string | null {
    const value = this.meta.get("activeFileId");
    return typeof value === "string" && this.files.has(value) ? value : null;
  }

  presenterFileId(): string | null {
    const value = this.meta.get("presenterFileId");
    return typeof value === "string" && this.files.has(value) ? value : null;
  }

  setActiveFile(fileId: string): void {
    this.requireFile(fileId);
    this.runLocal(() => this.meta.set("activeFileId", fileId));
  }

  /** The presenter's current file, which followers may track (02B). */
  setPresenterFile(fileId: string | null): void {
    if (fileId !== null) this.requireFile(fileId);
    this.runLocal(() => {
      if (fileId === null) this.meta.delete("presenterFileId");
      else this.meta.set("presenterFileId", fileId);
    });
  }

  addFile(input: CodeWorkspaceFileInput): string {
    this.assertInitialized();
    this.assertWritable();
    validateFileInput(input);
    const entries = sortedEntries(this.files);
    if (entries.length >= CODE_WORKSPACE_LIMITS.maxFiles) {
      throw new CodeWorkspaceAuthorityError("file_limit");
    }
    this.assertUniqueName(input.name, null);
    if (
      this.usage().totalBytes + utf8ByteLength(input.content) >
      CODE_WORKSPACE_LIMITS.maxTotalBytes
    ) {
      throw new CodeWorkspaceAuthorityError("workspace_too_large");
    }
    const id = this.allocateFileId();
    const order =
      entries.reduce(
        (highest, [, entry]) => Math.max(highest, entry.get("order") as number),
        -1,
      ) + 1;
    this.runLocal(() => this.files.set(id, createFileEntry(id, input, order)));
    this.appendChunks(this.text(id), input.content, this.localOrigin);
    return id;
  }

  renameFile(fileId: string, name: string): void {
    const entry = this.requireFile(fileId);
    if (!isValidCodeWorkspaceFileName(name)) {
      throw new CodeWorkspaceAuthorityError("file_name_invalid");
    }
    this.assertUniqueName(name, fileId);
    this.runLocal(() => entry.set("name", name));
  }

  setFileLanguage(fileId: string, language: CodeWorkspaceLanguage): void {
    const entry = this.requireFile(fileId);
    if (!isCodeWorkspaceLanguage(language)) {
      throw new CodeWorkspaceAuthorityError("file_language_unsupported");
    }
    this.runLocal(() => entry.set("language", language));
  }

  deleteFile(fileId: string): void {
    this.requireFile(fileId);
    if (this.files.size <= 1) {
      throw new CodeWorkspaceAuthorityError("file_last");
    }
    this.runLocal(() => {
      this.files.delete(fileId);
      const remaining = sortedEntries(this.files)[0]?.[0];
      if (this.meta.get("activeFileId") === fileId && remaining) {
        this.meta.set("activeFileId", remaining);
      }
      if (this.meta.get("presenterFileId") === fileId) {
        this.meta.delete("presenterFileId");
      }
    });
    this.undoManagers.get(fileId)?.destroy();
    this.undoManagers.delete(fileId);
  }

  /** Replaces one file's text (for example "Restore template"). */
  replaceFileText(fileId: string, content: string): void {
    const text = this.text(fileId);
    const bytes = utf8ByteLength(content);
    if (bytes > CODE_WORKSPACE_LIMITS.maxFileBytes) {
      throw new CodeWorkspaceAuthorityError("file_too_large");
    }
    const current = utf8ByteLength(text.toString());
    if (
      this.usage().totalBytes - current + bytes >
      CODE_WORKSPACE_LIMITS.maxTotalBytes
    ) {
      throw new CodeWorkspaceAuthorityError("workspace_too_large");
    }
    this.assertWritable();
    this.runLocal(() => text.delete(0, text.length));
    this.appendChunks(text, content, this.localOrigin);
  }

  /** The live Y.Text an editor binding (y-codemirror.next) attaches to. */
  text(fileId: string): Y.Text {
    const text = this.requireFile(fileId).get("text");
    if (!(text instanceof Y.Text)) {
      throw new CodeWorkspaceAuthorityError("workspace_corrupt");
    }
    return text;
  }

  /**
   * Actor-local undo for one file. Only this actor's authority origin is
   * tracked up front; an editor binding adds its own origin, so remote edits
   * are never undone and there is no second (CodeMirror) history.
   */
  undoManager(fileId: string): Y.UndoManager {
    const existing = this.undoManagers.get(fileId);
    if (existing) return existing;
    const manager = new Y.UndoManager(this.text(fileId), {
      captureTimeout: 500,
      trackedOrigins: new Set<unknown>([this.localOrigin]),
    });
    this.undoManagers.set(fileId, manager);
    return manager;
  }

  usage(): CodeWorkspaceUsage {
    let totalBytes = 0;
    for (const [, entry] of this.files.entries()) {
      const text = entry instanceof Y.Map ? entry.get("text") : undefined;
      if (text instanceof Y.Text) totalBytes += utf8ByteLength(text.toString());
    }
    return {
      fileCount: this.files.size,
      maxFileBytes: CODE_WORKSPACE_LIMITS.maxFileBytes,
      maxFiles: CODE_WORKSPACE_LIMITS.maxFiles,
      maxTotalBytes: CODE_WORKSPACE_LIMITS.maxTotalBytes,
      totalBytes,
    };
  }

  /**
   * Pre-check for an editor change filter: whether replacing `removedBytes`
   * with `insertedBytes` in one file keeps every cap.
   */
  allowsTextChange(
    fileId: string,
    removedBytes: number,
    insertedBytes: number,
  ): boolean {
    if (
      this.readOnly ||
      this.violationCode !== null ||
      !Number.isSafeInteger(removedBytes) ||
      !Number.isSafeInteger(insertedBytes) ||
      removedBytes < 0 ||
      insertedBytes < 0
    ) {
      return false;
    }
    const current = utf8ByteLength(this.text(fileId).toString());
    const delta = insertedBytes - removedBytes;
    return (
      current + delta <= CODE_WORKSPACE_LIMITS.maxFileBytes &&
      this.usage().totalBytes + delta <= CODE_WORKSPACE_LIMITS.maxTotalBytes
    );
  }

  /** A clean, validated copy for "Fork to personal draft". */
  snapshot(): CodeWorkspaceSnapshot {
    this.assertInitialized();
    const problem = validateWorkspace(this.meta, this.files);
    if (problem) throw new CodeWorkspaceAuthorityError(problem);
    const entries = sortedEntries(this.files);
    const active = this.activeFileId();
    const activeIndex = Math.max(
      0,
      entries.findIndex(([id]) => id === active),
    );
    return Object.freeze({
      activeIndex,
      files: Object.freeze(
        entries.map(([, entry]) =>
          Object.freeze({
            content: (entry.get("text") as Y.Text).toString(),
            language: entry.get("language") as CodeWorkspaceLanguage,
            name: entry.get("name") as string,
          }),
        ),
      ),
      stdin: "",
    });
  }

  violation(): CodeWorkspaceErrorCode | null {
    return this.violationCode;
  }

  onViolation(listener: (code: CodeWorkspaceErrorCode) => void): () => void {
    this.violationListeners.add(listener);
    return () => this.violationListeners.delete(listener);
  }

  subscribe(listener: () => void): () => void {
    const handleUpdate = () => listener();
    this.document.on("update", handleUpdate);
    return () => this.document.off("update", handleUpdate);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.files.unobserveDeep(this.handleDeepChange);
    this.meta.unobserve(this.handleMetaChange);
    for (const manager of this.undoManagers.values()) manager.destroy();
    this.undoManagers.clear();
    this.violationListeners.clear();
  }

  private readonly handleMetaChange = (
    _event: Y.YMapEvent<unknown>,
    transaction: Y.Transaction,
  ): void => {
    if (transaction.origin === GUARD_ORIGIN) return;
    if (this.isInitialized()) this.refreshViolation();
  };

  /**
   * Fail-closed guard. It runs after every transaction that touches files;
   * inserted text and added files that break a cap are rolled back in a
   * follow-up guard transaction (Yjs queues it after the current cleanup).
   */
  private readonly handleDeepChange = (
    events: Array<Y.YEvent<Y.AbstractType<unknown>>>,
    transaction: Y.Transaction,
  ): void => {
    if (transaction.origin === GUARD_ORIGIN || !this.isInitialized()) return;
    const inserted = new Map<Y.Text, InsertedRange[]>();
    const addedFiles: string[] = [];
    for (const event of events) {
      if (event instanceof Y.YTextEvent) {
        const ranges: InsertedRange[] = [];
        let index = 0;
        for (const operation of event.delta) {
          if (typeof operation.retain === "number") index += operation.retain;
          if (typeof operation.insert === "string") {
            ranges.push({ index, length: operation.insert.length });
            index += operation.insert.length;
          }
        }
        if (ranges.length > 0) inserted.set(event.target as Y.Text, ranges);
      } else if (event.target === this.files && event instanceof Y.YMapEvent) {
        for (const [key, change] of event.changes.keys) {
          if (change.action === "add") addedFiles.push(key);
        }
      }
    }
    if (validateWorkspace(this.meta, this.files) === null) {
      this.setViolation(null);
      return;
    }
    if (this.readOnly) {
      this.refreshViolation();
      return;
    }
    this.document.transact(() => {
      this.rollbackAddedFiles(addedFiles);
      this.rollbackOversizedText(inserted);
    }, GUARD_ORIGIN);
    this.refreshViolation();
  };

  private rollbackAddedFiles(addedFiles: readonly string[]): void {
    const added = new Set(addedFiles);
    const names = new Set<string>();
    for (const [id, entry] of sortedEntries(this.files)) {
      if (!added.has(id)) {
        const name = entry.get("name");
        if (typeof name === "string") names.add(name.toLowerCase());
      }
    }
    let kept = this.files.size - added.size;
    for (const id of [...added].sort()) {
      const entry = this.files.get(id);
      const name = entry instanceof Y.Map ? entry.get("name") : undefined;
      const valid =
        entry instanceof Y.Map &&
        validateEntry(id, entry) === null &&
        typeof name === "string" &&
        !names.has(name.toLowerCase()) &&
        kept < CODE_WORKSPACE_LIMITS.maxFiles;
      if (valid) {
        names.add((name as string).toLowerCase());
        kept += 1;
      } else {
        this.files.delete(id);
      }
    }
  }

  private rollbackOversizedText(inserted: Map<Y.Text, InsertedRange[]>): void {
    const overTotal =
      this.usage().totalBytes > CODE_WORKSPACE_LIMITS.maxTotalBytes;
    for (const [text, ranges] of inserted) {
      if (text.doc !== this.document) continue;
      const overFile =
        utf8ByteLength(text.toString()) > CODE_WORKSPACE_LIMITS.maxFileBytes;
      if (!overFile && !overTotal) continue;
      for (const range of [...ranges].sort((a, b) => b.index - a.index)) {
        if (range.index + range.length <= text.length) {
          text.delete(range.index, range.length);
        }
      }
    }
  }

  private appendChunks(text: Y.Text, content: string, origin: object): void {
    for (const chunk of textChunks(content)) {
      this.document.transact(() => text.insert(text.length, chunk), origin);
    }
  }

  private refreshViolation(): void {
    this.setViolation(validateWorkspace(this.meta, this.files));
  }

  private setViolation(code: CodeWorkspaceErrorCode | null): void {
    if (this.violationCode === code) return;
    this.violationCode = code;
    if (code === null) return;
    for (const listener of this.violationListeners) listener(code);
  }

  private assertUniqueName(name: string, ignoreId: string | null): void {
    const folded = name.toLowerCase();
    for (const [id, entry] of this.files.entries()) {
      if (id === ignoreId) continue;
      const other = entry instanceof Y.Map ? entry.get("name") : undefined;
      if (typeof other === "string" && other.toLowerCase() === folded) {
        throw new CodeWorkspaceAuthorityError("file_duplicate_name");
      }
    }
  }

  private requireFile(fileId: string): FileEntry {
    this.assertInitialized();
    const entry = this.files.get(fileId);
    if (!(entry instanceof Y.Map)) {
      throw new CodeWorkspaceAuthorityError("file_not_found");
    }
    return entry;
  }

  private allocateFileId(): string {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const id = this.newFileId();
      if (FILE_ID_PATTERN.test(id) && !this.files.has(id)) return id;
    }
    throw new CodeWorkspaceAuthorityError("file_invalid");
  }

  private runLocal(callback: () => void): void {
    this.assertWritable();
    if (this.violationCode !== null) {
      throw new CodeWorkspaceAuthorityError(this.violationCode);
    }
    this.document.transact(callback, this.localOrigin);
  }

  private assertWritable(): void {
    if (this.readOnly) {
      throw new CodeWorkspaceAuthorityError("authority_read_only");
    }
  }

  private assertInitialized(): void {
    if (!this.isInitialized()) {
      throw new CodeWorkspaceAuthorityError("authority_not_initialized");
    }
    if (this.meta.get("schemaVersion") !== CODE_WORKSPACE_SCHEMA_VERSION) {
      throw new CodeWorkspaceAuthorityError("workspace_schema_unsupported");
    }
  }
}

/** `null` when the stored workspace satisfies every `code.workspace.v1` cap. */
export function validateWorkspace(
  meta: Y.Map<unknown>,
  files: Y.Map<unknown>,
): CodeWorkspaceErrorCode | null {
  if (meta.get("schemaVersion") !== CODE_WORKSPACE_SCHEMA_VERSION) {
    return "workspace_schema_unsupported";
  }
  if (files.size < 1 || files.size > CODE_WORKSPACE_LIMITS.maxFiles) {
    return "file_limit";
  }
  const names = new Set<string>();
  let total = 0;
  for (const [id, entry] of files.entries()) {
    if (!(entry instanceof Y.Map)) return "workspace_corrupt";
    const problem = validateEntry(id, entry);
    if (problem) return problem;
    const folded = (entry.get("name") as string).toLowerCase();
    if (names.has(folded)) return "file_duplicate_name";
    names.add(folded);
    total += utf8ByteLength((entry.get("text") as Y.Text).toString());
  }
  if (total > CODE_WORKSPACE_LIMITS.maxTotalBytes) return "workspace_too_large";
  const presenter = meta.get("presenterFileId");
  if (presenter !== undefined && typeof presenter !== "string") {
    return "workspace_corrupt";
  }
  return null;
}

function validateEntry(
  id: string,
  entry: Y.Map<unknown>,
): CodeWorkspaceErrorCode | null {
  const text = entry.get("text");
  const order = entry.get("order");
  if (
    !FILE_ID_PATTERN.test(id) ||
    entry.get("id") !== id ||
    !(text instanceof Y.Text) ||
    !Number.isSafeInteger(order) ||
    (order as number) < 0
  ) {
    return "workspace_corrupt";
  }
  if (!isValidCodeWorkspaceFileName(entry.get("name"))) {
    return "file_name_invalid";
  }
  if (!isCodeWorkspaceLanguage(entry.get("language"))) {
    return "file_language_unsupported";
  }
  if (utf8ByteLength(text.toString()) > CODE_WORKSPACE_LIMITS.maxFileBytes) {
    return "file_too_large";
  }
  return null;
}

function validateFileInput(file: CodeWorkspaceFileInput): void {
  if (
    typeof file !== "object" ||
    file === null ||
    typeof file.content !== "string"
  ) {
    throw new CodeWorkspaceAuthorityError("file_invalid");
  }
  if (!isValidCodeWorkspaceFileName(file.name)) {
    throw new CodeWorkspaceAuthorityError("file_name_invalid");
  }
  if (!isCodeWorkspaceLanguage(file.language)) {
    throw new CodeWorkspaceAuthorityError("file_language_unsupported");
  }
  if (utf8ByteLength(file.content) > CODE_WORKSPACE_LIMITS.maxFileBytes) {
    throw new CodeWorkspaceAuthorityError("file_too_large");
  }
}

/** Splits text into bounded chunks without breaking a UTF-16 surrogate pair. */
export function textChunks(content: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < content.length) {
    let end = Math.min(content.length, start + TEXT_CHUNK_UNITS);
    const last = content.charCodeAt(end - 1);
    if (end < content.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(content.slice(start, end));
    start = end;
  }
  return chunks;
}

/** Text is appended afterwards in bounded chunks (`appendChunks`). */
function createFileEntry(
  id: string,
  file: CodeWorkspaceFileInput,
  order: number,
): FileEntry {
  const entry = new Y.Map<unknown>();
  const text = new Y.Text();
  entry.set("id", id);
  entry.set("name", file.name);
  entry.set("language", file.language);
  entry.set("order", order);
  entry.set("text", text);
  return entry;
}

function sortedEntries(files: Y.Map<unknown>): Array<[string, FileEntry]> {
  return [...files.entries()]
    .filter((pair): pair is [string, FileEntry] => pair[1] instanceof Y.Map)
    .sort(([leftId, left], [rightId, right]) => {
      const leftOrder = Number(left.get("order"));
      const rightOrder = Number(right.get("order"));
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
}

function validateScope(scope: CodeWorkspaceAuthorityScope): void {
  if (
    !isUuid(scope.documentId) ||
    typeof scope.tenantId !== "string" ||
    scope.tenantId.length < 1 ||
    scope.tenantId.length > 128 ||
    !Number.isSafeInteger(scope.generation) ||
    scope.generation < 1
  ) {
    throw new CodeWorkspaceAuthorityError("authority_scope_invalid");
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function defaultFileId(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}
