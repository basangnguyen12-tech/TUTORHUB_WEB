/**
 * ADR-0041 classroom visual effects: the choice model, the curated education
 * backgrounds, personal background storage and the light preference store.
 *
 * Nothing here touches the camera or loads the processing runtime: the
 * pipeline lives in `features/media/visualEffectsProcessor.ts` and is only
 * loaded through `import()` once an effect runs on a live camera.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TranslationKey } from "./i18n";
import {
  NO_VISUAL_EFFECTS,
  VISUAL_EFFECTS_DATABASE_NAME,
  VISUAL_EFFECTS_PREFERENCE_PREFIX,
} from "./mediaPrejoin";

export const VISUAL_BACKGROUND_PRESET_IDS = [
  "academic-library",
  "modern-classroom",
  "nordic-study",
  "lecture-studio",
  "daylight-office",
  "warm-lounge",
  "botanical-calm",
] as const;

export type VisualBackgroundPresetId =
  (typeof VISUAL_BACKGROUND_PRESET_IDS)[number];
export type VisualBlurStrength = "light" | "strong";
export type VisualBackgroundState =
  | { kind: "none" }
  | { kind: "blur"; strength: VisualBlurStrength }
  | { kind: "preset"; presetId: VisualBackgroundPresetId }
  | { kind: "custom"; imageId: string };
export type VisualLightingBrightness = "normal" | "low_light" | "studio_bright";
export type VisualLightingTone = "natural" | "warm" | "crisp";

export interface VisualLightingState {
  brightness: VisualLightingBrightness;
  tone: VisualLightingTone;
}

export interface ClassroomVisualEffectsState {
  background: VisualBackgroundState;
  lighting: VisualLightingState;
}

export const DEFAULT_VISUAL_EFFECTS: ClassroomVisualEffectsState =
  NO_VISUAL_EFFECTS;

export const VISUAL_BLUR_RADIUS: Readonly<Record<VisualBlurStrength, number>> =
  Object.freeze({ light: 8, strong: 18 });

export const VISUAL_LIGHTING_BRIGHTNESS: readonly VisualLightingBrightness[] = [
  "normal",
  "low_light",
  "studio_bright",
];
export const VISUAL_LIGHTING_TONES: readonly VisualLightingTone[] = [
  "natural",
  "warm",
  "crisp",
];

export type VisualEffectsMode = "none" | "lighting" | "background";

export function hasActiveBackground(
  state: ClassroomVisualEffectsState,
): boolean {
  return state.background.kind !== "none";
}

export function hasActiveLighting(state: ClassroomVisualEffectsState): boolean {
  return (
    state.lighting.brightness !== "normal" || state.lighting.tone !== "natural"
  );
}

export function hasActiveVisualEffects(
  state: ClassroomVisualEffectsState,
): boolean {
  return hasActiveBackground(state) || hasActiveLighting(state);
}

/** `lighting` never loads the person-mask model; `background` does. */
export function visualEffectsMode(
  state: ClassroomVisualEffectsState,
): VisualEffectsMode {
  if (hasActiveBackground(state)) return "background";
  return hasActiveLighting(state) ? "lighting" : "none";
}

export function sameVisualEffects(
  left: ClassroomVisualEffectsState,
  right: ClassroomVisualEffectsState,
): boolean {
  return (
    backgroundKey(left.background) === backgroundKey(right.background) &&
    left.lighting.brightness === right.lighting.brightness &&
    left.lighting.tone === right.lighting.tone
  );
}

function backgroundKey(background: VisualBackgroundState): string {
  switch (background.kind) {
    case "none":
      return "none";
    case "blur":
      return `blur:${background.strength}`;
    case "preset":
      return `preset:${background.presetId}`;
    case "custom":
      return `custom:${background.imageId}`;
  }
}

const customImageIdPattern = /^[A-Za-z0-9-]{8,64}$/;

/** Parses untrusted (stored) input into a valid state; unknown → defaults. */
export function normalizeVisualEffects(
  value: unknown,
): ClassroomVisualEffectsState {
  if (!isRecord(value)) return DEFAULT_VISUAL_EFFECTS;
  return {
    background: normalizeBackground(value.background),
    lighting: normalizeLighting(value.lighting),
  };
}

function normalizeBackground(value: unknown): VisualBackgroundState {
  if (!isRecord(value)) return { kind: "none" };
  if (
    value.kind === "blur" &&
    (value.strength === "light" || value.strength === "strong")
  ) {
    return { kind: "blur", strength: value.strength };
  }
  if (value.kind === "preset" && isPresetId(value.presetId)) {
    return { kind: "preset", presetId: value.presetId };
  }
  if (
    value.kind === "custom" &&
    typeof value.imageId === "string" &&
    customImageIdPattern.test(value.imageId)
  ) {
    return { kind: "custom", imageId: value.imageId };
  }
  return { kind: "none" };
}

function normalizeLighting(value: unknown): VisualLightingState {
  if (!isRecord(value)) return { ...DEFAULT_VISUAL_EFFECTS.lighting };
  const brightness = VISUAL_LIGHTING_BRIGHTNESS.find(
    (item) => item === value.brightness,
  );
  const tone = VISUAL_LIGHTING_TONES.find((item) => item === value.tone);
  return { brightness: brightness ?? "normal", tone: tone ?? "natural" };
}

export function isPresetId(value: unknown): value is VisualBackgroundPresetId {
  return VISUAL_BACKGROUND_PRESET_IDS.some((id) => id === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// --- Render plan ------------------------------------------------------------

export type VisualEffectsBackgroundPlan =
  { kind: "blur"; blurRadius: number } | { kind: "image"; imageUrl: string };

/** What the pipeline needs: no ids, only resolved, same-origin image URLs. */
export type VisualEffectsRenderPlan =
  | { mode: "lighting"; lighting: VisualLightingState }
  | {
      mode: "background";
      background: VisualEffectsBackgroundPlan;
      lighting: VisualLightingState;
    };

/**
 * Turns a choice into a pipeline plan. A personal image that is not (yet)
 * available resolves like "no background" so lighting still applies.
 */
export function resolveVisualEffectsPlan(
  state: ClassroomVisualEffectsState,
  customImageUrl: (imageId: string) => string | null,
): VisualEffectsRenderPlan | null {
  const lighting = { ...state.lighting };
  const background = state.background;
  let backgroundPlan: VisualEffectsBackgroundPlan | null = null;
  if (background.kind === "blur") {
    backgroundPlan = {
      kind: "blur",
      blurRadius: VISUAL_BLUR_RADIUS[background.strength],
    };
  } else if (background.kind === "preset") {
    backgroundPlan = {
      kind: "image",
      imageUrl: visualBackgroundPresetUrl(background.presetId),
    };
  } else if (background.kind === "custom") {
    const imageUrl = customImageUrl(background.imageId);
    backgroundPlan = imageUrl ? { kind: "image", imageUrl } : null;
  }
  if (backgroundPlan) {
    return { mode: "background", background: backgroundPlan, lighting };
  }
  return hasActiveLighting(state) ? { mode: "lighting", lighting } : null;
}

/**
 * The 2D canvas filter for the lighting step. Deliberately subtle: it lifts a
 * dim face or warms/clears the tone, never reshapes or smooths features.
 */
export function lightingFilter(lighting: VisualLightingState): string {
  const parts: string[] = [];
  if (lighting.brightness === "low_light") {
    parts.push("brightness(1.22)", "contrast(1.05)");
  } else if (lighting.brightness === "studio_bright") {
    parts.push("brightness(1.12)", "contrast(1.1)", "saturate(1.05)");
  }
  if (lighting.tone === "warm") {
    parts.push("sepia(0.14)", "saturate(1.08)");
  } else if (lighting.tone === "crisp") {
    parts.push("contrast(1.05)", "saturate(1.1)", "hue-rotate(-4deg)");
  }
  return parts.length > 0 ? parts.join(" ") : "none";
}

// --- Runtime contracts (implemented by visualEffectsProcessor.ts) -----------

export interface StandaloneVisualEffectsHandle {
  readonly mode: "lighting" | "background";
  /** The processed camera stream for a preview `<video>`. */
  readonly stream: MediaStream;
  /** Applies a plan in place; `false` when the mode needs a new pipeline. */
  apply(plan: VisualEffectsRenderPlan): Promise<boolean>;
  /** Idempotent. Never stops the raw camera track it was given. */
  destroy(): Promise<void>;
}

export interface VisualEffectsRuntimeOptions {
  /** Called once when sustained overload trips the ADR-0031 §11 guard. */
  onOverload?: () => void;
}

export interface MediaVisualEffectsRuntime {
  supportsVisualEffects(mode: "lighting" | "background"): boolean;
  startStandaloneVisualEffects(
    track: MediaStreamTrack,
    plan: VisualEffectsRenderPlan,
    options?: VisualEffectsRuntimeOptions,
  ): Promise<StandaloneVisualEffectsHandle>;
}

// --- Curated education backgrounds -----------------------------------------
//
// Seven original 16:9 scenes (1600×900), drawn as SVG with layered gradients,
// soft light pools and a slight depth-of-field blur so the person in front
// stays the subject. No third-party imagery.

const sceneWidth = 1600;
const sceneHeight = 900;
const presetUrlCache = new Map<VisualBackgroundPresetId, string>();

export function visualBackgroundPresetUrl(
  id: VisualBackgroundPresetId,
): string {
  const cached = presetUrlCache.get(id);
  if (cached) return cached;
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    presetScene(id),
  )}`;
  presetUrlCache.set(id, url);
  return url;
}

export function presetScene(id: VisualBackgroundPresetId): string {
  switch (id) {
    case "academic-library":
      return academicLibrary();
    case "modern-classroom":
      return modernClassroom();
    case "nordic-study":
      return nordicStudy();
    case "lecture-studio":
      return lectureStudio();
    case "daylight-office":
      return daylightOffice();
    case "warm-lounge":
      return warmLounge();
    case "botanical-calm":
      return botanicalCalm();
  }
}

type GradientStop = readonly [offset: number, color: string, opacity?: number];

function stops(list: readonly GradientStop[]): string {
  return list
    .map(
      ([offset, color, opacity = 1]) =>
        `<stop offset="${offset}" stop-color="${color}" stop-opacity="${opacity}"/>`,
    )
    .join("");
}

function linear(
  id: string,
  list: readonly GradientStop[],
  x2 = 0,
  y2 = 1,
): string {
  return `<linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}">${stops(list)}</linearGradient>`;
}

function radial(
  id: string,
  cx: number,
  cy: number,
  r: number,
  list: readonly GradientStop[],
): string {
  return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${r}">${stops(list)}</radialGradient>`;
}

function box(
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  extra = "",
): string {
  return `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" fill="${fill}"${extra}/>`;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function glow(
  cx: number,
  cy: number,
  r: number,
  color: string,
  opacity: number,
) {
  const id = `g${Math.round(cx)}x${Math.round(cy)}r${Math.round(r)}`;
  return {
    def: radial(id, cx, cy, r, [
      [0, color, opacity],
      [1, color, 0],
    ]),
    shape: `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${id})"/>`,
  };
}

/** Deterministic pseudo-random sequence so a scene renders identically. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function bookRow(
  random: () => number,
  x: number,
  baseline: number,
  width: number,
  palette: readonly string[],
): string {
  let cursor = x + 4;
  const books: string[] = [];
  while (cursor < x + width - 18) {
    const bookWidth = 12 + Math.floor(random() * 16);
    if (cursor + bookWidth > x + width - 4) break;
    const height = 62 + Math.floor(random() * 40);
    const color = palette[Math.floor(random() * palette.length)] ?? "#6b4a2f";
    const lean = random() > 0.93;
    const transform = lean
      ? ` transform="rotate(-9 ${cursor} ${baseline})"`
      : "";
    books.push(
      box(cursor, baseline - height, bookWidth, height, color, transform),
      box(
        cursor + 2,
        baseline - height + 10,
        bookWidth - 4,
        3,
        "#f3e3c2",
        ` opacity="0.28"${transform}`,
      ),
    );
    cursor += bookWidth + (lean ? 10 : 1 + Math.floor(random() * 2));
    if (random() > 0.9) cursor += 18;
  }
  return books.join("");
}

function leaf(
  x: number,
  y: number,
  length: number,
  width: number,
  angle: number,
  fill: string,
  vein = "#ffffff",
): string {
  const l = length;
  const w = width;
  return `<g transform="translate(${x} ${y}) rotate(${angle})"><path d="M0 0C${w} ${-l * 0.25} ${w} ${-l * 0.72} 0 ${-l}C${-w} ${-l * 0.72} ${-w} ${-l * 0.25} 0 0Z" fill="${fill}"/><path d="M0 0L0 ${-l * 0.94}" stroke="${vein}" stroke-opacity="0.22" stroke-width="3"/></g>`;
}

function scene(defs: string, body: string, blur = 2.2): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sceneWidth}" height="${sceneHeight}" viewBox="0 0 ${sceneWidth} ${sceneHeight}">`,
    "<defs>",
    defs,
    `<filter id="dof" filterUnits="userSpaceOnUse" x="-60" y="-60" width="${sceneWidth + 120}" height="${sceneHeight + 120}"><feGaussianBlur stdDeviation="${blur}"/></filter>`,
    `<radialGradient id="vignette" cx="50%" cy="46%" r="72%"><stop offset="0.62" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.34"/></radialGradient>`,
    "</defs>",
    `<g filter="url(#dof)">${body}</g>`,
    `<rect width="${sceneWidth}" height="${sceneHeight}" fill="url(#vignette)"/>`,
    "</svg>",
  ].join("");
}

/** A rectangle larger than the frame so the blur never shows a dark edge. */
function bleed(fill: string): string {
  return box(-60, -60, sceneWidth + 120, sceneHeight + 120, fill);
}

function academicLibrary(): string {
  const random = seeded(11);
  const palette = [
    "#7a2e2a",
    "#2f4a3a",
    "#27384f",
    "#8a6a2f",
    "#5b3a52",
    "#9a4f2b",
    "#3e5c5a",
    "#b89659",
    "#6b2737",
    "#33415c",
  ];
  const lamp = glow(800, 40, 760, "#ffcf8a", 0.42);
  const pool = glow(800, 820, 520, "#ffb866", 0.18);
  const units = [70, 450, 830, 1210];
  const shelves = units
    .map((x) => {
      const rows = [250, 380, 510, 640]
        .map(
          (baseline) =>
            bookRow(random, x + 18, baseline, 284, palette) +
            box(x + 10, baseline, 300, 14, "#5f3d24") +
            box(x + 10, baseline, 300, 3, "#8a5d37"),
        )
        .join("");
      return (
        box(x, 96, 320, 670, "#3a2416") +
        box(x + 10, 110, 300, 640, "url(#shelfBack)") +
        rows +
        box(x, 96, 12, 670, "#4d301c") +
        box(x + 308, 96, 12, 670, "#4d301c") +
        box(x - 6, 84, 332, 20, "#5a391f")
      );
    })
    .join("");
  const boards = Array.from({ length: 9 }, (_, index) =>
    box(-60, 776 + index * 16, 1720, 1.5, "#000", ' opacity="0.16"'),
  ).join("");
  return scene(
    linear("wall", [
      [0, "#3d2617"],
      [1, "#22140c"],
    ]) +
      linear("shelfBack", [
        [0, "#2a1810"],
        [1, "#1b0f09"],
      ]) +
      linear("floor", [
        [0, "#4a2d18"],
        [1, "#1f120a"],
      ]) +
      lamp.def +
      pool.def,
    bleed("url(#wall)") +
      shelves +
      box(-60, 766, 1720, 200, "url(#floor)") +
      boards +
      lamp.shape +
      pool.shape,
  );
}

function modernClassroom(): string {
  const sun = glow(300, 300, 620, "#fff7e6", 0.55);
  const rays = `<path d="M110 120L520 120L980 900L-60 900Z" fill="#ffffff" opacity="0.16"/>`;
  const windowFrame =
    box(90, 110, 440, 520, "url(#sky)") +
    [90, 236, 383, 530]
      .map((x) => box(x - 6, 110, 12, 520, "#ffffff"))
      .join("") +
    box(84, 104, 452, 14, "#ffffff") +
    box(84, 366, 452, 10, "#ffffff") +
    box(84, 624, 452, 16, "#f1f3f5");
  const board =
    box(640, 160, 700, 330, "#c7d0d8") +
    box(652, 172, 676, 306, "#fbfcfd") +
    box(640, 490, 700, 14, "#aeb8c2") +
    `<path d="M700 420Q790 250 880 360T1060 300" stroke="#2f6fb5" stroke-width="7" fill="none" opacity="0.5" stroke-linecap="round"/>` +
    `<circle cx="1180" cy="300" r="70" stroke="#2e9a6a" stroke-width="7" fill="none" opacity="0.45"/>` +
    `<path d="M1110 300H1250M1180 230V370" stroke="#2e9a6a" stroke-width="5" opacity="0.35"/>`;
  const pendants = [760, 1000, 1240]
    .map(
      (x) =>
        box(x - 1.5, -60, 3, 120, "#3b4652") +
        `<path d="M${x - 46} 96Q${x} 40 ${x + 46} 96Z" fill="#33404c"/>` +
        `<ellipse cx="${x}" cy="98" rx="40" ry="8" fill="#fff4d6" opacity="0.9"/>`,
    )
    .join("");
  const desks = [
    { y: 720, left: 380, right: 1500, top: 26 },
    { y: 830, left: 220, right: 1640, top: 34 },
  ]
    .map(
      ({ y, left, right, top }) =>
        `<path d="M${left} ${y}L${right} ${y}L${right + 40} ${y + top}L${left - 40} ${y + top}Z" fill="#dcbf94"/>` +
        box(left - 40, y + top, right - left + 80, 8, "#b8976c") +
        [0.18, 0.42, 0.66, 0.9]
          .map((t) =>
            box(
              left + (right - left) * t - 30,
              y - 70,
              60,
              64,
              "#3f8f8b",
              ' rx="14"',
            ),
          )
          .join(""),
    )
    .join("");
  const plant =
    `<path d="M1470 640L1540 640L1528 720L1482 720Z" fill="#e7e1d8"/>` +
    leaf(1505, 640, 140, 30, -28, "#5f9a63") +
    leaf(1505, 640, 170, 34, 6, "#6fae70") +
    leaf(1505, 640, 130, 28, 36, "#4f8a55");
  return scene(
    linear("wall", [
      [0, "#f1f4f7"],
      [1, "#dde4ea"],
    ]) +
      linear("sky", [
        [0, "#bfe0f6"],
        [1, "#f2f8fc"],
      ]) +
      linear("floor", [
        [0, "#d3cabb"],
        [1, "#b6ab9a"],
      ]) +
      sun.def,
    bleed("url(#wall)") +
      box(-60, 690, 1720, 280, "url(#floor)") +
      windowFrame +
      sun.shape +
      rays +
      board +
      pendants +
      plant +
      desks,
  );
}

function nordicStudy(): string {
  const light = `<path d="M1660 40L1240 40L760 900L1660 900Z" fill="#ffffff" opacity="0.2"/>`;
  const print =
    box(980, 170, 290, 260, "#2b2b2b") +
    box(988, 178, 274, 244, "#fbfaf7") +
    `<circle cx="1080" cy="290" r="62" fill="#d9b38c"/>` +
    `<path d="M1050 390A90 90 0 0 1 1230 390Z" fill="#9db39a"/>` +
    box(1160, 220, 50, 120, "#c8775a", ' rx="25"');
  const shelf =
    box(280, 330, 420, 14, "#c9a97d") +
    box(300, 250, 34, 80, "#e9e4dc", ' rx="10"') +
    box(350, 270, 24, 60, "#8aa293", ' rx="8"') +
    box(420, 300, 120, 14, "#c8775a") +
    box(428, 286, 104, 14, "#d9cbb6") +
    box(436, 272, 88, 14, "#6f7f8f") +
    `<circle cx="620" cy="300" r="30" fill="#b7c3b5"/>`;
  const desk =
    box(150, 610, 640, 18, "#d9bf96") +
    box(180, 628, 14, 200, "#bfa47c") +
    box(746, 628, 14, 200, "#bfa47c") +
    `<path d="M300 610L320 470Q330 430 380 440" stroke="#222" stroke-width="7" fill="none"/>` +
    `<path d="M360 430L440 460L420 490Z" fill="#222"/>` +
    box(600, 560, 70, 50, "#ffffff", ' rx="10"') +
    leaf(635, 560, 80, 18, -20, "#7c9c6d") +
    leaf(635, 560, 90, 18, 18, "#8fb07f");
  const plant =
    `<path d="M1340 700L1460 700L1440 840L1360 840Z" fill="#f4f1ec"/>` +
    leaf(1400, 700, 260, 60, -24, "#6f8f62") +
    leaf(1400, 700, 300, 64, 4, "#87a878") +
    leaf(1400, 700, 230, 56, 34, "#5e7f55") +
    leaf(1380, 560, 160, 44, -48, "#7c9c6d");
  return scene(
    linear("wall", [
      [0, "#f4f0e9"],
      [1, "#e6dfd3"],
    ]) +
      linear("floor", [
        [0, "#dcc7a6"],
        [1, "#c3a882"],
      ]),
    bleed("url(#wall)") +
      box(-60, 650, 1720, 320, "url(#floor)") +
      box(-60, 640, 1720, 12, "#efe9df") +
      print +
      shelf +
      desk +
      plant +
      light,
    2.4,
  );
}

function lectureStudio(): string {
  const spotLeft = glow(560, 120, 520, "#ffe2a8", 0.28);
  const spotRight = glow(1060, 120, 520, "#ffe2a8", 0.24);
  const chalk = (path: string, width = 5, opacity = 0.55) =>
    `<path d="${path}" stroke="#f4f7f2" stroke-width="${width}" fill="none" opacity="${opacity}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const board =
    box(210, 120, 1180, 450, "#7a5532") +
    box(226, 136, 1148, 418, "url(#board)") +
    box(200, 566, 1200, 18, "#8a6340") +
    chalk("M300 480H700M320 500V200") +
    chalk("M330 470Q450 180 690 260", 6, 0.6) +
    chalk("M820 460L1000 220L1120 460Z") +
    chalk("M860 460A40 40 0 0 1 880 420", 4, 0.5) +
    `<circle cx="1240" cy="300" r="80" stroke="#f4f7f2" stroke-width="5" fill="none" opacity="0.5"/>` +
    chalk("M1240 300L1300 250", 4, 0.5) +
    chalk("M420 200H500M440 225H520M1180 440H1310M1180 470H1270", 4, 0.35) +
    chalk("M760 300H790M775 285V315", 4, 0.4);
  const lectern =
    `<path d="M1240 900L1290 680L1500 680L1550 900Z" fill="#6b4529"/>` +
    box(1270, 664, 260, 22, "#80583a");
  const panels = [0, 1, 2, 3, 4, 5, 6]
    .map((index) =>
      box(40 + index * 230, 660, 200, 150, "#000", ' opacity="0.12" rx="6"'),
    )
    .join("");
  return scene(
    linear("wall", [
      [0, "#2f3f38"],
      [1, "#24312b"],
    ]) +
      linear("board", [
        [0, "#28513f"],
        [1, "#1c3b2f"],
      ]) +
      linear("wood", [
        [0, "#71502f"],
        [1, "#4e3420"],
      ]) +
      spotLeft.def +
      spotRight.def,
    bleed("url(#wall)") +
      box(-60, 630, 1720, 340, "url(#wood)") +
      panels +
      box(-60, 624, 1720, 10, "#8a6340") +
      board +
      spotLeft.shape +
      spotRight.shape +
      lectern,
  );
}

function daylightOffice(): string {
  const random = seeded(5);
  const towers = Array.from({ length: 14 }, (_, index) => {
    const width = 70 + Math.floor(random() * 70);
    const height = 120 + Math.floor(random() * 230);
    const x = 170 + index * 92;
    const shade = index % 2 === 0 ? "#c6d4e1" : "#d6e1ea";
    return box(x, 560 - height, width, height, shade);
  }).join("");
  const mullions =
    [160, 480, 800, 1120, 1440]
      .map((x) => box(x - 7, 90, 14, 520, "#5a626c"))
      .join("") +
    box(153, 84, 1294, 12, "#5a626c") +
    box(153, 340, 1294, 8, "#5a626c") +
    box(140, 606, 1320, 18, "#e7e3dc");
  const trees = [260, 520, 900, 1250]
    .map(
      (x, index) =>
        `<ellipse cx="${x}" cy="${560 - (index % 2) * 10}" rx="90" ry="60" fill="${
          index % 2 ? "#9cc08f" : "#8ab47e"
        }"/>`,
    )
    .join("");
  const beam = `<path d="M240 90L760 90L1300 900L380 900Z" fill="#ffffff" opacity="0.16"/>`;
  const desk =
    box(-60, 700, 1720, 26, "#e3d3b8") +
    box(-60, 726, 1720, 10, "#c8b08c") +
    box(1180, 600, 220, 100, "#2c3238", ' rx="8"') +
    box(1270, 690, 40, 12, "#2c3238") +
    `<path d="M260 700L280 640L330 640L350 700Z" fill="#f2efe9"/>` +
    leaf(305, 640, 90, 22, -24, "#6aa36a") +
    leaf(305, 640, 110, 24, 10, "#7cb47a");
  return scene(
    linear("wall", [
      [0, "#f4f2ee"],
      [1, "#e5e1da"],
    ]) +
      linear("sky", [
        [0, "#a9d2f0"],
        [1, "#eef6fb"],
      ]) +
      linear("floor", [
        [0, "#ddd6cb"],
        [1, "#c8bfb2"],
      ]),
    bleed("url(#wall)") +
      box(-60, 736, 1720, 240, "url(#floor)") +
      box(160, 90, 1280, 520, "url(#sky)") +
      towers +
      trees +
      mullions +
      beam +
      desk,
  );
}

function warmLounge(): string {
  const random = seeded(23);
  const palette = [
    "#7b3b26",
    "#355a55",
    "#c08a4a",
    "#4b3a5a",
    "#8c5a2b",
    "#2f4058",
    "#a8653c",
    "#5d6b3a",
  ];
  const lamp = glow(300, 330, 460, "#ffc677", 0.5);
  const shelf =
    box(1060, 100, 460, 660, "#3a2014") +
    [260, 400, 540, 680]
      .map(
        (baseline) =>
          bookRow(random, 1080, baseline, 420, palette) +
          box(1070, baseline, 440, 14, "#5c3420"),
      )
      .join("");
  const chair =
    `<path d="M430 860L430 600Q430 520 520 520L760 520Q850 520 850 600L850 860Z" fill="#8b4a2b"/>` +
    `<path d="M380 860L380 680Q380 640 420 640L460 640L460 860Z" fill="#7a3f24"/>` +
    `<path d="M820 860L820 640L860 640Q900 640 900 680L900 860Z" fill="#7a3f24"/>` +
    box(460, 700, 360, 70, "#9a5532", ' rx="18"');
  const floorLamp =
    box(296, 400, 8, 460, "#2b211b") +
    `<path d="M230 400L370 400L340 300L260 300Z" fill="#f3e2c3"/>` +
    `<ellipse cx="300" cy="862" rx="60" ry="10" fill="#2b211b"/>`;
  const frame =
    box(560, 200, 300, 200, "#c79a5a") + box(574, 214, 272, 172, "url(#art)");
  return scene(
    linear("wall", [
      [0, "#9b5b3d"],
      [1, "#6b3825"],
    ]) +
      linear(
        "art",
        [
          [0, "#e6b88a"],
          [1, "#7f4f6a"],
        ],
        1,
        1,
      ) +
      linear("floor", [
        [0, "#4a2a1b"],
        [1, "#2a170e"],
      ]) +
      lamp.def,
    bleed("url(#wall)") +
      box(-60, 760, 1720, 210, "url(#floor)") +
      `<ellipse cx="660" cy="880" rx="560" ry="70" fill="#b5835a" opacity="0.55"/>` +
      shelf +
      frame +
      chair +
      floorLamp +
      lamp.shape,
  );
}

function botanicalCalm(): string {
  const random = seeded(31);
  const bokeh = Array.from(
    { length: 16 },
    () =>
      `<circle cx="${Math.floor(random() * 1600)}" cy="${Math.floor(random() * 600)}" r="${
        20 + Math.floor(random() * 50)
      }" fill="#ffffff" opacity="${(0.08 + random() * 0.16).toFixed(2)}"/>`,
  ).join("");
  const arch =
    `<path d="M600 660L600 300A200 200 0 0 1 1000 300L1000 660Z" fill="url(#archLight)"/>` +
    `<path d="M600 660L600 300A200 200 0 0 1 1000 300L1000 660" stroke="#f3f6ef" stroke-width="14" fill="none"/>` +
    box(793, 110, 14, 550, "#f3f6ef");
  const leftLeaves = [
    leaf(-20, 900, 520, 120, 32, "url(#leafA)"),
    leaf(80, 930, 460, 110, 12, "url(#leafB)"),
    leaf(-40, 640, 380, 90, 62, "url(#leafA)"),
    leaf(160, 960, 360, 80, -6, "url(#leafC)"),
  ].join("");
  const rightLeaves = [
    leaf(1620, 900, 540, 120, -34, "url(#leafB)"),
    leaf(1520, 940, 470, 110, -12, "url(#leafA)"),
    leaf(1640, 620, 400, 90, -64, "url(#leafC)"),
    leaf(1440, 970, 340, 80, 8, "url(#leafB)"),
  ].join("");
  const table =
    box(-60, 700, 1720, 270, "url(#stone)") +
    `<path d="M700 700L760 700L752 640L708 640Z" fill="#efe9de"/>` +
    leaf(730, 640, 90, 20, -16, "#5f8f62") +
    leaf(730, 640, 100, 22, 14, "#73a274");
  return scene(
    linear("wall", [
      [0, "#e1ebe0"],
      [1, "#b7cbb7"],
    ]) +
      linear("archLight", [
        [0, "#fbfdf8"],
        [1, "#dfe9dc"],
      ]) +
      linear("stone", [
        [0, "#e9e5db"],
        [1, "#d2ccbf"],
      ]) +
      linear("leafA", [
        [0, "#3f6b47"],
        [1, "#7aa57a"],
      ]) +
      linear("leafB", [
        [0, "#4f7a55"],
        [1, "#8fb98b"],
      ]) +
      linear("leafC", [
        [0, "#365c3e"],
        [1, "#5f8f62"],
      ]),
    bleed("url(#wall)") + arch + bokeh + table + leftLeaves + rightLeaves,
    2.6,
  );
}

// --- Light preference (localStorage, no personal data) ----------------------

export interface VisualEffectsScope {
  tenantId: string;
  userId: string;
}

export function visualEffectsScopeKey(scope: VisualEffectsScope): string {
  return `${scope.tenantId}\u0000${scope.userId}`;
}

function preferenceKey(scope: VisualEffectsScope): string {
  return `${VISUAL_EFFECTS_PREFERENCE_PREFIX}${encodeURIComponent(
    scope.tenantId,
  )}:${encodeURIComponent(scope.userId)}`;
}

function defaultPreferenceStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadVisualEffectsPreference(
  scope: VisualEffectsScope | null,
  storage: Storage | null = defaultPreferenceStorage(),
): ClassroomVisualEffectsState {
  if (!scope || !storage) return DEFAULT_VISUAL_EFFECTS;
  try {
    const raw = storage.getItem(preferenceKey(scope));
    if (!raw) return DEFAULT_VISUAL_EFFECTS;
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) && parsed.v === 1
      ? normalizeVisualEffects(parsed)
      : DEFAULT_VISUAL_EFFECTS;
  } catch {
    return DEFAULT_VISUAL_EFFECTS;
  }
}

export function saveVisualEffectsPreference(
  scope: VisualEffectsScope | null,
  state: ClassroomVisualEffectsState,
  storage: Storage | null = defaultPreferenceStorage(),
): void {
  if (!scope || !storage) return;
  try {
    if (!hasActiveVisualEffects(state)) {
      storage.removeItem(preferenceKey(scope));
      return;
    }
    storage.setItem(
      preferenceKey(scope),
      JSON.stringify({
        v: 1,
        background: state.background,
        lighting: state.lighting,
      }),
    );
  } catch {
    // Quota or privacy mode: the choice still applies for this session.
  }
}

// --- Personal backgrounds ---------------------------------------------------

export const CUSTOM_BACKGROUND_LIMIT = 4;
export const CUSTOM_BACKGROUND_MAX_BYTES = 8 * 1024 * 1024;
export const CUSTOM_BACKGROUND_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
export const CUSTOM_BACKGROUND_MAX_WIDTH = 1920;
export const CUSTOM_BACKGROUND_MAX_HEIGHT = 1080;
export const CUSTOM_BACKGROUND_QUALITY = 0.88;

export type CustomBackgroundErrorCode =
  | "unsupported_type"
  | "too_large"
  | "decode_failed"
  | "limit_reached"
  | "storage_unavailable";

export class CustomBackgroundError extends Error {
  readonly code: CustomBackgroundErrorCode;

  constructor(code: CustomBackgroundErrorCode) {
    super(code);
    this.name = "CustomBackgroundError";
    this.code = code;
  }
}

export interface CropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** Centred `object-fit: cover` crop of a source to the target aspect ratio. */
export function coverCropRect(
  sourceWidth: number,
  sourceHeight: number,
  targetAspect: number,
): CropRect {
  const sourceAspect = sourceWidth / sourceHeight;
  if (sourceAspect > targetAspect) {
    const sw = Math.round(sourceHeight * targetAspect);
    return {
      sx: Math.round((sourceWidth - sw) / 2),
      sy: 0,
      sw,
      sh: sourceHeight,
    };
  }
  const sh = Math.round(sourceWidth / targetAspect);
  return {
    sx: 0,
    sy: Math.round((sourceHeight - sh) / 2),
    sw: sourceWidth,
    sh,
  };
}

/** Never upscales; caps the 16:9 crop at 1920×1080. */
export function customBackgroundOutputSize(
  cropWidth: number,
  cropHeight: number,
): { width: number; height: number } {
  const scale = Math.min(
    1,
    CUSTOM_BACKGROUND_MAX_WIDTH / cropWidth,
    CUSTOM_BACKGROUND_MAX_HEIGHT / cropHeight,
  );
  return {
    width: Math.max(1, Math.round(cropWidth * scale)),
    height: Math.max(1, Math.round(cropHeight * scale)),
  };
}

export interface DecodedBackgroundImage {
  readonly width: number;
  readonly height: number;
  readonly source: CanvasImageSource;
  close(): void;
}

export interface BackgroundImagePipeline {
  decode(file: Blob): Promise<DecodedBackgroundImage>;
  encode(
    source: CanvasImageSource,
    crop: CropRect,
    size: { width: number; height: number },
  ): Promise<Blob>;
}

/**
 * Decodes, crops (cover 16:9) and re-encodes a personal image. Only pixels
 * survive the canvas round trip, so EXIF/GPS and any other metadata are gone.
 */
export async function prepareCustomBackground(
  file: Blob,
  pipeline: BackgroundImagePipeline = browserImagePipeline,
): Promise<{ blob: Blob; width: number; height: number }> {
  if (!CUSTOM_BACKGROUND_TYPES.some((type) => type === file.type)) {
    throw new CustomBackgroundError("unsupported_type");
  }
  if (file.size > CUSTOM_BACKGROUND_MAX_BYTES) {
    throw new CustomBackgroundError("too_large");
  }
  if (file.size === 0) {
    throw new CustomBackgroundError("decode_failed");
  }
  let image: DecodedBackgroundImage;
  try {
    image = await pipeline.decode(file);
  } catch {
    throw new CustomBackgroundError("decode_failed");
  }
  try {
    if (image.width < 2 || image.height < 2) {
      throw new CustomBackgroundError("decode_failed");
    }
    const crop = coverCropRect(image.width, image.height, 16 / 9);
    const size = customBackgroundOutputSize(crop.sw, crop.sh);
    let blob: Blob;
    try {
      blob = await pipeline.encode(image.source, crop, size);
    } catch {
      throw new CustomBackgroundError("decode_failed");
    }
    if (blob.size === 0) {
      throw new CustomBackgroundError("decode_failed");
    }
    return { blob, ...size };
  } finally {
    image.close();
  }
}

const browserImagePipeline: BackgroundImagePipeline = {
  async decode(file) {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
    });
    return {
      width: bitmap.width,
      height: bitmap.height,
      source: bitmap,
      close: () => bitmap.close(),
    };
  },
  async encode(source, crop, size) {
    const draw = (context: CanvasDrawingSurface) => {
      // JPEG has no alpha: transparent PNG pixels become white, not black.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, size.width, size.height);
      context.imageSmoothingQuality = "high";
      context.drawImage(
        source,
        crop.sx,
        crop.sy,
        crop.sw,
        crop.sh,
        0,
        0,
        size.width,
        size.height,
      );
    };
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(size.width, size.height);
      try {
        const context = canvas.getContext("2d");
        if (!context) throw new Error("canvas_unavailable");
        draw(context);
        return await canvas.convertToBlob({
          type: "image/jpeg",
          quality: CUSTOM_BACKGROUND_QUALITY,
        });
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    try {
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas_unavailable");
      draw(context);
      return await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("encode_failed"))),
          "image/jpeg",
          CUSTOM_BACKGROUND_QUALITY,
        ),
      );
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  },
};

type CanvasDrawingSurface =
  CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface CustomBackgroundRecord {
  /** Primary key: `${scopeKey}\u0000${id}`. */
  key: string;
  scopeKey: string;
  id: string;
  blob: Blob;
  width: number;
  height: number;
  createdAt: number;
}

/** Device-local store; images never leave the browser. */
export interface CustomBackgroundStore {
  list(scopeKey: string): Promise<CustomBackgroundRecord[]>;
  /** Adds atomically, rejecting with `limit_reached` past `limit`. */
  add(record: CustomBackgroundRecord, limit: number): Promise<void>;
  remove(scopeKey: string, id: string): Promise<void>;
}

export async function addCustomBackground(
  store: CustomBackgroundStore,
  scopeKey: string,
  file: Blob,
  options: {
    pipeline?: BackgroundImagePipeline;
    createId?: () => string;
    now?: () => number;
  } = {},
): Promise<CustomBackgroundRecord> {
  // Fail fast before decoding when the library is already full.
  if ((await store.list(scopeKey)).length >= CUSTOM_BACKGROUND_LIMIT) {
    throw new CustomBackgroundError("limit_reached");
  }
  const prepared = await prepareCustomBackground(file, options.pipeline);
  const id = (options.createId ?? (() => globalThis.crypto.randomUUID()))();
  const record: CustomBackgroundRecord = {
    key: `${scopeKey}\u0000${id}`,
    scopeKey,
    id,
    blob: prepared.blob,
    width: prepared.width,
    height: prepared.height,
    createdAt: (options.now ?? Date.now)(),
  };
  await store.add(record, CUSTOM_BACKGROUND_LIMIT);
  return record;
}

export function createMemoryBackgroundStore(): CustomBackgroundStore {
  const records = new Map<string, CustomBackgroundRecord>();
  return {
    async list(scopeKey) {
      return [...records.values()]
        .filter((record) => record.scopeKey === scopeKey)
        .sort((left, right) => left.createdAt - right.createdAt);
    },
    async add(record, limit) {
      const count = [...records.values()].filter(
        (item) => item.scopeKey === record.scopeKey,
      ).length;
      if (count >= limit) throw new CustomBackgroundError("limit_reached");
      records.set(record.key, record);
    },
    async remove(scopeKey, id) {
      records.delete(`${scopeKey}\u0000${id}`);
    },
  };
}

const backgroundObjectStore = "backgrounds";

export function createIndexedDbBackgroundStore(
  databases: IDBFactory | null = typeof indexedDB === "undefined"
    ? null
    : indexedDB,
): CustomBackgroundStore | null {
  if (!databases) return null;
  const factory = databases;

  function open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(VISUAL_EFFECTS_DATABASE_NAME, 1);
      } catch {
        reject(new CustomBackgroundError("storage_unavailable"));
        return;
      }
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(backgroundObjectStore)) {
          database
            .createObjectStore(backgroundObjectStore, { keyPath: "key" })
            .createIndex("scope", "scopeKey", { unique: false });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        // Sign-out deletes the database; never hold it open against that.
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () =>
        reject(new CustomBackgroundError("storage_unavailable"));
      request.onblocked = () =>
        reject(new CustomBackgroundError("storage_unavailable"));
    });
  }

  async function run<T>(
    mode: IDBTransactionMode,
    work: (
      store: IDBObjectStore,
      finish: (value: T) => void,
      fail: (error: unknown) => void,
    ) => void,
  ): Promise<T> {
    const database = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        let result: { value: T } | null = null;
        let failure: unknown = null;
        let transaction: IDBTransaction;
        try {
          transaction = database.transaction(backgroundObjectStore, mode);
        } catch {
          reject(new CustomBackgroundError("storage_unavailable"));
          return;
        }
        const fail = (error: unknown) => {
          failure = error;
          try {
            transaction.abort();
          } catch {
            // The transaction already finished.
          }
        };
        transaction.oncomplete = () =>
          result
            ? resolve(result.value)
            : reject(
                failure ?? new CustomBackgroundError("storage_unavailable"),
              );
        transaction.onabort = () =>
          reject(failure ?? new CustomBackgroundError("storage_unavailable"));
        try {
          work(
            transaction.objectStore(backgroundObjectStore),
            (value) => {
              result = { value };
            },
            fail,
          );
        } catch (error) {
          fail(error);
        }
      });
    } finally {
      database.close();
    }
  }

  return {
    list(scopeKey) {
      return run<CustomBackgroundRecord[]>("readonly", (store, finish) => {
        const request = store.index("scope").getAll(IDBKeyRange.only(scopeKey));
        request.onsuccess = () => {
          const records = (request.result as unknown[]).filter(
            (value): value is CustomBackgroundRecord =>
              isStoredBackground(value) && value.scopeKey === scopeKey,
          );
          finish(
            records.sort((left, right) => left.createdAt - right.createdAt),
          );
        };
      });
    },
    add(record, limit) {
      return run<void>("readwrite", (store, finish, fail) => {
        const count = store
          .index("scope")
          .count(IDBKeyRange.only(record.scopeKey));
        count.onsuccess = () => {
          if (count.result >= limit) {
            fail(new CustomBackgroundError("limit_reached"));
            return;
          }
          store.put(record).onsuccess = () => finish(undefined);
        };
      });
    },
    remove(scopeKey, id) {
      return run<void>("readwrite", (store, finish) => {
        store.delete(`${scopeKey}\u0000${id}`).onsuccess = () =>
          finish(undefined);
      });
    },
  };
}

function isStoredBackground(value: unknown): value is CustomBackgroundRecord {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    typeof value.scopeKey === "string" &&
    typeof value.id === "string" &&
    value.blob instanceof Blob &&
    typeof value.width === "number" &&
    typeof value.height === "number" &&
    typeof value.createdAt === "number"
  );
}

// --- React hook: personal backgrounds with object URL ownership -------------

export interface CustomBackgroundItem {
  id: string;
  url: string;
}

export type CustomBackgroundLibraryStatus =
  "disabled" | "unavailable" | "loading" | "ready" | "error";

export interface CustomBackgroundLibrary {
  status: CustomBackgroundLibraryStatus;
  items: readonly CustomBackgroundItem[];
  canAdd: boolean;
  add(file: Blob): Promise<CustomBackgroundItem>;
  remove(id: string): Promise<void>;
  urlFor(id: string): string | null;
}

export interface ObjectUrlFactory {
  create(blob: Blob): string;
  revoke(url: string): void;
}

const browserObjectUrls: ObjectUrlFactory = {
  create: (blob) => URL.createObjectURL(blob),
  revoke: (url) => URL.revokeObjectURL(url),
};

const noCustomBackgrounds: readonly CustomBackgroundItem[] = [];

interface OwnedUrls {
  closed: boolean;
  urls: Map<string, string>;
}

/**
 * Lists the personal backgrounds of one (tenant, user) and owns their `blob:`
 * URLs: every URL is revoked on removal, scope change and unmount.
 */
export function useCustomBackgrounds(
  scope: VisualEffectsScope | null,
  options: {
    store?: CustomBackgroundStore | null;
    objectUrls?: ObjectUrlFactory;
    pipeline?: BackgroundImagePipeline;
  } = {},
): CustomBackgroundLibrary {
  const scopeKey = scope ? visualEffectsScopeKey(scope) : "";
  const [store] = useState<CustomBackgroundStore | null>(() =>
    options.store === undefined
      ? createIndexedDbBackgroundStore()
      : options.store,
  );
  const [objectUrls] = useState(() => options.objectUrls ?? browserObjectUrls);
  const [pipeline] = useState(() => options.pipeline);
  const [library, setLibrary] = useState<{
    scopeKey: string;
    status: "ready" | "error";
    items: readonly CustomBackgroundItem[];
  }>({ scopeKey: "", status: "ready", items: [] });
  const owned = useRef<OwnedUrls>({ closed: true, urls: new Map() });

  useEffect(() => {
    if (!scopeKey || !store) return undefined;
    const current: OwnedUrls = { closed: false, urls: new Map() };
    owned.current = current;
    void store.list(scopeKey).then(
      (records) => {
        if (current.closed) return;
        const items = records.map((record) => {
          const url = objectUrls.create(record.blob);
          current.urls.set(record.id, url);
          return { id: record.id, url };
        });
        setLibrary({ scopeKey, status: "ready", items });
      },
      () => {
        if (!current.closed) {
          setLibrary({ scopeKey, status: "error", items: [] });
        }
      },
    );
    return () => {
      current.closed = true;
      for (const url of current.urls.values()) objectUrls.revoke(url);
      current.urls.clear();
    };
  }, [objectUrls, scopeKey, store]);

  const status: CustomBackgroundLibraryStatus = !scopeKey
    ? "disabled"
    : !store
      ? "unavailable"
      : library.scopeKey !== scopeKey
        ? "loading"
        : library.status;
  const items = useMemo(
    () =>
      status === "ready" && library.scopeKey === scopeKey
        ? library.items
        : noCustomBackgrounds,
    [library.items, library.scopeKey, scopeKey, status],
  );

  const add = useCallback(
    async (file: Blob): Promise<CustomBackgroundItem> => {
      if (!scopeKey || !store) {
        throw new CustomBackgroundError("storage_unavailable");
      }
      const record = await addCustomBackground(store, scopeKey, file, {
        pipeline,
      });
      const current = owned.current;
      if (current.closed) {
        throw new CustomBackgroundError("storage_unavailable");
      }
      const url = objectUrls.create(record.blob);
      current.urls.set(record.id, url);
      const item = { id: record.id, url };
      setLibrary((previous) =>
        previous.scopeKey === scopeKey
          ? { ...previous, items: [...previous.items, item] }
          : previous,
      );
      return item;
    },
    [objectUrls, pipeline, scopeKey, store],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      if (!scopeKey || !store) return;
      await store.remove(scopeKey, id);
      const current = owned.current;
      const url = current.urls.get(id);
      if (url) {
        current.urls.delete(id);
        objectUrls.revoke(url);
      }
      setLibrary((previous) =>
        previous.scopeKey === scopeKey
          ? {
              ...previous,
              items: previous.items.filter((item) => item.id !== id),
            }
          : previous,
      );
    },
    [objectUrls, scopeKey, store],
  );

  const urlFor = useCallback(
    (id: string) => items.find((item) => item.id === id)?.url ?? null,
    [items],
  );

  return {
    status,
    items,
    canAdd: status === "ready" && items.length < CUSTOM_BACKGROUND_LIMIT,
    add,
    remove,
    urlFor,
  };
}

/**
 * A stored personal background that no longer exists falls back to "none"
 * once the library has loaded; while it loads the choice is kept.
 */
export function effectiveVisualEffects(
  state: ClassroomVisualEffectsState,
  library: Pick<CustomBackgroundLibrary, "status" | "urlFor">,
): ClassroomVisualEffectsState {
  if (state.background.kind !== "custom") return state;
  if (library.status === "loading") return state;
  return library.urlFor(state.background.imageId)
    ? state
    : { ...state, background: { kind: "none" } };
}

export { clearVisualEffectsDeviceStorage as clearVisualEffectsStorage } from "./mediaPrejoin";

/** The short name of the active effect, for badges and status text. */
export function visualEffectsSummaryKey(
  state: ClassroomVisualEffectsState,
): TranslationKey {
  const background = state.background;
  switch (background.kind) {
    case "blur":
      return background.strength === "light"
        ? "media.fx.blurLight"
        : "media.fx.blurStrong";
    case "preset":
      return `media.fx.preset.${background.presetId}`;
    case "custom":
      return "media.fx.short.custom";
    case "none":
      break;
  }
  if (state.lighting.brightness !== "normal") {
    return `media.fx.short.${state.lighting.brightness}`;
  }
  if (state.lighting.tone !== "natural") {
    return `media.fx.short.${state.lighting.tone}`;
  }
  return "media.fx.none";
}
