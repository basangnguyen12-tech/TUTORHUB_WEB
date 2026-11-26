import { Button } from "@tutorhub/ui";
import { useQueryClient } from "@tanstack/react-query";
import type { PdfPresentation } from "@tutorhub/api-client";
import { Download, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../../app/i18n";
import {
  classifyRoomDocumentError,
  fetchRoomDocumentBytes,
  requestRoomDocumentView,
  RoomDocumentBytesError,
  roomDocumentQueryKeys,
} from "../../app/roomDocuments";
import type { PendingWhiteboardSnippet } from "../collaboration/whiteboardSnippetBridge";
import {
  DocumentViewer,
  type DocumentSource,
  type DocumentViewerPresentation,
} from "./DocumentViewer";
import type {
  ClassroomFilesSession,
  ClassroomFilesViewState,
} from "./filesSession";
import {
  roomDocumentLoadMode,
  RoomDocumentRangeLoader,
} from "./pdfRangeTransport";

/**
 * ROOM-TOOLS-FILES-01B / 02B: asks the server for a short-lived,
 * version-bound view capability, then either fetches the whole file into
 * memory (≤ 30 MiB, SHA-256 checked, session LRU) or — for a 30–50 MiB PDF —
 * hands pdf.js a version-pinned HTTP Range reader. In "Trình chiếu lớp" the
 * capability must name exactly the presented version (`expectedVersionID`),
 * otherwise the document fails closed with the integrity message.
 */
type LoadState =
  | { readonly kind: "capability" }
  | { readonly kind: "downloading"; readonly percent: number }
  | { readonly kind: "ready"; readonly source: DocumentSource }
  | {
      readonly kind: "error";
      readonly reason:
        | "error"
        | "featureOff"
        | "forbidden"
        | "integrity"
        | "network"
        | "tooLarge";
    };

/**
 * ROOM-UI-POLISH-01: right after joining, the server may still see the
 * LiveKit participant session as "connecting" and conceal the document
 * (404 → `forbidden`) for a few hundred ms. The first attempt therefore
 * retries a concealed answer twice on a short backoff before showing it.
 */
const DOCUMENT_VIEW_FORBIDDEN_RETRY_DELAYS_MS: readonly number[] = [700, 1600];

/** Resolves after `ms`, or at once when `signal` aborts (timer cleared). */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = globalThis.setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export interface DocumentLoaderProps {
  readonly actorID: string;
  readonly activePresentation?: PdfPresentation | null;
  readonly canDownloadOriginal: boolean;
  /** "Trình chiếu lớp": the exact presented object version. */
  readonly expectedVersionID?: string;
  readonly headerSlot: HTMLElement | null | undefined;
  readonly libraryOpen: boolean;
  readonly mediaSpaceID: string;
  readonly onDownloadOriginal: () => void;
  readonly onLoaded: (versionID: string) => void;
  readonly onOpenLibrary: () => void;
  readonly onViewChange: (view: ClassroomFilesViewState) => void;
  readonly presentation?: DocumentViewerPresentation | null;
  readonly session: ClassroomFilesSession;
  readonly tenantID: string;
  readonly topBarExtra?: ReactNode;
  readonly view: ClassroomFilesViewState;
  readonly whiteboard: {
    readonly canEdit?: boolean;
    readonly onSend: (snippet: PendingWhiteboardSnippet) => void;
  } | null;
}

export function DocumentLoader({
  actorID,
  activePresentation,
  canDownloadOriginal,
  expectedVersionID,
  headerSlot,
  libraryOpen,
  mediaSpaceID,
  onDownloadOriginal,
  onLoaded,
  onOpenLibrary,
  onViewChange,
  presentation,
  session,
  tenantID,
  topBarExtra,
  view,
  whiteboard,
}: DocumentLoaderProps) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const fileID = view.document.fileID;
  const knownVersion = expectedVersionID ?? view.document.versionID;
  // Cached bytes from earlier in this room session open without a request.
  const [initial] = useState<LoadState>(() => {
    const cached =
      knownVersion === null ? null : session.readBytes(fileID, knownVersion);
    if (!cached && fileID.startsWith("chat:"))
      return { kind: "error", reason: "error" };
    return cached
      ? { kind: "ready", source: { bytes: cached, kind: "bytes" } }
      : { kind: "capability" };
  });
  const [state, setState] = useState<LoadState>(initial);
  const [attempt, setAttempt] = useState(0);
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
  });

  useEffect(() => {
    if (fileID.startsWith("chat:")) return undefined;
    if (attempt === 0 && initial.kind === "ready") return undefined;
    const controller = new AbortController();
    let reader: RoomDocumentRangeLoader | null = null;
    const retryDelays =
      attempt === 0 ? DOCUMENT_VIEW_FORBIDDEN_RETRY_DELAYS_MS : [];
    const requestView = async () => {
      for (let retry = 0; ; retry += 1) {
        try {
          return await requestRoomDocumentView(
            tenantID,
            mediaSpaceID,
            fileID,
            controller.signal,
          );
        } catch (error) {
          const delay = retryDelays[retry];
          if (
            delay === undefined ||
            controller.signal.aborted ||
            classifyRoomDocumentError(error) !== "forbidden"
          ) {
            throw error;
          }
          await pause(delay, controller.signal);
          if (controller.signal.aborted) throw error;
        }
      }
    };
    void (async () => {
      try {
        const capability = await requestView();
        if (controller.signal.aborted) return;
        if (
          expectedVersionID !== undefined &&
          capability.version_id !== expectedVersionID
        ) {
          // The presented version is pinned: never show another one.
          setState({ kind: "error", reason: "integrity" });
          return;
        }
        const mode = roomDocumentLoadMode(capability);
        if (mode === "tooLarge") {
          setState({ kind: "error", reason: "tooLarge" });
          return;
        }
        if (mode === "range") {
          const initialVersionID = capability.version_id;
          reader = new RoomDocumentRangeLoader({
            cache: session.rangeCache(fileID, initialVersionID),
            capability,
            renew: (signal) =>
              requestRoomDocumentView(tenantID, mediaSpaceID, fileID, signal),
          });
          setState({
            kind: "ready",
            source: {
              kind: "range",
              reader,
              versionID: initialVersionID,
              sha256: capability.sha256,
            },
          });
          onLoadedRef.current(initialVersionID);
          return;
        }
        const cached = session.readBytes(fileID, capability.version_id);
        if (cached) {
          setState({ kind: "ready", source: { bytes: cached, kind: "bytes" } });
          onLoadedRef.current(capability.version_id);
          return;
        }
        setState({ kind: "downloading", percent: 0 });
        const bytes = await fetchRoomDocumentBytes(capability, {
          onProgress: (percent) => {
            if (!controller.signal.aborted) {
              setState({ kind: "downloading", percent });
            }
          },
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        session.saveBytes(fileID, capability.version_id, bytes);
        setState({ kind: "ready", source: { bytes, kind: "bytes" } });
        onLoadedRef.current(capability.version_id);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof RoomDocumentBytesError) {
          setState({
            kind: "error",
            reason:
              error.code === "tooLarge"
                ? "tooLarge"
                : error.code === "integrity"
                  ? "integrity"
                  : "network",
          });
          return;
        }
        const kind = classifyRoomDocumentError(error);
        setState({
          kind: "error",
          reason:
            kind === "featureOff"
              ? "featureOff"
              : kind === "forbidden"
                ? "forbidden"
                : "error",
        });
      }
    })();
    return () => {
      // Closing the stage, switching documents or leaving cancels every
      // in-flight request and Range transport.
      controller.abort();
      reader?.abort();
    };
  }, [
    attempt,
    expectedVersionID,
    fileID,
    initial.kind,
    mediaSpaceID,
    session,
    tenantID,
  ]);

  if (state.kind === "ready") {
    return (
      <DocumentViewer
        study={{ actorID, tenantID, mediaSpaceID, activePresentation, session }}
        onRefreshAccess={() =>
          void queryClient.invalidateQueries({
            queryKey: roomDocumentQueryKeys.list(tenantID, mediaSpaceID),
          })
        }
        canDownloadOriginal={canDownloadOriginal}
        headerSlot={headerSlot}
        libraryOpen={libraryOpen}
        onDownloadOriginal={onDownloadOriginal}
        onOpenLibrary={onOpenLibrary}
        onViewChange={onViewChange}
        presentation={presentation}
        source={state.source}
        topBarExtra={topBarExtra}
        view={view}
        whiteboard={whiteboard}
      />
    );
  }
  if (state.kind === "error") {
    const message =
      state.reason === "forbidden"
        ? t("classroomTools.files.viewer.forbidden")
        : state.reason === "featureOff"
          ? t("classroomTools.files.featureOff")
          : state.reason === "tooLarge"
            ? t("classroomTools.files.viewer.tooLarge")
            : state.reason === "integrity"
              ? t("classroomTools.files.viewer.integrity")
              : t("classroomTools.files.viewer.loadError");
    return (
      <div className="classroom-files-state" role="alert">
        <p className="classroom-files-state__title">{message}</p>
        <div className="classroom-files-state__actions">
          {/* A concealed answer may be a join race: Retry stays offered. */}
          {state.reason === "featureOff" ||
          fileID.startsWith("chat:") ? null : (
            <Button
              leadingIcon={<RefreshCw />}
              onClick={() => {
                setState({ kind: "capability" });
                setAttempt((value) => value + 1);
              }}
              size="sm"
              variant="secondary"
            >
              {t("state.retry")}
            </Button>
          )}
          {state.reason === "tooLarge" && canDownloadOriginal ? (
            <Button
              leadingIcon={<Download />}
              onClick={onDownloadOriginal}
              size="sm"
              variant="secondary"
            >
              {t("classroomTools.files.library.download")}
            </Button>
          ) : null}
          <Button onClick={onOpenLibrary} size="sm" variant="quiet">
            {t("classroomTools.files.library.title")}
          </Button>
        </div>
      </div>
    );
  }
  const percent = state.kind === "downloading" ? state.percent : 0;
  return (
    <div className="classroom-files-state" role="status">
      <span aria-hidden="true" className="classroom-code-state__spinner" />
      <p>
        {state.kind === "downloading"
          ? t("classroomTools.files.viewer.downloading", { percent })
          : t("classroomTools.files.viewer.preparing")}
      </p>
      <progress
        aria-label={t("classroomTools.files.viewer.downloadProgress")}
        className="classroom-files-state__progress"
        max={100}
        value={state.kind === "downloading" ? percent : undefined}
      />
    </div>
  );
}
