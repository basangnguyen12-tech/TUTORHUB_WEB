// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  APIRequestError,
  type RoomDocument,
  type RoomDocumentLibraryViewerAccess,
} from "@tutorhub/api-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../app/i18n";
import { ClassroomFilesTool } from "./ClassroomFilesTool";
import { createClassroomFilesSession } from "./filesSession";

const api = vi.hoisted(() => ({
  download: vi.fn(),
  list: vi.fn(),
  rotateCSRF: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@tutorhub/api-client", async () => {
  const actual = await vi.importActual<typeof import("@tutorhub/api-client")>(
    "@tutorhub/api-client",
  );
  return {
    ...actual,
    issueFileDownloadCapability: api.download,
    listRoomDocuments: api.list,
    rotateCSRFToken: api.rotateCSRF,
    updateRoomDocument: api.update,
  };
});

// The pdf.js engine is exercised in Chromium (Playwright); jsdom only needs
// the library and its states.
vi.mock("./pdfRuntime", () => ({
  AnnotationMode: { ENABLE: 1 },
  openPdfDocument: vi.fn(),
  readPdfPageText: vi.fn(),
  resolvePdfDestination: vi.fn(),
  TextLayer: class {
    static cleanup() {}
  },
}));

const tenantID = "b43d5964-b602-4dd5-befe-cbbfe6fc9f0b";
const spaceID = "0e0f92c4-347c-4022-b4d1-c81208a972e3";
const actorID = "fc06b119-e27b-4fa0-93b1-391d70dd81c0";

function roomDocument(overrides: Partial<RoomDocument>): RoomDocument {
  return {
    active_content: false,
    allow_student_download: false,
    class_id: null,
    created_at: "2030-08-08T01:00:00Z",
    declared_media_type: "application/pdf",
    display_name: "De.pdf",
    expected_size_bytes: 1_250_000,
    expires_at: null,
    first_page_aspect: 0.7071,
    id: "11111111-1111-4111-8111-111111111111",
    media_space_id: spaceID,
    owner_kind: "media_space",
    page_count: 12,
    rejection_reason: null,
    status: "ready",
    updated_at: "2030-08-08T01:00:00Z",
    uploaded_by_viewer: false,
    version: 3,
    viewer_access: {
      can_download_original: false,
      can_manage: false,
      can_retry_upload: false,
      can_view: true,
    },
    ...overrides,
  };
}

const staffAccess: RoomDocumentLibraryViewerAccess = {
  can_manage: true,
  can_present: true,
  can_upload: true,
  can_upload_to_class: true,
};
const studentAccess: RoomDocumentLibraryViewerAccess = {
  can_manage: false,
  can_present: false,
  can_upload: false,
  can_upload_to_class: false,
};

function renderTool(
  props: Partial<Parameters<typeof ClassroomFilesTool>[0]> = {},
  language: "en" | "vi" = "vi",
) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage={language}>
        <ClassroomFilesTool
          actorID={actorID}
          enabled
          mediaSpaceID={spaceID}
          session={createClassroomFilesSession()}
          tenantID={tenantID}
          {...props}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("ROOM-TOOLS-FILES-01B Documents tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.rotateCSRF.mockResolvedValue({ csrf_token: "csrf" });
  });
  afterEach(() => cleanup());

  it("renders loading, feature-off and forbidden states without the chunk", () => {
    const first = renderTool({ enabled: undefined });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Đang tải công cụ Tài liệu…",
    );
    first.unmount();
    const second = renderTool({ enabled: false });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Công cụ Tài liệu đang tắt",
    );
    second.unmount();
    renderTool({ tenantID: "" });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Không thể mở Tài liệu",
    );
    expect(api.list).not.toHaveBeenCalled();
  });

  it("lists class and room files with kind, size, status, reasons and warnings", async () => {
    api.list.mockResolvedValue({
      items: [
        roomDocument({
          active_content: true,
          display_name: "Đề kiểm tra.pdf",
          owner_kind: "class",
        }),
        roomDocument({
          declared_media_type: "image/png",
          display_name: "Hình.png",
          id: "22222222-2222-4222-8222-222222222222",
          page_count: 1,
        }),
        roomDocument({
          display_name: "Đang xử lý.pdf",
          id: "33333333-3333-4333-8333-333333333333",
          status: "processing",
        }),
        roomDocument({
          display_name: "Có mật khẩu.pdf",
          id: "44444444-4444-4444-8444-444444444444",
          rejection_reason: "pdf_encrypted",
          status: "rejected",
        }),
      ],
      next_cursor: null,
      viewer_access: studentAccess,
    });
    renderTool();
    const list = await screen.findByRole("list", {
      name: "Danh sách tài liệu",
    });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent("Tệp của lớp");
    expect(rows[0]).toHaveTextContent("PDF · 12 trang");
    expect(rows[0]).toHaveTextContent("1,3 MB");
    expect(rows[0]).toHaveTextContent("Có nội dung chủ động");
    expect(rows[1]).toHaveTextContent("Tệp phòng học");
    expect(rows[1]).toHaveTextContent("Ảnh");
    expect(rows[2]).toHaveTextContent("Đang kiểm tra tệp…");
    expect(within(rows[2]!).queryByRole("button", { name: /Mở/ })).toBeNull();
    expect(rows[3]).toHaveTextContent(
      "Tệp bị từ chối: PDF có mật khẩu, hãy gỡ mật khẩu rồi tải lại.",
    );
    // Students never see upload, manage or download actions they lack.
    expect(
      screen.queryByRole("button", { name: "Tải tài liệu lên" }),
    ).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: /Tải bản gốc/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Xóa/ })).toBeNull();
  });

  it("offers upload with scope and download options and checks sizes early", async () => {
    api.list.mockResolvedValue({
      items: [],
      next_cursor: null,
      viewer_access: staffAccess,
    });
    renderTool();
    expect(await screen.findByText("Chưa có tài liệu nào")).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Chỉ phòng này (30 ngày)" }),
    ).toBeChecked();
    const allow = screen.getByRole("switch", {
      name: "Cho phép học sinh tải bản gốc",
    });
    expect(allow).not.toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Lưu vào Kho lớp" }));
    expect(allow).toBeChecked();

    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).toHaveAttribute(
      "accept",
      ".pdf,application/pdf,image/png,image/jpeg,image/webp",
    );
    const big = new File(["x"], "Lớn.pdf", { type: "application/pdf" });
    Object.defineProperty(big, "size", { value: 60 * 1024 * 1024 });
    fireEvent.change(input!, { target: { files: [big] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "PDF vượt 50 MiB.",
    );
    const sheet = new File(["x"], "Bài.docx");
    fireEvent.change(input!, { target: { files: [sheet] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Chỉ nhận PDF, PNG, JPEG hoặc WebP.",
    );
  });

  it("warns before downloading an original with active content", async () => {
    api.download.mockResolvedValue({
      expires_at: "2030-08-08T01:05:00Z",
      method: "GET",
      url: "https://storage.example.test/original",
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    api.list.mockResolvedValue({
      items: [
        roomDocument({
          active_content: true,
          viewer_access: {
            can_download_original: true,
            can_manage: false,
            can_retry_upload: false,
            can_view: true,
          },
        }),
        roomDocument({
          display_name: "An toàn.pdf",
          id: "55555555-5555-4555-8555-555555555555",
          viewer_access: {
            can_download_original: true,
            can_manage: false,
            can_retry_upload: false,
            can_view: true,
          },
        }),
      ],
      next_cursor: null,
      viewer_access: studentAccess,
    });
    renderTool({}, "en");
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Download the original De.pdf",
      }),
    );
    const dialog = await screen.findByRole("alertdialog", {
      name: "This file has active content",
    });
    expect(api.download).not.toHaveBeenCalled();
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(api.download).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Download the original De.pdf" }),
    );
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Download anyway",
      }),
    );
    await waitFor(() => expect(api.download).toHaveBeenCalledTimes(1));

    fireEvent.click(
      screen.getByRole("button", { name: "Download the original An toàn.pdf" }),
    );
    await waitFor(() => expect(api.download).toHaveBeenCalledTimes(2));
    expect(click).toHaveBeenCalledTimes(2);
    click.mockRestore();
  });

  it("lets staff toggle student downloads and remove a document after confirming", async () => {
    const managed = roomDocument({
      viewer_access: {
        can_download_original: true,
        can_manage: true,
        can_retry_upload: false,
        can_view: true,
      },
    });
    api.list.mockResolvedValue({
      items: [managed],
      next_cursor: null,
      viewer_access: staffAccess,
    });
    api.update.mockResolvedValue(managed);
    renderTool();
    fireEvent.click(
      await screen.findByRole("switch", { name: "Cho phép HS tải bản gốc" }),
    );
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith(
        tenantID,
        spaceID,
        managed.id,
        { allow_student_download: true, expected_version: 3 },
        "csrf",
        expect.any(Object),
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Xóa De.pdf khỏi phòng" }),
    );
    const confirm = screen.getByRole("group", { name: "Xác nhận xóa De.pdf" });
    expect(
      within(confirm).getByRole("button", { name: "Xóa khỏi phòng" }),
    ).toHaveFocus();
    fireEvent.click(
      within(confirm).getByRole("button", { name: "Xóa khỏi phòng" }),
    );
    await waitFor(() =>
      expect(api.update).toHaveBeenLastCalledWith(
        tenantID,
        spaceID,
        managed.id,
        { deleted: true, expected_version: 3 },
        "csrf",
        expect.any(Object),
      ),
    );
  });

  it.each([
    [
      new APIRequestError(404),
      "Bạn không có quyền xem tài liệu của phòng này.",
    ],
    [new APIRequestError(503), "Công cụ Tài liệu đang tắt"],
    [new APIRequestError(500), "Không tải được kho tài liệu."],
  ])("shows the library error state for %s", async (error, message) => {
    api.list.mockRejectedValue(error);
    renderTool();
    // 5xx answers are retried once by the query before the error shows.
    expect(
      await screen.findByRole("alert", {}, { timeout: 5_000 }),
    ).toHaveTextContent(message);
    const retry = screen.queryByRole("button", { name: "Thử lại" });
    if (error.status === 500) {
      expect(retry).toBeInTheDocument();
      api.list.mockResolvedValue({
        items: [],
        next_cursor: null,
        viewer_access: studentAccess,
      });
      fireEvent.click(retry!);
      expect(
        await screen.findByText(
          "Giáo viên chưa chia sẻ tài liệu nào trong phòng này.",
        ),
      ).toBeInTheDocument();
    } else {
      expect(retry).toBeNull();
    }
  });
});

describe("study export permissions in a paginated room library", () => {
  it.each(["presentation", "restored private view"] as const)(
    "resolves the exact ready document on page two for a %s",
    async (mode) => {
      const target = roomDocument({
        allow_student_download: true,
        viewer_access: {
          can_download_original: true,
          can_manage: false,
          can_retry_upload: false,
          can_view: true,
        },
      });
      const other = roomDocument({
        id: "55555555-5555-4555-8555-555555555555",
      });
      api.list
        .mockClear()
        .mockImplementation(async (_tenant, _space, { cursor }) => ({
          items: cursor ? [target] : [other],
          next_cursor: cursor ? "unneeded-page" : "next-page",
          viewer_access: studentAccess,
        }));
      const session = createClassroomFilesSession();
      const { roomDocumentView } = await import("../../app/roomChatDocuments");
      session.saveView(roomDocumentView(target));
      const timestamp = "2030-08-08T01:00:00Z";
      const resolve = vi
        .spyOn(await import("@tutorhub/api-client"), "resolvePdfPresentation")
        .mockResolvedValue({
          active_annotator_grants: [],
          can_present: false,
          presentation: {
            id: "77777777-7777-4777-8777-777777777777",
            file_id: target.id,
            version_id: "v1",
            page_count: 12,
            media_space_id: spaceID,
            current_generation: 1,
            revoke_generation: 1,
            version: 1,
            status: "open",
            created_at: timestamp,
            updated_at: timestamp,
            document: {
              file_id: target.id,
              version_id: "v1",
              page_count: 12,
              first_page_aspect: 0.7071,
              media_type: "application/pdf",
              active_content: false,
              allow_student_download: true,
              display_name: target.display_name,
            },
            viewer_capabilities: {
              can_close: false,
              can_exchange_grant: true,
              can_manage: false,
              can_manage_annotator_grants: false,
              can_resume: false,
              can_suspend: false,
              capability: "view",
            },
          },
        });
      // Observe the capability handed to the stage without opening a PDF worker or a collaboration socket.
      const stage = ({
        canDownloadOriginal,
      }: {
        canDownloadOriginal: boolean;
      }) => <button disabled={!canDownloadOriginal}>Export for study</button>;
      const presentation = vi
        .spyOn(await import("./PdfPresentationStage"), "PdfPresentationStage")
        .mockImplementation(stage);
      const privateView = vi
        .spyOn(await import("./DocumentLoader"), "DocumentLoader")
        .mockImplementation(stage);
      try {
        renderTool({ session, collaborationEnabled: mode === "presentation" });
        await waitFor(() =>
          expect(
            screen.getByRole("button", { name: "Export for study" }),
          ).toBeEnabled(),
        );
        expect(api.list.mock.calls.map(([, , input]) => input.cursor)).toEqual([
          undefined,
          "next-page",
        ]);
        expect(
          mode === "presentation" ? presentation : privateView,
        ).toHaveBeenCalled();
      } finally {
        cleanup();
        presentation.mockRestore();
        privateView.mockRestore();
        resolve.mockRestore();
      }
    },
  );
});
