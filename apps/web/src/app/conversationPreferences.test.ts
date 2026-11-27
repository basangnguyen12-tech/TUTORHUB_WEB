import { act, renderHook } from "@testing-library/react";
import type { Conversation } from "@tutorhub/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_PREFERENCES_PREFIX,
  compactConversationTime,
  conversationPreferencesKey,
  emptyConversationPreferences,
  filterConversations,
  foldSearchText,
  parseConversationPreferences,
  partitionPinnedConversations,
  readConversationPreferences,
  toggleCollapsedSection,
  togglePinnedConversation,
  useConversationPreferences,
  writeConversationPreferences,
} from "./conversationPreferences";
import { CONVERSATION_PREFERENCES_STORAGE_PREFIX } from "./session";

const tenantID = "4b18543a-74de-419f-9fe8-d0c3dfc991eb";
const userID = "be85eb92-0f18-4163-85ba-50e4d343d632";
const firstID = "c82ef7ee-0a1b-4e99-b9d5-3ae20858a82e";
const secondID = "4cbcb21e-008f-4693-ab95-a5bc952802df";

function conversation(
  id: string,
  kind: Conversation["kind"],
  title: string,
  options: { participants?: string[]; unread?: number } = {},
): Conversation {
  return {
    id,
    kind,
    title,
    participants: (options.participants ?? []).map((name, index) => ({
      user_id: `00000000-0000-4000-8000-00000000000${index}`,
      display_name: name,
    })),
    viewer_access: { can_post_messages: true },
    unread_count: options.unread ?? 0,
    unread_count_capped: false,
    created_at: "2026-08-03T09:00:00Z",
    updated_at: "2026-08-03T09:00:00Z",
  };
}

describe("conversation preferences (MSG-CLASSIN-TEAMS-01)", () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("scopes the key per tenant and user with the prefix cleared on sign-out", () => {
    expect(CONVERSATION_PREFERENCES_PREFIX).toBe(
      CONVERSATION_PREFERENCES_STORAGE_PREFIX,
    );
    expect(conversationPreferencesKey(tenantID, userID)).toBe(
      `tutorhub.conversation-prefs:${tenantID}:${userID}`,
    );
  });

  it("parses stored state defensively", () => {
    expect(parseConversationPreferences(null)).toBe(
      emptyConversationPreferences,
    );
    expect(parseConversationPreferences("{not json")).toBe(
      emptyConversationPreferences,
    );
    expect(parseConversationPreferences("[1,2]")).toBe(
      emptyConversationPreferences,
    );
    expect(
      parseConversationPreferences(
        JSON.stringify({
          pinned: [firstID, firstID, "<script>", 42, secondID],
          collapsed: ["favorites", "bogus", "favorites", "chats"],
        }),
      ),
    ).toEqual({
      pinned: [firstID, secondID],
      collapsed: ["favorites", "chats"],
    });
  });

  it("writes only non-default state and removes the key when back to default", () => {
    const key = conversationPreferencesKey(tenantID, userID);
    const pinned = togglePinnedConversation(
      emptyConversationPreferences,
      firstID,
    );
    writeConversationPreferences(localStorage, key, pinned);
    expect(JSON.parse(localStorage.getItem(key) ?? "{}")).toEqual({
      pinned: [firstID],
      collapsed: [],
    });
    expect(readConversationPreferences(localStorage, key)).toEqual(pinned);

    writeConversationPreferences(
      localStorage,
      key,
      togglePinnedConversation(pinned, firstID),
    );
    expect(localStorage.getItem(key)).toBeNull();
    expect(() => writeConversationPreferences(null, key, pinned)).not.toThrow();
  });

  it("pins most recent first, ignores malformed IDs and folds sections", () => {
    let preferences = togglePinnedConversation(
      emptyConversationPreferences,
      firstID,
    );
    preferences = togglePinnedConversation(preferences, secondID);
    expect(preferences.pinned).toEqual([secondID, firstID]);
    expect(togglePinnedConversation(preferences, "../evil")).toBe(preferences);
    preferences = toggleCollapsedSection(preferences, "favorites");
    expect(preferences.collapsed).toEqual(["favorites"]);
    preferences = toggleCollapsedSection(preferences, "favorites");
    expect(preferences.collapsed).toEqual([]);
  });

  it("only touches storage after an explicit user action", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { result } = renderHook(() =>
      useConversationPreferences(tenantID, userID),
    );
    expect(result.current.isPinned(firstID)).toBe(false);
    expect(setItem).not.toHaveBeenCalled();

    act(() => result.current.togglePin(firstID));
    expect(result.current.isPinned(firstID)).toBe(true);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(
      localStorage.getItem(conversationPreferencesKey(tenantID, userID)),
    ).toContain(firstID);

    act(() => result.current.togglePin(firstID));
    expect(
      localStorage.getItem(conversationPreferencesKey(tenantID, userID)),
    ).toBeNull();

    act(() => result.current.toggleCollapsed("chats"));
    expect(result.current.isCollapsed("chats")).toBe(true);
  });

  it("folds Vietnamese diacritics, Đ/đ and case for search", () => {
    expect(foldSearchText("  Đại Số   TUYẾN tính ")).toBe("dai so tuyen tinh");
    expect(foldSearchText("Phòng ôn tập Toán")).toBe("phong on tap toan");
  });

  it("filters by chip and diacritic-insensitive query, including member names", () => {
    const items = [
      conversation(firstID, "class", "Đại số tuyến tính"),
      conversation(secondID, "direct", "Lê Văn Đức", {
        participants: ["Nguyễn Thị Hoa", "Lê Văn Đức"],
        unread: 2,
      }),
      conversation(
        "6a8b229d-b4ee-4464-bb94-b0c0af8828a6",
        "room",
        "Phòng ôn tập",
      ),
    ];
    expect(
      filterConversations(items, "all", "dai so").map((i) => i.id),
    ).toEqual([firstID]);
    expect(filterConversations(items, "all", "HOA").map((i) => i.id)).toEqual([
      secondID,
    ]);
    expect(filterConversations(items, "unread", "").map((i) => i.id)).toEqual([
      secondID,
    ]);
    expect(filterConversations(items, "class", "").map((i) => i.kind)).toEqual([
      "class",
    ]);
    expect(filterConversations(items, "direct", "").map((i) => i.kind)).toEqual(
      ["direct"],
    );
    expect(filterConversations(items, "room", "").map((i) => i.kind)).toEqual([
      "room",
    ]);
    expect(filterConversations(items, "class", "duc")).toEqual([]);
  });

  it("splits pinned conversations in pin order", () => {
    const items = [
      conversation(firstID, "class", "A"),
      conversation(secondID, "direct", "B"),
      conversation("6a8b229d-b4ee-4464-bb94-b0c0af8828a6", "room", "C"),
    ];
    const { pinned, others } = partitionPinnedConversations(items, [
      "6a8b229d-b4ee-4464-bb94-b0c0af8828a6",
      firstID,
    ]);
    expect(pinned.map((item) => item.title)).toEqual(["C", "A"]);
    expect(others.map((item) => item.title)).toEqual(["B"]);
  });

  it("formats Teams-style compact list times", () => {
    const now = new Date(2026, 10, 27, 15, 30);
    expect(
      compactConversationTime(new Date(2026, 10, 27, 9, 5), now, "vi"),
    ).toBe("09:05");
    expect(
      compactConversationTime(new Date(2026, 10, 24, 9, 5), now, "vi"),
    ).toMatch(/^Thứ/);
    expect(
      compactConversationTime(new Date(2026, 10, 24, 9, 5), now, "en"),
    ).toMatch(/^[A-Z][a-z]{2}$/);
    expect(
      compactConversationTime(new Date(2026, 2, 31, 9, 5), now, "en"),
    ).toBe("3/31");
    expect(
      compactConversationTime(new Date(2026, 2, 31, 9, 5), now, "vi"),
    ).toBe("31/03");
    expect(
      compactConversationTime(new Date(2024, 11, 10, 9, 5), now, "vi"),
    ).toBe("10/12/24");
    expect(compactConversationTime("not a date", now, "vi")).toBe("");
  });
});
