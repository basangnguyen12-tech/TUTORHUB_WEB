import type { PdfPresentation, RoomDocument } from "@tutorhub/api-client";
import { Button, IconButton } from "@tutorhub/ui";
import { AlertTriangle, MonitorPlay, Square, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useI18n, type TranslationKey } from "../../app/i18n";
import {
  pdfPresentationAutoOpenKey,
  usePdfPresentationTool,
  usePresentPdfDocument,
  useTransitionPdfPresentation,
  type PdfPresentationOperation,
} from "../../app/pdfPresentations";
import {
  classifyRoomDocumentError,
  useRoomDocumentDownload,
  useRoomDocuments,
} from "../../app/roomDocuments";
import type {
  PendingWhiteboardSnippet,
  WhiteboardSnippetBridge,
} from "../collaboration/whiteboardSnippetBridge";
import type { CodePresenceRoster } from "./codePresence";
import { DocumentLibrary, type DocumentLibraryQuery } from "./DocumentLibrary";
import { DocumentLoader } from "./DocumentLoader";
import type {
  ClassroomFilesSession,
  ClassroomFilesViewState,
} from "./filesSession";
import {
  PdfPresentationStage,
  PresentationLifecycleMenu,
} from "./PdfPresentationStage";
import type { ClassroomToolActions } from "./toolActions";
import "./ClassroomFilesTool.css";

/**
 * ROOM-TOOLS-FILES-01B / ADR-0045 §1, §3 (lazy chunk): the Documents tool.
 * With nothing open the room library fills the stage; opening a ready file
 * asks the server for a short-lived, version-bound view capability, fetches
 * the bytes into memory (no cookies, no referrer, no HTTP cache, SHA-256
 * checked) — or Range-loads a 30–50 MiB PDF — and hands them to the
 * virtualized zero-scripting viewer.
 *
 * ROOM-TOOLS-FILES-02B: with `classroom_pdf_collaboration` on, the Top Bar
 * gains "Trình chiếu lớp | Xem riêng": the class presentation (page-scoped
 * ink, laser, follow) or the viewer's own private reading.
 */
export interface LazyDocumentViewerProps {
  readonly actorID: string;
  /** `classroom_pdf_collaboration` (with the files switches) is on. */
  readonly collaborationEnabled?: boolean;
  readonly displayName?: string;
  readonly headerSlot: HTMLElement | null | undefined;
  readonly mediaSpaceID: string;
  readonly presenceRoster?: CodePresenceRoster | null;
  readonly session: ClassroomFilesSession;
  readonly snippetBridge?: WhiteboardSnippetBridge;
  readonly tenantID: string;
  readonly toolActions: ClassroomToolActions | null;
  readonly whiteboardCanEdit?: boolean;
  readonly whiteboardEnabled?: boolean;
}

export default function LazyDocumentViewer(props: LazyDocumentViewerProps) {
  if (props.collaborationEnabled !== true)
    return <PrivateDocuments {...props} />;
  return <CollaborativeDocuments {...props} />;
}

type WhiteboardTarget = {
  readonly canEdit?: boolean;
  readonly onSend: (snippet: PendingWhiteboardSnippet) => void;
} | null;

function useWhiteboardTarget({
  snippetBridge,
  toolActions,
  whiteboardCanEdit,
  whiteboardEnabled = false,
}: Pick<
  LazyDocumentViewerProps,
  "snippetBridge" | "toolActions" | "whiteboardCanEdit" | "whiteboardEnabled"
>): WhiteboardTarget {
  const sendToWhiteboard = useCallback(
    (snippet: PendingWhiteboardSnippet) => {
      snippetBridge?.push(snippet);
      toolActions?.openTool("whiteboard");
    },
    [snippetBridge, toolActions],
  );
  return whiteboardEnabled &&
    snippetBridge &&
    toolActions?.hasTool("whiteboard")
    ? { canEdit: whiteboardCanEdit, onSend: sendToWhiteboard }
    : null;
}

function useLibraryQuery(tenantID: string, mediaSpaceID: string) {
  const documents = useRoomDocuments(tenantID, mediaSpaceID, true);
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
  return { allDocuments, query };
}

/** "Tải bản gốc" with the active-content warning and its error toast. */
function useOriginalDownload(tenantID: string) {
  const { t } = useI18n();
  const download = useRoomDocumentDownload(tenantID);
  const [pending, setPending] = useState<RoomDocument | null>(null);
  const request = (document: RoomDocument) => {
    if (document.active_content) {
      setPending(document);
      return;
    }
    download.mutate(document);
  };
  const ui = (
    <>
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
      {pending ? (
        <ActiveContentDialog
          document={pending}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            download.mutate(pending);
            setPending(null);
          }}
        />
      ) : null}
    </>
  );
  return { request, ui };
}

function privateView(document: RoomDocument): ClassroomFilesViewState {
  return {
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
}

interface PresentControls {
  readonly onPresent: (document: RoomDocument) => void;
  readonly pending: boolean;
  readonly presentingFileID: string | null;
}

/** Slice 1 behaviour (and "Xem riêng" when collaboration is on). */
function PrivateDocuments({
  headerSlot,
  mediaSpaceID,
  present = null,
  session,
  snippetBridge,
  tenantID,
  toolActions,
  whiteboardCanEdit,
  whiteboardEnabled,
}: LazyDocumentViewerProps & { readonly present?: PresentControls | null }) {
  const { t } = useI18n();
  const [view, setView] = useState<ClassroomFilesViewState | null>(() =>
    session.readView(),
  );
  const [libraryOpen, setLibraryOpen] = useState(false);
  const { allDocuments, query } = useLibraryQuery(tenantID, mediaSpaceID);
  const download = useOriginalDownload(tenantID);
  const whiteboard = useWhiteboardTarget({
    snippetBridge,
    toolActions,
    whiteboardCanEdit,
    whiteboardEnabled,
  });

  // Sign-out / leaving the room wipes the session: drop what is shown.
  useEffect(
    () =>
      session.subscribe(() => {
        setView(null);
        setLibraryOpen(false);
      }),
    [session],
  );

  const openFileID = view?.document.fileID ?? null;
  const currentDocument =
    openFileID === null
      ? null
      : (allDocuments.find((document) => document.id === openFileID) ?? null);

  const openDocument = (document: RoomDocument) => {
    setLibraryOpen(false);
    if (document.id === openFileID) return;
    const next = privateView(document);
    session.saveView(next);
    setView(next);
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

  const library = (mode: "drawer" | "stage") => (
    <DocumentLibrary
      activeFileID={openFileID}
      mediaSpaceID={mediaSpaceID}
      mode={mode}
      onClose={() => setLibraryOpen(false)}
      onDownload={download.request}
      onOpen={openDocument}
      onPresent={present?.onPresent}
      presentPending={present?.pending}
      presentingFileID={present?.presentingFileID ?? null}
      query={query}
      tenantID={tenantID}
    />
  );

  const presentable =
    present !== null &&
    currentDocument !== null &&
    currentDocument.status === "ready" &&
    currentDocument.viewer_access.can_view &&
    currentDocument.id !== present.presentingFileID;
  const topBarExtra = presentable ? (
    <Button
      className="classroom-files-topbar__present"
      data-tooltip={t("classroomTools.files.present.present")}
      data-tooltip-side="bottom"
      disabled={present.pending}
      leadingIcon={<MonitorPlay />}
      onClick={() => present.onPresent(currentDocument)}
      size="sm"
    >
      <span className="classroom-files-topbar__present-label">
        {t("classroomTools.files.present.present")}
      </span>
    </Button>
  ) : null;

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
            if (currentDocument) download.request(currentDocument);
          }}
          onLoaded={markLoaded}
          onOpenLibrary={() => setLibraryOpen(true)}
          onViewChange={saveView}
          session={session}
          tenantID={tenantID}
          topBarExtra={topBarExtra}
          view={view}
          whiteboard={whiteboard}
        />
      )}
      {view !== null && libraryOpen ? (
        <div className="classroom-files-drawer">{library("drawer")}</div>
      ) : null}
      {download.ui}
    </div>
  );
}

type DocumentsMode = "class" | "mine";

function CollaborativeDocuments(props: LazyDocumentViewerProps) {
  const {
    actorID,
    displayName = "",
    headerSlot,
    mediaSpaceID,
    presenceRoster = null,
    session,
    tenantID,
  } = props;
  const { t } = useI18n();
  const tool = usePdfPresentationTool(tenantID, mediaSpaceID, true);
  const projection = tool.isSuccess ? tool.data : undefined;
  const presentation = projection?.presentation ?? null;
  const { allDocuments, query } = useLibraryQuery(tenantID, mediaSpaceID);
  const canPresent =
    projection?.can_present === true ||
    query.viewerAccess?.can_present === true;
  const openKey = pdfPresentationAutoOpenKey(presentation);
  const classAvailable =
    presentation !== null &&
    (presentation.status === "open" ||
      (presentation.status === "suspended" &&
        presentation.viewer_capabilities.can_resume));
  const resolved = tool.isSuccess || tool.isError;
  const [mode, setMode] = useState<DocumentsMode | null>(null);
  const [handledOpenKey, setHandledOpenKey] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<TranslationKey | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [innerSlot, setInnerSlot] = useState<HTMLSpanElement | null>(null);

  // Adjust state while rendering: the first mode, then one automatic
  // switch to "Trình chiếu lớp" per presented `id:generation:revoke`.
  if (mode === null && resolved) {
    setMode(openKey ? "class" : "mine");
    setHandledOpenKey(openKey);
  } else if (mode !== null && openKey !== null && openKey !== handledOpenKey) {
    setHandledOpenKey(openKey);
    if (mode === "mine") {
      setMode("class");
      setNotice(t("classroomTools.files.present.autoSwitched"));
    }
  }
  const effectiveMode: DocumentsMode | null =
    mode === "class" && !classAvailable ? "mine" : mode;

  const presentMutation = usePresentPdfDocument(tenantID, mediaSpaceID);
  const transitionMutation = useTransitionPdfPresentation(
    tenantID,
    mediaSpaceID,
  );
  const presentingFileID =
    presentation?.status === "open" ? presentation.file_id : null;
  const present: PresentControls | null = canPresent
    ? {
        onPresent: (document) => {
          setError(null);
          presentMutation.mutate(
            { fileID: document.id },
            {
              onError: () =>
                setError("classroomTools.files.present.presentFailed"),
              onSuccess: (next: PdfPresentation) => {
                setHandledOpenKey(pdfPresentationAutoOpenKey(next));
                setLibraryOpen(false);
                setMode("class");
              },
            },
          );
        },
        pending: presentMutation.isPending,
        presentingFileID,
      }
    : null;
  const transition = (operation: PdfPresentationOperation) => {
    if (!presentation) return;
    setError(null);
    transitionMutation.mutate(
      { operation, presentation },
      {
        onError: () =>
          setError("classroomTools.files.present.transitionFailed"),
      },
    );
  };

  const download = useOriginalDownload(tenantID);
  const whiteboard = useWhiteboardTarget(props);
  const presentedDocument =
    presentation === null
      ? null
      : (allDocuments.find(
          (document) => document.id === presentation.file_id,
        ) ?? null);

  const openPrivately = (document: RoomDocument) => {
    session.saveView(privateView(document));
    setLibraryOpen(false);
    setMode("mine");
  };

  const group = (
    <div className="classroom-code-header-group classroom-files-header-group">
      {classAvailable ? (
        <div
          aria-label={t("classroomTools.files.present.modeGroup")}
          className="classroom-code-mode"
          role="group"
        >
          <button
            aria-pressed={effectiveMode === "class"}
            className="classroom-code-mode__option"
            data-mode="class"
            disabled={effectiveMode === null}
            onClick={() => setMode("class")}
            type="button"
          >
            {presentation?.status === "open" ? (
              <span aria-hidden="true" className="classroom-code-mode__dot" />
            ) : null}
            {t("classroomTools.files.present.modeClass")}
            {presentation?.status === "open" ? (
              <span className="visually-hidden">
                {` (${t("classroomTools.files.present.modeLive")})`}
              </span>
            ) : null}
          </button>
          <button
            aria-pressed={effectiveMode === "mine"}
            className="classroom-code-mode__option"
            data-mode="mine"
            disabled={effectiveMode === null}
            onClick={() => setMode("mine")}
            type="button"
          >
            {t("classroomTools.files.present.modePrivate")}
          </button>
        </div>
      ) : null}
      <span className="classroom-code-header-group__slot" ref={setInnerSlot} />
    </div>
  );

  let content: ReactNode;
  if (effectiveMode === null) {
    content = (
      <div className="classroom-files-state" role="status">
        <span aria-hidden="true" className="classroom-code-state__spinner" />
        <p>{t("classroomTools.files.loading")}</p>
      </div>
    );
  } else if (effectiveMode === "mine" || presentation === null) {
    content = (
      <PrivateDocuments
        {...props}
        headerSlot={headerSlot === undefined ? undefined : innerSlot}
        key="mine"
        present={present}
      />
    );
  } else if (presentation.status === "suspended") {
    content = (
      <div className="classroom-files-state" role="status">
        <MonitorPlay
          aria-hidden="true"
          className="classroom-files-state__icon"
        />
        <p className="classroom-files-state__title">
          {t("classroomTools.files.present.suspendedTitle")}
        </p>
        <p>{t("classroomTools.files.present.suspendedBody")}</p>
        <div className="classroom-files-state__actions">
          <Button
            disabled={transitionMutation.isPending}
            leadingIcon={<MonitorPlay />}
            onClick={() => transition("resume")}
            size="sm"
          >
            {t("classroomTools.files.present.resume")}
          </Button>
          {presentation.viewer_capabilities.can_close ? (
            <Button
              disabled={transitionMutation.isPending}
              leadingIcon={<Square />}
              onClick={() => transition("close")}
              size="sm"
              variant="secondary"
            >
              {t("classroomTools.files.present.close")}
            </Button>
          ) : null}
        </div>
      </div>
    );
  } else if (presentation.document === null) {
    const manager = presentation.viewer_capabilities.can_close;
    content = (
      <div className="classroom-files-state" role="alert">
        <AlertTriangle
          aria-hidden="true"
          className="classroom-files-state__icon"
        />
        <p className="classroom-files-state__title">
          {manager
            ? t("classroomTools.files.present.documentGoneTitle")
            : t("classroomTools.files.present.documentGoneViewer")}
        </p>
        {manager ? (
          <>
            <p>{t("classroomTools.files.present.documentGoneBody")}</p>
            <div className="classroom-files-state__actions">
              <PresentationLifecycleMenu
                canClose
                canSuspend={false}
                onTransition={transition}
                pending={transitionMutation.isPending}
              />
            </div>
          </>
        ) : null}
      </div>
    );
  } else {
    content = (
      <PdfPresentationStage
        actorID={actorID}
        canDownloadOriginal={
          presentedDocument?.viewer_access.can_download_original === true
        }
        displayName={displayName}
        headerSlot={headerSlot === undefined ? undefined : innerSlot}
        key={presentation.id}
        libraryOpen={libraryOpen}
        mediaSpaceID={mediaSpaceID}
        onDownloadOriginal={() => {
          if (presentedDocument) download.request(presentedDocument);
        }}
        onOpenLibrary={() => setLibraryOpen(true)}
        onTransition={transition}
        presenceRoster={presenceRoster}
        presentation={presentation}
        refetch={tool.refetch}
        session={session}
        tenantID={tenantID}
        transitionPending={transitionMutation.isPending}
        whiteboard={whiteboard}
      />
    );
  }

  const classDrawer =
    effectiveMode === "class" && libraryOpen ? (
      <div className="classroom-files-drawer">
        <DocumentLibrary
          activeFileID={presentation?.file_id ?? null}
          mediaSpaceID={mediaSpaceID}
          mode="drawer"
          onClose={() => setLibraryOpen(false)}
          onDownload={download.request}
          onOpen={openPrivately}
          onPresent={present?.onPresent}
          presentPending={present?.pending}
          presentingFileID={presentingFileID}
          query={query}
          tenantID={tenantID}
        />
      </div>
    ) : null;

  return (
    <div className="classroom-files">
      {headerSlot
        ? createPortal(group, headerSlot)
        : headerSlot === undefined
          ? group
          : null}
      <p
        aria-atomic="true"
        aria-live="polite"
        className="classroom-files-sr-only"
        role="status"
      >
        {notice}
      </p>
      {content}
      {classDrawer}
      {error ? (
        <div
          className="classroom-files-toast classroom-files-toast--error"
          role="alert"
        >
          <p>{t(error)}</p>
          <IconButton
            label={t("classroomTools.files.ink.dismiss")}
            onClick={() => setError(null)}
            size="sm"
            variant="quiet"
          >
            <X />
          </IconButton>
        </div>
      ) : null}
      {download.ui}
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
