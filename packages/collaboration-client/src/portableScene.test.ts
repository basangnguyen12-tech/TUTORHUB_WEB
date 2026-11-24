import { describe, expect, it } from "vitest";
import {
  semanticHash,
  WHITEBOARD_PAPER_MODES,
  type CanonicalExcalidrawSceneV1,
} from "./canonicalAuthority.js";
import {
  exportPortableScene,
  importPortableScene,
  PORTABLE_EXCALIDRAW_LIMITS,
} from "./portableScene.js";

describe("portable Excalidraw scene", () => {
  it("round-trips one bounded canonical scene", () => {
    const scene = createScene();
    const bytes = exportPortableScene(scene, "2026-08-22T00:00:00.000Z");
    expect(importPortableScene(bytes)).toEqual(scene);
  });

  it.each([
    [
      "external URL",
      {
        elements: [
          { ...createScene().elements[0], link: "https://example.invalid/a" },
        ],
      },
    ],
    ["path traversal", { page: { ...createScene().page, name: "../private" } }],
    [
      "active SVG",
      {
        files: { "file-1": { dataURL: "data:image/svg+xml;base64,PHN2Zz4=" } },
      },
    ],
    [
      "active HTML",
      { elements: [{ ...createScene().elements[0], text: "<iframe src=x>" }] },
    ],
  ])("rejects %s without external resolution", (_name, override) => {
    const scene = { ...createScene(), ...override };
    expect(() => exportPortableScene(scene)).toThrowError(
      "portable_active_content_denied",
    );
  });

  it("keeps the portable envelope of a scene without paper fields unchanged", () => {
    const scene = createScene();
    const bytes = exportPortableScene(scene, "2026-08-22T00:00:00.000Z");
    const envelope = JSON.parse(new TextDecoder().decode(bytes)) as {
      scene: CanonicalExcalidrawSceneV1;
      semanticHash: string;
    };
    expect(envelope.semanticHash).toBe("fnv1a64:32048562f4a9921b");
    expect(Object.keys(envelope.scene.page).sort()).toEqual([
      "backgroundColor",
      "id",
      "name",
    ]);
  });

  it.each(
    WHITEBOARD_PAPER_MODES.flatMap((paperMode) =>
      [false, true].map((paperDark) => [paperMode, paperDark] as const),
    ),
  )(
    "round-trips paper mode %s (paperDark %s) through the portable envelope",
    (paperMode, paperDark) => {
      const base = createScene();
      const scene: CanonicalExcalidrawSceneV1 = {
        ...base,
        page: { ...base.page, paperDark, paperMode },
      };
      const bytes = exportPortableScene(scene, "2026-08-22T00:00:00.000Z");
      const imported = importPortableScene(bytes);
      expect(imported).toEqual(scene);
      expect(imported.page.paperMode).toBe(paperMode);
      expect(imported.page.paperDark).toBe(paperDark);
      expect(semanticHash(imported)).toBe(semanticHash(scene));
    },
  );

  it.each([
    ["unknown paper mode", { paperMode: "hexagonal" }],
    ["string paperDark", { paperDark: "yes" }],
  ])("refuses to export or import a %s", (_name, override) => {
    const base = createScene();
    const scene = { ...base, page: { ...base.page, ...override } };
    expect(() => exportPortableScene(scene)).toThrowError("scene_invalid");

    const valid = exportPortableScene(base, "2026-08-22T00:00:00.000Z");
    const tampered = JSON.parse(new TextDecoder().decode(valid)) as {
      scene: { page: Record<string, unknown> };
    };
    Object.assign(tampered.scene.page, override);
    expect(() =>
      importPortableScene(new TextEncoder().encode(JSON.stringify(tampered))),
    ).toThrowError("portable_corrupt");
  });

  it("rejects an oversized import before parsing", () => {
    expect(() =>
      importPortableScene(
        new Uint8Array(PORTABLE_EXCALIDRAW_LIMITS.maxBytes + 1),
      ),
    ).toThrowError("portable_too_large");
  });
});

function createScene(): CanonicalExcalidrawSceneV1 {
  return {
    elements: [
      {
        height: 40,
        id: "element-1",
        text: "TutorHub",
        type: "text",
        width: 120,
        x: 10,
        y: 20,
      },
    ],
    files: {},
    page: { backgroundColor: "#ffffff", id: "page-1", name: "Lesson" },
    schemaVersion: 1,
  };
}
