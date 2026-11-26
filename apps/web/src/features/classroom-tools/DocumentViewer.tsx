import {
  Button,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from "@tutorhub/ui";
import {
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  Crop,
  FileText,
  Download,
  Maximize2,
  Minus,
  MoreHorizontal,
  PanelLeft,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../app/i18n";
import type { PendingWhiteboardSnippet } from "../collaboration/whiteboardSnippetBridge";
import {
  blobToDataURL,
  domSnippetEncoderHost,
  encodeDocumentSnippet,
} from "./documentSnippet";
import {
  canvasBackingSize,
  classifyPdfLinkTarget,
  clampZoom,
  createRenderScheduler,
  DOCUMENT_VIEWER_LIMITS,
  findDocumentMatches,
  foldSearchText,
  FULL_PAGE_RECT,
  isMobileViewerWidth,
  isUsableCrop,
  liveCanvasLimit,
  maxCanvasPixels,
  mostVisiblePage,
  nextMatchPage,
  nudgeCrop,
  rectFromPoints,
  selectLivePages,
  snippetRenderScale,
  stepZoom,
  ThumbnailUrlCache,
  type DocumentSearchMatch,
  type NormalizedRect,
  type RenderScheduler,
} from "./documentViewerModel";
import type {
  ClassroomFilesFitMode,
  ClassroomFilesViewState,
} from "./filesSession";
import {
  AnnotationMode,
  openPdfDocument,
  readPdfPageText,
  resolvePdfDestination,
  TextLayer,
  type PdfLinkAnnotation,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "./pdfRuntime";

export interface DocumentViewerWhiteboard {
  /** `false` when the viewer can only watch the board (display hint). */
  readonly canEdit?: boolean;
  readonly onSend: (snippet: PendingWhiteboardSnippet) => void;
}

export interface DocumentViewerProps {
  readonly bytes: Uint8Array;
  readonly canDownloadOriginal: boolean;
  readonly headerSlot: HTMLElement | null | undefined;
  readonly libraryOpen: boolean;
  readonly onDownloadOriginal: () => void;
  readonly onOpenLibrary: () => void;
  readonly onViewChange: (view: ClassroomFilesViewState) => void;
  readonly view: ClassroomFilesViewState;
  readonly whiteboard: DocumentViewerWhiteboard | null;
}

interface PageSize {
  readonly height: number;
  readonly width: number;
}

type ImageSource = {
  readonly element: HTMLImageElement;
  readonly height: number;
  readonly url: string;
  readonly width: number;
};

interface LinkSpec {
  readonly display?: string;
  readonly height: number;
  readonly href?: string;
  readonly key: string;
  readonly kind: "external" | "internal" | "mailto";
  readonly left: number;
  readonly page?: number;
  readonly top: number;
  readonly width: number;
}

interface CropState {
  readonly page: number;
  readonly rect: NormalizedRect;
}

type SnippetStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "working" }
  | {
      readonly kind: "error";
      readonly reason: "encode" | "readOnly" | "render" | "tooLarge";
    };

interface SearchState {
  readonly matches: readonly DocumentSearchMatch[];
  readonly noText: boolean;
  readonly scanned: number;
  readonly scanning: boolean;
}

const EMPTY_SEARCH: SearchState = {
  matches: [],
  noText: false,
  scanned: 0,
  scanning: false,
};

const MAX_LINKS_PER_PAGE = 200;
const PAGE_GAP_PX = 12;

function clampAspect(aspect: number): number {
  return Number.isFinite(aspect) && aspect > 0
    ? Math.min(10, Math.max(0.1, aspect))
    : 0.7071;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.closest("input, textarea, select, [contenteditable='true']") !==
        null)
  );
}

function zeroCanvas(canvas: HTMLCanvasElement | null) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * ROOM-TOOLS-FILES-01B / ADR-0045 §3: virtualized, zero-scripting viewer for
 * one verified PDF or image. At most 5 page canvases (2 below 768 px) hold
 * pixels at any time; every other page is a correctly sized placeholder.
 */
export function DocumentViewer({
  bytes,
  canDownloadOriginal,
  headerSlot,
  libraryOpen,
  onDownloadOriginal,
  onOpenLibrary,
  onViewChange,
  view,
  whiteboard,
}: DocumentViewerProps) {
  const { language, t } = useI18n();
  const doc = view.document;
  const isPDF = doc.mediaType === "application/pdf";
  const regionID = useId();
  const searchInputID = useId();
  const cropHintID = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const linkReturnFocusRef = useRef<HTMLElement | null>(null);

  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [image, setImage] = useState<ImageSource | null>(null);
  const [sourceError, setSourceError] = useState(false);
  const [sourceAttempt, setSourceAttempt] = useState(0);
  const [pageSizes, setPageSizes] = useState<ReadonlyMap<number, PageSize>>(
    () => new Map(),
  );
  const [box, setBox] = useState({ height: 0, width: 0 });
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth || 1280,
  );
  const [fitMode, setFitMode] = useState<ClassroomFilesFitMode>(view.fitMode);
  const [zoom, setZoom] = useState(() => clampZoom(view.zoom));
  const pageCount = isPDF ? (pdf?.numPages ?? Math.max(1, doc.pageCount)) : 1;
  const [current, setCurrent] = useState(() =>
    Math.min(Math.max(1, view.page), Math.max(1, doc.pageCount)),
  );
  const [direction, setDirection] = useState<1 | -1>(1);
  const [visible, setVisible] = useState<readonly number[]>([]);
  // What the person is typing in the page box (null: it shows the current
  // page, so scrolling never overwrites an unfinished entry).
  const [pageDraft, setPageDraft] = useState<string | null>(null);
  const [thumbsOpen, setThumbsOpen] = useState<boolean | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [ignoreDiacritics, setIgnoreDiacritics] = useState(true);
  const [search, setSearch] = useState<SearchState>(EMPTY_SEARCH);
  const [crop, setCrop] = useState<CropState | null>(null);
  const [snippet, setSnippet] = useState<SnippetStatus>({ kind: "idle" });
  const [pendingLink, setPendingLink] = useState<LinkSpec | null>(null);
  const [scheduler] = useState<RenderScheduler>(() => createRenderScheduler(2));
  const [thumbnails] = useState(() => new ThumbnailUrlCache());
  const [thumbnailVersion, setThumbnailVersion] = useState(0);
  const bumpThumbnails = useCallback(
    () => setThumbnailVersion((value) => value + 1),
    [],
  );
  const currentRef = useRef(current);
  const liveRef = useRef<ReadonlySet<number>>(new Set());
  const textCacheRef = useRef(new Map<number, string>());
  const ratiosRef = useRef(new Map<number, number>());
  const restoredRef = useRef(false);
  const mobile = isMobileViewerWidth(viewportWidth);
  const showThumbs = isPDF && (thumbsOpen ?? !mobile);

  useLayoutEffect(() => {
    currentRef.current = current;
  }, [current]);

  // Open the verified bytes: pdf.js for PDFs, a local Blob URL for images.
  useEffect(() => {
    let cancelled = false;
    if (isPDF) {
      const task = openPdfDocument(bytes);
      task.promise.then(
        (opened) => {
          if (cancelled) return;
          setSourceError(false);
          setPdf(opened);
          void opened.getPage(1).then(
            (first) => {
              if (cancelled) return;
              const base = first.getViewport({ scale: 1 });
              setPageSizes((previous) =>
                new Map(previous).set(1, {
                  height: base.height,
                  width: base.width,
                }),
              );
            },
            () => undefined,
          );
        },
        () => {
          if (!cancelled) setSourceError(true);
        },
      );
      return () => {
        cancelled = true;
        TextLayer.cleanup();
        void task.destroy();
      };
    }
    const url = URL.createObjectURL(
      new Blob([bytes as Uint8Array<ArrayBuffer>], { type: doc.mediaType }),
    );
    const element = new Image();
    element.decoding = "async";
    element.addEventListener("load", () => {
      if (cancelled) return;
      setSourceError(false);
      setImage({
        element,
        height: element.naturalHeight || 1,
        url,
        width: element.naturalWidth || 1,
      });
    });
    element.addEventListener("error", () => {
      if (!cancelled) setSourceError(true);
    });
    element.src = url;
    return () => {
      cancelled = true;
      element.removeAttribute("src");
      URL.revokeObjectURL(url);
    };
  }, [bytes, doc.mediaType, isPDF, sourceAttempt]);

  // Release every thumbnail URL with the viewer.
  useEffect(() => () => thumbnails.clear(), [thumbnails]);

  // Stage size (fit modes) and window width (5 vs 2 live canvases).
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { height, width } = entry.contentRect;
      setBox((previous) =>
        Math.abs(previous.width - width) < 1 &&
        Math.abs(previous.height - height) < 1
          ? previous
          : { height, width },
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const update = () => setViewportWidth(window.innerWidth || 1280);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const sourceReady = isPDF ? pdf !== null : image !== null;
  const aspectOf = useCallback(
    (page: number) => {
      if (!isPDF && image) return clampAspect(image.width / image.height);
      const size = pageSizes.get(page);
      return clampAspect(size ? size.width / size.height : doc.firstPageAspect);
    },
    [doc.firstPageAspect, image, isPDF, pageSizes],
  );
  const baseWidth = Math.max(160, (box.width || 720) - 32);
  const effectiveZoom =
    fitMode === "width"
      ? 1
      : fitMode === "page"
        ? clampZoom(
            Math.max(
              0.25,
              (((box.height || 600) - 24) * aspectOf(current)) / baseWidth,
            ),
          )
        : zoom;
  const cssWidth = Math.round(baseWidth * effectiveZoom);
  const limit = liveCanvasLimit(viewportWidth);
  const livePages = useMemo(
    () =>
      new Set(
        sourceReady
          ? selectLivePages({ current, direction, limit, pageCount, visible })
          : [],
      ),
    [current, direction, limit, pageCount, sourceReady, visible],
  );
  useLayoutEffect(() => {
    liveRef.current = livePages;
  }, [livePages]);

  const scrollToPage = useCallback(
    (page: number) => {
      const target = Math.min(Math.max(1, page), pageCount);
      const container = scrollRef.current;
      const frame = container?.querySelector<HTMLElement>(
        `[data-page-frame="${target}"]`,
      );
      if (container && frame) {
        container.scrollTop = Math.max(0, frame.offsetTop - PAGE_GAP_PX);
      }
      setDirection(target >= currentRef.current ? 1 : -1);
      setCurrent(target);
    },
    [pageCount],
  );

  // Track the visible pages (IntersectionObserver, clipped by the stage).
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !sourceReady) return undefined;
    if (typeof IntersectionObserver === "undefined") {
      const frame = requestAnimationFrame(() =>
        setVisible([currentRef.current]),
      );
      return () => cancelAnimationFrame(frame);
    }
    const ratios = ratiosRef.current;
    ratios.clear();
    let frame = 0;
    const commit = () => {
      frame = 0;
      const shown = [...ratios]
        .filter(([, ratio]) => ratio > 0)
        .map(([page]) => page)
        .sort((left, right) => left - right);
      setVisible((previous) =>
        previous.length === shown.length &&
        previous.every((page, index) => page === shown[index])
          ? previous
          : shown,
      );
      const next = mostVisiblePage(ratios, currentRef.current);
      if (next !== currentRef.current) {
        setDirection(next > currentRef.current ? 1 : -1);
        setCurrent(next);
      }
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = Number(
            (entry.target as HTMLElement).dataset.pageFrame ?? "0",
          );
          if (page > 0) ratios.set(page, entry.intersectionRatio);
        }
        if (frame === 0) frame = requestAnimationFrame(commit);
      },
      { root: container, threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] },
    );
    container
      .querySelectorAll<HTMLElement>("[data-page-frame]")
      .forEach((element) => observer.observe(element));
    return () => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [pageCount, sourceReady]);

  // Restore the remembered page once the stage has a size, and keep the
  // current page anchored when zoom or the stage width changes.
  const anchoredWidthRef = useRef(0);
  useLayoutEffect(() => {
    if (!sourceReady || box.width === 0) return;
    if (!restoredRef.current) {
      restoredRef.current = true;
      anchoredWidthRef.current = cssWidth;
      if (currentRef.current > 1) scrollToPage(currentRef.current);
      return;
    }
    if (anchoredWidthRef.current !== cssWidth) {
      anchoredWidthRef.current = cssWidth;
      scrollToPage(currentRef.current);
    }
  }, [box.width, cssWidth, scrollToPage, sourceReady]);

  // Remember page / zoom in the room session (RAM only).
  useEffect(() => {
    onViewChange({ document: doc, fitMode, page: current, zoom });
  }, [current, doc, fitMode, onViewChange, zoom]);

  const reportPageSize = useCallback((page: number, size: PageSize) => {
    setPageSizes((previous) => {
      const known = previous.get(page);
      if (
        known &&
        Math.abs(known.width - size.width) < 0.5 &&
        Math.abs(known.height - size.height) < 0.5
      ) {
        return previous;
      }
      return new Map(previous).set(page, size);
    });
  }, []);

  const changeZoom = (next: number) => {
    setFitMode("custom");
    setZoom(clampZoom(next));
  };
  const zoomIn = () => changeZoom(stepZoom(effectiveZoom, 1));
  const zoomOut = () => changeZoom(stepZoom(effectiveZoom, -1));
  const resetZoom = () => {
    setFitMode("width");
    setZoom(1);
  };

  // ---- Search (PDF text, accent-insensitive option) -----------------------
  const needle = useMemo(
    () => foldSearchText(searchQuery, ignoreDiacritics).trim(),
    [ignoreDiacritics, searchQuery],
  );
  useEffect(() => {
    if (!pdf || !searchOpen || needle.length === 0) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const cache = textCacheRef.current;
        setSearch((previous) => ({ ...previous, scanning: true }));
        for (let page = 1; page <= pdf.numPages; page += 1) {
          if (cancelled) return;
          if (cache.has(page)) continue;
          try {
            const proxy = await pdf.getPage(page);
            const text = await readPdfPageText(proxy);
            if (!liveRef.current.has(page)) proxy.cleanup();
            cache.set(page, text);
          } catch {
            cache.set(page, "");
          }
          if (page % 10 === 0 && !cancelled) {
            setSearch((previous) => ({ ...previous, scanned: page }));
          }
        }
        if (cancelled) return;
        const matches = findDocumentMatches(
          cache,
          searchQuery,
          ignoreDiacritics,
        );
        const totalText = [...cache.values()].reduce(
          (sum, text) => sum + text.trim().length,
          0,
        );
        setSearch({
          matches,
          noText: totalText === 0,
          scanned: pdf.numPages,
          scanning: false,
        });
        const first = nextMatchPage(matches, currentRef.current - 1, 1);
        if (first !== null) scrollToPage(first);
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [ignoreDiacritics, needle, pdf, scrollToPage, searchOpen, searchQuery]);
  const totalMatches = search.matches.reduce(
    (sum, match) => sum + match.count,
    0,
  );
  const activeNeedle = searchOpen ? needle : "";

  const openSearch = () => {
    setSearchOpen(true);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
    setSearch(EMPTY_SEARCH);
    scrollRef.current?.focus();
  };

  // ---- Whiteboard snippets -------------------------------------------------
  const sendRegion = async (page: number, rect: NormalizedRect) => {
    if (!whiteboard) return;
    if (whiteboard.canEdit === false) {
      setSnippet({ kind: "error", reason: "readOnly" });
      return;
    }
    setSnippet({ kind: "working" });
    const canvas = await renderRegion(pdf, image, page, rect).catch(() => null);
    if (!canvas) {
      setSnippet({ kind: "error", reason: "render" });
      return;
    }
    const encoded = await encodeDocumentSnippet(canvas, domSnippetEncoderHost);
    zeroCanvas(canvas);
    if (!encoded.ok) {
      setSnippet({ kind: "error", reason: encoded.reason });
      return;
    }
    const dataURL = await blobToDataURL(encoded.blob);
    setSnippet({ kind: "idle" });
    setCrop(null);
    whiteboard.onSend({
      byteLength: encoded.blob.size,
      createdAt: Date.now(),
      dataURL,
      height: encoded.height,
      id: crypto.randomUUID(),
      mimeType: encoded.mimeType,
      pageNumber: isPDF ? page : null,
      sourceName: doc.displayName,
      width: encoded.width,
    });
  };
  const startCrop = () => {
    setSnippet({ kind: "idle" });
    setCrop({
      page: currentRef.current,
      rect: { height: 0.4, width: 0.8, x: 0.1, y: 0.1 },
    });
  };
  const cancelCrop = () => {
    setCrop(null);
    scrollRef.current?.focus();
  };

  // ---- Keyboard ------------------------------------------------------------
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const modifier = event.ctrlKey || event.metaKey;
    if (event.key === "Escape") {
      if (pendingLink) return;
      if (crop) {
        event.preventDefault();
        event.stopPropagation();
        cancelCrop();
        return;
      }
      if (searchOpen) {
        event.preventDefault();
        event.stopPropagation();
        closeSearch();
        return;
      }
      if (mobile && showThumbs) {
        event.preventDefault();
        event.stopPropagation();
        setThumbsOpen(false);
      }
      return;
    }
    if (modifier && event.key.toLowerCase() === "f" && isPDF) {
      event.preventDefault();
      openSearch();
      return;
    }
    if (modifier && (event.key === "+" || event.key === "=")) {
      event.preventDefault();
      zoomIn();
      return;
    }
    if (modifier && (event.key === "-" || event.key === "_")) {
      event.preventDefault();
      zoomOut();
      return;
    }
    if (modifier && event.key === "0") {
      event.preventDefault();
      resetZoom();
      return;
    }
    if (modifier || event.altKey || isEditableTarget(event.target) || crop) {
      return;
    }
    const goto =
      event.key === "PageDown"
        ? currentRef.current + 1
        : event.key === "PageUp"
          ? currentRef.current - 1
          : event.key === "Home"
            ? 1
            : event.key === "End"
              ? pageCount
              : null;
    if (goto !== null) {
      event.preventDefault();
      scrollToPage(goto);
    }
  };

  const commitPageInput = () => {
    if (pageDraft === null) return;
    const parsed = Number.parseInt(pageDraft, 10);
    setPageDraft(null);
    if (Number.isFinite(parsed)) scrollToPage(parsed);
  };

  const percent = new Intl.NumberFormat(language === "vi" ? "vi-VN" : "en-US", {
    maximumFractionDigits: 0,
  }).format(Math.round(effectiveZoom * 100));

  const topBar = (
    <div className="classroom-files-topbar">
      <button
        aria-expanded={libraryOpen}
        aria-label={t("classroomTools.files.viewer.libraryKey", {
          name: doc.displayName,
        })}
        className="classroom-files-topbar__file"
        data-tooltip={t("classroomTools.files.library.title")}
        data-tooltip-side="bottom"
        onClick={onOpenLibrary}
        type="button"
      >
        <FileText aria-hidden="true" />
        <span className="classroom-files-topbar__file-name">
          {doc.displayName}
        </span>
        <ChevronDown aria-hidden="true" />
      </button>
      {isPDF ? (
        <div className="classroom-files-topbar__page">
          <input
            aria-label={t("classroomTools.files.viewer.pageInput", {
              count: pageCount,
            })}
            inputMode="numeric"
            max={pageCount}
            min={1}
            onBlur={commitPageInput}
            onChange={(event) => setPageDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitPageInput();
              } else if (event.key === "Escape" && pageDraft !== null) {
                event.preventDefault();
                setPageDraft(null);
              }
            }}
            type="number"
            value={pageDraft ?? String(current)}
          />
          <span aria-hidden="true">/ {pageCount}</span>
        </div>
      ) : null}
      <div
        aria-label={t("classroomTools.files.viewer.zoomGroup")}
        className="classroom-files-topbar__zoom"
        role="group"
      >
        <IconButton
          data-tooltip={t("classroomTools.files.viewer.zoomOut")}
          data-tooltip-side="bottom"
          label={t("classroomTools.files.viewer.zoomOut")}
          onClick={zoomOut}
          size="sm"
          variant="quiet"
        >
          <Minus />
        </IconButton>
        <output
          aria-label={t("classroomTools.files.viewer.zoomValue", {
            percent,
          })}
          className="classroom-files-topbar__percent"
        >
          {percent}%
        </output>
        <IconButton
          data-tooltip={t("classroomTools.files.viewer.zoomIn")}
          data-tooltip-side="bottom"
          label={t("classroomTools.files.viewer.zoomIn")}
          onClick={zoomIn}
          size="sm"
          variant="quiet"
        >
          <Plus />
        </IconButton>
      </div>
      <select
        aria-label={t("classroomTools.files.viewer.fitMode")}
        className="classroom-files-topbar__fit"
        onChange={(event) => {
          const next = event.target.value as ClassroomFilesFitMode;
          if (next === "custom") setZoom(effectiveZoom);
          setFitMode(next);
        }}
        value={fitMode}
      >
        <option value="width">
          {t("classroomTools.files.viewer.fitWidth")}
        </option>
        <option value="page">{t("classroomTools.files.viewer.fitPage")}</option>
        <option value="custom">
          {t("classroomTools.files.viewer.fitCustom")}
        </option>
      </select>
      {isPDF ? (
        <IconButton
          aria-pressed={searchOpen}
          className="classroom-files-topbar__search"
          data-tooltip={t("classroomTools.files.search.open")}
          data-tooltip-side="bottom"
          label={t("classroomTools.files.search.open")}
          onClick={() => (searchOpen ? closeSearch() : openSearch())}
          size="sm"
          variant="quiet"
        >
          <Search />
        </IconButton>
      ) : null}
      {whiteboard ? (
        <Menu modal={false}>
          <MenuTrigger asChild>
            <Button
              className="classroom-files-topbar__send"
              data-tooltip={t("classroomTools.files.snippet.menu")}
              data-tooltip-side="bottom"
              disabled={snippet.kind === "working"}
              leadingIcon={<ClipboardPaste />}
              size="sm"
              variant="secondary"
            >
              <span className="classroom-files-topbar__send-label">
                {t("classroomTools.files.snippet.menu")}
              </span>
            </Button>
          </MenuTrigger>
          <MenuContent
            align="end"
            aria-label={t("classroomTools.files.snippet.menu")}
            className="classroom-files-menu"
            data-theme="dark"
            sideOffset={8}
          >
            <MenuItem
              onSelect={() =>
                void sendRegion(currentRef.current, FULL_PAGE_RECT)
              }
            >
              <ClipboardPaste aria-hidden="true" />
              {t("classroomTools.files.snippet.sendPage")}
            </MenuItem>
            <MenuItem onSelect={startCrop}>
              <Crop aria-hidden="true" />
              {t("classroomTools.files.snippet.crop")}
            </MenuItem>
          </MenuContent>
        </Menu>
      ) : null}
      <Menu modal={false}>
        <MenuTrigger asChild>
          <IconButton
            data-tooltip={t("classroomTools.files.viewer.more")}
            data-tooltip-side="bottom"
            label={t("classroomTools.files.viewer.more")}
            size="sm"
            variant="quiet"
          >
            <MoreHorizontal />
          </IconButton>
        </MenuTrigger>
        <MenuContent
          align="end"
          aria-label={t("classroomTools.files.viewer.more")}
          className="classroom-files-menu"
          data-theme="dark"
          sideOffset={8}
        >
          {isPDF ? (
            <MenuItem onSelect={() => setThumbsOpen(!showThumbs)}>
              <PanelLeft aria-hidden="true" />
              {showThumbs
                ? t("classroomTools.files.viewer.hideThumbnails")
                : t("classroomTools.files.viewer.showThumbnails")}
            </MenuItem>
          ) : null}
          {/* Zoom stays reachable where the Top Bar hides it (≤ 479 px). */}
          <MenuItem onSelect={zoomIn}>
            <Plus aria-hidden="true" />
            {t("classroomTools.files.viewer.zoomIn")}
          </MenuItem>
          <MenuItem onSelect={zoomOut}>
            <Minus aria-hidden="true" />
            {t("classroomTools.files.viewer.zoomOut")}
          </MenuItem>
          <MenuItem onSelect={resetZoom}>
            <Maximize2 aria-hidden="true" />
            {t("classroomTools.files.viewer.fitWidth")}
          </MenuItem>
          <MenuItem onSelect={onOpenLibrary}>
            <FileText aria-hidden="true" />
            {t("classroomTools.files.library.title")}
          </MenuItem>
          {canDownloadOriginal ? (
            <MenuItem onSelect={onDownloadOriginal}>
              <Download aria-hidden="true" />
              {t("classroomTools.files.library.download")}
            </MenuItem>
          ) : null}
        </MenuContent>
      </Menu>
    </div>
  );

  const regionLabel = isPDF
    ? t("classroomTools.files.viewer.region", {
        count: pageCount,
        name: doc.displayName,
        page: current,
      })
    : t("classroomTools.files.viewer.regionImage", { name: doc.displayName });

  if (sourceError) {
    return (
      <div className="classroom-files-state" role="alert">
        {headerSlot ? createPortal(topBar, headerSlot) : null}
        <p className="classroom-files-state__title">
          {t("classroomTools.files.viewer.parseError")}
        </p>
        <Button
          leadingIcon={<RefreshCw />}
          onClick={() => {
            setSourceError(false);
            setSourceAttempt((value) => value + 1);
          }}
          size="sm"
          variant="secondary"
        >
          {t("state.retry")}
        </Button>
      </div>
    );
  }

  return (
    <div
      className={`classroom-files-viewer${showThumbs ? " classroom-files-viewer--thumbs" : ""}${mobile ? " classroom-files-viewer--mobile" : ""}`}
    >
      {headerSlot === undefined ? (
        <div className="classroom-files-viewer__toolbar">{topBar}</div>
      ) : headerSlot ? (
        createPortal(topBar, headerSlot)
      ) : null}
      {searchOpen ? (
        <div
          className="classroom-files-search"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeSearch();
            }
          }}
          role="search"
        >
          <label className="classroom-files-sr-only" htmlFor={searchInputID}>
            {t("classroomTools.files.search.label")}
          </label>
          <input
            id={searchInputID}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                const next = nextMatchPage(
                  search.matches,
                  currentRef.current,
                  event.shiftKey ? -1 : 1,
                );
                if (next !== null) scrollToPage(next);
              }
            }}
            placeholder={t("classroomTools.files.search.placeholder")}
            ref={searchInputRef}
            type="search"
            value={searchQuery}
          />
          <label className="classroom-files-search__option">
            <input
              checked={ignoreDiacritics}
              onChange={(event) => setIgnoreDiacritics(event.target.checked)}
              type="checkbox"
            />
            {t("classroomTools.files.search.ignoreDiacritics")}
          </label>
          <IconButton
            disabled={search.matches.length === 0}
            label={t("classroomTools.files.search.previous")}
            onClick={() => {
              const next = nextMatchPage(
                search.matches,
                currentRef.current,
                -1,
              );
              if (next !== null) scrollToPage(next);
            }}
            size="sm"
            variant="quiet"
          >
            <ChevronUp />
          </IconButton>
          <IconButton
            disabled={search.matches.length === 0}
            label={t("classroomTools.files.search.next")}
            onClick={() => {
              const next = nextMatchPage(search.matches, currentRef.current, 1);
              if (next !== null) scrollToPage(next);
            }}
            size="sm"
            variant="quiet"
          >
            <ChevronDown />
          </IconButton>
          <p
            aria-live="polite"
            className="classroom-files-search__status"
            role="status"
          >
            {needle.length === 0
              ? ""
              : search.scanning
                ? t("classroomTools.files.search.scanning", {
                    count: pageCount,
                    scanned: search.scanned,
                  })
                : search.noText
                  ? t("classroomTools.files.search.scanned")
                  : search.matches.length === 0
                    ? t("classroomTools.files.search.none")
                    : t("classroomTools.files.search.results", {
                        count: totalMatches,
                        pages: search.matches.length,
                      })}
          </p>
          <IconButton
            label={t("classroomTools.files.search.close")}
            onClick={closeSearch}
            size="sm"
            variant="quiet"
          >
            <X />
          </IconButton>
        </div>
      ) : null}
      <div className="classroom-files-viewer__body">
        {showThumbs && pdf ? (
          <ThumbnailRail
            aspectOf={aspectOf}
            current={current}
            currentRef={currentRef}
            liveRef={liveRef}
            onClose={mobile ? () => setThumbsOpen(false) : undefined}
            onSelect={(page) => {
              scrollToPage(page);
              if (mobile) setThumbsOpen(false);
            }}
            onThumbnail={bumpThumbnails}
            pageCount={pageCount}
            pdf={pdf}
            scheduler={scheduler}
            thumbnails={thumbnails}
            version={thumbnailVersion}
          />
        ) : null}
        <div className="classroom-files-viewer__region">
          {/*
            The scrolling page column is itself the focusable, labelled
            region (WCAG 2.1.1: keyboard users can scroll it; PageUp/Down,
            Home/End, Ctrl/⌘ +/−/0, Ctrl/⌘ F and Escape act on it).
          */}
          <div
            aria-label={regionLabel}
            className="classroom-files-pages"
            id={regionID}
            onKeyDown={handleKeyDown}
            ref={scrollRef}
            role="region"
            tabIndex={0}
          >
            {sourceReady ? (
              Array.from({ length: pageCount }, (_, index) => {
                const page = index + 1;
                const live = livePages.has(page);
                const height = Math.round(cssWidth / aspectOf(page));
                return (
                  <PageFrame
                    height={height}
                    key={page}
                    label={t("classroomTools.files.viewer.page", { page })}
                    page={page}
                    width={cssWidth}
                  >
                    {live && pdf ? (
                      <PdfPageLayers
                        cssWidth={cssWidth}
                        currentRef={currentRef}
                        liveRef={liveRef}
                        maxPixels={maxCanvasPixels(viewportWidth)}
                        needle={activeNeedle}
                        ignoreDiacritics={ignoreDiacritics}
                        onExternalLink={(link, element) => {
                          linkReturnFocusRef.current = element;
                          setPendingLink(link);
                        }}
                        onInternalLink={scrollToPage}
                        onPageSize={reportPageSize}
                        page={page}
                        pdf={pdf}
                        scheduler={scheduler}
                      />
                    ) : live && image ? (
                      <img
                        alt={doc.displayName}
                        className="classroom-files-image"
                        draggable={false}
                        src={image.url}
                      />
                    ) : (
                      <span
                        aria-hidden="true"
                        className="classroom-files-page__placeholder"
                      >
                        {page}
                      </span>
                    )}
                    {crop?.page === page ? (
                      <CropOverlay
                        hintID={cropHintID}
                        onCancel={cancelCrop}
                        onChange={(rect) => setCrop({ page, rect })}
                        onConfirm={() => void sendRegion(page, crop.rect)}
                        rect={crop.rect}
                        working={snippet.kind === "working"}
                      />
                    ) : null}
                  </PageFrame>
                );
              })
            ) : (
              <div className="classroom-files-state" role="status">
                <span
                  aria-hidden="true"
                  className="classroom-code-state__spinner"
                />
                <p>{t("classroomTools.files.viewer.opening")}</p>
              </div>
            )}
          </div>
        </div>
      </div>
      <p className="classroom-files-sr-only" id={cropHintID}>
        {t("classroomTools.files.snippet.cropHint")}
      </p>
      {snippet.kind === "working" ? (
        <p className="classroom-files-toast" role="status">
          {t("classroomTools.files.snippet.working")}
        </p>
      ) : snippet.kind === "error" ? (
        <div
          className="classroom-files-toast classroom-files-toast--error"
          role="alert"
        >
          <p>
            {snippet.reason === "readOnly"
              ? t("classroomTools.files.snippet.readOnly")
              : snippet.reason === "tooLarge"
                ? t("classroomTools.files.snippet.tooLarge")
                : t("classroomTools.files.snippet.failed")}
          </p>
          <IconButton
            label={t("classroomTools.files.snippet.dismiss")}
            onClick={() => setSnippet({ kind: "idle" })}
            size="sm"
            variant="quiet"
          >
            <X />
          </IconButton>
        </div>
      ) : null}
      {pendingLink ? (
        <LinkConfirmDialog
          link={pendingLink}
          onCancel={() => {
            setPendingLink(null);
            linkReturnFocusRef.current?.focus();
          }}
          onConfirm={() => {
            const href = pendingLink.href;
            setPendingLink(null);
            if (href) window.open(href, "_blank", "noopener,noreferrer");
            linkReturnFocusRef.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

function PageFrame({
  children,
  height,
  label,
  page,
  width,
}: {
  children: ReactNode;
  height: number;
  label: string;
  page: number;
  width: number;
}) {
  return (
    <div
      aria-label={label}
      className="classroom-files-page"
      data-page-frame={page}
      role="group"
      style={{ height, width }}
    >
      {children}
    </div>
  );
}

/**
 * One live page: canvas pixels, the selectable text layer (DOM spans,
 * `textContent` only) and the safe link layer. Unmounting it is the
 * eviction: the render task is cancelled, the canvas zeroed and removed,
 * and the page's worker resources released (`page.cleanup()`).
 */
function PdfPageLayers({
  cssWidth,
  currentRef,
  ignoreDiacritics,
  liveRef,
  maxPixels,
  needle,
  onExternalLink,
  onInternalLink,
  onPageSize,
  page,
  pdf,
  scheduler,
}: {
  cssWidth: number;
  currentRef: RefObject<number>;
  ignoreDiacritics: boolean;
  liveRef: RefObject<ReadonlySet<number>>;
  maxPixels: number;
  needle: string;
  onExternalLink: (link: LinkSpec, element: HTMLElement) => void;
  onInternalLink: (page: number) => void;
  onPageSize: (page: number, size: PageSize) => void;
  page: number;
  pdf: PDFDocumentProxy;
  scheduler: RenderScheduler;
}) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"done" | "error" | "pending">("pending");
  const [links, setLinks] = useState<readonly LinkSpec[]>([]);
  const [textVersion, setTextVersion] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const onPageSizeRef = useRef(onPageSize);
  useLayoutEffect(() => {
    onPageSizeRef.current = onPageSize;
  });

  // Eviction: zero the canvas and release the page when this unmounts.
  useEffect(() => {
    const canvas = canvasRef.current;
    const live = liveRef;
    return () => {
      zeroCanvas(canvas);
      void pdf.getPage(page).then(
        (proxy) => {
          if (!live.current.has(page)) proxy.cleanup();
        },
        () => undefined,
      );
    };
  }, [liveRef, page, pdf]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const textContainer = textRef.current;
    if (!canvas || !textContainer) return undefined;
    let cancelled = false;
    let renderTask: ReturnType<PDFPageProxy["render"]> | null = null;
    let textLayer: InstanceType<typeof TextLayer> | null = null;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const cancelJob = scheduler.schedule(
      () => Math.abs(page - currentRef.current),
      async () => {
        if (cancelled) return;
        try {
          const proxy = await pdf.getPage(page);
          if (cancelled) return;
          const base = proxy.getViewport({ scale: 1 });
          onPageSizeRef.current(page, {
            height: base.height,
            width: base.width,
          });
          const scale = cssWidth / base.width;
          const viewport = proxy.getViewport({ scale });
          const backing = canvasBackingSize({
            cssHeight: viewport.height,
            cssWidth: viewport.width,
            devicePixelRatio: window.devicePixelRatio || 1,
            maxPixels,
          });
          canvas.width = backing.width;
          canvas.height = backing.height;
          const sx = backing.width / viewport.width;
          const sy = backing.height / viewport.height;
          renderTask = proxy.render({
            annotationMode: AnnotationMode.ENABLE,
            background: "rgb(255,255,255)",
            canvas,
            transform: sx === 1 && sy === 1 ? undefined : [sx, 0, 0, sy, 0, 0],
            viewport,
          });
          const task = renderTask;
          watchdog = setTimeout(
            () => task.cancel(),
            DOCUMENT_VIEWER_LIMITS.renderWatchdogMs,
          );
          await task.promise;
          clearTimeout(watchdog);
          if (cancelled) return;
          setStatus("done");

          textContainer.replaceChildren();
          textContainer.style.setProperty("--scale-factor", String(scale));
          textLayer = new TextLayer({
            container: textContainer,
            textContentSource: proxy.streamTextContent(),
            viewport,
          });
          await textLayer.render();
          if (cancelled) return;
          setTextVersion((value) => value + 1);

          const annotations = (await proxy.getAnnotations({
            intent: "display",
          })) as PdfLinkAnnotation[];
          if (cancelled) return;
          const next: LinkSpec[] = [];
          for (const annotation of annotations) {
            if (next.length >= MAX_LINKS_PER_PAGE) break;
            if (annotation.subtype !== "Link" || !annotation.rect) continue;
            if (annotation.rect.length < 4) continue;
            const [r1 = 0, r2 = 0, r3 = 0, r4 = 0] = annotation.rect;
            const [x1 = 0, y1 = 0] = base.convertToViewportPoint(
              r1,
              r2,
            ) as number[];
            const [x2 = 0, y2 = 0] = base.convertToViewportPoint(
              r3,
              r4,
            ) as number[];
            const geometry = {
              height: (Math.abs(y2 - y1) / base.height) * 100,
              left: (Math.min(x1, x2) / base.width) * 100,
              top: (Math.min(y1, y2) / base.height) * 100,
              width: (Math.abs(x2 - x1) / base.width) * 100,
            };
            if (geometry.width <= 0 || geometry.height <= 0) continue;
            const key = `${annotation.id ?? next.length}`;
            if (annotation.dest !== undefined && annotation.dest !== null) {
              const target = await resolvePdfDestination(pdf, annotation.dest);
              if (cancelled) return;
              if (target !== null && target >= 1 && target <= pdf.numPages) {
                next.push({ ...geometry, key, kind: "internal", page: target });
              }
              continue;
            }
            const target = classifyPdfLinkTarget(
              annotation.url ?? annotation.unsafeUrl,
            );
            // Blocked schemes get no element at all: nothing to click.
            if (target.kind === "blocked") continue;
            next.push({
              ...geometry,
              display: target.display,
              href: target.href,
              key,
              kind: target.kind,
            });
          }
          setLinks(next);
        } catch {
          clearTimeout(watchdog);
          if (!cancelled) setStatus("error");
        }
      },
    );
    return () => {
      cancelled = true;
      cancelJob();
      clearTimeout(watchdog);
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [attempt, cssWidth, currentRef, maxPixels, page, pdf, scheduler]);

  // Search hits: mark text spans containing the folded query.
  useEffect(() => {
    const container = textRef.current;
    if (!container) return;
    for (const span of container.querySelectorAll("span")) {
      const hit =
        needle.length > 0 &&
        foldSearchText(span.textContent ?? "", ignoreDiacritics).includes(
          needle,
        );
      span.classList.toggle("classroom-files-hit", hit);
    }
  }, [ignoreDiacritics, needle, textVersion]);

  return (
    <>
      <canvas
        aria-hidden="true"
        className="classroom-files-canvas"
        data-pdf-page={page}
        ref={canvasRef}
      />
      <div className="textLayer" ref={textRef} />
      <div className="classroom-files-links">
        {links.map((link) => (
          <button
            aria-label={
              link.kind === "internal"
                ? t("classroomTools.files.links.internal", {
                    page: link.page ?? 1,
                  })
                : link.kind === "mailto"
                  ? t("classroomTools.files.links.mailto", {
                      address: link.display ?? "",
                    })
                  : t("classroomTools.files.links.external", {
                      host: link.display ?? "",
                    })
            }
            className="classroom-files-link"
            data-link-kind={link.kind}
            key={link.key}
            onClick={(event) => {
              if (link.kind === "internal") onInternalLink(link.page ?? 1);
              else onExternalLink(link, event.currentTarget);
            }}
            style={{
              height: `${link.height}%`,
              left: `${link.left}%`,
              top: `${link.top}%`,
              width: `${link.width}%`,
            }}
            type="button"
          />
        ))}
      </div>
      {status === "error" ? (
        <div className="classroom-files-page__error" role="alert">
          <p>{t("classroomTools.files.viewer.pageError")}</p>
          <Button
            leadingIcon={<RefreshCw />}
            onClick={() => {
              setStatus("pending");
              setAttempt((value) => value + 1);
            }}
            size="sm"
            variant="secondary"
          >
            {t("state.retry")}
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** Renders a page region onto a detached canvas (long edge ≤ 1 440 px). */
async function renderRegion(
  pdf: PDFDocumentProxy | null,
  image: ImageSource | null,
  page: number,
  rect: NormalizedRect,
): Promise<HTMLCanvasElement | null> {
  const canvas = document.createElement("canvas");
  if (pdf) {
    const proxy = await pdf.getPage(page);
    const base = proxy.getViewport({ scale: 1 });
    const regionWidth = rect.width * base.width;
    const regionHeight = rect.height * base.height;
    const scale = snippetRenderScale(regionWidth, regionHeight);
    const viewport = proxy.getViewport({
      offsetX: -rect.x * base.width * scale,
      offsetY: -rect.y * base.height * scale,
      scale,
    });
    canvas.width = Math.max(1, Math.round(regionWidth * scale));
    canvas.height = Math.max(1, Math.round(regionHeight * scale));
    await proxy.render({
      annotationMode: AnnotationMode.ENABLE,
      background: "rgb(255,255,255)",
      canvas,
      viewport,
    }).promise;
    return canvas;
  }
  if (image) {
    const sx = rect.x * image.width;
    const sy = rect.y * image.height;
    const sw = Math.max(1, rect.width * image.width);
    const sh = Math.max(1, rect.height * image.height);
    const scale = snippetRenderScale(sw, sh, undefined, 1);
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
      image.element,
      sx,
      sy,
      sw,
      sh,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    return canvas;
  }
  return null;
}

function ThumbnailRail({
  aspectOf,
  current,
  currentRef,
  liveRef,
  onClose,
  onSelect,
  onThumbnail,
  pageCount,
  pdf,
  scheduler,
  thumbnails,
  version,
}: {
  aspectOf: (page: number) => number;
  current: number;
  currentRef: RefObject<number>;
  liveRef: RefObject<ReadonlySet<number>>;
  onClose?: () => void;
  onSelect: (page: number) => void;
  onThumbnail: () => void;
  pageCount: number;
  pdf: PDFDocumentProxy;
  scheduler: RenderScheduler;
  thumbnails: ThumbnailUrlCache;
  version: number;
}) {
  const { t } = useI18n();
  const listRef = useRef<HTMLOListElement>(null);
  const [shown, setShown] = useState<readonly number[]>([]);
  const inFlightRef = useRef(new Set<number>());
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof IntersectionObserver === "undefined") return undefined;
    const ratios = new Map<number, boolean>();
    let frame = 0;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset.thumb ?? 0);
          if (page > 0) ratios.set(page, entry.isIntersecting);
        }
        if (frame === 0) {
          frame = requestAnimationFrame(() => {
            frame = 0;
            setShown(
              [...ratios]
                .filter(([, isShown]) => isShown)
                .map(([page]) => page),
            );
          });
        }
      },
      { root: list },
    );
    list
      .querySelectorAll<HTMLElement>("[data-thumb]")
      .forEach((element) => observer.observe(element));
    return () => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [pageCount]);

  useEffect(() => {
    const queued = new Map<number, () => void>();
    const inFlight = inFlightRef.current;
    for (const page of shown) {
      if (thumbnails.has(page) || inFlightRef.current.has(page)) continue;
      inFlightRef.current.add(page);
      queued.set(
        page,
        scheduler.schedule(
          () => 1_000 + Math.abs(page - currentRef.current),
          async () => {
            queued.delete(page);
            const canvas = document.createElement("canvas");
            try {
              const proxy = await pdf.getPage(page);
              const base = proxy.getViewport({ scale: 1 });
              const viewport = proxy.getViewport({
                scale: DOCUMENT_VIEWER_LIMITS.thumbnailWidthPx / base.width,
              });
              canvas.width = Math.max(1, Math.round(viewport.width));
              canvas.height = Math.max(1, Math.round(viewport.height));
              await proxy.render({
                annotationMode: AnnotationMode.ENABLE,
                background: "rgb(255,255,255)",
                canvas,
                viewport,
              }).promise;
              if (!liveRef.current.has(page)) proxy.cleanup();
              const blob = await new Promise<Blob | null>((resolve) =>
                canvas.toBlob(resolve, "image/png"),
              );
              if (blob && mountedRef.current) {
                thumbnails.set(page, URL.createObjectURL(blob));
                onThumbnail();
              }
            } catch {
              // A failed thumbnail keeps its numbered placeholder.
            } finally {
              zeroCanvas(canvas);
              inFlightRef.current.delete(page);
            }
          },
        ),
      );
    }
    return () => {
      // Jobs that have not started are dropped and may be queued again.
      for (const [page, cancel] of queued) {
        cancel();
        inFlight.delete(page);
      }
    };
  }, [currentRef, liveRef, onThumbnail, pdf, scheduler, shown, thumbnails]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLOListElement>) => {
    const step =
      event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = Math.min(Math.max(1, current + step), pageCount);
    onSelect(next);
    requestAnimationFrame(() =>
      listRef.current
        ?.querySelector<HTMLButtonElement>(`[data-thumb="${next}"] button`)
        ?.focus(),
    );
  };

  return (
    <nav
      aria-label={t("classroomTools.files.viewer.thumbnails")}
      className="classroom-files-thumbs"
      data-version={version}
    >
      {onClose ? (
        <div className="classroom-files-thumbs__header">
          <IconButton
            label={t("classroomTools.files.viewer.hideThumbnails")}
            onClick={onClose}
            size="sm"
            variant="quiet"
          >
            <X />
          </IconButton>
        </div>
      ) : null}
      <ol onKeyDown={handleKeyDown} ref={listRef}>
        {Array.from({ length: pageCount }, (_, index) => {
          const page = index + 1;
          const url = thumbnails.get(page);
          const active = page === current;
          return (
            <li data-thumb={page} key={page}>
              <button
                aria-current={active ? "page" : undefined}
                aria-label={t("classroomTools.files.viewer.page", { page })}
                className="classroom-files-thumb"
                onClick={() => onSelect(page)}
                tabIndex={active ? 0 : -1}
                type="button"
              >
                <span
                  className="classroom-files-thumb__image"
                  style={
                    { aspectRatio: String(aspectOf(page)) } as CSSProperties
                  }
                >
                  {url ? <img alt="" src={url} /> : null}
                </span>
                <span
                  aria-hidden="true"
                  className="classroom-files-thumb__number"
                >
                  {page}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function CropOverlay({
  hintID,
  onCancel,
  onChange,
  onConfirm,
  rect,
  working,
}: {
  hintID: string;
  onCancel: () => void;
  onChange: (rect: NormalizedRect) => void;
  onConfirm: () => void;
  rect: NormalizedRect;
  working: boolean;
}) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const usable = isUsableCrop(rect);

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const point = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - box.left) / Math.max(1, box.width),
      y: (event.clientY - box.top) / Math.max(1, box.height),
    };
  };

  return (
    <div
      aria-describedby={hintID}
      aria-label={t("classroomTools.files.snippet.cropLabel")}
      className="classroom-files-crop"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
          return;
        }
        if (event.key === "Enter" && event.target === event.currentTarget) {
          event.preventDefault();
          if (usable && !working) onConfirm();
          return;
        }
        if (
          event.target === event.currentTarget &&
          (event.key === "ArrowLeft" ||
            event.key === "ArrowRight" ||
            event.key === "ArrowUp" ||
            event.key === "ArrowDown")
        ) {
          event.preventDefault();
          onChange(nudgeCrop(rect, event.key, event.shiftKey));
        }
      }}
      onPointerDown={(event) => {
        if (event.target !== event.currentTarget) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const start = point(event);
        startRef.current = start;
        onChange(rectFromPoints(start, start));
      }}
      onPointerMove={(event) => {
        const start = startRef.current;
        if (!start) return;
        onChange(rectFromPoints(start, point(event)));
      }}
      onPointerUp={(event) => {
        if (!startRef.current) return;
        onChange(rectFromPoints(startRef.current, point(event)));
        startRef.current = null;
      }}
      ref={rootRef}
      role="group"
      tabIndex={0}
    >
      <div
        aria-hidden="true"
        className="classroom-files-crop__box"
        style={{
          height: `${rect.height * 100}%`,
          left: `${rect.x * 100}%`,
          top: `${rect.y * 100}%`,
          width: `${rect.width * 100}%`,
        }}
      />
      <div className="classroom-files-crop__actions">
        <Button
          disabled={!usable || working}
          leadingIcon={<ClipboardPaste />}
          onClick={onConfirm}
          size="sm"
        >
          {t("classroomTools.files.snippet.cropConfirm")}
        </Button>
        <Button onClick={onCancel} size="sm" variant="secondary">
          {t("classroomTools.files.cancel")}
        </Button>
      </div>
    </div>
  );
}

function LinkConfirmDialog({
  link,
  onCancel,
  onConfirm,
}: {
  link: LinkSpec;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const titleID = useId();
  const descriptionID = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
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
          const focusables = Array.from(
            rootRef.current?.querySelectorAll<HTMLElement>("button") ?? [],
          );
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          if (!first || !last) return;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        ref={rootRef}
        role="alertdialog"
      >
        <h3 className="classroom-files-dialog__title" id={titleID}>
          {link.kind === "mailto"
            ? t("classroomTools.files.links.confirmMailTitle")
            : t("classroomTools.files.links.confirmTitle")}
        </h3>
        <div id={descriptionID}>
          <p>
            {link.kind === "mailto"
              ? t("classroomTools.files.links.confirmMailBody")
              : t("classroomTools.files.links.confirmBody")}
          </p>
          <p className="classroom-files-dialog__host" data-testid="link-host">
            {link.display}
          </p>
          {link.kind === "external" ? (
            <p className="classroom-files-dialog__url">{link.href}</p>
          ) : null}
        </div>
        <div className="classroom-files-dialog__actions">
          <Button onClick={onConfirm} size="sm">
            {link.kind === "mailto"
              ? t("classroomTools.files.links.confirmMail")
              : t("classroomTools.files.links.confirmOpen")}
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
