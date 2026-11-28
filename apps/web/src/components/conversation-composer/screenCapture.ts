/**
 * MSG-COMPOSER-TOOLS-01: in-browser screenshot capture for the conversation
 * composer.
 *
 * Privacy contract: one frame is read from the display stream and every track
 * is stopped in `finally`, whether the capture succeeds, fails or is
 * cancelled. The frame only ever lives in a canvas in this tab; nothing is
 * uploaded until the person confirms the crop and the normal staged-upload
 * path takes over (and nothing is sent until they press Send).
 */
import { CHAT_IMAGE_MAX_EDGE } from "../../features/media/classroomChatMedia";

/** `screen`: capture now. `delayed`: exclude this tab, wait, then capture. */
export type ScreenCaptureMode = "screen" | "delayed";

export const SCREEN_CAPTURE_DELAY_SECONDS = 3;
/** Above this size a PNG screenshot is re-encoded as JPEG (limit is 5 MiB). */
export const SCREENSHOT_PNG_BUDGET_BYTES = 4.5 * 1024 * 1024;
/** Smallest crop edge, in source pixels. */
export const SCREENSHOT_MIN_EDGE_PX = 16;

type CapturePreference = "include" | "exclude";

/** `DisplayMediaStreamOptions` plus the Chromium-only hints (MDN, Chrome 112+). */
export type DisplayCaptureOptions = DisplayMediaStreamOptions & {
  selfBrowserSurface?: CapturePreference;
  surfaceSwitching?: CapturePreference;
};

interface DisplayMediaSource {
  getDisplayMedia(options?: DisplayMediaStreamOptions): Promise<MediaStream>;
}

export function isScreenCaptureSupported(
  source:
    | { mediaDevices?: Partial<DisplayMediaSource> }
    | undefined = typeof navigator === "undefined" ? undefined : navigator,
): boolean {
  return typeof source?.mediaDevices?.getDisplayMedia === "function";
}

export function displayCaptureOptions(
  mode: ScreenCaptureMode,
): DisplayCaptureOptions {
  return {
    audio: false,
    video: { displaySurface: "monitor" },
    // Switching the shared surface mid-capture makes no sense for a still.
    surfaceSwitching: "exclude",
    // The delayed mode is the web stand-in for "hide the current window":
    // Chromium leaves this TutorHub tab out of the picker.
    selfBrowserSurface: mode === "delayed" ? "exclude" : "include",
  };
}

/** True for a picker the person dismissed or a permission they denied. */
export function isCaptureCancellation(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "NotAllowedError" || error.name === "AbortError")
  );
}

function abortError() {
  return new DOMException("Screen capture was cancelled.", "AbortError");
}

function waitForCountdown(
  seconds: number,
  track: MediaStreamTrack,
  signal: AbortSignal | undefined,
  onTick: ((remaining: number) => void) | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let remaining = seconds;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      track.removeEventListener("ended", cancel);
    };
    // Either Cancel in TutorHub or the browser's "Stop sharing" ends it.
    const cancel = () => {
      cleanup();
      reject(abortError());
    };
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    signal?.addEventListener("abort", cancel, { once: true });
    track.addEventListener("ended", cancel, { once: true });
    const tick = () => {
      if (remaining <= 0) {
        cleanup();
        resolve();
        return;
      }
      onTick?.(remaining);
      remaining -= 1;
      timer = setTimeout(tick, 1_000);
    };
    tick();
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  fallback: T,
) {
  return Promise.race([
    promise,
    new Promise<T>((resolve) =>
      setTimeout(() => resolve(fallback), milliseconds),
    ),
  ]);
}

/** Draws the newest presented frame of a display stream into a canvas. */
export async function readVideoFrame(
  stream: MediaStream,
): Promise<HTMLCanvasElement> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await video.play();
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      const ready = await withTimeout(
        new Promise<boolean>((resolve) =>
          video.addEventListener("loadeddata", () => resolve(true), {
            once: true,
          }),
        ),
        3_000,
        false,
      );
      if (!ready) throw new Error("The shared surface produced no frame.");
    }
    // A background tab may never run video-frame callbacks, so bound it.
    if (typeof video.requestVideoFrameCallback === "function") {
      await withTimeout(
        new Promise<void>((resolve) => {
          video.requestVideoFrameCallback(() => resolve());
        }),
        250,
        undefined,
      );
    }
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (width === 0 || height === 0) {
      throw new Error("The shared surface has no size.");
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable.");
    context.drawImage(video, 0, 0, width, height);
    return canvas;
  } finally {
    video.pause();
    video.srcObject = null;
  }
}

export interface CaptureScreenFrameOptions {
  mode: ScreenCaptureMode;
  mediaDevices?: DisplayMediaSource;
  /** Called with 3, 2, 1 before a delayed capture. */
  onCountdown?: (remaining: number) => void;
  readFrame?: (stream: MediaStream) => Promise<HTMLCanvasElement>;
  signal?: AbortSignal;
  delaySeconds?: number;
}

/**
 * Must be called from a user activation (click or the keyboard shortcut).
 * Rejects with an `AbortError`/`NotAllowedError` DOMException on cancel.
 */
export async function captureScreenFrame({
  delaySeconds = SCREEN_CAPTURE_DELAY_SECONDS,
  mediaDevices = navigator.mediaDevices,
  mode,
  onCountdown,
  readFrame = readVideoFrame,
  signal,
}: CaptureScreenFrameOptions): Promise<HTMLCanvasElement> {
  const stream = await mediaDevices.getDisplayMedia(
    displayCaptureOptions(mode),
  );
  try {
    const [track] = stream.getVideoTracks();
    if (!track) throw new Error("The shared surface has no video track.");
    if (signal?.aborted) throw abortError();
    if (mode === "delayed" && delaySeconds > 0) {
      await waitForCountdown(delaySeconds, track, signal, onCountdown);
    }
    return await readFrame(stream);
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}

type ShortcutEvent = Pick<
  KeyboardEvent,
  | "altKey"
  | "code"
  | "ctrlKey"
  | "getModifierState"
  | "isComposing"
  | "metaKey"
  | "repeat"
  | "shiftKey"
>;

/**
 * Ctrl+Alt+X (Ctrl+Option+X on macOS), matched on the physical key so
 * Option's character remapping does not matter. AltGr reports Ctrl+Alt on
 * Windows layouts and is left alone so it can still type characters.
 */
export function isCaptureShortcut(event: ShortcutEvent): boolean {
  return (
    event.code === "KeyX" &&
    event.ctrlKey &&
    event.altKey &&
    !event.shiftKey &&
    !event.metaKey &&
    !event.repeat &&
    !event.isComposing &&
    !event.getModifierState("AltGraph")
  );
}

function isApplePlatform() {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ?? navigator.platform;
  return /mac|iphone|ipad/i.test(platform);
}

/** Visible shortcut text; `aria-keyshortcuts` always uses the ARIA names. */
export function captureShortcutLabel() {
  return isApplePlatform() ? "Ctrl+Option+X" : "Ctrl+Alt+X";
}

/** A crop in fractions (0..1) of the captured image. */
export interface CropSelection {
  height: number;
  width: number;
  x: number;
  y: number;
}

export const FULL_SELECTION: CropSelection = {
  height: 1,
  width: 1,
  x: 0,
  y: 0,
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

/** Keeps a crop inside the image and at least `minimum` (fraction) wide/tall. */
export function clampSelection(
  selection: CropSelection,
  minimum: { height: number; width: number },
): CropSelection {
  const width = clamp(selection.width, Math.min(minimum.width, 1), 1);
  const height = clamp(selection.height, Math.min(minimum.height, 1), 1);
  return {
    height,
    width,
    x: clamp(selection.x, 0, 1 - width),
    y: clamp(selection.y, 0, 1 - height),
  };
}

/** The crop spanned by two points (any drag direction). */
export function selectionFromPoints(
  start: { x: number; y: number },
  end: { x: number; y: number },
): CropSelection {
  const x = clamp(Math.min(start.x, end.x), 0, 1);
  const y = clamp(Math.min(start.y, end.y), 0, 1);
  return {
    height: clamp(Math.max(start.y, end.y), 0, 1) - y,
    width: clamp(Math.max(start.x, end.x), 0, 1) - x,
    x,
    y,
  };
}

export function selectionToPixels(
  selection: CropSelection,
  size: { height: number; width: number },
) {
  const x = clamp(Math.round(selection.x * size.width), 0, size.width - 1);
  const y = clamp(Math.round(selection.y * size.height), 0, size.height - 1);
  return {
    height: clamp(
      Math.round(selection.height * size.height),
      1,
      size.height - y,
    ),
    width: clamp(Math.round(selection.width * size.width), 1, size.width - x),
    x,
    y,
  };
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob && blob.size > 0
          ? resolve(blob)
          : reject(new Error("Screenshot encoding failed.")),
      type,
      quality,
    );
  });
}

function timestamp(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Crops the capture, bounds the longest edge to the chat image limit and
 * encodes PNG (sharp text), falling back to JPEG when PNG is too large.
 */
export async function exportScreenshot(
  source: HTMLCanvasElement,
  selection: CropSelection,
  now = new Date(),
): Promise<File> {
  const crop = selectionToPixels(selection, source);
  const scale = Math.min(
    1,
    CHAT_IMAGE_MAX_EDGE / Math.max(crop.width, crop.height, 1),
  );
  const output = document.createElement("canvas");
  output.width = Math.max(1, Math.round(crop.width * scale));
  output.height = Math.max(1, Math.round(crop.height * scale));
  const context = output.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable.");
  context.drawImage(
    source,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    output.width,
    output.height,
  );
  try {
    let blob = await canvasToBlob(output, "image/png");
    let extension = "png";
    if (blob.size > SCREENSHOT_PNG_BUDGET_BYTES) {
      blob = await canvasToBlob(output, "image/jpeg", 0.9);
      extension = "jpg";
    }
    return new File([blob], `screenshot-${timestamp(now)}.${extension}`, {
      type: blob.type || (extension === "png" ? "image/png" : "image/jpeg"),
    });
  } finally {
    output.width = 0;
    output.height = 0;
  }
}
