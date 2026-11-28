// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { EditorView } from "@codemirror/view";
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
import {
  APIRequestError,
  type CodeScratchpad,
  type CodeSharedScratchpad,
  type CodeSnippet,
  type CodeSnippetSummary,
} from "@tutorhub/api-client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { I18nProvider } from "../../app/i18n";
import { ClassroomCodeTool } from "./ClassroomCodeTool";
import { exportCodeProject } from "./codePortable";
import { createClassroomCodeSession } from "./codeSession";
import {
  ClassroomToolActionsContext,
  type ClassroomToolActions,
} from "./toolActions";

/**
 * ROOM-TOOLS-CODE-03B: the durable library, the server draft, "Gửi bài cho
 * GV", the teacher's "Bài học sinh" and portable projects through the real
 * Code tool (CodeMirror in jsdom). Only the Core API client is replaced.
 */
const api = vi.hoisted(() => ({
  createSnippet: vi.fn(),
  deleteSnippet: vi.fn(),
  getScratchpad: vi.fn(),
  getShared: vi.fn(),
  getSnippet: vi.fn(),
  listShared: vi.fn(),
  listSnippets: vi.fn(),
  putScratchpad: vi.fn(),
  rotate: vi.fn(),
  share: vi.fn(),
  updateSnippet: vi.fn(),
}));

vi.mock("@tutorhub/api-client", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@tutorhub/api-client")>();
  return {
    ...original,
    createCodeSnippet: api.createSnippet,
    deleteCodeSnippet: api.deleteSnippet,
    getCodeScratchpad: api.getScratchpad,
    getCodeSnippet: api.getSnippet,
    getSharedCodeScratchpad: api.getShared,
    listCodeSnippets: api.listSnippets,
    listSharedCodeScratchpads: api.listShared,
    putCodeScratchpad: api.putScratchpad,
    rotateCSRFToken: api.rotate,
    shareCodeScratchpad: api.share,
    updateCodeSnippet: api.updateSnippet,
  };
});

const tenantID = "4b18543a-74de-419f-9fe8-d0c3dfc991eb";
const mediaSpaceID = "c2dc1048-1d90-4c90-ae50-5fb436bfb607";
const classID = "2a6f4d0b-0f27-4c3e-9a40-6c7d3c1d5e21";
const personalID = "5b0c6f0e-3d7a-4c38-9f15-2a7f9a3d1c11";
const classSnippetID = "6c1d7f1f-4e8b-4d49-8a26-3b8a0b4e2d22";
const sharedID = "0d6c4d64-8d4c-4f3c-b0f5-7b6e1b9b2a44";

beforeAll(() => {
  // CodeMirror measures text with Range rectangles, which jsdom lacks.
  const rect = () => new DOMRect(0, 0, 0, 0);
  for (const target of [Range.prototype, Element.prototype]) {
    if (!("getClientRects" in target)) {
      Object.defineProperty(target, "getClientRects", {
        configurable: true,
        value: () => [],
      });
    }
    if (!("getBoundingClientRect" in target)) {
      Object.defineProperty(target, "getBoundingClientRect", {
        configurable: true,
        value: rect,
      });
    }
  }
});

function summary(overrides: Partial<CodeSnippetSummary>): CodeSnippetSummary {
  return {
    author_display_name: "Thu Hà",
    byte_length: 16,
    class_id: null,
    created_at: "2030-08-03T00:00:00Z",
    description: "",
    file_name: "loop.py",
    id: personalID,
    language: "python",
    title: "Vòng lặp của tôi",
    updated_at: "2030-08-03T00:00:00Z",
    version: 1,
    viewer_capabilities: { can_delete: true, can_edit: true },
    visibility: "personal",
    ...overrides,
  };
}

const classSnippet = summary({
  class_id: classID,
  file_name: "bang_cuu_chuong.py",
  id: classSnippetID,
  title: "Bảng cửu chương",
  viewer_capabilities: { can_delete: false, can_edit: false },
  visibility: "class",
});

function detail(item: CodeSnippetSummary, content: string): CodeSnippet {
  return { ...item, content, content_sha256: `sha256:${"0".repeat(64)}` };
}

function draft(version: number, content: string, shared = false) {
  return {
    active_index: 0,
    byte_length: content.length,
    created_at: "2030-08-03T00:00:00Z",
    expires_at: "2030-09-02T00:00:00Z",
    files: [{ content, language: "python" as const, name: "main.py" }],
    id: sharedID,
    media_space_id: mediaSpaceID,
    shared_at: shared ? "2030-08-03T00:01:00Z" : null,
    shared_with_staff: shared,
    stdin: "",
    updated_at: "2030-08-03T00:00:00Z",
    version,
  } satisfies CodeScratchpad;
}

function problem(status: number, code: string) {
  return new APIRequestError(status, {
    code,
    status,
    title: code,
    type: "about:blank",
  });
}

let queryClient: QueryClient;
const toolActions: ClassroomToolActions = {
  hasTool: () => true,
  openChat: vi.fn(() => true),
  openTool: vi.fn(() => true),
};

function renderTool(
  options: {
    classID?: string | null;
    isStaff?: boolean;
    libraryEnabled?: boolean;
    onSendToChat?: (text: string) => void;
  } = {},
) {
  queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLanguage="vi">
        <ClassroomToolActionsContext.Provider value={toolActions}>
          <ClassroomCodeTool
            actorID="actor-0001"
            chatCanPost
            classID={options.classID ?? null}
            enabled
            isStaff={options.isStaff ?? false}
            libraryEnabled={options.libraryEnabled ?? true}
            mediaSpaceID={mediaSpaceID}
            onSendToChat={options.onSendToChat}
            session={createClassroomCodeSession()}
            tenantID={tenantID}
          />
        </ClassroomToolActionsContext.Provider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function editor(): EditorView {
  const element = document.querySelector(".classroom-code .cm-editor");
  const view = element ? EditorView.findFromDOM(element as HTMLElement) : null;
  if (!view) throw new Error("editor not mounted");
  return view;
}

async function waitForEditor() {
  await waitFor(
    () =>
      expect(
        document.querySelector(".classroom-code .cm-editor"),
      ).not.toBeNull(),
    { timeout: 5_000 },
  );
}

function setCode(text: string) {
  act(() => {
    const view = editor();
    view.dispatch({
      changes: { from: 0, insert: text, to: view.state.doc.length },
    });
  });
}

const fileTab = (name: string) =>
  within(screen.getByRole("group", { name: "Tệp trong phiên" })).getByRole(
    "button",
    { name },
  );

function openLibrary() {
  fireEvent.click(screen.getByRole("button", { name: "Kho Snippet" }));
  return screen.getByRole("complementary", { name: "Kho Snippet" });
}

function chooseTab(name: string) {
  const tab = screen.getByRole("tab", { name });
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
  fireEvent.click(tab);
}

beforeEach(() => {
  api.rotate.mockResolvedValue({ csrf_token: "code-csrf" });
  api.getScratchpad.mockResolvedValue({ scratchpad: null });
  api.listShared.mockResolvedValue({ items: [] });
  api.listSnippets.mockImplementation(
    async (_tenant: string, query: { scope: string }) => ({
      items: query.scope === "class" ? [classSnippet] : [summary({})],
      next_cursor: null,
    }),
  );
});

afterEach(async () => {
  cleanup();
  // A detached workspace flushes its unsaved draft: let it settle here.
  await new Promise((resolve) => globalThis.setTimeout(resolve, 30));
  queryClient?.clear();
  window.localStorage.clear();
  for (const mock of Object.values(api)) mock.mockReset();
  vi.clearAllMocks();
});

describe("Code library off (Slice 1/2 unchanged)", () => {
  it("never calls the library or the server draft and keeps the built-in drawer", async () => {
    renderTool({ libraryEnabled: false });
    await waitForEditor();
    const drawer = openLibrary();
    expect(within(drawer).queryByRole("tablist")).toBeNull();
    expect(
      within(drawer).queryByRole("button", { name: "Lưu vào Kho" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Gửi bài cho GV" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Bài học sinh/u })).toBeNull();
    await act(async () => {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 30));
    });
    expect(api.getScratchpad).not.toHaveBeenCalled();
    expect(api.listSnippets).not.toHaveBeenCalled();
    expect(api.listShared).not.toHaveBeenCalled();
  });
});

describe("Kho Snippet with the durable library", () => {
  it("offers Mẫu có sẵn and Của tôi, and Của lớp only with a class", async () => {
    renderTool({ classID: null });
    await waitForEditor();
    let drawer = openLibrary();
    const tabs = within(drawer).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Mẫu có sẵn",
      "Của tôi",
    ]);
    cleanup();

    renderTool({ classID });
    await waitForEditor();
    drawer = openLibrary();
    expect(
      within(drawer)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Mẫu có sẵn", "Của tôi", "Của lớp"]);
  });

  it("reads a class snippet's content only when opened, never runs it, and hides manage actions from students", async () => {
    api.getSnippet.mockResolvedValue(
      detail(classSnippet, "for i in range(1, 4):\n    print(i * 7)\n"),
    );
    renderTool({ classID, isStaff: false });
    await waitForEditor();
    openLibrary();
    chooseTab("Của lớp");
    const title = await screen.findByRole("heading", {
      name: "Bảng cửu chương",
    });
    const card = title.closest("article") as HTMLElement;
    expect(api.listSnippets).toHaveBeenCalledWith(
      tenantID,
      expect.objectContaining({ classID, scope: "class" }),
      expect.anything(),
    );
    expect(api.getSnippet).not.toHaveBeenCalled();
    expect(within(card).queryByRole("button", { name: /Sửa/u })).toBeNull();
    expect(within(card).queryByRole("button", { name: /Xóa/u })).toBeNull();

    fireEvent.click(
      within(card).getByRole("button", { name: "Mở thành tệp mới" }),
    );
    await waitFor(() => expect(fileTab("bang_cuu_chuong.py")).toBeVisible());
    expect(api.getSnippet).toHaveBeenCalledWith(
      tenantID,
      classSnippetID,
      expect.anything(),
    );
    expect(editor().state.doc.toString()).toContain("print(i * 7)");
    expect(
      document.querySelector(".classroom-code-output__pre"),
    ).toHaveAttribute("data-empty", "true");
  });

  it("saves the open file for the class as staff, and edits or deletes by viewer capabilities", async () => {
    api.createSnippet.mockImplementation(
      async (_tenant: string, input: Record<string, unknown>) =>
        detail(
          { ...classSnippet, id: "7d2e8a20-5f9c-4e5a-9b37-4c9b1c5f3e33" },
          String(input.content),
        ),
    );
    api.deleteSnippet.mockResolvedValue(undefined);
    renderTool({ classID, isStaff: true });
    await waitForEditor();
    setCode("print('chia se cho lop')\n");
    const drawer = openLibrary();
    fireEvent.click(
      within(drawer).getByRole("button", { name: "Lưu vào Kho" }),
    );
    const form = await screen.findByRole("form", {
      name: "Lưu vào Kho Snippet",
    });
    const titleInput = within(form).getByLabelText("Tiêu đề");
    expect(titleInput).toHaveValue("main.py");
    fireEvent.change(titleInput, { target: { value: "Chia sẻ lớp" } });
    fireEvent.click(within(form).getByLabelText("Chia sẻ cho lớp"));
    fireEvent.click(within(form).getByRole("button", { name: "Lưu vào Kho" }));
    await waitFor(() => expect(api.createSnippet).toHaveBeenCalledTimes(1));
    const [, input, csrf] = api.createSnippet.mock.calls[0] as [
      string,
      Record<string, unknown>,
      string,
    ];
    expect(csrf).toBe("code-csrf");
    expect(input).toMatchObject({
      class_id: classID,
      content: "print('chia se cho lop')\n",
      file_name: "main.py",
      language: "python",
      title: "Chia sẻ lớp",
      visibility: "class",
    });
    expect(String(input.idempotency_key).length).toBeGreaterThanOrEqual(16);

    // Back on the list: a personal snippet the viewer owns can be deleted.
    chooseTab("Của tôi");
    const mine = await screen.findByRole("heading", {
      name: "Vòng lặp của tôi",
    });
    const card = mine.closest("article") as HTMLElement;
    expect(
      within(card).getByRole("button", {
        name: "Sửa snippet “Vòng lặp của tôi”",
      }),
    ).toBeVisible();
    fireEvent.click(
      within(card).getByRole("button", {
        name: "Xóa snippet “Vòng lặp của tôi”",
      }),
    );
    fireEvent.click(within(card).getByRole("button", { name: "Xóa" }));
    await waitFor(() =>
      expect(api.deleteSnippet).toHaveBeenCalledWith(
        tenantID,
        personalID,
        "code-csrf",
        expect.anything(),
      ),
    );
  });

  it("never offers class sharing to a student and explains a quota refusal", async () => {
    api.createSnippet.mockRejectedValue(
      problem(409, "code_snippet_quota_exceeded"),
    );
    renderTool({ classID, isStaff: false });
    await waitForEditor();
    const drawer = openLibrary();
    fireEvent.click(
      within(drawer).getByRole("button", { name: "Lưu vào Kho" }),
    );
    const form = await screen.findByRole("form", {
      name: "Lưu vào Kho Snippet",
    });
    expect(within(form).queryByLabelText("Chia sẻ cho lớp")).toBeNull();
    fireEvent.click(within(form).getByRole("button", { name: "Lưu vào Kho" }));
    expect(
      await within(form).findByText(/đạt giới hạn số snippet/u),
    ).toBeVisible();
    expect(api.createSnippet.mock.calls[0]?.[1]).toMatchObject({
      class_id: null,
      visibility: "personal",
    });
  });
});

describe("Nháp của tôi on the server", () => {
  it("opens a newer server draft that was not edited here", async () => {
    api.getScratchpad.mockResolvedValue({
      scratchpad: draft(3, "print('tu may chu')\n"),
    });
    renderTool();
    await waitForEditor();
    await waitFor(() =>
      expect(editor().state.doc.toString()).toBe("print('tu may chu')\n"),
    );
    expect(await screen.findByText(/Đã lưu trên máy chủ/u)).toBeVisible();
    expect(api.putScratchpad).not.toHaveBeenCalled();
  });

  it("autosaves with CAS and resolves a version conflict both ways without losing text", async () => {
    let version = 0;
    api.putScratchpad.mockImplementation(
      async (_tenant: string, _space: string, input: { files: [] }) => {
        version += 1;
        return { ...draft(version, ""), files: input.files };
      },
    );
    renderTool();
    await waitForEditor();
    await waitFor(() => expect(api.getScratchpad).toHaveBeenCalledTimes(1));
    setCode("print('v1')\n");
    await waitFor(() => expect(api.putScratchpad).toHaveBeenCalledTimes(1), {
      timeout: 4_000,
    });
    expect(api.putScratchpad.mock.calls[0]?.[2]).toMatchObject({
      active_index: 0,
      expected_version: 0,
      files: [
        { content: "print('v1')\n", language: "python", name: "main.py" },
      ],
    });
    expect(api.putScratchpad.mock.calls[0]?.[3]).toBe("code-csrf");
    await waitFor(() =>
      expect(screen.getByText(/Đã lưu trên máy chủ/u)).toBeVisible(),
    );

    api.putScratchpad.mockRejectedValueOnce(
      problem(409, "code_scratchpad_version_conflict"),
    );
    setCode("print('v2 cua tab nay')\n");
    const bar = await screen.findByRole(
      "group",
      { name: /Bản nháp đã được cập nhật từ tab\/thiết bị khác/u },
      { timeout: 4_000 },
    );
    expect(editor().state.doc.toString()).toBe("print('v2 cua tab nay')\n");

    api.getScratchpad.mockResolvedValueOnce({
      scratchpad: draft(5, "print('ban may chu')\n"),
    });
    fireEvent.click(
      within(bar).getByRole("button", { name: "Tải bản trên máy chủ" }),
    );
    await waitFor(() =>
      expect(editor().state.doc.toString()).toBe("print('ban may chu')\n"),
    );
    expect(
      screen.queryByRole("group", { name: /Bản nháp đã được cập nhật/u }),
    ).toBeNull();

    api.putScratchpad.mockRejectedValueOnce(
      problem(409, "code_scratchpad_version_conflict"),
    );
    setCode("print('giu ban nay')\n");
    const again = await screen.findByRole(
      "group",
      { name: /Bản nháp đã được cập nhật/u },
      { timeout: 4_000 },
    );
    api.getScratchpad.mockResolvedValueOnce({
      scratchpad: draft(9, "print('khac')\n"),
    });
    const callsBefore = api.putScratchpad.mock.calls.length;
    fireEvent.click(
      within(again).getByRole("button", { name: "Ghi đè bằng bản đang gõ" }),
    );
    await waitFor(() =>
      expect(api.putScratchpad.mock.calls.length).toBe(callsBefore + 1),
    );
    expect(api.putScratchpad.mock.lastCall?.[2]).toMatchObject({
      expected_version: 9,
      files: [{ content: "print('giu ban nay')\n" }],
    });
    expect(editor().state.doc.toString()).toBe("print('giu ban nay')\n");
  });

  it("explains an oversized draft and keeps the text", async () => {
    api.putScratchpad.mockRejectedValue(
      problem(413, "code_scratchpad_too_large"),
    );
    renderTool();
    await waitForEditor();
    await waitFor(() => expect(api.getScratchpad).toHaveBeenCalled());
    setCode("x = 1\n");
    expect(
      await screen.findByText(/Bản nháp vượt 256 KB/u, undefined, {
        timeout: 4_000,
      }),
    ).toBeVisible();
    expect(editor().state.doc.toString()).toBe("x = 1\n");
  });

  it("lets a student send work to teachers (saving first) and stop sharing", async () => {
    api.putScratchpad.mockResolvedValue(draft(1, "x = 1"));
    api.share.mockImplementation(
      async (_tenant: string, _space: string, shared: boolean) => ({
        scratchpad: draft(1, "x = 1", shared),
      }),
    );
    renderTool({ isStaff: false });
    await waitForEditor();
    const toggle = await screen.findByRole("button", {
      name: "Gửi bài cho GV",
    });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    const sharedToggle = await screen.findByRole("button", {
      name: "Đã gửi GV · Ngừng chia sẻ",
    });
    expect(sharedToggle).toHaveAttribute("aria-pressed", "true");
    expect(api.putScratchpad).toHaveBeenCalledTimes(1);
    expect(api.share).toHaveBeenLastCalledWith(
      tenantID,
      mediaSpaceID,
      true,
      "code-csrf",
      expect.anything(),
    );
    expect(api.putScratchpad.mock.invocationCallOrder[0]).toBeLessThan(
      api.share.mock.invocationCallOrder[0] ?? 0,
    );

    fireEvent.click(sharedToggle);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Gửi bài cho GV" }),
      ).toHaveAttribute("aria-pressed", "false"),
    );
    expect(api.share).toHaveBeenLastCalledWith(
      tenantID,
      mediaSpaceID,
      false,
      "code-csrf",
      expect.anything(),
    );
    expect(
      screen.getByText("Đã ngừng chia sẻ bài làm với giáo viên."),
    ).toBeInTheDocument();
  });
});

describe("Bài học sinh (staff)", () => {
  const studentWork: CodeSharedScratchpad = {
    active_file_name: "main.py",
    active_index: 0,
    active_language: "python",
    author_display_name: "Minh Anh",
    byte_length: 22,
    file_count: 1,
    files: [
      {
        content: "print('bai cua Minh Anh')\n",
        language: "python",
        name: "main.py",
      },
    ],
    id: sharedID,
    participant_key: null,
    shared_at: "2030-08-03T00:01:00Z",
    stdin: "",
    updated_at: "2030-08-03T00:02:00Z",
  };

  it("lists shared work, shows it read-only, copies it into My draft and prefills a chat comment", async () => {
    api.listShared.mockResolvedValue({ items: [studentWork] });
    api.getShared.mockResolvedValue(studentWork);
    const onSendToChat = vi.fn();
    renderTool({ isStaff: true, onSendToChat });
    await waitForEditor();
    expect(screen.queryByRole("button", { name: "Gửi bài cho GV" })).toBeNull();
    const button = await screen.findByRole("button", {
      name: "Bài học sinh (1)",
    });
    fireEvent.click(button);
    const drawer = screen.getByRole("complementary", { name: "Bài học sinh" });
    fireEvent.click(
      await within(drawer).findByRole("button", { name: /^Minh Anh/u }),
    );
    const code = await within(drawer).findByLabelText(
      "Tệp main.py của Minh Anh (chỉ đọc)",
    );
    expect(code.textContent).toBe("print('bai cua Minh Anh')\n");
    expect(drawer.querySelector("[contenteditable]")).toBeNull();

    fireEvent.click(
      within(drawer).getByRole("button", {
        name: "Gửi nhận xét vào Trò chuyện",
      }),
    );
    expect(onSendToChat).toHaveBeenCalledWith("@Minh Anh ");
    expect(toolActions.openChat).toHaveBeenCalled();

    fireEvent.click(
      within(drawer).getByRole("button", {
        name: "Mở bản sao vào Nháp của tôi",
      }),
    );
    await waitFor(() =>
      expect(editor().state.doc.toString()).toBe("print('bai cua Minh Anh')\n"),
    );
    expect(
      screen.queryByRole("complementary", { name: "Bài học sinh" }),
    ).toBeNull();
    // The copy is the teacher's own edit: it saves to the teacher's draft.
    await waitFor(() => expect(api.putScratchpad).toHaveBeenCalled(), {
      timeout: 4_000,
    });
  });

  it("explains work the student stopped sharing and re-reads the list", async () => {
    api.listShared.mockResolvedValue({ items: [studentWork] });
    api.getShared.mockRejectedValue(problem(404, "code_library_not_found"));
    renderTool({ isStaff: true });
    await waitForEditor();
    fireEvent.click(
      await screen.findByRole("button", { name: "Bài học sinh (1)" }),
    );
    const drawer = screen.getByRole("complementary", { name: "Bài học sinh" });
    const calls = api.listShared.mock.calls.length;
    fireEvent.click(
      await within(drawer).findByRole("button", { name: /^Minh Anh/u }),
    );
    expect(
      await within(drawer).findByText("Học sinh đã ngừng chia sẻ bài làm này."),
    ).toBeVisible();
    await waitFor(() =>
      expect(api.listShared.mock.calls.length).toBeGreaterThan(calls),
    );
    fireEvent.keyDown(drawer, { key: "Escape" });
    expect(
      screen.queryByRole("complementary", { name: "Bài học sinh" }),
    ).toBeNull();
  });
});

describe("Nhập gói dự án (.json)", () => {
  async function pick(content: string) {
    const input = document.querySelector(
      '[data-testid="code-project-import"]',
    ) as HTMLInputElement;
    const file = new File([content], "bai.tutorhub-code.json", {
      type: "application/json",
    });
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });
    await act(async () => {
      fireEvent.change(input);
      await new Promise((resolve) => globalThis.setTimeout(resolve, 30));
    });
  }

  it("refuses a package changed by one character and opens the intact one without running it", async () => {
    const exported = await exportCodeProject(
      {
        activeIndex: 0,
        files: [
          {
            content: "print('goi du an')\n",
            language: "python",
            name: "app.py",
          },
          { content: "SELECT 1;\n", language: "sql", name: "q.sql" },
        ],
        stdin: "",
      },
      "app",
    );
    renderTool({ libraryEnabled: false });
    await waitForEditor();

    await pick(exported.json.replace("goi du an", "goi du an!"));
    expect(await screen.findByText(/sai mã kiểm tra checksum/u)).toBeVisible();
    expect(screen.queryByRole("button", { name: "app.py" })).toBeNull();

    await pick(exported.json);
    await waitFor(() => expect(fileTab("app.py")).toBeVisible());
    expect(fileTab("q.sql")).toBeVisible();
    expect(editor().state.doc.toString()).toBe("print('goi du an')\n");
    expect(
      document.querySelector(".classroom-code-output__pre"),
    ).toHaveAttribute("data-empty", "true");
  });
});
