import { describe, expect, it, vi } from "vitest";
import {
  canvasBackingSize,
  classifyPdfLinkTarget,
  createRenderScheduler,
  DOCUMENT_VIEWER_LIMITS,
  findDocumentMatches,
  foldSearchText,
  formatDocumentSize,
  isUsableCrop,
  liveCanvasLimit,
  maxCanvasPixels,
  mostVisiblePage,
  nextMatchPage,
  nudgeCrop,
  rectFromPoints,
  selectLivePages,
  snippetRenderScale,
  stepZoom,
  ThumbnailUrlCache,
} from "./documentViewerModel";

describe("ROOM-TOOLS-FILES-01B virtualized page window", () => {
  it("keeps at most 5 live canvases on desktop and 2 below 768px", () => {
    expect(liveCanvasLimit(1440)).toBe(5);
    expect(liveCanvasLimit(768)).toBe(5);
    expect(liveCanvasLimit(767)).toBe(2);
    expect(liveCanvasLimit(320)).toBe(2);
    expect(maxCanvasPixels(1440)).toBe(16_000_000);
    expect(maxCanvasPixels(320)).toBe(8_000_000);
    expect(DOCUMENT_VIEWER_LIMITS.renderWatchdogMs).toBe(15_000);
  });

  it("selects the current page, the nearest visible pages, then neighbours", () => {
    for (const current of [1, 75, 150]) {
      const desktop = selectLivePages({
        current,
        limit: 5,
        pageCount: 150,
        visible: [current - 1, current, current + 1, current + 2],
      });
      expect(desktop.length).toBeLessThanOrEqual(5);
      expect(desktop[0]).toBe(current);
      expect(desktop.every((page) => page >= 1 && page <= 150)).toBe(true);
      const mobile = selectLivePages({
        current,
        limit: 2,
        pageCount: 150,
        visible: [current, current + 1, current + 2, current + 3],
      });
      expect(mobile.length).toBeLessThanOrEqual(2);
    }
    // Scrolling forward prefers the next page over the previous one.
    expect(
      selectLivePages({
        current: 10,
        direction: 1,
        limit: 3,
        pageCount: 20,
        visible: [10],
      }),
    ).toEqual([10, 11, 9]);
    expect(
      selectLivePages({
        current: 10,
        direction: -1,
        limit: 3,
        pageCount: 20,
        visible: [10],
      }),
    ).toEqual([10, 9, 11]);
    // Many visible pages never exceed the limit (zoomed far out).
    expect(
      selectLivePages({
        current: 5,
        limit: 5,
        pageCount: 30,
        visible: Array.from({ length: 12 }, (_, index) => index + 1),
      }),
    ).toHaveLength(5);
    expect(
      selectLivePages({ current: 1, limit: 5, pageCount: 0, visible: [] }),
    ).toEqual([]);
    expect(
      selectLivePages({ current: 9, limit: 5, pageCount: 3, visible: [] }),
    ).toEqual([3, 2, 1]);
  });

  it("picks the most visible page with earlier pages winning ties", () => {
    expect(
      mostVisiblePage(
        new Map([
          [3, 0.2],
          [4, 0.9],
          [5, 0.1],
        ]),
        1,
      ),
    ).toBe(4);
    expect(
      mostVisiblePage(
        new Map([
          [7, 1],
          [6, 1],
        ]),
        1,
      ),
    ).toBe(6);
    expect(mostVisiblePage(new Map([[2, 0]]), 9)).toBe(9);
  });

  it("caps the canvas backing store at the per-device pixel budget", () => {
    const small = canvasBackingSize({
      cssHeight: 800,
      cssWidth: 600,
      devicePixelRatio: 2,
      maxPixels: 16_000_000,
    });
    expect(small).toMatchObject({ height: 1600, scale: 2, width: 1200 });
    const capped = canvasBackingSize({
      cssHeight: 4000,
      cssWidth: 3000,
      devicePixelRatio: 3,
      maxPixels: 8_000_000,
    });
    expect(capped.width * capped.height).toBeLessThanOrEqual(8_000_000);
    expect(capped.scale).toBeLessThan(3);
  });
});

describe("ROOM-TOOLS-FILES-01B safe link policy", () => {
  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "blob:https://example.org/uuid",
    "file:///etc/passwd",
    "http://insecure.example",
    "ftp://files.example.org/a",
    "tel:+84123456789",
    "https://user:pass@example.org/",
    "https://exa\nmple.org/",
    "/relative/path",
    "",
  ])("blocks %s", (url) => {
    expect(classifyPdfLinkTarget(url)).toEqual({ kind: "blocked" });
  });

  it("allows https with its real host and mailto with its address", () => {
    expect(
      classifyPdfLinkTarget("https://safe.example.org/bai-tap?x=1"),
    ).toEqual({
      display: "safe.example.org",
      href: "https://safe.example.org/bai-tap?x=1",
      kind: "external",
    });
    expect(classifyPdfLinkTarget("mailto:co.ha@truong.edu.vn")).toEqual({
      display: "co.ha@truong.edu.vn",
      href: "mailto:co.ha@truong.edu.vn",
      kind: "mailto",
    });
    expect(classifyPdfLinkTarget("mailto:not an address")).toEqual({
      kind: "blocked",
    });
    expect(classifyPdfLinkTarget(null)).toEqual({ kind: "blocked" });
    expect(classifyPdfLinkTarget(undefined)).toEqual({ kind: "blocked" });
  });
});

describe("ROOM-TOOLS-FILES-01B document search", () => {
  it("folds Vietnamese diacritics when asked", () => {
    expect(foldSearchText("Phương Trình Bậc Hai", true)).toBe(
      "phuong trinh bac hai",
    );
    expect(foldSearchText("Đường tròn", true)).toBe("duong tron");
    expect(foldSearchText("Đường tròn", false)).toBe("đường tròn");
  });

  it("finds pages with accent-insensitive matches and wraps navigation", () => {
    const texts = new Map([
      [1, "Bài 1. Giải phương trình x + 1 = 0"],
      [2, "Hình học không gian"],
      [3, "Phương trình bậc hai và phương trình bậc ba"],
    ]);
    const folded = findDocumentMatches(texts, "phuong trinh", true);
    expect(folded).toEqual([
      { count: 1, page: 1 },
      { count: 2, page: 3 },
    ]);
    expect(findDocumentMatches(texts, "phuong trinh", false)).toEqual([]);
    expect(findDocumentMatches(texts, "PHƯƠNG TRÌNH", false)).toHaveLength(2);
    expect(findDocumentMatches(texts, "   ", true)).toEqual([]);
    expect(nextMatchPage(folded, 1, 1)).toBe(3);
    expect(nextMatchPage(folded, 3, 1)).toBe(1);
    expect(nextMatchPage(folded, 1, -1)).toBe(3);
    expect(nextMatchPage([], 1, 1)).toBeNull();
  });
});

describe("ROOM-TOOLS-FILES-01B zoom, crop and snippet geometry", () => {
  it("steps along the zoom ladder within bounds", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(1.05, 1)).toBe(1.1);
    expect(stepZoom(4, 1)).toBe(4);
    expect(stepZoom(0.5, -1)).toBe(0.5);
  });

  it("builds, nudges and validates normalized crop rectangles", () => {
    const rect = rectFromPoints({ x: 0.8, y: 0.6 }, { x: 0.2, y: 1.4 });
    expect(rect).toEqual({
      height: 0.4,
      width: 0.6000000000000001,
      x: 0.2,
      y: 0.6,
    });
    expect(isUsableCrop(rect)).toBe(true);
    expect(
      isUsableCrop(rectFromPoints({ x: 0.5, y: 0.5 }, { x: 0.51, y: 0.9 })),
    ).toBe(false);
    const moved = nudgeCrop(
      { height: 0.2, width: 0.2, x: 0.79, y: 0 },
      "ArrowRight",
      false,
    );
    expect(moved.x + moved.width).toBeLessThanOrEqual(1);
    const resized = nudgeCrop(
      { height: 0.2, width: 0.2, x: 0, y: 0 },
      "ArrowDown",
      true,
    );
    expect(resized.height).toBeCloseTo(0.22);
  });

  it("keeps the snippet long edge at or below 1,440 px", () => {
    expect(snippetRenderScale(595, 842)).toBe(1440 / 842);
    expect(snippetRenderScale(200, 100)).toBe(2);
    expect(Math.max(3000, 1000) * snippetRenderScale(3000, 1000)).toBe(1440);
  });

  it("formats sizes for both languages", () => {
    expect(formatDocumentSize(1_250_000, "vi-VN")).toBe("1,3 MB");
    expect(formatDocumentSize(1_250_000, "en-US")).toBe("1.3 MB");
    expect(formatDocumentSize(512, "en-US")).toBe("512 B");
  });
});

describe("ROOM-TOOLS-FILES-01B render queue and thumbnail cache", () => {
  it("runs the lowest priority first and drops cancelled jobs", async () => {
    const scheduler = createRenderScheduler(1);
    const order: string[] = [];
    let release: () => void = () => undefined;
    scheduler.schedule(
      () => 0,
      () =>
        new Promise<void>((resolve) => {
          order.push("blocker");
          release = resolve;
        }),
    );
    await Promise.resolve();
    scheduler.schedule(
      () => 9,
      async () => {
        order.push("far");
      },
    );
    const cancel = scheduler.schedule(
      () => 5,
      async () => {
        order.push("cancelled");
      },
    );
    scheduler.schedule(
      () => 1,
      async () => {
        order.push("near");
      },
    );
    cancel();
    release();
    await vi.waitFor(() => expect(order).toHaveLength(3));
    expect(order).toEqual(["blocker", "near", "far"]);
  });

  it("evicts the least recently used thumbnail URL and revokes it", () => {
    const revoke = vi.fn();
    const cache = new ThumbnailUrlCache(2, revoke);
    cache.set(1, "blob:1");
    cache.set(2, "blob:2");
    expect(cache.get(1)).toBe("blob:1");
    cache.set(3, "blob:3");
    expect(revoke).toHaveBeenCalledWith("blob:2");
    expect(cache.has(2)).toBe(false);
    expect(cache.size).toBe(2);
    cache.clear();
    expect(revoke).toHaveBeenCalledWith("blob:1");
    expect(revoke).toHaveBeenCalledWith("blob:3");
    expect(cache.size).toBe(0);
    expect(new ThumbnailUrlCache().size).toBe(0);
  });
});
