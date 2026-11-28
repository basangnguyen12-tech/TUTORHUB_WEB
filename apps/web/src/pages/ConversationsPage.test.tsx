import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  Conversation,
  CurrentUser,
  Message,
  MessagePage,
  TenantCapabilities,
} from "@tutorhub/api-client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultCoverTheme } from "../app/classroomPreferences";
import { conversationQueryKeys } from "../app/conversations";
import { I18nProvider } from "../app/i18n";
import { SessionProvider } from "../app/session";
import { tenantCapabilityQueryKeys } from "../app/tenantCapabilities";
import { availableTenantCapabilities } from "../test/tenantCapabilities";
import { ConversationsPage } from "./ConversationsPage";

const tenantID = "4b18543a-74de-419f-9fe8-d0c3dfc991eb";
const teacherID = "be85eb92-0f18-4163-85ba-50e4d343d632";
const studentID = "53f0dac5-6c10-46ff-bcb8-da03d07bc142";
const directID = "c82ef7ee-0a1b-4e99-b9d5-3ae20858a82e";
const classConversationID = "4cbcb21e-008f-4693-ab95-a5bc952802df";
const roomConversationID = "6a8b229d-b4ee-4464-bb94-b0c0af8828a6";
const activeClassID = "f3b8c2a1-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const activeClassConversationID = "9e7d6c5b-4a3f-4e2d-9c1b-0a9f8e7d6c5b";
const preferencesKey = `tutorhub.conversation-prefs:${tenantID}:${teacherID}`;

const session: CurrentUser = {
  user: {
    id: teacherID,
    email: "teacher@example.com",
    display_name: "TutorHub Teacher",
    locale: "vi",
    timezone: "Asia/Ho_Chi_Minh",
  },
  active_tenant: {
    id: tenantID,
    slug: "tutorhub-test",
    name: "TutorHub Test",
    role: "teacher",
    is_active: true,
    status: "active",
    version: 1,
  },
  memberships: [
    {
      id: tenantID,
      slug: "tutorhub-test",
      name: "TutorHub Test",
      role: "teacher",
      is_active: true,
      status: "active",
      version: 1,
    },
  ],
  permissions: ["tenant.view"],
};

const directConversation: Conversation = {
  id: directID,
  kind: "direct",
  title: "TutorHub Student",
  participants: [
    { user_id: teacherID, display_name: "TutorHub Teacher" },
    { user_id: studentID, display_name: "TutorHub Student" },
  ],
  viewer_access: { can_post_messages: true },
  unread_count: 100,
  unread_count_capped: true,
  created_at: "2026-08-03T09:00:00Z",
  updated_at: "2026-08-03T09:00:00Z",
};

const archivedClassConversation: Conversation = {
  id: classConversationID,
  kind: "class",
  class_id: "a912f628-f3d2-4c18-84c6-42a9e858dc8d",
  class_status: "archived",
  title: "Cơ sở An toàn thông tin",
  participants: [],
  viewer_access: { can_post_messages: false },
  unread_count: 0,
  unread_count_capped: false,
  created_at: "2026-08-03T08:00:00Z",
  updated_at: "2026-08-03T10:00:00Z",
};

const endedRoomConversation: Conversation = {
  id: roomConversationID,
  kind: "room",
  media_space_id: "dd060149-e85d-43c2-98d0-110f6e3ead29",
  media_space_status: "ended",
  title: "Phòng ôn tập Toán",
  participants: [],
  viewer_access: { can_post_messages: false },
  unread_count: 0,
  unread_count_capped: false,
  created_at: "2026-08-03T08:00:00Z",
  updated_at: "2026-08-03T11:00:00Z",
};

const activeClassConversation: Conversation = {
  id: activeClassConversationID,
  kind: "class",
  class_id: activeClassID,
  class_status: "active",
  title: "Đại số tuyến tính",
  participants: [],
  viewer_access: { can_post_messages: true },
  unread_count: 0,
  unread_count_capped: false,
  created_at: "2026-08-03T08:00:00Z",
  updated_at: "2026-08-03T12:00:00Z",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type":
        status >= 400 ? "application/problem+json" : "application/json",
    },
  });
}

function renderPage(
  path: string,
  fetchMock: ReturnType<typeof vi.fn>,
  capabilities: TenantCapabilities = availableTenantCapabilities(tenantID),
  seed?: (queryClient: QueryClient) => void,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  queryClient.setQueryData(
    tenantCapabilityQueryKeys.detail(tenantID),
    capabilities,
  );
  seed?.(queryClient);
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLanguage="vi">
        <SessionProvider mode={{ kind: "static", currentUser: session }}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route element={<ConversationsPage />} path="/app/messages" />
              <Route
                element={<ConversationsPage />}
                path="/app/messages/:conversationId"
              />
            </Routes>
          </MemoryRouter>
        </SessionProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

function listResponse(items: Conversation[] = [directConversation]) {
  return jsonResponse({ items, next_cursor: null });
}

/** Picks a conversation kind from the Zalo-style "Phân loại" menu. */
async function pickCategory(filters: HTMLElement, label: string) {
  const trigger = within(filters).getByRole("button", { name: /^Phân loại/ });
  act(() => trigger.focus());
  fireEvent.keyDown(trigger, { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitemradio", { name: label }));
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
}

function emptyMessagePageResponse() {
  return jsonResponse({
    items: [],
    next_cursor: null,
    read_state: null,
    unread_count: 0,
    unread_count_capped: false,
  });
}

describe("ConversationsPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("renders class history as read-only and focuses the selected heading", async () => {
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      const path = new URL(request.url).pathname;
      if (
        path.endsWith(`/api/v1/conversations/${classConversationID}/messages`)
      ) {
        return Promise.resolve(emptyMessagePageResponse());
      }
      if (path.endsWith(`/api/v1/conversations/${classConversationID}`)) {
        return Promise.resolve(jsonResponse(archivedClassConversation));
      }
      if (path.endsWith("/api/v1/conversations")) {
        return Promise.resolve(
          listResponse([directConversation, archivedClassConversation]),
        );
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });

    renderPage(`/app/messages/${classConversationID}`, fetchMock);

    const heading = await screen.findByRole("heading", {
      name: "Cơ sở An toàn thông tin",
    });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText("Chỉ đọc", { exact: true })).toBeInTheDocument();
    expect(screen.getByText(/Lịch sử được giữ lại/)).toBeInTheDocument();
    expect(
      heading.closest("header")?.querySelector(".conversation-presence-dot"),
    ).toBeNull();
    expect(
      screen.queryByRole("textbox", { name: "Tin nhắn mới" }),
    ).not.toBeInTheDocument();
  });

  it("keeps ended room history in the canonical conversation surface", async () => {
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      const path = new URL(request.url).pathname;
      if (
        path.endsWith(`/api/v1/conversations/${roomConversationID}/messages`)
      ) {
        return Promise.resolve(emptyMessagePageResponse());
      }
      if (path.endsWith(`/api/v1/conversations/${roomConversationID}`)) {
        return Promise.resolve(jsonResponse(endedRoomConversation));
      }
      if (path.endsWith("/api/v1/conversations")) {
        return Promise.resolve(listResponse([endedRoomConversation]));
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });

    renderPage(`/app/messages/${roomConversationID}`, fetchMock);

    const heading = await screen.findByRole("heading", {
      name: "Phòng ôn tập Toán",
    });
    // The kind label stays in the list row only; the header shows status.
    expect(screen.getAllByText("Phòng học")).toHaveLength(1);
    expect(heading.closest("header")?.textContent).not.toContain("Phòng học");
    expect(screen.getByText("Chỉ đọc", { exact: true })).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Tin nhắn mới" }),
    ).not.toBeInTheDocument();
  });

  it("keeps history visible while feature controls disable creation", async () => {
    const base = availableTenantCapabilities(tenantID);
    const capabilities: TenantCapabilities = {
      ...base,
      features: {
        ...base.features,
        conversations: {
          configured_enabled: false,
          enabled: false,
        },
      },
      operations: {
        ...base.operations,
        create_conversation: {
          available: false,
          reason: "feature_disabled",
        },
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(listResponse());

    renderPage("/app/messages", fetchMock, capabilities);

    expect(await screen.findByText("TutorHub Student")).toBeInTheDocument();
    expect(screen.getByText("100+ chưa đọc")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Bắt đầu trò chuyện" }),
    ).toBeDisabled();
    expect(screen.getByText(/Tính năng này đang bị tắt/)).toBeInTheDocument();
  });

  it("restores focus to the opener when Escape closes the create dialog", async () => {
    const fetchMock = vi.fn().mockResolvedValue(listResponse());

    renderPage("/app/messages", fetchMock);

    const trigger = await screen.findByRole("button", {
      name: "Bắt đầu trò chuyện",
    });
    fireEvent.click(trigger);
    const email = await screen.findByRole("textbox", {
      name: "Email thành viên",
    });
    await waitFor(() => expect(email).toHaveFocus());

    fireEvent.keyDown(email, { code: "Escape", key: "Escape" });

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });

  it("validates, normalizes, creates, announces, and opens a direct conversation", async () => {
    const requests: Request[] = [];
    const capabilities = availableTenantCapabilities(tenantID);
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/api/v1/auth/csrf")) {
        return Promise.resolve(
          jsonResponse({ csrf_token: "conversation-csrf" }),
        );
      }
      if (
        path.endsWith("/api/v1/conversations/direct") &&
        request.method === "POST"
      ) {
        return Promise.resolve(jsonResponse(directConversation, 201));
      }
      if (
        path.endsWith(`/api/v1/conversations/${directID}/messages`) &&
        request.method === "GET"
      ) {
        return Promise.resolve(emptyMessagePageResponse());
      }
      if (path.endsWith(`/api/v1/tenants/${tenantID}/capabilities`)) {
        return Promise.resolve(jsonResponse(capabilities));
      }
      if (path.endsWith("/api/v1/conversations")) {
        return Promise.resolve(listResponse([]));
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });

    renderPage("/app/messages", fetchMock, capabilities);

    fireEvent.click(
      await screen.findByRole("button", { name: "Bắt đầu trò chuyện" }),
    );
    const submit = screen.getByRole("button", { name: "Tạo trò chuyện" });
    fireEvent.click(submit);
    expect(await screen.findByText("Hãy nhập email thành viên.")).toBeVisible();

    fireEvent.change(screen.getByLabelText("Email thành viên"), {
      target: { value: " Student@Example.COM " },
    });
    fireEvent.click(submit);

    expect(
      await screen.findByText("Đã mở cuộc trò chuyện TutorHub Student."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "TutorHub Student" }),
      ).toHaveFocus(),
    );
    const createRequest = requests.find(
      (request) =>
        request.method === "POST" &&
        new URL(request.url).pathname.endsWith("/api/v1/conversations/direct"),
    );
    await expect(createRequest?.clone().json()).resolves.toEqual({
      target_member_email: "student@example.com",
    });
  });

  it("filters by accent-insensitive search, Zalo-style tabs and the category menu", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          listResponse([
            directConversation,
            activeClassConversation,
            endedRoomConversation,
          ]),
        ),
      );

    renderPage("/app/messages", fetchMock);

    expect(await screen.findByText("Đại số tuyến tính")).toBeInTheDocument();
    const search = screen.getByRole("searchbox", {
      name: "Tìm cuộc trò chuyện",
    });
    fireEvent.change(search, { target: { value: "  DAI SO " } });
    expect(screen.getByText("Đại số tuyến tính")).toBeInTheDocument();
    expect(screen.queryByText("TutorHub Student")).not.toBeInTheDocument();
    expect(screen.queryByText("Phòng ôn tập Toán")).not.toBeInTheDocument();
    expect(screen.getByText("1 cuộc trò chuyện phù hợp")).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "" } });

    const filters = screen.getByRole("group", {
      name: "Lọc cuộc trò chuyện",
    });
    const unread = within(filters).getByRole("button", { name: /^Chưa đọc/ });
    expect(unread).toHaveTextContent("1");
    fireEvent.click(unread);
    expect(unread).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("TutorHub Student")).toBeInTheDocument();
    expect(screen.queryByText("Đại số tuyến tính")).not.toBeInTheDocument();

    // Only the two tabs and the category menu sit in the row.
    expect(
      within(filters)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Tất cả", "Chưa đọc1", "Phân loại"]);
    const trigger = within(filters).getByRole("button", { name: "Phân loại" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    act(() => trigger.focus());
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(
      (await screen.findAllByRole("menuitemradio")).map(
        (item) => item.textContent,
      ),
    ).toEqual(["Lớp học", "Trực tiếp", "Phòng trực tuyến"]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );

    await pickCategory(filters, "Lớp học");
    expect(screen.getByText("Đại số tuyến tính")).toBeInTheDocument();
    expect(screen.queryByText("TutorHub Student")).not.toBeInTheDocument();
    // The menu button now names the chosen kind and is the active tab.
    const active = within(filters).getByRole("button", {
      name: "Phân loại: Lớp học",
    });
    expect(active).toHaveTextContent("Lớp học");
    expect(active).toHaveAttribute("data-active", "true");
    expect(unread).toHaveAttribute("aria-pressed", "false");

    await pickCategory(filters, "Trực tiếp");
    expect(screen.getByText("TutorHub Student")).toBeInTheDocument();
    expect(screen.queryByText("Đại số tuyến tính")).not.toBeInTheDocument();

    await pickCategory(filters, "Phòng trực tuyến");
    expect(screen.getByText("Phòng ôn tập Toán")).toBeInTheDocument();
    expect(screen.queryByText("TutorHub Student")).not.toBeInTheDocument();

    // "Tất cả" clears the category.
    fireEvent.click(within(filters).getByRole("button", { name: "Tất cả" }));
    expect(
      within(filters).getByRole("button", { name: "Phân loại" }),
    ).not.toHaveAttribute("data-active");
    expect(screen.getByText("TutorHub Student")).toBeInTheDocument();
  });

  it("pins conversations into a collapsible Favorites group only after a click", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          listResponse([directConversation, activeClassConversation]),
        ),
      );

    renderPage("/app/messages", fetchMock);

    expect(await screen.findByText("Đại số tuyến tính")).toBeInTheDocument();
    expect(
      setItem.mock.calls.some(([key]) =>
        String(key).startsWith("tutorhub.conversation-prefs:"),
      ),
    ).toBe(false);
    expect(localStorage.getItem(preferencesKey)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^Đã ghim/ }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Ghim Đại số tuyến tính" }),
    );
    expect(JSON.parse(localStorage.getItem(preferencesKey) ?? "{}")).toEqual({
      pinned: [activeClassConversationID],
      collapsed: [],
    });
    const favorites = screen.getByRole("button", { name: /^Đã ghim/ });
    expect(favorites).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /^Trò chuyện/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    const favoritesList = document.getElementById(
      favorites.getAttribute("aria-controls") ?? "",
    );
    expect(favoritesList).not.toBeNull();
    expect(
      within(favoritesList as HTMLElement).getByText("Đại số tuyến tính"),
    ).toBeInTheDocument();
    expect(
      within(favoritesList as HTMLElement).queryByText("TutorHub Student"),
    ).not.toBeInTheDocument();

    fireEvent.click(favorites);
    expect(favorites).toHaveAttribute("aria-expanded", "false");
    expect(favoritesList).not.toBeVisible();
    expect(JSON.parse(localStorage.getItem(preferencesKey) ?? "{}")).toEqual({
      pinned: [activeClassConversationID],
      collapsed: ["favorites"],
    });

    fireEvent.click(favorites);
    fireEvent.click(
      screen.getByRole("button", { name: "Bỏ ghim Đại số tuyến tính" }),
    );
    expect(localStorage.getItem(preferencesKey)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^Đã ghim/ }),
    ).not.toBeInTheDocument();
  });

  it("shows search shortcuts on focus and opens a prefilled direct conversation", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(listResponse()));

    renderPage("/app/messages", fetchMock);

    const search = await screen.findByRole("searchbox", {
      name: "Tìm cuộc trò chuyện",
    });
    expect(screen.queryByText("Lối tắt")).not.toBeInTheDocument();
    act(() => search.focus());
    expect(screen.getByText("Lối tắt")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Tìm hoặc tham gia lớp học/ }),
    ).toHaveAttribute("href", "/app/classrooms");

    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByText("Lối tắt")).not.toBeInTheDocument();
    expect(search).toHaveFocus();

    fireEvent.change(search, { target: { value: " Student@Example.com " } });
    expect(
      screen.getByText("Không có cuộc trò chuyện phù hợp"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /Nhắn tin trực tiếp bằng email/ }),
    );
    const email = await screen.findByRole("textbox", {
      name: "Email thành viên",
    });
    expect(email).toHaveValue("student@example.com");

    fireEvent.keyDown(email, { code: "Escape", key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "Bắt đầu trò chuyện" }),
    ).toHaveFocus();
  });

  describe("MSG-AVATAR-SEARCH-CLASSIN-01 ClassIn search", () => {
    function renderList() {
      const fetchMock = vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            listResponse([
              directConversation,
              activeClassConversation,
              endedRoomConversation,
            ]),
          ),
        );
      renderPage("/app/messages", fetchMock);
    }

    const filtersGroup = () =>
      screen.queryByRole("group", { name: "Lọc cuộc trò chuyện" });
    const listPanel = () =>
      document.querySelector(".conversation-list-panel__scroll");

    it("swaps the chips and list for a full shortcut panel on an empty focus", async () => {
      renderList();
      const search = await screen.findByRole("searchbox", {
        name: "Tìm cuộc trò chuyện",
      });
      await screen.findByText("Đại số tuyến tính");
      // Idle: chips and list, no panel, no clear button.
      expect(filtersGroup()).toBeInTheDocument();
      expect(listPanel()).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "Xóa tìm kiếm" }),
      ).not.toBeInTheDocument();

      act(() => search.focus());
      const panel = document.querySelector(".conversation-shortcuts--panel");
      expect(panel).not.toBeNull();
      expect(
        within(panel as HTMLElement).getByText("Lối tắt"),
      ).toBeInTheDocument();
      expect(filtersGroup()).not.toBeInTheDocument();
      expect(listPanel()).not.toBeVisible();
      const clear = screen.getByRole("button", { name: "Xóa tìm kiếm" });

      // Moving focus inside the search area keeps the panel open, and a
      // click on its empty space does not blur the search.
      fireEvent.focusOut(search, { relatedTarget: clear });
      expect(filtersGroup()).not.toBeInTheDocument();
      expect(
        fireEvent.mouseDown(within(panel as HTMLElement).getByText("Lối tắt")),
      ).toBe(false);

      // The clear button closes search mode and keeps focus on the input.
      fireEvent.click(clear);
      expect(document.querySelector(".conversation-shortcuts")).toBeNull();
      expect(filtersGroup()).toBeInTheDocument();
      expect(listPanel()).toBeVisible();
      expect(search).toHaveFocus();

      // Escape does the same.
      act(() => search.blur());
      act(() => search.focus());
      expect(filtersGroup()).not.toBeInTheDocument();
      fireEvent.keyDown(search, { key: "Escape" });
      expect(filtersGroup()).toBeInTheDocument();
      expect(search).toHaveFocus();

      // Leaving the search area closes the panel too.
      act(() => search.blur());
      act(() => search.focus());
      expect(filtersGroup()).not.toBeInTheDocument();
      fireEvent.focusOut(search, { relatedTarget: null });
      expect(filtersGroup()).toBeInTheDocument();
      expect(screen.getByText("Đại số tuyến tính")).toBeVisible();
    });

    it("keeps chips over the results and puts the shortcuts inside the scroller while typing", async () => {
      renderList();
      const search = await screen.findByRole("searchbox", {
        name: "Tìm cuộc trò chuyện",
      });
      await screen.findByText("Đại số tuyến tính");

      act(() => search.focus());
      fireEvent.change(search, { target: { value: "dai so" } });
      const filters = filtersGroup();
      expect(filters).toBeInTheDocument();
      const scroller = listPanel() as HTMLElement;
      expect(scroller).toBeVisible();
      expect(within(scroller).getByText("Đại số tuyến tính")).toBeVisible();
      expect(scroller.lastElementChild).toHaveClass(
        "conversation-shortcuts--results",
      );
      expect(
        within(scroller).getByRole("link", {
          name: /Tìm hoặc tham gia lớp học/,
        }),
      ).toHaveAttribute("href", "/app/classrooms");
      expect(
        document.querySelector(".conversation-shortcuts--panel"),
      ).toBeNull();
      // The filters still narrow the results.
      await pickCategory(filters as HTMLElement, "Trực tiếp");
      expect(
        screen.getByText("Không có cuộc trò chuyện phù hợp"),
      ).toBeInTheDocument();
      fireEvent.click(
        within(filters as HTMLElement).getByRole("button", { name: "Tất cả" }),
      );

      // Deleting the text while focused returns to the shortcut panel (the
      // menu took focus, so come back to the search first).
      act(() => search.focus());
      expect(
        document.querySelector(".conversation-shortcuts--panel"),
      ).toBeNull();
      fireEvent.change(search, { target: { value: "" } });
      expect(
        document.querySelector(".conversation-shortcuts--panel"),
      ).not.toBeNull();
      expect(filtersGroup()).not.toBeInTheDocument();

      // A value reset while the input is not focused never opens the panel.
      fireEvent.focusOut(search, { relatedTarget: null });
      act(() => search.blur());
      fireEvent.change(search, { target: { value: "toan" } });
      fireEvent.change(search, { target: { value: "" } });
      expect(document.querySelector(".conversation-shortcuts")).toBeNull();
      expect(filtersGroup()).toBeInTheDocument();
    });
  });

  it("draws people as Zalo avatars and classes and rooms as ClassIn covers", async () => {
    const roomWithClass: Conversation = {
      ...endedRoomConversation,
      id: "0b7c2d1e-3f4a-4b5c-8d6e-7f8091a2b3c4",
      class_id: activeClassID,
      media_space_id: "7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918",
      title: "Phòng học Đại số",
    };
    localStorage.setItem(
      `tutorhub.classroom-prefs:${tenantID}:${teacherID}`,
      JSON.stringify({ pinned: [], covers: { [activeClassID]: "lilac-dusk" } }),
    );
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          listResponse([
            directConversation,
            activeClassConversation,
            roomWithClass,
            endedRoomConversation,
          ]),
        ),
      );
    renderPage("/app/messages", fetchMock);

    const avatarOf = async (title: string) => {
      const link = (await screen.findByText(title)).closest("a");
      expect(link).not.toBeNull();
      return (link as HTMLElement).querySelector(".conversation-avatar");
    };

    const person = await avatarOf("TutorHub Student");
    expect(person).toHaveClass("user-avatar");
    expect(person).toHaveAttribute("aria-hidden", "true");
    expect(person).toHaveAttribute("data-avatar", "default");
    expect(person).toHaveTextContent("");

    // The class and its room share the cover chosen for the class.
    for (const title of ["Đại số tuyến tính", "Phòng học Đại số"]) {
      const cover = await avatarOf(title);
      expect(cover).toHaveClass("conversation-avatar--cover");
      expect(cover?.querySelector(".class-cover-art")).toHaveAttribute(
        "data-cover",
        "lilac-dusk",
      );
      expect(
        cover?.querySelector(".conversation-avatar__badge"),
      ).not.toBeNull();
    }

    // A standalone room gets a stable cover from its media space.
    const standalone = await avatarOf("Phòng ôn tập Toán");
    expect(standalone?.querySelector(".class-cover-art")).toHaveAttribute(
      "data-cover",
      defaultCoverTheme(endedRoomConversation.media_space_id ?? ""),
    );
    expect(document.querySelector(".conversation-list [data-tone]")).toBeNull();
  });

  it("keeps the presence dot on the direct header avatar", async () => {
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith(`/api/v1/conversations/${directID}/messages`)) {
        return Promise.resolve(emptyMessagePageResponse());
      }
      if (path.endsWith(`/api/v1/conversations/${directID}`)) {
        return Promise.resolve(jsonResponse(directConversation));
      }
      return Promise.resolve(listResponse());
    });
    renderPage(`/app/messages/${directID}`, fetchMock);

    const heading = await screen.findByRole("heading", {
      level: 2,
      name: "TutorHub Student",
    });
    const header = heading.closest("header") as HTMLElement;
    const avatar = header.querySelector(
      ".conversation-detail-panel__avatar .user-avatar",
    );
    expect(avatar).toHaveClass("conversation-avatar--sm");
    expect(avatar).toHaveAttribute("data-avatar", "default");
    expect(
      header.querySelector(
        '.conversation-detail-panel__avatar .conversation-presence-dot[aria-hidden="true"]',
      ),
    ).not.toBeNull();
    // The welcome block uses the large size of the same avatar.
    await waitFor(() =>
      expect(
        document.querySelector(
          ".conversation-welcome .user-avatar.conversation-avatar--lg",
        ),
      ).not.toBeNull(),
    );
  });

  it("welcomes a new class conversation with real class shortcuts", async () => {
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      const path = new URL(request.url).pathname;
      if (
        path.endsWith(
          `/api/v1/conversations/${activeClassConversationID}/messages`,
        )
      ) {
        return Promise.resolve(emptyMessagePageResponse());
      }
      if (path.endsWith(`/api/v1/conversations/${activeClassConversationID}`)) {
        return Promise.resolve(jsonResponse(activeClassConversation));
      }
      if (path.endsWith("/api/v1/conversations")) {
        return Promise.resolve(listResponse([activeClassConversation]));
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });

    renderPage(`/app/messages/${activeClassConversationID}`, fetchMock);

    const heading = await screen.findByRole("heading", {
      name: "Đại số tuyến tính",
    });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(
      await screen.findByRole("heading", {
        name: "Lớp học mới bắt đầu từ đây",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Thêm thành viên/ }),
    ).toHaveAttribute("href", `/app/classrooms/${activeClassID}?tab=members`);
    expect(
      screen.getByRole("link", { name: /Quản lý buổi học & tài liệu/ }),
    ).toHaveAttribute("href", `/app/classrooms/${activeClassID}`);
    for (const link of screen.getAllByRole("link", { name: /^Vào lớp học/ })) {
      expect(link).toHaveAttribute("href", `/app/classrooms/${activeClassID}`);
    }
    expect(
      screen.getByRole("link", { name: /^Kho tài liệu lớp/ }),
    ).toHaveAttribute("href", `/app/classrooms/${activeClassID}?tab=materials`);
    expect(
      screen.getByRole("link", { name: "Mở kho tài liệu lớp" }),
    ).toHaveAttribute("href", `/app/classrooms/${activeClassID}?tab=materials`);
    expect(
      screen.getByRole("textbox", { name: "Tin nhắn mới" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Đính kèm tệp hoặc ảnh" }),
    ).not.toBeInTheDocument();
  });

  it("shows a Zalo-style presence line without member chips and pins from the header", async () => {
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith(`/api/v1/conversations/${directID}/messages`)) {
        return Promise.resolve(emptyMessagePageResponse());
      }
      if (path.endsWith(`/api/v1/conversations/${directID}`)) {
        return Promise.resolve(jsonResponse(directConversation));
      }
      if (path.endsWith("/api/v1/conversations")) {
        return Promise.resolve(listResponse([directConversation]));
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });

    renderPage(`/app/messages/${directID}`, fetchMock);

    const heading = await screen.findByRole("heading", {
      level: 2,
      name: "TutorHub Student",
    });
    const header = heading.closest("header");
    expect(header).not.toBeNull();
    // Presence reads as a plain status line under the name; the kind label
    // ("Trực tiếp") and the participant chips are gone from the header.
    expect(
      within(header as HTMLElement).getByText("Đang hoạt động", {
        exact: true,
      }),
    ).toHaveClass("conversation-detail-panel__meta");
    expect(header?.textContent).not.toContain("Trực tiếp");
    expect(header?.querySelector(".conversation-presence-dot")).not.toBeNull();
    expect(
      screen.queryByRole("list", { name: "Thành viên" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("TutorHub Teacher")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("teacher@example.com");

    fireEvent.click(
      screen.getByRole("button", { name: "Ghim cuộc trò chuyện" }),
    );
    expect(localStorage.getItem(preferencesKey)).toContain(directID);
    expect(
      screen.getByRole("button", { name: "Bỏ ghim cuộc trò chuyện" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Đã ghim/ }),
    ).toBeInTheDocument();
  });

  it("conceals a foreign or missing conversation without rendering cached detail", async () => {
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith(`/api/v1/conversations/${directID}`)) {
        return Promise.resolve(
          jsonResponse(
            {
              type: "urn:tutorhub:problem:http-404",
              title: "Not found",
              status: 404,
            },
            404,
          ),
        );
      }
      if (path.endsWith("/api/v1/conversations")) {
        return Promise.resolve(listResponse());
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });

    const queryClient = renderPage(`/app/messages/${directID}`, fetchMock);
    queryClient.setQueryData(
      ["conversations", tenantID, "detail", directID],
      directConversation,
    );
    await queryClient.invalidateQueries({
      queryKey: ["conversations", tenantID, "detail", directID],
    });

    expect(
      await screen.findByRole("heading", {
        name: "Cuộc trò chuyện không khả dụng",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("TutorHub Teacher")).not.toBeInTheDocument();
  });

  describe("MSG-WELCOME-3D-01 welcome carousel", () => {
    const carouselName = "Giới thiệu tính năng TutorHub";

    function stubViewport(wide: boolean) {
      vi.stubGlobal("matchMedia", (query: string) => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(),
        matches: query === "(min-width: 860px)" ? wide : false,
        media: query,
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      }));
    }

    function slideLabels(carousel: HTMLElement) {
      return within(carousel)
        .getAllByRole("group", { hidden: true })
        .filter(
          (group) => group.getAttribute("aria-roledescription") === "slide",
        )
        .map((group) => group.getAttribute("aria-label"));
    }

    it("welcomes desktop users with real, capability-filtered features while no conversation is open", async () => {
      stubViewport(true);
      renderPage("/app/messages", vi.fn().mockResolvedValue(listResponse()));

      const carousel = await screen.findByRole("region", {
        name: carouselName,
      });
      expect(
        screen.getByRole("heading", {
          level: 2,
          name: "Chào mừng đến với TutorHub!",
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          "Chọn một cuộc trò chuyện ở danh sách bên trái để bắt đầu nhắn tin.",
        ),
      ).toBeInTheDocument();
      // The fixture enables the Code tool but not whiteboards or files.
      expect(slideLabels(carousel)).toEqual([
        "1 / 4: Nhắn tin lớp học & trò chuyện riêng",
        "2 / 4: Phòng học trực tuyến",
        "3 / 4: Lịch học & nhắc lịch",
        "4 / 4: Code cùng nhau trong lớp",
      ]);
      expect(
        within(carousel).queryByText("Bảng trắng cộng tác"),
      ).not.toBeInTheDocument();
      expect(
        within(carousel).queryByText("Tài liệu & trình chiếu PDF"),
      ).not.toBeInTheDocument();
      expect(localStorage.length).toBe(0);
    });

    it("keeps the compact prompt and skips the carousel below 860px", async () => {
      stubViewport(false);
      renderPage("/app/messages", vi.fn().mockResolvedValue(listResponse()));

      expect(await screen.findByText("TutorHub Student")).toBeInTheDocument();
      expect(screen.getByText("Chọn một cuộc trò chuyện")).toBeInTheDocument();
      expect(
        screen.queryByRole("region", { name: carouselName }),
      ).not.toBeInTheDocument();
    });

    it("opens the existing create dialog from the carousel and returns focus to it", async () => {
      stubViewport(true);
      renderPage("/app/messages", vi.fn().mockResolvedValue(listResponse()));

      const carousel = await screen.findByRole("region", {
        name: carouselName,
      });
      const cta = within(carousel).getByRole("button", {
        name: "Bắt đầu trò chuyện",
      });
      fireEvent.click(cta);

      const email = await screen.findByRole("textbox", {
        name: "Email thành viên",
      });
      await waitFor(() => expect(email).toHaveFocus());
      fireEvent.keyDown(email, { code: "Escape", key: "Escape" });

      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(cta).toHaveFocus();
    });

    it("blocks the carousel start action with the same reason as the header", async () => {
      stubViewport(true);
      const base = availableTenantCapabilities(tenantID);
      renderPage("/app/messages", vi.fn().mockResolvedValue(listResponse()), {
        ...base,
        operations: {
          ...base.operations,
          create_conversation: {
            available: false,
            reason: "feature_disabled",
          },
        },
      });

      const carousel = await screen.findByRole("region", {
        name: carouselName,
      });
      const cta = within(carousel).getByRole("button", {
        name: "Bắt đầu trò chuyện",
      });
      expect(cta).toBeDisabled();
      expect(cta).toHaveAccessibleDescription(
        "Tính năng này đang bị tắt cho workspace hiện tại.",
      );
    });

    it("does not show the carousel once a conversation is selected", async () => {
      stubViewport(true);
      const fetchMock = vi.fn().mockImplementation((request: Request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith(`/api/v1/conversations/${directID}/messages`)) {
          return Promise.resolve(emptyMessagePageResponse());
        }
        if (path.endsWith(`/api/v1/conversations/${directID}`)) {
          return Promise.resolve(jsonResponse(directConversation));
        }
        if (path.endsWith("/api/v1/conversations")) {
          return Promise.resolve(listResponse([directConversation]));
        }
        return Promise.reject(new Error(`Unexpected request: ${request.url}`));
      });

      renderPage(`/app/messages/${directID}`, fetchMock);

      expect(
        await screen.findByRole("heading", {
          level: 2,
          name: "TutorHub Student",
        }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("region", { name: carouselName }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("Chào mừng đến với", { exact: false }),
      ).not.toBeInTheDocument();
    });
  });

  it("previews card messages as cards in the conversation list", async () => {
    const card = (
      id: string,
      conversationID: string,
      own: boolean,
      embed: unknown,
    ) =>
      ({
        id,
        conversation_id: conversationID,
        sequence: 3,
        client_message_id: id,
        author: own
          ? { user_id: teacherID, display_name: "TutorHub Teacher" }
          : { user_id: studentID, display_name: "TutorHub Student" },
        content: "",
        attachments: [],
        embed,
        state: "active",
        version: 1,
        created_at: "2026-08-03T12:00:00Z",
        updated_at: "2026-08-03T12:00:00Z",
      }) as Message;
    const seedPage = (
      queryClient: QueryClient,
      conversationID: string,
      item: Message,
    ) =>
      queryClient.setQueryData(
        conversationQueryKeys.messages(tenantID, conversationID),
        {
          pageParams: [undefined],
          pages: [
            {
              items: [item],
              read_state: null,
              unread_count: 0,
              unread_count_capped: false,
            } satisfies MessagePage,
          ],
        },
      );
    renderPage(
      "/app/messages",
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            listResponse([directConversation, activeClassConversation]),
          ),
        ),
      availableTenantCapabilities(tenantID),
      (queryClient) => {
        seedPage(
          queryClient,
          directID,
          card("10000000-0000-4000-8000-000000000031", directID, false, {
            kind: "contact_card",
            available: true,
            user_id: "0d6e7a51-5d3c-4c1b-8a6f-7e8a9b0c1d2e",
            display_name: "Lê Thu Hà",
          }),
        );
        seedPage(
          queryClient,
          activeClassConversationID,
          card(
            "10000000-0000-4000-8000-000000000032",
            activeClassConversationID,
            true,
            {
              kind: "instant_class",
              media_space_id: "d3b3a0b2-6b5e-4f5e-9a51-1c0f0e6d2c11",
              title: "Ôn tập chương 3",
              status: "scheduled",
              ends_at: "2026-08-03T12:15:00Z",
              remaining_seconds: 900,
              viewer_can_join: true,
            },
          ),
        );
      },
    );

    expect(
      await screen.findByText("[Danh thiếp] Lê Thu Hà"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Bạn: [Lớp học tạm thời] Ôn tập chương 3"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Đã gửi tệp đính kèm/)).not.toBeInTheDocument();
  });

  it("previews sticker messages as [Sticker] with the localized label (MSG-STICKER-03)", async () => {
    const sticker = (
      id: string,
      conversationID: string,
      own: boolean,
      embed: unknown,
    ) =>
      ({
        id,
        conversation_id: conversationID,
        sequence: 4,
        client_message_id: id,
        author: own
          ? { user_id: teacherID, display_name: "TutorHub Teacher" }
          : { user_id: studentID, display_name: "TutorHub Student" },
        content: "",
        attachments: [],
        embed,
        state: "active",
        version: 1,
        created_at: "2026-08-03T12:00:00Z",
        updated_at: "2026-08-03T12:00:00Z",
      }) as Message;
    const seed = (
      queryClient: QueryClient,
      conversationID: string,
      item: Message,
    ) =>
      queryClient.setQueryData(
        conversationQueryKeys.messages(tenantID, conversationID),
        {
          pageParams: [undefined],
          pages: [
            {
              items: [item],
              read_state: null,
              unread_count: 0,
              unread_count_capped: false,
            } satisfies MessagePage,
          ],
        },
      );
    renderPage(
      "/app/messages",
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            listResponse([directConversation, activeClassConversation]),
          ),
        ),
      availableTenantCapabilities(tenantID),
      (queryClient) => {
        seed(
          queryClient,
          directID,
          sticker("10000000-0000-4000-8000-000000000041", directID, false, {
            kind: "sticker",
            available: true,
            sticker_id: "noto_animated:1f602",
            pack_id: "noto_animated",
            labels: { vi: "Cười ra nước mắt", en: "Tears of joy" },
            asset: {
              animated_url: "/stickers/noto_animated/v1/1f602.webp",
              static_url: "/stickers/noto_animated/v1/1f602.static.webp",
              width: 160,
              height: 160,
            },
          }),
        );
        seed(
          queryClient,
          activeClassConversationID,
          sticker(
            "10000000-0000-4000-8000-000000000042",
            activeClassConversationID,
            true,
            { kind: "sticker", available: false },
          ),
        );
      },
    );

    expect(
      await screen.findByText("[Sticker] Cười ra nước mắt"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Bạn: Sticker không còn khả dụng"),
    ).toBeInTheDocument();
  });
});
