import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VisualEffectsRenderPlan } from "../../app/visualEffects";

const library = vi.hoisted(() => ({
  backgroundSupported: true,
  backgroundConstructed: [] as Array<Record<string, unknown>>,
  failInit: false,
  failRestart: false,
  wrapperDestroys: 0,
  transformerDestroys: 0,
}));

vi.mock("@livekit/track-processors", () => {
  class ProcessorWrapper<Options extends Record<string, unknown>> {
    static isSupported = true;
    name: string;
    transformer: {
      init: (options: unknown) => Promise<void>;
      destroy: (options?: unknown) => Promise<void>;
      update: (options: Options) => Promise<void> | void;
    };
    processedTrack?: MediaStreamTrack;
    displayCanvas?: HTMLCanvasElement;
    private running = false;

    constructor(
      transformer: ProcessorWrapper<Options>["transformer"],
      name: string,
    ) {
      this.transformer = transformer;
      this.name = name;
    }

    async init(options: { element?: HTMLMediaElement }) {
      this.processedTrack = {
        stop: vi.fn(),
        kind: "video",
      } as unknown as MediaStreamTrack;
      this.displayCanvas = document.createElement("canvas");
      document.body.append(this.displayCanvas);
      if (library.failInit) throw new Error("wasm failed to load");
      await this.transformer.init({
        outputCanvas: {},
        inputElement: options.element,
      });
      this.running = true;
    }

    async restart(options: { element?: HTMLMediaElement }) {
      await this.destroy({ willProcessorRestart: true });
      if (library.failRestart) throw new Error("restart failed");
      await this.init(options);
    }

    async destroy(options?: unknown) {
      if (!this.running) return;
      this.running = false;
      library.wrapperDestroys += 1;
      await this.transformer.destroy(options);
    }

    async updateTransformerOptions(options: Options) {
      await this.transformer.update(options);
    }
  }

  class BackgroundTransformer {
    options: Record<string, unknown>;
    gl?: { setBackgroundImage: (image: ImageBitmap | null) => Promise<void> };
    backgroundImageAndPath: { imageData: ImageBitmap; path: string } | null =
      null;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      library.backgroundConstructed.push(options);
    }

    async init() {
      this.gl = { setBackgroundImage: vi.fn(async () => undefined) };
      const imagePath = this.options.imagePath;
      if (typeof imagePath === "string")
        await this.loadAndSetBackground(imagePath);
    }

    async destroy() {
      library.transformerDestroys += 1;
      this.gl = undefined;
      this.backgroundImageAndPath = null;
    }

    async loadAndSetBackground(path: string) {
      void path;
    }

    async transform(
      frame: VideoFrame,
      controller: TransformStreamDefaultController<VideoFrame>,
    ) {
      controller.enqueue(frame.clone());
      controller.enqueue(frame);
    }

    async update(options: Record<string, unknown>) {
      this.options = { ...this.options, ...options };
      const imagePath = options.imagePath;
      if (typeof imagePath === "string")
        await this.loadAndSetBackground(imagePath);
    }
  }

  return {
    BackgroundTransformer,
    LogLevel: { silent: 5 },
    ProcessorWrapper,
    setLogLevel: vi.fn(),
    supportsBackgroundProcessors: vi.fn(() => library.backgroundSupported),
  };
});

vi.mock("livekit-client", () => ({ Track: { Kind: { Video: "video" } } }));

const {
  EffectsPerformanceGuard,
  LightingStage,
  LightingTransformer,
  TutorHubBackgroundTransformer,
  VISUAL_EFFECTS_ASSET_PATHS,
  createVisualEffectsProcessor,
  startStandaloneVisualEffects,
  supportsVisualEffects,
} = await import("./visualEffectsProcessor");

class FakeVideoFrame {
  static created: FakeVideoFrame[] = [];
  readonly close = vi.fn();
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly timestamp: number;
  readonly duration: number | null;

  constructor(
    _source: unknown,
    init: { timestamp?: number; duration?: number } = {},
    size = { width: 640, height: 480 },
  ) {
    this.displayWidth = size.width;
    this.displayHeight = size.height;
    this.timestamp = init.timestamp ?? 0;
    this.duration = init.duration ?? null;
    FakeVideoFrame.created.push(this);
  }

  clone() {
    return new FakeVideoFrame(this, { timestamp: this.timestamp });
  }
}

function frame(): VideoFrame {
  return new FakeVideoFrame(null, { timestamp: 42 }) as unknown as VideoFrame;
}

function filterSurface(
  options: { supportsFilter?: boolean; drawFails?: boolean } = {},
) {
  let filterValue = "none";
  const context = {
    get filter() {
      return options.supportsFilter === false ? "none" : filterValue;
    },
    set filter(value: string) {
      filterValue = value;
    },
    drawImage: vi.fn(() => {
      if (options.drawFails) throw new Error("context lost");
    }),
  } as unknown as CanvasRenderingContext2D;
  const canvas = { width: 0, height: 0 } as HTMLCanvasElement;
  return { canvas, context };
}

function controller() {
  const enqueued: VideoFrame[] = [];
  const value = {
    desiredSize: 1,
    enqueue: vi.fn((chunk?: VideoFrame) => {
      if (chunk) enqueued.push(chunk);
    }),
    error: vi.fn(),
    terminate: vi.fn(),
  } as unknown as TransformStreamDefaultController<VideoFrame>;
  return { enqueued, value };
}

const lightingPlan: VisualEffectsRenderPlan = {
  mode: "lighting",
  lighting: { brightness: "low_light", tone: "warm" },
};
const blurPlan: VisualEffectsRenderPlan = {
  mode: "background",
  background: { kind: "blur", blurRadius: 18 },
  lighting: { brightness: "normal", tone: "natural" },
};

beforeEach(() => {
  vi.stubGlobal("VideoFrame", FakeVideoFrame);
  FakeVideoFrame.created = [];
  library.backgroundSupported = true;
  library.backgroundConstructed = [];
  library.failInit = false;
  library.failRestart = false;
  library.wrapperDestroys = 0;
  library.transformerDestroys = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("visual effects processor modes", () => {
  it("lighting-only never constructs the person-mask background pipeline", async () => {
    const processor = await createVisualEffectsProcessor(lightingPlan);
    expect(processor.visualEffectsMode).toBe("lighting");
    expect(library.backgroundConstructed).toHaveLength(0);
    expect(processor.name).toMatch(/^tutorhub-effects-lighting-\d+$/);
    await expect(processor.applyPlan(blurPlan)).resolves.toBe(false);
    await expect(
      processor.applyPlan({
        mode: "lighting",
        lighting: { brightness: "studio_bright", tone: "crisp" },
      }),
    ).resolves.toBe(true);
  });

  it("background modes only ever use same-origin MediaPipe assets", async () => {
    const processor = await createVisualEffectsProcessor(blurPlan);
    expect(processor.visualEffectsMode).toBe("background");
    const options = library.backgroundConstructed[0];
    expect(options).toMatchObject({
      blurRadius: 18,
      backgroundDisabled: false,
      assetPaths: {
        tasksVisionFileSet: "/vendor/mediapipe/wasm",
        modelAssetPath: "/vendor/mediapipe/models/selfie_segmenter.tflite",
      },
    });
    expect(JSON.stringify(VISUAL_EFFECTS_ASSET_PATHS)).not.toMatch(
      /https?:|jsdelivr|googleapis/,
    );
    expect(options?.imagePath).toBeUndefined();
    const second = await createVisualEffectsProcessor(blurPlan);
    expect(second.name).not.toBe(processor.name);
  });

  it("detects missing browser support and falls back safely", () => {
    library.backgroundSupported = false;
    expect(supportsVisualEffects("background")).toBe(false);
    expect(supportsVisualEffects("lighting", () => filterSurface())).toBe(true);
    expect(
      supportsVisualEffects("lighting", () =>
        filterSurface({ supportsFilter: false }),
      ),
    ).toBe(false);
    vi.stubGlobal("VideoFrame", undefined);
    expect(supportsVisualEffects("lighting", () => filterSurface())).toBe(
      false,
    );
  });
});

describe("lighting step frame ownership", () => {
  it("closes the input frame only after a lit replacement exists", () => {
    const surface = filterSurface();
    const stage = new LightingStage(() => surface);
    stage.setLighting({ brightness: "low_light", tone: "natural" });
    const input = frame();
    const output = stage.apply(input);
    expect(output).not.toBe(input);
    expect(input.close).toHaveBeenCalledTimes(1);
    expect(output.close).not.toHaveBeenCalled();
    expect(surface.context.filter).toBe("brightness(1.22) contrast(1.05)");
    expect(output.timestamp).toBe(42);
  });

  it("passes the original frame through when the filter is off, unsupported or fails", () => {
    const off = new LightingStage(() => filterSurface());
    const untouched = frame();
    expect(off.apply(untouched)).toBe(untouched);

    const unsupported = new LightingStage(() =>
      filterSurface({ supportsFilter: false }),
    );
    unsupported.setLighting({ brightness: "studio_bright", tone: "natural" });
    const first = frame();
    expect(unsupported.apply(first)).toBe(first);
    expect(first.close).not.toHaveBeenCalled();
    expect(unsupported.active).toBe(false);

    const failing = new LightingStage(() => filterSurface({ drawFails: true }));
    failing.setLighting({ brightness: "studio_bright", tone: "natural" });
    const second = frame();
    expect(failing.apply(second)).toBe(second);
    expect(second.close).not.toHaveBeenCalled();
  });

  it("lighting transformer enqueues lit frames and never leaks one on a closed stream", async () => {
    const guard = new EffectsPerformanceGuard(vi.fn());
    const record = vi.spyOn(guard, "record");
    const transformer = new LightingTransformer(
      { brightness: "low_light", tone: "natural" },
      guard,
      () => new LightingStage(() => filterSurface()),
    );
    await transformer.init();
    const { enqueued, value } = controller();
    const input = frame();
    transformer.transform(input, value);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).not.toBe(input);
    expect(input.close).toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);

    const closed = {
      ...value,
      enqueue: vi.fn(() => {
        throw new TypeError("stream closed");
      }),
    } as unknown as TransformStreamDefaultController<VideoFrame>;
    const late = frame();
    transformer.transform(late, closed);
    const lit = FakeVideoFrame.created.at(-1);
    expect(lit?.close).toHaveBeenCalled();
    await transformer.destroy();
    await transformer.destroy();
  });

  it("background lighting pass closes every intermediate frame", async () => {
    const stage = new LightingStage(() => filterSurface());
    const transformer = new TutorHubBackgroundTransformer(
      { blurRadius: 8 },
      { brightness: "studio_bright", tone: "natural" },
      stage,
    );
    const { enqueued, value } = controller();
    const input = frame();
    await transformer.transform(input, value);
    // The base transformer enqueued a clone and the frame; both were
    // replaced by lit frames and closed.
    expect(enqueued).toHaveLength(2);
    const [cloneSource] = FakeVideoFrame.created.slice(1, 2);
    expect(cloneSource?.close).toHaveBeenCalled();
    expect(input.close).toHaveBeenCalled();
    for (const output of enqueued) expect(output.close).not.toHaveBeenCalled();
  });
});

describe("background image ownership", () => {
  function bitmap(): ImageBitmap {
    return {
      close: vi.fn(),
      width: 1600,
      height: 900,
    } as unknown as ImageBitmap;
  }

  it("closes replaced and destroyed background bitmaps", async () => {
    const decoded: ImageBitmap[] = [];
    const transformer = new TutorHubBackgroundTransformer(
      { backgroundDisabled: true },
      { brightness: "normal", tone: "natural" },
      new LightingStage(() => filterSurface()),
      async () => {
        const image = bitmap();
        decoded.push(image);
        return image;
      },
    );
    await transformer.init({
      outputCanvas: {} as OffscreenCanvas,
      inputElement: document.createElement("video"),
    });
    await transformer.update({ imagePath: "data:image/svg+xml,a" });
    await transformer.update({ imagePath: "blob:test/b" });
    expect(decoded).toHaveLength(2);
    expect(decoded[0]?.close).toHaveBeenCalledTimes(1);
    expect(decoded[1]?.close).not.toHaveBeenCalled();
    expect(transformer.gl?.setBackgroundImage).toHaveBeenLastCalledWith(
      decoded[1],
    );

    await transformer.destroy();
    expect(decoded[1]?.close).toHaveBeenCalledTimes(1);
    expect(transformer.backgroundImageAndPath).toBeNull();
  });

  it("closes a bitmap that finishes decoding after destroy", async () => {
    let release: (image: ImageBitmap) => void = () => undefined;
    const late = bitmap();
    const transformer = new TutorHubBackgroundTransformer(
      { backgroundDisabled: true },
      { brightness: "normal", tone: "natural" },
      new LightingStage(() => filterSurface()),
      () => new Promise<ImageBitmap>((resolve) => (release = resolve)),
    );
    const pending = transformer.loadAndSetBackground("blob:test/slow");
    await transformer.destroy();
    release(late);
    await pending;
    expect(late.close).toHaveBeenCalledTimes(1);
  });
});

describe("processor lifecycle", () => {
  it("destroy is idempotent and a failed init releases what it created", async () => {
    const processor = await createVisualEffectsProcessor(lightingPlan);
    await processor.init({
      kind: "video" as never,
      track: {} as MediaStreamTrack,
      element: document.createElement("video"),
    });
    await Promise.all([processor.destroy(), processor.destroy()]);
    await processor.destroy();
    expect(library.wrapperDestroys).toBe(1);

    library.failInit = true;
    const failing = await createVisualEffectsProcessor(blurPlan);
    await expect(
      failing.init({
        kind: "video" as never,
        track: {} as MediaStreamTrack,
        element: document.createElement("video"),
      }),
    ).rejects.toThrow("wasm failed to load");
    expect(failing.processedTrack?.stop).toHaveBeenCalled();
    expect(failing.displayCanvas?.isConnected).toBe(false);
    expect(library.transformerDestroys).toBe(1);
    await failing.destroy();
  });

  it("reports a failed restart instead of breaking the camera", async () => {
    const onFailure = vi.fn();
    const processor = await createVisualEffectsProcessor(lightingPlan, {
      onFailure,
    });
    const options = {
      kind: "video" as never,
      track: {} as MediaStreamTrack,
      element: document.createElement("video"),
    };
    await processor.init(options);
    library.failRestart = true;
    await expect(processor.restart(options)).resolves.toBeUndefined();
    await Promise.resolve();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("standalone preview never stops the raw camera and tears down once", async () => {
    class FakeMediaStream {
      constructor(readonly tracks: MediaStreamTrack[]) {}
    }
    vi.stubGlobal("MediaStream", FakeMediaStream);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
      () => undefined,
    );
    const raw = { stop: vi.fn(), kind: "video" } as unknown as MediaStreamTrack;

    const handle = await startStandaloneVisualEffects(raw, lightingPlan);
    expect(handle.mode).toBe("lighting");
    expect(handle.stream).toBeInstanceOf(FakeMediaStream);
    await expect(handle.apply(lightingPlan)).resolves.toBe(true);
    await Promise.all([handle.destroy(), handle.destroy()]);
    expect(raw.stop).not.toHaveBeenCalled();
    expect(library.wrapperDestroys).toBe(1);
  });
});

describe("runtime overload guard (ADR-0031 §11)", () => {
  it("trips once after three consecutive bad 5 s windows", () => {
    let now = 0;
    const onOverload = vi.fn();
    const guard = new EffectsPerformanceGuard(onOverload, () => now);
    const window = (frames: number, durationMs: number) => {
      for (let index = 0; index < frames; index += 1) {
        now += 5_000 / frames;
        guard.record(durationMs);
      }
    };
    window(125, 10); // healthy (25 fps)
    window(125, 80); // slow
    window(125, 80); // slow
    expect(onOverload).not.toHaveBeenCalled();
    window(125, 10); // recovered: streak resets
    window(40, 10); // 8 fps
    window(40, 10);
    window(40, 10);
    // Windows are evaluated by the first frame past their 5 s boundary.
    now += 125;
    guard.record(10);
    expect(onOverload).toHaveBeenCalledTimes(1);
    window(40, 10);
    expect(onOverload).toHaveBeenCalledTimes(1);
  });
});
