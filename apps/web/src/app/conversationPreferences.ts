import type { Conversation } from "@tutorhub/api-client";
import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * MSG-CLASSIN-TEAMS-01: light, per-(tenant, user) preferences of the Messages
 * tab — pinned conversations (Teams "Favorites") and which list sections are
 * collapsed. The default state is never written: storage is only touched after
 * the user pins a conversation or folds a section, an all-default state
 * removes the key again, and sign-out clears every key (see `session.tsx`).
 * Message content and drafts are never stored here.
 */
export const CONVERSATION_PREFERENCES_PREFIX = "tutorhub.conversation-prefs:";

export const conversationListSections = ["favorites", "chats"] as const;
export type ConversationListSection = (typeof conversationListSections)[number];

export interface ConversationPreferences {
  /** Pinned conversation IDs, most recently pinned first. */
  readonly pinned: readonly string[];
  readonly collapsed: readonly ConversationListSection[];
}

export const emptyConversationPreferences: ConversationPreferences =
  Object.freeze({
    pinned: Object.freeze([]) as readonly string[],
    collapsed: Object.freeze([]) as readonly ConversationListSection[],
  });

const maxPinned = 100;
const conversationIDPattern = /^[A-Za-z0-9-]{1,64}$/;

function isListSection(value: unknown): value is ConversationListSection {
  return conversationListSections.some((section) => section === value);
}

export function conversationPreferencesKey(tenantID: string, userID: string) {
  return `${CONVERSATION_PREFERENCES_PREFIX}${tenantID}:${userID}`;
}

/** Parses stored preferences defensively; anything malformed is dropped. */
export function parseConversationPreferences(
  raw: string | null,
): ConversationPreferences {
  if (!raw) {
    return emptyConversationPreferences;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return emptyConversationPreferences;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return emptyConversationPreferences;
  }
  const record = value as { pinned?: unknown; collapsed?: unknown };
  const pinned = Array.isArray(record.pinned)
    ? [
        ...new Set(
          record.pinned.filter(
            (id): id is string =>
              typeof id === "string" && conversationIDPattern.test(id),
          ),
        ),
      ].slice(0, maxPinned)
    : [];
  const collapsed = Array.isArray(record.collapsed)
    ? [...new Set(record.collapsed.filter(isListSection))]
    : [];
  return { pinned, collapsed };
}

function isDefaultState(preferences: ConversationPreferences) {
  return preferences.pinned.length === 0 && preferences.collapsed.length === 0;
}

export function safeConversationStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readConversationPreferences(
  storage: Storage | null,
  key: string,
): ConversationPreferences {
  if (!storage) {
    return emptyConversationPreferences;
  }
  try {
    return parseConversationPreferences(storage.getItem(key));
  } catch {
    return emptyConversationPreferences;
  }
}

/** Persists an explicit user change; the default state removes the key. */
export function writeConversationPreferences(
  storage: Storage | null,
  key: string,
  preferences: ConversationPreferences,
) {
  if (!storage) {
    return;
  }
  try {
    if (isDefaultState(preferences)) {
      storage.removeItem(key);
    } else {
      storage.setItem(
        key,
        JSON.stringify({
          pinned: preferences.pinned,
          collapsed: preferences.collapsed,
        }),
      );
    }
  } catch {
    // Storage may be full or blocked; the in-memory state still applies.
  }
}

export function togglePinnedConversation(
  preferences: ConversationPreferences,
  conversationID: string,
): ConversationPreferences {
  if (!conversationIDPattern.test(conversationID)) {
    return preferences;
  }
  const pinned = preferences.pinned.includes(conversationID)
    ? preferences.pinned.filter((id) => id !== conversationID)
    : [conversationID, ...preferences.pinned].slice(0, maxPinned);
  return { ...preferences, pinned };
}

export function toggleCollapsedSection(
  preferences: ConversationPreferences,
  section: ConversationListSection,
): ConversationPreferences {
  const collapsed = preferences.collapsed.includes(section)
    ? preferences.collapsed.filter((value) => value !== section)
    : [...preferences.collapsed, section];
  return { ...preferences, collapsed };
}

/**
 * Reads the stored preferences once per (tenant, user) and only writes after
 * an explicit user change.
 */
export function useConversationPreferences(
  tenantID: string | undefined,
  userID: string | undefined,
) {
  const key =
    tenantID && userID ? conversationPreferencesKey(tenantID, userID) : null;
  const [state, setState] = useState<{
    key: string | null;
    preferences: ConversationPreferences;
  }>(() => ({
    key,
    preferences: key
      ? readConversationPreferences(safeConversationStorage(), key)
      : emptyConversationPreferences,
  }));
  const preferences =
    state.key === key
      ? state.preferences
      : key
        ? readConversationPreferences(safeConversationStorage(), key)
        : emptyConversationPreferences;

  useEffect(() => {
    if (!key || typeof window === "undefined") {
      return;
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key === key) {
        setState({
          key,
          preferences: parseConversationPreferences(event.newValue),
        });
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key]);

  const update = useCallback(
    (change: (current: ConversationPreferences) => ConversationPreferences) => {
      if (!key) {
        return;
      }
      const next = change(preferences);
      writeConversationPreferences(safeConversationStorage(), key, next);
      setState({ key, preferences: next });
    },
    [key, preferences],
  );

  return useMemo(
    () => ({
      preferences,
      isCollapsed: (section: ConversationListSection) =>
        preferences.collapsed.includes(section),
      isPinned: (conversationID: string) =>
        preferences.pinned.includes(conversationID),
      toggleCollapsed: (section: ConversationListSection) =>
        update((current) => toggleCollapsedSection(current, section)),
      togglePin: (conversationID: string) =>
        update((current) => togglePinnedConversation(current, conversationID)),
    }),
    [preferences, update],
  );
}

/* ---------- List presentation helpers ---------- */

export const conversationFilters = [
  "all",
  "unread",
  "class",
  "direct",
  "room",
] as const;
export type ConversationFilter = (typeof conversationFilters)[number];

const combiningMarks = /[̀-ͯ]/g;
const vietnameseD = /[Đđ]/g;

/**
 * Folds text for search: Unicode NFD without combining marks, `Đ/đ → d`,
 * lower-cased and with collapsed whitespace ("Đại Số" → "dai so").
 */
export function foldSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(combiningMarks, "")
    .replace(vietnameseD, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function matchesConversationQuery(
  conversation: Pick<Conversation, "participants" | "title">,
  foldedQuery: string,
): boolean {
  if (!foldedQuery) {
    return true;
  }
  if (foldSearchText(conversation.title).includes(foldedQuery)) {
    return true;
  }
  return conversation.participants.some((participant) =>
    foldSearchText(participant.display_name).includes(foldedQuery),
  );
}

export function matchesConversationFilter(
  conversation: Pick<Conversation, "kind" | "unread_count">,
  filter: ConversationFilter,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "unread":
      return conversation.unread_count > 0;
    default:
      return conversation.kind === filter;
  }
}

export function filterConversations<
  T extends Pick<
    Conversation,
    "kind" | "participants" | "title" | "unread_count"
  >,
>(items: readonly T[], filter: ConversationFilter, query: string): T[] {
  const folded = foldSearchText(query);
  return items.filter(
    (item) =>
      matchesConversationFilter(item, filter) &&
      matchesConversationQuery(item, folded),
  );
}

/** Splits a list into pinned (most recently pinned first) and the rest. */
export function partitionPinnedConversations<T extends { id: string }>(
  items: readonly T[],
  pinned: readonly string[],
): { pinned: T[]; others: T[] } {
  if (pinned.length === 0) {
    return { pinned: [], others: [...items] };
  }
  const rank = new Map(pinned.map((id, index) => [id, index]));
  const pinnedItems: T[] = [];
  const others: T[] = [];
  for (const item of items) {
    if (rank.has(item.id)) {
      pinnedItems.push(item);
    } else {
      others.push(item);
    }
  }
  pinnedItems.sort(
    (left, right) => (rank.get(left.id) ?? 0) - (rank.get(right.id) ?? 0),
  );
  return { pinned: pinnedItems, others };
}

const dayMilliseconds = 24 * 60 * 60 * 1000;

function startOfLocalDay(value: Date) {
  return new Date(
    value.getFullYear(),
    value.getMonth(),
    value.getDate(),
  ).getTime();
}

/** Whole local calendar days from `value` to `now` (0 = same day). */
export function calendarDaysBetween(value: Date, now: Date): number {
  return Math.round(
    (startOfLocalDay(now) - startOfLocalDay(value)) / dayMilliseconds,
  );
}

/**
 * Teams-style compact list timestamp: `HH:mm` today, the weekday within the
 * last 6 days, `dd/MM` earlier this year and `dd/MM/yy` before that.
 */
export function compactConversationTime(
  value: string | Date,
  now: Date,
  language: "vi" | "en",
): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const locale = language === "vi" ? "vi-VN" : "en-US";
  const days = calendarDaysBetween(date, now);
  if (days <= 0) {
    return new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: language === "vi" ? "h23" : "h12",
    }).format(date);
  }
  if (days < 7) {
    return new Intl.DateTimeFormat(locale, {
      weekday: language === "vi" ? "long" : "short",
    }).format(date);
  }
  // Built by hand: ICU builds differ on the vi-VN day/month separator.
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const dayMonth =
    language === "vi"
      ? `${day}/${month}`
      : `${date.getMonth() + 1}/${date.getDate()}`;
  return date.getFullYear() === now.getFullYear()
    ? dayMonth
    : `${dayMonth}/${String(date.getFullYear() % 100).padStart(2, "0")}`;
}
