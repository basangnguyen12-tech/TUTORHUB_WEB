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
  CanonicalPdfAnnotationAuthority,
  type PdfAnnotationBinding,
} from "./pdfAnnotationAuthority.js";

/** Provider awareness (bounded, sanitized and capability-stamped by the runtime). */
export type PdfAnnotationAwareness = HocuspocusProvider["awareness"];

/**
 * ROOM-TOOLS-FILES-02A: browser session for the `pdf.annotations.v1` document
 * of one classroom PDF presentation. The provider document name is derived
 * from the opaque presentation id in the disjoint `pd_` namespace; the
 * server-issued one-time grant binds the same kind, so a whiteboard or code
 * credential can never open an annotation layer (and vice versa).
 */
export interface BrowserPdfAnnotationSession {
  authority: CanonicalPdfAnnotationAuthority;
  awareness: PdfAnnotationAwareness;
  capability: CollaborationCapability;
  destroy(): void;
  generation: number;
}

export interface BrowserPdfAnnotationSessionOptions {
  actorId: string;
  /** Exact presented document (from the server projection). */
  binding: PdfAnnotationBinding;
  grant: BrowserCollaborationGrant;
  onStatus?: (status: CollaborationConnectionStatus) => void;
  onTerminal?: (reason: CollaborationTerminalReason) => void;
  tenantId: string;
}

export async function createBrowserPdfAnnotationSession({
  actorId,
  binding,
  grant,
  onStatus = () => undefined,
  onTerminal = () => undefined,
  tenantId,
}: BrowserPdfAnnotationSessionOptions): Promise<BrowserPdfAnnotationSession> {
  const providerDocumentName = derivePdfProviderDocumentName(grant.documentId);
  validateGrantTransport(grant);
  const connection = connectHocuspocusDocument({
    grant,
    onStatus,
    onTerminal,
    providerDocumentName,
  });
  const authority = new CanonicalPdfAnnotationAuthority(
    connection.document,
    {
      documentId: grant.documentId,
      generation: grant.generation,
      tenantId,
    },
    actorId,
    { capability: grant.capability },
  );
  const stopViolation = authority.onViolation(() =>
    onTerminal("recovery_required"),
  );

  try {
    await connection.ready();
    // Only the presenter bootstraps the layer, after syncing, so concurrent
    // annotators never race to create page maps.
    if (!authority.isInitialized() && grant.capability === "present") {
      authority.initialize(binding);
    }
    await connection.waitUntil(
      () => authority.isInitialized(),
      "collaboration_authority_not_ready",
      grant.capability === "present" ? 8_000 : 10_000,
    );
    authority.assertBinding(binding);
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

export function derivePdfProviderDocumentName(presentationId: string): string {
  if (!UUID_PATTERN.test(presentationId)) {
    throw new Error("collaboration_document_id_invalid");
  }
  return `pd_${presentationId.replaceAll("-", "")}`;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
