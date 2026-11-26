import {
  APIRequestError,
  getRoomStudyNote,
  putRoomStudyNote,
  rotateCSRFToken,
  type RoomStudyNote,
  type StudyNoteEntry,
} from "@tutorhub/api-client";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { getApiBaseUrl } from "./classFiles";
import { registerPrivateSessionMemoryCleanup } from "./session";
import type { ClassroomFilesSession } from "../features/classroom-tools/filesSession";

type NoteStatus =
  "loading" | "saving" | "saved" | "conflict" | "error" | "limit" | "tooLarge";
interface NoteSnapshot {
  readonly entries: readonly StudyNoteEntry[];
  readonly status: NoteStatus;
  readonly ready: boolean;
}
const initial: NoteSnapshot = { entries: [], ready: false, status: "loading" };
const byteEncoder = new TextEncoder();

/** A document's CAS version covers all pages. Only locally edited pages are
 * reapplied after a conflict, leaving other writers' pages intact. */
function createEditor(
  tenantID: string,
  mediaSpaceID: string,
  fileID: string | null,
) {
  let snapshot = initial;
  let version = 0;
  let controller = new AbortController();
  let started = false;
  let pending = false;
  let conflict = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const edits = new Map<number, string>();
  const listeners = new Set<() => void>();

  function publish(update: Partial<NoteSnapshot>) {
    snapshot = { ...snapshot, ...update };
    for (const notify of listeners) notify();
  }
  function withEdits(base: readonly StudyNoteEntry[]) {
    const byPage = new Map(base.map(({ page, text }) => [page, text]));
    for (const [page, text] of edits) byPage.set(page, text);
    return Array.from(byPage, ([page, text]) => ({ page, text }))
      .filter(({ text }) => text.length > 0)
      .sort((a, b) => a.page - b.page);
  }
  async function load(afterConflict = false) {
    if (!fileID) return;
    const signal = controller.signal;
    if (!afterConflict) publish({ status: "loading" });
    try {
      const record = await getRoomStudyNote(tenantID, mediaSpaceID, fileID, {
        baseUrl: getApiBaseUrl(),
        signal,
      });
      if (signal.aborted) return;
      version = record.version;
      publish({
        entries: withEdits(record.entries),
        ready: true,
        status: afterConflict ? "conflict" : "saved",
      });
    } catch {
      if (!signal.aborted) publish({ ready: false, status: "error" });
    }
  }
  async function flush() {
    clearTimeout(timer);
    if (
      !fileID ||
      !snapshot.ready ||
      !edits.size ||
      pending ||
      conflict ||
      controller.signal.aborted
    )
      return;
    const entries = snapshot.entries
      .map(({ page, text }) => ({ page, text: text.trimEnd() }))
      .filter((entry) => entry.text.length > 0);
    const sizes = entries.map((entry) => byteEncoder.encode(entry.text).length);
    if (
      sizes.some((size) => size > 4096) ||
      sizes.reduce((sum, size) => sum + size, 0) > 65536
    ) {
      publish({ status: "tooLarge" });
      return;
    }
    const sent = new Map(edits);
    const options = { baseUrl: getApiBaseUrl(), signal: controller.signal };
    pending = true;
    publish({ status: "saving" });
    let result: RoomStudyNote | undefined;
    try {
      const csrf = await rotateCSRFToken(options);
      result = await putRoomStudyNote(
        tenantID,
        mediaSpaceID,
        fileID,
        { entries, expected_version: version },
        csrf.csrf_token,
        options,
      );
    } catch (error) {
      if (options.signal.aborted) return;
      if (
        error instanceof APIRequestError &&
        error.status === 409 &&
        error.problem?.code === "room_document_version_conflict"
      ) {
        conflict = true;
        await load(true);
      } else {
        const limit =
          error instanceof APIRequestError &&
          error.status === 409 &&
          error.problem?.code === "room_document_note_limit_exceeded";
        publish({ status: limit ? "limit" : "error" });
      }
    } finally {
      if (!options.signal.aborted) pending = false;
    }
    if (!result || options.signal.aborted) return;
    version = result.version;
    for (const [page, text] of sent) {
      if (edits.get(page) === text) edits.delete(page);
    }
    // Keep the text under the caret, including a space typed before a pause.
    publish({ status: edits.size ? "saving" : "saved" });
    if (edits.size) void flush();
  }
  function edit(page: number, text: string) {
    if (!snapshot.ready || controller.signal.aborted) return;
    edits.set(page, Array.from(text).slice(0, 2000).join(""));
    publish({
      entries: withEdits(snapshot.entries),
      status: conflict ? "conflict" : "saving",
    });
    clearTimeout(timer);
    if (!conflict) timer = setTimeout(() => void flush(), 800);
  }
  function clear() {
    controller.abort();
    clearTimeout(timer);
    edits.clear();
    conflict = false;
    pending = false;
    started = false;
    version = 0;
    publish(initial);
  }
  return {
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    getSnapshot: () => snapshot,
    start() {
      if (started) return;
      started = true;
      controller = new AbortController();
      void load();
    },
    edit,
    flush,
    clear,
    retry() {
      if (!snapshot.ready) {
        void load(conflict);
        return;
      }
      conflict = false;
      void flush();
    },
  };
}

type Editor = ReturnType<typeof createEditor>;
const roomEditors = new WeakMap<ClassroomFilesSession, Map<string, Editor>>();

function editorFor(
  session: ClassroomFilesSession | undefined,
  tenantID: string,
  spaceID: string,
  fileID: string | null,
  actorID: string,
) {
  if (!session || !fileID || !actorID)
    return createEditor(tenantID, spaceID, actorID ? fileID : null);
  let editors = roomEditors.get(session);
  if (!editors) {
    editors = new Map();
    roomEditors.set(session, editors);
  }
  const key = JSON.stringify([tenantID, spaceID, fileID, actorID]);
  let editor = editors.get(key);
  if (!editor) {
    editor = createEditor(tenantID, spaceID, fileID);
    editors.set(key, editor);
  }
  return editor;
}

const observedRooms = new WeakSet<ClassroomFilesSession>();
function observeRoomWipe(session: ClassroomFilesSession) {
  if (observedRooms.has(session)) return;
  observedRooms.add(session);
  const unsubscribe = session.subscribe(() => {
    for (const editor of roomEditors.get(session)?.values() ?? [])
      editor.clear();
    roomEditors.delete(session);
    observedRooms.delete(session);
    unsubscribe();
  });
}

export function useRoomStudyNotes(
  tenantID: string,
  mediaSpaceID: string,
  fileID: string | null,
  actorID: string,
  session?: ClassroomFilesSession,
) {
  const editor = useMemo(
    () => editorFor(session, tenantID, mediaSpaceID, fileID, actorID),
    [tenantID, mediaSpaceID, fileID, actorID, session],
  );
  useEffect(() => {
    editor.start();
    if (session) observeRoomWipe(session);
    const unregister = session
      ? undefined
      : registerPrivateSessionMemoryCleanup(editor.clear);
    return () => {
      // Switching tools or documents keeps a conflicting draft, and lets an
      // in-flight save finish. The room owner wipes all editors on sign-out.
      void editor.flush();
      unregister?.();
    };
  }, [editor, session]);
  const snapshot = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  return {
    ...snapshot,
    edit: editor.edit,
    flush: editor.flush,
    retry: editor.retry,
  };
}

export type RoomStudyNotes = ReturnType<typeof useRoomStudyNotes>;
