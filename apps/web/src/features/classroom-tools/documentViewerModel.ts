/**
 * ROOM-TOOLS-FILES-01B / ADR-0045 §3: pure model of the virtualized,
 * zero-scripting document viewer (no DOM, no pdf.js) so the memory window,
 * the link policy, search folding and crop geometry are unit-tested exactly.
 */
export const DOCUMENT_VIEWER_LIMITS = Object.freeze({
  desktopCanvases: 5,
  desktopMaxCanvasPixels: 16_000_000,
  mobileBreakpointPx: 768,
  mobileCanvases: 2,
  mobileMaxCanvasPixels: 8_000_000,
  renderWatchdogMs: 15_000,
  snippetMaxLongEdgePx: 1_440,
  thumbnailCacheSize: 40,
  thumbnailWidthPx: 120,
});

export function isMobileViewerWidth(viewportWidth: number): boolean {
  return viewportWidth < DOCUMENT_VIEWER_LIMITS.mobileBreakpointPx;
}

/** At most 5 live page canvases on desktop (≥ 768 px), 2 on mobile. */
export function liveCanvasLimit(viewportWidth: number): number {
  return isMobileViewerWidth(viewportWidth)
    ? DOCUMENT_VIEWER_LIMITS.mobileCanvases
    : DOCUMENT_VIEWER_LIMITS.desktopCanvases;
}

export function maxCanvasPixels(viewportWidth: number): number {
  return isMobileViewerWidth(viewportWidth)
    ? DOCUMENT_VIEWER_LIMITS.mobileMaxCanvasPixels
    : DOCUMENT_VIEWER_LIMITS.desktopMaxCanvasPixels;
}

function clampPage(page: number, pageCount: number): number {
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(1, Math.round(page)), Math.max(1, pageCount));
}

/**
 * The pages allowed to hold a pixel canvas, in render-priority order: the
 * current page, then the visible pages nearest to it, then neighbours in the
 * scroll direction before those behind. Never more than `limit`.
 */
export function selectLivePages({
  current,
  direction = 1,
  limit,
  pageCount,
  visible,
}: {
  readonly current: number;
  readonly direction?: 1 | -1;
  readonly limit: number;
  readonly pageCount: number;
  readonly visible: readonly number[];
}): number[] {
  const max = Math.max(0, Math.floor(limit));
  if (pageCount < 1 || max === 0) return [];
  const anchor = clampPage(current, pageCount);
  const chosen: number[] = [];
  const add = (page: number) => {
    if (
      chosen.length < max &&
      page >= 1 &&
      page <= pageCount &&
      !chosen.includes(page)
    ) {
      chosen.push(page);
    }
  };
  add(anchor);
  [...new Set(visible)]
    .filter((page) => page >= 1 && page <= pageCount)
    .sort(
      (left, right) =>
        Math.abs(left - anchor) - Math.abs(right - anchor) || left - right,
    )
    .forEach(add);
  for (let step = 1; chosen.length < max && step <= pageCount; step += 1) {
    add(anchor + direction * step);
    add(anchor - direction * step);
  }
  return chosen;
}

/** The page with the largest visible share (ties → the earlier page). */
export function mostVisiblePage(
  ratios: ReadonlyMap<number, number>,
  fallback: number,
): number {
  let best = fallback;
  let bestRatio = 0;
  for (const [page, ratio] of ratios) {
    if (
      ratio > bestRatio ||
      (ratio === bestRatio && ratio > 0 && page < best)
    ) {
      best = page;
      bestRatio = ratio;
    }
  }
  return best;
}

/**
 * Backing-store size for a page canvas: CSS size × device pixel ratio,
 * scaled down so the canvas never exceeds the per-device pixel budget.
 */
export function canvasBackingSize({
  cssHeight,
  cssWidth,
  devicePixelRatio,
  maxPixels,
}: {
  readonly cssHeight: number;
  readonly cssWidth: number;
  readonly devicePixelRatio: number;
  readonly maxPixels: number;
}): {
  readonly height: number;
  readonly scale: number;
  readonly width: number;
} {
  const width = Math.max(1, cssWidth);
  const height = Math.max(1, cssHeight);
  const dpr =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
  const scale = Math.min(dpr, Math.sqrt(maxPixels / (width * height)));
  return {
    height: Math.max(1, Math.floor(height * scale)),
    scale,
    width: Math.max(1, Math.floor(width * scale)),
  };
}

export type PdfLinkTarget =
  | { readonly kind: "blocked" }
  | {
      /** What the confirmation dialog shows: the real host. */
      readonly display: string;
      readonly href: string;
      readonly kind: "external";
    }
  | {
      readonly display: string;
      readonly href: string;
      readonly kind: "mailto";
    };

/**
 * ADR-0045 §3 link policy: only absolute `https:` (with a host and without
 * embedded credentials) and `mailto:` targets are ever clickable, and only
 * after a confirmation that shows the host / address. `javascript:`,
 * `data:`, `blob:`, `file:`, `http:`, `ftp:`, `tel:` … stay inert.
 */
export function classifyPdfLinkTarget(
  value: string | null | undefined,
): PdfLinkTarget {
  if (typeof value !== "string") return { kind: "blocked" };
  const trimmed = value.trim();
  // Control characters (incl. CR/LF smuggling) are never acceptable.
  if (trimmed.length === 0 || trimmed.length > 2_048)
    return { kind: "blocked" };
  for (const character of trimmed) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return { kind: "blocked" };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { kind: "blocked" };
  }
  if (url.protocol === "https:") {
    if (!url.hostname || url.username || url.password) {
      return { kind: "blocked" };
    }
    return { display: url.hostname, href: url.href, kind: "external" };
  }
  if (url.protocol === "mailto:") {
    let address: string;
    try {
      address = decodeURIComponent(url.pathname);
    } catch {
      return { kind: "blocked" };
    }
    if (!/^[^\s@<>()",;:]+@[^\s@<>()",;:]+$/.test(address)) {
      return { kind: "blocked" };
    }
    return { display: address, href: `mailto:${address}`, kind: "mailto" };
  }
  return { kind: "blocked" };
}

/**
 * Case-insensitive search text; with `ignoreDiacritics` Vietnamese marks are
 * folded too ("phuong trinh" matches "phương trình", "đ" matches "d").
 */
export function foldSearchText(
  text: string,
  ignoreDiacritics: boolean,
): string {
  const lower = text.normalize("NFC").toLocaleLowerCase("vi");
  if (!ignoreDiacritics) return lower.replace(/\s+/g, " ");
  return lower
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/đ/g, "d")
    .replace(/\s+/g, " ")
    .normalize("NFC");
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export interface DocumentSearchMatch {
  readonly count: number;
  readonly page: number;
}

/** Pages containing the query (ascending), with per-page match counts. */
export function findDocumentMatches(
  pageTexts: ReadonlyMap<number, string>,
  query: string,
  ignoreDiacritics: boolean,
): DocumentSearchMatch[] {
  const needle = foldSearchText(query, ignoreDiacritics).trim();
  if (needle.length === 0) return [];
  const matches: DocumentSearchMatch[] = [];
  for (const [page, text] of [...pageTexts].sort(([a], [b]) => a - b)) {
    const count = countOccurrences(
      foldSearchText(text, ignoreDiacritics),
      needle,
    );
    if (count > 0) matches.push({ count, page });
  }
  return matches;
}

/** The next match page after (or before) `current`, wrapping around. */
export function nextMatchPage(
  matches: readonly DocumentSearchMatch[],
  current: number,
  direction: 1 | -1,
): number | null {
  if (matches.length === 0) return null;
  const pages = matches.map((match) => match.page);
  if (direction === 1) {
    return pages.find((page) => page > current) ?? pages[0] ?? null;
  }
  return (
    [...pages].reverse().find((page) => page < current) ??
    pages[pages.length - 1] ??
    null
  );
}

export const DOCUMENT_ZOOM_STEPS = Object.freeze([
  0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4,
]);
export const DOCUMENT_ZOOM_MIN = DOCUMENT_ZOOM_STEPS[0] ?? 0.5;
export const DOCUMENT_ZOOM_MAX =
  DOCUMENT_ZOOM_STEPS[DOCUMENT_ZOOM_STEPS.length - 1] ?? 4;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(DOCUMENT_ZOOM_MAX, Math.max(DOCUMENT_ZOOM_MIN, zoom));
}

/** One step up/down the zoom ladder from an arbitrary zoom. */
export function stepZoom(current: number, direction: 1 | -1): number {
  const zoom = clampZoom(current);
  if (direction === 1) {
    return (
      DOCUMENT_ZOOM_STEPS.find((step) => step > zoom + 0.001) ??
      DOCUMENT_ZOOM_MAX
    );
  }
  return (
    [...DOCUMENT_ZOOM_STEPS].reverse().find((step) => step < zoom - 0.001) ??
    DOCUMENT_ZOOM_MIN
  );
}

/** A crop rectangle in page-relative units (0..1 on both axes). */
export interface NormalizedRect {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export const MIN_CROP_SIZE = 0.04;
export const FULL_PAGE_RECT: NormalizedRect = Object.freeze({
  height: 1,
  width: 1,
  x: 0,
  y: 0,
});

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** The rectangle spanned by two drag points, clamped to the page. */
export function rectFromPoints(
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
): NormalizedRect {
  const x1 = clamp01(Math.min(start.x, end.x));
  const y1 = clamp01(Math.min(start.y, end.y));
  const x2 = clamp01(Math.max(start.x, end.x));
  const y2 = clamp01(Math.max(start.y, end.y));
  return { height: y2 - y1, width: x2 - x1, x: x1, y: y1 };
}

export function isUsableCrop(rect: NormalizedRect): boolean {
  return rect.width >= MIN_CROP_SIZE && rect.height >= MIN_CROP_SIZE;
}

/** Keyboard crop editing: arrows move, Shift+arrows resize (within page). */
export function nudgeCrop(
  rect: NormalizedRect,
  key: "ArrowDown" | "ArrowLeft" | "ArrowRight" | "ArrowUp",
  resize: boolean,
  step = 0.02,
): NormalizedRect {
  const dx = key === "ArrowRight" ? step : key === "ArrowLeft" ? -step : 0;
  const dy = key === "ArrowDown" ? step : key === "ArrowUp" ? -step : 0;
  if (resize) {
    const width = Math.min(
      1 - rect.x,
      Math.max(MIN_CROP_SIZE, rect.width + dx),
    );
    const height = Math.min(
      1 - rect.y,
      Math.max(MIN_CROP_SIZE, rect.height + dy),
    );
    return { ...rect, height, width };
  }
  return {
    ...rect,
    x: Math.min(1 - rect.width, Math.max(0, rect.x + dx)),
    y: Math.min(1 - rect.height, Math.max(0, rect.y + dy)),
  };
}

/** Render scale so the crop's long edge is at most `maxLongEdge` pixels. */
export function snippetRenderScale(
  regionWidth: number,
  regionHeight: number,
  maxLongEdge: number = DOCUMENT_VIEWER_LIMITS.snippetMaxLongEdgePx,
  preferredScale = 2,
): number {
  const longEdge = Math.max(regionWidth, regionHeight, 1);
  return Math.min(preferredScale, maxLongEdge / longEdge);
}

export interface RenderScheduler {
  /**
   * Queues a job; the lowest `priority()` (read when a slot frees up) runs
   * first. The returned function drops a job that has not started yet.
   */
  schedule(priority: () => number, run: () => Promise<void>): () => void;
}

/** A tiny priority queue so visible pages render before far-away ones. */
export function createRenderScheduler(concurrency = 2): RenderScheduler {
  interface Job {
    cancelled: boolean;
    readonly priority: () => number;
    readonly run: () => Promise<void>;
  }
  const queue: Job[] = [];
  let active = 0;
  const pump = () => {
    while (active < concurrency && queue.length > 0) {
      queue.sort((left, right) => left.priority() - right.priority());
      const job = queue.shift();
      if (!job || job.cancelled) continue;
      active += 1;
      void job
        .run()
        .catch(() => undefined)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };
  return {
    schedule(priority, run) {
      const job: Job = { cancelled: false, priority, run };
      queue.push(job);
      queueMicrotask(pump);
      return () => {
        job.cancelled = true;
        const index = queue.indexOf(job);
        if (index >= 0) queue.splice(index, 1);
      };
    },
  };
}

/** LRU of thumbnail object URLs; evicted entries are released at once. */
export class ThumbnailUrlCache {
  private readonly entries = new Map<number, string>();

  constructor(
    private readonly limit: number = DOCUMENT_VIEWER_LIMITS.thumbnailCacheSize,
    private readonly revoke: (url: string) => void = (url) =>
      URL.revokeObjectURL(url),
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get(page: number): string | undefined {
    const url = this.entries.get(page);
    if (url === undefined) return undefined;
    this.entries.delete(page);
    this.entries.set(page, url);
    return url;
  }

  has(page: number): boolean {
    return this.entries.has(page);
  }

  set(page: number, url: string): void {
    const previous = this.entries.get(page);
    if (previous !== undefined && previous !== url) this.revoke(previous);
    this.entries.delete(page);
    this.entries.set(page, url);
    while (this.entries.size > this.limit) {
      const [oldestPage, oldestURL] = this.entries.entries().next().value ?? [];
      if (oldestPage === undefined || oldestURL === undefined) break;
      this.entries.delete(oldestPage);
      this.revoke(oldestURL);
    }
  }

  clear(): void {
    for (const url of this.entries.values()) this.revoke(url);
    this.entries.clear();
  }
}

/** Bytes as a short localized size ("1,2 MB" / "1.2 MB"). */
export function formatDocumentSize(bytes: number, locale: string): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const formatter = new Intl.NumberFormat(locale, {
    maximumFractionDigits: unit === 0 || value >= 100 ? 0 : 1,
  });
  return `${formatter.format(value)} ${units[unit]}`;
}
