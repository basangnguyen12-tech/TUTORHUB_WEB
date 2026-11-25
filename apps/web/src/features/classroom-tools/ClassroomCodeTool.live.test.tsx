// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
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
  CodeWorkspace,
  CodeWorkspaceProjection,
  WhiteboardCapability,
} from "@tutorhub/api-client";
import {
  CanonicalCodeWorkspaceAuthority,
  type CodeWorkspaceFileInput,
} from "@tutorhub/collaboration-client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as Y from "yjs";
import { codeWorkspaceQueryKeys } from "../../app/codeWorkspaces";
import { I18nProvider } from "../../app/i18n";
import { ClassroomCodeTool } from "./ClassroomCodeTool";
import {
  createClassroomCodeSession,
  type ClassroomCodeSession,
} from "./codeSession";
import type {
  LiveCodeSession,
  OpenLiveCodeSessionOptions,
} from "./liveCodeCollaboration";

/**
 * ROOM-TOOLS-CODE-02B: the Code tool's two modes. Only the Core API client
 * and the Hocuspocus transport are replaced; the shared files are real
 * `code.workspace.v1` authorities over two linked Y.Docs (teacher ↔ viewer),
 * bound to CodeMirror through the real `y-codemirror.next` extensions.
 */
const apiMocks = vi.hoisted(() => ({
  create: vi.fn(),
  exchange: vi.fn(),
  resolve: vi.fn(),
  rotate: vi.fn(),
  transition: vi.fn(),
}));
const liveMocks = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock("@tutorhub/api-client", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@tutorhub/api-client")>();
  return {
    ...original,
    createCodeWorkspace: apiMocks.create,
    exchangeCodeWorkspaceGrant: apiMocks.exchange,
    resolveCodeWorkspace: apiMocks.resolve,
    rotateCSRFToken: apiMocks.rotate,
    transitionCodeWorkspace: apiMocks.transition,
  };
});

vi.mock("./liveCodeCollaboration", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./liveCodeCollaboration")>();
  return { ...original, openLiveCodeSession: liveMocks.open };
});

const tenantID = "4b18543a-74de-419f-9fe8-d0c3dfc991eb";
const mediaSpaceID = "c2dc1048-1d90-4c90-ae50-5fb436bfb607";
const workspaceID = "5b0c6f0e-3d7a-4c38-9f15-2a7f9a3d1c11";
const teacherActor = "teacher-actor-0001";
const studentActor = "student-actor-0002";
const scope = {
  documentId: workspaceID,
  generation: 1,
  tenantId: "tenant-0001",
};

const SHARED_FILES: readonly CodeWorkspaceFileInput[] = [
  { content: 'print("xin chao")\n', language: "python", name: "main.py" },
  {
    content: "def tong(a, b):\n    return a + b\n",
    language: "python",
    name: "bai2.py",
  },
];

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

function workspace(
  status: CodeWorkspace["status"],
  capability: WhiteboardCapability,
  overrides: Partial<CodeWorkspace["viewer_capabilities"]> = {},
): CodeWorkspace {
  const presenter = capability === "present";
  return {
    created_at: "2030-08-03T00:00:00Z",
    current_generation: 1,
    id: workspaceID,
    media_space_id: mediaSpaceID,
    revoke_generation: 1,
    status,
    updated_at: "2030-08-03T00:00:00Z",
    version: 2,
    viewer_capabilities: {
      can_close: presenter && status === "open",
      can_exchange_grant: status === "open",
      can_manage_editor_grants: presenter && status === "open",
      can_open: presenter && status === "created",
      can_resume: presenter && status === "suspended",
      can_suspend: presenter && status === "open",
      capability,
      ...overrides,
    },
  };
}

function projection(
  current: CodeWorkspace | null,
  canCreate = false,
): CodeWorkspaceProjection {
  return {
    active_editor_grants: [],
    can_create: canCreate,
    workspace: current,
  };
}

/** Two replicas synced both ways, like the Hocuspocus relay. */
function linkedDocs(): [Y.Doc, Y.Doc] {
  const left = new Y.Doc();
  const right = new Y.Doc();
  left.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "remote") Y.applyUpdate(right, update, "remote");
  });
  right.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "remote") Y.applyUpdate(left, update, "remote");
  });
  return [left, right];
}

interface Classroom {
  readonly fileIds: readonly string[];
  /** The other side of the room (the teacher for a student viewer). */
  readonly peer: CanonicalCodeWorkspaceAuthority;
  readonly viewerDoc: Y.Doc;
}

/** A shared workspace the teacher already started with two files. */
function startedClassroom(): Classroom {
  const [teacherDoc, viewerDoc] = linkedDocs();
  const peer = new CanonicalCodeWorkspaceAuthority(
    teacherDoc,
    scope,
    teacherActor,
  );
  const fileIds = peer.initialize(SHARED_FILES);
  return { fileIds, peer, viewerDoc };
}

/** The session factory over the viewer's replica (`createBrowser…` shape). */
function serveSessions(viewerDoc: Y.Doc, actor: string) {
  liveMocks.open.mockImplementation(
    async ({ grant, initialFiles }: OpenLiveCodeSessionOptions) => {
      const authority = new CanonicalCodeWorkspaceAuthority(
        viewerDoc,
        scope,
        actor,
        { readOnly: grant.capability === "view" },
      );
      if (!authority.isInitialized() && grant.capability !== "view") {
        authority.initialize(initialFiles);
      }
      return {
        authority,
        awareness: null,
        capability: grant.capability,
        destroy: () => authority.destroy(),
        generation: grant.generation,
      } as unknown as LiveCodeSession;
    },
  );
}

let queryClient: QueryClient;

function renderTool(
  options: {
    collaborationEnabled?: boolean;
    session?: ClassroomCodeSession;
  } = {},
) {
  const session = options.session ?? createClassroomCodeSession();
  queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLanguage="vi">
        <ClassroomCodeTool
          actorID={studentActor}
          chatCanPost
          collaborationEnabled={options.collaborationEnabled}
          displayName="Minh Anh"
          enabled
          mediaSpaceID={mediaSpaceID}
          session={session}
          tenantID={tenantID}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { ...view, session };
}

const modeButton = (name: "Chung lớp" | "Nháp của tôi") =>
  within(screen.getByRole("group", { name: "Chế độ Code" })).getByRole(
    "button",
    { name: new RegExp(`^${name}`, "u") },
  );
const fileTab = (name: string) =>
  within(screen.getByRole("group", { name: "Tệp trong phiên" })).getByRole(
    "button",
    { name },
  );
const editorText = () =>
  document.querySelector(".classroom-code .cm-content")?.textContent ?? "";

async function waitForEditor() {
  await waitFor(() =>
    expect(document.querySelector(".classroom-code .cm-editor")).not.toBeNull(),
  );
}

beforeEach(() => {
  apiMocks.rotate.mockResolvedValue({ csrf_token: "code-csrf" });
  apiMocks.exchange.mockImplementation(
    async (
      _tenant: string,
      _workspace: string,
      request: { capability: WhiteboardCapability },
    ) => ({
      capability: request.capability,
      credential: "c".repeat(48),
      document_id: workspaceID,
      expires_at: "2099-01-01T00:00:00Z",
      generation: 1,
      provider_url: "ws://127.0.0.1:1/collaboration",
      revoke_generation: 1,
    }),
  );
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  window.localStorage.clear();
  vi.clearAllMocks();
  apiMocks.resolve.mockReset();
  apiMocks.create.mockReset();
  apiMocks.transition.mockReset();
  liveMocks.open.mockReset();
});

describe("ClassroomCodeTool shared mode (ROOM-TOOLS-CODE-02B)", () => {
  it("keeps the Slice 1 personal workspace when collaboration is off", async () => {
    renderTool();
    await waitForEditor();
    expect(
      screen.queryByRole("group", { name: "Chế độ Code" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Trạng thái buổi code chung" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Thêm tệp" })).toBeVisible();
    expect(editorText()).toContain("Chào mừng");
    // Personal mode never reads the shared projection nor loads Yjs.
    expect(apiMocks.resolve).not.toHaveBeenCalled();
    expect(liveMocks.open).not.toHaveBeenCalled();
  });

  it("opens a student in My draft before class coding starts and shows the not-started state in Class", async () => {
    apiMocks.resolve.mockResolvedValue(projection(null));
    renderTool({ collaborationEnabled: true });

    await waitFor(() =>
      expect(modeButton("Nháp của tôi")).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(modeButton("Chung lớp")).toHaveAttribute("aria-pressed", "false");
    await waitForEditor();
    expect(editorText()).toContain("Chào mừng");

    fireEvent.click(modeButton("Chung lớp"));
    expect(modeButton("Chung lớp")).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByText("Chưa bắt đầu")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Bắt đầu buổi code chung" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Mở Nháp của tôi" }));
    expect(modeButton("Nháp của tôi")).toHaveAttribute("aria-pressed", "true");
    await waitForEditor();
    expect(liveMocks.open).not.toHaveBeenCalled();
  });

  it("lets a teacher start class coding in one tap, seeded from the draft template", async () => {
    let current = projection(null, true);
    apiMocks.resolve.mockImplementation(async () => current);
    apiMocks.create.mockImplementation(async () => {
      const created = workspace("created", "present");
      current = projection(created);
      return created;
    });
    apiMocks.transition.mockImplementation(
      async (_tenant: string, _id: string, operation: string) => {
        expect(operation).toBe("open");
        const opened = workspace("open", "present");
        current = projection(opened);
        return opened;
      },
    );
    const [teacherDoc] = linkedDocs();
    serveSessions(teacherDoc, teacherActor);
    renderTool({ collaborationEnabled: true });

    await waitFor(() =>
      expect(modeButton("Chung lớp")).toHaveAttribute("aria-pressed", "true"),
    );
    expect(await screen.findByText("Sẵn sàng code cùng cả lớp")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Bắt đầu buổi code chung" }),
    );

    const bar = await screen.findByRole("group", {
      name: "Trạng thái buổi code chung",
    });
    expect(bar).toHaveTextContent("Bạn đang trình bày — cả lớp thấy mã này");
    expect(apiMocks.create).toHaveBeenCalledTimes(1);
    expect(apiMocks.transition).toHaveBeenCalledTimes(1);
    expect(apiMocks.exchange).toHaveBeenCalledWith(
      tenantID,
      workspaceID,
      {
        capability: "present",
        expected_generation: 1,
        expected_revoke_generation: 1,
      },
      "code-csrf",
      expect.any(Object),
    );
    // The presenter neither follows nor forks; the empty doc was seeded.
    expect(
      within(bar).queryByRole("button", { name: "Theo dõi GV" }),
    ).not.toBeInTheDocument();
    expect(
      within(bar).queryByRole("button", { name: "Tạo bản nháp từ mẫu" }),
    ).not.toBeInTheDocument();
    await waitForEditor();
    expect(editorText()).toContain("Chào mừng");
    expect(screen.getByRole("button", { name: "Thêm tệp" })).toBeVisible();
    // The live dot marks Class while the session is open.
    // (jsdom drops the leading space of the visually-hidden suffix.)
    expect(modeButton("Chung lớp")).toHaveAccessibleName(
      /^Chung lớp\s?\(đang mở\)$/u,
    );
  });

  it("keeps a view grant read-only, follows the teacher's file and stops following on a manual tab choice", async () => {
    const room = startedClassroom();
    apiMocks.resolve.mockResolvedValue(projection(workspace("open", "view")));
    serveSessions(room.viewerDoc, studentActor);
    renderTool({ collaborationEnabled: true });

    const bar = await screen.findByRole("group", {
      name: "Trạng thái buổi code chung",
    });
    expect(modeButton("Chung lớp")).toHaveAttribute("aria-pressed", "true");
    expect(bar).toHaveTextContent("Chế độ xem — giáo viên đang giảng mẫu");
    await waitForEditor();
    expect(editorText()).toContain('print("xin chao")');

    // Read-only: no add / rename / close; the editor says so.
    expect(screen.queryByRole("button", { name: "Thêm tệp" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Đổi tên main.py" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Đóng tệp main.py" }),
    ).toBeNull();
    expect(
      document.querySelector(".classroom-code .cm-content"),
    ).toHaveAttribute("aria-readonly", "true");

    const follow = within(bar).getByRole("button", { name: "Theo dõi GV" });
    expect(follow).toHaveAttribute("aria-pressed", "true");

    // The presenter opens bai2.py: the follower lands on it.
    act(() => room.peer.setPresenterFile(room.fileIds[1] as string));
    await waitFor(() =>
      expect(fileTab("bai2.py")).toHaveAttribute("aria-current", "true"),
    );
    await waitFor(() => expect(editorText()).toContain("def tong(a, b):"));

    // Remote typing reaches the read-only editor.
    act(() => {
      room.peer.text(room.fileIds[1] as string).insert(0, "# GV giảng\n");
    });
    await waitFor(() => expect(editorText()).toContain("# GV giảng"));

    // Choosing another tab yourself hands control back.
    fireEvent.click(fileTab("main.py"));
    expect(fileTab("main.py")).toHaveAttribute("aria-current", "true");
    expect(follow).toHaveAttribute("aria-pressed", "false");
    act(() => room.peer.setPresenterFile(room.fileIds[0] as string));
    act(() => room.peer.setPresenterFile(room.fileIds[1] as string));
    expect(fileTab("main.py")).toHaveAttribute("aria-current", "true");

    // Turning it back on jumps to the presenter's file again.
    fireEvent.click(follow);
    expect(follow).toHaveAttribute("aria-pressed", "true");
    await waitFor(() =>
      expect(fileTab("bai2.py")).toHaveAttribute("aria-current", "true"),
    );
  });

  it("forks the class code into My draft in one tap without touching the shared files", async () => {
    const room = startedClassroom();
    apiMocks.resolve.mockResolvedValue(projection(workspace("open", "view")));
    serveSessions(room.viewerDoc, studentActor);
    const { session } = renderTool({ collaborationEnabled: true });

    const bar = await screen.findByRole("group", {
      name: "Trạng thái buổi code chung",
    });
    await waitForEditor();
    fireEvent.click(
      within(bar).getByRole("button", { name: "Tạo bản nháp từ mẫu" }),
    );

    await waitFor(() =>
      expect(modeButton("Nháp của tôi")).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(
      await screen.findByText(
        "Đã tạo bản nháp từ mẫu trong Nháp của tôi. Bạn có thể sửa và chạy thử.",
      ),
    ).toBeInTheDocument();
    expect(session.readSnapshot()).toEqual({
      activeIndex: 0,
      files: SHARED_FILES.map((file) => ({ ...file })),
      stdin: "",
    });
    await waitForEditor();
    expect(editorText()).toContain('print("xin chao")');
    expect(fileTab("bai2.py")).toBeVisible();
    // The draft is editable and separate from the class workspace.
    expect(screen.getByRole("button", { name: "Thêm tệp" })).toBeVisible();
    expect(
      screen.queryByRole("group", { name: "Trạng thái buổi code chung" }),
    ).not.toBeInTheDocument();
    expect(room.peer.text(room.fileIds[0] as string).toString()).toBe(
      'print("xin chao")\n',
    );
  });

  it("swaps a view session for an edit grant without leaving the stage", async () => {
    const room = startedClassroom();
    apiMocks.resolve.mockResolvedValue(projection(workspace("open", "view")));
    serveSessions(room.viewerDoc, studentActor);
    renderTool({ collaborationEnabled: true });

    const bar = await screen.findByRole("group", {
      name: "Trạng thái buổi code chung",
    });
    await waitForEditor();
    expect(screen.queryByRole("button", { name: "Thêm tệp" })).toBeNull();

    act(() => {
      queryClient.setQueryData(
        codeWorkspaceQueryKeys.tool(tenantID, mediaSpaceID),
        projection(workspace("open", "edit")),
      );
    });

    await waitFor(() =>
      expect(bar).toHaveTextContent("Bạn có thể cùng sửa mã"),
    );
    expect(liveMocks.open).toHaveBeenCalledTimes(2);
    expect(
      apiMocks.exchange.mock.calls.map((call) => call[2].capability),
    ).toEqual(["view", "edit"]);
    expect(screen.getByRole("button", { name: "Thêm tệp" })).toBeVisible();
    expect(
      document.querySelector(".classroom-code .cm-content"),
    ).not.toHaveAttribute("aria-readonly");
    // An upgrade never keeps following (no caret jumps while typing).
    expect(
      within(bar).getByRole("button", { name: "Theo dõi GV" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(modeButton("Chung lớp")).toHaveAttribute("aria-pressed", "true");
  });
});
