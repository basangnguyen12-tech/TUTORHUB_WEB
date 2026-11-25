import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useI18n } from "../../app/i18n";
import {
  CLASSROOM_TOOL_MANIFEST,
  groupClassroomTools,
  isClassroomToolGridKey,
  nextClassroomToolIndex,
  type ClassroomToolID,
} from "./registry";

export interface ClassroomToolsPopoverTool {
  readonly icon: ReactNode;
  readonly id: ClassroomToolID;
  readonly label: string;
}

const OPTION_SELECTOR = "[data-tool-option]";

/**
 * ROOM-TOOLS-CODE-01 / ADR-0043 §1 Classroom tools popover: a non-modal
 * Liquid Glass dialog anchored above the Dock with a grouped 4-column grid
 * (2 columns on narrow screens). One roving tab stop moves in 2D with the
 * arrow keys, Home and End; Escape closes and returns focus to the Dock key.
 * Each tile is a toggle (`aria-pressed`) naming the tool on the stage.
 */
export function ClassroomToolsPopover({
  anchorRef,
  id,
  onClose,
  onSelect,
  openToolID,
  tools,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  id: string;
  onClose: (restoreFocus: boolean) => void;
  onSelect: (toolID: ClassroomToolID) => void;
  openToolID: ClassroomToolID | null;
  tools: readonly ClassroomToolsPopoverTool[];
}) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const titleID = useId();
  const groups = groupClassroomTools(tools);
  const ordered = groups.flatMap((group) => group.tools);
  const [focusIndex, setFocusIndex] = useState(() =>
    Math.max(
      0,
      ordered.findIndex((tool) => tool.id === openToolID),
    ),
  );
  const safeFocusIndex = Math.min(focusIndex, Math.max(0, ordered.length - 1));

  // Point the caret at the Dock key. The popover itself is centred on the
  // Dock (like the device popover), so it always stays inside the viewport.
  useLayoutEffect(() => {
    const update = () => {
      const root = rootRef.current;
      const anchor = anchorRef.current;
      if (!root || !anchor) return;
      const rootBox = root.getBoundingClientRect();
      const anchorBox = anchor.getBoundingClientRect();
      const center = anchorBox.left + anchorBox.width / 2 - rootBox.left;
      root.style.setProperty(
        "--tools-caret-left",
        `${Math.min(Math.max(center, 22), Math.max(22, rootBox.width - 22))}px`,
      );
    };
    update();
    globalThis.addEventListener("resize", update);
    return () => globalThis.removeEventListener("resize", update);
  }, [anchorRef]);

  // Move focus into the grid once, on open: the open tool, else the first.
  useEffect(() => {
    const root = rootRef.current;
    const target =
      root?.querySelector<HTMLButtonElement>(
        `${OPTION_SELECTOR}[aria-pressed="true"]`,
      ) ?? root?.querySelector<HTMLButtonElement>(OPTION_SELECTOR);
    target?.focus();
  }, []);

  // An outside pointer closes without moving focus (non-modal popover).
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose(false);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [anchorRef, onClose]);

  const columns = () => {
    const grid = rootRef.current?.querySelector<HTMLElement>(
      ".media-p506-tools-popover__grid",
    );
    if (!grid) return 4;
    // Resolved track list, e.g. "80px 80px 80px 80px"; "none" without CSS.
    const template = getComputedStyle(grid).gridTemplateColumns.trim();
    if (!template || template === "none") return 4;
    return Math.max(1, template.split(/\s+/).length);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    }
    if (!isClassroomToolGridKey(event.key)) return;
    const options = Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>(OPTION_SELECTOR) ??
        [],
    );
    const current = options.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    if (current < 0) return;
    event.preventDefault();
    event.stopPropagation();
    const next = nextClassroomToolIndex(
      groups.map((group) => group.tools.length),
      columns(),
      current,
      event.key,
    );
    if (next >= 0) {
      setFocusIndex(next);
      options[next]?.focus();
    }
  };

  const groupOffsets = groups.map((_, groupIndex) =>
    groups
      .slice(0, groupIndex)
      .reduce((sum, group) => sum + group.tools.length, 0),
  );
  return (
    <div
      aria-labelledby={titleID}
      className="media-p506-tools-popover"
      data-testid="media-p506-tools-popover"
      id={id}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next === null || !(next instanceof Node)) return;
        if (rootRef.current?.contains(next)) return;
        if (anchorRef.current?.contains(next)) return;
        onClose(false);
      }}
      onKeyDown={handleKeyDown}
      ref={rootRef}
      role="dialog"
    >
      <span aria-hidden="true" className="media-p506-tools-popover__caret" />
      <div className="media-p506-tools-popover__header">
        <p className="media-p506-tools-popover__title" id={titleID}>
          {t("classroomTools.popoverTitle")}
        </p>
        <span aria-hidden="true" className="media-p506-tools-popover__hint">
          {t("classroomTools.escapeHint")}
        </span>
      </div>
      {groups.map((group, groupIndex) => {
        const groupTitleID = `${id}-group-${group.category}`;
        return (
          <div className="media-p506-tools-popover__group" key={group.category}>
            <p
              className="media-p506-tools-popover__group-title"
              id={groupTitleID}
            >
              {t(group.titleKey)}
            </p>
            <div
              aria-labelledby={groupTitleID}
              className="media-p506-tools-popover__grid"
              role="group"
            >
              {group.tools.map((tool, toolIndex) => {
                const index = (groupOffsets[groupIndex] ?? 0) + toolIndex;
                const open = openToolID === tool.id;
                const descriptionID = `${id}-${tool.id}-description`;
                return (
                  <Fragment key={tool.id}>
                    <button
                      aria-describedby={descriptionID}
                      aria-pressed={open}
                      className="media-p506-tool-option"
                      data-tool-option={tool.id}
                      id={`media-p506-tool-option-${tool.id}`}
                      onClick={() => onSelect(tool.id)}
                      onFocus={() => setFocusIndex(index)}
                      tabIndex={index === safeFocusIndex ? 0 : -1}
                      type="button"
                    >
                      <span
                        aria-hidden="true"
                        className="media-p506-tool-option__icon"
                      >
                        {tool.icon}
                      </span>
                      <span className="media-p506-tool-option__label">
                        {tool.label}
                      </span>
                      {open && (
                        <span
                          aria-hidden="true"
                          className="media-p506-tool-option__dot"
                        />
                      )}
                    </button>
                    {/* Outside the button so it never joins the name. */}
                    <span hidden id={descriptionID}>
                      {t(CLASSROOM_TOOL_MANIFEST[tool.id].descriptionKey)}
                      {open ? ` ${t("classroomTools.openOnStage")}` : ""}
                    </span>
                  </Fragment>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
