import * as Y from "yjs";

/**
 * ROOM-TOOLS-FILES-02A (ADR-0045 §4 Slice 2): the single canonical client
 * authority for a `pdf.annotations.v1` Yjs document.
 *
 * Y.Doc
 * ├─ meta:  Y.Map { schemaVersion: 1, fileId, versionId, pageCount 1..300,
 * │                 presenterPage 1..pageCount, followLock, hiddenPages }
 * └─ pages: Y.Map<"p:1".."p:N", Y.Map<strokeId, string>>
 *
 * Page maps are created once at initialization so two peers never race to
 * create the same page map (Yjs map keys are last-writer-wins). Each stroke is
 * one compact, deterministic string:
 *
 *   "1|<pen|highlighter>|<tone 0..7>|<s|m|l>|<actorId>|<base64url points>"
 *
 * Points are page-normalized `[0..1]` coordinates (pdf.js viewport at
 * rotation 0, scale 1) quantized to uint16 `0..65535`: the first point is two
 * little-endian uint16 values, every following point a zig-zag varint delta.
 * Coordinates therefore survive any zoom, rotation or screen size.
 *
 * Bounds are enforced fail-closed before writing (≤ 2,000 points per stroke,
 * ≤ 400 strokes per page, ≤ 2,000 strokes per document, every transaction well
 * below the runtime's 32 KiB update ceiling and the whole stroke set below its
 * 1 MiB document ceiling). A `view` client never emits a transaction. Peers'
 * malformed strokes are ignored on read and reported as a violation.
 */
export const PDF_ANNOTATIONS_SCHEMA_VERSION = 1 as const;

export const PDF_ANNOTATION_LIMITS = Object.freeze({
  maxDocumentStrokeBytes: 960 * 1024,
  maxPages: 300,
  maxPointsPerStroke: 2_000,
  maxStrokeBytes: 24 * 1024,
  maxStrokesPerDocument: 2_000,
  maxStrokesPerPage: 400,
  maxTransactionBytes: 24 * 1024,
  maxVersionIdLength: 512,
  tones: 8,
});

/** Default Ramer–Douglas–Peucker tolerance in page-normalized units. */
export const PDF_STROKE_SIMPLIFY_EPSILON = 0.0005;

export const PDF_ANNOTATION_TOOLS = ["pen", "highlighter"] as const;
export const PDF_ANNOTATION_WIDTHS = ["s", "m", "l"] as const;

export type PdfAnnotationTool = (typeof PDF_ANNOTATION_TOOLS)[number];
export type PdfAnnotationWidth = (typeof PDF_ANNOTATION_WIDTHS)[number];
export type PdfAnnotationCapability = "view" | "edit" | "present";

export type PdfAnnotationErrorCode =
  | "annotations_corrupt"
  | "annotations_schema_unsupported"
  | "authority_already_initialized"
  | "authority_not_initialized"
  | "authority_not_presenter"
  | "authority_read_only"
  | "authority_scope_invalid"
  | "binding_invalid"
  | "document_mismatch"
  | "document_stroke_limit"
  | "document_too_large"
  | "page_invalid"
  | "page_stroke_limit"
  | "stroke_invalid"
  | "stroke_not_found"
  | "stroke_not_owned"
  | "stroke_too_large";

export class PdfAnnotationAuthorityError extends Error {
  constructor(readonly code: PdfAnnotationErrorCode) {
    super(code);
    this.name = "PdfAnnotationAuthorityError";
  }
}

export interface PdfAnnotationAuthorityScope {
  documentId: string;
  generation: number;
  tenantId: string;
}

/** The presented room document this annotation layer is bound to. */
export interface PdfAnnotationBinding {
  fileId: string;
  pageCount: number;
  versionId: string;
}

export interface PdfAnnotationPoint {
  readonly x: number;
  readonly y: number;
}

export interface PdfStrokeInput {
  points: readonly PdfAnnotationPoint[];
  tone: number;
  tool: PdfAnnotationTool;
  width: PdfAnnotationWidth;
}

export interface PdfStroke {
  readonly actorId: string;
  readonly id: string;
  readonly page: number;
  /** Dequantized page-normalized points. */
  readonly points: readonly PdfAnnotationPoint[];
  readonly tone: number;
  readonly tool: PdfAnnotationTool;
  readonly width: PdfAnnotationWidth;
}

export interface PdfAnnotationMeta {
  readonly followLock: boolean;
  readonly hiddenPages: readonly number[];
  readonly pageCount: number;
  readonly presenterPage: number;
}

export interface PdfAnnotationAuthorityOptions {
  capability: PdfAnnotationCapability;
  newStrokeId?: () => string;
}

interface DecodedStroke {
  actorId: string;
  points: Array<[number, number]>;
  tone: number;
  tool: PdfAnnotationTool;
  width: PdfAnnotationWidth;
}

const STROKE_ID_PATTERN = /^[A-Za-z0-9_-]{8,40}$/;
const ACTOR_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const QUANTUM = 65_535;
const BOOTSTRAP_ORIGIN = Object.freeze({ kind: "pdf-annotations-bootstrap" });

export function pageKey(page: number): string {
  return `p:${page}`;
}

/** Page-normalized `[0..1]` → uint16 `0..65535` (clamped, rounded). */
export function quantizeCoordinate(value: number): number {
  if (!Number.isFinite(value)) {
    throw new PdfAnnotationAuthorityError("stroke_invalid");
  }
  return Math.round(Math.min(1, Math.max(0, value)) * QUANTUM);
}

export function dequantizeCoordinate(value: number): number {
  return value / QUANTUM;
}

/**
 * Ramer–Douglas–Peucker simplification (iterative, no recursion) in
 * page-normalized space. The tolerance doubles until the stroke fits
 * `maxPoints`; endpoints are always kept.
 */
export function simplifyStroke(
  points: readonly PdfAnnotationPoint[],
  epsilon = PDF_STROKE_SIMPLIFY_EPSILON,
  maxPoints = PDF_ANNOTATION_LIMITS.maxPointsPerStroke,
): PdfAnnotationPoint[] {
  const clean = points.filter(
    (point) => Number.isFinite(point.x) && Number.isFinite(point.y),
  );
  if (clean.length !== points.length || clean.length === 0) {
    throw new PdfAnnotationAuthorityError("stroke_invalid");
  }
  if (clean.length <= 2) return clean.map((point) => ({ ...point }));
  let tolerance = Math.max(epsilon, 0);
  let simplified = rdp(clean, tolerance);
  for (
    let attempt = 0;
    simplified.length > maxPoints && attempt < 24;
    attempt += 1
  ) {
    tolerance = tolerance > 0 ? tolerance * 2 : 0.0001;
    simplified = rdp(clean, tolerance);
  }
  if (simplified.length > maxPoints) {
    const step = (simplified.length - 1) / (maxPoints - 1);
    simplified = Array.from(
      { length: maxPoints },
      (_, index) => simplified[Math.round(index * step)] as PdfAnnotationPoint,
    );
  }
  return simplified;
}

function rdp(
  points: readonly PdfAnnotationPoint[],
  epsilon: number,
): PdfAnnotationPoint[] {
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop() as [number, number];
    let maxDistance = -1;
    let index = -1;
    for (let candidate = start + 1; candidate < end; candidate += 1) {
      const distance = perpendicularDistance(
        points[candidate] as PdfAnnotationPoint,
        points[start] as PdfAnnotationPoint,
        points[end] as PdfAnnotationPoint,
      );
      if (distance > maxDistance) {
        maxDistance = distance;
        index = candidate;
      }
    }
    if (index > 0 && maxDistance > epsilon) {
      keep[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }
  return points.filter((_, index) => keep[index] === 1);
}

function perpendicularDistance(
  point: PdfAnnotationPoint,
  start: PdfAnnotationPoint,
  end: PdfAnnotationPoint,
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  return (
    Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) /
    length
  );
}

/** Deterministic compact encoding of one validated stroke. */
export function encodeStroke(stroke: DecodedStroke): string {
  if (
    !isTool(stroke.tool) ||
    !isWidth(stroke.width) ||
    !isTone(stroke.tone) ||
    !isActorId(stroke.actorId) ||
    stroke.points.length < 1 ||
    stroke.points.length > PDF_ANNOTATION_LIMITS.maxPointsPerStroke
  ) {
    throw new PdfAnnotationAuthorityError("stroke_invalid");
  }
  const bytes: number[] = [];
  const [first, ...rest] = stroke.points as [
    [number, number],
    ...Array<[number, number]>,
  ];
  pushUint16(bytes, first[0]);
  pushUint16(bytes, first[1]);
  let [previousX, previousY] = first;
  for (const [x, y] of rest) {
    if (!isQuantized(x) || !isQuantized(y)) {
      throw new PdfAnnotationAuthorityError("stroke_invalid");
    }
    pushVarint(bytes, zigzag(x - previousX));
    pushVarint(bytes, zigzag(y - previousY));
    previousX = x;
    previousY = y;
  }
  return [
    PDF_ANNOTATIONS_SCHEMA_VERSION,
    stroke.tool,
    stroke.tone,
    stroke.width,
    stroke.actorId,
    base64UrlEncode(Uint8Array.from(bytes)),
  ].join("|");
}

/** Strict decoder; any malformed or out-of-bound stroke yields `null`. */
export function decodeStroke(value: unknown): DecodedStroke | null {
  if (
    typeof value !== "string" ||
    value.length < 12 ||
    value.length > PDF_ANNOTATION_LIMITS.maxStrokeBytes
  ) {
    return null;
  }
  const parts = value.split("|");
  if (
    parts.length !== 6 ||
    parts[0] !== String(PDF_ANNOTATIONS_SCHEMA_VERSION)
  ) {
    return null;
  }
  const [, tool, toneText, width, actorId, encoded] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const tone = /^[0-7]$/.test(toneText) ? Number(toneText) : -1;
  if (
    !isTool(tool) ||
    !isWidth(width) ||
    !isTone(tone) ||
    !isActorId(actorId)
  ) {
    return null;
  }
  const bytes = base64UrlDecode(encoded);
  if (!bytes || bytes.length < 4) return null;
  let offset = 4;
  let x = (bytes[0] as number) | ((bytes[1] as number) << 8);
  let y = (bytes[2] as number) | ((bytes[3] as number) << 8);
  const points: Array<[number, number]> = [[x, y]];
  while (offset < bytes.length) {
    const dx = readVarint(bytes, offset);
    if (!dx) return null;
    const dy = readVarint(bytes, dx.next);
    if (!dy) return null;
    offset = dy.next;
    x += unzigzag(dx.value);
    y += unzigzag(dy.value);
    if (!isQuantized(x) || !isQuantized(y)) return null;
    points.push([x, y]);
    if (points.length > PDF_ANNOTATION_LIMITS.maxPointsPerStroke) return null;
  }
  return { actorId, points, tone, tool, width };
}

/**
 * Presenter laser/viewport presence is trusted only when the runtime stamped
 * the sender's server capability as `present` (`tutorhub.capability`).
 */
export function isTrustedPresenterAwareness(state: unknown): boolean {
  if (typeof state !== "object" || state === null) return false;
  const marker = (state as { tutorhub?: unknown }).tutorhub;
  return (
    typeof marker === "object" &&
    marker !== null &&
    (marker as { capability?: unknown }).capability === "present"
  );
}

export class CanonicalPdfAnnotationAuthority {
  readonly capability: PdfAnnotationCapability;
  private readonly localOrigin: Readonly<{
    actorId: string;
    kind: "pdf-annotations-local";
  }>;
  private readonly meta: Y.Map<unknown>;
  private readonly pages: Y.Map<unknown>;
  private readonly newStrokeId: () => string;
  private readonly undo: Y.UndoManager;
  private readonly violationListeners = new Set<
    (code: PdfAnnotationErrorCode) => void
  >();
  private violationCode: PdfAnnotationErrorCode | null = null;
  private destroyed = false;

  constructor(
    private readonly document: Y.Doc,
    readonly scope: PdfAnnotationAuthorityScope,
    readonly actorId: string,
    options: PdfAnnotationAuthorityOptions,
  ) {
    validateScope(scope);
    if (!isActorId(actorId)) {
      throw new PdfAnnotationAuthorityError("authority_scope_invalid");
    }
    if (!["view", "edit", "present"].includes(options.capability)) {
      throw new PdfAnnotationAuthorityError("authority_scope_invalid");
    }
    this.capability = options.capability;
    this.localOrigin = Object.freeze({
      actorId,
      kind: "pdf-annotations-local",
    });
    this.meta = document.getMap<unknown>("meta");
    this.pages = document.getMap<unknown>("pages");
    this.newStrokeId = options.newStrokeId ?? defaultStrokeId;
    // Actor-isolated history: only this actor's own transactions are
    // tracked, so undo/redo never touches a peer's strokes.
    this.undo = new Y.UndoManager(this.pages, {
      captureTimeout: 0,
      trackedOrigins: new Set<unknown>([this.localOrigin]),
    });
    this.pages.observeDeep(this.handleChange);
    this.meta.observe(this.handleChange);
    if (this.isInitialized()) this.refreshViolation();
  }

  isInitialized(): boolean {
    return this.meta.has("schemaVersion");
  }

  /** Creates the canonical meta and every page map (presenter only). */
  initialize(binding: PdfAnnotationBinding): void {
    this.assertPresenter();
    if (this.isInitialized()) {
      throw new PdfAnnotationAuthorityError("authority_already_initialized");
    }
    validateBinding(binding);
    this.document.transact(() => {
      this.meta.set("fileId", binding.fileId);
      this.meta.set("versionId", binding.versionId);
      this.meta.set("pageCount", binding.pageCount);
      this.meta.set("presenterPage", 1);
      this.meta.set("followLock", false);
      this.meta.set("hiddenPages", []);
      for (let page = 1; page <= binding.pageCount; page += 1) {
        this.pages.set(pageKey(page), new Y.Map<string>());
      }
      this.meta.set("schemaVersion", PDF_ANNOTATIONS_SCHEMA_VERSION);
    }, BOOTSTRAP_ORIGIN);
  }

  /** The document this layer was initialized for, or null before init. */
  binding(): PdfAnnotationBinding | null {
    if (!this.isInitialized()) return null;
    const fileId = this.meta.get("fileId");
    const versionId = this.meta.get("versionId");
    const pageCount = this.meta.get("pageCount");
    if (
      typeof fileId !== "string" ||
      typeof versionId !== "string" ||
      typeof pageCount !== "number"
    ) {
      return null;
    }
    return { fileId, pageCount, versionId };
  }

  /** Throws `document_mismatch` unless bound to the expected document. */
  assertBinding(expected: PdfAnnotationBinding): void {
    const current = this.binding();
    if (
      !current ||
      current.fileId !== expected.fileId ||
      current.versionId !== expected.versionId ||
      current.pageCount !== expected.pageCount
    ) {
      throw new PdfAnnotationAuthorityError("document_mismatch");
    }
  }

  /** Normalized presenter state; out-of-range peer values are clamped. */
  metaState(): PdfAnnotationMeta {
    const pageCount = this.pageCount();
    const rawPage = this.meta.get("presenterPage");
    const presenterPage =
      Number.isSafeInteger(rawPage) &&
      (rawPage as number) >= 1 &&
      (rawPage as number) <= pageCount
        ? (rawPage as number)
        : 1;
    return Object.freeze({
      followLock: this.meta.get("followLock") === true,
      hiddenPages: Object.freeze(
        normalizePages(this.meta.get("hiddenPages"), pageCount),
      ),
      pageCount,
      presenterPage,
    });
  }

  setPresenterPage(page: number): void {
    this.assertPresenter();
    this.assertPage(page);
    this.runLocal(() => this.meta.set("presenterPage", page), false);
  }

  setFollowLock(locked: boolean): void {
    this.assertPresenter();
    this.runLocal(() => this.meta.set("followLock", locked === true), false);
  }

  setHiddenPages(pages: readonly number[]): void {
    this.assertPresenter();
    for (const page of pages) this.assertPage(page);
    this.runLocal(
      () =>
        this.meta.set("hiddenPages", normalizePages(pages, this.pageCount())),
      false,
    );
  }

  /** Adds one stroke in its own transaction (< 24 KiB) and returns its id. */
  addStroke(page: number, input: PdfStrokeInput): string {
    return this.addStrokes(page, [input])[0] as string;
  }

  /**
   * Adds several strokes (e.g. a pointerup batch), split into transactions
   * that each stay below the runtime's 32 KiB update ceiling.
   */
  addStrokes(page: number, inputs: readonly PdfStrokeInput[]): string[] {
    this.assertWritable();
    this.assertPage(page);
    const target = this.pageMap(page);
    const encoded = inputs.map((input) => {
      const value = encodeStroke(this.prepareStroke(input));
      if (value.length > PDF_ANNOTATION_LIMITS.maxStrokeBytes) {
        throw new PdfAnnotationAuthorityError("stroke_too_large");
      }
      return value;
    });
    const usage = this.usage();
    if (
      validStrokeCount(target) + encoded.length >
      PDF_ANNOTATION_LIMITS.maxStrokesPerPage
    ) {
      throw new PdfAnnotationAuthorityError("page_stroke_limit");
    }
    if (
      usage.strokes + encoded.length >
      PDF_ANNOTATION_LIMITS.maxStrokesPerDocument
    ) {
      throw new PdfAnnotationAuthorityError("document_stroke_limit");
    }
    const addedBytes = encoded.reduce(
      (total, value) => total + value.length,
      0,
    );
    if (
      usage.bytes + addedBytes >
      PDF_ANNOTATION_LIMITS.maxDocumentStrokeBytes
    ) {
      throw new PdfAnnotationAuthorityError("document_too_large");
    }
    const ids = encoded.map(() => this.allocateStrokeId(target));
    let batch: number[] = [];
    let batchBytes = 0;
    const flush = () => {
      if (batch.length === 0) return;
      const indexes = batch;
      this.runLocal(() => {
        for (const index of indexes) {
          target.set(ids[index] as string, encoded[index] as string);
        }
      });
      batch = [];
      batchBytes = 0;
    };
    encoded.forEach((value, index) => {
      const cost = value.length + (ids[index] as string).length + 16;
      if (batchBytes + cost > PDF_ANNOTATION_LIMITS.maxTransactionBytes)
        flush();
      batch.push(index);
      batchBytes += cost;
    });
    flush();
    return ids;
  }

  /** Valid strokes of one page in deterministic (time-ordered id) order. */
  strokes(page: number): PdfStroke[] {
    this.assertPage(page);
    const target = this.pages.get(pageKey(page));
    if (!(target instanceof Y.Map)) return [];
    const strokes: PdfStroke[] = [];
    for (const [id, value] of target.entries()) {
      const decoded = STROKE_ID_PATTERN.test(id) ? decodeStroke(value) : null;
      if (!decoded) continue;
      strokes.push(
        Object.freeze({
          actorId: decoded.actorId,
          id,
          page,
          points: Object.freeze(
            decoded.points.map(([x, y]) =>
              Object.freeze({
                x: dequantizeCoordinate(x),
                y: dequantizeCoordinate(y),
              }),
            ),
          ),
          tone: decoded.tone,
          tool: decoded.tool,
          width: decoded.width,
        }),
      );
    }
    strokes.sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
    return strokes.slice(0, PDF_ANNOTATION_LIMITS.maxStrokesPerPage);
  }

  usage(): { bytes: number; strokes: number } {
    let bytes = 0;
    let strokes = 0;
    for (const [, target] of this.pages.entries()) {
      if (!(target instanceof Y.Map)) continue;
      for (const [id, value] of target.entries()) {
        if (typeof value === "string") bytes += value.length + id.length;
        strokes += 1;
      }
    }
    return { bytes, strokes };
  }

  /** Erases one stroke: own strokes for `edit`, any stroke for `present`. */
  eraseOwnStroke(page: number, strokeId: string): void {
    this.assertWritable();
    this.assertPage(page);
    const target = this.pageMap(page);
    const value = target.get(strokeId);
    if (value === undefined) {
      throw new PdfAnnotationAuthorityError("stroke_not_found");
    }
    const decoded = decodeStroke(value);
    if (this.capability !== "present" && decoded?.actorId !== this.actorId) {
      throw new PdfAnnotationAuthorityError("stroke_not_owned");
    }
    this.runLocal(() => target.delete(strokeId));
  }

  /** Clears every stroke of one page (presenter only). Returns the count. */
  clearPageStrokes(page: number): number {
    this.assertPresenter();
    this.assertPage(page);
    const target = this.pageMap(page);
    const keys = [...target.keys()];
    if (keys.length > 0) {
      this.runLocal(() => {
        for (const key of keys) target.delete(key);
      });
    }
    return keys.length;
  }

  canUndo(): boolean {
    return this.capability !== "view" && this.undo.canUndo();
  }

  canRedo(): boolean {
    return this.capability !== "view" && this.undo.canRedo();
  }

  /** Undoes this actor's last own operation only. */
  undoLast(): boolean {
    this.assertWritable();
    return this.undo.undo() !== null;
  }

  redoLast(): boolean {
    this.assertWritable();
    return this.undo.redo() !== null;
  }

  violation(): PdfAnnotationErrorCode | null {
    return this.violationCode;
  }

  onViolation(listener: (code: PdfAnnotationErrorCode) => void): () => void {
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
    this.pages.unobserveDeep(this.handleChange);
    this.meta.unobserve(this.handleChange);
    this.undo.destroy();
    this.violationListeners.clear();
  }

  private readonly handleChange = (): void => {
    if (this.isInitialized()) this.refreshViolation();
  };

  private refreshViolation(): void {
    this.setViolation(validateDocument(this.meta, this.pages));
  }

  private setViolation(code: PdfAnnotationErrorCode | null): void {
    if (this.violationCode === code) return;
    this.violationCode = code;
    if (code === null) return;
    for (const listener of this.violationListeners) listener(code);
  }

  private prepareStroke(input: PdfStrokeInput): DecodedStroke {
    if (
      typeof input !== "object" ||
      input === null ||
      !Array.isArray(input.points) ||
      input.points.length < 1 ||
      !isTool(input.tool) ||
      !isWidth(input.width) ||
      !isTone(input.tone)
    ) {
      throw new PdfAnnotationAuthorityError("stroke_invalid");
    }
    const simplified = simplifyStroke(input.points);
    const points: Array<[number, number]> = [];
    for (const point of simplified) {
      const quantized: [number, number] = [
        quantizeCoordinate(point.x),
        quantizeCoordinate(point.y),
      ];
      const previous = points[points.length - 1];
      if (
        !previous ||
        previous[0] !== quantized[0] ||
        previous[1] !== quantized[1]
      ) {
        points.push(quantized);
      }
    }
    return {
      actorId: this.actorId,
      points,
      tone: input.tone,
      tool: input.tool,
      width: input.width,
    };
  }

  private pageCount(): number {
    const value = this.meta.get("pageCount");
    return Number.isSafeInteger(value) &&
      (value as number) >= 1 &&
      (value as number) <= PDF_ANNOTATION_LIMITS.maxPages
      ? (value as number)
      : 0;
  }

  private pageMap(page: number): Y.Map<string> {
    const target = this.pages.get(pageKey(page));
    if (!(target instanceof Y.Map)) {
      throw new PdfAnnotationAuthorityError("annotations_corrupt");
    }
    return target as Y.Map<string>;
  }

  private allocateStrokeId(target: Y.Map<string>): string {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const id = this.newStrokeId();
      if (STROKE_ID_PATTERN.test(id) && !target.has(id)) return id;
    }
    throw new PdfAnnotationAuthorityError("stroke_invalid");
  }

  private runLocal(callback: () => void, tracked = true): void {
    this.assertWritable();
    this.document.transact(
      callback,
      tracked
        ? this.localOrigin
        : Object.freeze({ kind: "pdf-annotations-meta" }),
    );
  }

  private assertPage(page: number): void {
    this.assertInitialized();
    if (!Number.isSafeInteger(page) || page < 1 || page > this.pageCount()) {
      throw new PdfAnnotationAuthorityError("page_invalid");
    }
  }

  private assertInitialized(): void {
    if (!this.isInitialized()) {
      throw new PdfAnnotationAuthorityError("authority_not_initialized");
    }
    if (this.meta.get("schemaVersion") !== PDF_ANNOTATIONS_SCHEMA_VERSION) {
      throw new PdfAnnotationAuthorityError("annotations_schema_unsupported");
    }
  }

  private assertWritable(): void {
    if (this.capability === "view") {
      throw new PdfAnnotationAuthorityError("authority_read_only");
    }
  }

  private assertPresenter(): void {
    this.assertWritable();
    if (this.capability !== "present") {
      throw new PdfAnnotationAuthorityError("authority_not_presenter");
    }
  }
}

function validateDocument(
  meta: Y.Map<unknown>,
  pages: Y.Map<unknown>,
): PdfAnnotationErrorCode | null {
  if (meta.get("schemaVersion") !== PDF_ANNOTATIONS_SCHEMA_VERSION) {
    return "annotations_schema_unsupported";
  }
  const pageCount = meta.get("pageCount");
  if (
    !Number.isSafeInteger(pageCount) ||
    (pageCount as number) < 1 ||
    (pageCount as number) > PDF_ANNOTATION_LIMITS.maxPages
  ) {
    return "annotations_corrupt";
  }
  let total = 0;
  for (const [key, target] of pages.entries()) {
    const match = /^p:(\d{1,3})$/.exec(key);
    const page = match ? Number(match[1]) : 0;
    if (
      !(target instanceof Y.Map) ||
      page < 1 ||
      page > (pageCount as number)
    ) {
      return "annotations_corrupt";
    }
    let count = 0;
    for (const [id, value] of target.entries()) {
      if (!STROKE_ID_PATTERN.test(id) || decodeStroke(value) === null) {
        return "stroke_invalid";
      }
      count += 1;
    }
    if (count > PDF_ANNOTATION_LIMITS.maxStrokesPerPage)
      return "page_stroke_limit";
    total += count;
  }
  if (total > PDF_ANNOTATION_LIMITS.maxStrokesPerDocument)
    return "document_stroke_limit";
  return null;
}

function validStrokeCount(target: Y.Map<string>): number {
  return target.size;
}

function normalizePages(value: unknown, pageCount: number): number[] {
  if (!Array.isArray(value)) return [];
  const pages = new Set<number>();
  for (const page of value) {
    if (Number.isSafeInteger(page) && page >= 1 && page <= pageCount)
      pages.add(page as number);
  }
  return [...pages].sort((left, right) => left - right);
}

function validateBinding(binding: PdfAnnotationBinding): void {
  if (
    typeof binding !== "object" ||
    binding === null ||
    !UUID_PATTERN.test(binding.fileId) ||
    typeof binding.versionId !== "string" ||
    binding.versionId.trim() !== binding.versionId ||
    binding.versionId.length < 1 ||
    binding.versionId.length > PDF_ANNOTATION_LIMITS.maxVersionIdLength ||
    !Number.isSafeInteger(binding.pageCount) ||
    binding.pageCount < 1 ||
    binding.pageCount > PDF_ANNOTATION_LIMITS.maxPages
  ) {
    throw new PdfAnnotationAuthorityError("binding_invalid");
  }
}

function validateScope(scope: PdfAnnotationAuthorityScope): void {
  if (
    !UUID_PATTERN.test(scope.documentId) ||
    typeof scope.tenantId !== "string" ||
    scope.tenantId.length < 1 ||
    scope.tenantId.length > 128 ||
    !Number.isSafeInteger(scope.generation) ||
    scope.generation < 1
  ) {
    throw new PdfAnnotationAuthorityError("authority_scope_invalid");
  }
}

function isTool(value: unknown): value is PdfAnnotationTool {
  return value === "pen" || value === "highlighter";
}

function isWidth(value: unknown): value is PdfAnnotationWidth {
  return value === "s" || value === "m" || value === "l";
}

function isTone(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) < PDF_ANNOTATION_LIMITS.tones
  );
}

function isActorId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (ACTOR_ID_PATTERN.test(value) || UUID_PATTERN.test(value))
  );
}

function isQuantized(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= QUANTUM;
}

function pushUint16(bytes: number[], value: number): void {
  if (!isQuantized(value))
    throw new PdfAnnotationAuthorityError("stroke_invalid");
  bytes.push(value & 0xff, (value >> 8) & 0xff);
}

function zigzag(value: number): number {
  return value >= 0 ? value * 2 : -value * 2 - 1;
}

function unzigzag(value: number): number {
  return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
}

function pushVarint(bytes: number[], value: number): void {
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  bytes.push(remaining);
}

function readVarint(
  bytes: Uint8Array,
  offset: number,
): { next: number; value: number } | null {
  let value = 0;
  let multiplier = 1;
  for (
    let index = offset;
    index < bytes.length && index < offset + 3;
    index += 1
  ) {
    const byte = bytes[index] as number;
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) {
      return value <= QUANTUM * 2 ? { next: index + 1, value } : null;
    }
    multiplier *= 0x80;
  }
  return null;
}

const BASE64_URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64UrlEncode(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] as number;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    output += BASE64_URL_ALPHABET[(triple >> 18) & 63];
    output += BASE64_URL_ALPHABET[(triple >> 12) & 63];
    if (b !== undefined) output += BASE64_URL_ALPHABET[(triple >> 6) & 63];
    if (c !== undefined) output += BASE64_URL_ALPHABET[triple & 63];
  }
  return output;
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null;
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 4) {
    const chunk = value.slice(index, index + 4);
    const sextets = [...chunk].map((char) => BASE64_URL_ALPHABET.indexOf(char));
    const triple =
      ((sextets[0] ?? 0) << 18) |
      ((sextets[1] ?? 0) << 12) |
      ((sextets[2] ?? 0) << 6) |
      (sextets[3] ?? 0);
    bytes.push((triple >> 16) & 0xff);
    if (chunk.length > 2) bytes.push((triple >> 8) & 0xff);
    if (chunk.length > 3) bytes.push(triple & 0xff);
  }
  const decoded = Uint8Array.from(bytes);
  // Reject non-canonical encodings so every stroke has one representation.
  return base64UrlEncode(decoded) === value ? decoded : null;
}

function defaultStrokeId(): string {
  const random = new Uint8Array(6);
  globalThis.crypto.getRandomValues(random);
  const suffix = [...random]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${Date.now().toString(36).padStart(9, "0")}${suffix}`;
}
