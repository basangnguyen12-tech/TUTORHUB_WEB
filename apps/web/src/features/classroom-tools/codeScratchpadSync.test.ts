import {
  APIRequestError,
  type CodeScratchpad,
  type PutCodeScratchpadRequest,
} from "@tutorhub/api-client";
import { describe, expect, it, vi } from "vitest";
import {
  CodeScratchpadSync,
  existingScratchpadSync,
  scratchpadRequest,
  scratchpadSyncFor,
  snapshotFromScratchpad,
  type ScratchpadSyncAPI,
} from "./codeScratchpadSync";
import { createClassroomCodeSession } from "./codeSession";
import type { ClassroomCodeWorkspaceSnapshot } from "./codeSession";

function draft(version: number, content = "x = 1"): CodeScratchpad {
  return {
    active_index: 0,
    byte_length: content.length,
    created_at: "2030-08-03T00:00:00Z",
    expires_at: "2030-09-02T00:00:00Z",
    files: [{ content, language: "python", name: "main.py" }],
    id: "0d6c4d64-8d4c-4f3c-b0f5-7b6e1b9b2a44",
    media_space_id: "c2dc1048-1d90-4c90-ae50-5fb436bfb607",
    shared_at: null,
    shared_with_staff: false,
    stdin: "",
    updated_at: "2030-08-03T00:00:00Z",
    version,
  };
}

function problem(status: number, code: string) {
  return new APIRequestError(status, {
    code,
    status,
    title: code,
    type: "about:blank",
  });
}

/** A fake server: one live draft with CAS on `expected_version`. */
function fakeServer(initial: CodeScratchpad | null = null) {
  let current = initial;
  const saves: PutCodeScratchpadRequest[] = [];
  const api: ScratchpadSyncAPI = {
    fetch: vi.fn(async () => ({ scratchpad: current })),
    save: vi.fn(async (input: PutCodeScratchpadRequest) => {
      saves.push(input);
      if ((input.expected_version ?? 0) !== (current?.version ?? 0)) {
        throw problem(409, "code_scratchpad_version_conflict");
      }
      current = {
        ...draft((current?.version ?? 0) + 1),
        files: input.files,
        shared_with_staff: current?.shared_with_staff ?? false,
        stdin: input.stdin ?? "",
      };
      return current;
    }),
    share: vi.fn(async (shared: boolean) => {
      if (!current) throw problem(409, "code_scratchpad_empty");
      current = { ...current, shared_with_staff: shared };
      return { scratchpad: current };
    }),
  };
  return {
    api,
    bump: (content: string) => {
      current = { ...draft((current?.version ?? 0) + 1, content) };
    },
    current: () => current,
    saves,
  };
}

function workspace(content: string): ClassroomCodeWorkspaceSnapshot {
  return {
    activeIndex: 0,
    files: [{ content, language: "python", name: "main.py" }],
    stdin: "",
  };
}

function mount(sync: CodeScratchpadSync, initial: string) {
  let screen = workspace(initial);
  const applied: ClassroomCodeWorkspaceSnapshot[] = [];
  const detach = sync.attach({
    apply: (snapshot) => {
      applied.push(snapshot);
      screen = snapshot;
    },
    read: () => screen,
  });
  return {
    applied,
    detach,
    screen: () => screen,
    type: (content: string) => {
      screen = workspace(content);
      sync.markDirty();
    },
  };
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 2));
  }
  throw new Error("condition not met");
}

describe("CodeScratchpadSync (ROOM-TOOLS-CODE-03B)", () => {
  it("opens the server copy when nothing was edited in this session", async () => {
    const server = fakeServer(draft(3, "print('server')"));
    const sync = new CodeScratchpadSync(server.api, 5);
    const view = mount(sync, "print('local')");
    await until(() => sync.getState().loaded);
    expect(view.applied).toHaveLength(1);
    expect(view.screen().files[0]?.content).toBe("print('server')");
    expect(sync.getState()).toMatchObject({ status: "saved", version: 3 });
    expect(server.api.save).not.toHaveBeenCalled();
  });

  it("keeps fresh edits over the server copy and saves them with CAS", async () => {
    const server = fakeServer(draft(2, "old"));
    const sync = new CodeScratchpadSync(server.api, 5);
    let screen = workspace("typed before the read finished");
    sync.markDirty();
    const apply = vi.fn();
    sync.attach({ apply, read: () => screen });
    await until(() => sync.getState().status === "saved");
    expect(apply).not.toHaveBeenCalled();
    expect(server.saves[0]?.expected_version).toBe(2);
    expect(server.current()?.files[0]?.content).toBe(
      "typed before the read finished",
    );
    screen = workspace("second edit");
    sync.markDirty();
    await until(() => sync.getState().version === 4);
    expect(server.saves[1]?.expected_version).toBe(3);
  });

  it("debounces edits and runs one request at a time", async () => {
    const server = fakeServer(null);
    const sync = new CodeScratchpadSync(server.api, 20);
    const view = mount(sync, "a");
    await until(() => sync.getState().loaded);
    view.type("ab");
    view.type("abc");
    view.type("abcd");
    await until(() => sync.getState().status === "saved");
    expect(server.saves).toHaveLength(1);
    expect(server.saves[0]).toMatchObject({ expected_version: 0 });
    expect(server.current()?.files[0]?.content).toBe("abcd");
  });

  it("stops autosave on a version conflict until the person chooses", async () => {
    const server = fakeServer(null);
    const sync = new CodeScratchpadSync(server.api, 5);
    const view = mount(sync, "mine");
    await until(() => sync.getState().loaded);
    server.bump("from another tab");
    view.type("mine v2");
    await until(() => sync.getState().status === "conflict");
    const attempts = server.saves.length;
    view.type("mine v3");
    await new Promise((resolve) => globalThis.setTimeout(resolve, 30));
    expect(server.saves).toHaveLength(attempts);
    expect(view.screen().files[0]?.content).toBe("mine v3");

    await sync.reloadFromServer();
    expect(view.screen().files[0]?.content).toBe("from another tab");
    expect(sync.getState()).toMatchObject({ dirty: false, status: "saved" });

    server.bump("yet another tab");
    view.type("keep this");
    await until(() => sync.getState().status === "conflict");
    await sync.overwriteServer();
    expect(sync.getState().status).toBe("saved");
    expect(server.current()?.files[0]?.content).toBe("keep this");
  });

  it("reports size and quota refusals without touching the text", async () => {
    const server = fakeServer(null);
    server.api.save = vi
      .fn()
      .mockRejectedValueOnce(problem(413, "code_scratchpad_too_large"))
      .mockRejectedValueOnce(problem(409, "code_storage_quota_exceeded"));
    const sync = new CodeScratchpadSync(server.api, 5);
    const view = mount(sync, "big");
    await until(() => sync.getState().loaded);
    view.type("bigger");
    await until(() => sync.getState().status === "error");
    expect(sync.getState()).toMatchObject({ dirty: true, error: "too_large" });
    view.type("biggest");
    await until(() => sync.getState().error === "storage_quota");
    expect(view.screen().files[0]?.content).toBe("biggest");
  });

  it("saves before sharing, then toggles consent without a version bump", async () => {
    const server = fakeServer(null);
    const sync = new CodeScratchpadSync(server.api, 1_000);
    mount(sync, "print('bai lam')");
    await until(() => sync.getState().loaded);
    await expect(sync.setShared(true)).resolves.toBe(true);
    expect(server.saves).toHaveLength(1);
    expect(sync.getState()).toMatchObject({ shared: true, version: 1 });
    await expect(sync.setShared(false)).resolves.toBe(true);
    expect(sync.getState()).toMatchObject({ shared: false, version: 1 });
    expect(server.saves).toHaveLength(1);
  });

  it("flushes unsaved work when the workspace unmounts and keeps it for the next mount", async () => {
    const server = fakeServer(null);
    const session = createClassroomCodeSession();
    const sync = scratchpadSyncFor(session, "tenant", "space", {
      api: server.api,
    });
    expect(existingScratchpadSync(session, "tenant", "space")).toBe(sync);
    expect(existingScratchpadSync(session, "tenant", "other")).toBeNull();
    const view = mount(sync, "a");
    await until(() => sync.getState().loaded);
    view.type("left mid-edit");
    view.detach();
    await until(() => sync.getState().status === "saved");
    expect(server.current()?.files[0]?.content).toBe("left mid-edit");
    // Remounting never re-reads (and never overwrites the screen).
    const again = mount(sync, "left mid-edit");
    expect(again.applied).toHaveLength(0);
    expect(server.api.fetch).toHaveBeenCalledTimes(1);
  });

  it("reads the server copy again when the workspace left before the first read finished", async () => {
    const server = fakeServer(draft(4, "print('server')"));
    const sync = new CodeScratchpadSync(server.api, 5);
    const first = mount(sync, "print('local')");
    first.detach();
    await until(() => sync.getState().status === "idle");
    expect(sync.getState().loaded).toBe(false);
    expect(first.applied).toHaveLength(0);
    const second = mount(sync, "print('local')");
    await until(() => sync.getState().loaded);
    expect(second.screen().files[0]?.content).toBe("print('server')");
    expect(server.api.save).not.toHaveBeenCalled();
  });

  it("maps drafts and requests with bounded indexes", () => {
    expect(
      snapshotFromScratchpad({ ...draft(1), active_index: 9 }).activeIndex,
    ).toBe(0);
    expect(
      scratchpadRequest({ ...workspace("x"), activeIndex: 5 }, 7),
    ).toMatchObject({ active_index: 0, expected_version: 7 });
  });
});
