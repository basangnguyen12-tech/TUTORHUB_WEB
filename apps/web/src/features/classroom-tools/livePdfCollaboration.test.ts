import { CanonicalPdfAnnotationAuthority } from "@tutorhub/collaboration-client";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  createPdfInkStore,
  createPdfLaserFeed,
  type PdfAwarenessLike,
} from "./livePdfCollaboration";

const documentId = "7c0c6f0e-3d7a-4c38-9f15-2a7f9a3d1c22";
const fileId = "8d1c6f0e-3d7a-4c38-9f15-2a7f9a3d1c33";
const scope = { documentId, generation: 1, tenantId: "tenant-0001" };

/** A fake awareness whose peers carry the runtime's server stamp. */
function fakeAwareness() {
  const states = new Map<number, Record<string, unknown>>();
  const listeners = new Set<() => void>();
  const awareness: PdfAwarenessLike = {
    clientID: 1,
    getLocalState: () => states.get(1) ?? null,
    getStates: () => states,
    off: (_event, listener) => listeners.delete(listener as () => void),
    on: (_event, listener) => listeners.add(listener as () => void),
    setLocalStateField: (field, value) =>
      states.set(1, { ...(states.get(1) ?? {}), [field]: value }),
  };
  return {
    awareness,
    emit: () => listeners.forEach((listener) => listener()),
    states,
  };
}

describe("createPdfLaserFeed (isTrustedPresenterAwareness)", () => {
  it("shows only lasers the runtime stamped as present", () => {
    const { awareness, emit, states } = fakeAwareness();
    let now = 0;
    const feed = createPdfLaserFeed(awareness, 3, { now: () => now });
    const changed = vi.fn();
    feed.subscribe(changed);
    // A `view` connection spoofs a laser: ignored.
    states.set(7, {
      pdfLaser: { page: 1, x: 0.5, y: 0.5 },
      tutorhub: { capability: "view" },
    });
    // An `edit` annotator tries too: ignored.
    states.set(8, {
      pdfLaser: { page: 1, x: 0.4, y: 0.4 },
      tutorhub: { capability: "edit" },
    });
    // No stamp at all (e.g. a client-side claim): ignored.
    states.set(9, {
      pdfLaser: { page: 1, x: 0.3, y: 0.3 },
      capability: "present",
    });
    emit();
    expect(feed.marks()).toEqual([]);
    expect(changed).not.toHaveBeenCalled();

    states.set(5, {
      pdfLaser: { page: 2, participantKey: "teacher-key", x: 0.25, y: 0.75 },
      tutorhub: { capability: "present" },
    });
    emit();
    expect(feed.marks()).toEqual([
      { clientID: 5, page: 2, participantKey: "teacher-key", x: 0.25, y: 0.75 },
    ]);
    expect(changed).toHaveBeenCalledTimes(1);

    // Our own (unstamped) local state is never drawn twice.
    awareness.setLocalStateField("pdfLaser", { page: 1, x: 0.1, y: 0.1 });
    emit();
    expect(feed.marks()).toHaveLength(1);

    // Stale after 1.5 s without an update.
    now = 1_600;
    emit();
    expect(feed.marks()).toEqual([]);
    feed.destroy();
  });

  it("rejects malformed or out-of-document laser points", () => {
    const { awareness, emit, states } = fakeAwareness();
    const feed = createPdfLaserFeed(awareness, 2);
    states.set(5, {
      pdfLaser: { page: 9, x: 0.5, y: 0.5 },
      tutorhub: { capability: "present" },
    });
    emit();
    expect(feed.marks()).toEqual([]);
    states.set(5, {
      pdfLaser: { page: 1, x: "0.5", y: 0.5 },
      tutorhub: { capability: "present" },
    });
    emit();
    expect(feed.marks()).toEqual([]);
    feed.destroy();
  });
});

describe("createPdfInkStore", () => {
  it("caches strokes and meta per document version and notifies on change", () => {
    const doc = new Y.Doc();
    const authority = new CanonicalPdfAnnotationAuthority(
      doc,
      scope,
      "teacher-actor-0001",
      { capability: "present" },
    );
    authority.initialize({ fileId, pageCount: 3, versionId: "v1" });
    const store = createPdfInkStore(authority);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const before = store.strokes(1);
    expect(store.strokes(1)).toBe(before);
    expect(before).toEqual([]);
    authority.addStroke(1, {
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.2, y: 0.2 },
      ],
      tone: 1,
      tool: "pen",
      width: "m",
    });
    expect(listener).toHaveBeenCalled();
    const after = store.strokes(1);
    expect(after).toHaveLength(1);
    expect(store.version()).toBeGreaterThan(0);
    expect(store.canUndo()).toBe(true);
    authority.setPresenterPage(3);
    expect(store.meta().presenterPage).toBe(3);
    unsubscribe();
    authority.destroy();
  });
});
