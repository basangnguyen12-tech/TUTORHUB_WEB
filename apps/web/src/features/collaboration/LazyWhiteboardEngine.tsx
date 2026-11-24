import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import {
  createBrowserCollaborationSession,
  excalidrawSceneToCanonical,
  semanticHash,
  type BrowserCollaborationSession,
  type CanonicalExcalidrawAuthority,
  type CanonicalElementV1,
  type CollaborationConnectionStatus,
} from "@tutorhub/collaboration-client";
import type {
  WhiteboardCapability,
  WhiteboardDocument,
} from "@tutorhub/api-client";
import { Button } from "@tutorhub/ui";
import { FileText } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../app/i18n";
import { requestWhiteboardGrant } from "../../app/whiteboards";
import {
  adaptInkForSurface,
  isDarkPaperSurface,
  readPaperSelection,
  resolvePaperBaseColor,
  type WhiteboardPaperSelection,
} from "./whiteboardPaper";
import {
  WhiteboardPaperBackdrop,
  type WhiteboardPaperBackdropHandle,
} from "./WhiteboardPaperBackdrop";
import { WhiteboardPaperPicker } from "./WhiteboardPaperPicker";

/**
 * Excalidraw draws on a transparent canvas above the TutorHub paper backdrop;
 * the canonical page keeps the real opaque `backgroundColor`.
 */
const EXCALIDRAW_TRANSPARENT_BACKGROUND = "transparent";
const EXCALIDRAW_UI_OPTIONS = {
  canvasActions: { changeViewBackgroundColor: false, toggleTheme: false },
} as const;

export default function LazyWhiteboardEngine({
  actorID,
  capability,
  classroom = false,
  document,
  onRecoveryRequired,
  tenantID,
  toolbarSlot = null,
}: {
  actorID: string;
  capability: WhiteboardCapability;
  /** ROOM-COMPACT-05: see `CanonicalExcalidrawCanvas`. */
  classroom?: boolean;
  document: WhiteboardDocument;
  onRecoveryRequired?: () => void;
  tenantID: string;
  toolbarSlot?: HTMLElement | null;
}) {
  const { t } = useI18n();
  const [attempt, setAttempt] = useState(0);
  const [connectionStatus, setConnectionStatus] =
    useState<CollaborationConnectionStatus>("connecting");
  const [error, setError] = useState(false);
  const [session, setSession] = useState<BrowserCollaborationSession | null>(
    null,
  );
  // The control-plane query and the room page re-render often (signal clock,
  // refetch-on-focus) and hand us fresh `document` objects and callbacks with
  // identical authority. Keep the latest values in refs so the session effect
  // depends only on the authority fence; otherwise every re-render would tear
  // down the live socket and burst `POST …/grant-exchanges` into a 429.
  const documentRef = useRef(document);
  const onRecoveryRequiredRef = useRef(onRecoveryRequired);
  useLayoutEffect(() => {
    documentRef.current = document;
    onRecoveryRequiredRef.current = onRecoveryRequired;
  });
  const documentID = document.id;
  const currentGeneration = document.current_generation;
  const revokeGeneration = document.revoke_generation;

  useEffect(() => {
    const abortController = new AbortController();
    let activeSession: BrowserCollaborationSession | null = null;
    const fencedDocument: WhiteboardDocument = {
      ...documentRef.current,
      current_generation: currentGeneration,
      id: documentID,
      revoke_generation: revokeGeneration,
    };
    void requestWhiteboardGrant(
      tenantID,
      fencedDocument,
      capability,
      abortController.signal,
    )
      .then((grant) =>
        createBrowserCollaborationSession({
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
          onStatus: setConnectionStatus,
          onTerminal: (reason) => {
            setError(true);
            if (reason === "authority_changed") {
              onRecoveryRequiredRef.current?.();
            }
          },
          tenantId: tenantID,
        }),
      )
      .then((created) => {
        if (abortController.signal.aborted) {
          created.destroy();
          return;
        }
        activeSession = created;
        setSession(created);
      })
      .catch(() => {
        if (!abortController.signal.aborted) setError(true);
      });
    return () => {
      abortController.abort();
      activeSession?.destroy();
    };
  }, [
    actorID,
    attempt,
    capability,
    currentGeneration,
    documentID,
    revokeGeneration,
    tenantID,
  ]);

  if (error) {
    return (
      <div className="whiteboard-tool-state" role="alert">
        <p>{t("whiteboard.engineError")}</p>
        <Button
          onClick={() => {
            setError(false);
            setSession(null);
            setConnectionStatus("connecting");
            setAttempt((value) => value + 1);
          }}
          variant="secondary"
        >
          {t("whiteboard.retry")}
        </Button>
      </div>
    );
  }
  if (session === null) {
    return (
      <div className="whiteboard-tool-state" role="status">
        <p>{t(`whiteboard.connection.${connectionStatus}`)}</p>
      </div>
    );
  }
  return (
    <CanonicalExcalidrawCanvas
      authority={session.authority}
      classroom={classroom}
      connectionStatus={connectionStatus}
      readOnly={session.capability === "view"}
      toolbarSlot={toolbarSlot}
    />
  );
}

const SEMANTIC_PAGE_SIZE = 50;

export type WhiteboardCanvasAuthority = Pick<
  CanonicalExcalidrawAuthority,
  | "getProjection"
  | "getScene"
  | "getSemanticHash"
  | "redo"
  | "replaceScene"
  | "subscribe"
  | "undo"
>;

/**
 * `classroom` (ROOM-COMPACT-05): inside the classroom stage the canvas drops
 * its own bar — no visible connection line and no "read as text" key — so
 * the paper fills the stage. The paper picker is portalled into
 * `toolbarSlot` (the room Top Bar) once it exists; the connection state stays
 * a polite live region for assistive technology, and the text alternative
 * stays in the DOM (keyboard focus entering it still opens it).
 */
export function CanonicalExcalidrawCanvas({
  authority,
  classroom = false,
  connectionStatus,
  readOnly,
  toolbarSlot = null,
}: {
  authority: WhiteboardCanvasAuthority;
  classroom?: boolean;
  connectionStatus: CollaborationConnectionStatus;
  readOnly: boolean;
  toolbarSlot?: HTMLElement | null;
}) {
  const { t } = useI18n();
  const [api, setAPI] = useState<ExcalidrawImperativeAPI | null>(null);
  const [semanticRevision, setSemanticRevision] = useState(0);
  const [semanticOpen, setSemanticOpen] = useState(false);
  const applyingRemoteRef = useRef(false);
  const backdropHandleRef = useRef<WhiteboardPaperBackdropHandle>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const semanticHeadingRef = useRef<HTMLHeadingElement>(null);
  const semanticTriggerRef = useRef<HTMLButtonElement>(null);
  const semanticDescriptionID = useId();
  const semanticPanelID = useId();
  const initialProjection = useMemo(
    () => authority.getProjection(),
    [authority],
  );
  const [paper, setPaper] = useState<WhiteboardPaperSelection>(() =>
    readPaperSelection(authority.getScene().page),
  );
  const darkSurface = isDarkPaperSurface(paper.mode, paper.dark);
  // Excalidraw's default ink (#1e1e1e) targets light paper.
  const inkSurfaceDarkRef = useRef(false);

  // Paper follows the canonical page for every role, including students who
  // never write: a teacher's change arrives through the same subscription.
  useEffect(() => {
    const sync = (page: Parameters<typeof readPaperSelection>[0]) => {
      const next = readPaperSelection(page);
      setPaper((current) =>
        current.mode === next.mode && current.dark === next.dark
          ? current
          : next,
      );
    };
    sync(authority.getScene().page);
    return authority.subscribe((scene) => sync(scene.page));
  }, [authority]);

  const changePaper = useCallback(
    (next: WhiteboardPaperSelection) => {
      if (readOnly) return;
      const scene = authority.getScene();
      authority.replaceScene({
        ...scene,
        page: {
          ...scene.page,
          backgroundColor: resolvePaperBaseColor(next.mode, next.dark),
          paperDark: next.dark,
          paperMode: next.mode,
        },
      });
      setPaper(next);
    },
    [authority, readOnly],
  );

  // Smart ink: when the surface flips light ↔ dark, retarget the *next*
  // stroke colour (default ink ↔ chalk). Existing elements are never touched.
  useEffect(() => {
    if (api === null || readOnly) return;
    if (inkSurfaceDarkRef.current === darkSurface) return;
    inkSurfaceDarkRef.current = darkSurface;
    const nextInk = adaptInkForSurface(
      api.getAppState().currentItemStrokeColor,
      darkSurface,
    );
    if (nextInk !== null) {
      api.updateScene({ appState: { currentItemStrokeColor: nextInk } });
    }
  }, [api, darkSurface, readOnly]);

  // Anchor the paper to Excalidraw's initial viewport once the API is ready;
  // later pans/zooms arrive through `onScrollChange` without React renders.
  useEffect(() => {
    if (api === null) return;
    const { scrollX, scrollY, zoom } = api.getAppState();
    backdropHandleRef.current?.setViewport({
      scrollX,
      scrollY,
      zoom: zoom.value,
    });
  }, [api]);

  useEffect(() => {
    const root = canvasRef.current;
    if (root === null) return;
    const normalizeExcalidrawSemantics = () => {
      const menuTrigger =
        root.querySelector<HTMLButtonElement>(".main-menu-trigger");
      if (menuTrigger && !menuTrigger.getAttribute("aria-label")) {
        menuTrigger.setAttribute("aria-label", t("whiteboard.menu"));
      }
      root.querySelectorAll("footer").forEach((footer) => {
        footer.setAttribute("aria-label", t("whiteboard.footerControls"));
        footer.setAttribute("role", "group");
      });
    };
    normalizeExcalidrawSemantics();
    const observer = new MutationObserver(normalizeExcalidrawSemantics);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [t]);

  useEffect(() => {
    if (api === null) return;
    const applyAuthority = () => {
      const projection = authority.getProjection();
      // Excalidraw always runs with a transparent background; compare against
      // the canonical page colour, never the runtime "transparent".
      const current = excalidrawSceneToCanonical({
        appState: {
          viewBackgroundColor: projection.appState.viewBackgroundColor,
        },
        elements: api
          .getSceneElements()
          .filter((element) => !element.isDeleted),
        files: api.getFiles(),
        page: projection.page,
      });
      if (semanticHash(current) === authority.getSemanticHash()) {
        api.history.clear();
        return;
      }
      applyingRemoteRef.current = true;
      api.addFiles(
        Object.values(projection.files) as unknown as Parameters<
          ExcalidrawImperativeAPI["addFiles"]
        >[0],
      );
      api.updateScene({
        appState: {
          viewBackgroundColor: EXCALIDRAW_TRANSPARENT_BACKGROUND,
        },
        elements:
          projection.elements as unknown as readonly ExcalidrawElement[],
      });
      api.history.clear();
      setSemanticRevision((value) => value + 1);
      requestAnimationFrame(() => {
        applyingRemoteRef.current = false;
        api.history.clear();
      });
    };
    applyAuthority();
    return authority.subscribe(applyAuthority);
  }, [api, authority]);

  useEffect(() => {
    if (readOnly) return;
    const handleUndo = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.shiftKey) authority.redo();
        else authority.undo();
      }
    };
    window.addEventListener("keydown", handleUndo, true);
    return () => window.removeEventListener("keydown", handleUndo, true);
  }, [authority, readOnly]);

  const semanticScene = authority.getScene();
  const connectionText = `${t(`whiteboard.connection.${connectionStatus}`)}${
    readOnly ? ` · ${t("whiteboard.readOnly")}` : ""
  }`;
  const paperPicker = (
    <WhiteboardPaperPicker
      onChange={changePaper}
      paper={paper}
      readOnly={readOnly}
    />
  );
  return (
    <div
      className={`whiteboard-engine${
        classroom ? " whiteboard-engine--classroom" : ""
      }`}
    >
      {classroom ? (
        <>
          <p
            aria-live="polite"
            className="whiteboard-connection-status whiteboard-sr-only"
            role="status"
          >
            {connectionText}
          </p>
          {toolbarSlot ? createPortal(paperPicker, toolbarSlot) : null}
        </>
      ) : (
        <div className="whiteboard-engine-bar">
          <p
            aria-live="polite"
            className="whiteboard-connection-status"
            role="status"
          >
            {connectionText}
          </p>
          <div className="whiteboard-semantic-actions">
            {paperPicker}
            {/*
              ROOM-MEET-DOCK-04: inside the classroom stylesheet this becomes
              a 32px icon key; the label stays its name and its room tooltip.
            */}
            <Button
              aria-controls={semanticPanelID}
              aria-expanded={semanticOpen}
              className="whiteboard-action"
              data-tooltip={t("whiteboard.readSemantic")}
              leadingIcon={<FileText />}
              onClick={() => {
                setSemanticOpen(true);
                semanticHeadingRef.current?.focus();
              }}
              ref={semanticTriggerRef}
              size="sm"
              variant="secondary"
            >
              <span className="whiteboard-action-label">
                {t("whiteboard.readSemantic")}
              </span>
            </Button>
          </div>
        </div>
      )}
      <div
        aria-describedby={semanticDescriptionID}
        aria-label={t("whiteboard.canvasLabel")}
        className="whiteboard-engine-canvas"
        data-paper-mode={paper.mode}
        data-paper-surface={darkSurface ? "dark" : "light"}
        ref={canvasRef}
        role="region"
        tabIndex={-1}
      >
        <WhiteboardPaperBackdrop
          dark={paper.dark}
          mode={paper.mode}
          viewportRef={backdropHandleRef}
        />
        <Excalidraw
          UIOptions={EXCALIDRAW_UI_OPTIONS}
          excalidrawAPI={setAPI}
          initialData={{
            appState: {
              viewBackgroundColor: EXCALIDRAW_TRANSPARENT_BACKGROUND,
            },
            elements:
              initialProjection.elements as unknown as readonly ExcalidrawElement[],
            scrollToContent: true,
          }}
          isCollaborating
          onChange={(elements, appState, files) => {
            if (
              api !== null &&
              appState.viewBackgroundColor !== EXCALIDRAW_TRANSPARENT_BACKGROUND
            ) {
              // e.g. a scene opened from a file: keep the paper visible.
              api.updateScene({
                appState: {
                  viewBackgroundColor: EXCALIDRAW_TRANSPARENT_BACKGROUND,
                },
              });
            }
            if (readOnly || applyingRemoteRef.current) return;
            const projection = authority.getProjection();
            const canonical = excalidrawSceneToCanonical({
              appState: {
                viewBackgroundColor: projection.appState.viewBackgroundColor,
              },
              elements: elements.filter((element) => !element.isDeleted),
              files,
              page: projection.page,
            });
            if (semanticHash(canonical) !== authority.getSemanticHash()) {
              authority.replaceScene(canonical);
              api?.history.clear();
              setSemanticRevision((value) => value + 1);
            }
          }}
          onScrollChange={(scrollX, scrollY, zoom) => {
            backdropHandleRef.current?.setViewport({
              scrollX,
              scrollY,
              zoom: zoom.value,
            });
          }}
          theme="light"
          viewModeEnabled={readOnly}
        />
      </div>
      <WhiteboardSemanticFallback
        canvasRef={canvasRef}
        descriptionID={semanticDescriptionID}
        elements={semanticScene.elements}
        headingRef={semanticHeadingRef}
        id={semanticPanelID}
        onClose={() => {
          setSemanticOpen(false);
          // Classroom mode has no trigger key: hand focus back to the canvas.
          (semanticTriggerRef.current ?? canvasRef.current)?.focus();
        }}
        onFocusCanvas={() => setSemanticOpen(false)}
        onOpen={() => setSemanticOpen(true)}
        open={semanticOpen}
        revision={semanticRevision}
      />
    </div>
  );
}

/**
 * Text alternative for the canvas. It is always in the DOM (it backs the
 * canvas `aria-describedby` and receives focus synchronously), but stays
 * visually collapsed until opened — explicitly, or implicitly when keyboard
 * focus enters it — so the drawing surface keeps the full stage.
 */
export function WhiteboardSemanticFallback({
  canvasRef,
  descriptionID,
  elements,
  headingRef,
  id,
  onClose,
  onFocusCanvas,
  onOpen,
  open = true,
  revision,
}: {
  canvasRef: RefObject<HTMLDivElement | null>;
  descriptionID: string;
  elements: CanonicalElementV1[];
  headingRef: RefObject<HTMLHeadingElement | null>;
  id?: string;
  onClose?: () => void;
  onFocusCanvas?: () => void;
  onOpen?: () => void;
  open?: boolean;
  revision: number;
}) {
  const { t } = useI18n();
  const [pageIndex, setPageIndex] = useState(0);
  const pageCount = Math.max(
    1,
    Math.ceil(elements.length / SEMANTIC_PAGE_SIZE),
  );
  const activePageIndex = Math.min(pageIndex, pageCount - 1);
  const visibleElements = useMemo(
    () =>
      elements.slice(
        activePageIndex * SEMANTIC_PAGE_SIZE,
        (activePageIndex + 1) * SEMANTIC_PAGE_SIZE,
      ),
    [activePageIndex, elements],
  );

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || !open || !onClose) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  return (
    <section
      aria-labelledby="whiteboard-semantic-title"
      className={`whiteboard-semantic-fallback ${
        open
          ? "whiteboard-semantic-fallback--open"
          : "whiteboard-semantic-fallback--collapsed"
      }`}
      data-semantic-revision={revision}
      data-testid="whiteboard-semantic-fallback"
      id={id}
      onFocus={() => {
        if (!open) onOpen?.();
      }}
      onKeyDown={handleKeyDown}
    >
      <div className="whiteboard-semantic-header">
        <h3 id="whiteboard-semantic-title" ref={headingRef} tabIndex={-1}>
          {t("whiteboard.semanticTitle")}
        </h3>
        {onClose ? (
          <Button onClick={onClose} size="sm" variant="quiet">
            {t("whiteboard.semanticClose")}
          </Button>
        ) : null}
      </div>
      <p id={descriptionID}>{t("whiteboard.semanticDescription")}</p>
      <p
        aria-atomic="true"
        aria-live="polite"
        data-testid="whiteboard-semantic-page"
      >
        {t("whiteboard.semanticPage")} {activePageIndex + 1}/{pageCount} ·{" "}
        {elements.length} {t("whiteboard.semanticElements")}
      </p>
      <div
        aria-label={t("whiteboard.semanticNavigation")}
        className="whiteboard-semantic-navigation"
        role="group"
      >
        <Button
          disabled={activePageIndex === 0}
          onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
          variant="secondary"
        >
          {t("whiteboard.semanticPrevious")}
        </Button>
        <Button
          disabled={activePageIndex >= pageCount - 1}
          onClick={() =>
            setPageIndex((current) => Math.min(pageCount - 1, current + 1))
          }
          variant="secondary"
        >
          {t("whiteboard.semanticNext")}
        </Button>
        <Button
          onClick={() => {
            onFocusCanvas?.();
            canvasRef.current?.focus();
          }}
          variant="secondary"
        >
          {t("whiteboard.focusCanvas")}
        </Button>
      </div>
      {visibleElements.length === 0 ? (
        <p>{t("whiteboard.semanticEmpty")}</p>
      ) : (
        <ol
          className="whiteboard-semantic-list"
          start={activePageIndex * SEMANTIC_PAGE_SIZE + 1}
        >
          {visibleElements.map((element) => (
            <li key={element.id}>
              {semanticElementLabel(element, t("whiteboard.untitledElement"))}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function semanticElementLabel(element: CanonicalElementV1, fallback: string) {
  const text = typeof element.text === "string" ? element.text.trim() : "";
  const label = text ? truncateSemanticText(text) : fallback;
  return `${element.type}: ${label}; x ${Math.round(Number(element.x))}, y ${Math.round(Number(element.y))}; ${Math.round(Number(element.width))} × ${Math.round(Number(element.height))}`;
}

function truncateSemanticText(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 239)}…`;
}
