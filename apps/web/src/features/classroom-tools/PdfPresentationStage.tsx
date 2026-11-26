import type {
  PdfPresentation,
  WhiteboardCapability,
} from "@tutorhub/api-client";
import type {
  CollaborationConnectionStatus,
  PdfAnnotationMeta,
  PdfAnnotationWidth,
} from "@tutorhub/collaboration-client";
import {
  Button,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from "@tutorhub/ui";
import {
  Eye,
  EyeOff,
  LocateFixed,
  Lock,
  LockOpen,
  MonitorPlay,
  Pause,
  RefreshCw,
  Square,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useI18n, type TranslationKey } from "../../app/i18n";
import {
  requestPdfPresentationGrant,
  type PdfPresentationOperation,
} from "../../app/pdfPresentations";
import type { PendingWhiteboardSnippet } from "../collaboration/whiteboardSnippetBridge";
import type { CodePresenceRoster } from "./codePresence";
import { DocumentLoader } from "./DocumentLoader";
import type { DocumentViewerPresentation } from "./DocumentViewer";
import type { NormalizedRect } from "./documentViewerModel";
import type {
  ClassroomFilesSession,
  ClassroomFilesViewState,
} from "./filesSession";
import type { LivePdfSession, PdfLaserMark } from "./livePdfCollaboration";
import {
  PdfAnnotationOverlay,
  PdfInkToolbar,
  type PdfInkSettings,
} from "./PdfAnnotationOverlay";
import {
  drawStrokesOnCanvas,
  inkToolsFor,
  pdfAnnotationErrorKey,
  PDF_INK_DEFAULT_TONES,
  strokesIntersectRect,
  type PdfInkTool,
} from "./pdfAnnotationModel";
import {
  followReducer,
  INITIAL_FOLLOW_STATE,
  presenterPublishPage,
  toggleHiddenPage,
  type FollowEvent,
  type FollowState,
} from "./pdfPresentationModel";

/**
 * ROOM-TOOLS-FILES-02B (ADR-0045 Slice 2): "Trình chiếu lớp". The presented
 * document (pinned to `presentation.version_id`) is shown in the regular
 * viewer; a `pdf.annotations.v1` session — loaded on demand — adds the
 * presenter's page, follow lock, hidden pages, page-scoped ink and the
 * server-stamped laser. A capability change (`view ↔ edit`) or a new fence
 * swaps the session in place: the viewer, its PDF and its scroll stay.
 */
const SESSION_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 15_000] as const;
const PRESENTER_PAGE_DEBOUNCE_MS = 200;

interface SessionEntry {
  readonly capability: WhiteboardCapability;
  readonly key: string;
  readonly session: LivePdfSession;
}

function usePdfAnnotationSession({
  actorID,
  displayName,
  onAnnounce,
  participantKey,
  presentation,
  refetch,
  tenantID,
}: {
  readonly actorID: string;
  readonly displayName: string;
  readonly onAnnounce: (key: TranslationKey) => void;
  readonly participantKey: string | null;
  readonly presentation: PdfPresentation;
  readonly refetch: () => Promise<unknown>;
  readonly tenantID: string;
}) {
  const capability = presentation.viewer_capabilities.capability;
  const presentationID = presentation.id;
  const generation = presentation.current_generation;
  const revokeGeneration = presentation.revoke_generation;
  const fileID = presentation.file_id;
  const versionID = presentation.version_id;
  const pageCount = presentation.page_count;
  const enabled =
    presentation.status === "open" &&
    presentation.viewer_capabilities.can_exchange_grant;
  const key = `${presentationID}:${generation}:${revokeGeneration}:${capability}`;
  const [entry, setEntry] = useState<SessionEntry | null>(null);
  const [connection, setConnection] =
    useState<CollaborationConnectionStatus>("connecting");
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [terminalKey, setTerminalKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [autoRetries, setAutoRetries] = useState(0);
  const entryRef = useRef<SessionEntry | null>(null);
  const latest = useRef({
    displayName,
    onAnnounce,
    participantKey,
    presentation,
    refetch,
  });
  useLayoutEffect(() => {
    latest.current = {
      displayName,
      onAnnounce,
      participantKey,
      presentation,
      refetch,
    };
  });

  useEffect(() => {
    if (!enabled) return undefined;
    const abort = new AbortController();
    const fenced: PdfPresentation = {
      ...latest.current.presentation,
      current_generation: generation,
      id: presentationID,
      revoke_generation: revokeGeneration,
    };
    const run = async () => {
      // The CRDT code is fetched only now (its own lazy chunk).
      const module = await import("./livePdfCollaboration");
      const grant = await requestPdfPresentationGrant(
        tenantID,
        fenced,
        capability,
        abort.signal,
      );
      if (abort.signal.aborted) return;
      let created: SessionEntry | null = null;
      const session = await module.openLivePdfSession({
        actorID,
        binding: { fileId: fileID, pageCount, versionId: versionID },
        displayName: latest.current.displayName,
        grant,
        onStatus: (status) => {
          if (created && entryRef.current === created) setConnection(status);
        },
        onTerminal: () => {
          if (!created || entryRef.current !== created) return;
          setTerminalKey(created.key);
          // A revoked or expired grant shows up as a new capability.
          void latest.current.refetch();
        },
        participantKey: latest.current.participantKey,
        tenantID,
      });
      if (abort.signal.aborted) {
        session.destroy();
        return;
      }
      const next: SessionEntry = {
        capability: session.capability,
        key,
        session,
      };
      created = next;
      const previous = entryRef.current;
      entryRef.current = next;
      setEntry(next);
      setConnection("connected");
      setFailedKey(null);
      setTerminalKey(null);
      setAutoRetries(0);
      previous?.session.destroy();
      if (previous) {
        if (previous.capability === "view" && next.capability !== "view") {
          latest.current.onAnnounce("classroomTools.files.present.upgraded");
        } else if (
          previous.capability !== "view" &&
          next.capability === "view"
        ) {
          latest.current.onAnnounce("classroomTools.files.present.downgraded");
        }
      }
    };
    run().catch(() => {
      if (!abort.signal.aborted) setFailedKey(key);
    });
    return () => abort.abort();
  }, [
    actorID,
    attempt,
    capability,
    enabled,
    fileID,
    generation,
    key,
    pageCount,
    presentationID,
    revokeGeneration,
    tenantID,
    versionID,
  ]);

  useEffect(
    () => () => {
      entryRef.current?.session.destroy();
      entryRef.current = null;
    },
    [],
  );

  // A presenter may still be bootstrapping the layer: retry a few times.
  const failed = failedKey === key;
  useEffect(() => {
    if (!failed || autoRetries >= SESSION_RETRY_DELAYS_MS.length) {
      return undefined;
    }
    const timer = globalThis.setTimeout(() => {
      setAutoRetries((value) => value + 1);
      setFailedKey(null);
      setAttempt((value) => value + 1);
    }, SESSION_RETRY_DELAYS_MS[autoRetries]);
    return () => globalThis.clearTimeout(timer);
  }, [autoRetries, failed]);

  const retry = useCallback(() => {
    setAutoRetries(0);
    setFailedKey(null);
    setTerminalKey(null);
    setAttempt((value) => value + 1);
  }, []);

  const terminal = entry !== null && terminalKey === entry.key;
  const current = entry !== null && entry.key === key && !terminal;
  return {
    /** Effective capability: anything stale or terminal is read-only. */
    capability: current && entry ? entry.capability : ("view" as const),
    connection: terminal ? ("failed" as const) : connection,
    failed: failed && autoRetries >= SESSION_RETRY_DELAYS_MS.length,
    retry,
    session: entry?.session ?? null,
    sessionKey: entry?.key ?? null,
  };
}

const DEFAULT_META: PdfAnnotationMeta = Object.freeze({
  followLock: false,
  hiddenPages: Object.freeze([]) as readonly number[],
  pageCount: 1,
  presenterPage: 1,
});
const noopSubscribe = () => () => undefined;

function useMeta(session: LivePdfSession | null): PdfAnnotationMeta {
  const version = useSyncExternalStore(
    session ? session.ink.subscribe : noopSubscribe,
    () => (session ? session.ink.version() : -1),
  );
  void version;
  if (!session) return DEFAULT_META;
  try {
    return session.ink.meta();
  } catch {
    return DEFAULT_META;
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.closest("input, textarea, select, [contenteditable='true']") !==
        null)
  );
}

export interface PdfPresentationStageProps {
  readonly chatPageRequest?: DocumentViewerPresentation["chatPageRequest"];
  readonly actorID: string;
  readonly canDownloadOriginal: boolean;
  readonly displayName: string;
  readonly headerSlot: HTMLElement | null | undefined;
  readonly libraryOpen: boolean;
  readonly mediaSpaceID: string;
  readonly onDownloadOriginal: () => void;
  readonly onOpenLibrary: () => void;
  readonly onTransition: (operation: PdfPresentationOperation) => void;
  readonly presenceRoster: CodePresenceRoster | null;
  readonly presentation: PdfPresentation;
  readonly refetch: () => Promise<unknown>;
  readonly session: ClassroomFilesSession;
  readonly tenantID: string;
  readonly transitionPending: boolean;
  readonly whiteboard: {
    readonly canEdit?: boolean;
    readonly onSend: (snippet: PendingWhiteboardSnippet) => void;
  } | null;
}

export function PdfPresentationStage({
  chatPageRequest,
  actorID,
  canDownloadOriginal,
  displayName,
  headerSlot,
  libraryOpen,
  mediaSpaceID,
  onDownloadOriginal,
  onOpenLibrary,
  onTransition,
  presenceRoster,
  presentation,
  refetch,
  session: filesSession,
  tenantID,
  transitionPending,
  whiteboard,
}: PdfPresentationStageProps) {
  const { t } = useI18n();
  const document = presentation.document;
  const [announcement, setAnnouncement] = useState("");
  const [notice, setNotice] = useState<TranslationKey | null>(null);
  const announce = useCallback(
    (key: TranslationKey) => setAnnouncement(t(key)),
    [t],
  );
  const live = usePdfAnnotationSession({
    actorID,
    displayName,
    onAnnounce: announce,
    participantKey: presenceRoster?.selfParticipantKey ?? null,
    presentation,
    refetch,
    tenantID,
  });
  const { capability, session } = live;
  const presenter = capability === "present";
  const meta = useMeta(session);
  const locked = !presenter && meta.followLock;

  // ---- Page state ------------------------------------------------------
  const [currentPage, setCurrentPage] = useState(1);
  const [follow, dispatchFollow] = useReducer(
    (state: FollowState, action: { event: FollowEvent; locked: boolean }) =>
      followReducer(state, action.event, action.locked),
    INITIAL_FOLLOW_STATE,
  );
  const sendFollow = useCallback(
    (event: FollowEvent) => dispatchFollow({ event, locked }),
    [locked],
  );

  // Viewers: every presenter move (and the first sync) scrolls while
  // following; the lock pins everyone. Adjusted while rendering.
  const moveKey =
    session && !presenter ? `${live.sessionKey}|${meta.presenterPage}` : null;
  const [seenMoveKey, setSeenMoveKey] = useState<string | null>(null);
  if (moveKey !== seenMoveKey) {
    setSeenMoveKey(moveKey);
    if (moveKey !== null)
      dispatchFollow({ event: { type: "presenterMoved" }, locked });
  }
  const [seenLocked, setSeenLocked] = useState(false);
  if (locked !== seenLocked) {
    setSeenLocked(locked);
    if (locked) dispatchFollow({ event: { type: "locked" }, locked: true });
  }

  // Presenter: land on the class page once per session, then publish.
  const [presenterSync, setPresenterSync] = useState({
    key: null as string | null,
    seq: 0,
  });
  if (presenter && session && live.sessionKey !== presenterSync.key) {
    setPresenterSync({ key: live.sessionKey, seq: presenterSync.seq + 1 });
  }
  const [appliedSeq, setAppliedSeq] = useState(0);
  const synced =
    presenter && presenterSync.seq > 0 && appliedSeq >= presenterSync.seq;

  useEffect(() => {
    if (!synced || !session || currentPage === meta.presenterPage) {
      return undefined;
    }
    const target = presenterPublishPage(
      currentPage,
      meta.hiddenPages,
      meta.presenterPage,
    );
    if (target === meta.presenterPage) return undefined;
    const timer = globalThis.setTimeout(() => {
      try {
        session.authority.setPresenterPage(target);
      } catch (error) {
        setNotice(pdfAnnotationErrorKey(error));
      }
    }, PRESENTER_PAGE_DEBOUNCE_MS);
    return () => globalThis.clearTimeout(timer);
  }, [currentPage, meta.hiddenPages, meta.presenterPage, session, synced]);

  const scrollRequest = presenter
    ? presenterSync.seq > 0
      ? { page: meta.presenterPage, seq: presenterSync.seq }
      : null
    : session && follow.seq > 0
      ? { page: meta.presenterPage, seq: follow.seq }
      : null;

  // ---- Ink settings ----------------------------------------------------
  const [tool, setTool] = useState<PdfInkTool>("select");
  const [tones, setTones] = useState(PDF_INK_DEFAULT_TONES);
  const [width, setWidth] = useState<PdfAnnotationWidth>("m");
  const offered = inkToolsFor(capability);
  const effectiveTool: PdfInkTool = offered.includes(tool) ? tool : "select";
  const settings = useMemo<PdfInkSettings>(
    () => ({
      tone: effectiveTool === "highlighter" ? tones.highlighter : tones.pen,
      tool: effectiveTool,
      width,
    }),
    [effectiveTool, tones, width],
  );

  const undo = useCallback(() => {
    if (!session || capability === "view") return;
    try {
      session.authority.undoLast();
    } catch (error) {
      setNotice(pdfAnnotationErrorKey(error));
    }
  }, [capability, session]);
  const redo = useCallback(() => {
    if (!session || capability === "view") return;
    try {
      session.authority.redoLast();
    } catch (error) {
      setNotice(pdfAnnotationErrorKey(error));
    }
  }, [capability, session]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (capability === "view" || isEditableTarget(event.target)) return;
    const key = event.key.toLowerCase();
    if (key === "z" && !event.shiftKey) {
      event.preventDefault();
      undo();
    } else if (key === "y" || (key === "z" && event.shiftKey)) {
      event.preventDefault();
      redo();
    }
  };

  const laserLabel = useCallback(
    (mark: PdfLaserMark) => {
      const name = presenceRoster?.participants.find(
        (participant) => participant.participant_key === mark.participantKey,
      )?.display_name;
      return name
        ? t("classroomTools.files.ink.laserOf", { name })
        : t("classroomTools.files.ink.laserMark");
    },
    [presenceRoster, t],
  );

  const renderPageOverlay = useCallback(
    (page: number, aspect: number): ReactNode => (
      <PdfAnnotationOverlay
        aspect={aspect}
        capability={capability}
        laserLabel={laserLabel}
        onInk={() => sendFollow({ type: "ink" })}
        onNotice={setNotice}
        page={page}
        session={session}
        settings={settings}
      />
    ),
    [capability, laserLabel, sendFollow, session, settings],
  );

  const drawSnippetAnnotations = useCallback(
    (page: number, rect: NormalizedRect, canvas: HTMLCanvasElement) => {
      if (!session) return;
      const context = canvas.getContext("2d");
      if (!context) return;
      drawStrokesOnCanvas(context, session.ink.strokes(page), rect, canvas);
    },
    [session],
  );
  const hasAnnotations = useCallback(
    (page: number, rect: NormalizedRect) =>
      session ? strokesIntersectRect(session.ink.strokes(page), rect) : false,
    [session],
  );

  // ---- Presenter controls ---------------------------------------------
  const hiddenCurrent = meta.hiddenPages.includes(currentPage);
  const toggleHidden = () => {
    if (!session || !presenter) return;
    const next = toggleHiddenPage(
      meta.pageCount,
      meta.hiddenPages,
      currentPage,
    );
    if (next === null) {
      setNotice("classroomTools.files.present.lastPage");
      return;
    }
    try {
      session.authority.setHiddenPages(next);
    } catch (error) {
      setNotice(pdfAnnotationErrorKey(error));
    }
  };
  const toggleLock = () => {
    if (!session || !presenter) return;
    try {
      session.authority.setFollowLock(!meta.followLock);
    } catch (error) {
      setNotice(pdfAnnotationErrorKey(error));
    }
  };
  const clearPage = () => {
    if (!session || !presenter) return;
    try {
      session.authority.clearPageStrokes(currentPage);
    } catch (error) {
      setNotice(pdfAnnotationErrorKey(error));
    }
  };

  // ---- View state (page / zoom per presentation, RAM only) ------------
  const [view, setView] = useState<ClassroomFilesViewState | null>(() => {
    if (!document) return null;
    const saved = filesSession.readPresentationView(presentation.id);
    return {
      document: {
        activeContent: document.active_content,
        displayName: document.display_name,
        fileID: document.file_id,
        firstPageAspect: document.first_page_aspect,
        mediaType: document.media_type,
        pageCount: document.page_count,
        versionID: presentation.version_id,
      },
      fitMode: saved?.fitMode ?? "width",
      page: saved?.page ?? 1,
      zoom: saved?.zoom ?? 1,
    };
  });
  // The document metadata may arrive later (e.g. a refetch after a 404).
  if (view === null && document) {
    setView({
      document: {
        activeContent: document.active_content,
        displayName: document.display_name,
        fileID: document.file_id,
        firstPageAspect: document.first_page_aspect,
        mediaType: document.media_type,
        pageCount: document.page_count,
        versionID: presentation.version_id,
      },
      fitMode: "width",
      page: 1,
      zoom: 1,
    });
  }
  const presentationID = presentation.id;
  const saveView = useCallback(
    (next: ClassroomFilesViewState) =>
      filesSession.savePresentationView({
        fitMode: next.fitMode,
        page: next.page,
        presentationID,
        zoom: next.zoom,
      }),
    [filesSession, presentationID],
  );
  const noopLoaded = useCallback(() => undefined, []);

  const followKeyVisible = !presenter && session !== null;
  const returnVisible = followKeyVisible && !follow.following && !locked;
  const overlay = (
    <>
      {offered.length > 0 ? (
        <PdfInkToolbar
          capability={capability}
          currentPage={currentPage}
          onClearPage={presenter ? clearPage : undefined}
          onRedo={redo}
          onTone={(tone) =>
            setTones((current) =>
              effectiveTool === "highlighter"
                ? { ...current, highlighter: tone }
                : { ...current, pen: tone },
            )
          }
          onTool={setTool}
          onUndo={undo}
          onWidth={setWidth}
          session={session}
          settings={settings}
        />
      ) : null}
      {returnVisible ? (
        <Button
          className="classroom-files-return"
          leadingIcon={<LocateFixed />}
          onClick={() => sendFollow({ type: "follow" })}
          size="sm"
        >
          {t("classroomTools.files.present.returnToPresenter", {
            page: meta.presenterPage,
          })}
        </Button>
      ) : null}
      {notice ? (
        <div
          className="classroom-files-toast classroom-files-toast--error classroom-files-ink-notice"
          role="alert"
        >
          <p>{t(notice)}</p>
          <IconButton
            label={t("classroomTools.files.ink.dismiss")}
            onClick={() => setNotice(null)}
            size="sm"
            variant="quiet"
          >
            <X />
          </IconButton>
        </div>
      ) : null}
    </>
  );

  const adapter: DocumentViewerPresentation = {
    chatPageRequest: session && (!presenter || synced) ? chatPageRequest : null,
    inkForExport: live.connection === "connected" ? session?.ink : undefined,
    drawSnippetAnnotations: session ? drawSnippetAnnotations : undefined,
    hasAnnotations,
    hiddenPages: meta.hiddenPages,
    menuItems: presenter ? (
      <MenuItem onSelect={toggleHidden}>
        {hiddenCurrent ? (
          <Eye aria-hidden="true" />
        ) : (
          <EyeOff aria-hidden="true" />
        )}
        {hiddenCurrent
          ? t("classroomTools.files.present.showPage", { page: currentPage })
          : t("classroomTools.files.present.hidePage", { page: currentPage })}
      </MenuItem>
    ) : undefined,
    navigationLocked: locked,
    onCurrentPageChange: setCurrentPage,
    onManualNavigation: () => sendFollow({ type: "manual" }),
    onScrollRequestApplied: setAppliedSeq,
    overlay,
    renderPageOverlay,
    scrollRequest,
    showHiddenPages: presenter,
  };

  const status = presenter
    ? t("classroomTools.files.present.statusPresenter", {
        page: meta.presenterPage,
      })
    : locked
      ? t("classroomTools.files.present.statusLocked")
      : capability === "edit"
        ? t("classroomTools.files.present.statusEditor")
        : t("classroomTools.files.present.statusViewer");

  return (
    <div
      className="classroom-files-presentation"
      data-capability={capability}
      onKeyDown={handleKeyDown}
    >
      <div
        aria-label={t("classroomTools.files.present.liveBar")}
        className="classroom-files-live-bar"
        data-capability={capability}
        role="group"
      >
        <span className="classroom-files-live-bar__status">
          <MonitorPlay aria-hidden="true" />
          <span>{status}</span>
        </span>
        <span className="classroom-files-live-bar__actions">
          {live.connection !== "connected" && !live.failed ? (
            <span className="classroom-files-live-bar__sync" role="status">
              {t("classroomTools.files.present.connecting")}
            </span>
          ) : null}
          {live.failed ? (
            <Button
              className="classroom-files-live-bar__retry"
              leadingIcon={<RefreshCw />}
              onClick={live.retry}
              size="sm"
              variant="secondary"
            >
              {t("classroomTools.files.present.retry")}
            </Button>
          ) : null}
          {followKeyVisible ? (
            <button
              aria-pressed={follow.following}
              className="classroom-files-live-toggle"
              disabled={locked}
              onClick={() =>
                sendFollow(
                  follow.following ? { type: "unfollow" } : { type: "follow" },
                )
              }
              type="button"
            >
              <LocateFixed aria-hidden="true" />
              {t("classroomTools.files.present.follow")}
            </button>
          ) : null}
          {presenter && session ? (
            <>
              <button
                aria-pressed={meta.followLock}
                className="classroom-files-live-toggle"
                onClick={toggleLock}
                type="button"
              >
                {meta.followLock ? (
                  <Lock aria-hidden="true" />
                ) : (
                  <LockOpen aria-hidden="true" />
                )}
                {t("classroomTools.files.present.followLock")}
              </button>
              <button
                className="classroom-files-live-toggle"
                data-hidden={hiddenCurrent || undefined}
                onClick={toggleHidden}
                type="button"
              >
                {hiddenCurrent ? (
                  <Eye aria-hidden="true" />
                ) : (
                  <EyeOff aria-hidden="true" />
                )}
                {hiddenCurrent
                  ? t("classroomTools.files.present.showPage", {
                      page: currentPage,
                    })
                  : t("classroomTools.files.present.hidePage", {
                      page: currentPage,
                    })}
              </button>
            </>
          ) : null}
          {presentation.viewer_capabilities.can_suspend ||
          presentation.viewer_capabilities.can_close ? (
            <PresentationLifecycleMenu
              canClose={presentation.viewer_capabilities.can_close}
              canSuspend={presentation.viewer_capabilities.can_suspend}
              onTransition={onTransition}
              pending={transitionPending}
            />
          ) : null}
        </span>
      </div>
      <p
        aria-atomic="true"
        aria-live="polite"
        className="classroom-files-sr-only"
        role="status"
      >
        {announcement}
      </p>
      <div className="classroom-files-presentation__viewer">
        {view ? (
          <DocumentLoader
            actorID={actorID}
            activePresentation={presentation}
            canDownloadOriginal={canDownloadOriginal}
            expectedVersionID={presentation.version_id}
            headerSlot={headerSlot}
            key={`${presentation.id}:${presentation.version_id}`}
            libraryOpen={libraryOpen}
            mediaSpaceID={mediaSpaceID}
            onDownloadOriginal={onDownloadOriginal}
            onLoaded={noopLoaded}
            onOpenLibrary={onOpenLibrary}
            onViewChange={saveView}
            presentation={adapter}
            session={filesSession}
            tenantID={tenantID}
            view={view}
            whiteboard={whiteboard}
          />
        ) : null}
      </div>
    </div>
  );
}

export function PresentationLifecycleMenu({
  canClose,
  canResume = false,
  canSuspend,
  onTransition,
  pending,
}: {
  readonly canClose: boolean;
  readonly canResume?: boolean;
  readonly canSuspend: boolean;
  readonly onTransition: (operation: PdfPresentationOperation) => void;
  readonly pending: boolean;
}) {
  const { t } = useI18n();
  return (
    <Menu modal={false}>
      <MenuTrigger asChild>
        <Button
          className="classroom-files-live-bar__menu"
          disabled={pending}
          leadingIcon={<MonitorPlay />}
          size="sm"
          variant="secondary"
        >
          {t("classroomTools.files.present.controls")}
        </Button>
      </MenuTrigger>
      <MenuContent
        align="end"
        aria-label={t("classroomTools.files.present.controls")}
        className="classroom-files-menu"
        data-theme="dark"
        sideOffset={8}
      >
        {canSuspend ? (
          <MenuItem disabled={pending} onSelect={() => onTransition("suspend")}>
            <Pause aria-hidden="true" />
            {t("classroomTools.files.present.suspend")}
          </MenuItem>
        ) : null}
        {canResume ? (
          <MenuItem disabled={pending} onSelect={() => onTransition("resume")}>
            <MonitorPlay aria-hidden="true" />
            {t("classroomTools.files.present.resume")}
          </MenuItem>
        ) : null}
        {canClose ? (
          <MenuItem
            disabled={pending}
            onSelect={() => onTransition("close")}
            tone="danger"
          >
            <Square aria-hidden="true" />
            {t("classroomTools.files.present.close")}
          </MenuItem>
        ) : null}
      </MenuContent>
    </Menu>
  );
}
