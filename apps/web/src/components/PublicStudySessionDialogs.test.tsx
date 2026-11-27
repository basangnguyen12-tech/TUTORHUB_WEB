import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { MediaSpace, TenantCapabilities } from "@tutorhub/api-client";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudyMeeting } from "../app/availabilityPollManagement";
import { I18nProvider } from "../app/i18n";
import { availableTenantCapabilities } from "../test/tenantCapabilities";
import {
  CreatePublicSessionDialog,
  JoinPublicSessionDialog,
} from "./PublicStudySessionDialogs";

const tenantID = "4b18543a-74de-419f-9fe8-d0c3dfc991eb";
const userID = "be85eb92-0f18-4163-85ba-50e4d343d632";
const meetingID = "5d3c2a1b-8e7f-4c6d-9a0b-1c2d3e4f5a6b";
const spaceID = "c2dc1048-1d90-4c90-ae50-5fb436bfb607";
const timezone = "Asia/Ho_Chi_Minh";
const available = { available: true, reason: "available" } as const;

function features(mediaRooms: boolean): TenantCapabilities["features"] {
  const base = availableTenantCapabilities(tenantID).features;
  return {
    ...base,
    classroom_media_rooms: {
      configured_enabled: mediaRooms,
      enabled: mediaRooms,
    },
    classroom_whiteboards: { configured_enabled: true, enabled: true },
  };
}

function meeting(overrides: Partial<StudyMeeting> = {}): StudyMeeting {
  return {
    id: meetingID,
    class_id: null,
    owner_user_id: userID,
    source_poll_id: null,
    title: "Buổi học công khai của TutorHub Teacher",
    starts_at: "2026-07-20T02:15:00Z",
    ends_at: "2026-07-20T02:55:00Z",
    timezone,
    status: "scheduled",
    version: 1,
    cancelled_at: null,
    created_at: "2026-07-20T02:15:00Z",
    updated_at: "2026-07-20T02:15:00Z",
    ...overrides,
  };
}

const openSpace: MediaSpace = {
  id: spaceID,
  source: { kind: "study_meeting", study_meeting_id: meetingID },
  status: "open",
  version: 2,
  active_room_instance: {
    id: "c5f918a5-a09e-4f94-9fab-fb0ab5702a4d",
    status: "active",
    version: 1,
    created_at: "2026-07-20T02:15:00Z",
    updated_at: "2026-07-20T02:15:00Z",
  },
  recovery_room_instance: null,
  viewer_operations: {
    can_start: true,
    can_end: true,
    can_cancel: true,
    can_manage_admissions: true,
    can_manage_invites: true,
    can_recover: false,
  },
  created_at: "2026-07-20T02:15:00Z",
  updated_at: "2026-07-20T02:15:00Z",
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

function LocationProbe() {
  const location = useLocation();
  return (
    <>
      <output data-testid="location">{location.pathname}</output>
      <output data-testid="location-state">
        {JSON.stringify(location.state ?? null)}
      </output>
    </>
  );
}

function renderDialog(
  dialog: ReactNode,
  fetchMock: (request: Request) => Promise<Response>,
) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      fetchMock(input instanceof Request ? input : new Request(input, init)),
    ),
  );
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLanguage="vi">
        <MemoryRouter initialEntries={["/app/classrooms"]}>
          <Routes>
            <Route element={dialog} path="/app/classrooms" />
            <Route
              element={<h1>Phòng chờ media</h1>}
              path="/app/media/spaces/:spaceId/prejoin"
            />
          </Routes>
          <LocationProbe />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function requests() {
  return (vi.mocked(fetch).mock.calls as unknown as [Request][]).map(
    ([request]) => request,
  );
}

describe("CreatePublicSessionDialog", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("creates a study meeting now and opens its media pre-join", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse("2026-07-20T02:15:42.500Z"),
    );
    const onOpenChange = vi.fn();
    renderDialog(
      <CreatePublicSessionDialog
        availability={available}
        features={features(true)}
        onOpenChange={onOpenChange}
        open
        organizerName="TutorHub Teacher"
        tenantID={tenantID}
        timezone={timezone}
      />,
      (request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/api/v1/auth/csrf")) {
          return Promise.resolve(jsonResponse({ csrf_token: "meeting-csrf" }));
        }
        if (
          path.endsWith("/api/v1/calendar/study-meetings") &&
          request.method === "POST"
        ) {
          return Promise.resolve(jsonResponse(meeting(), 201));
        }
        if (path.endsWith("/api/v1/media/spaces/resolve")) {
          return Promise.resolve(jsonResponse(openSpace));
        }
        return Promise.reject(new Error(`Unexpected request: ${request.url}`));
      },
    );

    const dialog = screen.getByRole("dialog", {
      name: "Tạo buổi học công khai",
    });
    expect(
      within(dialog).getByRole("textbox", { name: "Tên buổi học" }),
    ).toHaveValue("Buổi học công khai của TutorHub Teacher");
    expect(
      within(dialog).getByRole("radio", { name: "Ngay bây giờ" }),
    ).toBeChecked();
    expect(
      within(dialog).getByRole("radio", { name: "40 phút" }),
    ).toBeChecked();
    const capabilities = within(dialog).getByRole("complementary", {
      name: "Khả năng phòng học trong workspace này",
    });
    expect(within(capabilities).getAllByRole("listitem")[0]).toHaveTextContent(
      "Âm thanh & hình ảnh trực tiếpĐang bật",
    );
    expect(within(capabilities).queryByRole("switch")).toBeNull();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Tạo và vào phòng" }),
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
      classTitle: "Buổi học công khai của TutorHub Teacher",
      returnTo: "/app/classrooms",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);

    const create = requests().find((request) =>
      request.url.endsWith("/api/v1/calendar/study-meetings"),
    );
    expect(create?.headers.get("X-CSRF-Token")).toBe("meeting-csrf");
    expect(create?.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(tenantID);
    const body = (await create!.clone().json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      class_id: null,
      ends_at: "2026-07-20T09:55:00+07:00",
      starts_at: "2026-07-20T09:15:00+07:00",
      timezone,
      title: "Buổi học công khai của TutorHub Teacher",
    });
    expect(body.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    const resolve = requests().find((request) =>
      request.url.includes("/api/v1/media/spaces/resolve"),
    );
    const query = new URL(resolve!.url).searchParams;
    expect(query.get("kind")).toBe("study_meeting");
    expect(query.get("study_meeting_id")).toBe(meetingID);
  });

  it("schedules a later session and confirms it in the dialog without opening a room", async () => {
    const scheduled = meeting({
      starts_at: "2026-07-21T12:30:00Z",
      ends_at: "2026-07-21T14:00:00Z",
    });
    renderDialog(
      <CreatePublicSessionDialog
        availability={available}
        features={features(true)}
        onOpenChange={() => undefined}
        open
        organizerName="TutorHub Teacher"
        tenantID={tenantID}
        timezone={timezone}
      />,
      (request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/api/v1/auth/csrf")) {
          return Promise.resolve(jsonResponse({ csrf_token: "meeting-csrf" }));
        }
        if (path.endsWith("/api/v1/calendar/study-meetings")) {
          return Promise.resolve(jsonResponse(scheduled, 201));
        }
        return Promise.reject(new Error(`Unexpected request: ${request.url}`));
      },
    );

    fireEvent.click(screen.getByRole("radio", { name: "Hẹn giờ" }));
    fireEvent.change(screen.getByLabelText("Bắt đầu lúc (Asia/Ho_Chi_Minh)"), {
      target: { value: "2026-07-21T19:30" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "90 phút" }));
    fireEvent.click(screen.getByRole("button", { name: "Tạo buổi học" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Đã tạo buổi học công khai",
    });
    expect(within(dialog).getByText(meetingID)).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Mở phòng ngay" }),
    ).toBeEnabled();
    const create = requests().find((request) =>
      request.url.endsWith("/api/v1/calendar/study-meetings"),
    );
    await expect(create?.clone().json()).resolves.toMatchObject({
      ends_at: "2026-07-21T21:00:00+07:00",
      starts_at: "2026-07-21T19:30:00+07:00",
    });
    expect(
      requests().some((request) => request.url.includes("/media/spaces")),
    ).toBe(false);
  });

  it("explains why creation is unavailable and blocks the submit", () => {
    renderDialog(
      <CreatePublicSessionDialog
        availability={{ available: false, reason: "feature_disabled" }}
        features={features(false)}
        onOpenChange={() => undefined}
        open
        organizerName="TutorHub Teacher"
        tenantID={tenantID}
        timezone={timezone}
      />,
      (request) =>
        Promise.reject(new Error(`Unexpected request: ${request.url}`)),
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Tạo buổi học công khai",
    );
    expect(screen.getByRole("button", { name: "Tạo buổi học" })).toBeDisabled();
    expect(requests()).toHaveLength(0);
  });
});

describe("JoinPublicSessionDialog", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function renderJoin(fetchMock: (request: Request) => Promise<Response>) {
    renderDialog(
      <JoinPublicSessionDialog
        currentUserID={userID}
        mediaRoomsEnabled
        onOpenChange={() => undefined}
        open
        tenantID={tenantID}
        timezone={timezone}
      />,
      fetchMock,
    );
  }

  it("lists the viewer's open public sessions and starts one in a tap", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse("2026-07-20T02:20:00.000Z"),
    );
    renderJoin((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/api/v1/calendar/study-meetings")) {
        return Promise.resolve(
          jsonResponse({
            meetings: [
              meeting(),
              meeting({
                id: "0f0e0d0c-0b0a-4909-8807-060504030201",
                status: "cancelled",
                title: "Buổi đã hủy",
              }),
              meeting({
                id: "1a1b1c1d-1e1f-4a2b-8c3d-4e5f6a7b8c9d",
                title: "Buổi đã qua",
                starts_at: "2026-07-19T01:00:00Z",
                ends_at: "2026-07-19T02:00:00Z",
              }),
            ],
          }),
        );
      }
      if (path.endsWith("/api/v1/media/spaces/resolve")) {
        return Promise.resolve(jsonResponse(openSpace));
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });

    const list = await screen.findByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent(
      "Buổi học công khai của TutorHub Teacher",
    );
    expect(items[0]).toHaveTextContent("Đang diễn ra");

    fireEvent.change(
      screen.getByLabelText("Liên kết phòng chờ hoặc mã buổi học"),
      { target: { value: "không khớp" } },
    );
    expect(
      screen.getByText("Không có buổi học khớp từ khóa."),
    ).toBeInTheDocument();
    fireEvent.change(
      screen.getByLabelText("Liên kết phòng chờ hoặc mã buổi học"),
      { target: { value: "" } },
    );

    fireEvent.click(
      within(screen.getByRole("list")).getByRole("button", {
        name: "Bắt đầu phòng học",
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "Phòng chờ media" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent(
      `/app/media/spaces/${spaceID}/prejoin`,
    );
  });

  it("opens a pasted same-origin waiting-room link and rejects foreign links", async () => {
    renderJoin((request) => {
      if (new URL(request.url).pathname.endsWith("/study-meetings")) {
        return Promise.resolve(jsonResponse({ meetings: [] }));
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });
    const input = screen.getByLabelText("Liên kết phòng chờ hoặc mã buổi học");

    fireEvent.change(input, {
      target: {
        value: `https://evil.example/app/media/spaces/${spaceID}/prejoin`,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Vào phòng" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Liên kết hoặc mã chưa đúng định dạng.",
    );

    fireEvent.change(input, {
      target: {
        value: `${window.location.origin}/app/media/spaces/${spaceID}/prejoin`,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Vào phòng" }));
    expect(
      await screen.findByRole("heading", { name: "Phòng chờ media" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent(
      `/app/media/spaces/${spaceID}/prejoin`,
    );
    await waitFor(() =>
      expect(
        requests().every((request) => !request.url.includes("evil.example")),
      ).toBe(true),
    );
  });
});
