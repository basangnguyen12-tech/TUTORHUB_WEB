import { describe, expect, it, vi } from "vitest";
import { createClassroomFilesSession } from "./filesSession";

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
