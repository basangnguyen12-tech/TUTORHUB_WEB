import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Palette } from "lucide-react";
import { useI18n } from "../../app/i18n";
import {
  isFixedPaperSurface,
  paperModeLabelKey,
  paperSwatchStyle,
  WHITEBOARD_PAPER_MODES,
  type PaperSwatchVariant,
  type WhiteboardPaperMode,
  type WhiteboardPaperSelection,
} from "./whiteboardPaper";

/**
 * Teacher/presenter: a round glass palette key that opens a non-modal paper popover
 * (3×3 toggle cards + light/dark switch). Student (`readOnly`): a passive pill
 * naming the paper the teacher chose. Toggle buttons use `aria-pressed`, never
 * `role="radio"`, so Excalidraw's tool radios stay the only radios in view.
 */
export function WhiteboardPaperPicker({
  onChange,
  paper,
  readOnly,
}: {
  onChange: (next: WhiteboardPaperSelection) => void;
  paper: WhiteboardPaperSelection;
  readOnly: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverID = useId();
  const hintID = useId();
  const modeName = t(paperModeLabelKey(paper.mode));
  const fixedSurface = isFixedPaperSurface(paper.mode);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (
        root &&
        event.target instanceof Node &&
        !root.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    globalThis.document.addEventListener(
      "pointerdown",
      handlePointerDown,
      true,
    );
    // Move focus into the popover: the selected paper card.
    popoverRef.current
      ?.querySelector<HTMLButtonElement>(
        '[data-paper-mode][aria-pressed="true"]',
      )
      ?.focus();
    return () =>
      globalThis.document.removeEventListener(
        "pointerdown",
        handlePointerDown,
        true,
      );
  }, [open]);

  if (readOnly) {
    const darkSuffix =
      paper.dark && !fixedSurface ? ` · ${t("whiteboard.paper.dark")}` : "";
    return (
      <p
        aria-live="polite"
        className="whiteboard-paper-readonly"
        data-paper-dark={paper.dark ? "true" : "false"}
        data-paper-mode={paper.mode}
        data-testid="whiteboard-paper-readonly"
      >
        <PaperSwatch dark={paper.dark} mode={paper.mode} variant="chip" />
        <span>
          {t("whiteboard.paper.readOnly", { mode: modeName })}
          {darkSuffix}
        </span>
      </p>
    );
  }

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  const handlePopoverKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  };

  const handleBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (!open || next === null) return;
    if (next instanceof Node && rootRef.current?.contains(next)) return;
    setOpen(false);
  };

  return (
    <div
      className="whiteboard-paper-picker"
      data-open={open ? "true" : "false"}
      onBlur={handleBlur}
      ref={rootRef}
    >
      <button
        aria-controls={open ? popoverID : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="whiteboard-paper-trigger"
        data-testid="whiteboard-paper-trigger"
        data-tooltip={t("whiteboard.paper.trigger", { mode: modeName })}
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
        type="button"
      >
        {/*
          ROOM-STAGE-POLISH-04: one round palette key like Lock / ⋯ / Close.
          The current paper lives in the accessible name and the tooltip.
        */}
        <Palette
          aria-hidden="true"
          className="whiteboard-paper-trigger-icon"
          strokeWidth={1.9}
        />
        <span className="whiteboard-paper-trigger-label">
          {t("whiteboard.paper.trigger", { mode: modeName })}
        </span>
      </button>
      {open ? (
        <div
          aria-describedby={fixedSurface ? hintID : undefined}
          aria-label={t("whiteboard.paper.dialogLabel")}
          className="whiteboard-paper-popover"
          data-testid="whiteboard-paper-popover"
          id={popoverID}
          onKeyDown={handlePopoverKeyDown}
          ref={popoverRef}
          role="dialog"
        >
          <div className="whiteboard-paper-popover-header">
            <p className="whiteboard-paper-popover-title">
              {t("whiteboard.paper.title")}
            </p>
            <div
              aria-label={t("whiteboard.paper.toneLabel")}
              className="whiteboard-paper-theme-switch"
              data-fixed={fixedSurface ? "true" : "false"}
              role="group"
            >
              {([false, true] as const).map((dark) => (
                <button
                  aria-pressed={paper.dark === dark}
                  className="whiteboard-paper-theme-option"
                  data-paper-tone={dark ? "dark" : "light"}
                  disabled={fixedSurface}
                  key={dark ? "dark" : "light"}
                  onClick={() => {
                    if (paper.dark !== dark) onChange({ ...paper, dark });
                  }}
                  type="button"
                >
                  {t(dark ? "whiteboard.paper.dark" : "whiteboard.paper.light")}
                </button>
              ))}
            </div>
          </div>
          {fixedSurface ? (
            <p className="whiteboard-paper-hint" id={hintID}>
              {t("whiteboard.paper.fixedHint")}
            </p>
          ) : null}
          <div
            aria-label={t("whiteboard.paper.modesLabel")}
            className="whiteboard-paper-grid"
            role="group"
          >
            {WHITEBOARD_PAPER_MODES.map((mode) => {
              const selected = mode === paper.mode;
              return (
                <button
                  aria-pressed={selected}
                  className="whiteboard-paper-card"
                  data-paper-mode={mode}
                  key={mode}
                  onClick={() => {
                    if (!selected) onChange({ ...paper, mode });
                  }}
                  type="button"
                >
                  <PaperSwatch dark={paper.dark} mode={mode} variant="card" />
                  <span className="whiteboard-paper-card-name">
                    {t(paperModeLabelKey(mode))}
                  </span>
                  {selected ? (
                    <span
                      aria-hidden="true"
                      className="whiteboard-paper-card-check"
                    >
                      ✓
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PaperSwatch({
  dark,
  mode,
  variant,
}: {
  dark: boolean;
  mode: WhiteboardPaperMode;
  variant: PaperSwatchVariant;
}) {
  return (
    <span
      aria-hidden="true"
      className={`whiteboard-paper-swatch whiteboard-paper-swatch--${variant}`}
      data-swatch-mode={mode}
      style={paperSwatchStyle(mode, dark, variant)}
    />
  );
}
