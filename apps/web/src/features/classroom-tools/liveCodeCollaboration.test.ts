// @vitest-environment jsdom

import { EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import {
  CanonicalCodeWorkspaceAuthority,
  type CodeWorkspaceFileInput,
} from "@tutorhub/collaboration-client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  liveEditorExtensions,
  liveInitialFiles,
  type LiveCodeSession,
} from "./liveCodeCollaboration";

const documentId = "5b0c6f0e-3d7a-4c38-9f15-2a7f9a3d1c11";
const scope = { documentId, generation: 1, tenantId: "tenant-0001" };
const teacherActor = "teacher-actor-0001";
const studentActor = "student-actor-0002";

beforeAll(() => {
  // CodeMirror measures text with Range rectangles, which jsdom lacks.
  const rect = () => new DOMRect(0, 0, 0, 0);
  for (const target of [Range.prototype, Element.prototype]) {
    if (!("getClientRects" in target)) {
      Object.defineProperty(target, "getClientRects", {
        configurable: true,
        value: () => [],
      });
    }
    if (!("getBoundingClientRect" in target)) {
      Object.defineProperty(target, "getBoundingClientRect", {
        configurable: true,
        value: rect,
      });
    }
  }
});

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

/** Two in-memory replicas, synced both ways like the Hocuspocus relay. */
function linkedDocs(): [Y.Doc, Y.Doc] {
  const left = new Y.Doc();
  const right = new Y.Doc();
  left.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "remote") Y.applyUpdate(right, update, "remote");
  });
  right.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "remote") Y.applyUpdate(left, update, "remote");
  });
  return [left, right];
}

function session(
  authority: CanonicalCodeWorkspaceAuthority,
  capability: "view" | "edit" | "present",
): LiveCodeSession {
  return {
    authority,
    awareness: null,
    capability,
    destroy: () => authority.destroy(),
    generation: 1,
  } as unknown as LiveCodeSession;
}

function mount(
  live: LiveCodeSession,
  fileId: string,
  onLimit: () => void = () => undefined,
): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: live.authority.text(fileId).toString(),
      extensions: [
        liveEditorExtensions({
          awareness: null,
          fileId,
          onLimit,
          session: live,
        }),
      ],
    }),
  });
  views.push(view);
  return view;
}

function type(view: EditorView, at: number, text: string) {
  view.dispatch({
    changes: { from: at, insert: text },
    userEvent: "input.type",
  });
}

/** Ctrl+Z through the editor's real keymaps (no binding: nothing runs). */
function undo(view: EditorView): boolean {
  return runScopeHandlers(
    view,
    new KeyboardEvent("keydown", { ctrlKey: true, key: "z" }),
    "editor",
  );
}

const DEFAULT_FILES: readonly CodeWorkspaceFileInput[] = [
  { content: 'print("xin chao")\n', language: "python", name: "main.py" },
];

function pair(
  files: readonly CodeWorkspaceFileInput[] = DEFAULT_FILES,
  studentOptions: { readOnly?: boolean } = {},
) {
  const [teacherDoc, studentDoc] = linkedDocs();
  const teacher = new CanonicalCodeWorkspaceAuthority(
    teacherDoc,
    scope,
    teacherActor,
  );
  const [fileId] = teacher.initialize(files);
  const student = new CanonicalCodeWorkspaceAuthority(
    studentDoc,
    scope,
    studentActor,
    studentOptions,
  );
  return { fileId: fileId as string, student, teacher };
}

describe("liveEditorExtensions (y-codemirror.next over code.workspace.v1)", () => {
  it("syncs typing both ways through real Y.Docs", () => {
    const { fileId, student, teacher } = pair();
    const teacherView = mount(session(teacher, "present"), fileId);
    const studentView = mount(session(student, "edit"), fileId);

    type(teacherView, 0, "# bai 1\n");
    expect(studentView.state.doc.toString()).toBe(
      '# bai 1\nprint("xin chao")\n',
    );

    type(studentView, studentView.state.doc.length, "print(2)\n");
    expect(teacherView.state.doc.toString()).toBe(
      '# bai 1\nprint("xin chao")\nprint(2)\n',
    );
    expect(teacher.text(fileId).toString()).toBe(
      student.text(fileId).toString(),
    );
  });

  it("undoes only the actor's own edits (A's Ctrl+Z keeps B's function)", () => {
    const { fileId, student, teacher } = pair();
    const teacherView = mount(session(teacher, "present"), fileId);
    const studentView = mount(session(student, "edit"), fileId);

    type(teacherView, 0, "# teacher note\n");
    type(
      studentView,
      studentView.state.doc.length,
      "def tong(a, b):\n    return a + b\n",
    );

    undo(teacherView);

    const expected = 'print("xin chao")\ndef tong(a, b):\n    return a + b\n';
    expect(teacherView.state.doc.toString()).toBe(expected);
    expect(studentView.state.doc.toString()).toBe(expected);
    // There is no second (CodeMirror) history: the binding owns undo.
    expect(teacher.undoManager(fileId).undoStack.length).toBe(0);
    expect(student.undoManager(fileId).undoStack.length).toBe(1);

    undo(studentView);
    expect(teacherView.state.doc.toString()).toBe('print("xin chao")\n');
  });

  it("refuses a local edit past 64 KB per file but never a synced remote one", () => {
    const { fileId, student, teacher } = pair();
    const onLimit = vi.fn();
    const teacherView = mount(session(teacher, "present"), fileId);
    const studentView = mount(session(student, "edit"), fileId, onLimit);

    type(studentView, 0, "x".repeat(70 * 1024));
    expect(onLimit).toHaveBeenCalledTimes(1);
    expect(studentView.state.doc.toString()).toBe('print("xin chao")\n');
    expect(student.text(fileId).toString()).toBe('print("xin chao")\n');

    // A large but valid remote paste reaches the editor unfiltered.
    type(teacherView, 0, "y".repeat(40 * 1024));
    expect(studentView.state.doc.length).toBe(40 * 1024 + 18);
    expect(onLimit).toHaveBeenCalledTimes(1);
  });

  it("keeps a view grant read-only while remote edits still arrive", () => {
    const {
      fileId,
      student: viewer,
      teacher,
    } = pair(DEFAULT_FILES, {
      readOnly: true,
    });
    const teacherView = mount(session(teacher, "present"), fileId);
    const viewerView = mount(session(viewer, "view"), fileId);

    type(viewerView, 0, "hacked");
    expect(viewerView.state.doc.toString()).toBe('print("xin chao")\n');
    expect(viewer.text(fileId).toString()).toBe('print("xin chao")\n');

    type(teacherView, teacherView.state.doc.length, "print(3)\n");
    expect(viewerView.state.doc.toString()).toBe(
      'print("xin chao")\nprint(3)\n',
    );
    // No undo binding for a viewer: Ctrl+Z changes nothing.
    expect(undo(viewerView)).toBe(false);
    expect(viewerView.state.doc.toString()).toBe(
      'print("xin chao")\nprint(3)\n',
    );
  });
});

describe("liveInitialFiles", () => {
  const fallback = [
    { content: "print(0)\n", language: "python" as const, name: "main.py" },
  ];

  it("seeds an empty shared workspace from a valid personal draft", () => {
    expect(
      liveInitialFiles(
        {
          activeIndex: 0,
          files: [
            { content: "a = 1\n", language: "python", name: "bai1.py" },
            { content: "<p>hi</p>", language: "html", name: "index.html" },
          ],
          stdin: "",
        },
        fallback,
      ),
    ).toEqual([
      { content: "a = 1\n", language: "python", name: "bai1.py" },
      { content: "<p>hi</p>", language: "html", name: "index.html" },
    ]);
  });

  it("falls back to the template for an empty or invalid draft", () => {
    expect(liveInitialFiles(null, fallback)).toBe(fallback);
    expect(
      liveInitialFiles(
        {
          activeIndex: 0,
          files: [{ content: "x", language: "python", name: "..." }],
          stdin: "",
        },
        fallback,
      ),
    ).toBe(fallback);
  });
});
