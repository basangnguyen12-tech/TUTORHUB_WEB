import type { CodeFileLanguage } from "./codeLanguages";

/** A code block handed to the Code tool ("Open in Code" from chat). */
export interface ClassroomCodeIncomingFile {
  readonly code: string;
  readonly language: CodeFileLanguage | null;
}

/** The workspace files as plain data (also the draft payload). */
export interface ClassroomCodeWorkspaceFile {
  readonly content: string;
  readonly language: CodeFileLanguage;
  readonly name: string;
}

export interface ClassroomCodeWorkspaceSnapshot {
  readonly activeIndex: number;
  readonly files: readonly ClassroomCodeWorkspaceFile[];
  readonly stdin: string;
}

/**
 * ROOM-TOOLS-CODE-01: per-room-session memory for the Code tool. It lives with
 * the room page (outside the lazy chunk), so switching Whiteboard ↔ Code keeps
 * the open files in memory even when the bounded local draft cannot be
 * written, and chat can queue an "Open in Code" block before the workspace
 * chunk has loaded. Nothing here ever runs code.
 */
export interface ClassroomCodeSession {
  /** Queues a block; the mounted (or next mounted) workspace adds a tab. */
  push(file: ClassroomCodeIncomingFile): void;
  /** Takes every queued block (oldest first). */
  drain(): ClassroomCodeIncomingFile[];
  subscribe(listener: () => void): () => void;
  /** The last workspace state, kept while the tool is off the stage. */
  readSnapshot(): ClassroomCodeWorkspaceSnapshot | null;
  saveSnapshot(snapshot: ClassroomCodeWorkspaceSnapshot): void;
}

export const CLASSROOM_CODE_INBOX_LIMIT = 8;

export function createClassroomCodeSession(): ClassroomCodeSession {
  const queue: ClassroomCodeIncomingFile[] = [];
  const listeners = new Set<() => void>();
  let snapshot: ClassroomCodeWorkspaceSnapshot | null = null;
  return {
    drain() {
      return queue.splice(0, queue.length);
    },
    push(file) {
      queue.push(file);
      if (queue.length > CLASSROOM_CODE_INBOX_LIMIT) queue.shift();
      for (const listener of listeners) listener();
    },
    readSnapshot() {
      return snapshot;
    },
    saveSnapshot(next) {
      snapshot = next;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
