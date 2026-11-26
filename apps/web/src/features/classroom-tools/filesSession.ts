/**
 * ROOM-TOOLS-FILES-01B (ADR-0045 §3): per-room-session memory for the
 * Documents tool. It lives with the room page (outside the lazy viewer
 * chunk), so switching Whiteboard ↔ Code ↔ Documents keeps the open document,
 * its page and zoom, and the verified bytes without a second download.
 *
 * Bytes are held in RAM only — never in localStorage, sessionStorage,
 * IndexedDB, CacheStorage, a Y.Doc or a log — and are wiped by `clear()`
 * (room unmount, sign-out through `clearPrivateSessionCache()`).
 */
export type ClassroomFilesFitMode = "custom" | "page" | "width";

export interface ClassroomFilesOpenDocument {
  readonly activeContent: boolean;
  readonly displayName: string;
  readonly fileID: string;
  readonly firstPageAspect: number;
  readonly mediaType: string;
  readonly pageCount: number;
  /** The exact object version the bytes belong to (null until loaded). */
  readonly versionID: string | null;
}

export interface ClassroomFilesViewState {
  readonly document: ClassroomFilesOpenDocument;
  readonly fitMode: ClassroomFilesFitMode;
  readonly page: number;
  /** Zoom factor relative to fit-to-width (1 = 100 %). */
  readonly zoom: number;
}

/**
 * ROOM-TOOLS-FILES-02B: RAM-only LRU of HTTP Range chunks for one 30–50 MiB
 * PDF version (≤ 32 MiB), so switching tools does not refetch every range.
 */
export interface ByteRangeCache {
  readonly byteLength: number;
  clear(): void;
  get(begin: number, end: number): Uint8Array | null;
  set(begin: number, end: number, bytes: Uint8Array): void;
}

export const CLASSROOM_FILES_RANGE_CACHE_MAX_BYTES = 32 * 1024 * 1024;

export function createByteRangeCache(
  maxBytes = CLASSROOM_FILES_RANGE_CACHE_MAX_BYTES,
): ByteRangeCache {
  // Insertion order is recency order (LRU).
  const chunks = new Map<string, Uint8Array>();
  let total = 0;
  const key = (begin: number, end: number) => `${begin}-${end}`;
  return {
    get byteLength() {
      return total;
    },
    clear() {
      chunks.clear();
      total = 0;
    },
    get(begin, end) {
      const entryKey = key(begin, end);
      const entry = chunks.get(entryKey);
      if (!entry) return null;
      chunks.delete(entryKey);
      chunks.set(entryKey, entry);
      return entry;
    },
    set(begin, end, bytes) {
      if (bytes.byteLength > maxBytes) return;
      const entryKey = key(begin, end);
      const previous = chunks.get(entryKey);
      if (previous) {
        total -= previous.byteLength;
        chunks.delete(entryKey);
      }
      chunks.set(entryKey, bytes);
      total += bytes.byteLength;
      while (total > maxBytes) {
        const oldest = chunks.keys().next().value;
        if (oldest === undefined) break;
        total -= chunks.get(oldest)?.byteLength ?? 0;
        chunks.delete(oldest);
      }
    },
  };
}

/** Page / zoom of a presentation, kept across tool switches (RAM only). */
export interface ClassroomFilesPresentationView {
  readonly fitMode: ClassroomFilesFitMode;
  readonly page: number;
  readonly presentationID: string;
  readonly zoom: number;
}

export interface ClassroomFilesSession {
  clear(): void;
  readBytes(fileID: string, versionID: string): Uint8Array | null;
  /** The Range chunk cache of one document version (others are dropped). */
  rangeCache(fileID: string, versionID: string): ByteRangeCache;
  readPresentationView(
    presentationID: string,
  ): ClassroomFilesPresentationView | null;
  savePresentationView(view: ClassroomFilesPresentationView): void;
  /** Drops the bytes but keeps the open document / page (stage closed). */
  releaseBytes(): void;
  readView(): ClassroomFilesViewState | null;
  saveBytes(fileID: string, versionID: string, bytes: Uint8Array): void;
  saveView(view: ClassroomFilesViewState | null): void;
  /** Notified after `clear()`, so a mounted viewer drops what it shows. */
  subscribe(listener: () => void): () => void;
}

export const CLASSROOM_FILES_SESSION_MAX_DOCUMENTS = 2;
export const CLASSROOM_FILES_SESSION_MAX_BYTES = 64 * 1024 * 1024;

export function createClassroomFilesSession(): ClassroomFilesSession {
  // Insertion order is recency order (LRU): a read moves the entry last.
  const bytes = new Map<string, Uint8Array>();
  const listeners = new Set<() => void>();
  let view: ClassroomFilesViewState | null = null;
  let range: { cache: ByteRangeCache; key: string } | null = null;
  let presentationView: ClassroomFilesPresentationView | null = null;
  const key = (fileID: string, versionID: string) =>
    `${fileID}\u0000${versionID}`;
  const total = () =>
    [...bytes.values()].reduce((sum, entry) => sum + entry.byteLength, 0);
  return {
    clear() {
      bytes.clear();
      range?.cache.clear();
      range = null;
      presentationView = null;
      view = null;
      for (const listener of [...listeners]) listener();
    },
    readBytes(fileID, versionID) {
      const entryKey = key(fileID, versionID);
      const entry = bytes.get(entryKey);
      if (!entry) return null;
      bytes.delete(entryKey);
      bytes.set(entryKey, entry);
      return entry;
    },
    readView() {
      return view;
    },
    rangeCache(fileID, versionID) {
      const entryKey = key(fileID, versionID);
      if (range?.key === entryKey) return range.cache;
      range?.cache.clear();
      range = { cache: createByteRangeCache(), key: entryKey };
      return range.cache;
    },
    readPresentationView(presentationID) {
      return presentationView?.presentationID === presentationID
        ? presentationView
        : null;
    },
    releaseBytes() {
      bytes.clear();
      range?.cache.clear();
      range = null;
    },
    savePresentationView(next) {
      presentationView = next;
    },
    saveBytes(fileID, versionID, next) {
      if (next.byteLength > CLASSROOM_FILES_SESSION_MAX_BYTES) return;
      const entryKey = key(fileID, versionID);
      bytes.delete(entryKey);
      bytes.set(entryKey, next);
      while (
        bytes.size > CLASSROOM_FILES_SESSION_MAX_DOCUMENTS ||
        total() > CLASSROOM_FILES_SESSION_MAX_BYTES
      ) {
        const oldest = bytes.keys().next().value;
        if (oldest === undefined || oldest === entryKey) break;
        bytes.delete(oldest);
      }
    },
    saveView(next) {
      view = next;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
