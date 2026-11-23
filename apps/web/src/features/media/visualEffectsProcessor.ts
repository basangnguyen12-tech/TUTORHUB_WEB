/**
 * ADR-0041 visual effects pipeline. Loaded only through `import()` once an
 * effect is enabled on a live camera; never imported statically by the
 * Pre-Join page or the entry chunk.
 *
 * Two modes share one `ProcessorWrapper` lifecycle from
 * `@livekit/track-processors` (Apache-2.0):
 *
 * - `lighting`: a light 2D-canvas filter transformer. It never loads the
 *   MediaPipe runtime or the person-mask model, so low-end devices can still
 *   publish a brightened face.
 * - `background`: the library's `BackgroundTransformer` (blur or image) with
 *   same-origin assets. When lighting is also chosen, it runs as one extra 2D
 *   pass on each output frame — no second person-mask runner, no second
 *   pipeline.
 */
import {
  BackgroundTransformer,
  LogLevel,
  ProcessorWrapper,
  setLogLevel,
  supportsBackgroundProcessors,
  type BackgroundOptions,
  type TrackTransformerDestroyOptions,
  type VideoTrackTransformer,
  type VideoTransformerInitOptions,
} from "@livekit/track-processors";
import { Track, type ProcessorOptions } from "livekit-client";
import {
  lightingFilter,
  type MediaVisualEffectsRuntime,
  type StandaloneVisualEffectsHandle,
  type VisualEffectsRenderPlan,
  type VisualEffectsRuntimeOptions,
  type VisualLightingState,
} from "../../app/visualEffects";

/** Same-origin, versioned assets (see public/vendor/mediapipe/NOTICE.txt). */
export const VISUAL_EFFECTS_ASSET_PATHS = Object.freeze({
  tasksVisionFileSet: "/vendor/mediapipe/wasm",
  modelAssetPath: "/vendor/mediapipe/models/selfie_segmenter.tflite",
});

/** ADR-0031 §11 runtime guard thresholds. */
export const VISUAL_EFFECTS_GUARD = Object.freeze({
  windowMs: 5_000,
  minFps: 12,
  maxP95Ms: 50,
  badWindows: 3,
});

// Processor internals log raw errors; the classroom keeps provider logs quiet.
setLogLevel(LogLevel.silent);

type EffectsMode = "lighting" | "background";

// --- Capability checks -------------------------------------------------------

export function supportsCanvasFilter(
  context: { filter: string } | null | undefined,
): boolean {
  if (!context || typeof context.filter !== "string") return false;
  const probe = "brightness(1.5)";
  context.filter = probe;
  const supported = context.filter === probe;
  context.filter = "none";
  return supported;
}

interface LightingSurface {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
}

export function createLightingSurface(
  width: number,
  height: number,
): LightingSurface | null {
  try {
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      return context ? { canvas, context } : null;
    }
    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    return context ? { canvas, context } : null;
  } catch {
    return null;
  }
}

export function supportsVisualEffects(
  mode: EffectsMode,
  probe: (
    width: number,
    height: number,
  ) => LightingSurface | null = createLightingSurface,
): boolean {
  try {
    if (mode === "background") return supportsBackgroundProcessors();
    if (!ProcessorWrapper.isSupported || typeof VideoFrame === "undefined") {
      return false;
    }
    const surface = probe(2, 2);
    const supported = supportsCanvasFilter(surface?.context);
    if (surface) {
      surface.canvas.width = 0;
      surface.canvas.height = 0;
    }
    return supported;
  } catch {
    return false;
  }
}

// --- Runtime guard -----------------------------------------------------------

/**
 * Trips once after three consecutive 5 s windows below 12 fps or above
 * 50 ms p95 processing time. Evaluated from frame callbacks: no timers.
 */
export class EffectsPerformanceGuard {
  private windowStart: number | null = null;
  private samples: number[] = [];
  private badStreak = 0;
  private tripped = false;

  constructor(
    private readonly onOverload: () => void,
    private readonly now: () => number = () => performance.now(),
    private readonly thresholds = VISUAL_EFFECTS_GUARD,
  ) {}

  record(durationMs: number): void {
    if (this.tripped) return;
    const now = this.now();
    if (this.windowStart === null) this.windowStart = now;
    this.samples.push(durationMs);
    const elapsed = now - this.windowStart;
    if (elapsed < this.thresholds.windowMs) return;
    const fps = (this.samples.length * 1_000) / elapsed;
    const sorted = [...this.samples].sort((left, right) => left - right);
    const p95 =
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ??
      0;
    const bad = fps < this.thresholds.minFps || p95 > this.thresholds.maxP95Ms;
    this.badStreak = bad ? this.badStreak + 1 : 0;
    this.windowStart = now;
    this.samples = [];
    if (this.badStreak >= this.thresholds.badWindows) {
      this.tripped = true;
      this.onOverload();
    }
  }
}

// --- Lighting step -----------------------------------------------------------

/**
 * Applies the lighting filter to one frame through a reusable 2D canvas. The
 * input frame is closed (in `finally`) only once a replacement exists; any
 * failure passes the original frame through unchanged.
 */
export class LightingStage {
  private surface: LightingSurface | null = null;
  private supported: boolean | null = null;
  private filter = "none";

  constructor(
    private readonly createSurface: (
      width: number,
      height: number,
    ) => LightingSurface | null = createLightingSurface,
  ) {}

  get active(): boolean {
    return this.filter !== "none" && this.supported !== false;
  }

  setLighting(lighting: VisualLightingState): void {
    this.filter = lightingFilter(lighting);
  }

  apply(frame: VideoFrame): VideoFrame {
    if (this.filter === "none") return frame;
    const width = frame.displayWidth;
    const height = frame.displayHeight;
    if (!width || !height) return frame;
    const surface = this.prepare(width, height);
    if (!surface) return frame;
    let output: VideoFrame | null = null;
    try {
      surface.context.filter = this.filter;
      surface.context.drawImage(frame, 0, 0, width, height);
      output = new VideoFrame(surface.canvas, {
        timestamp: frame.timestamp,
        ...(frame.duration ? { duration: frame.duration } : {}),
      });
      return output;
    } catch {
      return frame;
    } finally {
      if (output) frame.close();
    }
  }

  /** Wraps a stream controller so every enqueued frame gets the lighting pass. */
  wrapController(
    controller: TransformStreamDefaultController<VideoFrame>,
  ): TransformStreamDefaultController<VideoFrame> {
    return {
      get desiredSize() {
        return controller.desiredSize;
      },
      enqueue: (chunk?: VideoFrame) => {
        if (!chunk) {
          controller.enqueue(chunk);
          return;
        }
        const output = this.apply(chunk);
        try {
          controller.enqueue(output);
        } catch (error) {
          output.close();
          throw error;
        }
      },
      error: (reason?: unknown) => controller.error(reason),
      terminate: () => controller.terminate(),
    };
  }

  release(): void {
    if (this.surface) {
      this.surface.canvas.width = 0;
      this.surface.canvas.height = 0;
    }
    this.surface = null;
    this.supported = null;
  }

  private prepare(width: number, height: number): LightingSurface | null {
    if (!this.surface) {
      this.surface = this.createSurface(width, height);
      this.supported = supportsCanvasFilter(this.surface?.context);
    }
    if (!this.surface || !this.supported) return null;
    if (this.surface.canvas.width !== width) this.surface.canvas.width = width;
    if (this.surface.canvas.height !== height) {
      this.surface.canvas.height = height;
    }
    return this.surface;
  }
}

type LightingOptions = { lighting: VisualLightingState };

/**
 * Lighting-only transformer. Implements the transformer contract directly:
 * the library's `VideoTransformer` base always creates a WebGL context, which
 * this mode does not need.
 */
export class LightingTransformer implements VideoTrackTransformer<LightingOptions> {
  transformer?: TransformStream;
  private stage: LightingStage | null = null;
  private lighting: VisualLightingState;

  constructor(
    lighting: VisualLightingState,
    private readonly guard: EffectsPerformanceGuard | null = null,
    private readonly createStage: () => LightingStage = () =>
      new LightingStage(),
  ) {
    this.lighting = lighting;
  }

  async init(): Promise<void> {
    this.stage?.release();
    this.stage = this.createStage();
    this.stage.setLighting(this.lighting);
    this.transformer = new TransformStream<VideoFrame, VideoFrame>({
      transform: (frame, controller) => this.transform(frame, controller),
    });
  }

  async restart(): Promise<void> {
    await this.init();
  }

  async destroy(): Promise<void> {
    this.stage?.release();
    this.stage = null;
    this.transformer = undefined;
  }

  transform(
    frame: VideoFrame,
    controller: TransformStreamDefaultController<VideoFrame>,
  ): void {
    const stage = this.stage;
    if (!stage) {
      controller.enqueue(frame);
      return;
    }
    const started = performance.now();
    const output = stage.apply(frame);
    try {
      controller.enqueue(output);
    } catch {
      output.close();
      return;
    }
    this.guard?.record(performance.now() - started);
  }

  update(options: LightingOptions): void {
    this.lighting = options.lighting;
    this.stage?.setLighting(options.lighting);
  }
}

// --- Background step ---------------------------------------------------------

async function decodeBackgroundImage(url: string): Promise<ImageBitmap> {
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  await image.decode();
  return createImageBitmap(image);
}

/**
 * The library background transformer plus: an optional lighting pass on the
 * output frame, and `ImageBitmap` ownership so replaced or destroyed
 * background sources are closed instead of waiting for garbage collection.
 */
export class TutorHubBackgroundTransformer extends BackgroundTransformer {
  private readonly lightingStage: LightingStage;
  private retiredBackgrounds: ImageBitmap[] = [];
  private finished = false;

  constructor(
    options: BackgroundOptions,
    lighting: VisualLightingState,
    lightingStage: LightingStage = new LightingStage(),
    private readonly decodeImage: (
      url: string,
    ) => Promise<ImageBitmap> = decodeBackgroundImage,
  ) {
    // Never pass `imagePath` here: the base constructor would call the
    // overridden loader before this subclass has initialised its fields.
    super({ ...options, imagePath: undefined });
    this.lightingStage = lightingStage;
    this.lightingStage.setLighting(lighting);
  }

  setLighting(lighting: VisualLightingState): void {
    this.lightingStage.setLighting(lighting);
  }

  async init(options: VideoTransformerInitOptions): Promise<void> {
    this.finished = false;
    await super.init(options);
  }

  async transform(
    frame: VideoFrame,
    controller: TransformStreamDefaultController<VideoFrame>,
  ): Promise<void> {
    if (!this.lightingStage.active) {
      return super.transform(frame, controller);
    }
    return super.transform(
      frame,
      this.lightingStage.wrapController(controller),
    );
  }

  async loadAndSetBackground(path: string): Promise<void> {
    const current = this.backgroundImageAndPath;
    if (!current || current.path !== path) {
      const bitmap = await this.decodeImage(path);
      if (this.finished) {
        bitmap.close();
        return;
      }
      const replaced = this.backgroundImageAndPath;
      if (replaced) this.retiredBackgrounds.push(replaced.imageData);
      this.backgroundImageAndPath = { imageData: bitmap, path };
    }
    const active = this.backgroundImageAndPath;
    // A later update switched to another background while this one decoded.
    if (!active || this.options.imagePath !== path) return;
    await this.gl?.setBackgroundImage(active.imageData);
    // The GL pipeline now holds the active image: older sources can go.
    this.closeRetiredBackgrounds(active.imageData);
  }

  async destroy(options?: TrackTransformerDestroyOptions): Promise<void> {
    const last = this.backgroundImageAndPath?.imageData ?? null;
    if (!options?.willProcessorRestart) this.finished = true;
    await super.destroy(options);
    last?.close();
    this.closeRetiredBackgrounds(null);
    this.backgroundImageAndPath = null;
    this.lightingStage.release();
  }

  private closeRetiredBackgrounds(keep: ImageBitmap | null): void {
    for (const bitmap of this.retiredBackgrounds) {
      if (bitmap !== keep) bitmap.close();
    }
    this.retiredBackgrounds = [];
  }
}

// --- Processor wrappers ------------------------------------------------------

let processorSequence = 0;

/** Unique names keep two live processors from sharing a fallback canvas. */
function nextProcessorName(mode: EffectsMode): string {
  processorSequence += 1;
  return `tutorhub-effects-${mode}-${processorSequence}`;
}

/**
 * `ProcessorWrapper.destroy()` only cleans up a processor that finished
 * `init`. This wrapper also releases what a failed `init` left behind, and
 * turns a failed restart (camera re-enabled or switched) into a reported
 * failure instead of breaking the camera.
 */
export abstract class EffectsProcessorWrapper<
  Options extends Record<string, unknown>,
  Transformer extends VideoTrackTransformer<Options>,
> extends ProcessorWrapper<Options, Transformer> {
  abstract readonly visualEffectsMode: EffectsMode;
  private initSucceeded = false;
  private destroyPromise: Promise<void> | null = null;

  constructor(
    transformer: Transformer,
    name: string,
    private readonly onFailure: (() => void) | undefined,
  ) {
    super(transformer, name, { maxFps: 30 });
  }

  abstract applyPlan(plan: VisualEffectsRenderPlan): Promise<boolean>;

  async init(options: ProcessorOptions<Track.Kind>): Promise<void> {
    this.initSucceeded = false;
    this.destroyPromise = null;
    try {
      await super.init(options);
      this.initSucceeded = true;
    } catch (error) {
      await this.releaseAfterFailedInit();
      throw error;
    }
  }

  async restart(options: ProcessorOptions<Track.Kind>): Promise<void> {
    try {
      await super.restart(options);
    } catch {
      // The owner stops this processor, which restores the raw camera.
      globalThis.queueMicrotask(() => this.onFailure?.());
    }
  }

  async destroy(
    options: TrackTransformerDestroyOptions = { willProcessorRestart: false },
  ): Promise<void> {
    if (options.willProcessorRestart) {
      await super.destroy(options);
      return;
    }
    this.destroyPromise ??= (async () => {
      await super.destroy(options);
      if (!this.initSucceeded) await this.releaseAfterFailedInit();
    })();
    return this.destroyPromise;
  }

  private async releaseAfterFailedInit(): Promise<void> {
    try {
      this.processedTrack?.stop();
    } catch {
      // Already stopped.
    }
    this.displayCanvas?.remove();
    try {
      await this.transformer.destroy({ willProcessorRestart: false });
    } catch {
      // Best effort: the transformer may not have initialised anything.
    }
  }
}

export class LightingEffectsProcessor extends EffectsProcessorWrapper<
  LightingOptions,
  LightingTransformer
> {
  readonly visualEffectsMode = "lighting" as const;

  async applyPlan(plan: VisualEffectsRenderPlan): Promise<boolean> {
    if (plan.mode !== "lighting") return false;
    this.transformer.update({ lighting: plan.lighting });
    return true;
  }
}

export class BackgroundEffectsProcessor extends EffectsProcessorWrapper<
  BackgroundOptions,
  TutorHubBackgroundTransformer
> {
  readonly visualEffectsMode = "background" as const;

  async applyPlan(plan: VisualEffectsRenderPlan): Promise<boolean> {
    if (plan.mode !== "background") return false;
    this.transformer.setLighting(plan.lighting);
    await this.updateTransformerOptions(backgroundOptions(plan));
    return true;
  }
}

export type VisualEffectsTrackProcessor =
  LightingEffectsProcessor | BackgroundEffectsProcessor;

function backgroundOptions(
  plan: Extract<VisualEffectsRenderPlan, { mode: "background" }>,
): BackgroundOptions {
  return plan.background.kind === "blur"
    ? {
        imagePath: undefined,
        blurRadius: plan.background.blurRadius,
        backgroundDisabled: false,
      }
    : {
        imagePath: plan.background.imageUrl,
        blurRadius: undefined,
        backgroundDisabled: false,
      };
}

export interface VisualEffectsProcessorOptions extends VisualEffectsRuntimeOptions {
  /** A restart (camera re-enabled or switched) failed; stop the processor. */
  onFailure?: () => void;
}

/**
 * Builds the LiveKit `TrackProcessor` for a plan. For `LocalVideoTrack`
 * pass it to `setProcessor`; for a raw track use `startStandaloneVisualEffects`.
 */
export async function createVisualEffectsProcessor(
  plan: VisualEffectsRenderPlan,
  options: VisualEffectsProcessorOptions = {},
): Promise<VisualEffectsTrackProcessor> {
  const guard = options.onOverload
    ? new EffectsPerformanceGuard(options.onOverload)
    : null;
  if (plan.mode === "lighting") {
    return new LightingEffectsProcessor(
      new LightingTransformer(plan.lighting, guard),
      nextProcessorName("lighting"),
      options.onFailure,
    );
  }
  const transformer = new TutorHubBackgroundTransformer(
    {
      blurRadius:
        plan.background.kind === "blur"
          ? plan.background.blurRadius
          : undefined,
      backgroundDisabled: plan.background.kind !== "blur",
      assetPaths: { ...VISUAL_EFFECTS_ASSET_PATHS },
      onFrameProcessed: guard
        ? (stats) => guard.record(stats.processingTimeMs)
        : undefined,
    },
    plan.lighting,
  );
  const processor = new BackgroundEffectsProcessor(
    transformer,
    nextProcessorName("background"),
    options.onFailure,
  );
  if (plan.background.kind === "image") {
    // Loads and decodes the image now; the GL upload happens during init.
    await processor.applyPlan(plan);
  }
  return processor;
}

/**
 * Runs a plan on a raw camera track (Pre-Join). The raw track stays owned by
 * the caller: `destroy()` stops only the processed output.
 */
export async function startStandaloneVisualEffects(
  track: MediaStreamTrack,
  plan: VisualEffectsRenderPlan,
  options: VisualEffectsRuntimeOptions = {},
): Promise<StandaloneVisualEffectsHandle> {
  const element = document.createElement("video");
  element.muted = true;
  element.playsInline = true;
  element.autoplay = true;
  element.srcObject = new MediaStream([track]);
  const releaseElement = () => {
    element.pause();
    element.srcObject = null;
    element.removeAttribute("src");
  };
  let processor: VisualEffectsTrackProcessor | null = null;
  try {
    // The background transformer waits on video frame callbacks of this
    // element for its first frame, so it must be playing.
    await element.play().catch(() => undefined);
    processor = await createVisualEffectsProcessor(plan, options);
    await processor.init({ kind: Track.Kind.Video, track, element });
    const processedTrack = processor.processedTrack;
    if (!processedTrack) throw new Error("visual_effects_no_output");
    const active = processor;
    const stream = new MediaStream([processedTrack]);
    let destroyed: Promise<void> | null = null;
    return {
      mode: active.visualEffectsMode,
      stream,
      apply: (next) => active.applyPlan(next),
      destroy() {
        destroyed ??= (async () => {
          try {
            processedTrack.stop();
          } catch {
            // Already stopped.
          }
          await active.destroy().catch(() => undefined);
          releaseElement();
        })();
        return destroyed;
      },
    };
  } catch (error) {
    await processor?.destroy().catch(() => undefined);
    releaseElement();
    throw error;
  }
}

/** The runtime contract consumed by the Pre-Join controller. */
export const visualEffectsRuntime: MediaVisualEffectsRuntime = {
  supportsVisualEffects: (mode) => supportsVisualEffects(mode),
  startStandaloneVisualEffects,
};
