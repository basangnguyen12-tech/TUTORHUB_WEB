import type { RoomDocument } from "@tutorhub/api-client";
import { Button } from "@tutorhub/ui";
import { AlertTriangle, Download, RefreshCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useI18n } from "../../app/i18n";
import {
  classifyRoomDocumentError,
  fetchRoomDocumentBytes,
  requestRoomDocumentView,
  RoomDocumentBytesError,
  useRoomDocumentDownload,
  useRoomDocuments,
} from "../../app/roomDocuments";
import type {
  PendingWhiteboardSnippet,
  WhiteboardSnippetBridge,
} from "../collaboration/whiteboardSnippetBridge";
import { DocumentLibrary, type DocumentLibraryQuery } from "./DocumentLibrary";
import { DocumentViewer } from "./DocumentViewer";
import type {
  ClassroomFilesSession,
  ClassroomFilesViewState,
} from "./filesSession";
import type { ClassroomToolActions } from "./toolActions";
import "./ClassroomFilesTool.css";

/**
 * ROOM-TOOLS-FILES-01B / ADR-0045 §1, §3 (lazy chunk): the Documents tool.
 * With nothing open the room library fills the stage; opening a ready file
 * asks the server for a short-lived, version-bound view capability, fetches
 * the bytes into memory (no cookies, no referrer, no HTTP cache, SHA-256
 * checked) and hands them to the virtualized zero-scripting viewer.
 */
export default function LazyDocumentViewer({
  headerSlot,
  mediaSpaceID,
  session,
  snippetBridge,
  tenantID,
  toolActions,
  whiteboardCanEdit,
  whiteboardEnabled = false,
}: {
  readonly actorID: string;
  readonly headerSlot: HTMLElement | null | undefined;
  readonly mediaSpaceID: string;
  readonly session: ClassroomFilesSession;
  readonly snippetBridge?: WhiteboardSnippetBridge;
  readonly tenantID: string;
  readonly toolActions: ClassroomToolActions | null;
  readonly whiteboardCanEdit?: boolean;
  readonly whiteboardEnabled?: boolean;
}) {
  const { t } = useI18n();
  const [view, setView] = useState<ClassroomFilesViewState | null>(() =>
    session.readView(),
  );
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [pendingDownload, setPendingDownload] = useState<RoomDocument | null>(
    null,
  );
  const documents = useRoomDocuments(tenantID, mediaSpaceID, true);
  const download = useRoomDocumentDownload(tenantID);

  // Sign-out / leaving the room wipes the session: drop what is shown.
  useEffect(
    () =>
      session.subscribe(() => {
        setView(null);
        setLibraryOpen(false);
      }),
    [session],
  );

  const allDocuments = useMemo(
    () => documents.data?.pages.flatMap((page) => page.items) ?? [],
    [documents.data],
  );
  const viewerAccess = documents.data?.pages[0]?.viewer_access ?? null;
  const query: DocumentLibraryQuery = {
    documents: allDocuments,
    error: documents.error,
    fetchNextPage: () => void documents.fetchNextPage(),
    hasNextPage: documents.hasNextPage,
    isError: documents.isError,
    isFetchingNextPage: documents.isFetchingNextPage,
    isPending: documents.isPending,
    refetch: () => void documents.refetch(),
    viewerAccess,
  };
  const openFileID = view?.document.fileID ?? null;
  const currentDocument =
    openFileID === null
      ? null
      : (allDocuments.find((document) => document.id === openFileID) ?? null);

  const openDocument = (document: RoomDocument) => {
    setLibraryOpen(false);
    if (document.id === openFileID) return;
    const next: ClassroomFilesViewState = {
      document: {
        activeContent: document.active_content,
        displayName: document.display_name,
        fileID: document.id,
        firstPageAspect: document.first_page_aspect ?? 0.7071,
        mediaType: document.declared_media_type,
        pageCount: Math.max(1, document.page_count ?? 1),
        versionID: null,
      },
      fitMode: "width",
      page: 1,
      zoom: 1,
    };
    session.saveView(next);
    setView(next);
  };

  const requestDownload = (document: RoomDocument) => {
    if (document.active_content) {
      setPendingDownload(document);
      return;
    }
    download.mutate(document);
  };

  const saveView = useCallback(
    (next: ClassroomFilesViewState) => session.saveView(next),
    [session],
  );
  const markLoaded = useCallback(
    (versionID: string) => {
      const saved = session.readView();
      if (saved && saved.document.versionID !== versionID) {
        session.saveView({
          ...saved,
          document: { ...saved.document, versionID },
        });
      }
      setView((previous) =>
        previous && previous.document.versionID !== versionID
          ? { ...previous, document: { ...previous.document, versionID } }
          : previous,
      );
    },
    [session],
  );

  const sendToWhiteboard = useCallback(
    (snippet: PendingWhiteboardSnippet) => {
      snippetBridge?.push(snippet);
      toolActions?.openTool("whiteboard");
    },
    [snippetBridge, toolActions],
  );
  const whiteboard =
    whiteboardEnabled && snippetBridge && toolActions?.hasTool("whiteboard")
      ? { canEdit: whiteboardCanEdit, onSend: sendToWhiteboard }
      : null;

  const library = (mode: "drawer" | "stage") => (
    <DocumentLibrary
      activeFileID={openFileID}
      mediaSpaceID={mediaSpaceID}
      mode={mode}
      onClose={() => setLibraryOpen(false)}
      onDownload={requestDownload}
      onOpen={openDocument}
      query={query}
      tenantID={tenantID}
    />
  );

  return (
    <div className="classroom-files">
      {view === null ? (
        library("stage")
      ) : (
        <DocumentLoader
          canDownloadOriginal={
            currentDocument?.viewer_access.can_download_original === true
          }
          headerSlot={headerSlot}
          key={view.document.fileID}
          libraryOpen={libraryOpen}
          mediaSpaceID={mediaSpaceID}
          onDownloadOriginal={() => {
            if (currentDocument) requestDownload(currentDocument);
          }}
          onLoaded={markLoaded}
          onOpenLibrary={() => setLibraryOpen(true)}
          onViewChange={saveView}
          session={session}
          tenantID={tenantID}
          view={view}
          whiteboard={whiteboard}
        />
      )}
      {view !== null && libraryOpen ? (
        <div className="classroom-files-drawer">{library("drawer")}</div>
      ) : null}
      {download.isError ? (
        <p
          className="classroom-files-toast classroom-files-toast--error"
          role="alert"
        >
          {classifyRoomDocumentError(download.error) === "forbidden"
            ? t("classroomTools.files.library.downloadForbidden")
            : t("classroomTools.files.library.downloadFailed")}
        </p>
      ) : null}
      {pendingDownload ? (
        <ActiveContentDialog
          document={pendingDownload}
          onCancel={() => setPendingDownload(null)}
          onConfirm={() => {
            download.mutate(pendingDownload);
            setPendingDownload(null);
          }}
        />
      ) : null}
    </div>
  );
}

type LoadState =
  | { readonly kind: "capability" }
  | { readonly kind: "downloading"; readonly percent: number }
  | { readonly bytes: Uint8Array; readonly kind: "ready" }
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

function DocumentLoader({
  canDownloadOriginal,
  headerSlot,
  libraryOpen,
  mediaSpaceID,
  onDownloadOriginal,
  onLoaded,
  onOpenLibrary,
  onViewChange,
  session,
  tenantID,
  view,
  whiteboard,
}: {
  readonly canDownloadOriginal: boolean;
  readonly headerSlot: HTMLElement | null | undefined;
  readonly libraryOpen: boolean;
  readonly mediaSpaceID: string;
  readonly onDownloadOriginal: () => void;
  readonly onLoaded: (versionID: string) => void;
  readonly onOpenLibrary: () => void;
  readonly onViewChange: (view: ClassroomFilesViewState) => void;
  readonly session: ClassroomFilesSession;
  readonly tenantID: string;
  readonly view: ClassroomFilesViewState;
  readonly whiteboard: {
    readonly canEdit?: boolean;
    readonly onSend: (snippet: PendingWhiteboardSnippet) => void;
  } | null;
}) {
  const { t } = useI18n();
  const fileID = view.document.fileID;
  const knownVersion = view.document.versionID;
  // Cached bytes from earlier in this room session open without a request.
  const [initial] = useState<LoadState>(() => {
    const cached =
      knownVersion === null ? null : session.readBytes(fileID, knownVersion);
    return cached ? { bytes: cached, kind: "ready" } : { kind: "capability" };
  });
  const [state, setState] = useState<LoadState>(initial);
  const [attempt, setAttempt] = useState(0);
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
  });

  useEffect(() => {
    if (attempt === 0 && initial.kind === "ready") return undefined;
    const controller = new AbortController();
    void (async () => {
      try {
        const capability = await requestRoomDocumentView(
          tenantID,
          mediaSpaceID,
          fileID,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        const cached = session.readBytes(fileID, capability.version_id);
        if (cached) {
          setState({ bytes: cached, kind: "ready" });
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
        setState({ bytes, kind: "ready" });
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
    return () => controller.abort();
  }, [attempt, fileID, initial.kind, mediaSpaceID, session, tenantID]);

  if (state.kind === "ready") {
    return (
      <DocumentViewer
        bytes={state.bytes}
        canDownloadOriginal={canDownloadOriginal}
        headerSlot={headerSlot}
        libraryOpen={libraryOpen}
        onDownloadOriginal={onDownloadOriginal}
        onOpenLibrary={onOpenLibrary}
        onViewChange={onViewChange}
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
          {state.reason === "forbidden" ||
          state.reason === "featureOff" ? null : (
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

function ActiveContentDialog({
  document,
  onCancel,
  onConfirm,
}: {
  readonly document: RoomDocument;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const { t } = useI18n();
  const titleID = useId();
  const descriptionID = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener =
      globalThis.document.activeElement instanceof HTMLElement
        ? globalThis.document.activeElement
        : null;
    cancelRef.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    <div className="classroom-files-dialog-backdrop">
      <div
        aria-describedby={descriptionID}
        aria-labelledby={titleID}
        className="classroom-files-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
            return;
          }
          if (event.key !== "Tab") return;
          const buttons = Array.from(
            rootRef.current?.querySelectorAll<HTMLElement>("button") ?? [],
          );
          const first = buttons[0];
          const last = buttons[buttons.length - 1];
          const active = globalThis.document.activeElement;
          if (!first || !last) return;
          if (event.shiftKey && active === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        ref={rootRef}
        role="alertdialog"
      >
        <h3 className="classroom-files-dialog__title" id={titleID}>
          <AlertTriangle aria-hidden="true" />
          {t("classroomTools.files.activeContent.title")}
        </h3>
        <div id={descriptionID}>
          <p>
            {t("classroomTools.files.activeContent.body", {
              name: document.display_name,
            })}
          </p>
          <p>{t("classroomTools.files.activeContent.advice")}</p>
        </div>
        <div className="classroom-files-dialog__actions">
          <Button onClick={onConfirm} size="sm" variant="danger">
            {t("classroomTools.files.activeContent.confirm")}
          </Button>
          <Button
            onClick={onCancel}
            ref={cancelRef}
            size="sm"
            variant="secondary"
          >
            {t("classroomTools.files.cancel")}
          </Button>
        </div>
      </div>
    </div>
  );
}
