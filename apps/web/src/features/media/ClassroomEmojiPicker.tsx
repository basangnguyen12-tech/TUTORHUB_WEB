import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Flag,
  Hand,
  Lightbulb,
  PawPrint,
  Plane,
  Search,
  Shapes,
  Smile,
  Trophy,
  UtensilsCrossed,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type RefObject,
  type UIEvent,
} from "react";
import { useI18n, type TranslationKey } from "../../app/i18n";
import {
  loadChatEmojiRecents,
  loadClassroomEmojiCatalog,
  peekClassroomEmojiCatalog,
  prefetchClassroomEmojiCatalog,
  recordChatEmojiRecent,
  searchClassroomEmoji,
  type ChatEmojiRecentScope,
  type ClassroomEmojiCatalog,
  type ClassroomEmojiEntry,
  type ClassroomEmojiTopic,
} from "./classroomChatMedia";

/**
 * ROOM-CHAT-EMOJI-02: Zalo-style emoji popover for the classroom composer.
 *
 * Three tiers: search on top, one continuous vertical stream ("Recent" then
 * nine topics, 8 columns, sticky titles) and a monochrome topic bar at the
 * bottom whose underline follows the scroll position (scroll-spy) and jumps
 * the stream to a topic on click. Picking inserts at the caret and keeps the
 * popover open; it closes on outside click, Escape, the emoji key or send.
 *
 * The stream is virtualised by fixed-height rows: every section's offset is
 * plain arithmetic (title + rows x 38px), so a jump lands on the exact top of
 * the last topics on the first click and only ~150 of ~1,900 buttons exist.
 */

const GRID_COLUMNS = 8;
/* Keep in sync with `.classroom-chat-emoji__*` in ClassroomRoomStage.css. */
const HEADER_HEIGHT = 30;
const ROW_HEIGHT = 38;
const CELL_HEIGHT = 36;
const SECTION_GAP = 6;
const HINT_HEIGHT = 38;
const DEFAULT_VIEWPORT = 317;
const WINDOW_STEP = ROW_HEIGHT * 4;
const OVERSCAN = ROW_HEIGHT * 6;

type TabID = ClassroomEmojiTopic | "recent";
type SectionID = TabID | "results";

const TABS: readonly { icon: LucideIcon; id: TabID }[] = [
  { icon: Clock, id: "recent" },
  { icon: Smile, id: "smileys" },
  { icon: Hand, id: "people" },
  { icon: PawPrint, id: "nature" },
  { icon: UtensilsCrossed, id: "food" },
  { icon: Trophy, id: "activities" },
  { icon: Plane, id: "travel" },
  { icon: Lightbulb, id: "objects" },
  { icon: Shapes, id: "symbols" },
  { icon: Flag, id: "flags" },
];

const SECTION_LABELS: Record<TabID, TranslationKey> = {
  activities: "media.chat.emoji.category.activities",
  flags: "media.chat.emoji.category.flags",
  food: "media.chat.emoji.category.food",
  nature: "media.chat.emoji.category.nature",
  objects: "media.chat.emoji.category.objects",
  people: "media.chat.emoji.category.people",
  recent: "media.chat.emoji.category.recent",
  smileys: "media.chat.emoji.category.smileys",
  symbols: "media.chat.emoji.category.symbols",
  travel: "media.chat.emoji.category.travel",
};

interface SectionSpec {
  entries: readonly ClassroomEmojiEntry[];
  hint?: boolean;
  id: SectionID;
}

interface LayoutSection extends SectionSpec {
  height: number;
  rows: number;
  top: number;
}

interface EmojiLayout {
  sections: LayoutSection[];
  total: number;
}

interface CellRef {
  index: number;
  section: SectionID;
}

function sectionHeight(count: number, hint = false) {
  const body = hint
    ? HINT_HEIGHT
    : Math.ceil(count / GRID_COLUMNS) * ROW_HEIGHT;
  return HEADER_HEIGHT + body + SECTION_GAP;
}

function recentHeight(count: number, hint: boolean) {
  return count > 0 || hint ? sectionHeight(count, count === 0) : 0;
}

function buildLayout(specs: readonly SectionSpec[]): EmojiLayout {
  let top = 0;
  const sections = specs.map((spec) => {
    const hint = spec.hint === true && spec.entries.length === 0;
    const section: LayoutSection = {
      ...spec,
      height: sectionHeight(spec.entries.length, hint),
      hint,
      rows: hint ? 0 : Math.ceil(spec.entries.length / GRID_COLUMNS),
      top,
    };
    top += section.height;
    return section;
  });
  return { sections, total: top };
}

function quantize(scrollTop: number) {
  return Math.max(0, Math.floor(scrollTop / WINDOW_STEP) * WINDOW_STEP);
}

function spyAt(layout: EmojiLayout, scrollTop: number, atBottom: boolean) {
  const { sections } = layout;
  if (sections.length === 0) return null;
  if (atBottom) return sections[sections.length - 1]?.id ?? null;
  let current = sections[0]?.id ?? null;
  for (const section of sections) {
    if (section.top > scrollTop + 4) break;
    current = section.id;
  }
  return current;
}

function navigable(layout: EmojiLayout) {
  return layout.sections.filter((section) => section.entries.length > 0);
}

function firstCell(layout: EmojiLayout): CellRef | null {
  const section = navigable(layout)[0];
  return section ? { index: 0, section: section.id } : null;
}

/** Arrow-key movement through the 8-column stream, across topic borders. */
function moveCell(
  layout: EmojiLayout,
  from: CellRef,
  key: string,
  jumpToEdge: boolean,
): CellRef | "search" | null {
  const sections = navigable(layout);
  const position = sections.findIndex((section) => section.id === from.section);
  const section = sections[position];
  if (!section) return firstCell(layout);
  const length = section.entries.length;
  const index = Math.min(from.index, length - 1);
  const row = Math.floor(index / GRID_COLUMNS);
  const column = index % GRID_COLUMNS;
  const previous = sections[position - 1];
  const next = sections[position + 1];
  const last = sections[sections.length - 1];
  switch (key) {
    case "ArrowRight":
      if (index + 1 < length) return { index: index + 1, section: section.id };
      return next ? { index: 0, section: next.id } : null;
    case "ArrowLeft":
      if (index > 0) return { index: index - 1, section: section.id };
      return previous
        ? { index: previous.entries.length - 1, section: previous.id }
        : "search";
    case "ArrowDown": {
      const nextRow = (row + 1) * GRID_COLUMNS;
      if (nextRow < length) {
        return {
          index: Math.min(nextRow + column, length - 1),
          section: section.id,
        };
      }
      return next
        ? {
            index: Math.min(column, next.entries.length - 1),
            section: next.id,
          }
        : null;
    }
    case "ArrowUp": {
      if (row > 0) {
        return { index: index - GRID_COLUMNS, section: section.id };
      }
      if (!previous) return "search";
      const lastRow = Math.floor((previous.entries.length - 1) / GRID_COLUMNS);
      return {
        index: Math.min(
          lastRow * GRID_COLUMNS + column,
          previous.entries.length - 1,
        ),
        section: previous.id,
      };
    }
    case "Home":
      return jumpToEdge
        ? firstCell(layout)
        : { index: row * GRID_COLUMNS, section: section.id };
    case "End":
      return jumpToEdge
        ? last
          ? { index: last.entries.length - 1, section: last.id }
          : null
        : {
            index: Math.min(row * GRID_COLUMNS + GRID_COLUMNS - 1, length - 1),
            section: section.id,
          };
    default:
      return null;
  }
}

type CatalogState =
  | { status: "error" }
  | { status: "loading" }
  | { catalog: ClassroomEmojiCatalog; status: "ready" };

function useEmojiCatalog() {
  const [state, setState] = useState<CatalogState>(() => {
    const catalog = peekClassroomEmojiCatalog();
    return catalog ? { catalog, status: "ready" } : { status: "loading" };
  });
  const [attempt, setAttempt] = useState(0);
  const ready = state.status === "ready";
  useEffect(() => {
    if (ready) return undefined;
    let active = true;
    loadClassroomEmojiCatalog().then(
      (catalog) => {
        if (active) setState({ catalog, status: "ready" });
      },
      () => {
        if (active) setState({ status: "error" });
      },
    );
    return () => {
      active = false;
    };
  }, [attempt, ready]);
  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((value) => value + 1);
  }, []);
  return [state, retry] as const;
}

export interface ClassroomEmojiPickerProps {
  /** Clicks inside this element (the composer card) keep the popover open. */
  boundaryRef?: RefObject<HTMLElement | null>;
  disabled?: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (emoji: string) => void;
  open: boolean;
  /** `(tenant, user)` scope of the device-local "Recent" row. */
  recentScope: ChatEmojiRecentScope | null;
}

export function ClassroomEmojiPicker({
  boundaryRef,
  disabled = false,
  onOpenChange,
  onSelect,
  open,
  recentScope,
}: ClassroomEmojiPickerProps) {
  const { t } = useI18n();
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverID = `${id}-popover`;

  const close = useCallback(
    (restoreFocus: boolean) => {
      onOpenChange(false);
      if (restoreFocus) triggerRef.current?.focus();
    },
    [onOpenChange],
  );

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target)) return;
      if (boundaryRef?.current?.contains(target)) return;
      onOpenChange(false);
    };
    const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (
        event.target instanceof Node &&
        rootRef.current?.contains(event.target)
      ) {
        return;
      }
      event.preventDefault();
      onOpenChange(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onDocumentKeyDown);
    };
  }, [boundaryRef, onOpenChange, open]);

  const label = t("media.chat.emoji.open");
  return (
    <div className="classroom-chat-emoji" ref={rootRef}>
      <button
        aria-controls={open ? popoverID : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        className="classroom-chat-tool"
        data-tooltip={label}
        disabled={disabled}
        onClick={() => (open ? close(true) : onOpenChange(true))}
        onFocus={prefetchClassroomEmojiCatalog}
        onPointerEnter={prefetchClassroomEmojiCatalog}
        ref={triggerRef}
        type="button"
      >
        <Smile aria-hidden="true" />
      </button>
      {open && (
        <EmojiPopover
          id={popoverID}
          onClose={close}
          onSelect={onSelect}
          recentScope={recentScope}
        />
      )}
    </div>
  );
}

function EmojiPopover({
  id,
  onClose,
  onSelect,
  recentScope,
}: {
  id: string;
  onClose: (restoreFocus: boolean) => void;
  onSelect: (emoji: string) => void;
  recentScope: ChatEmojiRecentScope | null;
}) {
  const { language, t } = useI18n();
  const [catalogState, retryCatalog] = useEmojiCatalog();
  const catalog = catalogState.status === "ready" ? catalogState.catalog : null;
  const [query, setQuery] = useState("");
  const [shownRecents, setShownRecents] = useState(() =>
    loadChatEmojiRecents(recentScope),
  );
  const storedRecents = useRef<readonly string[] | null>(null);
  const [recentHint, setRecentHint] = useState(false);
  const [spy, setSpy] = useState<SectionID>(() =>
    shownRecents.length > 0 ? "recent" : "smileys",
  );
  const [windowTop, setWindowTop] = useState(0);
  const [viewport, setViewport] = useState(DEFAULT_VIEWPORT);
  const [active, setActive] = useState<CellRef | null>(null);
  const [tabOverflow, setTabOverflow] = useState({
    end: false,
    start: false,
  });
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<TabID, HTMLButtonElement>());
  const pendingScroll = useRef<number | null>(null);
  const pendingFocus = useRef<CellRef | null>(null);

  const recentEntries = useMemo(
    () =>
      catalog
        ? shownRecents.flatMap((char) => {
            const entry = catalog.byChar.get(char);
            return entry ? [entry] : [];
          })
        : [],
    [catalog, shownRecents],
  );
  const topicLayout = useMemo(() => {
    if (!catalog) return buildLayout([]);
    const specs: SectionSpec[] = [];
    if (recentEntries.length > 0 || recentHint) {
      specs.push({ entries: recentEntries, hint: true, id: "recent" });
    }
    for (const topic of catalog.topics) {
      specs.push({ entries: topic.entries, id: topic.id });
    }
    return buildLayout(specs);
  }, [catalog, recentEntries, recentHint]);
  const trimmedQuery = query.trim();
  const searching = trimmedQuery.length > 0;
  const results = useMemo(
    () =>
      catalog && trimmedQuery
        ? searchClassroomEmoji(catalog, trimmedQuery)
        : [],
    [catalog, trimmedQuery],
  );
  const layout = useMemo(
    () =>
      searching
        ? buildLayout(
            results.length > 0 ? [{ entries: results, id: "results" }] : [],
          )
        : topicLayout,
    [results, searching, topicLayout],
  );

  const activeSection = active
    ? layout.sections.find(
        (section) =>
          section.id === active.section && section.entries.length > 0,
      )
    : undefined;
  const activeCell: CellRef | null =
    active && activeSection
      ? {
          index: Math.min(active.index, activeSection.entries.length - 1),
          section: active.section,
        }
      : firstCell(layout);
  const currentSpy: SectionID = topicLayout.sections.some(
    (section) => section.id === spy,
  )
    ? spy
    : (topicLayout.sections[0]?.id ?? "smileys");
  const currentTab: TabID = currentSpy === "results" ? "smileys" : currentSpy;

  // Apply queued scroll positions and focus after the rows exist in the DOM.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller && pendingScroll.current !== null) {
      scroller.scrollTop = pendingScroll.current;
      pendingScroll.current = null;
    }
    const focus = pendingFocus.current;
    if (focus) {
      pendingFocus.current = null;
      scroller
        ?.querySelector<HTMLButtonElement>(
          `[data-cell="${focus.section}:${focus.index}"]`,
        )
        ?.focus({ preventScroll: true });
    }
  });

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const updateTabOverflow = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const start = strip.scrollLeft > 1;
    const end = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
    setTabOverflow((current) =>
      current.start === start && current.end === end ? current : { end, start },
    );
  }, []);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return undefined;
    const scroller = scrollerRef.current;
    const strip = stripRef.current;
    const observer = new ResizeObserver(() => {
      if (scroller) setViewport(scroller.clientHeight || DEFAULT_VIEWPORT);
      updateTabOverflow();
    });
    if (scroller) observer.observe(scroller);
    if (strip) observer.observe(strip);
    return () => observer.disconnect();
  }, [updateTabOverflow]);

  // Keep the active topic icon inside the bottom strip (inline "nearest").
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const tab = tabRefs.current.get(currentTab);
    if (!strip || !tab) return;
    if (tab.offsetLeft < strip.scrollLeft) {
      strip.scrollLeft = tab.offsetLeft;
    } else if (
      tab.offsetLeft + tab.offsetWidth >
      strip.scrollLeft + strip.clientWidth
    ) {
      strip.scrollLeft = tab.offsetLeft + tab.offsetWidth - strip.clientWidth;
    }
  }, [currentTab]);

  const scrollStream = (top: number) => {
    pendingScroll.current = Math.max(0, top);
    setWindowTop(quantize(top));
  };

  const onStreamScroll = (event: UIEvent<HTMLDivElement>) => {
    const scroller = event.currentTarget;
    const top = scroller.scrollTop;
    setWindowTop(quantize(top));
    if (searching) return;
    const atBottom =
      scroller.scrollHeight > scroller.clientHeight &&
      top + scroller.clientHeight >= scroller.scrollHeight - 2;
    const next = spyAt(topicLayout, top, atBottom);
    if (next) setSpy(next);
  };

  const jumpTo = (tab: TabID) => {
    if (searching) setQuery("");
    if (tab === "recent" && recentEntries.length === 0) setRecentHint(true);
    const section = topicLayout.sections.find((item) => item.id === tab);
    // "Recent" always sits at the top (it may only appear on this click).
    const top = tab === "recent" ? 0 : (section?.top ?? 0);
    setSpy(tab);
    if (section && section.entries.length > 0) {
      setActive({ index: 0, section: tab });
    }
    scrollStream(top);
  };

  const focusCell = (cell: CellRef) => {
    setActive(cell);
    pendingFocus.current = cell;
    const scroller = scrollerRef.current;
    const section = layout.sections.find((item) => item.id === cell.section);
    if (!scroller || !section) return;
    const rowTop =
      section.top +
      HEADER_HEIGHT +
      Math.floor(cell.index / GRID_COLUMNS) * ROW_HEIGHT;
    const current = scroller.scrollTop;
    const view = scroller.clientHeight || viewport;
    if (rowTop - HEADER_HEIGHT < current) {
      scrollStream(rowTop - HEADER_HEIGHT);
    } else if (rowTop + CELL_HEIGHT > current + view) {
      scrollStream(rowTop + CELL_HEIGHT + SECTION_GAP - view);
    }
  };

  const choose = (entry: ClassroomEmojiEntry, from: SectionID) => {
    onSelect(entry.char);
    const stored = storedRecents.current ?? shownRecents;
    const next = recordChatEmojiRecent(recentScope, stored, entry.char);
    storedRecents.current = next;
    // Picking from "Recent" keeps that row still under the pointer; the new
    // order shows next time the popover opens.
    if (from === "recent") return;
    setShownRecents(next);
    if (searching || !catalog) return;
    const count = next.filter((char) => catalog.byChar.has(char)).length;
    const delta =
      recentHeight(count, recentHint) -
      recentHeight(recentEntries.length, recentHint);
    const scroller = scrollerRef.current;
    // Anchor the picked emoji: "Recent" grows above it, the stream does not
    // jump.
    if (delta !== 0 && scroller) scrollStream(scroller.scrollTop + delta);
  };

  const onSearchChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setQuery(value);
    setActive(null);
    if (!value.trim()) setSpy(topicLayout.sections[0]?.id ?? "smileys");
    scrollStream(0);
  };

  const clearSearch = () => {
    setQuery("");
    setActive(null);
    setSpy(topicLayout.sections[0]?.id ?? "smileys");
    scrollStream(0);
    searchRef.current?.focus();
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const first = firstCell(layout);
    if (event.key === "ArrowDown" && first) {
      event.preventDefault();
      focusCell(first);
    } else if (event.key === "Enter" && searching && results[0]) {
      event.preventDefault();
      choose(results[0], "results");
    }
  };

  const onStreamKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement) || !event.target.dataset.cell) {
      return;
    }
    if (!activeCell) return;
    const next = moveCell(
      layout,
      activeCell,
      event.key,
      event.ctrlKey || event.metaKey,
    );
    const handled = [
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "End",
      "Home",
    ].includes(event.key);
    if (handled) event.preventDefault();
    if (next === "search") {
      searchRef.current?.focus();
    } else if (next) {
      focusCell(next);
    }
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.findIndex((tab) => tab.id === currentTab);
    const total = TABS.length;
    const targets: Record<string, number> = {
      ArrowLeft: (index - 1 + total) % total,
      ArrowRight: (index + 1) % total,
      End: total - 1,
      Home: 0,
    };
    const nextIndex = targets[event.key];
    if (nextIndex === undefined) return;
    event.preventDefault();
    const next = TABS[nextIndex]?.id ?? "smileys";
    jumpTo(next);
    tabRefs.current.get(next)?.focus();
  };

  const scrollTabs = (direction: -1 | 1) => {
    const strip = stripRef.current;
    if (!strip) return;
    strip.scrollLeft += direction * Math.max(64, strip.clientWidth * 0.6);
  };

  const onPopoverKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose(true);
  };

  const windowStart = windowTop - OVERSCAN;
  const windowEnd = windowTop + viewport + WINDOW_STEP + OVERSCAN;
  const rowsFor = (section: LayoutSection) => {
    if (section.rows === 0) return [];
    const base = section.top + HEADER_HEIGHT;
    const first = Math.max(0, Math.floor((windowStart - base) / ROW_HEIGHT));
    const last = Math.min(
      section.rows - 1,
      Math.floor((windowEnd - base) / ROW_HEIGHT),
    );
    const rows: number[] = [];
    for (let row = first; row <= last; row += 1) rows.push(row);
    if (activeCell?.section === section.id) {
      const activeRow = Math.floor(activeCell.index / GRID_COLUMNS);
      if (activeRow < first || activeRow > last) rows.push(activeRow);
    }
    return rows;
  };

  const sectionTitle = (section: LayoutSection) =>
    section.id === "results"
      ? t("media.chat.emoji.results", { count: results.length })
      : t(SECTION_LABELS[section.id]);
  const labelFor = (entry: ClassroomEmojiEntry) =>
    language === "vi" ? entry.vi : entry.en;

  return (
    <div
      aria-label={t("media.chat.emoji.title")}
      className="classroom-chat-emoji__popover"
      id={id}
      onKeyDown={onPopoverKeyDown}
      role="dialog"
    >
      <div className="classroom-chat-emoji__search-bar">
        <Search
          aria-hidden="true"
          className="classroom-chat-emoji__search-icon"
        />
        <input
          aria-label={t("media.chat.emoji.search")}
          autoComplete="off"
          className="classroom-chat-emoji__search"
          enterKeyHint="search"
          onChange={onSearchChange}
          onKeyDown={onSearchKeyDown}
          placeholder={t("media.chat.emoji.searchPlaceholder")}
          ref={searchRef}
          spellCheck={false}
          type="search"
          value={query}
        />
        {query !== "" && (
          <button
            aria-label={t("media.chat.emoji.clearSearch")}
            className="classroom-chat-emoji__clear"
            onClick={clearSearch}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        )}
      </div>

      <div
        className="classroom-chat-emoji__stream"
        data-searching={searching || undefined}
        onKeyDown={onStreamKeyDown}
        onScroll={onStreamScroll}
        ref={scrollerRef}
      >
        {catalogState.status === "loading" && (
          <div className="classroom-chat-emoji__state" role="status">
            <span aria-hidden="true" className="classroom-chat-emoji__skeleton">
              {Array.from({ length: GRID_COLUMNS * 3 }, (_, index) => (
                <span key={index} />
              ))}
            </span>
            <span>{t("media.chat.emoji.loading")}</span>
          </div>
        )}
        {catalogState.status === "error" && (
          <div className="classroom-chat-emoji__state" role="alert">
            <span>{t("media.chat.emoji.loadFailed")}</span>
            <button
              className="classroom-chat-emoji__retry"
              onClick={retryCatalog}
              type="button"
            >
              {t("media.chat.emoji.retry")}
            </button>
          </div>
        )}
        {catalog && searching && results.length === 0 && (
          <p className="classroom-chat-emoji__empty">
            {t("media.chat.emoji.empty")}
          </p>
        )}
        {catalog &&
          layout.sections.map((section) => {
            const titleID = `${id}-title-${section.id}`;
            return (
              <div
                aria-labelledby={titleID}
                className="classroom-chat-emoji__section"
                data-section={section.id}
                data-top={section.top}
                id={`${id}-section-${section.id}`}
                key={section.id}
                role="group"
                style={{ height: section.height }}
              >
                <h3 className="classroom-chat-emoji__heading" id={titleID}>
                  {sectionTitle(section)}
                </h3>
                {section.hint ? (
                  <p className="classroom-chat-emoji__hint">
                    {t("media.chat.emoji.recentHint")}
                  </p>
                ) : (
                  <div
                    className="classroom-chat-emoji__rows"
                    style={{ height: section.rows * ROW_HEIGHT }}
                  >
                    {rowsFor(section).map((row) => (
                      <div
                        className="classroom-chat-emoji__row"
                        key={row}
                        style={{ top: row * ROW_HEIGHT }}
                      >
                        {section.entries
                          .slice(row * GRID_COLUMNS, (row + 1) * GRID_COLUMNS)
                          .map((entry, offset) => {
                            const index = row * GRID_COLUMNS + offset;
                            const label = labelFor(entry);
                            const isActive =
                              activeCell?.section === section.id &&
                              activeCell.index === index;
                            return (
                              <button
                                aria-label={label}
                                className="classroom-chat-emoji__cell"
                                data-cell={`${section.id}:${index}`}
                                key={index}
                                onClick={() => choose(entry, section.id)}
                                onFocus={() =>
                                  setActive({ index, section: section.id })
                                }
                                tabIndex={isActive ? 0 : -1}
                                title={label}
                                type="button"
                              >
                                <span aria-hidden="true">{entry.char}</span>
                              </button>
                            );
                          })}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
      </div>
      <p aria-live="polite" className="classroom-chat__sr" role="status">
        {catalog && searching
          ? results.length > 0
            ? t("media.chat.emoji.results", { count: results.length })
            : t("media.chat.emoji.empty")
          : ""}
      </p>

      <div className="classroom-chat-emoji__nav">
        {tabOverflow.start && (
          <button
            aria-hidden="true"
            className="classroom-chat-emoji__nav-arrow"
            data-side="start"
            onClick={() => scrollTabs(-1)}
            tabIndex={-1}
            type="button"
          >
            <ChevronLeft />
          </button>
        )}
        <div
          aria-label={t("media.chat.emoji.categories")}
          className="classroom-chat-emoji__tabs"
          onScroll={updateTabOverflow}
          ref={stripRef}
          role="tablist"
        >
          {TABS.map(({ icon: Icon, id: tab }) => {
            const section = topicLayout.sections.find(
              (item) => item.id === tab,
            );
            const selected = !searching && tab === currentTab;
            const label = t(SECTION_LABELS[tab]);
            return (
              <button
                aria-controls={
                  section && !searching
                    ? `${id}-section-${section.id}`
                    : undefined
                }
                aria-label={label}
                aria-selected={selected}
                className="classroom-chat-emoji__tab"
                data-tab={tab}
                disabled={!catalog}
                key={tab}
                onClick={() => jumpTo(tab)}
                onKeyDown={onTabKeyDown}
                ref={(element) => {
                  if (element) tabRefs.current.set(tab, element);
                  else tabRefs.current.delete(tab);
                }}
                role="tab"
                tabIndex={tab === currentTab ? 0 : -1}
                title={label}
                type="button"
              >
                <Icon aria-hidden="true" />
              </button>
            );
          })}
        </div>
        {tabOverflow.end && (
          <button
            aria-hidden="true"
            className="classroom-chat-emoji__nav-arrow"
            data-side="end"
            onClick={() => scrollTabs(1)}
            tabIndex={-1}
            type="button"
          >
            <ChevronRight />
          </button>
        )}
      </div>
    </div>
  );
}
