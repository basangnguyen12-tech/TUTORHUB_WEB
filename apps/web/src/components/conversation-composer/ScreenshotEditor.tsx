import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@tutorhub/ui";
import {
  useCallback,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useI18n } from "../../app/i18n";
import {
  FULL_SELECTION,
  SCREENSHOT_MIN_EDGE_PX,
  clampSelection,
  exportScreenshot,
  selectionFromPoints,
  selectionToPixels,
  type CropSelection,
} from "./screenCapture";
import "./ScreenshotEditor.css";

/** Keyboard step for moving or resizing the crop, as a fraction. */
const KEYBOARD_STEP = 0.01;

interface DragState {
  mode: "move" | "new";
  origin: { x: number; y: number };
  start: CropSelection;
}

export interface ScreenshotEditorProps {
  /** The captured frame; it never leaves this tab until confirmed. */
  capture: HTMLCanvasElement;
  exportImage?: typeof exportScreenshot;
  onCancel: () => void;
  onConfirm: (file: File) => void;
  onRetake: () => void;
  /** Where focus goes when the editor closes (defaults to Radix restore). */
  returnFocus?: () => void;
}

/**
 * MSG-COMPOSER-TOOLS-01: modal crop step between capture and staging. The
 * crop can be drawn with a pointer or moved/resized from the keyboard.
 */
export function ScreenshotEditor({
  capture,
  exportImage = exportScreenshot,
  onCancel,
  onConfirm,
  onRetake,
  returnFocus,
}: ScreenshotEditorProps) {
  const { t } = useI18n();
  const hintID = useId();
  const stage = useRef<HTMLDivElement>(null);
  const selectionBox = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  const [selection, setSelection] = useState<CropSelection>(FULL_SELECTION);
  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);

  const width = capture.width;
  const height = capture.height;
  const minimum = {
    height: SCREENSHOT_MIN_EDGE_PX / Math.max(height, 1),
    width: SCREENSHOT_MIN_EDGE_PX / Math.max(width, 1),
  };
  const pixels = selectionToPixels(selection, { height, width });

  // A callback ref: the dialog portal mounts its content after the first
  // commit, so an effect would run before the canvas exists.
  const drawPreview = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (!canvas) return;
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d")?.drawImage(capture, 0, 0);
      return () => {
        // Release the preview bitmap as soon as the editor closes.
        canvas.width = 0;
        canvas.height = 0;
      };
    },
    [capture, height, width],
  );

  const pointFromEvent = (event: PointerEvent<HTMLElement>) => {
    const rect = stage.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) {
      return { x: 0, y: 0 };
    }
    return {
      x: Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1),
      y: Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1),
    };
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || exporting) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const origin = pointFromEvent(event);
    const insideSelection =
      event.target instanceof Node &&
      selectionBox.current?.contains(event.target) === true;
    drag.current = {
      mode: insideSelection ? "move" : "new",
      origin,
      start: selection,
    };
    selectionBox.current?.focus({ preventScroll: true });
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    const point = pointFromEvent(event);
    if (current.mode === "move") {
      setSelection(
        clampSelection(
          {
            ...current.start,
            x: current.start.x + point.x - current.origin.x,
            y: current.start.y + point.y - current.origin.y,
          },
          minimum,
        ),
      );
      return;
    }
    setSelection(selectionFromPoints(current.origin, point));
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!current || current.mode === "move") return;
    const drawn = selectionFromPoints(current.origin, pointFromEvent(event));
    // A plain click keeps the previous crop instead of collapsing it.
    setSelection(
      drawn.width < minimum.width && drawn.height < minimum.height
        ? current.start
        : clampSelection(drawn, minimum),
    );
  };

  const confirm = async () => {
    if (exporting) return;
    setExporting(true);
    setExportFailed(false);
    try {
      onConfirm(await exportImage(capture, selection));
    } catch {
      setExportFailed(true);
      setExporting(false);
    }
  };

  const onSelectionKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void confirm();
      return;
    }
    const delta: Record<string, [number, number]> = {
      ArrowDown: [0, KEYBOARD_STEP],
      ArrowLeft: [-KEYBOARD_STEP, 0],
      ArrowRight: [KEYBOARD_STEP, 0],
      ArrowUp: [0, -KEYBOARD_STEP],
    };
    const step = delta[event.key];
    if (!step) return;
    event.preventDefault();
    const [dx, dy] = step;
    setSelection((current) =>
      clampSelection(
        event.shiftKey
          ? {
              ...current,
              height: current.height + dy,
              width: current.width + dx,
            }
          : { ...current, x: current.x + dx, y: current.y + dy },
        minimum,
      ),
    );
  };

  const stageStyle = {
    "--screenshot-ratio": `${width / Math.max(height, 1)}`,
  } as CSSProperties;
  const boxStyle: CSSProperties = {
    height: `${selection.height * 100}%`,
    left: `${selection.x * 100}%`,
    top: `${selection.y * 100}%`,
    width: `${selection.width * 100}%`,
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      open
    >
      <DialogContent
        aria-describedby={hintID}
        className="screenshot-editor"
        closeLabel={t("conversations.screenshotClose")}
        onCloseAutoFocus={(event) => {
          if (!returnFocus) return;
          event.preventDefault();
          returnFocus();
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          selectionBox.current?.focus();
        }}
      >
        <DialogTitle>{t("conversations.screenshotEditorTitle")}</DialogTitle>
        <DialogDescription id={hintID}>
          {t("conversations.screenshotEditorHint")}
        </DialogDescription>
        <div
          className="screenshot-editor__stage"
          data-testid="screenshot-stage"
          onPointerCancel={onPointerUp}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          ref={stage}
          style={stageStyle}
        >
          <canvas
            aria-hidden="true"
            className="screenshot-editor__image"
            ref={drawPreview}
          />
          <div
            aria-describedby={hintID}
            aria-label={t("conversations.screenshotSelection", {
              height: pixels.height,
              width: pixels.width,
              x: pixels.x,
              y: pixels.y,
            })}
            aria-roledescription={t("conversations.screenshotSelectionRole")}
            className="screenshot-editor__selection"
            onKeyDown={onSelectionKeyDown}
            ref={selectionBox}
            role="group"
            style={boxStyle}
            tabIndex={0}
          />
        </div>
        <p className="screenshot-editor__size">
          {t("conversations.screenshotSize", {
            height: pixels.height,
            width: pixels.width,
          })}
        </p>
        {exportFailed && (
          <p className="screenshot-editor__error" role="alert">
            {t("conversations.screenshotExportFailed")}
          </p>
        )}
        <div className="screenshot-editor__actions">
          <Button
            disabled={exporting}
            onClick={() => setSelection(FULL_SELECTION)}
            size="sm"
            variant="quiet"
          >
            {t("conversations.screenshotSelectAll")}
          </Button>
          <span className="screenshot-editor__spacer" />
          <Button
            disabled={exporting}
            onClick={onRetake}
            size="sm"
            variant="secondary"
          >
            {t("conversations.screenshotRetake")}
          </Button>
          <Button
            disabled={exporting}
            onClick={onCancel}
            size="sm"
            variant="secondary"
          >
            {t("conversations.screenshotCancel")}
          </Button>
          <Button
            loading={exporting}
            loadingLabel={t("conversations.screenshotExporting")}
            onClick={() => void confirm()}
            size="sm"
          >
            {t("conversations.screenshotUse")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
