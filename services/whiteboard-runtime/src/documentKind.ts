import type { CollaborationDocumentKind } from "./contracts.js";

/**
 * ROOM-TOOLS-CODE-02A (ADR-0043 §4): one Hocuspocus process serves two typed
 * document kinds. The opaque, server-generated provider document name prefix
 * is bound to exactly one kind, and the control plane must confirm the same
 * kind, so a credential, checkpoint or budget can never cross kinds.
 */
export const WHITEBOARD_DOCUMENT_KIND = "whiteboard.excalidraw.v1" as const;
export const CODE_WORKSPACE_DOCUMENT_KIND = "code.workspace.v1" as const;

/** Hard data-plane ceilings for `code.workspace.v1` (checkpoint ≤ 512 KiB). */
export const CODE_WORKSPACE_MAX_DOCUMENT_BYTES = 512 * 1024;
export const CODE_WORKSPACE_MAX_UPDATE_BYTES = 32 * 1024;

const WHITEBOARD_NAME_PATTERN = /^wb_[A-Za-z0-9_-]{22,125}$/;
const CODE_WORKSPACE_NAME_PATTERN = /^cw_[A-Za-z0-9_-]{22,125}$/;

export function documentKindForName(
  documentName: string,
): CollaborationDocumentKind | null {
  if (WHITEBOARD_NAME_PATTERN.test(documentName)) {
    return WHITEBOARD_DOCUMENT_KIND;
  }
  if (CODE_WORKSPACE_NAME_PATTERN.test(documentName)) {
    return CODE_WORKSPACE_DOCUMENT_KIND;
  }
  return null;
}

/** Legacy payloads without `document_kind` keep the whiteboard contract. */
export function parseDocumentKind(
  value: unknown,
): CollaborationDocumentKind | null {
  if (value === undefined || value === WHITEBOARD_DOCUMENT_KIND) {
    return WHITEBOARD_DOCUMENT_KIND;
  }
  if (value === CODE_WORKSPACE_DOCUMENT_KIND) {
    return CODE_WORKSPACE_DOCUMENT_KIND;
  }
  return null;
}

export function scopeDocumentKind(scope: {
  documentKind?: CollaborationDocumentKind;
}): CollaborationDocumentKind {
  return scope.documentKind ?? WHITEBOARD_DOCUMENT_KIND;
}
