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
  TenantCapabilities,
} from "@tutorhub/api-client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("filters by accent-insensitive search and Teams-style chips", async () => {
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

    fireEvent.click(within(filters).getByRole("button", { name: "Lớp học" }));
    expect(screen.getByText("Đại số tuyến tính")).toBeInTheDocument();
    expect(screen.queryByText("TutorHub Student")).not.toBeInTheDocument();

    fireEvent.click(within(filters).getByRole("button", { name: "Trực tiếp" }));
    expect(screen.getByText("TutorHub Student")).toBeInTheDocument();
    expect(screen.queryByText("Đại số tuyến tính")).not.toBeInTheDocument();

    fireEvent.click(
      within(filters).getByRole("button", { name: "Phòng trực tuyến" }),
    );
    expect(screen.getByText("Phòng ôn tập Toán")).toBeInTheDocument();
    expect(screen.queryByText("TutorHub Student")).not.toBeInTheDocument();
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
});
