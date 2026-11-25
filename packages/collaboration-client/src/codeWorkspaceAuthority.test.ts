import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  CanonicalCodeWorkspaceAuthority,
  CODE_WORKSPACE_LIMITS,
  CodeWorkspaceAuthorityError,
  textChunks,
  type CodeWorkspaceErrorCode,
} from "./codeWorkspaceAuthority";
import { deriveCodeProviderDocumentName } from "./codeWorkspaceSession";
import { deriveProviderDocumentName } from "./browserSession";

const WORKSPACE_ID = "8c40ee79-5d4a-4d53-8845-6d295958dd42";
const SCOPE = { documentId: WORKSPACE_ID, generation: 1, tenantId: "tenant-a" };

function newAuthority(
  document = new Y.Doc(),
  actorId = "teacher-actor-0001",
  readOnly = false,
): CanonicalCodeWorkspaceAuthority {
  let counter = 0;
  return new CanonicalCodeWorkspaceAuthority(document, SCOPE, actorId, {
    newFileId: () =>
      `file${actorId.slice(0, 4)}${String(++counter).padStart(6, "0")}`,
    readOnly,
  });
}

function sync(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(
    to,
    Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)),
    "remote",
  );
}

function expectCode(action: () => unknown, code: CodeWorkspaceErrorCode): void {
  expect(action).toThrowError(
    expect.objectContaining({ code }) as unknown as CodeWorkspaceAuthorityError,
  );
}

describe("CanonicalCodeWorkspaceAuthority (code.workspace.v1)", () => {
  it("derives a disjoint cw_ provider name from the opaque workspace id", () => {
    expect(deriveCodeProviderDocumentName(WORKSPACE_ID)).toBe(
      "cw_8c40ee795d4a4d5388456d295958dd42",
    );
    expect(deriveCodeProviderDocumentName(WORKSPACE_ID)).not.toBe(
      deriveProviderDocumentName(WORKSPACE_ID),
    );
    expect(() => deriveCodeProviderDocumentName("not-a-uuid")).toThrow(
      "collaboration_document_id_invalid",
    );
  });

  it("initializes the canonical meta/files shape and exports a clean fork snapshot", () => {
    const document = new Y.Doc();
    const authority = newAuthority(document);
    const [mainId, helperId] = authority.initialize(
      [
        { content: "print(1)\n", language: "python", name: "main.py" },
        { content: "SELECT 1;", language: "sql", name: "query.sql" },
      ],
      1,
    );
    expect(document.getMap("meta").get("schemaVersion")).toBe(1);
    expect(authority.activeFileId()).toBe(helperId);
    const entry = document
      .getMap<Y.Map<unknown>>("files")
      .get(mainId as string);
    expect(entry?.get("text")).toBeInstanceOf(Y.Text);
    expect(authority.snapshot()).toEqual({
      activeIndex: 1,
      files: [
        { content: "print(1)\n", language: "python", name: "main.py" },
        { content: "SELECT 1;", language: "sql", name: "query.sql" },
      ],
      stdin: "",
    });
    expectCode(() => authority.initialize([]), "authority_already_initialized");
  });

  it("enforces file count, names, languages and byte caps before writing", () => {
    const authority = newAuthority();
    authority.initialize([
      { content: "", language: "python", name: "main.py" },
    ]);
    expectCode(
      () =>
        authority.addFile({ content: "", language: "python", name: "MAIN.py" }),
      "file_duplicate_name",
    );
    expectCode(
      () =>
        authority.addFile({ content: "", language: "python", name: "../x.py" }),
      "file_name_invalid",
    );
    expectCode(
      () =>
        authority.addFile({
          content: "",
          language: "ruby" as unknown as "python",
          name: "x.rb",
        }),
      "file_language_unsupported",
    );
    expectCode(
      () =>
        authority.addFile({
          content: "é".repeat(CODE_WORKSPACE_LIMITS.maxFileBytes / 2 + 1),
          language: "python",
          name: "big.py",
        }),
      "file_too_large",
    );
    for (let index = 1; index < CODE_WORKSPACE_LIMITS.maxFiles; index += 1) {
      authority.addFile({
        content: "",
        language: "javascript",
        name: `f${index}.js`,
      });
    }
    expectCode(
      () =>
        authority.addFile({ content: "", language: "css", name: "style.css" }),
      "file_limit",
    );
    const [first] = authority.listFiles();
    authority.renameFile(first?.id as string, "app.py");
    expect(authority.snapshot().files[0]?.name).toBe("app.py");
  });

  it("rolls back a local editor insert that exceeds the per-file cap", () => {
    const authority = newAuthority();
    const [fileId] = authority.initialize([
      { content: "ok", language: "python", name: "main.py" },
    ]);
    const text = authority.text(fileId as string);
    const editorOrigin = { binding: "codemirror" };
    text.doc?.transact(
      () => text.insert(2, "x".repeat(CODE_WORKSPACE_LIMITS.maxFileBytes)),
      editorOrigin,
    );
    expect(text.toString()).toBe("ok");
    expect(authority.violation()).toBeNull();
    expect(authority.allowsTextChange(fileId as string, 0, 10)).toBe(true);
    expect(
      authority.allowsTextChange(
        fileId as string,
        0,
        CODE_WORKSPACE_LIMITS.maxFileBytes,
      ),
    ).toBe(false);
  });

  it("rejects remote over-cap files and text for editors; read-only clients only report", () => {
    const teacherDoc = new Y.Doc();
    const teacher = newAuthority(teacherDoc);
    const [fileId] = teacher.initialize([
      { content: "a", language: "python", name: "main.py" },
    ]);
    const attackerDoc = new Y.Doc();
    const studentDoc = new Y.Doc();
    sync(teacherDoc, attackerDoc);
    sync(teacherDoc, studentDoc);
    const student = newAuthority(studentDoc, "student-viewer-01", true);
    const violations: CodeWorkspaceErrorCode[] = [];
    student.onViolation((code) => violations.push(code));

    // A modified peer bypasses the authority and writes raw Yjs.
    const raw = attackerDoc.getMap<Y.Map<unknown>>("files");
    attackerDoc.transact(() => {
      (raw.get(fileId as string)?.get("text") as Y.Text).insert(
        1,
        "z".repeat(CODE_WORKSPACE_LIMITS.maxFileBytes + 10),
      );
    });
    sync(attackerDoc, teacherDoc);
    expect(teacher.text(fileId as string).toString()).toBe("a");

    sync(attackerDoc, studentDoc);
    expect(student.violation()).toBe("file_too_large");
    expect(violations).toEqual(["file_too_large"]);
    expectCode(() => student.snapshot(), "file_too_large");
    expectCode(
      () => student.setActiveFile(fileId as string),
      "authority_read_only",
    );

    // The editor's rollback converges the read-only replica back to valid.
    sync(teacherDoc, studentDoc);
    expect(student.violation()).toBeNull();
    expect(student.snapshot().files[0]?.content).toBe("a");
  });

  it("removes remotely added files beyond the eight-file cap or with invalid names", () => {
    const teacherDoc = new Y.Doc();
    const teacher = newAuthority(teacherDoc);
    teacher.initialize([{ content: "", language: "python", name: "main.py" }]);
    const attackerDoc = new Y.Doc();
    sync(teacherDoc, attackerDoc);
    const raw = attackerDoc.getMap<Y.Map<unknown>>("files");
    attackerDoc.transact(() => {
      for (let index = 0; index < 9; index += 1) {
        const entry = new Y.Map<unknown>();
        const id = `attack${String(index).padStart(6, "0")}`;
        entry.set("id", id);
        entry.set("name", index === 0 ? "bad name.py" : `x${index}.py`);
        entry.set("language", "python");
        entry.set("order", 10 + index);
        entry.set("text", new Y.Text());
        raw.set(id, entry);
      }
    });
    sync(attackerDoc, teacherDoc);
    const files = teacher.listFiles();
    expect(files).toHaveLength(CODE_WORKSPACE_LIMITS.maxFiles);
    expect(files.some((file) => file.name === "bad name.py")).toBe(false);
    expect(teacher.violation()).toBeNull();
  });

  it("tracks undo per actor so a peer's edits are never undone", () => {
    const teacherDoc = new Y.Doc();
    const teacher = newAuthority(teacherDoc);
    const [fileId] = teacher.initialize([
      { content: "", language: "python", name: "main.py" },
    ]);
    const studentDoc = new Y.Doc();
    sync(teacherDoc, studentDoc);
    const student = newAuthority(studentDoc, "student-editor-01");

    const undo = teacher.undoManager(fileId as string);
    const binding = { binding: "teacher-editor" };
    undo.addTrackedOrigin(binding);
    teacherDoc.transact(
      () => teacher.text(fileId as string).insert(0, "T"),
      binding,
    );
    undo.stopCapturing();
    studentDoc.transact(() => student.text(fileId as string).insert(0, "S"), {
      binding: "student-editor",
    });
    sync(studentDoc, teacherDoc);
    expect(teacher.text(fileId as string).toString()).toContain("S");
    undo.undo();
    expect(teacher.text(fileId as string).toString()).toBe("S");
  });

  it("keeps every provider update under the 32 KiB runtime budget for large files", () => {
    const document = new Y.Doc();
    const sizes: number[] = [];
    document.on("update", (update: Uint8Array) =>
      sizes.push(update.byteLength),
    );
    const authority = newAuthority(document);
    const large = "ă".repeat(30_000);
    const [fileId] = authority.initialize([
      { content: large, language: "python", name: "main.py" },
      { content: "é".repeat(30_000), language: "sql", name: "db.sql" },
    ]);
    authority.replaceFileText(fileId as string, "ô".repeat(31_000));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(32 * 1024);
    expect(authority.text(fileId as string).toString()).toBe(
      "ô".repeat(31_000),
    );

    const emoji = "😀".repeat(5_000);
    const chunks = textChunks(emoji);
    expect(chunks.join("")).toBe(emoji);
    for (const chunk of chunks) {
      const last = chunk.charCodeAt(chunk.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  it("keeps the last file and validates its scope", () => {
    const authority = newAuthority();
    const [fileId] = authority.initialize([
      { content: "", language: "python", name: "main.py" },
    ]);
    expectCode(() => authority.deleteFile(fileId as string), "file_last");
    expect(
      () =>
        new CanonicalCodeWorkspaceAuthority(
          new Y.Doc(),
          { ...SCOPE, documentId: "nope" },
          "teacher-actor-0001",
        ),
    ).toThrow("authority_scope_invalid");
  });
});
