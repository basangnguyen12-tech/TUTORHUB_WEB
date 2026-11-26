import type {
  PdfAnnotationPoint,
  PdfAnnotationTool,
  PdfAnnotationWidth,
  PdfStroke,
} from "@tutorhub/collaboration-client";
import {
  Button,
  IconButton,
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@tutorhub/ui";
import {
  Crosshair,
  Eraser,
  Highlighter,
  MousePointer2,
  PenLine,
  Redo2,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useI18n, type TranslationKey } from "../../app/i18n";
import type { LivePdfSession, PdfLaserMark } from "./livePdfCollaboration";
import {
  hitTestStrokes,
  inkToolsFor,
  inkViewBox,
  isDrawingTool,
  normalizePointer,
  PDF_INK_HIGHLIGHT_OPACITY,
  PDF_INK_TONES,
  pdfAnnotationErrorKey,
  strokeColor,
  strokePathData,
  strokeWidthUnits,
  type PdfInkTool,
} from "./pdfAnnotationModel";

/**
 * ROOM-TOOLS-FILES-02B (ADR-0045 Slice 2): the page-scoped ink layer. One
 * overlay is mounted per *live* page frame only (≤ 5 desktop / ≤ 2 mobile),
 * drawn as SVG in a 1 000-unit, aspect-correct viewBox, so normalized
 * `[0..1]` strokes stay crisp at every zoom without a Yjs write. A stroke is
 * drawn locally while the pointer moves and written once on `pointerup`.
 */
const MAX_DRAFT_POINTS = 4_000;

const EMPTY_STROKES: readonly PdfStroke[] = Object.freeze([]);
const EMPTY_MARKS: readonly PdfLaserMark[] = Object.freeze([]);
const noopSubscribe = () => () => undefined;

export interface PdfInkSettings {
  readonly tool: PdfInkTool;
  readonly tone: number;
  readonly width: PdfAnnotationWidth;
}

export interface PdfAnnotationOverlayProps {
  readonly aspect: number;
  /** Effective capability (a stale or terminal session is `view`). */
  readonly capability?: "view" | "edit" | "present";
  readonly onNotice: (key: TranslationKey) => void;
  /** Ink activity: never changes "Theo dõi GV". */
  readonly onInk?: () => void;
  readonly page: number;
  /** A presenter's roster tone/name for a laser (cosmetic). */
  readonly laserLabel?: (mark: PdfLaserMark) => string;
  readonly session: LivePdfSession | null;
  readonly settings: PdfInkSettings;
}

function useInkStrokes(session: LivePdfSession | null, page: number) {
  const version = useSyncExternalStore(
    session ? session.ink.subscribe : noopSubscribe,
    () => (session ? session.ink.version() : -1),
  );
  void version;
  return session ? session.ink.strokes(page) : EMPTY_STROKES;
}

function useLaserMarks(session: LivePdfSession | null) {
  return useSyncExternalStore(
    session ? session.laser.subscribe : noopSubscribe,
    () => (session ? session.laser.marks() : EMPTY_MARKS),
  );
}

export function PdfAnnotationOverlay({
  aspect,
  capability: capabilityOverride,
  laserLabel,
  onInk,
  onNotice,
  page,
  session,
  settings,
}: PdfAnnotationOverlayProps) {
  const { t } = useI18n();
  const strokes = useInkStrokes(session, page);
  const marks = useLaserMarks(session).filter((mark) => mark.page === page);
  const capability = session
    ? (capabilityOverride ?? session.capability)
    : "view";
  const tool = settings.tool;
  const drawing = capability !== "view" && isDrawingTool(tool);
  const lasering = capability === "present" && tool === "laser";
  const interactive = drawing || lasering;
  const box = inkViewBox(aspect);
  const rootRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<{
    points: PdfAnnotationPoint[];
    pointerId: number;
    pointerType: string;
  } | null>(null);
  const erasingRef = useRef<{ noticed: boolean; pointerId: number } | null>(
    null,
  );
  const penDownRef = useRef(false);
  const frameRef = useRef(0);
  const [draft, setDraft] = useState<string | null>(null);
  const [ownLaser, setOwnLaser] = useState<PdfAnnotationPoint | null>(null);

  useEffect(
    () => () => {
      if (frameRef.current !== 0) cancelAnimationFrame(frameRef.current);
    },
    [],
  );
  // Leaving the laser tool (or the page unmounting) clears our laser.
  useEffect(() => {
    if (!lasering) return undefined;
    return () => {
      session?.publishLaser(null);
      setOwnLaser(null);
    };
  }, [lasering, session]);

  const pointOf = (event: ReactPointerEvent<HTMLElement>) =>
    normalizePointer(
      event.clientX,
      event.clientY,
      event.currentTarget.getBoundingClientRect(),
    );

  const scheduleDraft = () => {
    if (frameRef.current !== 0) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const current = draftRef.current;
      setDraft(current ? strokePathData(current.points, aspect) : null);
    });
  };

  const eraseAt = (point: PdfAnnotationPoint) => {
    if (!session) return;
    const hit = hitTestStrokes(strokes, point, aspect);
    if (!hit) return;
    const own = hit.actorId === session.authority.actorId;
    if (!own && capability !== "present") {
      // An annotator may only erase their own ink.
      if (erasingRef.current && !erasingRef.current.noticed) {
        erasingRef.current.noticed = true;
        onNotice("classroomTools.files.ink.error.notOwned");
      }
      return;
    }
    try {
      session.authority.eraseOwnStroke(page, hit.id);
    } catch (error) {
      onNotice(pdfAnnotationErrorKey(error));
    }
  };

  const commitDraft = () => {
    const current = draftRef.current;
    draftRef.current = null;
    setDraft(null);
    if (!current || !session || current.points.length === 0) return;
    if (tool !== "pen" && tool !== "highlighter") return;
    try {
      session.authority.addStroke(page, {
        points: current.points,
        tone: settings.tone,
        tool: tool as PdfAnnotationTool,
        width: settings.width,
      });
    } catch (error) {
      onNotice(pdfAnnotationErrorKey(error));
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive || !session) return;
    // Palm rejection: a touching hand is ignored while a stylus is down.
    if (event.pointerType === "touch" && penDownRef.current) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (event.pointerType === "pen") penDownRef.current = true;
    onInk?.();
    const point = pointOf(event);
    if (lasering) {
      setOwnLaser(point);
      session.publishLaser({ page, x: point.x, y: point.y });
      return;
    }
    if (tool === "eraser") {
      erasingRef.current = { noticed: false, pointerId: event.pointerId };
      eraseAt(point);
      return;
    }
    draftRef.current = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      points: [point],
    };
    scheduleDraft();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive || !session) return;
    if (event.pointerType === "touch" && penDownRef.current) return;
    if (lasering) {
      // Hover (mouse / pen) or a pressed touch moves the laser.
      if (event.pointerType === "touch" && event.buttons === 0) return;
      const point = pointOf(event);
      setOwnLaser(point);
      session.publishLaser({ page, x: point.x, y: point.y });
      return;
    }
    if (erasingRef.current?.pointerId === event.pointerId) {
      eraseAt(pointOf(event));
      return;
    }
    const current = draftRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const native = event.nativeEvent;
    const samples =
      typeof native.getCoalescedEvents === "function"
        ? native.getCoalescedEvents()
        : [];
    const box = event.currentTarget.getBoundingClientRect();
    for (const sample of samples.length > 0 ? samples : [native]) {
      if (current.points.length >= MAX_DRAFT_POINTS) break;
      current.points.push(
        normalizePointer(sample.clientX, sample.clientY, box),
      );
    }
    scheduleDraft();
  };

  const finish = (
    event: ReactPointerEvent<HTMLDivElement>,
    commit: boolean,
  ) => {
    if (event.pointerType === "pen") penDownRef.current = false;
    if (lasering) {
      if (event.pointerType === "touch") {
        setOwnLaser(null);
        session?.publishLaser(null);
      }
      return;
    }
    if (erasingRef.current?.pointerId === event.pointerId) {
      erasingRef.current = null;
      return;
    }
    if (draftRef.current?.pointerId !== event.pointerId) return;
    if (commit) {
      commitDraft();
    } else {
      draftRef.current = null;
      setDraft(null);
    }
  };

  const highlights = strokes.filter((stroke) => stroke.tool === "highlighter");
  const pens = strokes.filter((stroke) => stroke.tool === "pen");
  const actorId = session?.authority.actorId ?? "";
  const draftTool = tool === "highlighter" ? "highlighter" : "pen";

  return (
    <div
      className="classroom-files-ink"
      data-pdf-ink={interactive ? (lasering ? "laser" : "draw") : "view"}
      data-pdf-ink-page={page}
      data-tool={interactive ? tool : undefined}
      onLostPointerCapture={(event) => finish(event, true)}
      onPointerCancel={(event) => finish(event, false)}
      onPointerDown={handlePointerDown}
      onPointerLeave={() => {
        if (lasering && ownLaser) {
          setOwnLaser(null);
          session?.publishLaser(null);
        }
      }}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => finish(event, true)}
      ref={rootRef}
    >
      <svg
        aria-hidden="true"
        className="classroom-files-ink__svg"
        focusable="false"
        preserveAspectRatio="none"
        viewBox={`0 0 ${box.width} ${box.height}`}
      >
        <g opacity={PDF_INK_HIGHLIGHT_OPACITY}>
          {highlights.map((stroke) => (
            <path
              d={strokePathData(stroke.points, aspect)}
              data-own={stroke.actorId === actorId || undefined}
              data-stroke-id={stroke.id}
              data-stroke-tool="highlighter"
              fill="none"
              key={stroke.id}
              stroke={strokeColor("highlighter", stroke.tone)}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={strokeWidthUnits("highlighter", stroke.width)}
            />
          ))}
        </g>
        {pens.map((stroke) => (
          <path
            d={strokePathData(stroke.points, aspect)}
            data-own={stroke.actorId === actorId || undefined}
            data-stroke-id={stroke.id}
            data-stroke-tool="pen"
            fill="none"
            key={stroke.id}
            stroke={strokeColor("pen", stroke.tone)}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={strokeWidthUnits("pen", stroke.width)}
          />
        ))}
        {draft ? (
          <path
            className="classroom-files-ink__draft"
            d={draft}
            fill="none"
            opacity={
              draftTool === "highlighter" ? PDF_INK_HIGHLIGHT_OPACITY : 1
            }
            stroke={strokeColor(draftTool, settings.tone)}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={strokeWidthUnits(draftTool, settings.width)}
          />
        ) : null}
      </svg>
      {marks.map((mark) => (
        <span
          aria-label={
            laserLabel?.(mark) ?? t("classroomTools.files.ink.laserMark")
          }
          className="classroom-files-laser"
          data-pdf-laser="presenter"
          key={mark.clientID}
          role="img"
          style={{ left: `${mark.x * 100}%`, top: `${mark.y * 100}%` }}
        />
      ))}
      {lasering && ownLaser ? (
        <span
          aria-hidden="true"
          className="classroom-files-laser classroom-files-laser--own"
          data-pdf-laser="own"
          style={{ left: `${ownLaser.x * 100}%`, top: `${ownLaser.y * 100}%` }}
        />
      ) : null}
    </div>
  );
}

// ---- Toolbar ------------------------------------------------------------

const TOOL_ICONS = {
  eraser: Eraser,
  highlighter: Highlighter,
  laser: Crosshair,
  pen: PenLine,
  select: MousePointer2,
} as const;

const TOOL_LABELS: Readonly<Record<PdfInkTool, TranslationKey>> = {
  eraser: "classroomTools.files.ink.tool.eraser",
  highlighter: "classroomTools.files.ink.tool.highlighter",
  laser: "classroomTools.files.ink.tool.laser",
  pen: "classroomTools.files.ink.tool.pen",
  select: "classroomTools.files.ink.tool.select",
};

const WIDTH_LABELS: Readonly<Record<PdfAnnotationWidth, TranslationKey>> = {
  l: "classroomTools.files.ink.width.l",
  m: "classroomTools.files.ink.width.m",
  s: "classroomTools.files.ink.width.s",
};

export interface PdfInkToolbarProps {
  readonly capability: "view" | "edit" | "present";
  readonly currentPage: number;
  readonly onClearPage?: () => void;
  readonly onRedo: () => void;
  readonly onTone: (tone: number) => void;
  readonly onTool: (tool: PdfInkTool) => void;
  readonly onUndo: () => void;
  readonly onWidth: (width: PdfAnnotationWidth) => void;
  readonly session: LivePdfSession | null;
  readonly settings: PdfInkSettings;
}

export function PdfInkToolbar({
  capability,
  currentPage,
  onClearPage,
  onRedo,
  onTone,
  onTool,
  onUndo,
  onWidth,
  session,
  settings,
}: PdfInkToolbarProps) {
  const { t } = useI18n();
  useSyncExternalStore(session ? session.ink.subscribe : noopSubscribe, () =>
    session ? session.ink.version() : -1,
  );
  const [confirmClear, setConfirmClear] = useState(false);
  const clearButtonRef = useRef<HTMLButtonElement>(null);
  const tools = inkToolsFor(capability);
  if (tools.length === 0) return null;
  const inkTool: PdfAnnotationTool =
    settings.tool === "highlighter" ? "highlighter" : "pen";
  const toneEntry = PDF_INK_TONES[settings.tone] ?? PDF_INK_TONES[1];
  const toneName = toneEntry ? t(toneEntry.label) : "";
  const canUndo = session?.ink.canUndo() === true;
  const canRedo = session?.ink.canRedo() === true;

  return (
    <div
      aria-label={t("classroomTools.files.ink.toolbar")}
      className="classroom-files-inkbar"
      role="toolbar"
    >
      <div className="classroom-files-inkbar__group">
        {tools.map((tool) => {
          const Icon = TOOL_ICONS[tool];
          return (
            <IconButton
              aria-pressed={settings.tool === tool}
              className="classroom-files-inkbar__tool"
              data-ink-tool={tool}
              data-tooltip={t(TOOL_LABELS[tool])}
              data-tooltip-side="top"
              key={tool}
              label={t(TOOL_LABELS[tool])}
              onClick={() => onTool(tool)}
              size="sm"
              variant="quiet"
            >
              <Icon />
            </IconButton>
          );
        })}
      </div>
      <span aria-hidden="true" className="classroom-files-inkbar__divider" />
      <Menu modal={false}>
        <MenuTrigger asChild>
          <button
            aria-label={t("classroomTools.files.ink.tone.menu", {
              name: toneName,
            })}
            className="classroom-files-inkbar__swatch-key"
            data-tooltip={t("classroomTools.files.ink.tone.menu", {
              name: toneName,
            })}
            data-tooltip-side="top"
            type="button"
          >
            <span
              aria-hidden="true"
              className="classroom-files-inkbar__swatch"
              style={{ background: strokeColor(inkTool, settings.tone) }}
            />
          </button>
        </MenuTrigger>
        <MenuContent
          aria-label={t("classroomTools.files.ink.tone.label")}
          className="classroom-files-menu"
          data-theme="dark"
          side="top"
        >
          <MenuRadioGroup
            onValueChange={(value) => onTone(Number(value))}
            value={String(settings.tone)}
          >
            {PDF_INK_TONES.map((tone, index) => (
              <MenuRadioItem key={tone.label} value={String(index)}>
                <span
                  aria-hidden="true"
                  className="classroom-files-inkbar__swatch"
                  style={{ background: strokeColor(inkTool, index) }}
                />
                {t(tone.label)}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
      <Menu modal={false}>
        <MenuTrigger asChild>
          <button
            aria-label={t("classroomTools.files.ink.width.menu", {
              size: t(WIDTH_LABELS[settings.width]),
            })}
            className="classroom-files-inkbar__width-key"
            data-tooltip={t("classroomTools.files.ink.width.menu", {
              size: t(WIDTH_LABELS[settings.width]),
            })}
            data-tooltip-side="top"
            type="button"
          >
            <span aria-hidden="true">{settings.width.toUpperCase()}</span>
          </button>
        </MenuTrigger>
        <MenuContent
          aria-label={t("classroomTools.files.ink.width.label")}
          className="classroom-files-menu"
          data-theme="dark"
          side="top"
        >
          <MenuRadioGroup
            onValueChange={(value) => onWidth(value as PdfAnnotationWidth)}
            value={settings.width}
          >
            {(["s", "m", "l"] as const).map((width) => (
              <MenuRadioItem key={width} value={width}>
                {t(WIDTH_LABELS[width])}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
      <span aria-hidden="true" className="classroom-files-inkbar__divider" />
      <IconButton
        className="classroom-files-inkbar__tool"
        data-tooltip={t("classroomTools.files.ink.undo")}
        data-tooltip-side="top"
        disabled={!canUndo}
        label={t("classroomTools.files.ink.undo")}
        onClick={onUndo}
        size="sm"
        variant="quiet"
      >
        <Undo2 />
      </IconButton>
      <IconButton
        className="classroom-files-inkbar__tool"
        data-tooltip={t("classroomTools.files.ink.redo")}
        data-tooltip-side="top"
        disabled={!canRedo}
        label={t("classroomTools.files.ink.redo")}
        onClick={onRedo}
        size="sm"
        variant="quiet"
      >
        <Redo2 />
      </IconButton>
      {capability === "present" && onClearPage ? (
        <IconButton
          className="classroom-files-inkbar__tool"
          data-tooltip={t("classroomTools.files.ink.clearPage", {
            page: currentPage,
          })}
          data-tooltip-side="top"
          label={t("classroomTools.files.ink.clearPage", { page: currentPage })}
          onClick={() => setConfirmClear(true)}
          ref={clearButtonRef}
          size="sm"
          variant="quiet"
        >
          <Trash2 />
        </IconButton>
      ) : null}
      {confirmClear && onClearPage ? (
        <ClearPageDialog
          onCancel={() => {
            setConfirmClear(false);
            clearButtonRef.current?.focus();
          }}
          onConfirm={() => {
            setConfirmClear(false);
            onClearPage();
            clearButtonRef.current?.focus();
          }}
          page={currentPage}
        />
      ) : null}
    </div>
  );
}

function ClearPageDialog({
  onCancel,
  onConfirm,
  page,
}: {
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly page: number;
}) {
  const { t } = useI18n();
  const titleID = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  const trap = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
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
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onCancel],
  );
  return (
    <div className="classroom-files-dialog-backdrop">
      <div
        aria-labelledby={titleID}
        className="classroom-files-dialog"
        onKeyDown={trap}
        ref={rootRef}
        role="alertdialog"
      >
        <h3 className="classroom-files-dialog__title" id={titleID}>
          {t("classroomTools.files.ink.clearTitle", { page })}
        </h3>
        <p>{t("classroomTools.files.ink.clearBody")}</p>
        <div className="classroom-files-dialog__actions">
          <Button onClick={onConfirm} size="sm" variant="danger">
            {t("classroomTools.files.ink.clearConfirm")}
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
