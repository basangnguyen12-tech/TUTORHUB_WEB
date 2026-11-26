import { QueryClientContext, type QueryClient } from "@tanstack/react-query";
import type {
  CodeScratchpad,
  CodeScratchpadProjection,
  PutCodeScratchpadRequest,
} from "@tutorhub/api-client";
import { useContext, useMemo, useSyncExternalStore } from "react";
import {
  codeLibraryErrorKind,
  codeLibraryQueryKeys,
  fetchCodeScratchpad,
  saveCodeScratchpad,
  setCodeScratchpadShared,
} from "../../app/codeLibrary";
import { isCodeFileLanguage } from "./codeLanguages";
import type {
  ClassroomCodeSession,
  ClassroomCodeWorkspaceSnapshot,
} from "./codeSession";

/**
 * ROOM-TOOLS-CODE-03B: the durable "Nháp của tôi" (ADR-0043 Slice 3).
 *
 * One controller per room session (it outlives the workspace component, which
 * remounts on Whiteboard ↔ Code and Chung lớp ↔ Nháp của tôi):
 *
 * - On first attach it reads the server draft; a draft the viewer has not
 *   edited in this session yields to the newer server copy.
 * - Every edit marks it dirty; ~1.2 s later one `PUT` (compare-and-swap on
 *   `expected_version`) runs at a time, so a tab never conflicts with itself.
 * - `409 code_scratchpad_version_conflict` stops autosave until the person
 *   chooses "load the server copy" or "overwrite with what I am typing".
 * - Size and quota refusals never touch the text on screen.
 *
 * Nothing here runs code, and the browser never decides who may read a draft.
 */
export const SCRATCHPAD_AUTOSAVE_DELAY_MS = 1_200;

export type ScratchpadSyncStatus =
  "conflict" | "error" | "idle" | "loading" | "saved" | "saving";

export type ScratchpadSyncError =
  "failed" | "storage_quota" | "too_large" | "unavailable";

export type ScratchpadShareError = "conflict" | "empty" | "failed" | "unsaved";

export interface ScratchpadSyncState {
  readonly dirty: boolean;
  readonly error: ScratchpadSyncError | null;
  readonly loaded: boolean;
  readonly shareError: ScratchpadShareError | null;
  readonly shared: boolean;
  readonly sharing: boolean;
  readonly status: ScratchpadSyncStatus;
  readonly version: number;
}

export interface ScratchpadSyncAPI {
  fetch(): Promise<CodeScratchpadProjection>;
  save(input: PutCodeScratchpadRequest): Promise<CodeScratchpad>;
  share(shared: boolean): Promise<CodeScratchpadProjection>;
}

/** The mounted workspace: read what is on screen, replace it wholesale. */
export interface ScratchpadSyncBinding {
  apply(snapshot: ClassroomCodeWorkspaceSnapshot): void;
  read(): ClassroomCodeWorkspaceSnapshot | null;
}

const INITIAL_STATE: ScratchpadSyncState = {
  dirty: false,
  error: null,
  loaded: false,
  shareError: null,
  shared: false,
  sharing: false,
  status: "idle",
  version: 0,
};

/** A server draft as a workspace snapshot (unknown languages dropped). */
export function snapshotFromScratchpad(
  scratchpad: CodeScratchpad,
): ClassroomCodeWorkspaceSnapshot {
  const files = scratchpad.files
    .filter((file) => isCodeFileLanguage(file.language))
    .map((file) => ({
      content: file.content,
      language: file.language,
      name: file.name,
    }));
  const activeIndex =
    scratchpad.active_index >= 0 && scratchpad.active_index < files.length
      ? scratchpad.active_index
      : 0;
  return { activeIndex, files, stdin: scratchpad.stdin };
}

export function scratchpadRequest(
  snapshot: ClassroomCodeWorkspaceSnapshot,
  expectedVersion: number,
): PutCodeScratchpadRequest {
  return {
    active_index: Math.min(
      Math.max(0, snapshot.activeIndex),
      Math.max(0, snapshot.files.length - 1),
    ),
    expected_version: expectedVersion,
    files: snapshot.files.map((file) => ({
      content: file.content,
      language: file.language,
      name: file.name,
    })),
    stdin: snapshot.stdin,
  };
}

function syncErrorFor(error: unknown): ScratchpadSyncError {
  switch (codeLibraryErrorKind(error)) {
    case "too_large":
      return "too_large";
    case "storage_quota":
      return "storage_quota";
    case "feature_off":
    case "forbidden":
    case "not_found":
    case "scope_changed":
      return "unavailable";
    default:
      return "failed";
  }
}

export class CodeScratchpadSync {
  private state: ScratchpadSyncState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private binding: ScratchpadSyncBinding | null = null;
  /** Used when an edit arrives with no workspace mounted (fork, import). */
  private pending: ClassroomCodeWorkspaceSnapshot | null = null;
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private loading: Promise<void> | null = null;
  private again = false;
  private disposed = false;

  constructor(
    private readonly api: ScratchpadSyncAPI,
    private readonly delayMs = SCRATCHPAD_AUTOSAVE_DELAY_MS,
  ) {}

  readonly getState = (): ScratchpadSyncState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<ScratchpadSyncState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Mount a workspace; the returned function detaches (and flushes). */
  attach(binding: ScratchpadSyncBinding): () => void {
    this.binding = binding;
    if (!this.state.loaded) void this.load();
    else if (this.state.dirty && this.state.status !== "conflict") {
      this.schedule();
    }
    return () => {
      if (this.binding !== binding) return;
      this.pending = binding.read() ?? this.pending;
      this.binding = null;
      if (this.state.dirty && this.state.status !== "conflict") {
        this.clearTimer();
        void this.save();
      }
    };
  }

  /** The viewer changed the draft (typing, files, stdin, fork, import). */
  markDirty(snapshot?: ClassroomCodeWorkspaceSnapshot) {
    if (snapshot) this.pending = snapshot;
    if (!this.state.dirty) this.update({ dirty: true });
    if (this.state.status === "conflict") return;
    this.schedule();
  }

  private schedule() {
    this.clearTimer();
    this.timer = globalThis.setTimeout(() => {
      this.timer = null;
      void this.save();
    }, this.delayMs);
  }

  private clearTimer() {
    if (this.timer !== null) globalThis.clearTimeout(this.timer);
    this.timer = null;
  }

  private snapshot(): ClassroomCodeWorkspaceSnapshot | null {
    return this.binding?.read() ?? this.pending;
  }

  /** First read of the server draft (also re-run by `retry`). */
  load(): Promise<void> {
    if (this.loading) return this.loading;
    this.update({ error: null, status: "loading" });
    const run = (async () => {
      try {
        const { scratchpad } = await this.api.fetch();
        if (this.disposed) return;
        const editedHere = this.state.dirty;
        if (scratchpad && !editedHere && !this.binding) {
          // The workspace left before the read finished: read again on the
          // next mount rather than silently skipping the server copy.
          this.update({ status: "idle" });
          return;
        }
        if (scratchpad && !editedHere) {
          const snapshot = snapshotFromScratchpad(scratchpad);
          if (snapshot.files.length > 0) {
            this.pending = snapshot;
            this.binding?.apply(snapshot);
          }
        }
        this.update({
          loaded: true,
          shared: scratchpad?.shared_with_staff ?? false,
          status: scratchpad && !editedHere ? "saved" : "idle",
          version: scratchpad?.version ?? 0,
        });
        if (this.state.dirty) this.schedule();
      } catch (error) {
        if (!this.disposed) {
          this.update({ error: syncErrorFor(error), status: "error" });
        }
      } finally {
        this.loading = null;
      }
    })();
    this.loading = run;
    return run;
  }

  /** Saves now (one request at a time; later edits save after it). */
  save(): Promise<void> {
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    if (this.state.status === "conflict" || this.disposed) {
      return Promise.resolve();
    }
    const run = (async () => {
      if (!this.state.loaded) {
        await this.load();
        if (!this.state.loaded) return;
      }
      // Nothing new since the last save (e.g. a timer after an explicit save).
      if (!this.state.dirty) return;
      const snapshot = this.snapshot();
      if (!snapshot || snapshot.files.length === 0) return;
      this.update({ dirty: false, error: null, status: "saving" });
      try {
        const saved = await this.api.save(
          scratchpadRequest(snapshot, this.state.version),
        );
        this.update({
          shared: saved.shared_with_staff,
          status: this.state.dirty ? "saving" : "saved",
          version: saved.version,
        });
      } catch (error) {
        const conflict = codeLibraryErrorKind(error) === "version_conflict";
        this.update({
          dirty: true,
          error: conflict ? null : syncErrorFor(error),
          status: conflict ? "conflict" : "error",
        });
      }
    })().finally(() => {
      this.inFlight = null;
      const retry = this.again;
      this.again = false;
      if (
        (retry || this.state.dirty) &&
        this.state.status === "saving" &&
        !this.disposed
      ) {
        this.schedule();
      }
    });
    this.inFlight = run;
    return run;
  }

  /** Error bar "Retry": re-read when never loaded, else save again. */
  retry(): Promise<void> {
    if (!this.state.loaded) return this.load();
    this.update({ dirty: true, error: null, status: "idle" });
    return this.save();
  }

  /** Conflict choice 1: replace the screen with the server copy. */
  async reloadFromServer(): Promise<void> {
    this.clearTimer();
    await this.inFlight;
    this.update({ error: null, status: "loading" });
    try {
      const { scratchpad } = await this.api.fetch();
      if (scratchpad) {
        const snapshot = snapshotFromScratchpad(scratchpad);
        if (snapshot.files.length > 0) {
          this.pending = snapshot;
          this.binding?.apply(snapshot);
        }
        this.update({
          dirty: false,
          loaded: true,
          shared: scratchpad.shared_with_staff,
          status: "saved",
          version: scratchpad.version,
        });
        return;
      }
      // The draft expired meanwhile: keep the screen and save it fresh.
      this.update({ loaded: true, shared: false, status: "idle", version: 0 });
      this.markDirty();
    } catch (error) {
      this.update({ error: syncErrorFor(error), status: "conflict" });
    }
  }

  /** Conflict choice 2: take the latest version, then write the screen. */
  async overwriteServer(): Promise<void> {
    this.clearTimer();
    await this.inFlight;
    this.update({ error: null, status: "loading" });
    try {
      const { scratchpad } = await this.api.fetch();
      this.update({
        dirty: true,
        loaded: true,
        shared: scratchpad?.shared_with_staff ?? false,
        status: "idle",
        version: scratchpad?.version ?? 0,
      });
      await this.save();
    } catch (error) {
      this.update({ error: syncErrorFor(error), status: "conflict" });
    }
  }

  /**
   * "Gửi bài cho GV": unsaved work is saved first so the teacher sees what
   * is on screen; turning it off revokes access immediately.
   */
  async setShared(shared: boolean): Promise<boolean> {
    if (this.state.sharing) return false;
    this.update({ shareError: null, sharing: true });
    try {
      if (shared) {
        if (this.state.status === "conflict") {
          this.update({ shareError: "conflict" });
          return false;
        }
        if (this.state.dirty || this.state.version === 0) {
          this.clearTimer();
          if (!this.state.dirty) this.update({ dirty: true });
          await this.save();
          const after = this.getState();
          if (after.dirty || after.version === 0) {
            this.update({
              shareError: after.status === "conflict" ? "conflict" : "unsaved",
            });
            return false;
          }
        }
      }
      const projection = await this.api.share(shared);
      this.update({
        shared: projection.scratchpad?.shared_with_staff ?? false,
        ...(projection.scratchpad
          ? { version: projection.scratchpad.version }
          : {}),
      });
      return true;
    } catch (error) {
      this.update({
        shareError:
          codeLibraryErrorKind(error) === "empty" ? "empty" : "failed",
      });
      return false;
    } finally {
      this.update({ sharing: false });
    }
  }

  dispose() {
    this.disposed = true;
    this.clearTimer();
    this.binding = null;
    this.listeners.clear();
  }
}

const controllers = new WeakMap<
  ClassroomCodeSession,
  Map<string, CodeScratchpadSync>
>();

function scratchpadAPI(
  tenantID: string,
  mediaSpaceID: string,
  queryClient: QueryClient | null,
): ScratchpadSyncAPI {
  const key = codeLibraryQueryKeys.scratchpad(tenantID, mediaSpaceID);
  return {
    fetch: async () => {
      const projection = await fetchCodeScratchpad(tenantID, mediaSpaceID);
      queryClient?.setQueryData(key, projection);
      return projection;
    },
    save: async (input) => {
      const scratchpad = await saveCodeScratchpad(
        tenantID,
        mediaSpaceID,
        input,
      );
      queryClient?.setQueryData<CodeScratchpadProjection>(key, {
        scratchpad,
      });
      return scratchpad;
    },
    share: async (shared) => {
      const projection = await setCodeScratchpadShared(
        tenantID,
        mediaSpaceID,
        shared,
      );
      queryClient?.setQueryData(key, projection);
      return projection;
    },
  };
}

/**
 * The room session's controller for (tenant, space), created on first use.
 * `api` is only for tests; the default calls the Core API.
 */
export function scratchpadSyncFor(
  session: ClassroomCodeSession,
  tenantID: string,
  mediaSpaceID: string,
  options: {
    readonly api?: ScratchpadSyncAPI;
    readonly queryClient?: QueryClient | null;
  } = {},
): CodeScratchpadSync {
  let byScope = controllers.get(session);
  if (!byScope) {
    byScope = new Map();
    controllers.set(session, byScope);
  }
  const scopeKey = `${tenantID}\u0000${mediaSpaceID}`;
  let controller = byScope.get(scopeKey);
  if (!controller) {
    controller = new CodeScratchpadSync(
      options.api ??
        scratchpadAPI(tenantID, mediaSpaceID, options.queryClient ?? null),
    );
    byScope.set(scopeKey, controller);
  }
  return controller;
}

/** The existing controller, if this session already has one. */
export function existingScratchpadSync(
  session: ClassroomCodeSession,
  tenantID: string,
  mediaSpaceID: string,
): CodeScratchpadSync | null {
  return (
    controllers.get(session)?.get(`${tenantID}\u0000${mediaSpaceID}`) ?? null
  );
}

const noSubscribe = () => () => undefined;
const noState = () => null;

export function useCodeScratchpadSync(
  session: ClassroomCodeSession,
  tenantID: string,
  mediaSpaceID: string,
  enabled: boolean,
): {
  readonly state: ScratchpadSyncState | null;
  readonly sync: CodeScratchpadSync | null;
} {
  // Optional: the Slice 1 personal tool also renders without a provider.
  const queryClient = useContext(QueryClientContext) ?? null;
  const sync = useMemo(
    () =>
      enabled && tenantID && mediaSpaceID
        ? scratchpadSyncFor(session, tenantID, mediaSpaceID, { queryClient })
        : null,
    [enabled, mediaSpaceID, queryClient, session, tenantID],
  );
  const state = useSyncExternalStore(
    sync ? sync.subscribe : noSubscribe,
    sync ? sync.getState : noState,
    sync ? sync.getState : noState,
  );
  return { state, sync };
}
