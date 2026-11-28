import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureScreenFrame,
  clampSelection,
  displayCaptureOptions,
  isCaptureCancellation,
  isCaptureShortcut,
  isScreenCaptureSupported,
  selectionFromPoints,
  selectionToPixels,
} from "./screenCapture";

class FakeTrack extends EventTarget {
  stop = vi.fn();
}

function fakeStream() {
  const track = new FakeTrack();
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
  const mediaDevices = {
    getDisplayMedia: vi.fn().mockResolvedValue(stream),
  };
  return { mediaDevices, stream, track };
}

function shortcut(overrides: Partial<KeyboardEvent> = {}, altGraph = false) {
  return {
    altKey: true,
    code: "KeyX",
    ctrlKey: true,
    getModifierState: (key: string) => key === "AltGraph" && altGraph,
    isComposing: false,
    metaKey: false,
    repeat: false,
    shiftKey: false,
    ...overrides,
  } as KeyboardEvent;
}

describe("screenCapture", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("detects getDisplayMedia support", () => {
    expect(isScreenCaptureSupported(undefined)).toBe(false);
    expect(isScreenCaptureSupported({ mediaDevices: {} })).toBe(false);
    expect(
      isScreenCaptureSupported({
        mediaDevices: { getDisplayMedia: () => Promise.reject(new Error()) },
      }),
    ).toBe(true);
  });

  it("requests video only and leaves this tab out of the delayed picker", () => {
    expect(displayCaptureOptions("screen")).toMatchObject({
      audio: false,
      selfBrowserSurface: "include",
      surfaceSwitching: "exclude",
    });
    expect(displayCaptureOptions("delayed")).toMatchObject({
      audio: false,
      selfBrowserSurface: "exclude",
    });
  });

  it("reads one frame and stops every track", async () => {
    const { mediaDevices, stream, track } = fakeStream();
    const canvas = document.createElement("canvas");
    const readFrame = vi.fn().mockResolvedValue(canvas);

    await expect(
      captureScreenFrame({ mediaDevices, mode: "screen", readFrame }),
    ).resolves.toBe(canvas);
    expect(readFrame).toHaveBeenCalledWith(stream);
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("stops the tracks when reading the frame fails", async () => {
    const { mediaDevices, track } = fakeStream();
    const readFrame = vi.fn().mockRejectedValue(new Error("no frame"));

    await expect(
      captureScreenFrame({ mediaDevices, mode: "screen", readFrame }),
    ).rejects.toThrow("no frame");
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("counts down before a delayed capture", async () => {
    vi.useFakeTimers();
    const { mediaDevices, track } = fakeStream();
    const readFrame = vi
      .fn()
      .mockResolvedValue(document.createElement("canvas"));
    const ticks: number[] = [];

    const result = captureScreenFrame({
      mediaDevices,
      mode: "delayed",
      onCountdown: (remaining) => ticks.push(remaining),
      readFrame,
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(readFrame).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(ticks).toEqual([3, 2, 1]);
    expect(readFrame).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("cancels the countdown from TutorHub or from the browser's stop button", async () => {
    vi.useFakeTimers();
    const first = fakeStream();
    const controller = new AbortController();
    const readFrame = vi.fn();
    const cancelled = captureScreenFrame({
      mediaDevices: first.mediaDevices,
      mode: "delayed",
      readFrame,
      signal: controller.signal,
    });
    const cancelledExpectation = expect(cancelled).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await cancelledExpectation;
    expect(first.track.stop).toHaveBeenCalledTimes(1);

    const second = fakeStream();
    const ended = captureScreenFrame({
      mediaDevices: second.mediaDevices,
      mode: "delayed",
      readFrame,
    });
    const endedExpectation = expect(ended).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(500);
    second.track.dispatchEvent(new Event("ended"));
    await endedExpectation;
    expect(second.track.stop).toHaveBeenCalledTimes(1);
    expect(readFrame).not.toHaveBeenCalled();
  });

  it("treats a dismissed picker as a cancellation, not a failure", async () => {
    const denied = new DOMException("denied", "NotAllowedError");
    const mediaDevices = {
      getDisplayMedia: vi.fn().mockRejectedValue(denied),
    };
    const error = await captureScreenFrame({
      mediaDevices,
      mode: "screen",
    }).catch((reason: unknown) => reason);
    expect(isCaptureCancellation(error)).toBe(true);
    expect(isCaptureCancellation(new Error("boom"))).toBe(false);
  });

  it("matches Ctrl+Alt+X but never AltGr, Shift, repeats or IME input", () => {
    expect(isCaptureShortcut(shortcut())).toBe(true);
    expect(isCaptureShortcut(shortcut({}, true))).toBe(false);
    expect(isCaptureShortcut(shortcut({ shiftKey: true }))).toBe(false);
    expect(isCaptureShortcut(shortcut({ repeat: true }))).toBe(false);
    expect(isCaptureShortcut(shortcut({ isComposing: true }))).toBe(false);
    expect(isCaptureShortcut(shortcut({ code: "KeyS" }))).toBe(false);
    expect(isCaptureShortcut(shortcut({ altKey: false }))).toBe(false);
  });

  it("keeps crops inside the image with a minimum size", () => {
    expect(
      clampSelection(
        { height: 0.5, width: 0.5, x: 0.8, y: -0.2 },
        { height: 0.1, width: 0.1 },
      ),
    ).toEqual({ height: 0.5, width: 0.5, x: 0.5, y: 0 });
    expect(
      clampSelection(
        { height: 0, width: 0.01, x: 0, y: 0 },
        { height: 0.1, width: 0.1 },
      ),
    ).toEqual({ height: 0.1, width: 0.1, x: 0, y: 0 });
    const drawn = selectionFromPoints({ x: 0.6, y: 0.7 }, { x: 0.2, y: 0.1 });
    expect(drawn.x).toBeCloseTo(0.2);
    expect(drawn.y).toBeCloseTo(0.1);
    expect(drawn.width).toBeCloseTo(0.4);
    expect(drawn.height).toBeCloseTo(0.6);
    expect(
      selectionToPixels(
        { height: 0.5, width: 0.25, x: 0.5, y: 0.5 },
        { height: 720, width: 1280 },
      ),
    ).toEqual({ height: 360, width: 320, x: 640, y: 360 });
  });
});
