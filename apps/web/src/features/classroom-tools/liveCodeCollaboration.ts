import { EditorState, Prec, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import type { WhiteboardGrantCredential } from "@tutorhub/api-client";
import {
  CODE_WORKSPACE_LIMITS,
  DEFAULT_CODE_WORKSPACE_FILES,
  createBrowserCodeCollaborationSession,
  isCodeWorkspaceLanguage,
  isValidCodeWorkspaceFileName,
  utf8ByteLength,
  type BrowserCodeCollaborationSession,
  type CodeWorkspaceFileInput,
  type CollaborationConnectionStatus,
  type CollaborationTerminalReason,
} from "@tutorhub/collaboration-client";
import {
  yCollab,
  ySyncAnnotation,
  yUndoManagerKeymap,
} from "y-codemirror.next";
import type { ClassroomCodeWorkspaceSnapshot } from "./codeSession";
import type { CodeAwarenessLike } from "./codePresence";

/**
 * ROOM-TOOLS-CODE-02B (ADR-0043 Slice 2): everything that needs Yjs. This
 * module is only reached through `import()` once collaboration is enabled and
 * the viewer opens "Chung lớp" on an open workspace, so the personal Code
 * workspace chunk (`LazyCodeWorkspace-*`) does not grow.
 */
export type LiveCodeSession = BrowserCodeCollaborationSession;

export interface OpenLiveCodeSessionOptions {
  readonly actorID: string;
  readonly grant: WhiteboardGrantCredential;
  readonly initialFiles: readonly CodeWorkspaceFileInput[];
  readonly onStatus: (status: CollaborationConnectionStatus) => void;
  readonly onTerminal: (reason: CollaborationTerminalReason) => void;
  readonly tenantID: string;
}

export function openLiveCodeSession({
  actorID,
  grant,
  initialFiles,
  onStatus,
  onTerminal,
  tenantID,
}: OpenLiveCodeSessionOptions): Promise<LiveCodeSession> {
  return createBrowserCodeCollaborationSession({
    actorId: actorID,
    grant: {
      capability: grant.capability,
      credential: grant.credential,
      documentId: grant.document_id,
      expiresAt: grant.expires_at,
      generation: grant.generation,
      providerUrl: grant.provider_url,
      revokeGeneration: grant.revoke_generation,
    },
    initialFiles,
    onStatus,
    onTerminal,
    tenantId: tenantID,
  });
}

/**
 * Seed files for an empty shared workspace: the viewer's personal draft when
 * every file is valid for `code.workspace.v1`, else the given default.
 */
export function liveInitialFiles(
  snapshot: ClassroomCodeWorkspaceSnapshot | null,
  fallback: readonly CodeWorkspaceFileInput[] = DEFAULT_CODE_WORKSPACE_FILES,
): readonly CodeWorkspaceFileInput[] {
  if (!snapshot || snapshot.files.length === 0) return fallback;
  if (snapshot.files.length > CODE_WORKSPACE_LIMITS.maxFiles) return fallback;
  const names = new Set<string>();
  let total = 0;
  for (const file of snapshot.files) {
    const bytes = utf8ByteLength(file.content);
    const folded = file.name.toLowerCase();
    if (
      !isValidCodeWorkspaceFileName(file.name) ||
      !isCodeWorkspaceLanguage(file.language) ||
      bytes > CODE_WORKSPACE_LIMITS.maxFileBytes ||
      names.has(folded)
    ) {
      return fallback;
    }
    names.add(folded);
    total += bytes;
  }
  if (total > CODE_WORKSPACE_LIMITS.maxTotalBytes) return fallback;
  return snapshot.files.map((file) => ({
    content: file.content,
    language: file.language,
    name: file.name,
  }));
}

const encoder = new TextEncoder();

export interface LiveEditorExtensionOptions {
  /** Sanitized cursor awareness; `null` draws no remote cursors. */
  readonly awareness: CodeAwarenessLike | null;
  readonly fileId: string;
  /** A local edit was refused because it would pass a workspace cap. */
  readonly onLimit: () => void;
  readonly session: LiveCodeSession;
}

/**
 * CodeMirror binding for one shared file: `yCollab` with the authority's
 * actor-local `Y.UndoManager` (no CodeMirror `history()`) and its keymap;
 * the workspace adds the read-only facet for `view` (focus, selection, copy
 * and search stay). A change filter refuses *local* edits that would pass 64 KB per
 * file / 256 KB per workspace; synced remote transactions always pass so the
 * editor never diverges from the CRDT.
 */
export function liveEditorExtensions({
  awareness,
  fileId,
  onLimit,
  session,
}: LiveEditorExtensionOptions): Extension {
  const { authority } = session;
  const readOnly = session.capability === "view";
  const changeFilter = EditorState.changeFilter.of((transaction) => {
    if (!transaction.docChanged) return true;
    if (transaction.annotation(ySyncAnnotation) !== undefined) return true;
    if (readOnly) return false;
    let removed = 0;
    let inserted = 0;
    transaction.changes.iterChanges((fromA, toA, _fromB, _toB, text) => {
      if (toA > fromA) {
        removed += encoder.encode(
          transaction.startState.sliceDoc(fromA, toA),
        ).byteLength;
      }
      if (text.length > 0) {
        inserted += encoder.encode(text.toString()).byteLength;
      }
    });
    // Shrinking is always safe; growing must keep every cap.
    if (inserted <= removed) return true;
    if (authority.allowsTextChange(fileId, removed, inserted)) return true;
    onLimit();
    return false;
  });
  return [
    yCollab(authority.text(fileId), awareness, {
      undoManager: readOnly ? false : authority.undoManager(fileId),
    }),
    readOnly ? [] : Prec.high(keymap.of(yUndoManagerKeymap)),
    changeFilter,
  ];
}
