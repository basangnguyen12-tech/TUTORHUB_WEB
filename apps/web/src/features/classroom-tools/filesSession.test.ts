import { describe, expect, it, vi } from "vitest";
import {
  CLASSROOM_FILES_RANGE_CACHE_MAX_BYTES,
  createByteRangeCache,
  createClassroomFilesSession,
} from "./filesSession";

const document = {
  activeContent: false,
  displayName: "De.pdf",
  fileID: "file-1",
  firstPageAspect: 0.7,
  mediaType: "application/pdf",
  pageCount: 3,
  versionID: "v1",
};

describe("ROOM-TOOLS-FILES-01B Documents room-session memory", () => {
  it("drops a temporary Chat view, queued navigation and late fetches on close", () => {
    const session = createClassroomFilesSession();
    const view = {
      document: { ...document, fileID: "chat:item" },
      page: 1,
      zoom: 1,
      fitMode: "width" as const,
    };
    const listener = vi.fn();
    session.subscribeChatOpen(listener);
    session.saveBytes("chat:item", "v1", new Uint8Array([1]));
    session.openFromChat(view, "private");
    expect(listener).toHaveBeenCalledOnce();
    session.saveView(view);
    const current = session.beginChatOpen();
    session.releaseBytes();
    expect(session.takeChatOpen()).toBeNull();
    expect(session.readView()).toBeNull();
    expect(session.readBytes("chat:item", "v1")).toBeNull();
    expect(current()).toBe(false);
  });
  it("keeps bytes in RAM by (file, version) with a 2-document LRU", () => {
    const session = createClassroomFilesSession();
    const one = new Uint8Array([1]);
    session.saveBytes("a", "v1", one);
    session.saveBytes("b", "v1", new Uint8Array([2]));
    expect(session.readBytes("a", "v1")).toBe(one);
    expect(session.readBytes("a", "v2")).toBeNull();
    session.saveBytes("c", "v1", new Uint8Array([3]));
    // "a" was read last, so "b" is evicted.
    expect(session.readBytes("b", "v1")).toBeNull();
    expect(session.readBytes("a", "v1")).toBe(one);
    expect(session.readBytes("c", "v1")).not.toBeNull();
  });

  it("releases bytes on stage close and wipes everything on clear", () => {
    const session = createClassroomFilesSession();
    const listener = vi.fn();
    session.subscribe(listener);
    session.saveView({ document, fitMode: "width", page: 2, zoom: 1 });
    session.saveBytes("file-1", "v1", new Uint8Array([1, 2]));
    session.releaseBytes();
    expect(session.readBytes("file-1", "v1")).toBeNull();
    expect(session.readView()?.page).toBe(2);
    session.saveBytes("file-1", "v1", new Uint8Array([1, 2]));
    session.clear();
    expect(session.readView()).toBeNull();
    expect(session.readBytes("file-1", "v1")).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("never stores a file above the in-memory ceiling", () => {
    const session = createClassroomFilesSession();
    const huge = { byteLength: 65 * 1024 * 1024 } as Uint8Array;
    session.saveBytes("big", "v1", huge);
    expect(session.readBytes("big", "v1")).toBeNull();
  });
});

describe("ROOM-TOOLS-FILES-02B Range chunk cache and presentation view", () => {
  it("keeps Range chunks in a ≤ 32 MiB LRU per document version", () => {
    const cache = createByteRangeCache(10);
    cache.set(0, 4, new Uint8Array(4));
    cache.set(4, 8, new Uint8Array(4));
    expect(cache.get(0, 4)).not.toBeNull();
    // 0-4 was read last, so 4-8 is evicted first.
    cache.set(8, 12, new Uint8Array(4));
    expect(cache.get(4, 8)).toBeNull();
    expect(cache.get(0, 4)).not.toBeNull();
    expect(cache.byteLength).toBe(8);
    cache.set(0, 20, new Uint8Array(20));
    expect(cache.get(0, 20)).toBeNull();
    expect(CLASSROOM_FILES_RANGE_CACHE_MAX_BYTES).toBe(32 * 1024 * 1024);
  });

  it("drops Range chunks on a document switch, stage close and sign-out", () => {
    const session = createClassroomFilesSession();
    const first = session.rangeCache("a", "v1");
    first.set(0, 2, new Uint8Array(2));
    expect(session.rangeCache("a", "v1")).toBe(first);
    const second = session.rangeCache("b", "v1");
    expect(second).not.toBe(first);
    expect(first.byteLength).toBe(0);
    second.set(0, 2, new Uint8Array(2));
    session.releaseBytes();
    expect(second.byteLength).toBe(0);
    const third = session.rangeCache("b", "v1");
    third.set(0, 2, new Uint8Array(2));
    session.clear();
    expect(third.byteLength).toBe(0);
  });

  it("remembers one presentation's page and zoom until sign-out", () => {
    const session = createClassroomFilesSession();
    session.savePresentationView({
      fitMode: "width",
      page: 3,
      presentationID: "p-1",
      zoom: 1,
    });
    expect(session.readPresentationView("p-1")?.page).toBe(3);
    expect(session.readPresentationView("p-2")).toBeNull();
    session.releaseBytes();
    expect(session.readPresentationView("p-1")?.page).toBe(3);
    session.clear();
    expect(session.readPresentationView("p-1")).toBeNull();
  });
});
