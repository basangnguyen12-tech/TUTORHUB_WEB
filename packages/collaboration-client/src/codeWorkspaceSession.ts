import type { HocuspocusProvider } from "@hocuspocus/provider";
import {
  connectHocuspocusDocument,
  validateGrantTransport,
  type BrowserCollaborationGrant,
  type CollaborationCapability,
  type CollaborationConnectionStatus,
  type CollaborationTerminalReason,
} from "./browserSession.js";
import {
  CanonicalCodeWorkspaceAuthority,
  type CodeWorkspaceFileInput,
} from "./codeWorkspaceAuthority.js";

/** Provider awareness (bounded, sanitized by the runtime); no extra dependency. */
export type CodeWorkspaceAwareness = HocuspocusProvider["awareness"];

/**
 * ROOM-TOOLS-CODE-02A: browser session for the shared `code.workspace.v1`
 * document. The provider document name is derived from the opaque workspace
 * id in the disjoint `cw_` namespace; the server-issued one-time grant binds
 * the same kind, so a whiteboard credential can never open a code workspace.
 */
export interface BrowserCodeCollaborationSession {
  authority: CanonicalCodeWorkspaceAuthority;
  awareness: CodeWorkspaceAwareness;
  capability: CollaborationCapability;
  destroy(): void;
  generation: number;
}

export interface BrowserCodeCollaborationSessionOptions {
  actorId: string;
  grant: BrowserCollaborationGrant;
  /** Seed files used only when an editing client finds an empty workspace. */
  initialFiles?: readonly CodeWorkspaceFileInput[];
  onStatus?: (status: CollaborationConnectionStatus) => void;
  onTerminal?: (reason: CollaborationTerminalReason) => void;
  tenantId: string;
}

export const DEFAULT_CODE_WORKSPACE_FILES: readonly CodeWorkspaceFileInput[] =
  Object.freeze([
    Object.freeze({
      content: 'print("Xin chào TutorHub!")\n',
      language: "python",
      name: "main.py",
    }),
  ]);

export async function createBrowserCodeCollaborationSession({
  actorId,
  grant,
  initialFiles = DEFAULT_CODE_WORKSPACE_FILES,
  onStatus = () => undefined,
  onTerminal = () => undefined,
  tenantId,
}: BrowserCodeCollaborationSessionOptions): Promise<BrowserCodeCollaborationSession> {
  const providerDocumentName = deriveCodeProviderDocumentName(grant.documentId);
  validateGrantTransport(grant);
  const connection = connectHocuspocusDocument({
    grant,
    onStatus,
    onTerminal,
    providerDocumentName,
  });
  const authority = new CanonicalCodeWorkspaceAuthority(
    connection.document,
    {
      documentId: grant.documentId,
      generation: grant.generation,
      tenantId,
    },
    actorId,
    { readOnly: grant.capability === "view" },
  );
  const stopViolation = authority.onViolation(() =>
    onTerminal("recovery_required"),
  );

  try {
    await connection.ready();
    if (!authority.isInitialized() && grant.capability !== "view") {
      authority.initialize(initialFiles);
    }
    await connection.waitUntil(
      () => authority.isInitialized(),
      "collaboration_authority_not_ready",
      grant.capability === "view" ? 10_000 : 8_000,
    );
  } catch (error) {
    onStatus("failed");
    stopViolation();
    authority.destroy();
    connection.destroy();
    throw error;
  }

  return {
    authority,
    awareness: connection.provider.awareness,
    capability: grant.capability,
    destroy: () => {
      stopViolation();
      authority.destroy();
      connection.destroy();
    },
    generation: grant.generation,
  };
}

export function deriveCodeProviderDocumentName(workspaceId: string): string {
  if (!UUID_PATTERN.test(workspaceId)) {
    throw new Error("collaboration_document_id_invalid");
  }
  return `cw_${workspaceId.replaceAll("-", "")}`;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
