/**
 * WHITEBOARD-PAPER-01 — classroom paper styles.
 *
 * Colours and rulings follow the TutorHub V1 paper sheet (lined/grid/notebook
 * 32px, dots 24px, music staves every 160px, blueprint 100px + 20px) plus an
 * art canvas weave. Everything here is imported only from the lazily loaded
 * whiteboard engine chunk, so the entry bundle does not grow.
 *
 * Geometry is expressed in scene units and mapped to the screen exactly like
 * Excalidraw: `screen = (scene + scroll) * zoom`. Rulings keep a constant
 * on-screen thickness (like Excalidraw's own grid) while their positions stay
 * anchored to the drawing when the teacher pans or zooms.
 */
import {
  isWhiteboardPaperMode,
  WHITEBOARD_PAPER_MODES,
  type WhiteboardPaperMode,
} from "@tutorhub/collaboration-client";
import type { TranslationKey } from "../../app/i18n";

export { WHITEBOARD_PAPER_MODES, type WhiteboardPaperMode };

export const DEFAULT_PAPER_MODE: WhiteboardPaperMode = "plain";

/** Default Excalidraw stroke on light paper, and chalk on dark surfaces. */
export const LIGHT_SURFACE_INK = "#1e1e1e";
export const DARK_SURFACE_INK = "#ffffff";

export interface WhiteboardPaperSelection {
  dark: boolean;
  mode: WhiteboardPaperMode;
}

export interface WhiteboardPaperPalette {
  /** Opaque surface colour, also stored as `page.backgroundColor`. */
  base: string;
  /** Ruling / dot / weave colour. */
  rule: string;
  /** Secondary colour: notebook margin, blueprint minor grid, chalk dust. */
  accent?: string;
}

interface PaperSpec {
  /** Blueprint and blackboard keep their own surface in both variants. */
  fixedSurface: boolean;
  light: WhiteboardPaperPalette;
  dark: WhiteboardPaperPalette;
}

const LIGHT_PAPER = "#fdfdfd";
const DARK_PAPER = "#1e293b";
const LIGHT_RULE = "#cbd5e1";
const DARK_RULE = "#475569";

export const WHITEBOARD_PAPER_SPECS: Readonly<
  Record<WhiteboardPaperMode, PaperSpec>
> = {
  plain: {
    fixedSurface: false,
    light: { base: "#ffffff", rule: "transparent" },
    dark: { base: DARK_PAPER, rule: "transparent" },
  },
  lined: {
    fixedSurface: false,
    light: { base: LIGHT_PAPER, rule: LIGHT_RULE },
    dark: { base: DARK_PAPER, rule: DARK_RULE },
  },
  grid: {
    fixedSurface: false,
    light: { base: LIGHT_PAPER, rule: LIGHT_RULE },
    dark: { base: DARK_PAPER, rule: DARK_RULE },
  },
  notebook: {
    fixedSurface: false,
    light: { accent: "#fca5a5", base: LIGHT_PAPER, rule: LIGHT_RULE },
    dark: { accent: "#7f1d1d", base: DARK_PAPER, rule: DARK_RULE },
  },
  dots: {
    fixedSurface: false,
    light: { base: LIGHT_PAPER, rule: LIGHT_RULE },
    dark: { base: DARK_PAPER, rule: DARK_RULE },
  },
  music: {
    fixedSurface: false,
    light: { base: LIGHT_PAPER, rule: "#94a3b8" },
    dark: { base: DARK_PAPER, rule: DARK_RULE },
  },
  canvas: {
    fixedSurface: false,
    light: { base: "#f7f3ea", rule: "rgba(120, 102, 78, 0.085)" },
    dark: { base: "#232220", rule: "rgba(255, 248, 235, 0.055)" },
  },
  blueprint: {
    fixedSurface: true,
    light: {
      accent: "rgba(255, 255, 255, 0.10)",
      base: "#1e3a8a",
      rule: "rgba(255, 255, 255, 0.30)",
    },
    dark: {
      accent: "rgba(255, 255, 255, 0.10)",
      base: "#1e3a8a",
      rule: "rgba(255, 255, 255, 0.30)",
    },
  },
  blackboard: {
    fixedSurface: true,
    light: {
      accent: "rgba(255, 255, 255, 0.03)",
      base: "#1b3d2b",
      rule: "transparent",
    },
    dark: {
      accent: "rgba(255, 255, 255, 0.03)",
      base: "#1b3d2b",
      rule: "transparent",
    },
  },
};

/** Ruling geometry in scene units (zoom 1.0). */
export const PAPER_GEOMETRY = {
  /** V1 draws each 1px rule at the bottom of its 32px band (31–32px). */
  linedOffset: 31,
  linePeriod: 32,
  dotPeriod: 24,
  dotRadius: 1.5,
  notebookMarginX: 80,
  notebookMarginWidth: 2,
  musicPeriod: 160,
  musicStaff: [40, 52, 64, 76, 88] as const,
  canvasPeriod: 12,
  blueprintMajor: 100,
  blueprintMinor: 20,
} as const;

export function paperModeLabelKey(mode: WhiteboardPaperMode): TranslationKey {
  return `whiteboard.paper.mode.${mode}`;
}

export function isFixedPaperSurface(mode: WhiteboardPaperMode): boolean {
  return WHITEBOARD_PAPER_SPECS[mode].fixedSurface;
}

export function isDarkPaperSurface(
  mode: WhiteboardPaperMode,
  paperDark: boolean | undefined,
): boolean {
  return mode === "blueprint" || mode === "blackboard" || Boolean(paperDark);
}

export function resolvePaperPalette(
  mode: WhiteboardPaperMode,
  paperDark: boolean | undefined,
): WhiteboardPaperPalette {
  const spec = WHITEBOARD_PAPER_SPECS[mode];
  return paperDark ? spec.dark : spec.light;
}

/** Opaque surface colour stored in `canonical.page.backgroundColor`. */
export function resolvePaperBaseColor(
  mode: WhiteboardPaperMode,
  paperDark: boolean | undefined,
): string {
  return resolvePaperPalette(mode, paperDark).base;
}

/**
 * Paper of a canonical page. Pages created before the picker existed carry no
 * paper fields and render as plain light paper.
 */
export function readPaperSelection(
  page: { paperDark?: unknown; paperMode?: unknown } | null | undefined,
): WhiteboardPaperSelection {
  return {
    dark: page?.paperDark === true,
    mode: isWhiteboardPaperMode(page?.paperMode)
      ? page.paperMode
      : DEFAULT_PAPER_MODE,
  };
}

/** Smart ink: the next stroke colour after the surface flips light ↔ dark. */
export function adaptInkForSurface(
  currentStrokeColor: string | undefined,
  darkSurface: boolean,
): string | null {
  const current = (currentStrokeColor ?? "").trim().toLowerCase();
  if (darkSurface) {
    return current === "#1e1e1e" || current === "#000000"
      ? DARK_SURFACE_INK
      : null;
  }
  return current === DARK_SURFACE_INK ? LIGHT_SURFACE_INK : null;
}

export type PaperSwatchVariant = "card" | "chip";

export interface PaperSwatchStyle {
  backgroundColor: string;
  backgroundImage?: string;
  backgroundPosition?: string;
  backgroundRepeat?: string;
  backgroundSize?: string;
}

/**
 * Miniature of a paper drawn with CSS gradients from the same palette as the
 * live backdrop: `card` (52×36 picker card) or `chip` (≈20×14 trigger/badge).
 * The canvas weave and chalk dust are slightly amplified so the texture
 * stays legible at thumbnail size.
 */
export function paperSwatchStyle(
  mode: WhiteboardPaperMode,
  paperDark: boolean,
  variant: PaperSwatchVariant,
): PaperSwatchStyle {
  const palette = resolvePaperPalette(mode, paperDark);
  const card = variant === "card";
  const scale = card ? 0.5 : 0.28;
  const px = (value: number) => `${Math.round(value * 100) / 100}px`;
  const rule = palette.rule;
  const horizontal = (color: string) =>
    `linear-gradient(to bottom, ${color} 1px, transparent 1px)`;
  const vertical = (color: string) =>
    `linear-gradient(to right, ${color} 1px, transparent 1px)`;
  const base = { backgroundColor: palette.base };
  const linePeriod = PAPER_GEOMETRY.linePeriod * scale;

  switch (mode) {
    case "plain":
      return base;
    case "lined":
      return {
        ...base,
        backgroundImage: `linear-gradient(to bottom, transparent calc(100% - 1px), ${rule} calc(100% - 1px))`,
        backgroundSize: `100% ${px(linePeriod)}`,
      };
    case "grid":
      return {
        ...base,
        backgroundImage: `${horizontal(rule)}, ${vertical(rule)}`,
        backgroundSize: `${px(linePeriod)} ${px(linePeriod)}`,
      };
    case "notebook": {
      const margin = card ? 13 : 5;
      const accent = palette.accent ?? rule;
      return {
        ...base,
        backgroundImage: `linear-gradient(to right, transparent ${px(margin - 1)}, ${accent} ${px(margin - 1)}, ${accent} ${px(margin + 1)}, transparent ${px(margin + 1)}), linear-gradient(to bottom, transparent calc(100% - 1px), ${rule} calc(100% - 1px))`,
        backgroundSize: `100% 100%, 100% ${px(linePeriod)}`,
      };
    }
    case "dots": {
      const period = PAPER_GEOMETRY.dotPeriod * scale;
      const radius = card ? 1.3 : 0.9;
      return {
        ...base,
        backgroundImage: `radial-gradient(circle, ${rule} ${px(radius)}, transparent ${px(radius + 0.6)})`,
        backgroundSize: `${px(period)} ${px(period)}`,
      };
    }
    case "music": {
      // One five-line staff per swatch (the 72px rest falls outside).
      const gap = card ? 5 : 2.4;
      const top = card ? 8 : 2;
      const stops = Array.from({ length: 5 }, (_, index) => {
        const y = top + index * gap;
        return `transparent ${px(y)}, ${rule} ${px(y)}, ${rule} ${px(y + 1)}, transparent ${px(y + 1)}`;
      }).join(", ");
      return {
        ...base,
        backgroundImage: `linear-gradient(to bottom, ${stops})`,
        backgroundRepeat: "no-repeat",
        backgroundSize: "100% 100%",
      };
    }
    case "canvas": {
      const thread = paperDark
        ? "rgba(255, 248, 235, 0.11)"
        : "rgba(120, 102, 78, 0.17)";
      const step = card ? 4 : 3;
      return {
        ...base,
        backgroundImage: `repeating-linear-gradient(45deg, ${thread} 0 1px, transparent 1px ${px(step)}), repeating-linear-gradient(-45deg, ${thread} 0 1px, transparent 1px ${px(step)})`,
      };
    }
    case "blueprint": {
      const major = PAPER_GEOMETRY.blueprintMajor * scale;
      const minor = PAPER_GEOMETRY.blueprintMinor * scale;
      const accent = palette.accent ?? rule;
      return {
        ...base,
        backgroundImage: `${horizontal(rule)}, ${vertical(rule)}, ${horizontal(accent)}, ${vertical(accent)}`,
        backgroundSize: `${px(major)} ${px(major)}, ${px(major)} ${px(major)}, ${px(minor)} ${px(minor)}, ${px(minor)} ${px(minor)}`,
      };
    }
    case "blackboard":
      return {
        ...base,
        backgroundImage:
          "radial-gradient(circle at 38% 32%, rgba(255, 255, 255, 0.09), rgba(255, 255, 255, 0) 68%)",
      };
  }
}

export interface PaperViewport {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

export interface PaintPaperOptions extends PaperViewport {
  dark: boolean;
  /** Device pixels per CSS pixel of the target canvas. */
  dpr: number;
  /** Target size in CSS pixels. */
  height: number;
  mode: WhiteboardPaperMode;
  width: number;
}

/** Screen spacing (CSS px) below which rulings double their step. */
const MIN_RULE_SPACING = 6;
const MIN_DOT_SPACING = 8;
const MIN_TEXTURE_SPACING = 6;
const MAX_TEXTURE_SPACING = 24;

/**
 * Paints one frame of paper into a 2D context sized `width × height` CSS px at
 * `dpr`. Pure: safe to call on every animation frame and for small swatches.
 */
export function paintPaper(
  context: CanvasRenderingContext2D,
  options: PaintPaperOptions,
): void {
  const { dark, dpr, height, mode, scrollX, scrollY, width } = options;
  const zoom =
    Number.isFinite(options.zoom) && options.zoom > 0 ? options.zoom : 1;
  const palette = resolvePaperPalette(mode, dark);
  const deviceWidth = Math.max(1, Math.round(width * dpr));
  const deviceHeight = Math.max(1, Math.round(height * dpr));
  const view = { dpr, deviceHeight, deviceWidth, scrollX, scrollY, zoom };

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.clearRect(0, 0, deviceWidth, deviceHeight);
  context.fillStyle = palette.base;
  context.fillRect(0, 0, deviceWidth, deviceHeight);

  const geometry = PAPER_GEOMETRY;
  switch (mode) {
    case "plain":
      return;
    case "lined":
      drawRules(context, view, "horizontal", {
        color: palette.rule,
        offsets: [geometry.linedOffset],
        period: geometry.linePeriod,
      });
      return;
    case "grid":
      drawRules(context, view, "horizontal", {
        color: palette.rule,
        offsets: [0],
        period: geometry.linePeriod,
      });
      drawRules(context, view, "vertical", {
        color: palette.rule,
        offsets: [0],
        period: geometry.linePeriod,
      });
      return;
    case "notebook": {
      drawRules(context, view, "horizontal", {
        color: palette.rule,
        offsets: [geometry.linedOffset],
        period: geometry.linePeriod,
      });
      const lineWidth = Math.max(
        1,
        Math.round(geometry.notebookMarginWidth * dpr),
      );
      const center = (geometry.notebookMarginX + scrollX) * zoom * dpr;
      context.fillStyle = palette.accent ?? palette.rule;
      context.fillRect(
        Math.round(center - lineWidth / 2),
        0,
        lineWidth,
        deviceHeight,
      );
      return;
    }
    case "dots":
      drawDots(context, view, palette.rule);
      return;
    case "music":
      drawRules(context, view, "horizontal", {
        color: palette.rule,
        lod: false,
        offsets: geometry.musicStaff,
        period: geometry.musicPeriod,
      });
      return;
    case "canvas":
      drawWeave(context, view, palette.rule);
      return;
    case "blueprint":
      if (geometry.blueprintMinor * zoom >= MIN_RULE_SPACING - 1) {
        for (const axis of ["horizontal", "vertical"] as const) {
          drawRules(context, view, axis, {
            color: palette.accent ?? palette.rule,
            lod: false,
            offsets: [0],
            period: geometry.blueprintMinor,
          });
        }
      }
      for (const axis of ["horizontal", "vertical"] as const) {
        drawRules(context, view, axis, {
          color: palette.rule,
          offsets: [0],
          period: geometry.blueprintMajor,
        });
      }
      return;
    case "blackboard":
      drawChalkDust(context, view, palette.accent ?? "rgba(255,255,255,0.03)");
      return;
  }
}

interface DeviceView {
  deviceHeight: number;
  deviceWidth: number;
  dpr: number;
  scrollX: number;
  scrollY: number;
  zoom: number;
}

function drawRules(
  context: CanvasRenderingContext2D,
  view: DeviceView,
  axis: "horizontal" | "vertical",
  rule: {
    color: string;
    lod?: boolean;
    offsets: readonly number[];
    period: number;
  },
): void {
  const { dpr, zoom } = view;
  let period = rule.period;
  if (rule.lod !== false) {
    // Level of detail: double the step (staying on the same scene lattice)
    // instead of filling the view with a grey wash when zoomed far out.
    while (period * zoom < MIN_RULE_SPACING) period *= 2;
  }
  const scroll = axis === "horizontal" ? view.scrollY : view.scrollX;
  const extent = axis === "horizontal" ? view.deviceHeight : view.deviceWidth;
  const span = axis === "horizontal" ? view.deviceWidth : view.deviceHeight;
  const sceneStart = -scroll;
  const sceneEnd = extent / dpr / zoom - scroll;
  const thickness = Math.max(1, Math.round(dpr));

  context.fillStyle = rule.color;
  for (const offset of rule.offsets) {
    const first = Math.floor((sceneStart - offset) / period);
    const last = Math.ceil((sceneEnd - offset) / period);
    for (let index = first; index <= last; index += 1) {
      const scene = index * period + offset;
      const device = Math.round((scene + scroll) * zoom * dpr);
      if (device < -thickness || device > extent) continue;
      if (axis === "horizontal") {
        context.fillRect(0, device, span, thickness);
      } else {
        context.fillRect(device, 0, thickness, span);
      }
    }
  }
}

function drawDots(
  context: CanvasRenderingContext2D,
  view: DeviceView,
  color: string,
): void {
  const { dpr, zoom } = view;
  let period: number = PAPER_GEOMETRY.dotPeriod;
  while (period * zoom < MIN_DOT_SPACING) period *= 2;
  const radius = Math.max(0.75, PAPER_GEOMETRY.dotRadius * dpr);
  const half = PAPER_GEOMETRY.dotPeriod / 2;
  const sceneLeft = -view.scrollX;
  const sceneTop = -view.scrollY;
  const sceneRight = view.deviceWidth / dpr / zoom - view.scrollX;
  const sceneBottom = view.deviceHeight / dpr / zoom - view.scrollY;
  const firstColumn = Math.floor((sceneLeft - half) / period);
  const lastColumn = Math.ceil((sceneRight - half) / period);
  const firstRow = Math.floor((sceneTop - half) / period);
  const lastRow = Math.ceil((sceneBottom - half) / period);
  const columns = lastColumn - firstColumn + 1;
  const rows = lastRow - firstRow + 1;

  context.fillStyle = color;
  // Few dots: draw them directly. Many dots: one cached tile pattern.
  if (columns * rows <= 6_000) {
    context.beginPath();
    for (let row = firstRow; row <= lastRow; row += 1) {
      const y = (row * period + half + view.scrollY) * zoom * dpr;
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        const x = (column * period + half + view.scrollX) * zoom * dpr;
        context.moveTo(x + radius, y);
        context.arc(x, y, radius, 0, Math.PI * 2);
      }
    }
    context.fill();
    return;
  }
  const tileSize = period * zoom * dpr;
  fillWithTile(context, view, tileSize, (tile, size) => {
    tile.fillStyle = color;
    tile.beginPath();
    tile.arc(size / 2, size / 2, radius * (size / tileSize), 0, Math.PI * 2);
    tile.fill();
  });
}

function drawWeave(
  context: CanvasRenderingContext2D,
  view: DeviceView,
  color: string,
): void {
  const { dpr, zoom } = view;
  // Mip-mapped texture period: stays between 6 and 24 CSS px on screen while
  // remaining anchored to the scene lattice (powers of two of 12).
  let period: number = PAPER_GEOMETRY.canvasPeriod;
  while (period * zoom < MIN_TEXTURE_SPACING) period *= 2;
  while (period * zoom > MAX_TEXTURE_SPACING && period > 0.75) period /= 2;
  const tileSize = period * zoom * dpr;
  fillWithTile(context, view, tileSize, (tile, size) => {
    const thread = Math.max(1, size / 12);
    tile.strokeStyle = color;
    tile.lineCap = "square";
    tile.lineWidth = thread;
    // Twill: diagonals that join seamlessly across tiles.
    tile.beginPath();
    for (const shift of [-size, -size / 2, 0, size / 2, size]) {
      tile.moveTo(shift, size);
      tile.lineTo(shift + size, 0);
    }
    tile.stroke();
    // Warp and weft: a fainter orthogonal plain weave.
    tile.globalAlpha = 0.6;
    tile.beginPath();
    for (const position of [size / 4, (3 * size) / 4]) {
      tile.moveTo(0, position);
      tile.lineTo(size, position);
      tile.moveTo(position, 0);
      tile.lineTo(position, size);
    }
    tile.stroke();
    tile.globalAlpha = 1;
  });
}

function drawChalkDust(
  context: CanvasRenderingContext2D,
  view: DeviceView,
  color: string,
): void {
  const { deviceHeight, deviceWidth } = view;
  const radius = Math.hypot(deviceWidth, deviceHeight) * 0.6;
  const glow = context.createRadialGradient(
    deviceWidth * 0.42,
    deviceHeight * 0.36,
    0,
    deviceWidth * 0.42,
    deviceHeight * 0.36,
    radius,
  );
  // Soft chalk-dust bloom near the writing area fading into a slate vignette.
  glow.addColorStop(0, color);
  glow.addColorStop(0.55, "rgba(255, 255, 255, 0.012)");
  glow.addColorStop(1, "rgba(0, 0, 0, 0.07)");
  context.fillStyle = glow;
  context.fillRect(0, 0, deviceWidth, deviceHeight);
}

/**
 * Fills the frame with a repeating tile of `tileSize` device px (one paper
 * period at the current zoom), anchored at the scene origin. The tile is
 * rasterised at an integer size and the pattern transform absorbs the
 * sub-pixel remainder, so the texture never drifts against the drawing.
 */
function fillWithTile(
  context: CanvasRenderingContext2D,
  view: DeviceView,
  tileSize: number,
  drawTile: (tile: CanvasRenderingContext2D, size: number) => void,
): void {
  const size = Math.max(2, Math.round(tileSize));
  const tileCanvas = createScratchCanvas(size);
  const tile = tileCanvas?.getContext("2d") ?? null;
  if (tileCanvas === null || tile === null) return;
  tile.clearRect(0, 0, size, size);
  drawTile(tile, size);
  const pattern = context.createPattern(tileCanvas, "repeat");
  if (pattern === null) return;
  const scale = tileSize / size;
  const originX = view.scrollX * view.zoom * view.dpr;
  const originY = view.scrollY * view.zoom * view.dpr;
  if (typeof pattern.setTransform === "function" && "DOMMatrix" in globalThis) {
    pattern.setTransform(new DOMMatrix([scale, 0, 0, scale, originX, originY]));
  }
  context.fillStyle = pattern;
  context.fillRect(0, 0, view.deviceWidth, view.deviceHeight);
}

const scratchCanvases = new Map<number, HTMLCanvasElement>();

function createScratchCanvas(size: number): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  let canvas = scratchCanvases.get(size);
  if (canvas === undefined) {
    if (scratchCanvases.size > 24) scratchCanvases.clear();
    canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    scratchCanvases.set(size, canvas);
  }
  return canvas;
}
