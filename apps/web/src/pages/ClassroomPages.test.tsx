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
  ClassSession,
  ClassroomClass,
  CurrentUser,
  MediaSpace,
  TenantCapabilities,
} from "@tutorhub/api-client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classEnrollmentQueryKeys } from "../app/classEnrollments";
import { classQueryKeys } from "../app/classes";
import { I18nProvider } from "../app/i18n";
import { SessionProvider } from "../app/session";
import { tenantCapabilityQueryKeys } from "../app/tenantCapabilities";
import {
  availableTenantCapabilities,
  withAvailableTenantCapabilities,
} from "../test/tenantCapabilities";
import { ClassroomDetailPage, ClassroomListPage } from "./ClassroomPages";

const tenantID = "4b18543a-74de-419f-9fe8-d0c3dfc991eb";
const ownerID = "be85eb92-0f18-4163-85ba-50e4d343d632";
const classID = "a912f628-f3d2-4c18-84c6-42a9e858dc8d";
const spaceID = "c2dc1048-1d90-4c90-ae50-5fb436bfb607";

const classroom: ClassroomClass = {
  id: classID,
  owner_user_id: ownerID,
  code: "SEC101",
  title: "Cơ sở An toàn thông tin",
  description: "Lớp học kỳ 1",
  timezone: "Asia/Ho_Chi_Minh",
  status: "active",
  version: 3,
  archived_at: null,
  created_at: "2026-07-18T01:00:00Z",
  updated_at: "2026-07-18T02:00:00Z",
  viewer_access: {
    class_role: null,
    enrollment_status: null,
    can_update_class: true,
    can_archive_class: true,
    can_transfer_ownership: true,
    can_manage_enrollments: false,
    can_schedule_sessions: true,
    can_join_room: true,
    can_publish_media: true,
    can_leave: false,
  },
};

const learnerView: ClassroomClass = {
  ...classroom,
  viewer_access: {
    ...classroom.viewer_access,
    class_role: "student",
    enrollment_status: "active",
    can_update_class: false,
    can_archive_class: false,
    can_transfer_ownership: false,
    can_schedule_sessions: false,
  },
};

function classSession(overrides: Partial<ClassSession> = {}): ClassSession {
  return {
    id: "9f8bf389-362c-48ca-8e67-53df4e558f4d",
    class_id: classID,
    title: "Buổi 1",
    description: "",
    starts_at: "2026-07-20T01:30:00Z",
    ends_at: "2026-07-20T03:00:00Z",
    timezone: "Asia/Ho_Chi_Minh",
    status: "scheduled",
    version: 1,
    viewer_access: { can_update: true, can_cancel: true },
    created_by: ownerID,
    updated_by: ownerID,
    cancelled_by: null,
    cancelled_at: null,
    created_at: "2026-07-19T02:00:00Z",
    updated_at: "2026-07-19T02:00:00Z",
    ...overrides,
  };
}

const openSpace: MediaSpace = {
  id: spaceID,
  source: {
    kind: "class_session",
    class_session_id: "9f8bf389-362c-48ca-8e67-53df4e558f4d",
  },
  status: "open",
  version: 2,
  active_room_instance: {
    id: "c5f918a5-a09e-4f94-9fab-fb0ab5702a4d",
    status: "active",
    version: 1,
    created_at: "2026-07-20T02:00:00Z",
    updated_at: "2026-07-20T02:00:00Z",
  },
  recovery_room_instance: null,
  viewer_operations: {
    can_start: true,
    can_end: true,
    can_cancel: true,
    can_manage_admissions: true,
    can_manage_invites: false,
    can_recover: false,
  },
  created_at: "2026-07-20T02:00:00Z",
  updated_at: "2026-07-20T02:00:00Z",
};

function currentUser({
  role = "teacher",
  userID = ownerID,
}: {
  role?: "org_admin" | "teacher";
  userID?: string;
} = {}): CurrentUser {
  const membership = {
    id: tenantID,
    slug: "tutorhub-test",
    name: "TutorHub Test",
    role,
    is_active: true,
    status: "active" as const,
    version: 1,
  };
  return {
    user: {
      id: userID,
      email: "teacher@example.com",
      display_name: "TutorHub Teacher",
      locale: "vi",
      timezone: "UTC",
    },
    active_tenant: membership,
    memberships: [membership],
    permissions: [
      "class.view",
      "class.create",
      "class.update",
      ...(role === "org_admin" ? (["class.archive"] as const) : []),
      "session.join",
    ],
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type":
        status >= 400 ? "application/problem+json" : "application/json",
    },
  });
}

function LocationProbe() {
  const location = useLocation();
  return (
    <>
      <output data-testid="location">{`${location.pathname}${location.search}`}</output>
      <output data-testid="location-state">
        {JSON.stringify(location.state ?? null)}
      </output>
    </>
  );
}

interface RenderOptions {
  features?: Partial<TenantCapabilities["features"]>;
  filesResponse?: () => Response;
}

function renderClassRoute(
  path: string,
  fetchMock: (request: Request) => Promise<Response>,
  session = currentUser(),
  mediaRoomsEnabled = false,
  { features = {}, filesResponse }: RenderOptions = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const capabilities = availableTenantCapabilities(tenantID);
  queryClient.setQueryData(tenantCapabilityQueryKeys.detail(tenantID), {
    ...capabilities,
    features: {
      ...capabilities.features,
      classroom_media_rooms: {
        configured_enabled: mediaRoomsEnabled,
        enabled: mediaRoomsEnabled,
      },
      ...features,
    },
  });
  const fetchWithClassFiles = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      if (
        new URL(request.url).pathname.endsWith(
          `/api/v1/classes/${classID}/files`,
        )
      ) {
        return Promise.resolve(
          filesResponse?.() ??
            jsonResponse({
              items: [],
              next_cursor: null,
              viewer_access: { can_upload: false },
            }),
        );
      }
      return fetchMock(request);
    },
  );
  vi.stubGlobal(
    "fetch",
    withAvailableTenantCapabilities(fetchWithClassFiles, tenantID),
  );
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLanguage="vi">
        <SessionProvider mode={{ kind: "static", currentUser: session }}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route element={<ClassroomListPage />} path="/app/classrooms" />
              <Route
                element={<ClassroomDetailPage />}
                path="/app/classrooms/:classId"
              />
              <Route
                element={<h1>Phòng chờ media</h1>}
                path="/app/media/spaces/:spaceId/prejoin"
              />
            </Routes>
            <LocationProbe />
          </MemoryRouter>
        </SessionProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

function requestFrom(call: unknown[]) {
  return call[0] as Request;
}

function requestsOf(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map(requestFrom);
}

function clickTab(tab: HTMLElement) {
  fireEvent.mouseDown(tab);
  act(() => tab.focus());
  fireEvent.mouseUp(tab);
  fireEvent.click(tab);
}

function pathOf(request: Request) {
  return new URL(request.url).pathname;
}

describe("ClassroomPages P2-04", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("filters by status and loads cursor pages without losing the first page", async () => {
    const secondClass: ClassroomClass = {
      ...classroom,
      id: "f24d8c4b-b141-475f-b20a-ed0bfe96da6b",
      code: "SEC102",
      title: "An toàn ứng dụng",
      version: 1,
    };
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      const url = new URL(request.url);
      if (!url.pathname.endsWith("/api/v1/classes")) {
        return Promise.reject(new Error(`Unexpected request: ${request.url}`));
      }
      if (url.searchParams.get("status") === "archived") {
        return Promise.resolve(
          jsonResponse({
            items: [
              {
                ...classroom,
                status: "archived",
                archived_at: classroom.updated_at,
              },
            ],
            next_cursor: null,
          }),
        );
      }
      if (url.searchParams.get("cursor") === "cursor-page-2") {
        return Promise.resolve(
          jsonResponse({ items: [secondClass], next_cursor: null }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          items: [classroom],
          next_cursor: "cursor-page-2",
        }),
      );
    });

    renderClassRoute("/app/classrooms", fetchMock);

    expect(
      await screen.findByText("Cơ sở An toàn thông tin"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tải thêm lớp" }));
    expect(await screen.findByText("An toàn ứng dụng")).toBeInTheDocument();
    expect(screen.getByText("Cơ sở An toàn thông tin")).toBeInTheDocument();

    const secondPageRequest = fetchMock.mock.calls
      .map(requestFrom)
      .find((request) => request.url.includes("cursor=cursor-page-2"));
    expect(secondPageRequest?.url).toContain("limit=20");

    const statusTrigger = screen.getByRole("combobox", {
      name: "Lọc theo trạng thái",
    });
    fireEvent.keyDown(statusTrigger, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Đã lưu trữ" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls
          .map(requestFrom)
          .some((request) => request.url.includes("status=archived")),
      ).toBe(true);
    });
  });

  it.each([401, 403, 404])(
    "hides cached class data and actions after a refreshed %s",
    async (status) => {
      let reads = 0;
      const fetchMock = vi.fn().mockImplementation((request: Request) => {
        if (
          new URL(request.url).pathname.endsWith("/api/v1/classes") &&
          request.method === "GET"
        ) {
          reads += 1;
          return Promise.resolve(
            reads === 1
              ? jsonResponse({ items: [classroom], next_cursor: null })
              : jsonResponse(
                  {
                    type: "urn:tutorhub:problem:access-boundary",
                    title: "Class list unavailable",
                    status,
                  },
                  status,
                ),
          );
        }
        return Promise.reject(new Error(`Unexpected request: ${request.url}`));
      });
      const queryClient = renderClassRoute("/app/classrooms", fetchMock);

      expect(await screen.findByText(classroom.title)).toBeInTheDocument();
      await queryClient.refetchQueries({
        exact: true,
        queryKey: classQueryKeys.list(tenantID, "all"),
      });

      await waitFor(() =>
        expect(screen.queryByText(classroom.title)).not.toBeInTheDocument(),
      );
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Tạo lớp học" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Tham gia bằng mã" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("combobox", { name: "Lọc theo trạng thái" }),
      ).not.toBeInTheDocument();
    },
  );

  it("uses the active workspace timezone when creating a draft class", async () => {
    const created = {
      ...classroom,
      status: "draft" as const,
      timezone: "Asia/Bangkok",
      version: 1,
    };
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      const url = new URL(request.url);
      if (
        url.pathname.endsWith(`/api/v1/tenants/${tenantID}`) &&
        request.method === "GET"
      ) {
        return Promise.resolve(jsonResponse({ timezone: "Asia/Bangkok" }));
      }
      if (url.pathname.endsWith("/api/v1/auth/csrf")) {
        return Promise.resolve(jsonResponse({ csrf_token: "class-csrf" }));
      }
      if (
        url.pathname.endsWith("/api/v1/classes") &&
        request.method === "POST"
      ) {
        return Promise.resolve(jsonResponse(created, 201));
      }
      if (
        url.pathname.endsWith("/api/v1/classes") &&
        request.method === "GET"
      ) {
        return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });

    renderClassRoute("/app/classrooms", fetchMock);

    await screen.findByText("Workspace chưa có lớp học");
    fireEvent.click(screen.getByRole("button", { name: "Tạo lớp học" }));
    const advanced = screen.getByRole("button", { name: "Tùy chọn nâng cao" });
    expect(advanced).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("textbox", { name: /^Mã lớp/ })).toBeNull();
    fireEvent.click(advanced);
    expect(advanced).toHaveAttribute("aria-expanded", "true");
    const timezoneInput = screen.getByRole("textbox", {
      name: /^Múi giờ lớp học/,
    });
    await waitFor(() => expect(timezoneInput).toHaveValue("Asia/Bangkok"));
    fireEvent.change(screen.getByRole("textbox", { name: /^Mã lớp/ }), {
      target: { value: "sec101" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Tên lớp" }), {
      target: { value: classroom.title },
    });
    const draftCheckbox = screen.getByRole("checkbox", {
      name: "Lưu làm bản nháp (chưa mở lớp ngay)",
    });
    expect(draftCheckbox).not.toBeChecked();
    fireEvent.click(draftCheckbox);
    fireEvent.click(screen.getByRole("button", { name: "Tạo lớp" }));

    await screen.findByRole("heading", { name: classroom.title });
    expect(
      fetchMock.mock.calls
        .map(requestFrom)
        .some((request) => request.method === "PATCH"),
    ).toBe(false);
    expect(
      screen.getByRole("region", { name: "Lớp đang ở trạng thái bản nháp" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Kích hoạt lớp ngay" }),
    ).toBeInTheDocument();
    const createRequest = fetchMock.mock.calls
      .map(requestFrom)
      .find(
        (request) =>
          request.method === "POST" && request.url.endsWith("/api/v1/classes"),
      );
    expect(createRequest?.headers.get("X-CSRF-Token")).toBe("class-csrf");
    await expect(createRequest?.clone().json()).resolves.toMatchObject({
      timezone: "Asia/Bangkok",
    });
  });

  it("updates metadata with the base version and activates a draft", async () => {
    const draft = { ...classroom, status: "draft" as const };
    const updated = {
      ...draft,
      title: "An toàn thông tin nâng cao",
      status: "active" as const,
      version: 4,
      updated_at: "2026-07-18T03:00:00Z",
    };
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      if (request.url.endsWith("/api/v1/auth/csrf")) {
        return Promise.resolve(jsonResponse({ csrf_token: "update-csrf" }));
      }
      if (
        request.url.endsWith(`/api/v1/classes/${classID}`) &&
        request.method === "PATCH"
      ) {
        return Promise.resolve(jsonResponse(updated));
      }
      if (
        request.url.endsWith(`/api/v1/classes/${classID}`) &&
        request.method === "GET"
      ) {
        return Promise.resolve(jsonResponse(draft));
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });

    renderClassRoute(`/app/classrooms/${classID}?tab=settings`, fetchMock);

    const titleInput = await screen.findByRole("textbox", {
      name: "Tên lớp",
    });
    fireEvent.change(titleInput, {
      target: { value: "An toàn thông tin nâng cao" },
    });
    const statusTrigger = screen.getByRole("combobox", {
      name: "Trạng thái lớp",
    });
    fireEvent.keyDown(statusTrigger, { key: "ArrowDown" });
    fireEvent.click(
      await screen.findByRole("option", { name: "Đang hoạt động" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Lưu thay đổi" }));

    expect(
      await screen.findByRole("heading", {
        name: "An toàn thông tin nâng cao",
      }),
    ).toBeInTheDocument();
    const updateRequest = fetchMock.mock.calls
      .map(requestFrom)
      .find((request) => request.method === "PATCH");
    expect(updateRequest?.headers.get("X-CSRF-Token")).toBe("update-csrf");
    await expect(updateRequest?.clone().json()).resolves.toMatchObject({
      expected_version: 3,
      status: "active",
      title: "An toàn thông tin nâng cao",
    });
  });

  it("keeps a conflicting edit until the user reloads the latest version", async () => {
    const latest = {
      ...classroom,
      title: "Tên từ máy chủ",
      version: 4,
      updated_at: "2026-07-18T03:00:00Z",
    };
    let detailReads = 0;
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      if (request.url.endsWith("/api/v1/auth/csrf")) {
        return Promise.resolve(jsonResponse({ csrf_token: "update-csrf" }));
      }
      if (request.method === "PATCH") {
        return Promise.resolve(
          jsonResponse(
            {
              type: "urn:tutorhub:problem:class-version-conflict",
              title: "Class changed",
              status: 409,
            },
            409,
          ),
        );
      }
      if (
        request.url.endsWith(`/api/v1/classes/${classID}`) &&
        request.method === "GET"
      ) {
        detailReads += 1;
        return Promise.resolve(
          jsonResponse(detailReads === 1 ? classroom : latest),
        );
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });

    renderClassRoute(`/app/classrooms/${classID}?tab=settings`, fetchMock);

    const titleInput = await screen.findByRole("textbox", {
      name: "Tên lớp",
    });
    fireEvent.change(titleInput, { target: { value: "Bản sửa của tôi" } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu thay đổi" }));
    expect(
      await screen.findByText(/Lớp đã được thay đổi ở nơi khác/),
    ).toBeInTheDocument();
    expect(titleInput).toHaveValue("Bản sửa của tôi");

    fireEvent.click(screen.getByRole("button", { name: "Tải bản mới nhất" }));
    await waitFor(() => expect(titleInput).toHaveValue("Tên từ máy chủ"));
  });

  it("reports a duplicate code without presenting stale-version recovery", async () => {
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      if (request.url.endsWith("/api/v1/auth/csrf")) {
        return Promise.resolve(jsonResponse({ csrf_token: "update-csrf" }));
      }
      if (request.method === "PATCH") {
        return Promise.resolve(
          jsonResponse(
            {
              type: "urn:tutorhub:problem:conflict",
              title: "Class code already exists",
              status: 409,
            },
            409,
          ),
        );
      }
      if (
        request.url.endsWith(`/api/v1/classes/${classID}`) &&
        request.method === "GET"
      ) {
        return Promise.resolve(jsonResponse(classroom));
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });

    renderClassRoute(`/app/classrooms/${classID}?tab=settings`, fetchMock);

    fireEvent.change(await screen.findByRole("textbox", { name: /^Mã lớp/ }), {
      target: { value: "SEC999" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Lưu thay đổi" }));

    expect(
      await screen.findByText(/Mã lớp đã tồn tại trong workspace này/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Tải bản mới nhất" }),
    ).not.toBeInTheDocument();
  });

  it("confirms archive and restore while keeping lifecycle controls owner-scoped", async () => {
    let state = classroom;
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      if (request.url.endsWith("/api/v1/auth/csrf")) {
        return Promise.resolve(jsonResponse({ csrf_token: "lifecycle-csrf" }));
      }
      if (
        request.url.endsWith(`/api/v1/classes/${classID}/archive`) &&
        request.method === "POST"
      ) {
        state = {
          ...state,
          status: "archived",
          version: 4,
          archived_at: "2026-07-18T04:00:00Z",
        };
        return Promise.resolve(jsonResponse(state));
      }
      if (
        request.url.endsWith(`/api/v1/classes/${classID}/restore`) &&
        request.method === "POST"
      ) {
        state = {
          ...state,
          status: "active",
          version: 5,
          archived_at: null,
        };
        return Promise.resolve(jsonResponse(state));
      }
      if (
        request.url.endsWith(`/api/v1/classes/${classID}`) &&
        request.method === "GET"
      ) {
        return Promise.resolve(jsonResponse(state));
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });

    const queryClient = renderClassRoute(
      `/app/classrooms/${classID}`,
      fetchMock,
    );
    const inviteKey = classEnrollmentQueryKeys.inviteCodes(tenantID, classID);
    const rosterKey = classEnrollmentQueryKeys.roster(
      tenantID,
      classID,
      "",
      "all",
    );
    queryClient.setQueryData(inviteKey, { items: [] });
    queryClient.setQueryData(rosterKey, { pageParams: [], pages: [] });

    expect(
      await screen.findByRole("link", {
        name: "Vào phòng học trực tuyến",
      }),
    ).toBeInTheDocument();
    clickTab(screen.getByRole("tab", { name: "Cài đặt" }));
    fireEvent.click(await screen.findByRole("button", { name: "Lưu trữ lớp" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Xác nhận lưu trữ" }),
    );

    expect(
      await screen.findByRole("button", { name: "Khôi phục lớp" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Vào phòng học trực tuyến" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Chỉnh sửa lớp học" }),
    ).not.toBeInTheDocument();

    const archiveRequest = fetchMock.mock.calls
      .map(requestFrom)
      .find((request) => request.url.endsWith("/archive"));
    await expect(archiveRequest?.clone().json()).resolves.toEqual({
      expected_version: 3,
    });
    expect(queryClient.getQueryState(inviteKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(rosterKey)?.isInvalidated).toBe(true);

    queryClient.setQueryData(inviteKey, { items: [] });
    queryClient.setQueryData(rosterKey, { pageParams: [], pages: [] });
    fireEvent.click(screen.getByRole("button", { name: "Khôi phục lớp" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Xác nhận khôi phục" }),
    );
    expect(
      await screen.findByRole("button", { name: "Lưu trữ lớp" }),
    ).toBeInTheDocument();

    const restoreRequest = fetchMock.mock.calls
      .map(requestFrom)
      .find((request) => request.url.endsWith("/restore"));
    await expect(restoreRequest?.clone().json()).resolves.toEqual({
      expected_version: 4,
    });
    expect(queryClient.getQueryState(inviteKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(rosterKey)?.isInvalidated).toBe(true);
  });

  it("does not expose archive or restore to a non-owner teacher", async () => {
    const teacherView = {
      ...classroom,
      viewer_access: {
        ...classroom.viewer_access,
        can_archive_class: false,
        can_transfer_ownership: false,
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(teacherView));
    renderClassRoute(
      `/app/classrooms/${classID}?tab=settings`,
      fetchMock,
      currentUser({
        role: "teacher",
        userID: "c7e64873-6e2f-48f3-9988-bb2d345401ed",
      }),
    );

    expect(
      await screen.findByRole("heading", { name: classroom.title }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Chỉnh sửa lớp học" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Lưu trữ lớp" }),
    ).not.toBeInTheDocument();
  });

  it("removes the class-wide P1 prejoin link when P4 media is enabled", async () => {
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      const path = new URL(request.url).pathname;
      if (
        path.endsWith(`/api/v1/classes/${classID}`) &&
        request.method === "GET"
      ) {
        return Promise.resolve(jsonResponse(classroom));
      }
      if (
        path.endsWith(`/api/v1/classes/${classID}/sessions`) &&
        request.method === "GET"
      ) {
        return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });
    renderClassRoute(
      `/app/classrooms/${classID}`,
      fetchMock,
      currentUser(),
      true,
    );

    expect(
      await screen.findByRole("heading", { name: classroom.title }),
    ).toBeVisible();
    expect(
      screen.queryByRole("link", {
        name: "Vào phòng học trực tuyến",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Vào phòng học ngay" }),
    ).toBeEnabled();
  });

  it("exposes lifecycle controls to an organization admin who is not the owner", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(classroom));
    renderClassRoute(
      `/app/classrooms/${classID}?tab=settings`,
      fetchMock,
      currentUser({
        role: "org_admin",
        userID: "c7e64873-6e2f-48f3-9988-bb2d345401ed",
      }),
    );

    expect(
      await screen.findByRole("button", { name: "Lưu trữ lớp" }),
    ).toBeInTheDocument();
  });

  it("switches between the four horizontal tabs and keeps ?tab in sync", async () => {
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      const path = pathOf(request);
      if (path.endsWith(`/api/v1/classes/${classID}`)) {
        return Promise.resolve(jsonResponse(classroom));
      }
      if (path.endsWith(`/api/v1/classes/${classID}/sessions`)) {
        return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
      }
      if (path.endsWith(`/api/v1/classes/${classID}/roster`)) {
        return Promise.resolve(
          jsonResponse({ class_owner: null, items: [], next_cursor: null }),
        );
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });
    renderClassRoute(`/app/classrooms/${classID}?tab=unknown`, fetchMock);

    const tablist = await screen.findByRole("tablist", {
      name: "Các mục của lớp học",
    });
    expect(
      within(tablist)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Buổi học", "Tài liệu", "Thành viên", "Cài đặt"]);
    expect(screen.getByRole("tab", { name: "Buổi học" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      await screen.findByRole("heading", { name: "Lịch buổi học" }),
    ).toBeInTheDocument();
    // The conversation shortcut stays on the hero regardless of the tab.
    expect(
      screen.getByRole("button", { name: "Mở trao đổi lớp" }),
    ).toBeInTheDocument();

    clickTab(screen.getByRole("tab", { name: "Tài liệu" }));
    expect(
      await screen.findByRole("heading", { name: "Tệp của lớp" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent(
      `/app/classrooms/${classID}?tab=materials`,
    );

    clickTab(screen.getByRole("tab", { name: "Cài đặt" }));
    expect(
      await screen.findByRole("heading", { name: "Thông tin lớp học" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Tệp của lớp" })).toBeNull();
    expect(screen.getByTestId("location")).toHaveTextContent("?tab=settings");

    const settingsTab = screen.getByRole("tab", { name: "Cài đặt" });
    fireEvent.keyDown(settingsTab, { key: "ArrowLeft" });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Thành viên" })).toHaveFocus(),
    );
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("?tab=members"),
    );

    clickTab(screen.getByRole("tab", { name: "Buổi học" }));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        new RegExp(`^/app/classrooms/${classID}$`),
      ),
    );
  });

  it("creates an active class by default by activating the version-1 draft", async () => {
    const draft = {
      ...classroom,
      status: "draft" as const,
      version: 1,
    };
    const activated = { ...draft, status: "active" as const, version: 2 };
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      const path = pathOf(request);
      if (path.endsWith(`/api/v1/tenants/${tenantID}`)) {
        return Promise.resolve(jsonResponse({ timezone: classroom.timezone }));
      }
      if (path.endsWith("/api/v1/auth/csrf")) {
        return Promise.resolve(jsonResponse({ csrf_token: "class-csrf" }));
      }
      if (path.endsWith("/api/v1/classes") && request.method === "POST") {
        return Promise.resolve(jsonResponse(draft, 201));
      }
      if (
        path.endsWith(`/api/v1/classes/${classID}`) &&
        request.method === "PATCH"
      ) {
        return Promise.resolve(jsonResponse(activated));
      }
      if (path.endsWith("/api/v1/classes") && request.method === "GET") {
        return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
      }
      if (path.endsWith(`/api/v1/classes/${classID}/sessions`)) {
        return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });
    renderClassRoute("/app/classrooms", fetchMock);

    await screen.findByText("Workspace chưa có lớp học");
    fireEvent.click(screen.getByRole("button", { name: "Tạo lớp học" }));
    fireEvent.click(screen.getByRole("button", { name: "Tùy chọn nâng cao" }));
    fireEvent.change(screen.getByRole("textbox", { name: /^Mã lớp/ }), {
      target: { value: "sec101" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Tên lớp" }), {
      target: { value: classroom.title },
    });
    fireEvent.click(screen.getByRole("button", { name: "Tạo lớp" }));

    expect(
      await screen.findByRole("heading", { name: classroom.title }),
    ).toBeInTheDocument();
    expect(
      document.querySelector(
        '.classroom-detail__identity .class-status[data-status="active"]',
      ),
    ).not.toBeNull();
    expect(
      screen.queryByRole("region", { name: "Lớp đang ở trạng thái bản nháp" }),
    ).not.toBeInTheDocument();
    const methods = requestsOf(fetchMock)
      .filter((request) => pathOf(request).includes("/api/v1/classes"))
      .map((request) => request.method)
      .filter((method) => method !== "GET");
    expect(methods).toEqual(["POST", "PATCH"]);
    const patch = requestsOf(fetchMock).find(
      (request) => request.method === "PATCH",
    );
    expect(patch?.headers.get("X-CSRF-Token")).toBe("class-csrf");
    await expect(patch?.clone().json()).resolves.toEqual({
      expected_version: 1,
      status: "active",
    });
  });

  it("keeps the new draft and offers activation when auto-activation hits the quota", async () => {
    const draft = {
      ...classroom,
      status: "draft" as const,
      version: 1,
    };
    let patches = 0;
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      const path = pathOf(request);
      if (path.endsWith(`/api/v1/tenants/${tenantID}`)) {
        return Promise.resolve(jsonResponse({ timezone: classroom.timezone }));
      }
      if (path.endsWith("/api/v1/auth/csrf")) {
        return Promise.resolve(jsonResponse({ csrf_token: "class-csrf" }));
      }
      if (path.endsWith("/api/v1/classes") && request.method === "POST") {
        return Promise.resolve(jsonResponse(draft, 201));
      }
      if (
        path.endsWith(`/api/v1/classes/${classID}`) &&
        request.method === "PATCH"
      ) {
        patches += 1;
        return Promise.resolve(
          patches === 1
            ? jsonResponse(
                {
                  type: "urn:tutorhub:problem:quota_exceeded",
                  code: "quota_exceeded",
                  title: "Quota exceeded",
                  status: 429,
                },
                429,
              )
            : jsonResponse({ ...draft, status: "active", version: 2 }),
        );
      }
      if (path.endsWith(`/api/v1/classes/${classID}`)) {
        return Promise.resolve(jsonResponse(draft));
      }
      if (path.endsWith("/api/v1/classes") && request.method === "GET") {
        return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
      }
      if (path.endsWith(`/api/v1/classes/${classID}/sessions`)) {
        return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });
    renderClassRoute("/app/classrooms", fetchMock);

    await screen.findByText("Workspace chưa có lớp học");
    fireEvent.click(screen.getByRole("button", { name: "Tạo lớp học" }));
    fireEvent.click(screen.getByRole("button", { name: "Tùy chọn nâng cao" }));
    fireEvent.change(screen.getByRole("textbox", { name: /^Mã lớp/ }), {
      target: { value: "sec101" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Tên lớp" }), {
      target: { value: classroom.title },
    });
    fireEvent.click(screen.getByRole("button", { name: "Tạo lớp" }));

    const banner = await screen.findByRole("region", {
      name: "Lớp đang ở trạng thái bản nháp",
    });
    expect(screen.getByTestId("location")).toHaveTextContent(
      `/app/classrooms/${classID}`,
    );
    expect(within(banner).getByRole("alert")).toHaveTextContent(
      "Workspace đã đạt giới hạn số lớp đang hoạt động",
    );
    fireEvent.click(
      within(banner).getByRole("button", { name: "Kích hoạt lớp ngay" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("region", {
          name: "Lớp đang ở trạng thái bản nháp",
        }),
      ).not.toBeInTheDocument(),
    );
    expect(patches).toBe(2);
  });

  it("activates a draft in one tap from its class card", async () => {
    let state: ClassroomClass = {
      ...classroom,
      status: "draft",
      version: 1,
    };
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      const path = pathOf(request);
      if (path.endsWith("/api/v1/auth/csrf")) {
        return Promise.resolve(jsonResponse({ csrf_token: "card-csrf" }));
      }
      if (
        path.endsWith(`/api/v1/classes/${classID}`) &&
        request.method === "PATCH"
      ) {
        state = { ...state, status: "active", version: 2 };
        return Promise.resolve(jsonResponse(state));
      }
      if (path.endsWith("/api/v1/classes") && request.method === "GET") {
        return Promise.resolve(
          jsonResponse({ items: [state], next_cursor: null }),
        );
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });
    renderClassRoute("/app/classrooms", fetchMock);

    const titleLink = await screen.findByRole("link", {
      name: classroom.title,
    });
    expect(titleLink).toHaveAttribute("href", `/app/classrooms/${classID}`);
    const card = titleLink.closest("article");
    expect(card).not.toBeNull();
    const details = within(card!).getByRole("link", { name: "Chi tiết lớp" });
    expect(details).toHaveAttribute("href", `/app/classrooms/${classID}`);
    expect(details).toHaveAccessibleDescription(classroom.title);
    expect(card!.querySelector("a button, button a")).toBeNull();

    fireEvent.click(
      within(card!).getByRole("button", { name: "Kích hoạt lớp" }),
    );

    expect(
      await within(card!).findByRole("link", {
        name: "Vào phòng học trực tuyến",
      }),
    ).toHaveAttribute("href", `/app/classrooms/${classID}/prejoin`);
    const patch = requestsOf(fetchMock).find(
      (request) => request.method === "PATCH",
    );
    expect(patch?.headers.get("X-CSRF-Token")).toBe("card-csrf");
    await expect(patch?.clone().json()).resolves.toEqual({
      expected_version: 1,
      status: "active",
    });
  });

  it("reuses a live session and opens its media pre-join with a return path", async () => {
    const live = classSession({ status: "live" });
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      const path = pathOf(request);
      if (path.endsWith(`/api/v1/classes/${classID}`)) {
        return Promise.resolve(jsonResponse(classroom));
      }
      if (path.endsWith(`/api/v1/classes/${classID}/sessions`)) {
        return Promise.resolve(
          jsonResponse({
            items: [
              classSession({ id: "upcoming", status: "scheduled" }),
              live,
            ],
            next_cursor: null,
          }),
        );
      }
      if (path.endsWith("/api/v1/media/spaces/resolve")) {
        return Promise.resolve(jsonResponse(openSpace));
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });
    renderClassRoute(
      `/app/classrooms/${classID}`,
      fetchMock,
      currentUser(),
      true,
    );

    const hero = (
      await screen.findByRole("heading", { name: classroom.title })
    ).closest("header") as HTMLElement;
    fireEvent.click(
      within(hero).getByRole("button", { name: "Vào phòng học ngay" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Phòng chờ media" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent(
      `/app/media/spaces/${spaceID}/prejoin`,
    );
    expect(
      JSON.parse(screen.getByTestId("location-state").textContent ?? "null"),
    ).toEqual({
      classTitle: classroom.title,
      returnTo: `/app/classrooms/${classID}`,
    });
    const resolve = requestsOf(fetchMock).find((request) =>
      pathOf(request).endsWith("/api/v1/media/spaces/resolve"),
    );
    expect(new URL(resolve!.url).searchParams.get("class_session_id")).toBe(
      live.id,
    );
    expect(
      requestsOf(fetchMock).some((request) => request.method === "POST"),
    ).toBe(false);
  });

  it("opens a 90-minute live session in the class timezone when nothing is running", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse("2026-07-20T02:15:42.500Z"),
    );
    const created = classSession({
      id: "1d0b0b1e-8f2a-4bd1-9a71-1c8f6c1e2a10",
      starts_at: "2026-07-20T02:15:00Z",
      ends_at: "2026-07-20T03:45:00Z",
    });
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      const path = pathOf(request);
      if (path.endsWith("/api/v1/auth/csrf")) {
        return Promise.resolve(jsonResponse({ csrf_token: "session-csrf" }));
      }
      if (path.endsWith(`/api/v1/classes/${classID}`)) {
        return Promise.resolve(jsonResponse(classroom));
      }
      if (
        path.endsWith(`/api/v1/classes/${classID}/sessions`) &&
        request.method === "POST"
      ) {
        return Promise.resolve(jsonResponse(created, 201));
      }
      if (path.endsWith(`/api/v1/classes/${classID}/sessions`)) {
        return Promise.resolve(
          jsonResponse({
            items: [
              classSession({ id: "ended", status: "ended" }),
              classSession({
                id: "later",
                starts_at: "2026-07-20T05:00:00Z",
                ends_at: "2026-07-20T06:00:00Z",
              }),
            ],
            next_cursor: null,
          }),
        );
      }
      if (path.endsWith("/api/v1/media/spaces/resolve")) {
        return Promise.resolve(jsonResponse(openSpace));
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });
    renderClassRoute(
      `/app/classrooms/${classID}`,
      fetchMock,
      currentUser(),
      true,
    );

    const hero = (
      await screen.findByRole("heading", { name: classroom.title })
    ).closest("header") as HTMLElement;
    fireEvent.click(
      within(hero).getByRole("button", { name: "Vào phòng học ngay" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Phòng chờ media" }),
    ).toBeInTheDocument();

    const lookup = requestsOf(fetchMock).find(
      (request) =>
        pathOf(request).endsWith("/sessions") &&
        new URL(request.url).searchParams.get("range_start") ===
          "2026-07-19T20:15:42.500Z",
    );
    expect(new URL(lookup!.url).searchParams.get("range_end")).toBe(
      "2026-07-21T02:15:42.500Z",
    );
    const createRequest = requestsOf(fetchMock).find(
      (request) =>
        request.method === "POST" && pathOf(request).endsWith("/sessions"),
    );
    expect(createRequest?.headers.get("X-CSRF-Token")).toBe("session-csrf");
    await expect(createRequest?.clone().json()).resolves.toEqual({
      description: "",
      ends_at: "2026-07-20T10:45:00+07:00",
      starts_at: "2026-07-20T09:15:00+07:00",
      timezone: "Asia/Ho_Chi_Minh",
      title: "Cơ sở An toàn thông tin — Buổi học trực tiếp",
    });
    const resolve = requestsOf(fetchMock).find((request) =>
      pathOf(request).endsWith("/api/v1/media/spaces/resolve"),
    );
    expect(new URL(resolve!.url).searchParams.get("class_session_id")).toBe(
      created.id,
    );
  });

  it("tells a learner when the instructor has not opened a live room yet", async () => {
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      const path = pathOf(request);
      if (path.endsWith(`/api/v1/classes/${classID}`)) {
        return Promise.resolve(jsonResponse(learnerView));
      }
      if (path.endsWith(`/api/v1/classes/${classID}/sessions`)) {
        return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });
    renderClassRoute(
      `/app/classrooms/${classID}`,
      fetchMock,
      currentUser(),
      true,
    );

    const hero = (
      await screen.findByRole("heading", { name: classroom.title })
    ).closest("header") as HTMLElement;
    expect(
      within(hero).queryByRole("button", { name: "Vào phòng học ngay" }),
    ).toBeNull();
    fireEvent.click(
      within(hero).getByRole("button", { name: "Tham gia phòng học" }),
    );

    expect(await within(hero).findByRole("status")).toHaveTextContent(
      "Giáo viên chưa mở phòng học trực tiếp cho lớp này.",
    );
    expect(
      requestsOf(fetchMock).some((request) => request.method === "POST"),
    ).toBe(false);
    expect(screen.getByTestId("location")).toHaveTextContent(
      `/app/classrooms/${classID}`,
    );
  });

  it("shows a calm notice in Materials when class file storage is turned off", async () => {
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      if (pathOf(request).endsWith(`/api/v1/classes/${classID}`)) {
        return Promise.resolve(jsonResponse(classroom));
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });
    renderClassRoute(
      `/app/classrooms/${classID}?tab=materials`,
      fetchMock,
      currentUser(),
      false,
      {
        features: {
          file_uploads: { configured_enabled: false, enabled: false },
        },
        filesResponse: () =>
          jsonResponse(
            {
              type: "urn:tutorhub:problem:feature_disabled",
              code: "feature_disabled",
              title: "Feature disabled",
              status: 503,
            },
            503,
          ),
      },
    );

    // The files query retries a 5xx once before settling on the error.
    const notice = await screen.findByText(
      "Tính năng tải tài liệu hiện đang tạm tắt trên môi trường này.",
      undefined,
      { timeout: 4000 },
    );
    expect(notice.closest('[role="status"]')).not.toBeNull();
    const materials = screen.getByRole("tabpanel", { name: "Tài liệu" });
    expect(within(materials).queryByRole("alert")).not.toBeInTheDocument();
    expect(
      within(materials).queryByRole("button", { name: "Thử lại" }),
    ).toBeNull();
  });
});

describe("ClassroomPages CLASS-CLASSIN-UI-01", () => {
  const secondClass: ClassroomClass = {
    ...classroom,
    id: "f24d8c4b-b141-475f-b20a-ed0bfe96da6b",
    code: "SEC102",
    title: "An toàn ứng dụng",
    description: "Lập trình an toàn",
    version: 1,
  };

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  function cardTitles() {
    return screen
      .getAllByRole("article")
      .map((card) => within(card).getByRole("heading").textContent);
  }

  function openMenu(trigger: HTMLElement) {
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  }

  it("creates a class in one step from its name and retries a duplicate derived code once", async () => {
    const title = "Lớp 11 - Tiếng Anh (3)";
    const draft = {
      ...classroom,
      code: "LOP-11-TIENG-ANH-3-K7QX",
      title,
      description: "",
      status: "draft" as const,
      version: 1,
    };
    let posts = 0;
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      const path = pathOf(request);
      if (path.endsWith(`/api/v1/tenants/${tenantID}`)) {
        return Promise.resolve(jsonResponse({ timezone: classroom.timezone }));
      }
      if (path.endsWith("/api/v1/auth/csrf")) {
        return Promise.resolve(jsonResponse({ csrf_token: "class-csrf" }));
      }
      if (path.endsWith("/api/v1/classes") && request.method === "POST") {
        posts += 1;
        return Promise.resolve(
          posts === 1
            ? jsonResponse(
                {
                  type: "urn:tutorhub:problem:conflict",
                  title: "Class code already exists",
                  status: 409,
                },
                409,
              )
            : jsonResponse(draft, 201),
        );
      }
      if (
        path.endsWith(`/api/v1/classes/${classID}`) &&
        request.method === "PATCH"
      ) {
        return Promise.resolve(
          jsonResponse({ ...draft, status: "active", version: 2 }),
        );
      }
      if (path.endsWith("/api/v1/classes") && request.method === "GET") {
        return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
      }
      if (path.endsWith(`/api/v1/classes/${classID}/sessions`)) {
        return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });
    const queryClient = renderClassRoute("/app/classrooms", fetchMock);

    await screen.findByText("Workspace chưa có lớp học");
    fireEvent.click(screen.getByRole("button", { name: "Tạo lớp học" }));
    // The hidden timezone field follows the workspace once it has loaded.
    await waitFor(() =>
      expect(queryClient.getQueryData(["tenants", "detail", tenantID])).toEqual(
        { timezone: classroom.timezone },
      ),
    );
    const dialog = screen.getByRole("dialog", { name: "Tạo lớp học mới" });
    const submit = within(dialog).getByRole("button", { name: "Tạo lớp" });
    expect(submit).toHaveAttribute("data-ready", "false");
    expect(
      within(dialog).getByRole("button", { name: "Tùy chọn nâng cao" }),
    ).toHaveAttribute("aria-expanded", "false");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Tên lớp" }), {
      target: { value: title },
    });
    expect(submit).toHaveAttribute("data-ready", "true");
    expect(
      within(dialog).getByText("Tự tạo từ tên lớp: LOP-11-TIENG-ANH-3"),
    ).toBeInTheDocument();
    fireEvent.click(submit);

    expect(
      await screen.findByRole("heading", { level: 1, name: title }),
    ).toBeInTheDocument();
    const creates = requestsOf(fetchMock).filter(
      (request) =>
        request.method === "POST" &&
        pathOf(request).endsWith("/api/v1/classes"),
    );
    expect(creates).toHaveLength(2);
    await expect(creates[0]!.clone().json()).resolves.toEqual({
      code: "LOP-11-TIENG-ANH-3",
      description: "",
      timezone: classroom.timezone,
      title,
    });
    const retried = (await creates[1]!.clone().json()) as { code: string };
    expect(retried.code).toMatch(/^LOP-11-TIENG-ANH-3-[A-Z2-9]{4}$/);
    const patch = requestsOf(fetchMock).find(
      (request) => request.method === "PATCH",
    );
    await expect(patch?.clone().json()).resolves.toEqual({
      expected_version: 1,
      status: "active",
    });
    // No cover was picked, so nothing is written to the device.
    expect(window.localStorage).toHaveLength(0);
  });

  it("pins a class from its ⋯ menu, filters pinned classes and searches without diacritics", async () => {
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      if (
        pathOf(request).endsWith("/api/v1/classes") &&
        request.method === "GET"
      ) {
        return Promise.resolve(
          jsonResponse({ items: [classroom, secondClass], next_cursor: null }),
        );
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });
    renderClassRoute("/app/classrooms", fetchMock);

    await screen.findByRole("link", { name: secondClass.title });
    expect(cardTitles()).toEqual([classroom.title, secondClass.title]);
    expect(screen.queryByText(/to-?do/i)).toBeNull();
    expect(window.localStorage).toHaveLength(0);

    openMenu(
      screen.getByRole("button", {
        name: `Tùy chọn lớp ${secondClass.title}`,
      }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Ghim" }));
    await waitFor(() =>
      expect(cardTitles()).toEqual([secondClass.title, classroom.title]),
    );
    expect(
      within(screen.getAllByRole("article")[0]!).getByText("Đã ghim"),
    ).toBeInTheDocument();
    expect(
      window.localStorage.getItem(
        `tutorhub.classroom-prefs:${tenantID}:${ownerID}`,
      ),
    ).toBe(JSON.stringify({ pinned: [secondClass.id], covers: {} }));

    const statusTrigger = screen.getByRole("combobox", {
      name: "Lọc theo trạng thái",
    });
    fireEvent.keyDown(statusTrigger, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Đã ghim" }));
    await waitFor(() => expect(cardTitles()).toEqual([secondClass.title]));
    expect(
      requestsOf(fetchMock).every(
        (request) => !new URL(request.url).searchParams.has("status"),
      ),
    ).toBe(true);

    openMenu(
      screen.getByRole("button", {
        name: `Tùy chọn lớp ${secondClass.title}`,
      }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Bỏ ghim" }));
    expect(await screen.findByText("Chưa ghim lớp nào")).toBeInTheDocument();
    expect(window.localStorage).toHaveLength(0);

    fireEvent.keyDown(statusTrigger, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Tất cả" }));
    const search = screen.getByRole("searchbox", { name: "Tìm lớp học" });
    fireEvent.change(search, { target: { value: "ung dung" } });
    await waitFor(() => expect(cardTitles()).toEqual([secondClass.title]));
    fireEvent.change(search, { target: { value: "không có lớp này" } });
    expect(
      await screen.findByText("Không tìm thấy lớp phù hợp"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Xóa từ khóa tìm kiếm" }),
    );
    await waitFor(() =>
      expect(cardTitles()).toEqual([classroom.title, secondClass.title]),
    );
  });

  it("opens the join and public-session dialogs from the ⊕ quick actions menu", async () => {
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      const path = pathOf(request);
      if (path.endsWith("/api/v1/classes") && request.method === "GET") {
        return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
      }
      if (path.endsWith("/api/v1/calendar/study-meetings")) {
        return Promise.resolve(jsonResponse({ meetings: [] }));
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });
    renderClassRoute("/app/classrooms", fetchMock);

    await screen.findByText("Workspace chưa có lớp học");
    openMenu(screen.getByRole("button", { name: "Thao tác nhanh" }));
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Tham gia lớp bằng mã",
      "Tham gia buổi học công khai",
      "Tạo buổi học công khai",
    ]);
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Tham gia lớp bằng mã" }),
    );
    const joinDialog = await screen.findByRole("dialog", {
      name: "Tham gia lớp học",
    });
    expect(
      within(joinDialog).getByLabelText("Mã hoặc liên kết tham gia"),
    ).toHaveAttribute("type", "password");
    fireEvent.click(
      within(joinDialog).getByRole("button", {
        name: "Đóng biểu mẫu tham gia lớp",
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Tham gia lớp học" }),
      ).toBeNull(),
    );

    openMenu(screen.getByRole("button", { name: "Thao tác nhanh" }));
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "Tham gia buổi học công khai",
      }),
    );
    const publicDialog = await screen.findByRole(
      "dialog",
      { name: "Tham gia buổi học công khai" },
      { timeout: 4000 },
    );
    expect(
      await within(publicDialog).findByText(
        "Bạn chưa có buổi học công khai nào sắp diễn ra.",
      ),
    ).toBeInTheDocument();
  });

  it("invites a member from the card ⋯ menu through the quick invite dialog", async () => {
    const managed: ClassroomClass = {
      ...classroom,
      viewer_access: {
        ...classroom.viewer_access,
        can_manage_enrollments: true,
      },
    };
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      const path = pathOf(request);
      if (path.endsWith("/api/v1/classes") && request.method === "GET") {
        return Promise.resolve(
          jsonResponse({ items: [managed], next_cursor: null }),
        );
      }
      if (path.endsWith("/api/v1/auth/csrf")) {
        return Promise.resolve(jsonResponse({ csrf_token: "invite-csrf" }));
      }
      if (
        path.endsWith(`/api/v1/classes/${classID}/enrollments`) &&
        request.method === "POST"
      ) {
        return Promise.resolve(
          jsonResponse(
            {
              id: "63af7268-58db-4d40-a96f-c4f473a92350",
              class_id: classID,
              user_id: "1d7d65eb-904e-4a0d-bd24-a8ec1b453d64",
              class_role: "student",
              status: "active",
              enrolled_by: ownerID,
              joined_at: classroom.updated_at,
              suspended_at: null,
              left_at: null,
              removed_at: null,
              created_at: classroom.updated_at,
              updated_at: classroom.updated_at,
            },
            201,
          ),
        );
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });
    renderClassRoute("/app/classrooms", fetchMock);

    openMenu(
      await screen.findByRole("button", {
        name: `Tùy chọn lớp ${classroom.title}`,
      }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Mời thành viên" }),
    );
    const dialog = await screen.findByRole(
      "dialog",
      { name: "Mời thành viên vào lớp" },
      { timeout: 4000 },
    );
    fireEvent.change(within(dialog).getByLabelText("Email thành viên"), {
      target: { value: " Learner@Example.com " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Thêm" }));

    expect(await within(dialog).findByRole("status")).toHaveTextContent(
      "Đã thêm học viên vào lớp.",
    );
    const enroll = requestsOf(fetchMock).find((request) =>
      pathOf(request).endsWith("/enrollments"),
    );
    expect(enroll?.headers.get("X-CSRF-Token")).toBe("invite-csrf");
    await expect(enroll?.clone().json()).resolves.toEqual({
      member_email: "learner@example.com",
    });
    expect(
      within(dialog).getByRole("button", { name: "Tạo liên kết mời" }),
    ).toBeEnabled();
  });

  it("renders the three-column class detail with a right rail and no to-do list", async () => {
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      const path = pathOf(request);
      if (path.endsWith(`/api/v1/classes/${classID}`)) {
        return Promise.resolve(jsonResponse(classroom));
      }
      if (path.endsWith(`/api/v1/classes/${classID}/sessions`)) {
        return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });
    renderClassRoute(`/app/classrooms/${classID}`, fetchMock);

    expect(
      await screen.findByRole("heading", { level: 1, name: classroom.title }),
    ).toBeInTheDocument();
    const rail = screen.getByRole("complementary", {
      name: "Thông tin nhanh của lớp",
    });
    expect(
      within(rail)
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual(["Thành viên", "Thông tin lớp", "Trao đổi lớp học"]);
    expect(within(rail).getByText(classroom.code)).toBeInTheDocument();
    expect(
      within(rail).getByRole("button", { name: "Mở trao đổi lớp" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/to-?do/i)).toBeNull();
    expect(
      requestsOf(fetchMock).some((request) =>
        pathOf(request).endsWith("/roster"),
      ),
    ).toBe(false);

    expect(
      screen.getByRole("button", { name: /^Lên lịch buổi học mới/ }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /^Mở kho tài liệu lớp/ }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "?tab=materials",
      ),
    );

    const materialsTab = screen.getByRole("tab", { name: "Tài liệu" });
    act(() => materialsTab.focus());
    fireEvent.keyDown(materialsTab, { key: "ArrowDown" });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Thành viên" })).toHaveFocus(),
    );
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("?tab=members"),
    );
  });

  it("shows a learner their class role in the rail without loading the roster", async () => {
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      const path = pathOf(request);
      if (path.endsWith(`/api/v1/classes/${classID}`)) {
        return Promise.resolve(jsonResponse(learnerView));
      }
      if (path.endsWith(`/api/v1/classes/${classID}/sessions`)) {
        return Promise.resolve(jsonResponse({ items: [], next_cursor: null }));
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });
    renderClassRoute(`/app/classrooms/${classID}`, fetchMock);

    const rail = await screen.findByRole("complementary", {
      name: "Thông tin nhanh của lớp",
    });
    expect(
      within(rail).getByText("Vai trò của bạn: Học viên"),
    ).toBeInTheDocument();
    expect(
      within(rail).queryByRole("button", { name: "Mời thành viên vào lớp" }),
    ).toBeNull();
    // Learners get the calendar shortcut instead of the schedule card.
    expect(
      screen.getByRole("link", { name: /^Xem lịch học của bạn/ }),
    ).toHaveAttribute("href", "/app/calendar");
    expect(
      requestsOf(fetchMock).some((request) =>
        pathOf(request).endsWith("/roster"),
      ),
    ).toBe(false);
  });
});
