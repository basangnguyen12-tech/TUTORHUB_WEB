import { Smile } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useI18n, type TranslationKey } from "../../app/i18n";
import {
  CLASSROOM_EMOJI,
  CLASSROOM_EMOJI_CATEGORIES,
  searchClassroomEmoji,
  type ClassroomEmojiCategory,
} from "./classroomChatMedia";

/**
 * ROOM-CHAT-01: dependency-free emoji popover for the classroom composer.
 * Four classroom-first categories, bilingual search, a roving 8-column grid
 * and Escape / outside-click dismissal that returns focus to the trigger.
 */

const GRID_COLUMNS = 8;

const CATEGORY_LABELS: Record<ClassroomEmojiCategory, TranslationKey> = {
  class: "media.chat.emoji.category.class",
  smileys: "media.chat.emoji.category.smileys",
  gestures: "media.chat.emoji.category.gestures",
  symbols: "media.chat.emoji.category.symbols",
};

const CATEGORY_ICONS: Record<ClassroomEmojiCategory, string> = {
  class: "📚",
  smileys: "😊",
  gestures: "👍",
  symbols: "➗",
};

export function ClassroomEmojiPicker({
  disabled = false,
  onSelect,
}: {
  disabled?: boolean;
  onSelect: (emoji: string) => void;
}) {
  const { language, t } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<ClassroomEmojiCategory>("class");
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Map<ClassroomEmojiCategory, HTMLButtonElement>>(
    new Map(),
  );

  const entries = useMemo(
    () =>
      query.trim() ? searchClassroomEmoji(query) : CLASSROOM_EMOJI[category],
    [category, query],
  );
  const effectiveActiveIndex = Math.min(
    activeIndex,
    Math.max(0, entries.length - 1),
  );

  const close = (restoreFocus = true) => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return undefined;
    searchRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !rootRef.current?.contains(target)) {
        setOpen(false);
        setQuery("");
        setActiveIndex(0);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const focusCell = (index: number) => {
    setActiveIndex(index);
    globalThis.requestAnimationFrame(() => {
      gridRef.current
        ?.querySelector<HTMLButtonElement>(`[data-emoji-index="${index}"]`)
        ?.focus();
    });
  };

  const choose = (emoji: string) => {
    onSelect(emoji);
    close(false);
  };

  const onPopoverKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = entries.length - 1;
    if (last < 0) return;
    let next: number;
    switch (event.key) {
      case "ArrowRight":
        next = Math.min(last, effectiveActiveIndex + 1);
        break;
      case "ArrowLeft":
        next = Math.max(0, effectiveActiveIndex - 1);
        break;
      case "ArrowDown":
        next = Math.min(last, effectiveActiveIndex + GRID_COLUMNS);
        break;
      case "ArrowUp":
        if (effectiveActiveIndex < GRID_COLUMNS) {
          event.preventDefault();
          searchRef.current?.focus();
          return;
        }
        next = effectiveActiveIndex - GRID_COLUMNS;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    focusCell(next);
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && entries.length > 0) {
      event.preventDefault();
      focusCell(0);
    } else if (event.key === "Enter" && entries[0]) {
      event.preventDefault();
      choose(entries[0].char);
    }
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = CLASSROOM_EMOJI_CATEGORIES.indexOf(category);
    const total = CLASSROOM_EMOJI_CATEGORIES.length;
    const targets: Record<string, number> = {
      ArrowLeft: (index - 1 + total) % total,
      ArrowRight: (index + 1) % total,
      End: total - 1,
      Home: 0,
    };
    const nextIndex = targets[event.key];
    if (nextIndex === undefined) return;
    event.preventDefault();
    const next = CLASSROOM_EMOJI_CATEGORIES[nextIndex] ?? "class";
    setCategory(next);
    setQuery("");
    setActiveIndex(0);
    tabRefs.current.get(next)?.focus();
  };

  const label = t("media.chat.emoji.open");
  const panelID = `${id}-panel`;
  const gridLabel = query.trim()
    ? t("media.chat.emoji.results", { count: entries.length })
    : t(CATEGORY_LABELS[category]);

  return (
    <div className="classroom-chat-emoji" ref={rootRef}>
      <button
        aria-controls={open ? `${id}-popover` : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        className="classroom-chat-tool"
        data-tooltip={label}
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
        ref={triggerRef}
        type="button"
      >
        <Smile aria-hidden="true" />
      </button>
      {open && (
        <div
          aria-label={t("media.chat.emoji.title")}
          className="classroom-chat-emoji__popover"
          id={`${id}-popover`}
          onKeyDown={onPopoverKeyDown}
          role="dialog"
        >
          <input
            aria-label={t("media.chat.emoji.search")}
            autoComplete="off"
            className="classroom-chat-emoji__search"
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onSearchKeyDown}
            placeholder={t("media.chat.emoji.search")}
            ref={searchRef}
            type="search"
            value={query}
          />
          <div
            aria-label={t("media.chat.emoji.categories")}
            className="classroom-chat-emoji__tabs"
            role="tablist"
          >
            {CLASSROOM_EMOJI_CATEGORIES.map((item) => {
              const selected = !query.trim() && item === category;
              return (
                <button
                  aria-controls={panelID}
                  aria-label={t(CATEGORY_LABELS[item])}
                  aria-selected={selected}
                  className="classroom-chat-emoji__tab"
                  data-tooltip={t(CATEGORY_LABELS[item])}
                  key={item}
                  onClick={() => {
                    setCategory(item);
                    setQuery("");
                    setActiveIndex(0);
                  }}
                  onKeyDown={onTabKeyDown}
                  ref={(element) => {
                    if (element) tabRefs.current.set(item, element);
                    else tabRefs.current.delete(item);
                  }}
                  role="tab"
                  tabIndex={item === category ? 0 : -1}
                  type="button"
                >
                  <span aria-hidden="true">{CATEGORY_ICONS[item]}</span>
                </button>
              );
            })}
          </div>
          <div
            aria-label={gridLabel}
            className="classroom-chat-emoji__panel"
            id={panelID}
            role="tabpanel"
          >
            <p className="classroom-chat-emoji__heading" aria-hidden="true">
              {gridLabel}
            </p>
            {entries.length === 0 ? (
              <p className="classroom-chat-emoji__empty" role="status">
                {t("media.chat.emoji.empty")}
              </p>
            ) : (
              <div
                className="classroom-chat-emoji__grid"
                onKeyDown={onGridKeyDown}
                ref={gridRef}
                role="group"
                aria-label={gridLabel}
              >
                {entries.map((entry, index) => (
                  <button
                    aria-label={language === "vi" ? entry.vi : entry.en}
                    className="classroom-chat-emoji__cell"
                    data-emoji-index={index}
                    key={entry.char}
                    onClick={() => choose(entry.char)}
                    onFocus={() => setActiveIndex(index)}
                    tabIndex={index === effectiveActiveIndex ? 0 : -1}
                    title={language === "vi" ? entry.vi : entry.en}
                    type="button"
                  >
                    {entry.char}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
