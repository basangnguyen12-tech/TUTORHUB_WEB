import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  canonicalSceneToExcalidraw,
  CanonicalExcalidrawAuthority,
  CanonicalSceneError,
  excalidrawSceneToCanonical,
  semanticHash,
  validateCanonicalScene,
  WHITEBOARD_PAPER_MODES,
  type CanonicalAuthorityScope,
  type CanonicalElementV1,
  type CanonicalExcalidrawSceneV1,
} from "./canonicalAuthority.js";

const scope: CanonicalAuthorityScope = {
  documentId: "board-p512",
  generation: 12,
  tenantId: "tenant-p512",
};

interface Peer {
  actorId: string;
  authority: CanonicalExcalidrawAuthority;
  document: Y.Doc;
}

const peers: Peer[] = [];

afterEach(() => {
  for (const peer of peers.splice(0)) {
    peer.authority.destroy();
    peer.document.destroy();
  }
});

describe("P5-COLLAB-12 canonical convergence and actor-local history", () => {
  it("converges 25 offline cycles after duplicate and out-of-order delivery, undo/redo, and restore", () => {
    const teacher = createPeer("teacher-a");
    teacher.authority.initialize({
      elements: [],
      files: {},
      page: {
        backgroundColor: "#ffffff",
        id: "page-p512",
        name: "P5-12",
      },
      schemaVersion: 1,
    });
    const student = createPeer(
      "student-b",
      teacher.authority.encodeProviderState(),
    );
    const assistant = createPeer(
      "assistant-c",
      teacher.authority.encodeProviderState(),
    );
    const activePeers = [teacher, student, assistant];

    for (let cycle = 0; cycle < 25; cycle += 1) {
      expectConverged(activePeers);
      const commonWatermark = teacher.authority.encodeCausalWatermark();

      for (const [index, peer] of activePeers.entries()) {
        peer.authority.putElement(
          rectangle(`${peer.actorId}-${cycle}`, cycle * 100 + index * 20),
        );
      }

      const offlineUpdates = activePeers.map((peer) =>
        Y.encodeStateAsUpdate(peer.document, commonWatermark),
      );
      for (const [targetIndex, target] of activePeers.entries()) {
        const deliveryOrder = [
          (targetIndex + 2) % activePeers.length,
          targetIndex,
          (targetIndex + 1) % activePeers.length,
        ];
        for (const sourceIndex of deliveryOrder) {
          target.authority.applyRemoteUpdate(
            requireUpdate(offlineUpdates, sourceIndex),
          );
        }
        target.authority.applyRemoteUpdate(
          requireUpdate(offlineUpdates, deliveryOrder[0] ?? -1),
        );
      }
      expectConverged(activePeers);

      const historyPeer = activePeers[cycle % activePeers.length] as Peer;
      const localElementId = `${historyPeer.actorId}-${cycle}`;
      const remoteElementId = `${
        activePeers[(cycle + 1) % activePeers.length]?.actorId
      }-${cycle}`;
      expect(historyPeer.authority.undo()).toBe(true);
      expect(sceneIds(historyPeer)).not.toContain(localElementId);
      expect(sceneIds(historyPeer)).toContain(remoteElementId);

      if (cycle % 2 === 0) {
        expect(historyPeer.authority.redo()).toBe(true);
        expect(sceneIds(historyPeer)).toContain(localElementId);
      }

      for (const target of activePeers) {
        if (target === historyPeer) continue;
        const historyUpdate = Y.encodeStateAsUpdate(
          historyPeer.document,
          Y.encodeStateVector(target.document),
        );
        target.authority.applyRemoteUpdate(historyUpdate);
        target.authority.applyRemoteUpdate(historyUpdate);
      }
      expectConverged(activePeers);
    }

    const restored = createPeer(
      "restore-reader",
      teacher.authority.encodeProviderState(),
    );
    expect(restored.authority.getSemanticHash()).toBe(
      teacher.authority.getSemanticHash(),
    );
    expect(restored.authority.encodeCausalWatermark()).toEqual(
      teacher.authority.encodeCausalWatermark(),
    );
  }, 15_000);
});

describe("WHITEBOARD-PAPER-01 optional page paper metadata", () => {
  // Golden hashes captured from the build that predates paperMode/paperDark:
  // existing documents, fixtures and B2 snapshots must keep them bit for bit.
  const LEGACY_EMPTY_HASH = "fnv1a64:7a4a512a7b8a73e1";
  const LEGACY_TEXT_HASH = "fnv1a64:32048562f4a9921b";

  it("keeps the canonical page shape and semantic hash of scenes without paper fields", () => {
    const legacy = legacyScene("page-p512", "P5-12");
    const canonical = validateCanonicalScene(legacy);
    expect(Object.keys(canonical.page).sort()).toEqual([
      "backgroundColor",
      "id",
      "name",
    ]);
    expect(semanticHash(legacy)).toBe(LEGACY_EMPTY_HASH);
    expect(
      semanticHash({
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
      }),
    ).toBe(LEGACY_TEXT_HASH);

    // Explicit `undefined` never materialises a key or an implicit "plain".
    const explicitUndefined = validateCanonicalScene({
      ...legacy,
      page: { ...legacy.page, paperDark: undefined, paperMode: undefined },
    });
    expect("paperMode" in explicitUndefined.page).toBe(false);
    expect("paperDark" in explicitUndefined.page).toBe(false);
    expect(semanticHash(explicitUndefined)).toBe(LEGACY_EMPTY_HASH);

    const projection = canonicalSceneToExcalidraw(legacy);
    expect(Object.keys(projection.page).sort()).toEqual(["id", "name"]);
    expect(semanticHash(excalidrawSceneToCanonical(projection))).toBe(
      LEGACY_EMPTY_HASH,
    );

    const teacher = createPeer("teacher-legacy");
    teacher.authority.initialize(legacy);
    expect(teacher.authority.getSemanticHash()).toBe(LEGACY_EMPTY_HASH);
    const student = createPeer(
      "student-legacy",
      teacher.authority.encodeProviderState(),
    );
    expect(student.authority.getScene().page).toEqual(legacy.page);
    expect(student.authority.getSemanticHash()).toBe(LEGACY_EMPTY_HASH);
  });

  it("round-trips every paper mode and paperDark value from a teacher Y.Doc to a student Y.Doc", () => {
    const teacher = createPeer("teacher-paper");
    teacher.authority.initialize(legacyScene());
    const student = createPeer(
      "student-paper",
      teacher.authority.encodeProviderState(),
    );
    teacher.authority.putElement(rectangle("paper-ink", 40));
    student.authority.applyRemoteUpdate(
      teacher.authority.encodeProviderState(),
    );

    for (const paperMode of WHITEBOARD_PAPER_MODES) {
      for (const paperDark of [false, true]) {
        const watermark = student.authority.encodeCausalWatermark();
        const current = teacher.authority.getScene();
        teacher.authority.replaceScene({
          ...current,
          page: {
            ...current.page,
            backgroundColor: paperDark ? "#1e293b" : "#fdfdfd",
            paperDark,
            paperMode,
          },
        });
        student.authority.applyRemoteUpdate(
          Y.encodeStateAsUpdate(teacher.document, watermark),
        );

        const received = student.authority.getScene();
        expect(received.page.paperMode).toBe(paperMode);
        expect(received.page.paperDark).toBe(paperDark);
        expect(received.elements.map((element) => element.id)).toEqual([
          "paper-ink",
        ]);
        expect(student.authority.getSemanticHash()).toBe(
          teacher.authority.getSemanticHash(),
        );

        const projection = student.authority.getProjection();
        expect(projection.page).toEqual({
          id: "page-paper",
          name: "Paper lesson",
          paperDark,
          paperMode,
        });
        expect(excalidrawSceneToCanonical(projection)).toEqual(received);
      }
    }

    // A late joiner restored from the full provider state sees the same paper.
    const restored = createPeer(
      "restore-paper",
      teacher.authority.encodeProviderState(),
    );
    expect(restored.authority.getScene().page).toEqual({
      backgroundColor: "#1e293b",
      id: "page-paper",
      name: "Paper lesson",
      paperDark: true,
      paperMode: "blackboard",
    });
  });

  it("keeps paperMode and paperDark independent and optional", () => {
    const base = legacyScene();
    const modeOnly = validateCanonicalScene({
      ...base,
      page: { ...base.page, paperMode: "grid" },
    });
    expect(modeOnly.page).toEqual({
      backgroundColor: "#ffffff",
      id: "page-paper",
      name: "Paper lesson",
      paperMode: "grid",
    });
    const darkOnly = validateCanonicalScene({
      ...base,
      page: { ...base.page, paperDark: true },
    });
    expect(darkOnly.page).toEqual({
      backgroundColor: "#ffffff",
      id: "page-paper",
      name: "Paper lesson",
      paperDark: true,
    });
    expect(semanticHash(modeOnly)).not.toBe(semanticHash(base));
    expect(semanticHash(darkOnly)).not.toBe(semanticHash(base));
  });

  it.each([
    ["an unknown paper mode", { paperMode: "hexagonal" }],
    ["a non-string paper mode", { paperMode: 7 }],
    ["a null paper mode", { paperMode: null }],
    ["a mixed-case paper mode", { paperMode: "Grid" }],
    ["a string paperDark", { paperDark: "yes" }],
    ["a numeric paperDark", { paperDark: 1 }],
    ["a null paperDark", { paperDark: null }],
  ])("fails closed on %s", (_name, override) => {
    const base = legacyScene();
    const scene = { ...base, page: { ...base.page, ...override } };
    expectSceneInvalid(() => validateCanonicalScene(scene));
    expectSceneInvalid(() =>
      excalidrawSceneToCanonical({
        appState: { viewBackgroundColor: "#ffffff" },
        elements: [],
        files: {},
        page: { id: "page-paper", name: "Paper lesson", ...override },
      }),
    );
    const teacher = createPeer("teacher-invalid");
    teacher.authority.initialize(base);
    expectSceneInvalid(() => teacher.authority.replaceScene(scene));
    expect(teacher.authority.getSemanticHash()).toBe(semanticHash(base));
  });

  it("rejects a remote update that stores an unsupported paper mode", () => {
    const teacher = createPeer("teacher-remote");
    teacher.authority.initialize(legacyScene());
    const student = createPeer(
      "student-remote",
      teacher.authority.encodeProviderState(),
    );
    const watermark = student.authority.encodeCausalWatermark();
    teacher.document
      .getMap<string>("tutorhub.excalidraw.page.v1")
      .set(
        "state",
        JSON.stringify({ ...legacyScene().page, paperMode: "hexagonal" }),
      );
    let thrown: unknown;
    try {
      student.authority.applyRemoteUpdate(
        Y.encodeStateAsUpdate(teacher.document, watermark),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CanonicalSceneError);
    expect((thrown as CanonicalSceneError).code).toBe("scene_invalid");
    expect(student.authority.getScene().page).toEqual(legacyScene().page);
  });

  it("undoes and redoes a paper mode change in a single step without reverting prior strokes", () => {
    const teacher = createPeer("teacher-paper-undo");
    teacher.authority.initialize(legacyScene());
    teacher.authority.putElement(rectangle("stroke-before-paper", 64));

    const beforePaper = teacher.authority.getScene();
    teacher.authority.replaceScene({
      ...beforePaper,
      page: {
        ...beforePaper.page,
        backgroundColor: "#fdfdfd",
        paperDark: false,
        paperMode: "notebook",
      },
    });
    expect(teacher.authority.getScene().page.paperMode).toBe("notebook");
    expect(sceneIds(teacher)).toEqual(["stroke-before-paper"]);

    expect(teacher.authority.undo()).toBe(true);
    expect(teacher.authority.getScene().page.paperMode).toBeUndefined();
    expect(sceneIds(teacher)).toEqual(["stroke-before-paper"]);

    expect(teacher.authority.redo()).toBe(true);
    expect(teacher.authority.getScene().page.paperMode).toBe("notebook");
    expect(sceneIds(teacher)).toEqual(["stroke-before-paper"]);
  });
});

function legacyScene(
  id = "page-paper",
  name = "Paper lesson",
): CanonicalExcalidrawSceneV1 {
  return {
    elements: [],
    files: {},
    page: { backgroundColor: "#ffffff", id, name },
    schemaVersion: 1,
  };
}

function expectSceneInvalid(action: () => unknown): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CanonicalSceneError);
  expect((thrown as CanonicalSceneError).code).toBe("scene_invalid");
}

function createPeer(actorId: string, initialState?: Uint8Array): Peer {
  const document = new Y.Doc();
  const authority = new CanonicalExcalidrawAuthority(document, scope, actorId);
  const peer = { actorId, authority, document };
  peers.push(peer);
  if (initialState !== undefined) authority.applyRemoteUpdate(initialState);
  return peer;
}

function rectangle(id: string, x: number): CanonicalElementV1 {
  return {
    height: 80,
    id,
    type: "rectangle",
    width: 120,
    x,
    y: 120,
  };
}

function sceneIds(peer: Peer): string[] {
  return peer.authority.getScene().elements.map((element) => element.id);
}

function expectConverged(candidates: Peer[]): void {
  const expectedHash = candidates[0]?.authority.getSemanticHash();
  expect(expectedHash).toBeDefined();
  for (const candidate of candidates) {
    expect(candidate.authority.getSemanticHash()).toBe(expectedHash);
  }
}

function requireUpdate(updates: Uint8Array[], index: number): Uint8Array {
  const update = updates[index];
  if (update === undefined) throw new Error("p512_fixture_update_missing");
  return update;
}
