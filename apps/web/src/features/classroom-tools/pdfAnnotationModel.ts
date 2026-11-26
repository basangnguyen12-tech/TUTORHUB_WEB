import type {
  PdfAnnotationErrorCode,
  PdfAnnotationPoint,
  PdfAnnotationTool,
  PdfAnnotationWidth,
  PdfStroke,
} from "@tutorhub/collaboration-client";
import type { TranslationKey } from "../../app/i18n";
import type { NormalizedRect } from "./documentViewerModel";

/**
 * ROOM-TOOLS-FILES-02B (ADR-0045 Slice 2): pure model of the page-scoped ink
 * layer — palette, widths, geometry, eraser hit-testing, laser throttling and
 * snippet compositing. No DOM, no Yjs: the `@tutorhub/collaboration-client`
 * imports above are type-only, so this stays in the lazy viewer chunk while
 * the CRDT code loads on demand (`livePdfCollaboration.ts`).
 */

/** The viewer's ink tools; `select` lets text selection and links through. */
export type PdfInkTool = "select" | "pen" | "highlighter" | "eraser" | "laser";

export const PDF_INK_TOOLS: readonly PdfInkTool[] = Object.freeze([
  "select",
  "pen",
  "highlighter",
  "eraser",
  "laser",
]);

export function isDrawingTool(tool: PdfInkTool): boolean {
  return tool === "pen" || tool === "highlighter" || tool === "eraser";
}

/** Tools offered for a capability: `view` has none, `laser` is presenter-only. */
export function inkToolsFor(
  capability: "view" | "edit" | "present",
): readonly PdfInkTool[] {
  if (capability === "view") return [];
  return capability === "present"
    ? PDF_INK_TOOLS
    : PDF_INK_TOOLS.filter((tool) => tool !== "laser");
}

export interface PdfInkTone {
  /** Highlighter shade (drawn translucent, multiply). */
  readonly highlight: string;
  readonly label: TranslationKey;
  /** Pen shade: ≥ 4.5:1 against white paper. */
  readonly pen: string;
}

/** 8 fixed tones (stroke `tone` 0..7); pen and highlighter shades per hue. */
export const PDF_INK_TONES: readonly PdfInkTone[] = Object.freeze([
  {
    highlight: "#fde047",
    label: "classroomTools.files.ink.tone.yellow",
    pen: "#a16207",
  },
  {
    highlight: "#fca5a5",
    label: "classroomTools.files.ink.tone.red",
    pen: "#dc2626",
  },
  {
    highlight: "#93c5fd",
    label: "classroomTools.files.ink.tone.blue",
    pen: "#1d4ed8",
  },
  {
    highlight: "#86efac",
    label: "classroomTools.files.ink.tone.green",
    pen: "#15803d",
  },
  {
    highlight: "#d8b4fe",
    label: "classroomTools.files.ink.tone.purple",
    pen: "#7e22ce",
  },
  {
    highlight: "#fdba74",
    label: "classroomTools.files.ink.tone.orange",
    pen: "#c2410c",
  },
  {
    highlight: "#d1d5db",
    label: "classroomTools.files.ink.tone.black",
    pen: "#111827",
  },
  {
    highlight: "#f9a8d4",
    label: "classroomTools.files.ink.tone.pink",
    pen: "#be185d",
  },
] satisfies PdfInkTone[]);

/** Default tone per tool: red correction ink, yellow highlighter. */
export const PDF_INK_DEFAULT_TONES: Readonly<
  Record<PdfAnnotationTool, number>
> = Object.freeze({ highlighter: 0, pen: 1 });

export const PDF_INK_HIGHLIGHT_OPACITY = 0.4;

/** Stroke widths in viewBox units (the page is 1 000 units wide). */
const WIDTH_UNITS: Readonly<
  Record<PdfAnnotationTool, Readonly<Record<PdfAnnotationWidth, number>>>
> = Object.freeze({
  highlighter: Object.freeze({ l: 28, m: 18, s: 12 }),
  pen: Object.freeze({ l: 7, m: 4, s: 2.5 }),
});

export const PDF_INK_VIEWBOX_WIDTH = 1_000;
/** Eraser reach in viewBox units (on top of half the stroke width). */
export const PDF_INK_ERASER_RADIUS = 10;

export function strokeWidthUnits(
  tool: PdfAnnotationTool,
  width: PdfAnnotationWidth,
): number {
  return WIDTH_UNITS[tool]?.[width] ?? 4;
}

export function strokeColor(tool: PdfAnnotationTool, tone: number): string {
  const entry = PDF_INK_TONES[clampTone(tone)] ?? PDF_INK_TONES[1];
  return tool === "highlighter"
    ? (entry?.highlight ?? "#fde047")
    : (entry?.pen ?? "#dc2626");
}

export function clampTone(tone: number): number {
  if (!Number.isSafeInteger(tone)) return 0;
  return Math.min(PDF_INK_TONES.length - 1, Math.max(0, tone));
}

function clampAspect(aspect: number): number {
  return Number.isFinite(aspect) && aspect > 0
    ? Math.min(10, Math.max(0.1, aspect))
    : 0.7071;
}

/** A page's SVG coordinate space: 1 000 units wide, aspect-correct height. */
export function inkViewBox(aspect: number): {
  readonly height: number;
  readonly width: number;
} {
  return {
    height: PDF_INK_VIEWBOX_WIDTH / clampAspect(aspect),
    width: PDF_INK_VIEWBOX_WIDTH,
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** SVG path data for normalized points (a dot becomes a short line). */
export function strokePathData(
  points: readonly PdfAnnotationPoint[],
  aspect: number,
): string {
  if (points.length === 0) return "";
  const box = inkViewBox(aspect);
  const coords: ReadonlyArray<readonly [number, number]> = points.map(
    (point) =>
      [round(point.x * box.width), round(point.y * box.height)] as const,
  );
  const first = coords[0] as readonly [number, number];
  const rest = coords.slice(1);
  if (rest.length === 0) {
    return `M${first[0]} ${first[1]}L${round(first[0] + 0.1)} ${first[1]}`;
  }
  return `M${first[0]} ${first[1]}${rest.map(([x, y]) => `L${x} ${y}`).join("")}`;
}

/** Normalized point of a pointer inside a page frame (clamped to 0..1). */
export function normalizePointer(
  clientX: number,
  clientY: number,
  box: {
    readonly height: number;
    readonly left: number;
    readonly top: number;
    readonly width: number;
  },
): PdfAnnotationPoint {
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return {
    x: clamp((clientX - box.left) / Math.max(1, box.width)),
    y: clamp((clientY - box.top) / Math.max(1, box.height)),
  };
}

function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.min(
    1,
    Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSquared),
  );
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Eraser hit-test in viewBox units (so the reach is the same horizontally
 * and vertically on any page shape). Returns the topmost (latest) hit.
 */
export function hitTestStrokes(
  strokes: readonly PdfStroke[],
  point: PdfAnnotationPoint,
  aspect: number,
  radius = PDF_INK_ERASER_RADIUS,
): PdfStroke | null {
  const box = inkViewBox(aspect);
  const px = point.x * box.width;
  const py = point.y * box.height;
  for (let index = strokes.length - 1; index >= 0; index -= 1) {
    const stroke = strokes[index] as PdfStroke;
    const reach = radius + strokeWidthUnits(stroke.tool, stroke.width) / 2;
    const points = stroke.points;
    for (let step = 0; step < points.length; step += 1) {
      const a = points[step] as PdfAnnotationPoint;
      const b = (points[step + 1] ?? a) as PdfAnnotationPoint;
      if (
        distanceToSegment(
          px,
          py,
          a.x * box.width,
          a.y * box.height,
          b.x * box.width,
          b.y * box.height,
        ) <= reach
      ) {
        return stroke;
      }
    }
  }
  return null;
}

/** Minimal structural 2D context used to composite ink onto a snippet. */
export interface InkCanvasContext {
  globalAlpha: number;
  globalCompositeOperation: string;
  lineCap: string;
  lineJoin: string;
  lineWidth: number;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  beginPath(): void;
  lineTo(x: number, y: number): void;
  moveTo(x: number, y: number): void;
  restore(): void;
  save(): void;
  stroke(): void;
}

/**
 * Draws the visible `pen` / `highlighter` strokes of a page region onto the
 * snippet canvas before it is compressed, at the same relative widths the
 * overlay shows. Strokes outside the region are clipped by the canvas.
 */
export function drawStrokesOnCanvas(
  context: InkCanvasContext,
  strokes: readonly PdfStroke[],
  rect: NormalizedRect,
  canvas: { readonly height: number; readonly width: number },
): number {
  if (rect.width <= 0 || rect.height <= 0) return 0;
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  // Page width in canvas pixels → viewBox units to pixels.
  const unit = scaleX / PDF_INK_VIEWBOX_WIDTH;
  let drawn = 0;
  // Highlights first, so pen ink stays crisp on top (as on the overlay).
  const ordered = [
    ...strokes.filter((stroke) => stroke.tool === "highlighter"),
    ...strokes.filter((stroke) => stroke.tool === "pen"),
  ];
  for (const stroke of ordered) {
    if (stroke.points.length === 0) continue;
    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = Math.max(
      1,
      strokeWidthUnits(stroke.tool, stroke.width) * unit,
    );
    context.strokeStyle = strokeColor(stroke.tool, stroke.tone);
    const highlight = stroke.tool === "highlighter";
    context.globalAlpha = highlight ? PDF_INK_HIGHLIGHT_OPACITY : 1;
    context.globalCompositeOperation = highlight ? "multiply" : "source-over";
    context.beginPath();
    stroke.points.forEach((point, index) => {
      const x = (point.x - rect.x) * scaleX;
      const y = (point.y - rect.y) * scaleY;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    if (stroke.points.length === 1) {
      const only = stroke.points[0] as PdfAnnotationPoint;
      context.lineTo(
        (only.x - rect.x) * scaleX + 0.1,
        (only.y - rect.y) * scaleY,
      );
    }
    context.stroke();
    context.restore();
    drawn += 1;
  }
  return drawn;
}

/** True when any stroke touches the normalized region. */
export function strokesIntersectRect(
  strokes: readonly PdfStroke[],
  rect: NormalizedRect,
): boolean {
  return strokes.some((stroke) =>
    stroke.points.some(
      (point) =>
        point.x >= rect.x &&
        point.x <= rect.x + rect.width &&
        point.y >= rect.y &&
        point.y <= rect.y + rect.height,
    ),
  );
}

// ---- Laser --------------------------------------------------------------

/** Presenter laser: ≤ 20 Hz, cleared after 1.5 s without an update. */
export const PDF_LASER_MIN_INTERVAL_MS = 50;
export const PDF_LASER_STALE_MS = 1_500;

export interface PdfLaserPoint {
  readonly page: number;
  readonly x: number;
  readonly y: number;
}

/** Strict parse of a peer's `pdfLaser` awareness field. */
export function parseLaserPoint(
  value: unknown,
  pageCount: number,
): PdfLaserPoint | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const { page, x, y } = record;
  if (
    !Number.isSafeInteger(page) ||
    (page as number) < 1 ||
    (page as number) > pageCount ||
    typeof x !== "number" ||
    typeof y !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    x > 1 ||
    y < 0 ||
    y > 1
  ) {
    return null;
  }
  return {
    page: page as number,
    x: Math.round(x * 10_000) / 10_000,
    y: Math.round(y * 10_000) / 10_000,
  };
}

/**
 * Leading + trailing throttle: the first point goes out at once, then at most
 * one every `minIntervalMs`; the last point of a burst is never lost.
 */
export function createLaserThrottle(
  publish: (point: PdfLaserPoint | null) => void,
  {
    minIntervalMs = PDF_LASER_MIN_INTERVAL_MS,
    now = () => Date.now(),
    schedule = (callback: () => void, delay: number) =>
      globalThis.setTimeout(callback, delay),
    cancel = (handle: ReturnType<typeof setTimeout>) =>
      globalThis.clearTimeout(handle),
  }: {
    readonly cancel?: (handle: ReturnType<typeof setTimeout>) => void;
    readonly minIntervalMs?: number;
    readonly now?: () => number;
    readonly schedule?: (
      callback: () => void,
      delay: number,
    ) => ReturnType<typeof setTimeout>;
  } = {},
) {
  let last = Number.NEGATIVE_INFINITY;
  let pending: PdfLaserPoint | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active = false;
  const flush = () => {
    timer = null;
    if (!pending) return;
    last = now();
    active = true;
    publish(pending);
    pending = null;
  };
  return {
    move(point: PdfLaserPoint) {
      pending = point;
      const elapsed = now() - last;
      if (elapsed >= minIntervalMs) {
        if (timer !== null) cancel(timer);
        flush();
      } else if (timer === null) {
        timer = schedule(flush, minIntervalMs - elapsed);
      }
    },
    clear() {
      pending = null;
      if (timer !== null) cancel(timer);
      timer = null;
      if (active) {
        active = false;
        last = now();
        publish(null);
      }
    },
  };
}

// ---- Errors -------------------------------------------------------------

/** The authority error code of a thrown value (duck-typed, no class import). */
export function pdfAnnotationErrorCode(
  error: unknown,
): PdfAnnotationErrorCode | null {
  if (
    error instanceof Error &&
    error.name === "PdfAnnotationAuthorityError" &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as unknown as { code: PdfAnnotationErrorCode }).code;
  }
  return null;
}

/** A polite bilingual notice for a refused ink operation. */
export function pdfAnnotationErrorKey(error: unknown): TranslationKey {
  switch (pdfAnnotationErrorCode(error)) {
    case "page_stroke_limit":
      return "classroomTools.files.ink.error.pageLimit";
    case "document_stroke_limit":
    case "document_too_large":
      return "classroomTools.files.ink.error.documentLimit";
    case "stroke_not_owned":
      return "classroomTools.files.ink.error.notOwned";
    case "stroke_too_large":
      return "classroomTools.files.ink.error.strokeTooLarge";
    case "authority_read_only":
    case "authority_not_presenter":
      return "classroomTools.files.ink.error.readOnly";
    default:
      return "classroomTools.files.ink.error.failed";
  }
}
