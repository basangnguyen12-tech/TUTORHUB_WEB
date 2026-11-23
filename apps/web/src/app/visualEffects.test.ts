import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPrivateSessionCache } from "./session";
import {
  CUSTOM_BACKGROUND_LIMIT,
  CUSTOM_BACKGROUND_MAX_BYTES,
  CustomBackgroundError,
  DEFAULT_VISUAL_EFFECTS,
  VISUAL_BACKGROUND_PRESET_IDS,
  addCustomBackground,
  coverCropRect,
  createMemoryBackgroundStore,
  customBackgroundOutputSize,
  effectiveVisualEffects,
  hasActiveVisualEffects,
  lightingFilter,
  loadVisualEffectsPreference,
  normalizeVisualEffects,
  prepareCustomBackground,
  presetScene,
  resolveVisualEffectsPlan,
  saveVisualEffectsPreference,
  useCustomBackgrounds,
  visualBackgroundPresetUrl,
  visualEffectsMode,
  visualEffectsScopeKey,
  visualEffectsSummaryKey,
  type BackgroundImagePipeline,
  type ClassroomVisualEffectsState,
  type CropRect,
  type ObjectUrlFactory,
} from "./visualEffects";

const scopeA = { tenantId: "tenant-a", userId: "user-1" };
const scopeA2 = { tenantId: "tenant-a", userId: "user-2" };
const scopeB = { tenantId: "tenant-b", userId: "user-1" };

function jpegWithMetadata(size = 64): File {
  // A fake JPEG whose bytes carry EXIF/GPS markers that must not survive.
  const marker = new TextEncoder().encode(
    "Exif\u0000\u0000GPSLatitude=21.0278",
  );
  const bytes = new Uint8Array(Math.max(size, marker.length));
  bytes.set(marker);
  return new File([bytes], "holiday.jpg", { type: "image/jpeg" });
}

function fakePipeline(
  dimensions = { width: 1600, height: 1200 },
  encodeImpl?: () => Promise<Blob>,
) {
  const close = vi.fn();
  const encoded = new Blob(
    [new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])],
    {
      type: "image/jpeg",
    },
  );
  const calls: Array<{
    crop: CropRect;
    size: { width: number; height: number };
  }> = [];
  const pipeline: BackgroundImagePipeline = {
    decode: vi.fn(async () => ({
      ...dimensions,
      source: {} as CanvasImageSource,
      close,
    })),
    encode: vi.fn(async (_source, crop, size) => {
      calls.push({ crop, size });
      return encodeImpl ? encodeImpl() : encoded;
    }),
  };
  return { calls, close, encoded, pipeline };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("visual effects choice model", () => {
  it("defaults to no effect and derives the pipeline mode", () => {
    expect(hasActiveVisualEffects(DEFAULT_VISUAL_EFFECTS)).toBe(false);
    expect(visualEffectsMode(DEFAULT_VISUAL_EFFECTS)).toBe("none");
    expect(
      visualEffectsMode({
        ...DEFAULT_VISUAL_EFFECTS,
        lighting: { brightness: "low_light", tone: "natural" },
      }),
    ).toBe("lighting");
    expect(
      visualEffectsMode({
        background: { kind: "blur", strength: "strong" },
        lighting: { brightness: "studio_bright", tone: "warm" },
      }),
    ).toBe("background");
  });

  it("normalizes untrusted stored input to a valid state", () => {
    expect(normalizeVisualEffects(null)).toEqual(DEFAULT_VISUAL_EFFECTS);
    expect(
      normalizeVisualEffects({
        background: { kind: "preset", presetId: "../../etc" },
        lighting: { brightness: "blinding", tone: "warm" },
      }),
    ).toEqual({
      background: { kind: "none" },
      lighting: { brightness: "normal", tone: "warm" },
    });
    expect(
      normalizeVisualEffects({
        background: { kind: "custom", imageId: "<script>" },
      }).background,
    ).toEqual({ kind: "none" });
    const valid: ClassroomVisualEffectsState = {
      background: { kind: "preset", presetId: "lecture-studio" },
      lighting: { brightness: "studio_bright", tone: "crisp" },
    };
    expect(normalizeVisualEffects(valid)).toEqual(valid);
  });

  it("resolves blur radii, same-origin preset images and missing personal images", () => {
    expect(
      resolveVisualEffectsPlan(
        {
          ...DEFAULT_VISUAL_EFFECTS,
          background: { kind: "blur", strength: "light" },
        },
        () => null,
      ),
    ).toEqual({
      mode: "background",
      background: { kind: "blur", blurRadius: 8 },
      lighting: DEFAULT_VISUAL_EFFECTS.lighting,
    });
    expect(
      resolveVisualEffectsPlan(
        {
          ...DEFAULT_VISUAL_EFFECTS,
          background: { kind: "blur", strength: "strong" },
        },
        () => null,
      ),
    ).toMatchObject({ background: { kind: "blur", blurRadius: 18 } });

    const preset = resolveVisualEffectsPlan(
      {
        ...DEFAULT_VISUAL_EFFECTS,
        background: { kind: "preset", presetId: "academic-library" },
      },
      () => null,
    );
    expect(preset?.mode).toBe("background");
    expect(
      preset?.mode === "background" && preset.background.kind === "image"
        ? preset.background.imageUrl
        : "",
    ).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);

    // A personal image that is gone resolves like no background; lighting stays.
    expect(
      resolveVisualEffectsPlan(
        {
          background: { kind: "custom", imageId: "abcdef12-3456" },
          lighting: { brightness: "low_light", tone: "natural" },
        },
        () => null,
      ),
    ).toEqual({
      mode: "lighting",
      lighting: { brightness: "low_light", tone: "natural" },
    });
    expect(
      resolveVisualEffectsPlan(
        {
          ...DEFAULT_VISUAL_EFFECTS,
          background: { kind: "custom", imageId: "abcdef12-3456" },
        },
        () => "blob:http://localhost/abc",
      ),
    ).toMatchObject({
      background: { kind: "image", imageUrl: "blob:http://localhost/abc" },
    });
    expect(
      resolveVisualEffectsPlan(DEFAULT_VISUAL_EFFECTS, () => null),
    ).toBeNull();
  });

  it("keeps the lighting filter subtle and deterministic", () => {
    expect(lightingFilter({ brightness: "normal", tone: "natural" })).toBe(
      "none",
    );
    expect(lightingFilter({ brightness: "low_light", tone: "natural" })).toBe(
      "brightness(1.22) contrast(1.05)",
    );
    expect(lightingFilter({ brightness: "studio_bright", tone: "warm" })).toBe(
      "brightness(1.12) contrast(1.1) saturate(1.05) sepia(0.14) saturate(1.08)",
    );
    expect(lightingFilter({ brightness: "normal", tone: "crisp" })).toContain(
      "hue-rotate(-4deg)",
    );
  });

  it("names the active effect for badges", () => {
    expect(visualEffectsSummaryKey(DEFAULT_VISUAL_EFFECTS)).toBe(
      "media.fx.none",
    );
    expect(
      visualEffectsSummaryKey({
        ...DEFAULT_VISUAL_EFFECTS,
        background: { kind: "preset", presetId: "academic-library" },
      }),
    ).toBe("media.fx.preset.academic-library");
    expect(
      visualEffectsSummaryKey({
        ...DEFAULT_VISUAL_EFFECTS,
        lighting: { brightness: "low_light", tone: "natural" },
      }),
    ).toBe("media.fx.short.low_light");
  });
});

describe("curated education backgrounds", () => {
  it("ships seven original 16:9 1600x900 scenes with no external references", () => {
    expect(VISUAL_BACKGROUND_PRESET_IDS).toHaveLength(7);
    const scenes = VISUAL_BACKGROUND_PRESET_IDS.map((id) => presetScene(id));
    for (const svg of scenes) {
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain('width="1600" height="900"');
      expect(svg).toContain('viewBox="0 0 1600 900"');
      // Only the SVG namespace URI; no remote images, fonts or scripts.
      expect(svg.replace("http://www.w3.org/2000/svg", "")).not.toMatch(
        /https?:|<image|<script|<foreignObject|xlink:href/i,
      );
    }
    expect(new Set(scenes).size).toBe(7);
    expect(visualBackgroundPresetUrl("botanical-calm")).toBe(
      visualBackgroundPresetUrl("botanical-calm"),
    );
  });
});

describe("personal background preparation", () => {
  it("crops object-fit: cover to 16:9 without stretching", () => {
    // 4:3 webcam-shaped source: the sides are cropped.
    expect(coverCropRect(1600, 1200, 16 / 9)).toEqual({
      sx: 0,
      sy: 150,
      sw: 1600,
      sh: 900,
    });
    // Ultra-wide: top/bottom kept, sides cropped.
    expect(coverCropRect(3000, 1000, 16 / 9)).toEqual({
      sx: 611,
      sy: 0,
      sw: 1778,
      sh: 1000,
    });
    // Portrait phone photo.
    expect(coverCropRect(1080, 1920, 16 / 9)).toMatchObject({
      sx: 0,
      sw: 1080,
    });
    expect(customBackgroundOutputSize(3840, 2160)).toEqual({
      width: 1920,
      height: 1080,
    });
    expect(customBackgroundOutputSize(800, 450)).toEqual({
      width: 800,
      height: 450,
    });
  });

  it("re-encodes through a canvas so EXIF/GPS never survives", async () => {
    const file = jpegWithMetadata();
    const { calls, close, encoded, pipeline } = fakePipeline({
      width: 4000,
      height: 3000,
    });

    const prepared = await prepareCustomBackground(file, pipeline);

    expect(prepared.blob).toBe(encoded);
    expect(prepared.blob).not.toBe(file);
    expect(prepared.blob.type).toBe("image/jpeg");
    const output = new TextDecoder().decode(await prepared.blob.arrayBuffer());
    expect(output).not.toContain("Exif");
    expect(output).not.toContain("GPS");
    expect(calls).toEqual([
      {
        crop: { sx: 0, sy: 375, sw: 4000, sh: 2250 },
        size: { width: 1920, height: 1080 },
      },
    ]);
    expect(prepared).toMatchObject({ width: 1920, height: 1080 });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported or oversized files before decoding and always closes the bitmap", async () => {
    const { pipeline, close } = fakePipeline();
    await expect(
      prepareCustomBackground(
        new File(["<svg/>"], "x.svg", { type: "image/svg+xml" }),
        pipeline,
      ),
    ).rejects.toMatchObject({ code: "unsupported_type" });
    const huge = new File(
      [new Uint8Array(CUSTOM_BACKGROUND_MAX_BYTES + 1)],
      "big.png",
      {
        type: "image/png",
      },
    );
    await expect(prepareCustomBackground(huge, pipeline)).rejects.toMatchObject(
      {
        code: "too_large",
      },
    );
    expect(pipeline.decode).not.toHaveBeenCalled();

    const failing = fakePipeline({ width: 800, height: 600 }, async () => {
      throw new Error("encoder crashed");
    });
    await expect(
      prepareCustomBackground(jpegWithMetadata(), failing.pipeline),
    ).rejects.toBeInstanceOf(CustomBackgroundError);
    expect(failing.close).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });
});

describe("personal background storage", () => {
  it("keeps at most four images per (tenant, user) and partitions strictly", async () => {
    const store = createMemoryBackgroundStore();
    const { pipeline } = fakePipeline();
    const keyA = visualEffectsScopeKey(scopeA);
    let id = 0;
    const createId = () => `image-000${(id += 1)}`;

    for (let index = 0; index < CUSTOM_BACKGROUND_LIMIT; index += 1) {
      await addCustomBackground(store, keyA, jpegWithMetadata(), {
        pipeline,
        createId,
      });
    }
    const decodes = vi.mocked(pipeline.decode).mock.calls.length;
    await expect(
      addCustomBackground(store, keyA, jpegWithMetadata(), {
        pipeline,
        createId,
      }),
    ).rejects.toMatchObject({ code: "limit_reached" });
    // The fifth file is refused before it is even decoded.
    expect(vi.mocked(pipeline.decode).mock.calls.length).toBe(decodes);

    await addCustomBackground(
      store,
      visualEffectsScopeKey(scopeA2),
      jpegWithMetadata(),
      {
        pipeline,
        createId,
      },
    );
    await addCustomBackground(
      store,
      visualEffectsScopeKey(scopeB),
      jpegWithMetadata(),
      {
        pipeline,
        createId,
      },
    );
    expect(await store.list(keyA)).toHaveLength(4);
    expect(await store.list(visualEffectsScopeKey(scopeA2))).toHaveLength(1);
    expect(await store.list(visualEffectsScopeKey(scopeB))).toHaveLength(1);

    const [first] = await store.list(keyA);
    await store.remove(keyA, first?.id ?? "");
    expect(await store.list(keyA)).toHaveLength(3);
    // Removing in another scope with the same id never touches this one.
    await store.remove(visualEffectsScopeKey(scopeB), first?.id ?? "");
    expect(await store.list(keyA)).toHaveLength(3);
  });

  it("stores the light preference per (tenant, user) and drops invalid data", () => {
    const storage = memoryStorage();
    const state: ClassroomVisualEffectsState = {
      background: { kind: "preset", presetId: "nordic-study" },
      lighting: { brightness: "low_light", tone: "warm" },
    };
    saveVisualEffectsPreference(scopeA, state, storage);
    expect(loadVisualEffectsPreference(scopeA, storage)).toEqual(state);
    expect(loadVisualEffectsPreference(scopeA2, storage)).toEqual(
      DEFAULT_VISUAL_EFFECTS,
    );
    expect(loadVisualEffectsPreference(scopeB, storage)).toEqual(
      DEFAULT_VISUAL_EFFECTS,
    );
    // Only the choice is stored: no image bytes or URLs.
    expect(storage.getItem(storage.key(0) ?? "")).not.toMatch(/blob:|data:/);

    saveVisualEffectsPreference(scopeA, DEFAULT_VISUAL_EFFECTS, storage);
    expect(storage.length).toBe(0);
    storage.setItem("tutorhub.visual-effects.v1:tenant-a:user-1", "{not json");
    expect(loadVisualEffectsPreference(scopeA, storage)).toEqual(
      DEFAULT_VISUAL_EFFECTS,
    );
  });

  it("clears preferences and personal images on sign-out", async () => {
    saveVisualEffectsPreference(scopeA, {
      ...DEFAULT_VISUAL_EFFECTS,
      background: { kind: "blur", strength: "light" },
    });
    localStorage.setItem("unrelated-key", "kept");
    const deleteDatabase = vi.fn(() => {
      const request = {} as IDBOpenDBRequest;
      queueMicrotask(() =>
        request.onsuccess?.call(request, new Event("success")),
      );
      return request;
    });
    vi.stubGlobal("indexedDB", { deleteDatabase });

    await clearPrivateSessionCache(new QueryClient());

    expect(loadVisualEffectsPreference(scopeA)).toEqual(DEFAULT_VISUAL_EFFECTS);
    expect(localStorage.getItem("unrelated-key")).toBe("kept");
    expect(deleteDatabase).toHaveBeenCalledWith("tutorhub-visual-effects");
    vi.unstubAllGlobals();
  });
});

describe("useCustomBackgrounds", () => {
  function fakeUrls(): ObjectUrlFactory & {
    live: Set<string>;
    revoked: string[];
  } {
    let count = 0;
    const live = new Set<string>();
    const revoked: string[] = [];
    return {
      live,
      revoked,
      create: () => {
        count += 1;
        const url = `blob:test/${count}`;
        live.add(url);
        return url;
      },
      revoke: (url) => {
        live.delete(url);
        revoked.push(url);
      },
    };
  }

  it("owns object URLs: revoked on removal, scope change and unmount", async () => {
    const store = createMemoryBackgroundStore();
    const urls = fakeUrls();
    const { pipeline } = fakePipeline();
    await addCustomBackground(
      store,
      visualEffectsScopeKey(scopeA),
      jpegWithMetadata(),
      {
        pipeline,
        createId: () => "stored-image-1",
      },
    );

    const { result, rerender, unmount } = renderHook(
      ({ scope }) =>
        useCustomBackgrounds(scope, { store, objectUrls: urls, pipeline }),
      { initialProps: { scope: scopeA as typeof scopeA | null } },
    );
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.items).toEqual([
      { id: "stored-image-1", url: "blob:test/1" },
    ]);
    expect(result.current.urlFor("stored-image-1")).toBe("blob:test/1");

    let added = { id: "", url: "" };
    await act(async () => {
      added = await result.current.add(jpegWithMetadata());
    });
    expect(result.current.items).toHaveLength(2);
    expect(urls.live.has(added.url)).toBe(true);

    await act(async () => {
      await result.current.remove("stored-image-1");
    });
    expect(urls.revoked).toContain("blob:test/1");
    expect(result.current.items).toEqual([added]);

    rerender({ scope: scopeB });
    expect(urls.revoked).toContain(added.url);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.items).toEqual([]);

    rerender({ scope: null });
    expect(result.current.status).toBe("disabled");
    expect(result.current.canAdd).toBe(false);
    unmount();
    expect(urls.live.size).toBe(0);
  });

  it("falls back to no background once a stored image is known to be gone", () => {
    const state: ClassroomVisualEffectsState = {
      ...DEFAULT_VISUAL_EFFECTS,
      background: { kind: "custom", imageId: "missing-image" },
    };
    expect(
      effectiveVisualEffects(state, { status: "loading", urlFor: () => null }),
    ).toBe(state);
    expect(
      effectiveVisualEffects(state, { status: "ready", urlFor: () => null })
        .background,
    ).toEqual({ kind: "none" });
    expect(
      effectiveVisualEffects(state, {
        status: "ready",
        urlFor: () => "blob:test/9",
      }),
    ).toBe(state);
  });
});
