import {
  validateCanonicalScene,
  type CanonicalExcalidrawSceneV1,
} from "@tutorhub/collaboration-client";
import { describe, expect, it, vi } from "vitest";
import {
  countDocumentSnippets,
  createWhiteboardSnippetBridge,
  dataURLByteLength,
  DOCUMENT_SNIPPET_MAX_PER_BOARD,
  planDocumentSnippetInsertion,
  type PendingWhiteboardSnippet,
} from "./whiteboardSnippetBridge";

const viewport = { centerX: 400, centerY: 300, height: 600, width: 800 };

function emptyScene(): CanonicalExcalidrawSceneV1 {
  return validateCanonicalScene({
    elements: [],
    files: {},
    page: { backgroundColor: "#ffffff", id: "page-1", name: "Page 1" },
    schemaVersion: 1,
  });
}

function snippet(
  overrides: Partial<PendingWhiteboardSnippet> = {},
): PendingWhiteboardSnippet {
  const dataURL = `data:image/webp;base64,${"A".repeat(4000)}`;
  return {
    byteLength: dataURLByteLength(dataURL),
    createdAt: 1,
    dataURL,
    height: 600,
    id: "3b5c7c1e-2b9d-4c55-9f61-3f51f0d8a001",
    mimeType: "image/webp",
    pageNumber: 2,
    sourceName: "De.pdf",
    width: 1200,
    ...overrides,
  };
}

describe("ROOM-TOOLS-FILES-01B whiteboard snippet bridge", () => {
  it("queues one snippet, notifies, and records the outcome", () => {
    const bridge = createWhiteboardSnippetBridge();
    const listener = vi.fn();
    const unsubscribe = bridge.subscribe(listener);
    bridge.push(snippet({ id: "old" }));
    bridge.push(snippet({ id: "new" }));
    expect(bridge.peek()?.id).toBe("new");
    expect(bridge.take()?.id).toBe("new");
    expect(bridge.take()).toBeNull();
    bridge.report("new", "inserted");
    expect(bridge.lastReport()).toEqual({
      outcome: "inserted",
      snippetID: "new",
    });
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
    bridge.push(snippet());
    bridge.clear();
    expect(bridge.peek()).toBeNull();
    expect(bridge.lastReport()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("measures the decoded size of a data URL", () => {
    expect(dataURLByteLength("data:image/webp;base64,QUJD")).toBe(3);
    expect(dataURLByteLength("data:image/webp;base64,QUI=")).toBe(2);
    expect(dataURLByteLength("no comma")).toBe(Number.POSITIVE_INFINITY);
  });

  it("plans a locked, centred image with a locked caption and its file", () => {
    const plan = planDocumentSnippetInsertion(
      emptyScene(),
      snippet(),
      viewport,
      { caption: "Trích từ De.pdf — trang 2", now: 10, random: () => 0.5 },
    );
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    const scene = validateCanonicalScene(plan.scene);
    const [image, caption] = scene.elements;
    expect(image).toMatchObject({
      fileId: plan.fileID,
      locked: true,
      status: "saved",
      type: "image",
    });
    expect(caption).toMatchObject({
      locked: true,
      text: "Trích từ De.pdf — trang 2",
      type: "text",
    });
    // Scaled into 70 % of the visible width, centred horizontally.
    expect(image?.width).toBe(560);
    expect(image?.height).toBe(280);
    expect((image?.x ?? 0) + (image?.width ?? 0) / 2).toBe(400);
    expect(plan.fileID.startsWith("doc-snip-")).toBe(true);
    expect(scene.files[plan.fileID]).toMatchObject({
      id: plan.fileID,
      mimeType: "image/webp",
    });
    expect(countDocumentSnippets(scene)).toBe(1);
  });

  it("refuses the 13th snippet and anything above 40 KiB", () => {
    let scene = emptyScene();
    for (let index = 0; index < DOCUMENT_SNIPPET_MAX_PER_BOARD; index += 1) {
      const plan = planDocumentSnippetInsertion(
        scene,
        snippet({ id: `s-${index}` }),
        viewport,
        { caption: "x" },
      );
      if (plan.kind !== "ok") throw new Error("expected ok");
      scene = plan.scene;
    }
    expect(countDocumentSnippets(scene)).toBe(12);
    expect(
      planDocumentSnippetInsertion(scene, snippet({ id: "13" }), viewport, {
        caption: "x",
      }),
    ).toEqual({ kind: "limit" });

    const big = `data:image/webp;base64,${"A".repeat(56_000)}`;
    expect(
      planDocumentSnippetInsertion(
        emptyScene(),
        snippet({ byteLength: 1000, dataURL: big }),
        viewport,
        { caption: "x" },
      ),
    ).toEqual({ kind: "tooLarge" });
    expect(
      planDocumentSnippetInsertion(
        emptyScene(),
        snippet({ dataURL: "data:text/html;base64,QUJD" }),
        viewport,
        { caption: "x" },
      ),
    ).toEqual({ kind: "tooLarge" });
  });
});
