import type { PdfPresentation } from "@tutorhub/api-client";
import type { PdfStroke } from "@tutorhub/collaboration-client";
import { requestPdfPresentationGrant } from "../../app/pdfPresentations";
import {
  authorizeRoomStudyExport,
  fetchRoomDocumentBytes,
  requestRoomDocumentView,
  RoomDocumentBytesError,
} from "../../app/roomDocuments";
import type { DocumentSource } from "./DocumentViewer";
import type {
  ClassroomFilesOpenDocument,
  ClassroomFilesSession,
} from "./filesSession";
import type { PdfInkStore } from "./livePdfCollaboration";

export interface DocumentStudyScope {
  readonly session: ClassroomFilesSession;
  readonly actorID: string;
  readonly tenantID: string;
  readonly mediaSpaceID: string;
  readonly activePresentation?: PdfPresentation | null;
}

export async function readClassInk(
  scope: DocumentStudyScope,
  doc: ClassroomFilesOpenDocument,
  ink: PdfInkStore | undefined,
  signal: AbortSignal,
): Promise<readonly PdfStroke[]> {
  const presentation = scope.activePresentation;
  if (
    !presentation ||
    presentation.status !== "open" ||
    !presentation.document ||
    presentation.file_id !== doc.fileID ||
    presentation.version_id !== doc.versionID ||
    !presentation.viewer_capabilities.can_exchange_grant
  )
    return [];
  const collect = (store: PdfInkStore) => {
    const hidden = new Set(
      presentation.viewer_capabilities.capability === "present"
        ? []
        : store.meta().hiddenPages,
    );
    return Array.from({ length: presentation.page_count }, (_, i) => i + 1)
      .filter((page) => !hidden.has(page))
      .flatMap((page) => store.strokes(page));
  };
  if (ink) return collect(ink);
  const grant = await requestPdfPresentationGrant(
    scope.tenantID,
    presentation,
    "view",
    signal,
  );
  const { openLivePdfSession } = await import("./livePdfCollaboration");
  signal.throwIfAborted();
  const session = await openLivePdfSession({
    actorID: scope.actorID,
    binding: {
      fileId: doc.fileID,
      versionId: presentation.version_id,
      pageCount: presentation.page_count,
    },
    tenantID: scope.tenantID,
    grant,
    onStatus: () => undefined,
    onTerminal: () => undefined,
  });
  try {
    signal.throwIfAborted();
    return collect(session.ink);
  } finally {
    session.destroy();
  }
}

export async function getStudyExportBytes(
  scope: DocumentStudyScope,
  doc: ClassroomFilesOpenDocument,
  source: DocumentSource,
  signal: AbortSignal,
  onProgress: (percent: number) => void,
) {
  await authorizeRoomStudyExport(scope.tenantID, doc.fileID, signal);
  if (source.kind === "bytes") return source.bytes;
  const capability = await requestRoomDocumentView(
    scope.tenantID,
    scope.mediaSpaceID,
    doc.fileID,
    signal,
  );
  if (
    capability.version_id !== doc.versionID ||
    capability.version_id !== source.versionID ||
    capability.sha256.toLowerCase() !== source.sha256.toLowerCase() ||
    capability.content_length_bytes !== source.reader.length
  )
    throw new RoomDocumentBytesError("integrity");
  return fetchRoomDocumentBytes(capability, {
    forStudyExport: true,
    onProgress,
    signal,
  });
}
