import { afterEach, describe, expect, it } from "vitest";
import { clearCodeDraftStorage } from "../../app/session";
import {
  CODE_DRAFT_TTL_MS,
  codeDraftKey,
  readCodeDraft,
  removeCodeDraft,
  writeCodeDraft,
} from "./codeDraftStorage";
import type { ClassroomCodeWorkspaceSnapshot } from "./codeSession";

const scope = {
  actorID: "actor-1",
  mediaSpaceID: "space-1",
  tenantID: "tenant-1",
};
const workspace: ClassroomCodeWorkspaceSnapshot = {
  activeIndex: 0,
  files: [{ content: "print('nháp')", language: "python", name: "main.py" }],
  stdin: "",
};

describe("ROOM-TOOLS-CODE-01 bounded code draft", () => {
  afterEach(() => localStorage.clear());

  it("round-trips a draft scoped to tenant, actor and media space", () => {
    const now = 1_800_000_000_000;
    expect(writeCodeDraft(scope, workspace, now)).toBe(true);
    expect(codeDraftKey(scope)).toBe(
      "tutorhub:code-draft:v1:tenant-1:actor-1:space-1",
    );
    expect(readCodeDraft(scope, now + 1_000)).toEqual(workspace);
    expect(readCodeDraft({ ...scope, actorID: "actor-2" }, now)).toBeNull();
    expect(readCodeDraft({ ...scope, tenantID: "" }, now)).toBeNull();
  });

  it("expires after 8 hours and drops tampered or oversized records", () => {
    const now = 1_800_000_000_000;
    writeCodeDraft(scope, workspace, now);
    expect(readCodeDraft(scope, now + CODE_DRAFT_TTL_MS + 1)).toBeNull();
    expect(localStorage.getItem(codeDraftKey(scope))).toBeNull();

    // A record copied from another actor's key is rejected.
    writeCodeDraft({ ...scope, actorID: "actor-2" }, workspace, now);
    localStorage.setItem(
      codeDraftKey(scope),
      localStorage.getItem(codeDraftKey({ ...scope, actorID: "actor-2" }))!,
    );
    expect(readCodeDraft(scope, now)).toBeNull();

    localStorage.setItem(codeDraftKey(scope), "{not json");
    expect(readCodeDraft(scope, now)).toBeNull();
    localStorage.setItem(codeDraftKey(scope), "x".repeat(97 * 1024));
    expect(readCodeDraft(scope, now)).toBeNull();
    expect(localStorage.getItem(codeDraftKey(scope))).toBeNull();
  });

  it("refuses to write a workspace over the bounds", () => {
    expect(
      writeCodeDraft(scope, {
        ...workspace,
        files: [
          { content: "x".repeat(65 * 1024), language: "python", name: "a.py" },
        ],
      }),
    ).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it("is removed one by one and wiped by the sign-out cleanup", () => {
    writeCodeDraft(scope, workspace);
    writeCodeDraft({ ...scope, mediaSpaceID: "space-2" }, workspace);
    localStorage.setItem("tutorhub:unrelated", "keep");
    removeCodeDraft(scope);
    expect(localStorage.getItem(codeDraftKey(scope))).toBeNull();
    clearCodeDraftStorage();
    expect(
      Object.keys(localStorage).filter((key) =>
        key.startsWith("tutorhub:code-draft:"),
      ),
    ).toEqual([]);
    expect(localStorage.getItem("tutorhub:unrelated")).toBe("keep");
  });
});
