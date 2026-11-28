import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import {
  APIRequestError,
  type Conversation,
  type Message,
  type MessagePage,
  type TenantCapabilities,
} from "@tutorhub/api-client";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  EmptyState,
  ErrorState,
  ForbiddenState,
  IconButton,
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
  Skeleton,
  SkeletonGroup,
  TextField,
} from "@tutorhub/ui";
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronDown,
  Mail,
  MessageSquarePlus,
  Pin,
  PinOff,
  RefreshCw,
  School,
  Search,
  X,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router";
import {
  type ClassCoverTheme,
  useClassroomPreferences,
} from "../app/classroomPreferences";
import {
  compactConversationTime,
  conversationFilters,
  filterConversations,
  partitionPinnedConversations,
  useConversationPreferences,
  type ConversationFilter,
  type ConversationListSection,
} from "../app/conversationPreferences";
import {
  conversationCreationAvailability,
  conversationQueryKeys,
  useConversation,
  useConversations,
  useCreateDirectConversation,
} from "../app/conversations";
import { useI18n, type TranslationKey } from "../app/i18n";
import { useSession } from "../app/session";
import {
  useTenantCapabilities,
  type TenantOperationAvailability,
} from "../app/tenantCapabilities";
import { shouldConcealTenantScopedData } from "../app/tenantDataAccess";
import {
  ConversationAvatar,
  ConversationMessages,
} from "../components/ConversationMessages";
import { parseQuotedMessage } from "../components/ConversationQuote";
import { chatMarkupToPlainText } from "../features/chat-format/chatMarkup";
import { cardPreviewText } from "../components/conversation-composer/composerCards";
import { TenantOperationNotice } from "../components/TenantOperationNotice";
import "./ConversationsPage.css";

// MSG-WELCOME-3D-01: the welcome carousel is its own chunk and is only
// requested while the right pane is visible (desktop, >= 860px).
const MessagesWelcomeCarousel = lazy(
  () => import("../features/messages-welcome/MessagesWelcomeCarousel"),
);

const welcomePaneQuery = "(min-width: 860px)";

function subscribeWelcomePane(onChange: () => void) {
  if (typeof window.matchMedia !== "function") {
    return () => undefined;
  }
  const query = window.matchMedia(welcomePaneQuery);
  query.addEventListener?.("change", onChange);
  return () => query.removeEventListener?.("change", onChange);
}

function welcomePaneSnapshot() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia(welcomePaneQuery).matches
  );
}

function welcomePaneServerSnapshot() {
  return false;
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const filterLabels: Record<ConversationFilter, TranslationKey> = {
  all: "conversations.filterAll",
  class: "conversations.filterClass",
  direct: "conversations.filterDirect",
  room: "conversations.filterRoom",
  unread: "conversations.filterUnread",
};

function kindLabelKey(kind: Conversation["kind"]): TranslationKey {
  return kind === "class"
    ? "conversations.classKind"
    : kind === "room"
      ? "conversations.roomKind"
      : "conversations.directKind";
}

function cachedNewestMessage(
  data: InfiniteData<MessagePage> | undefined,
): Message | undefined {
  return data?.pages[0]?.items.reduce<Message | undefined>(
    (newest, item) =>
      !newest || item.sequence > newest.sequence ? item : newest,
    undefined,
  );
}

export function ConversationsPage() {
  const { conversationId } = useParams();
  const { language, t } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const session = useSession();
  const tenantID = session.currentUser?.active_tenant?.id;
  const actorID = session.currentUser?.user.id ?? "";
  const conversations = useConversations(tenantID);
  const conversation = useConversation(tenantID, conversationId);
  const capabilities = useTenantCapabilities(tenantID, Boolean(tenantID));
  const createAvailability = conversationCreationAvailability(capabilities);
  const createDirect = useCreateDirectConversation(tenantID);
  const conversationPreferences = useConversationPreferences(
    tenantID,
    actorID || undefined,
  );
  const classroomPreferences = useClassroomPreferences(
    tenantID,
    actorID || undefined,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [targetEmail, setTargetEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [createdTitle, setCreatedTitle] = useState<string | null>(null);
  const [filter, setFilter] = useState<ConversationFilter>("all");
  const [query, setQuery] = useState("");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const createTrigger = useRef<HTMLButtonElement | null>(null);
  const headerCreateButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const suppressShortcutsOnFocus = useRef(false);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const items = useMemo(() => {
    const byID = new Map<string, Conversation>();
    for (const page of conversations.data?.pages ?? []) {
      for (const item of page.items) {
        byID.set(item.id, item);
      }
    }
    return [...byID.values()];
  }, [conversations.data?.pages]);
  const formatter = useMemo(
    () =>
      new Intl.DateTimeFormat(language === "vi" ? "vi-VN" : "en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [language],
  );

  useEffect(() => {
    if (conversationId && conversation.isSuccess) {
      const frame = window.requestAnimationFrame(() => {
        detailHeading.current?.focus();
      });
      return () => window.cancelAnimationFrame(frame);
    }
    return undefined;
  }, [conversation.isSuccess, conversationId]);

  const listConcealed = shouldConcealTenantScopedData(conversations.error);
  const listForbidden =
    conversations.error instanceof APIRequestError &&
    conversations.error.status === 403;
  const initialListError =
    conversations.isError && (listConcealed || items.length === 0);
  const refreshingError =
    conversations.isError &&
    !listConcealed &&
    items.length > 0 &&
    !conversations.isFetchNextPageError;

  const unreadConversations = items.filter(
    (item) => item.unread_count > 0,
  ).length;
  const hasRoomConversations = items.some((item) => item.kind === "room");
  const visibleFilters = conversationFilters.filter(
    (value) => value !== "room" || hasRoomConversations || filter === "room",
  );
  const tabFilters = visibleFilters.filter(
    (value) => value === "all" || value === "unread",
  );
  const categoryFilters = visibleFilters.filter(
    (value) => value !== "all" && value !== "unread",
  );
  const activeCategory = categoryFilters.find((value) => value === filter);
  const filtered = useMemo(
    () => filterConversations(items, filter, query),
    [filter, items, query],
  );
  const searching = query.trim().length > 0;
  // MSG-AVATAR-SEARCH-CLASSIN-01 (ClassIn ref-05): a focused, empty search
  // swaps the chips and the list for a full-height shortcut panel. While a
  // query is typed the chips and results come back, with the shortcuts at the
  // end of the scrolling results.
  const panelOpen = shortcutsOpen && !searching;
  const { pinned: pinnedItems, others: otherItems } =
    partitionPinnedConversations(
      filtered,
      conversationPreferences.preferences.pinned,
    );
  const grouped = filter === "all" && !searching && pinnedItems.length > 0;
  const now = new Date();

  const openCreate = (event: MouseEvent<HTMLButtonElement>) => {
    createTrigger.current = event.currentTarget;
    setCreatedTitle(null);
    setCreateOpen(true);
  };

  const openCreateFromShortcut = () => {
    // The shortcut panel closes with the dialog, so focus returns to the
    // header button that owns "Start a conversation".
    createTrigger.current = headerCreateButton.current;
    const candidate = query.trim().toLowerCase();
    setTargetEmail(emailPattern.test(candidate) ? candidate : "");
    setEmailError(null);
    setCreatedTitle(null);
    setShortcutsOpen(false);
    setCreateOpen(true);
  };

  const focusSearchQuietly = () => {
    suppressShortcutsOnFocus.current = true;
    searchInput.current?.focus();
    suppressShortcutsOnFocus.current = false;
  };

  /** ✕ and Escape leave search mode: the normal chips and list come back. */
  const closeSearch = () => {
    setQuery("");
    setShortcutsOpen(false);
    focusSearchQuietly();
  };

  const handleSearchAreaKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && (shortcutsOpen || query)) {
      event.preventDefault();
      closeSearch();
    }
  };

  const handleSearchAreaBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
      setShortcutsOpen(false);
    }
  };

  // A click on the panel's empty space must not blur the search and close it.
  const keepSearchFocus = (event: MouseEvent<HTMLDivElement>) => {
    if (
      !(event.target instanceof Element) ||
      !event.target.closest("a, button")
    ) {
      event.preventDefault();
    }
  };

  const renderShortcuts = (placement: "panel" | "results") => {
    const titleID = `conversation-shortcuts-title-${placement}`;
    return (
      <div
        className={`conversation-shortcuts conversation-shortcuts--${placement}${
          placement === "panel" ? " scroll-autohide" : ""
        }`}
        onMouseDown={placement === "panel" ? keepSearchFocus : undefined}
      >
        <p className="conversation-shortcuts__title" id={titleID}>
          {t("conversations.shortcutsTitle")}
        </p>
        <ul aria-labelledby={titleID}>
          <li>
            <button
              className="conversation-shortcut"
              disabled={!createAvailability.available}
              onClick={openCreateFromShortcut}
              type="button"
            >
              <span aria-hidden="true" className="conversation-shortcut__icon">
                <Mail />
              </span>
              <span className="conversation-shortcut__text">
                <strong>{t("conversations.shortcutDirect")}</strong>
                <span>{t("conversations.shortcutDirectHint")}</span>
              </span>
              <ArrowUpRight
                aria-hidden="true"
                className="conversation-shortcut__arrow"
              />
            </button>
          </li>
          <li>
            <Link className="conversation-shortcut" to="/app/classrooms">
              <span aria-hidden="true" className="conversation-shortcut__icon">
                <School />
              </span>
              <span className="conversation-shortcut__text">
                <strong>{t("conversations.shortcutClasses")}</strong>
                <span>{t("conversations.shortcutClassesHint")}</span>
              </span>
              <ArrowUpRight
                aria-hidden="true"
                className="conversation-shortcut__arrow"
              />
            </Link>
          </li>
        </ul>
      </div>
    );
  };

  const submitDirect = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedEmail = targetEmail.trim().toLowerCase();
    if (!normalizedEmail) {
      setEmailError(t("conversations.targetEmailRequired"));
      return;
    }
    if (!emailPattern.test(normalizedEmail)) {
      setEmailError(t("conversations.targetEmailInvalid"));
      return;
    }
    setEmailError(null);
    createDirect.mutate(
      { target_member_email: normalizedEmail },
      {
        onSuccess: (created) => {
          setCreateOpen(false);
          setTargetEmail("");
          setCreatedTitle(created.title);
          navigate(`/app/messages/${created.id}`);
        },
      },
    );
  };

  const previewFor = (item: Conversation) => {
    if (!tenantID) {
      return null;
    }
    const newest = cachedNewestMessage(
      queryClient.getQueryData<InfiniteData<MessagePage>>(
        conversationQueryKeys.messages(tenantID, item.id),
      ),
    );
    if (!newest) {
      return null;
    }
    const text =
      newest.state === "deleted"
        ? t("conversations.messageDeleted")
        : chatMarkupToPlainText(parseQuotedMessage(newest.content).body)
            .replace(/\s+/g, " ")
            .trim() ||
          // MSG-COMPOSER-TOOLS-01: cards read as cards, not attachments.
          cardPreviewText(newest.embed, t, language) ||
          t("conversations.attachmentPreview");
    if (newest.author.user_id === actorID) {
      return `${t("conversations.youPrefix")}: ${text}`;
    }
    return item.kind === "direct"
      ? text
      : `${newest.author.display_name}: ${text}`;
  };

  const renderRow = (item: Conversation) => {
    const pinned = conversationPreferences.isPinned(item.id);
    const preview = previewFor(item);
    const kindLabel = t(kindLabelKey(item.kind));
    const unreadLabel = t("conversations.unreadBadge", {
      count: item.unread_count_capped ? "100+" : item.unread_count,
    });
    const compactUnread =
      item.unread_count_capped || item.unread_count > 99
        ? "99+"
        : String(item.unread_count);
    return (
      <li
        className="conversation-list__item"
        data-pinned={pinned ? "true" : undefined}
        key={item.id}
      >
        <NavLink
          className={({ isActive }) =>
            `conversation-list__link${
              isActive ? " conversation-list__link--active" : ""
            }`
          }
          onClick={() => setShortcutsOpen(false)}
          to={`/app/messages/${item.id}`}
        >
          <ConversationAvatar
            conversation={item}
            coverTheme={
              item.class_id
                ? classroomPreferences.coverFor(item.class_id)
                : undefined
            }
          />
          <span className="conversation-list__text">
            <span className="conversation-list__line">
              <strong className="conversation-list__title">{item.title}</strong>
              <time
                className="conversation-list__time"
                dateTime={item.updated_at}
                title={formatter.format(new Date(item.updated_at))}
              >
                {compactConversationTime(item.updated_at, now, language)}
              </time>
            </span>
            <span className="conversation-list__line">
              <span className="conversation-list__preview">
                {preview ? (
                  <>
                    <span className="visually-hidden">{kindLabel}. </span>
                    {preview}
                  </>
                ) : (
                  kindLabel
                )}
              </span>
              {item.unread_count > 0 && (
                <span className="conversation-list__unread">
                  <span aria-hidden="true">{compactUnread}</span>
                  <span className="visually-hidden">{unreadLabel}</span>
                </span>
              )}
            </span>
          </span>
        </NavLink>
        <button
          aria-label={t(pinned ? "conversations.unpin" : "conversations.pin", {
            title: item.title,
          })}
          className="conversation-list__pin"
          data-tooltip={t(
            pinned ? "conversations.unpinCurrent" : "conversations.pinCurrent",
          )}
          onClick={() => conversationPreferences.togglePin(item.id)}
          type="button"
        >
          {pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
        </button>
      </li>
    );
  };

  const renderSection = (
    section: ConversationListSection,
    label: string,
    sectionItems: readonly Conversation[],
  ) => {
    const collapsed = conversationPreferences.isCollapsed(section);
    const listID = `conversation-section-${section}`;
    return (
      <div className="conversation-section" key={section}>
        <button
          aria-controls={listID}
          aria-expanded={!collapsed}
          className="conversation-section__toggle"
          onClick={() => conversationPreferences.toggleCollapsed(section)}
          type="button"
        >
          <ChevronDown aria-hidden="true" />
          <span>{label}</span>
          <span className="conversation-section__count">
            {sectionItems.length}
          </span>
        </button>
        <ul className="conversation-list" hidden={collapsed} id={listID}>
          {sectionItems.map(renderRow)}
        </ul>
      </div>
    );
  };

  if (initialListError) {
    const State = listForbidden ? ForbiddenState : ErrorState;
    return (
      <div className="page-content conversations-page conversations-page--state">
        <State
          actions={
            <Button
              leadingIcon={<RefreshCw />}
              onClick={() => void conversations.refetch()}
              variant="secondary"
            >
              {t("state.retry")}
            </Button>
          }
          description={
            listForbidden
              ? t("conversations.forbiddenDescription")
              : t("conversations.errorDescription")
          }
          title={
            listForbidden
              ? t("conversations.forbiddenTitle")
              : t("conversations.errorTitle")
          }
        />
      </div>
    );
  }

  const listStatus =
    filter !== "all" || searching
      ? t("conversations.matchCount", { count: filtered.length })
      : t("conversations.loadedCount", { count: items.length });

  return (
    <div
      className="page-content conversations-page"
      data-view={conversationId ? "detail" : "list"}
    >
      <section
        aria-labelledby="conversations-page-title"
        className="conversation-list-panel"
      >
        <header className="conversations-page__header">
          <h1 id="conversations-page-title">{t("conversations.title")}</h1>
          <p className="visually-hidden">
            {t("conversations.headerDescription")}
          </p>
          <div className="conversations-page__header-actions">
            <IconButton
              className="conversations-page__icon-action"
              data-tooltip={t("conversations.refresh")}
              label={t("conversations.refresh")}
              loading={
                conversations.isRefetching && !conversations.isFetchingNextPage
              }
              onClick={() => void conversations.refetch()}
              size="sm"
              variant="quiet"
            >
              <RefreshCw />
            </IconButton>
            <IconButton
              className="conversations-page__icon-action"
              data-tooltip={t("conversations.createAction")}
              disabled={!createAvailability.available}
              label={t("conversations.createAction")}
              onClick={openCreate}
              ref={headerCreateButton}
              size="sm"
              variant="quiet"
            >
              <MessageSquarePlus />
            </IconButton>
          </div>
        </header>

        {createdTitle && (
          <p className="conversations-page__feedback" role="status">
            {t("conversations.created", { title: createdTitle })}
          </p>
        )}

        <TenantOperationNotice
          availability={createAvailability}
          label={t("capabilities.operationCreateConversation")}
          onRetry={() => void capabilities.refetch()}
        />

        {refreshingError && (
          <div className="conversations-page__inline-error" role="alert">
            <span>{t("conversations.refreshError")}</span>
            <Button
              onClick={() => void conversations.refetch()}
              size="sm"
              variant="secondary"
            >
              {t("state.retry")}
            </Button>
          </div>
        )}

        <div
          className="conversation-search-area"
          data-open={panelOpen ? "true" : undefined}
          onBlur={handleSearchAreaBlur}
          onKeyDown={handleSearchAreaKeyDown}
        >
          <div
            aria-label={t("conversations.searchLabel")}
            className="conversation-search"
            data-active={shortcutsOpen || searching ? "true" : undefined}
            role="search"
          >
            <Search aria-hidden="true" className="conversation-search__icon" />
            <label className="visually-hidden" htmlFor="conversation-search">
              {t("conversations.searchLabel")}
            </label>
            <input
              autoComplete="off"
              id="conversation-search"
              onChange={(event) => {
                setQuery(event.target.value);
                // Only a focused input opens search mode; a value reset from
                // elsewhere must not leave the panel stuck open.
                if (event.target === document.activeElement) {
                  setShortcutsOpen(true);
                }
              }}
              onFocus={() => {
                if (!suppressShortcutsOnFocus.current) {
                  setShortcutsOpen(true);
                }
              }}
              placeholder={t("conversations.searchPlaceholder")}
              ref={searchInput}
              type="search"
              value={query}
            />
            {(searching || shortcutsOpen) && (
              <button
                aria-label={t("conversations.searchClear")}
                className="conversation-search__clear"
                onClick={closeSearch}
                type="button"
              >
                <X aria-hidden="true" />
              </button>
            )}
          </div>
          {panelOpen && renderShortcuts("panel")}
        </div>

        {/* Kept mounted while the panel is open so the list keeps its scroll
            position; `hidden` removes both from layout and the a11y tree. */}
        {!listConcealed && items.length > 0 && (
          <div
            aria-label={t("conversations.filtersLabel")}
            className="conversation-filters"
            hidden={panelOpen}
            role="group"
          >
            {/* Zalo-style row: two text tabs, the conversation kinds behind a
                "Phân loại" menu on the right, so it never wraps. */}
            {tabFilters.map((value) => (
              <button
                aria-pressed={filter === value}
                className="conversation-filter"
                key={value}
                onClick={() => setFilter(value)}
                type="button"
              >
                {t(filterLabels[value])}
                {value === "unread" && unreadConversations > 0 && (
                  <span className="conversation-filter__count">
                    {unreadConversations}
                  </span>
                )}
              </button>
            ))}
            {/* Non-modal: a light filter menu must not aria-hide the page. */}
            <Menu modal={false}>
              <MenuTrigger asChild>
                <button
                  aria-label={
                    activeCategory
                      ? t("conversations.filterCategoryActive", {
                          category: t(filterLabels[activeCategory]),
                        })
                      : undefined
                  }
                  className="conversation-filter conversation-filter--category"
                  data-active={activeCategory ? "true" : undefined}
                  type="button"
                >
                  <span className="conversation-filter__label">
                    {activeCategory
                      ? t(filterLabels[activeCategory])
                      : t("conversations.filterCategory")}
                  </span>
                  <ChevronDown aria-hidden="true" />
                </button>
              </MenuTrigger>
              <MenuContent align="end" className="conversation-filter-menu">
                <MenuRadioGroup
                  onValueChange={(value) => {
                    const next = categoryFilters.find(
                      (category) => category === value,
                    );
                    if (next) {
                      setFilter(next);
                    }
                  }}
                  value={activeCategory ?? ""}
                >
                  {categoryFilters.map((value) => (
                    <MenuRadioItem key={value} value={value}>
                      {t(filterLabels[value])}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuContent>
            </Menu>
          </div>
        )}

        <div
          className="conversation-list-panel__scroll scroll-autohide"
          hidden={panelOpen}
        >
          {conversations.isPending && (
            <SkeletonGroup label={t("conversations.loading")}>
              <Skeleton height={56} />
              <Skeleton height={56} />
              <Skeleton height={56} />
            </SkeletonGroup>
          )}

          {!listConcealed && conversations.data && items.length === 0 && (
            <EmptyState
              actions={
                createAvailability.available ? (
                  <Button
                    leadingIcon={<Mail />}
                    onClick={openCreateFromShortcut}
                    variant="secondary"
                  >
                    {t("conversations.shortcutDirect")}
                  </Button>
                ) : undefined
              }
              description={t("conversations.emptyDescription")}
              title={t("conversations.emptyTitle")}
            />
          )}

          {!listConcealed && items.length > 0 && (
            <>
              <p className="visually-hidden" role="status">
                {listStatus}
              </p>
              {filtered.length === 0 ? (
                <div className="conversation-list__no-match">
                  <strong>{t("conversations.noMatchTitle")}</strong>
                  <span>{t("conversations.noMatchDescription")}</span>
                </div>
              ) : grouped ? (
                <>
                  {renderSection(
                    "favorites",
                    t("conversations.favoritesSection"),
                    pinnedItems,
                  )}
                  {otherItems.length > 0 &&
                    renderSection(
                      "chats",
                      t("conversations.chatsSection"),
                      otherItems,
                    )}
                </>
              ) : (
                <ul className="conversation-list">
                  {[...pinnedItems, ...otherItems].map(renderRow)}
                </ul>
              )}
            </>
          )}

          {conversations.isFetchNextPageError && (
            <div className="conversations-page__inline-error" role="alert">
              <span>{t("conversations.loadMoreError")}</span>
              <Button
                onClick={() => void conversations.fetchNextPage()}
                size="sm"
                variant="secondary"
              >
                {t("state.retry")}
              </Button>
            </div>
          )}

          {conversations.hasNextPage && (
            <div className="conversation-list-panel__pagination">
              <Button
                leadingIcon={<ChevronDown />}
                loading={conversations.isFetchingNextPage}
                loadingLabel={t("conversations.loadingMore")}
                onClick={() => void conversations.fetchNextPage()}
                size="sm"
                variant="secondary"
              >
                {t("conversations.loadMore")}
              </Button>
            </div>
          )}

          {searching &&
            !listConcealed &&
            items.length > 0 &&
            renderShortcuts("results")}
        </div>
      </section>

      <ConversationDetail
        actorID={actorID}
        conversation={conversation}
        coverFor={classroomPreferences.coverFor}
        createAvailability={createAvailability}
        detailHeading={detailHeading}
        features={
          capabilities.isError ? undefined : capabilities.data?.features
        }
        formatter={formatter}
        isPinned={conversationPreferences.isPinned}
        onStartConversation={openCreate}
        onTogglePin={conversationPreferences.togglePin}
        selected={Boolean(conversationId)}
        tenantID={tenantID ?? ""}
      />

      <Dialog
        onOpenChange={(open) => {
          if (createDirect.isPending) {
            return;
          }
          setCreateOpen(open);
          if (!open) {
            setEmailError(null);
            createDirect.reset();
          }
        }}
        open={createOpen}
      >
        <DialogContent
          className="conversations-dialog"
          closeLabel={t("conversations.closeDialog")}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            createTrigger.current?.focus();
          }}
        >
          <form className="conversations-dialog__form" onSubmit={submitDirect}>
            <span aria-hidden="true" className="conversations-dialog__icon">
              <Mail />
            </span>
            <DialogTitle>{t("conversations.createDialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("conversations.createDialogDescription")}
            </DialogDescription>
            <TextField
              autoComplete="off"
              autoFocus
              disabled={createDirect.isPending}
              error={emailError ?? undefined}
              hint={t("conversations.targetEmailHint")}
              label={t("conversations.targetEmailLabel")}
              onChange={(event) => {
                setTargetEmail(event.target.value);
                if (emailError) {
                  setEmailError(null);
                }
              }}
              type="email"
              value={targetEmail}
            />
            {createDirect.isError && (
              <p className="conversations-page__form-error" role="alert">
                {t("conversations.createError")}
              </p>
            )}
            <DialogFooter className="conversations-dialog__footer">
              <DialogClose asChild>
                <Button disabled={createDirect.isPending} variant="secondary">
                  {t("conversations.cancel")}
                </Button>
              </DialogClose>
              <Button
                loading={createDirect.isPending}
                loadingLabel={t("conversations.creating")}
                type="submit"
              >
                {t("conversations.create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DetailBackLink() {
  const { t } = useI18n();
  return (
    <Link className="conversation-detail-panel__back" to="/app/messages">
      <ArrowLeft aria-hidden="true" />
      <span>{t("conversations.backToList")}</span>
    </Link>
  );
}

/**
 * MSG-WELCOME-3D-01: right pane before a conversation is chosen. Desktop
 * widths get the welcome carousel (lazy chunk); narrower screens keep the
 * original prompt, which CSS hides while the list fills the screen.
 */
function ConversationWelcomePane({
  createAvailability,
  features,
  onStartConversation,
}: {
  createAvailability: TenantOperationAvailability;
  features: TenantCapabilities["features"] | undefined;
  onStartConversation: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const { t } = useI18n();
  const wide = useSyncExternalStore(
    subscribeWelcomePane,
    welcomePaneSnapshot,
    welcomePaneServerSnapshot,
  );

  if (!wide) {
    return (
      <section className="conversation-detail-panel conversation-detail-panel--prompt">
        <EmptyState
          description={t("conversations.detailPromptDescription")}
          title={t("conversations.detailPromptTitle")}
        />
      </section>
    );
  }

  const [titleStart, titleEnd = ""] = t("conversations.welcomeTitle").split(
    "{brand}",
  );
  return (
    <section
      aria-labelledby="conversation-welcome-title"
      className="conversation-detail-panel conversation-detail-panel--welcome"
    >
      <div className="conversation-tour__intro">
        <h2 id="conversation-welcome-title">
          {titleStart}
          <strong>TutorHub</strong>
          {titleEnd}
        </h2>
        <p>{t("conversations.welcomeDescription")}</p>
      </div>
      <Suspense
        fallback={
          <div aria-hidden="true" className="conversation-tour__fallback" />
        }
      >
        <MessagesWelcomeCarousel
          createAvailability={createAvailability}
          features={features}
          onStartConversation={onStartConversation}
        />
      </Suspense>
      <p className="conversation-tour__hint">
        {t("conversations.welcomeHint")}
      </p>
    </section>
  );
}

function ConversationDetail({
  actorID,
  conversation,
  coverFor,
  createAvailability,
  detailHeading,
  features,
  formatter,
  isPinned,
  onStartConversation,
  onTogglePin,
  selected,
  tenantID,
}: {
  actorID: string;
  conversation: ReturnType<typeof useConversation>;
  coverFor: (classID: string) => ClassCoverTheme;
  createAvailability: TenantOperationAvailability;
  detailHeading: RefObject<HTMLHeadingElement | null>;
  features: TenantCapabilities["features"] | undefined;
  formatter: Intl.DateTimeFormat;
  isPinned: (conversationID: string) => boolean;
  onStartConversation: (event: MouseEvent<HTMLButtonElement>) => void;
  onTogglePin: (conversationID: string) => void;
  selected: boolean;
  tenantID: string;
}) {
  const { t } = useI18n();
  const [toolsTarget, setToolsTarget] = useState<HTMLDivElement | null>(null);

  if (!selected) {
    return (
      <ConversationWelcomePane
        createAvailability={createAvailability}
        features={features}
        onStartConversation={onStartConversation}
      />
    );
  }

  if (conversation.isPending) {
    return (
      <section className="conversation-detail-panel conversation-detail-panel--state">
        <DetailBackLink />
        <SkeletonGroup label={t("conversations.detailLoading")}>
          <Skeleton height={36} width="55%" />
          <Skeleton height={90} />
          <Skeleton height={150} />
        </SkeletonGroup>
      </section>
    );
  }

  if (conversation.isError) {
    const concealed = shouldConcealTenantScopedData(conversation.error);
    const State =
      conversation.error instanceof APIRequestError &&
      conversation.error.status === 403
        ? ForbiddenState
        : concealed
          ? EmptyState
          : ErrorState;
    return (
      <section className="conversation-detail-panel conversation-detail-panel--state">
        <DetailBackLink />
        <State
          actions={
            concealed ? undefined : (
              <Button
                leadingIcon={<RefreshCw />}
                onClick={() => void conversation.refetch()}
                variant="secondary"
              >
                {t("state.retry")}
              </Button>
            )
          }
          description={
            concealed
              ? t("conversations.notFoundDescription")
              : t("conversations.detailErrorDescription")
          }
          title={
            concealed
              ? t("conversations.notFoundTitle")
              : t("conversations.detailErrorTitle")
          }
        />
      </section>
    );
  }

  const item = conversation.data;
  const readOnly =
    item.class_status === "archived" ||
    item.viewer_access.can_post_messages !== true;
  const pinned = isPinned(item.id);
  const classPath =
    item.kind === "class" && item.class_id
      ? `/app/classrooms/${item.class_id}`
      : null;
  const roomPath =
    item.kind === "room" &&
    item.media_space_id &&
    item.media_space_status === "open"
      ? `/app/media/spaces/${item.media_space_id}/prejoin`
      : null;

  return (
    <article
      aria-labelledby="conversation-detail-title"
      className="conversation-detail-panel"
    >
      <header className="conversation-detail-panel__header">
        <DetailBackLink />
        {/* Zalo-style presence: a green dot on the person's avatar plus a
            plain muted status line under the name (no pill, no kind label). */}
        <span className="conversation-detail-panel__avatar">
          <ConversationAvatar
            conversation={item}
            coverTheme={item.class_id ? coverFor(item.class_id) : undefined}
            size="sm"
          />
          {item.kind === "direct" && !readOnly && (
            <span aria-hidden="true" className="conversation-presence-dot" />
          )}
        </span>
        <div className="conversation-detail-panel__identity">
          <h2 id="conversation-detail-title" ref={detailHeading} tabIndex={-1}>
            {item.title}
          </h2>
          <p
            className="conversation-detail-panel__meta"
            data-state={readOnly ? "read-only" : "active"}
          >
            {t(readOnly ? "conversations.readOnly" : "conversations.ready")}
          </p>
        </div>
        <div className="conversation-detail-panel__actions">
          {classPath && (
            <Link className="conversation-cta" to={classPath}>
              <span>{t("conversations.openClass")}</span>
              <ArrowUpRight aria-hidden="true" />
            </Link>
          )}
          {roomPath && (
            <Link className="conversation-cta" to={roomPath}>
              <span>{t("conversations.openRoom")}</span>
              <ArrowUpRight aria-hidden="true" />
            </Link>
          )}
          <div
            className="conversation-detail-panel__tools"
            ref={setToolsTarget}
          />
          <IconButton
            className="conversation-thread-tools__button"
            data-tooltip={t(
              pinned
                ? "conversations.unpinCurrent"
                : "conversations.pinCurrent",
            )}
            label={t(
              pinned
                ? "conversations.unpinCurrent"
                : "conversations.pinCurrent",
            )}
            onClick={() => onTogglePin(item.id)}
            size="sm"
            variant="quiet"
          >
            {pinned ? <PinOff /> : <Pin />}
          </IconButton>
        </div>
      </header>

      <div className="conversation-subbar">
        <nav
          aria-label={t("conversations.detailNavLabel")}
          className="conversation-subbar__nav"
        >
          <span aria-current="page" className="conversation-subbar__tab">
            {t("conversations.chatTab")}
          </span>
          {classPath && (
            <>
              <Link className="conversation-subbar__link" to={classPath}>
                {t("conversations.openClass")}
                <ArrowUpRight aria-hidden="true" />
              </Link>
              <Link
                className="conversation-subbar__link"
                to={`${classPath}?tab=materials`}
              >
                {t("conversations.openMaterials")}
                <ArrowUpRight aria-hidden="true" />
              </Link>
            </>
          )}
          {roomPath && (
            <Link className="conversation-subbar__link" to={roomPath}>
              {t("conversations.openRoom")}
              <ArrowUpRight aria-hidden="true" />
            </Link>
          )}
        </nav>
      </div>

      <ConversationMessages
        actorID={actorID}
        canPostMessages={!readOnly}
        conversation={item}
        conversationID={item.id}
        formatter={formatter}
        key={item.id}
        readOnlyNotice={
          readOnly ? t("conversations.readOnlyDescription") : undefined
        }
        tenantID={tenantID}
        toolbarTarget={toolsTarget}
      />
    </article>
  );
}
