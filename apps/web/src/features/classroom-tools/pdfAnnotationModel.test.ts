import type { PdfStroke } from "@tutorhub/collaboration-client";
import { describe, expect, it, vi } from "vitest";
import {
  createLaserThrottle,
  drawStrokesOnCanvas,
  hitTestStrokes,
  inkToolsFor,
  inkViewBox,
  normalizePointer,
  parseLaserPoint,
  pdfAnnotationErrorKey,
  PDF_INK_TONES,
  strokeColor,
  strokePathData,
  strokesIntersectRect,
  strokeWidthUnits,
  type InkCanvasContext,
} from "./pdfAnnotationModel";

function stroke(overrides: Partial<PdfStroke> = {}): PdfStroke {
  return {
    actorId: "teacher-actor-0001",
    id: "0000stroke01",
    page: 1,
    points: [
      { x: 0.1, y: 0.1 },
      { x: 0.5, y: 0.1 },
    ],
    tone: 1,
    tool: "pen",
    width: "m",
    ...overrides,
  };
}

describe("ink palette and geometry", () => {
  it("has 8 tones with readable pen ink and translucent highlights", () => {
    expect(PDF_INK_TONES).toHaveLength(8);
    expect(strokeColor("pen", 1)).toBe("#dc2626");
    expect(strokeColor("highlighter", 0)).toBe("#fde047");
    // Out-of-range peer tones are clamped, never trusted.
    expect(strokeColor("pen", 99)).toBe(PDF_INK_TONES[7]?.pen);
    expect(strokeWidthUnits("pen", "s")).toBeLessThan(
      strokeWidthUnits("pen", "l"),
    );
    expect(strokeWidthUnits("highlighter", "s")).toBeGreaterThan(
      strokeWidthUnits("pen", "l"),
    );
  });

  it("offers ink tools by capability (laser is the presenter's)", () => {
    expect(inkToolsFor("view")).toEqual([]);
    expect(inkToolsFor("edit")).not.toContain("laser");
    expect(inkToolsFor("present")).toContain("laser");
  });

  it("scales normalized points into an aspect-correct viewBox", () => {
    expect(inkViewBox(0.5)).toEqual({ height: 2000, width: 1000 });
    expect(
      strokePathData(
        [
          { x: 0.1, y: 0.5 },
          { x: 0.2, y: 1 },
        ],
        0.5,
      ),
    ).toBe("M100 1000L200 2000");
    expect(strokePathData([{ x: 0, y: 0 }], 1)).toBe("M0 0L0.1 0");
    expect(
      normalizePointer(150, 300, {
        height: 200,
        left: 100,
        top: 200,
        width: 100,
      }),
    ).toEqual({ x: 0.5, y: 0.5 });
    expect(
      normalizePointer(0, 900, {
        height: 200,
        left: 100,
        top: 200,
        width: 100,
      }),
    ).toEqual({ x: 0, y: 1 });
  });

  it("hit-tests the topmost stroke within the eraser reach", () => {
    const first = stroke({ id: "0000stroke01" });
    const second = stroke({ id: "0000stroke02" });
    expect(hitTestStrokes([first, second], { x: 0.3, y: 0.105 }, 1)?.id).toBe(
      "0000stroke02",
    );
    expect(hitTestStrokes([first], { x: 0.3, y: 0.3 }, 1)).toBeNull();
  });

  it("detects strokes inside a crop region", () => {
    expect(
      strokesIntersectRect([stroke()], { height: 0.2, width: 0.2, x: 0, y: 0 }),
    ).toBe(true);
    expect(
      strokesIntersectRect([stroke()], {
        height: 0.2,
        width: 0.2,
        x: 0.7,
        y: 0.7,
      }),
    ).toBe(false);
  });
});

describe("drawStrokesOnCanvas (Kèm nét chữa trên trang)", () => {
  it("composites highlights first then pen ink, mapped into the crop", () => {
    const calls: string[] = [];
    const context: InkCanvasContext = {
      beginPath: () => calls.push("begin"),
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
      lineCap: "butt",
      lineJoin: "miter",
      lineTo: (x, y) => calls.push(`line ${x} ${y}`),
      lineWidth: 1,
      moveTo: (x, y) => calls.push(`move ${x} ${y}`),
      restore: () => calls.push("restore"),
      save: () => calls.push("save"),
      stroke: () =>
        calls.push(`stroke ${context.strokeStyle} ${context.globalAlpha}`),
      strokeStyle: "#000",
    };
    const drawn = drawStrokesOnCanvas(
      context,
      [
        stroke({ id: "pen", tool: "pen" }),
        stroke({ id: "hl", tone: 0, tool: "highlighter" }),
      ],
      { height: 0.5, width: 0.5, x: 0, y: 0 },
      { height: 400, width: 400 },
    );
    expect(drawn).toBe(2);
    expect(calls).toContain("move 80 80");
    expect(calls).toContain("line 400 80");
    const strokes = calls.filter((call) => call.startsWith("stroke"));
    expect(strokes[0]).toBe("stroke #fde047 0.4");
    expect(strokes[1]).toBe("stroke #dc2626 1");
  });
});

describe("presenter laser", () => {
  it("accepts only a bounded page-normalized point", () => {
    expect(parseLaserPoint({ page: 2, x: 0.5, y: 0.25 }, 3)).toEqual({
      page: 2,
      x: 0.5,
      y: 0.25,
    });
    expect(parseLaserPoint({ page: 4, x: 0.5, y: 0.5 }, 3)).toBeNull();
    expect(parseLaserPoint({ page: 1, x: 2, y: 0.5 }, 3)).toBeNull();
    expect(parseLaserPoint("1,0.5,0.5", 3)).toBeNull();
    expect(parseLaserPoint(null, 3)).toBeNull();
  });

  it("publishes at most 20 times per second and never loses the last point", () => {
    let now = 0;
    const timers: Array<{ at: number; run: () => void }> = [];
    const publish = vi.fn();
    const throttle = createLaserThrottle(publish, {
      cancel: () => timers.splice(0),
      now: () => now,
      schedule: (run, delay) => {
        timers.push({ at: now + delay, run });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
    });
    for (let step = 0; step < 5; step += 1) {
      throttle.move({ page: 1, x: step / 10, y: 0.5 });
      now += 10;
    }
    // 5 moves in 40 ms: the first goes out, the rest wait for the window.
    expect(publish).toHaveBeenCalledTimes(1);
    now = 50;
    timers.shift()?.run();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith({ page: 1, x: 0.4, y: 0.5 });
    throttle.clear();
    expect(publish).toHaveBeenLastCalledWith(null);
  });
});

describe("annotation errors", () => {
  it("maps authority codes to polite notices without importing Yjs", () => {
    const error = Object.assign(new Error("page_stroke_limit"), {
      code: "page_stroke_limit",
      name: "PdfAnnotationAuthorityError",
    });
    expect(pdfAnnotationErrorKey(error)).toBe(
      "classroomTools.files.ink.error.pageLimit",
    );
    expect(
      pdfAnnotationErrorKey(
        Object.assign(new Error("x"), {
          code: "stroke_not_owned",
          name: "PdfAnnotationAuthorityError",
        }),
      ),
    ).toBe("classroomTools.files.ink.error.notOwned");
    expect(pdfAnnotationErrorKey(new Error("boom"))).toBe(
      "classroomTools.files.ink.error.failed",
    );
  });
});
