import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  APIRequestError,
  listStickerPacks,
  type Sticker,
  type StickerEmbed,
  type StickerPack,
  type StickerPackCatalog,
} from "@tutorhub/api-client";
import { Clock, ImageOff, Search, Smile, X } from "lucide-react";
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
} from "react";
import { useI18n } from "../../app/i18n";
import { useTenantCapabilities } from "../../app/tenantCapabilities";
import {
  ClassroomEmojiPanel,
  type ClassroomEmojiPanelProps,
} from "./ClassroomEmojiPicker";
import {
  chatStickerLabel,
  loadChatStickerRecents,
  prefetchClassroomEmojiCatalog,
  recordChatStickerRecent,
  searchChatStickers,
  type ChatEmojiRecentScope,
} from "./classroomChatMedia";

/**
 * MSG-STICKER-03 (ADR-0047 §5): the composer's expression popover with a
 * WAI-ARIA `Sticker | Emoji` tablist. The Emoji tab is the existing
 * ROOM-CHAT-EMOJI-02 picker; the Sticker tab lists the server catalog
 * (`GET /api/v1/conversations/sticker-packs`) and sends a sticker the moment
 * one is picked, without touching the typed draft. When `chat_stickers` is
 * off (capability or 403) the popover is the Emoji picker alone.
 *
 * CPU guard: grid tiles show the static first frame and play the animation
 * only while hovered or keyboard-focused, never under reduced motion.
 */

type ExpressionTab = "sticker" | "emoji";

const GRID_COLUMNS = 4;
const TILE_SIZE = 64;
const SKELETON_TILES = 12;
const STICKER_CATALOG_STALE_MS = 5 * 60 * 1000;

/** The last tab used in this browser session (sessionStorage, no PII). */
const EXPRESSION_TAB_SESSION_KEY = "tutorhub:chat-expression-tab:v1";

function loadExpressionTab(): ExpressionTab {
  try {
    return sessionStorage.getItem(EXPRESSION_TAB_SESSION_KEY) === "sticker"
      ? "sticker"
      : "emoji";
  } catch {
    return "emoji";
  }
}

function saveExpressionTab(tab: ExpressionTab) {
  try {
    sessionStorage.setItem(EXPRESSION_TAB_SESSION_KEY, tab);
  } catch {
    // Blocked storage only forgets the tab.
  }
}

function isFocusVisible(element: Element) {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

function getApiBaseUrl() {
  return import.meta.env.VITE_API_BASE_URL ?? "/api";
}

function stickerPackQueryKey(tenantID: string) {
  return ["conversations", tenantID, "sticker-packs"] as const;
}

function stickerCatalogQuery(tenantID: string) {
  return {
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      listStickerPacks(tenantID, { baseUrl: getApiBaseUrl(), signal }),
    queryKey: stickerPackQueryKey(tenantID),
    retry: (failureCount: number, error: Error) =>
      !(error instanceof APIRequestError && error.status < 500) &&
      failureCount < 2,
    staleTime: STICKER_CATALOG_STALE_MS,
  };
}

function isFeatureDisabled(error: unknown) {
  return (
    error instanceof APIRequestError &&
    (error.problem?.code === "feature_disabled" || error.status === 403)
  );
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let query: MediaQueryList;
    try {
      query = window.matchMedia("(prefers-reduced-motion: reduce)");
    } catch {
      return undefined;
    }
    const update = () => setReduced(query.matches);
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

export interface ChatExpressionPickerProps {
  /** Clicks inside this element (the composer card) keep the popover open. */
  boundaryRef?: RefObject<HTMLElement | null>;
  /** Focus target after a sticker is sent (the composer textarea). */
  composerRef?: RefObject<HTMLElement | null>;
  disabled?: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectEmoji: (emoji: string) => void;
  /** Sends one sticker message; the caller owns pending/error/retry UI. */
  onSendSticker: (sticker: Sticker) => void;
  open: boolean;
  /** Read-only conversation or paused room chat: stickers are disabled. */
  readOnly?: boolean;
  /** `(tenant, user)` scope of the device-local "Recent" rows. */
  recentScope: ChatEmojiRecentScope | null;
  tenantID: string;
}

export function ChatExpressionPicker({
  boundaryRef,
  composerRef,
  disabled = false,
  onOpenChange,
  onSelectEmoji,
  onSendSticker,
  open,
  readOnly = false,
  recentScope,
  tenantID,
}: ChatExpressionPickerProps) {
  const { t } = useI18n();
  const id = useId();
  const queryClient = useQueryClient();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef(new Map<ExpressionTab, HTMLButtonElement>());
  const popoverID = `${id}-popover`;

  const capabilities = useTenantCapabilities(tenantID || undefined);
  const capabilityOn =
    capabilities.data?.features.chat_stickers?.enabled === true;
  const stickers = useQuery({
    ...stickerCatalogQuery(tenantID),
    enabled: open && capabilityOn && Boolean(tenantID),
  });
  const stickersAvailable = capabilityOn && !isFeatureDisabled(stickers.error);

  const [tab, setTabState] = useState<ExpressionTab>(loadExpressionTab);
  const [enteredFromTab, setEnteredFromTab] = useState(false);
  const activeTab: ExpressionTab = stickersAvailable ? tab : "emoji";
  const selectTab = (next: ExpressionTab) => {
    saveExpressionTab(next);
    setTabState(next);
    setEnteredFromTab(true);
  };

  const prefetch = useCallback(() => {
    prefetchClassroomEmojiCatalog();
    if (capabilityOn && tenantID) {
      void queryClient.prefetchQuery(stickerCatalogQuery(tenantID));
    }
  }, [capabilityOn, queryClient, tenantID]);

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

  const sendSticker = (sticker: Sticker) => {
    onOpenChange(false);
    onSendSticker(sticker);
    const target = composerRef?.current ?? triggerRef.current;
    window.requestAnimationFrame(() => target?.focus());
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const order: ExpressionTab[] = ["sticker", "emoji"];
    const index = order.indexOf(activeTab);
    const targets: Record<string, ExpressionTab | undefined> = {
      ArrowLeft: order[(index + order.length - 1) % order.length],
      ArrowRight: order[(index + 1) % order.length],
      End: order[order.length - 1],
      Home: order[0],
    };
    const next = targets[event.key];
    if (!next) return;
    event.preventDefault();
    selectTab(next);
    tabRefs.current.get(next)?.focus();
  };

  const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  };

  const label = t("media.chat.emoji.open");
  const emojiPanel = (
    props: Pick<
      ClassroomEmojiPanelProps,
      "autoFocusSearch" | "embedded" | "id" | "labelledBy"
    >,
  ) => (
    <ClassroomEmojiPanel
      {...props}
      onClose={close}
      onSelect={onSelectEmoji}
      recentScope={recentScope}
    />
  );

  const tabID = (value: ExpressionTab) => `${id}-tab-${value}`;
  const panelID = (value: ExpressionTab) => `${id}-panel-${value}`;
  return (
    <div className="classroom-chat-emoji chat-expression" ref={rootRef}>
      <button
        aria-controls={open ? popoverID : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        className="classroom-chat-tool"
        data-tooltip={label}
        disabled={disabled}
        onClick={() => {
          if (open) {
            close(true);
            return;
          }
          setEnteredFromTab(false);
          onOpenChange(true);
        }}
        onFocus={prefetch}
        onPointerEnter={prefetch}
        ref={triggerRef}
        type="button"
      >
        <Smile aria-hidden="true" />
      </button>
      {open &&
        (stickersAvailable ? (
          <div
            aria-label={t("media.chat.expression.title")}
            className="classroom-chat-emoji__popover chat-expression__popover"
            id={popoverID}
            onKeyDown={onDialogKeyDown}
            role="dialog"
          >
            <div
              aria-label={t("media.chat.expression.tabs")}
              className="chat-expression__tabs"
              role="tablist"
            >
              {(["sticker", "emoji"] as const).map((value) => (
                <button
                  aria-controls={panelID(value)}
                  aria-selected={activeTab === value}
                  className="chat-expression__tab"
                  id={tabID(value)}
                  key={value}
                  onClick={() => selectTab(value)}
                  onKeyDown={onTabKeyDown}
                  ref={(element) => {
                    if (element) tabRefs.current.set(value, element);
                    else tabRefs.current.delete(value);
                  }}
                  role="tab"
                  tabIndex={activeTab === value ? 0 : -1}
                  type="button"
                >
                  {t(
                    value === "sticker"
                      ? "media.chat.expression.tabSticker"
                      : "media.chat.expression.tabEmoji",
                  )}
                </button>
              ))}
            </div>
            {activeTab === "sticker" ? (
              <StickerPanel
                autoFocusSearch={!enteredFromTab}
                catalog={stickers.data}
                error={stickers.isError}
                id={panelID("sticker")}
                labelledBy={tabID("sticker")}
                loading={stickers.isPending}
                onRetry={() => void stickers.refetch()}
                onSend={sendSticker}
                readOnly={readOnly}
                recentScope={recentScope}
              />
            ) : (
              emojiPanel({
                autoFocusSearch: !enteredFromTab,
                embedded: true,
                id: panelID("emoji"),
                labelledBy: tabID("emoji"),
              })
            )}
          </div>
        ) : (
          emojiPanel({ id: popoverID })
        ))}
    </div>
  );
}

/* ---- Sticker tab ----------------------------------------------------- */

interface StickerSection {
  id: string;
  stickers: readonly Sticker[];
  title: string;
}

interface CellPosition {
  index: number;
  section: number;
}

function StickerPanel({
  autoFocusSearch,
  catalog,
  error,
  id,
  labelledBy,
  loading,
  onRetry,
  onSend,
  readOnly,
  recentScope,
}: {
  autoFocusSearch: boolean;
  catalog: StickerPackCatalog | undefined;
  error: boolean;
  id: string;
  labelledBy: string;
  loading: boolean;
  onRetry: () => void;
  onSend: (sticker: Sticker) => void;
  readOnly: boolean;
  recentScope: ChatEmojiRecentScope | null;
}) {
  const { language, t } = useI18n();
  const reducedMotion = usePrefersReducedMotion();
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState(() =>
    loadChatStickerRecents(recentScope),
  );
  const [active, setActive] = useState<CellPosition | null>(null);
  const [animated, setAnimated] = useState<string | null>(null);
  const [currentPack, setCurrentPack] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const hintID = `${id}-hint`;

  const packs = useMemo<readonly StickerPack[]>(
    () => catalog?.packs ?? [],
    [catalog],
  );
  const allStickers = useMemo(
    () => packs.flatMap((pack) => pack.stickers),
    [packs],
  );
  const byID = useMemo(
    () => new Map(allStickers.map((sticker) => [sticker.id, sticker])),
    [allStickers],
  );
  const trimmed = query.trim();
  const searching = trimmed.length > 0;
  const results = useMemo(
    () => (searching ? searchChatStickers(allStickers, trimmed) : []),
    [allStickers, searching, trimmed],
  );
  const sections = useMemo<StickerSection[]>(() => {
    if (searching) {
      return results.length > 0
        ? [
            {
              id: "results",
              stickers: results,
              title: t("media.chat.sticker.results", { count: results.length }),
            },
          ]
        : [];
    }
    const list: StickerSection[] = [];
    const recentStickers = recents.flatMap((stickerID) => {
      const sticker = byID.get(stickerID);
      return sticker ? [sticker] : [];
    });
    if (recentStickers.length > 0) {
      list.push({
        id: "recent",
        stickers: recentStickers,
        title: t("media.chat.sticker.recent"),
      });
    }
    for (const pack of packs) {
      list.push({
        id: `pack-${pack.id}`,
        stickers: pack.stickers,
        title: chatStickerLabel(pack.title, language),
      });
    }
    return list;
  }, [byID, language, packs, recents, results, searching, t]);

  const activeCell: CellPosition | null =
    active && sections[active.section]
      ? {
          index: Math.min(
            active.index,
            (sections[active.section]?.stickers.length ?? 1) - 1,
          ),
          section: active.section,
        }
      : sections.length > 0
        ? { index: 0, section: 0 }
        : null;

  useEffect(() => {
    if (autoFocusSearch) searchRef.current?.focus();
    // Only on mount, like the Emoji tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    pendingFocus.current = null;
    streamRef.current
      ?.querySelector<HTMLButtonElement>(`[data-cell="${key}"]`)
      ?.focus();
  });

  const cellKey = (position: CellPosition) =>
    `${position.section}:${position.index}`;

  const focusCell = (position: CellPosition) => {
    setActive(position);
    pendingFocus.current = cellKey(position);
  };

  const choose = (sticker: Sticker) => {
    if (readOnly) return;
    // Written now: sending closes the popover before any state update runs.
    setRecents(recordChatStickerRecent(recentScope, recents, sticker.id));
    onSend(sticker);
  };

  const move = (
    from: CellPosition,
    key: string,
  ): CellPosition | "search" | null => {
    const section = sections[from.section];
    if (!section) return null;
    const count = section.stickers.length;
    const column = from.index % GRID_COLUMNS;
    switch (key) {
      case "ArrowRight":
        if (from.index + 1 < count) return { ...from, index: from.index + 1 };
        return sections[from.section + 1]
          ? { index: 0, section: from.section + 1 }
          : null;
      case "ArrowLeft":
        if (from.index > 0) return { ...from, index: from.index - 1 };
        if (from.section > 0) {
          const previous = sections[from.section - 1];
          return previous
            ? { index: previous.stickers.length - 1, section: from.section - 1 }
            : null;
        }
        return null;
      case "ArrowDown": {
        if (from.index + GRID_COLUMNS < count) {
          return { ...from, index: from.index + GRID_COLUMNS };
        }
        const lastRowStart = count - ((count - 1) % GRID_COLUMNS) - 1;
        if (from.index < lastRowStart) {
          return { ...from, index: count - 1 };
        }
        const next = sections[from.section + 1];
        return next
          ? {
              index: Math.min(column, next.stickers.length - 1),
              section: from.section + 1,
            }
          : null;
      }
      case "ArrowUp": {
        if (from.index - GRID_COLUMNS >= 0) {
          return { ...from, index: from.index - GRID_COLUMNS };
        }
        const previous = sections[from.section - 1];
        if (!previous) return "search";
        const previousCount = previous.stickers.length;
        const lastRow = Math.floor((previousCount - 1) / GRID_COLUMNS);
        return {
          index: Math.min(lastRow * GRID_COLUMNS + column, previousCount - 1),
          section: from.section - 1,
        };
      }
      case "Home":
        return { ...from, index: from.index - column };
      case "End":
        return {
          ...from,
          index: Math.min(from.index - column + GRID_COLUMNS - 1, count - 1),
        };
      default:
        return null;
    }
  };

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement) || !event.target.dataset.cell) {
      return;
    }
    if (!activeCell) return;
    const handled = [
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "End",
      "Home",
    ].includes(event.key);
    if (!handled) return;
    event.preventDefault();
    const next = move(activeCell, event.key);
    if (next === "search") searchRef.current?.focus();
    else if (next) focusCell(next);
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && sections.length > 0) {
      event.preventDefault();
      focusCell({ index: 0, section: 0 });
    } else if (event.key === "Enter" && searching && results[0]) {
      event.preventDefault();
      choose(results[0]);
    }
  };

  const onSearchChange = (event: ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
    setActive(null);
    streamRef.current?.scrollTo?.({ top: 0 });
  };

  const jumpToPack = (sectionID: string) => {
    setQuery("");
    setCurrentPack(sectionID);
    window.requestAnimationFrame(() => {
      const target = streamRef.current?.querySelector<HTMLElement>(
        `[data-section="${sectionID}"]`,
      );
      if (target && streamRef.current) {
        streamRef.current.scrollTop = target.offsetTop;
      }
    });
  };

  const stripSections = searching
    ? []
    : sections.filter((section) => section.id !== "results");
  const selectedStrip =
    currentPack && stripSections.some((section) => section.id === currentPack)
      ? currentPack
      : stripSections[0]?.id;

  return (
    <div
      aria-labelledby={labelledBy}
      className="chat-sticker"
      id={id}
      role="tabpanel"
    >
      <div className="classroom-chat-emoji__search-bar">
        <Search
          aria-hidden="true"
          className="classroom-chat-emoji__search-icon"
        />
        <input
          aria-describedby={hintID}
          aria-label={t("media.chat.sticker.search")}
          autoComplete="off"
          className="classroom-chat-emoji__search"
          disabled={!catalog}
          enterKeyHint="search"
          onChange={onSearchChange}
          onKeyDown={onSearchKeyDown}
          placeholder={t("media.chat.sticker.searchPlaceholder")}
          ref={searchRef}
          spellCheck={false}
          type="search"
          value={query}
        />
        {query !== "" && (
          <button
            aria-label={t("media.chat.sticker.clearSearch")}
            className="classroom-chat-emoji__clear"
            onClick={() => {
              setQuery("");
              setActive(null);
              searchRef.current?.focus();
            }}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        )}
      </div>
      <p className="classroom-chat__sr visually-hidden" id={hintID}>
        {t("media.chat.sticker.hint")}
      </p>
      <div
        className="chat-sticker__stream"
        onKeyDown={onGridKeyDown}
        ref={streamRef}
      >
        {readOnly && (
          <p className="chat-sticker__notice" role="status">
            {t("media.chat.sticker.readOnly")}
          </p>
        )}
        {loading && (
          <div className="chat-sticker__state" role="status">
            <span aria-hidden="true" className="chat-sticker__skeleton">
              {Array.from({ length: SKELETON_TILES }, (_, index) => (
                <span key={index} />
              ))}
            </span>
            <span>{t("media.chat.sticker.loading")}</span>
          </div>
        )}
        {error && !catalog && (
          <div className="chat-sticker__state" role="alert">
            <span>{t("media.chat.sticker.loadFailed")}</span>
            <button
              className="classroom-chat-emoji__retry"
              onClick={onRetry}
              type="button"
            >
              {t("media.chat.sticker.retry")}
            </button>
          </div>
        )}
        {catalog && searching && results.length === 0 && (
          <p className="chat-sticker__empty">{t("media.chat.sticker.empty")}</p>
        )}
        {catalog &&
          sections.map((section, sectionIndex) => {
            const titleID = `${id}-section-${section.id}`;
            return (
              <div
                aria-labelledby={titleID}
                className="chat-sticker__section"
                data-section={section.id}
                key={section.id}
                role="group"
              >
                <h3 className="chat-sticker__heading" id={titleID}>
                  {section.title}
                </h3>
                <div className="chat-sticker__grid">
                  {section.stickers.map((sticker, index) => {
                    const label = chatStickerLabel(sticker.labels, language);
                    const key = `${sectionIndex}:${index}`;
                    const isActive =
                      activeCell?.section === sectionIndex &&
                      activeCell.index === index;
                    const playing =
                      !reducedMotion && sticker.animated && animated === key;
                    return (
                      <button
                        aria-disabled={readOnly || undefined}
                        aria-label={label}
                        className="chat-sticker__cell"
                        data-cell={key}
                        key={sticker.id}
                        onBlur={() =>
                          setAnimated((current) =>
                            current === key ? null : current,
                          )
                        }
                        onClick={() => choose(sticker)}
                        onFocus={(event) => {
                          setActive({ index, section: sectionIndex });
                          if (isFocusVisible(event.currentTarget)) {
                            setAnimated(key);
                          }
                        }}
                        onPointerEnter={() => setAnimated(key)}
                        onPointerLeave={() =>
                          setAnimated((current) =>
                            current === key ? null : current,
                          )
                        }
                        tabIndex={isActive ? 0 : -1}
                        title={label}
                        type="button"
                      >
                        <img
                          alt=""
                          decoding="async"
                          draggable={false}
                          height={TILE_SIZE}
                          loading="lazy"
                          src={
                            playing
                              ? sticker.asset.animated_url
                              : sticker.asset.static_url
                          }
                          width={TILE_SIZE}
                        />
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
      </div>
      <p aria-live="polite" className="classroom-chat__sr visually-hidden">
        {catalog && searching
          ? results.length > 0
            ? t("media.chat.sticker.results", { count: results.length })
            : t("media.chat.sticker.empty")
          : ""}
      </p>
      {catalog && (
        <div className="chat-sticker__footer">
          <div
            aria-label={t("media.chat.sticker.packs")}
            className="chat-sticker__packs"
            role="group"
          >
            {stripSections.map((section) => {
              const first = section.stickers[0];
              return (
                <button
                  aria-label={section.title}
                  aria-pressed={selectedStrip === section.id}
                  className="chat-sticker__pack"
                  key={section.id}
                  onClick={() => jumpToPack(section.id)}
                  title={section.title}
                  type="button"
                >
                  {section.id === "recent" || !first ? (
                    <Clock aria-hidden="true" />
                  ) : (
                    <img
                      alt=""
                      decoding="async"
                      height={24}
                      src={first.asset.static_url}
                      width={24}
                    />
                  )}
                </button>
              );
            })}
          </div>
          {packs.map((pack) => (
            <p className="chat-sticker__credits" key={pack.id}>
              <span>
                {chatStickerLabel(pack.title, language)} ·{" "}
                {pack.attribution.license}
              </span>
              <a
                aria-label={t("media.chat.sticker.creditsLabel", {
                  license: pack.attribution.license,
                  title: chatStickerLabel(pack.title, language),
                })}
                href={pack.attribution.notices_path}
                rel="noopener"
                target="_blank"
              >
                {t("media.chat.sticker.credits")}
              </a>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---- In-thread sticker ------------------------------------------------ */

/**
 * A sticker message: borderless artwork with explicit dimensions (CLS 0).
 * Reduced motion always gets the static frame through `<picture>`; an
 * IntersectionObserver swaps stickers outside the viewport back to the
 * static frame so long threads never decode many animations at once.
 */
export function ChatStickerView({
  embed,
  size = 136,
}: {
  embed: StickerEmbed;
  size?: number;
}) {
  const { language, t } = useI18n();
  const imageRef = useRef<HTMLImageElement>(null);
  const [inView, setInView] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  const asset = embed.available ? embed.asset : undefined;
  const labels = embed.available ? embed.labels : undefined;

  useEffect(() => {
    const image = imageRef.current;
    if (!image || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setInView(entry.isIntersecting);
      },
      { rootMargin: "48px" },
    );
    observer.observe(image);
    return () => observer.disconnect();
  }, [asset]);

  if (!asset || !labels) {
    return (
      <p className="chat-sticker-message chat-sticker-message--unavailable">
        <ImageOff aria-hidden="true" />
        <span>{t("conversations.stickerUnavailable")}</span>
      </p>
    );
  }
  const label = chatStickerLabel(labels, language);
  return (
    <picture className="chat-sticker-message">
      <source
        media="(prefers-reduced-motion: reduce)"
        srcSet={asset.static_url}
      />
      <img
        alt={label}
        className="chat-sticker-message__image"
        data-playing={inView ? "true" : "false"}
        decoding="async"
        draggable={false}
        height={size}
        loading="lazy"
        ref={imageRef}
        src={inView ? asset.animated_url : asset.static_url}
        style={{ height: size, width: size }}
        title={label}
        width={size}
      />
    </picture>
  );
}
