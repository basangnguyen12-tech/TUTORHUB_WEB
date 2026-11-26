import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * ROOM-TOOLS-CODE-03B (ADR-0043 Slice 3): the durable snippet library, the
 * server-synced "Nháp của tôi", "Gửi bài cho GV" ↔ "Bài học sinh", portable
 * `.tutorhub-code.json` projects and lazily highlighted chat code cards.
 *
 * A teacher page and a student page mount the real classroom shell, chat
 * panel and Code tool from Vite source modules. The Core API answers from one
 * in-test state shared by both pages, enforcing what the server enforces:
 * tenant assertion, CSRF on mutations, CAS on the draft, class-staff rights
 * and 404 concealment of drafts that are not shared with staff.
 */
const fixturePath = "/__room-tools-code-03-fixture";
const TENANT_ID = "50000000-0000-4000-8000-000000000001";
const SPACE_ID = "40000000-0000-4000-8000-000000000001";
const CLASS_ID = "30000000-0000-4000-8000-000000000001";
const CSRF_TOKEN = "room-tools-code-03-csrf-token";

test.skip(
  process.env.E2E_MODE === "staging",
  "The Code library fixture loads Vite source modules.",
);

type Role = "teacher" | "student";
type Language =
  | "python"
  | "javascript"
  | "typescript"
  | "html"
  | "sql"
  | "c"
  | "cpp"
  | "java"
  | "css";

const PEOPLE: Readonly<Record<Role, { readonly name: string }>> = {
  student: { name: "Minh Anh" },
  teacher: { name: "Thu Hà" },
};

interface SnippetRecord {
  readonly classID: string | null;
  content: string;
  readonly createdAt: string;
  deleted: boolean;
  description: string;
  fileName: string;
  readonly id: string;
  language: Language;
  readonly owner: Role;
  title: string;
  updatedAt: string;
  version: number;
  readonly visibility: "personal" | "class";
}

interface DraftFile {
  readonly content: string;
  readonly language: Language;
  readonly name: string;
}

interface DraftRecord {
  activeIndex: number;
  readonly createdAt: string;
  files: DraftFile[];
  readonly id: string;
  shared: boolean;
  sharedAt: string | null;
  stdin: string;
  updatedAt: string;
  version: number;
}

interface CoreState {
  readonly drafts: Map<Role, DraftRecord>;
  readonly requests: Record<Role, string[]>;
  readonly snippets: SnippetRecord[];
}

let state: CoreState;

test.beforeEach(() => {
  state = {
    drafts: new Map(),
    requests: { student: [], teacher: [] },
    snippets: [],
  };
});

declare global {
  interface Window {
    __code03Fixture?: {
      editorText: () => string;
      sent: () => string[];
      setCode: (code: string) => void;
    };
  }
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    body: JSON.stringify(body),
    contentType: "application/json",
    status,
  });
}

async function problem(route: Route, status: number, code: string) {
  await route.fulfill({
    body: JSON.stringify({ code, status, title: code, type: "about:blank" }),
    contentType: "application/problem+json",
    status,
  });
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function snippetReadable(snippet: SnippetRecord, role: Role): boolean {
  if (snippet.deleted) return false;
  return snippet.visibility === "personal"
    ? snippet.owner === role
    : snippet.classID === CLASS_ID;
}

function snippetSummary(snippet: SnippetRecord, role: Role) {
  const manage =
    snippet.visibility === "personal"
      ? snippet.owner === role
      : role === "teacher";
  return {
    author_display_name: PEOPLE[snippet.owner].name,
    byte_length: bytes(snippet.content),
    class_id: snippet.classID,
    created_at: snippet.createdAt,
    description: snippet.description,
    file_name: snippet.fileName,
    id: snippet.id,
    language: snippet.language,
    title: snippet.title,
    updated_at: snippet.updatedAt,
    version: snippet.version,
    viewer_capabilities: { can_delete: manage, can_edit: manage },
    visibility: snippet.visibility,
  };
}

function snippetDetail(snippet: SnippetRecord, role: Role) {
  return {
    ...snippetSummary(snippet, role),
    content: snippet.content,
    content_sha256: `sha256:${"0".repeat(64)}`,
  };
}

function draftView(draft: DraftRecord) {
  return {
    active_index: draft.activeIndex,
    byte_length:
      draft.files.reduce((sum, file) => sum + bytes(file.content), 0) +
      bytes(draft.stdin),
    created_at: draft.createdAt,
    expires_at: new Date(Date.now() + 30 * 24 * 3_600_000).toISOString(),
    files: draft.files,
    id: draft.id,
    media_space_id: SPACE_ID,
    shared_at: draft.sharedAt,
    shared_with_staff: draft.shared,
    stdin: draft.stdin,
    updated_at: draft.updatedAt,
    version: draft.version,
  };
}

function sharedSummary(owner: Role, draft: DraftRecord) {
  const active = draft.files[draft.activeIndex] ?? draft.files[0];
  return {
    active_file_name: active?.name ?? "",
    active_language: active?.language ?? "python",
    author_display_name: PEOPLE[owner].name,
    byte_length: draftView(draft).byte_length,
    file_count: draft.files.length,
    id: draft.id,
    participant_key: null,
    shared_at: draft.sharedAt ?? draft.updatedAt,
    updated_at: draft.updatedAt,
  };
}

/** The Core API for one page (its role decides every right). */
async function installCoreApi(page: Page, role: Role) {
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const { pathname } = url;
    state.requests[role].push(`${method} ${pathname}`);
    if (pathname === "/api/v1/auth/csrf" && method === "GET") {
      return json(route, { csrf_token: CSRF_TOKEN });
    }
    const headers = request.headers();
    if (headers["x-tutorhub-expected-tenant-id"] !== TENANT_ID) {
      return problem(route, 400, "code_library_invalid");
    }
    if (method !== "GET" && headers["x-csrf-token"] !== CSRF_TOKEN) {
      return problem(route, 403, "csrf_invalid");
    }
    const now = new Date().toISOString();

    if (pathname === "/api/v1/code-snippets") {
      if (method === "GET") {
        const scope = url.searchParams.get("scope");
        const classID = url.searchParams.get("class_id");
        if (scope === "class" && classID !== CLASS_ID) {
          return problem(route, 404, "code_library_not_found");
        }
        const query = (url.searchParams.get("q") ?? "").toLowerCase();
        const language = url.searchParams.get("language");
        const items = state.snippets
          .filter(
            (snippet) =>
              snippet.visibility === scope &&
              snippetReadable(snippet, role) &&
              (!language || snippet.language === language) &&
              (!query || snippet.title.toLowerCase().includes(query)),
          )
          .map((snippet) => snippetSummary(snippet, role));
        return json(route, { items, next_cursor: null });
      }
      if (method === "POST") {
        const body = request.postDataJSON() as {
          class_id?: string | null;
          content: string;
          description?: string;
          file_name: string;
          language: Language;
          title: string;
          visibility: "personal" | "class";
        };
        if (body.visibility === "class") {
          if (body.class_id !== CLASS_ID) {
            return problem(route, 400, "code_library_invalid");
          }
          if (role !== "teacher") {
            return problem(route, 403, "code_library_forbidden");
          }
        }
        const snippet: SnippetRecord = {
          classID: body.visibility === "class" ? CLASS_ID : null,
          content: body.content,
          createdAt: now,
          deleted: false,
          description: body.description ?? "",
          fileName: body.file_name,
          id: randomUUID(),
          language: body.language,
          owner: role,
          title: body.title,
          updatedAt: now,
          version: 1,
          visibility: body.visibility,
        };
        state.snippets.push(snippet);
        return json(route, snippetDetail(snippet, role), 201);
      }
    }

    const snippetMatch = /^\/api\/v1\/code-snippets\/([0-9a-f-]{36})$/u.exec(
      pathname,
    );
    if (snippetMatch) {
      const snippet = state.snippets.find(
        (item) => item.id === snippetMatch[1] && snippetReadable(item, role),
      );
      if (!snippet) return problem(route, 404, "code_library_not_found");
      const manage = snippetSummary(snippet, role).viewer_capabilities.can_edit;
      if (method === "GET") return json(route, snippetDetail(snippet, role));
      if (!manage) return problem(route, 403, "code_library_forbidden");
      if (method === "DELETE") {
        snippet.deleted = true;
        return route.fulfill({ status: 204 });
      }
      if (method === "PATCH") {
        const body = request.postDataJSON() as {
          description?: string;
          expected_version: number;
          title?: string;
        };
        if (body.expected_version !== snippet.version) {
          return problem(route, 409, "code_snippet_version_conflict");
        }
        snippet.title = body.title ?? snippet.title;
        snippet.description = body.description ?? snippet.description;
        snippet.version += 1;
        snippet.updatedAt = now;
        return json(route, snippetDetail(snippet, role));
      }
    }

    const spacePath = `/api/v1/media/spaces/${SPACE_ID}`;
    if (pathname === `${spacePath}/code-scratchpad`) {
      const draft = state.drafts.get(role) ?? null;
      if (method === "GET") {
        return json(route, { scratchpad: draft ? draftView(draft) : null });
      }
      if (method === "PUT") {
        const body = request.postDataJSON() as {
          active_index: number;
          expected_version?: number;
          files: DraftFile[];
          stdin?: string;
        };
        if ((body.expected_version ?? 0) !== (draft?.version ?? 0)) {
          return problem(route, 409, "code_scratchpad_version_conflict");
        }
        const next: DraftRecord = {
          activeIndex: body.active_index,
          createdAt: draft?.createdAt ?? now,
          files: body.files,
          id: draft?.id ?? randomUUID(),
          shared: draft?.shared ?? false,
          sharedAt: draft?.sharedAt ?? null,
          stdin: body.stdin ?? "",
          updatedAt: now,
          version: (draft?.version ?? 0) + 1,
        };
        state.drafts.set(role, next);
        return json(route, draftView(next));
      }
    }
    if (pathname === `${spacePath}/code-scratchpad/share` && method === "PUT") {
      const draft = state.drafts.get(role);
      if (!draft) return problem(route, 409, "code_scratchpad_empty");
      const { shared } = request.postDataJSON() as { shared: boolean };
      draft.shared = shared;
      draft.sharedAt = shared ? now : null;
      return json(route, { scratchpad: draftView(draft) });
    }
    if (pathname === `${spacePath}/shared-scratchpads` && method === "GET") {
      // Only the room's teaching staff: everyone else is concealed as 404.
      if (role !== "teacher")
        return problem(route, 404, "code_library_not_found");
      const items = [...state.drafts]
        .filter(([owner, draft]) => owner !== "teacher" && draft.shared)
        .map(([owner, draft]) => sharedSummary(owner, draft));
      return json(route, { items });
    }
    const sharedMatch = new RegExp(
      `^${spacePath}/shared-scratchpads/([0-9a-f-]{36})$`,
      "u",
    ).exec(pathname);
    if (sharedMatch && method === "GET") {
      const entry = [...state.drafts].find(
        ([owner, draft]) =>
          owner !== "teacher" && draft.id === sharedMatch[1] && draft.shared,
      );
      if (role !== "teacher" || !entry) {
        return problem(route, 404, "code_library_not_found");
      }
      const [owner, draft] = entry;
      return json(route, {
        ...sharedSummary(owner, draft),
        active_index: draft.activeIndex,
        files: draft.files,
        stdin: draft.stdin,
      });
    }
    return problem(route, 404, "not_found");
  });
}

async function installFixtureDocument(page: Page) {
  await page.route(`**${fixturePath}`, async (route) => {
    await route.fulfill({
      body: [
        "<!doctype html>",
        '<html lang="vi">',
        "<head>",
        '<meta charset="UTF-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
        "<title>ROOM-TOOLS-CODE-03 fixture</title>",
        '<script type="module">',
        "import RefreshRuntime from '/@react-refresh';",
        "RefreshRuntime.injectIntoGlobalHook(window);",
        "window.$RefreshReg$ = () => {};",
        "window.$RefreshSig$ = () => (type) => type;",
        "window.__vite_plugin_react_preamble_installed__ = true;",
        "</script>",
        "</head>",
        '<body><div id="code-fixture-root"></div></body>',
        "</html>",
      ].join(""),
      contentType: "text/html",
      headers: { "Cache-Control": "no-store" },
      status: 200,
    });
  });
}

async function installMediaProbe(page: Page) {
  await page.addInitScript(() => {
    const events = new EventTarget();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        addEventListener: events.addEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
        enumerateDevices: async () => [],
        getSupportedConstraints: () => ({}),
        getUserMedia: async () => {
          throw new DOMException(
            "No capture in the fixture.",
            "NotAllowedError",
          );
        },
        removeEventListener: events.removeEventListener.bind(events),
      },
    });
  });
}

interface MountedPage {
  readonly context: BrowserContext;
  readonly errors: string[];
  readonly page: Page;
}

async function mountClassroom(
  browser: Browser,
  role: Role,
  options: {
    readonly forcedColors?: boolean;
    readonly viewport?: { readonly height: number; readonly width: number };
  } = {},
): Promise<MountedPage> {
  const context = await browser.newContext({
    acceptDownloads: true,
    baseURL: "http://127.0.0.1:5173",
    locale: "vi-VN",
    viewport: options.viewport ?? { height: 900, width: 1440 },
  });
  const page = await context.newPage();
  if (options.forcedColors) {
    await page.emulateMedia({
      forcedColors: "active",
      reducedMotion: "reduce",
    });
  }
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installFixtureDocument(page);
  await installMediaProbe(page);
  await installCoreApi(page, role);
  await page.goto(fixturePath);
  await page.evaluate(
    async (fixture) => {
      const dynamicImport = new Function(
        "specifier",
        "return import(specifier)",
      ) as <Module>(specifier: string) => Promise<Module>;
      const source = (modulePath: string) =>
        fetch(modulePath).then((response) => {
          if (!response.ok) throw new Error(`Could not load ${modulePath}.`);
          return response.text();
        });
      const shellPath = "/src/features/media/ClassroomMediaShell.tsx";
      const libraryPath = "/src/app/codeLibrary.ts";
      const [shellSource, editorSource, librarySource] = await Promise.all([
        source(shellPath),
        source("/src/features/classroom-tools/codeEditor.ts"),
        source(libraryPath),
      ]);
      const pick = (text: string, pattern: RegExp, label: string) => {
        const value = text.match(pattern)?.[1];
        if (!value) throw new Error(`Could not resolve ${label}.`);
        return value;
      };
      /* eslint-disable @typescript-eslint/no-explicit-any -- browser-side fixture modules are untyped Vite source modules */
      const [
        ReactImport,
        ReactDOMImport,
        components,
        livekit,
        shell,
        i18n,
        icons,
        codeTool,
        codeSession,
        chatPanel,
        chatMedia,
        toolActions,
        view,
        query,
      ] = await Promise.all([
        dynamicImport<any>(
          pick(shellSource, /from "([^"]*\/react\.js\?v=[^"]+)"/, "React"),
        ),
        dynamicImport<any>("/@id/react-dom/client"),
        dynamicImport<any>(
          pick(
            shellSource,
            /from "([^"]*\/@livekit_components-react\.js\?v=[^"]+)"/,
            "LiveKit components",
          ),
        ),
        dynamicImport<any>(
          pick(
            shellSource,
            /from "([^"]*\/livekit-client\.js\?v=[^"]+)"/,
            "LiveKit client",
          ),
        ),
        dynamicImport<any>(shellPath),
        dynamicImport<any>(
          pick(
            shellSource,
            /from "([^"]*\/src\/app\/i18n\.tsx(?:\?t=[^"]+)?)"/,
            "i18n",
          ),
        ),
        dynamicImport<any>(
          pick(
            shellSource,
            /from "([^"]*\/lucide-react\.js\?v=[^"]+)"/,
            "icons",
          ),
        ),
        dynamicImport<any>(
          "/src/features/classroom-tools/ClassroomCodeTool.tsx",
        ),
        dynamicImport<any>("/src/features/classroom-tools/codeSession.ts"),
        dynamicImport<any>("/src/features/media/ClassroomChatPanel.tsx"),
        dynamicImport<any>("/src/features/media/classroomChatMedia.ts"),
        dynamicImport<any>("/src/features/classroom-tools/toolActions.ts"),
        dynamicImport<any>(
          pick(
            editorSource,
            /from "([^"]*\/@codemirror_view\.js\?v=[^"]+)"/,
            "CodeMirror view",
          ),
        ),
        dynamicImport<any>(
          pick(
            librarySource,
            /from "([^"]*\/@tanstack_react-query\.js\?v=[^"]+)"/,
            "React Query",
          ),
        ),
        dynamicImport<unknown>("/@id/@tutorhub/design-tokens/tokens.css"),
        dynamicImport<unknown>("/@id/@tutorhub/ui/styles.css"),
        dynamicImport<unknown>("/src/styles.css"),
        dynamicImport<unknown>("/src/pages/ClassroomRoomStage.css"),
      ]);
      const React = ReactImport.default;
      const ReactDOM = ReactDOMImport.default;
      const h = React.createElement;

      livekit.setLogLevel(livekit.LogLevel.silent);
      const room = new livekit.Room({
        adaptiveStream: true,
        dynacast: true,
        loggerName: "room-tools-code-03-fixture",
      });
      livekit
        .getLogger("room-tools-code-03-fixture")
        .setLevel(livekit.LogLevel.silent);
      await room.simulateParticipants({
        participants: { audio: false, count: 1, video: false },
        publish: { audio: true, useRealTracks: false, video: false },
      });

      const self = {
        display_name: fixture.name,
        user_id: `${fixture.role}-0001`,
      };
      const conversationID = "20000000-0000-4000-8000-000000000003";
      let sequence = 0;
      const message = (content: string) => {
        sequence += 1;
        const at = new Date().toISOString();
        return {
          attachments: [],
          author: self,
          client_message_id: `client-${sequence}`,
          content,
          conversation_id: conversationID,
          created_at: at,
          id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
          sequence,
          state: "active",
          updated_at: at,
          version: 1,
        };
      };
      const sent: string[] = [];
      const composerStore = chatMedia.createClassroomChatComposerStore();
      const session = codeSession.createClassroomCodeSession();
      const queryClient = new query.QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      const ChatContent = ({
        messages,
        onSend,
        open,
      }: {
        messages: unknown[];
        onSend: (input: { content: string }) => Promise<void>;
        open: boolean;
      }) => {
        const actions = React.useContext(
          toolActions.ClassroomToolActionsContext,
        );
        return h(chatPanel.ClassroomChatPanel, {
          actorID: self.user_id,
          composerStore,
          conversation: {
            created_at: new Date().toISOString(),
            id: conversationID,
            kind: "room",
            media_space_id: fixture.spaceID,
            media_space_status: "open",
            participant_chat_enabled: true,
            participants: [],
            title: "Lớp 10A1",
            unread_count: 0,
            unread_count_capped: false,
            updated_at: new Date().toISOString(),
            viewer_access: {
              can_moderate_chat: fixture.role === "teacher",
              can_post_messages: true,
              can_upload_attachments: true,
            },
          },
          hasOlder: false,
          loadAttachment: async () => new Blob([]),
          loadingOlder: false,
          messages,
          onDelete: async () => undefined,
          onEdit: async () => undefined,
          onLoadOlder: () => undefined,
          onOpenInCode:
            actions && actions.hasTool("code")
              ? (block: { code: string; language: string | null }) => {
                  session.push(block);
                  actions.openTool("code");
                }
              : undefined,
          onSend,
          onToggleParticipantChat: async () => undefined,
          onUpload: async () => {
            throw new Error("No uploads in the fixture.");
          },
          open,
          tenantID: fixture.tenantID,
        });
      };

      const Room = () => {
        const [open, setOpen] = React.useState(false);
        const [messages, setMessages] = React.useState([] as unknown[]);
        const onSend = async (input: { content: string }) => {
          sent.push(input.content);
          setMessages((current: unknown[]) => [
            ...current,
            message(input.content),
          ]);
        };
        return h(shell.ClassroomMediaShell, {
          canPublishCameraMicrophone: true,
          canShareScreen: true,
          canSubscribe: true,
          chat: h(ChatContent, { messages, onSend, open }),
          connectionStatus: "connected",
          onChatOpenChange: setOpen,
          onLeave: () => undefined,
          onTerminalMediaCleanup: async () => undefined,
          roomTitle: "Lớp 10A1 · Tin học",
          tools: [
            {
              content: h(codeTool.ClassroomCodeTool, {
                actorID: self.user_id,
                chatCanPost: true,
                classID: fixture.classID,
                displayName: self.display_name,
                enabled: true,
                isStaff: fixture.role === "teacher",
                libraryEnabled: true,
                mediaSpaceID: fixture.spaceID,
                onSendToChat: (text: string) =>
                  chatMedia.prefillClassroomChatComposer(composerStore, text),
                session,
                tenantID: fixture.tenantID,
              }),
              icon: h(icons.CodeXml),
              id: "code",
              label: "Code",
              title: "Công cụ Code",
            },
          ],
        });
      };

      const editorView = () => {
        const element = document.querySelector(".classroom-code .cm-editor");
        const found = element ? view.EditorView.findFromDOM(element) : null;
        if (!found) throw new Error("The Code editor is not mounted.");
        return found;
      };
      window.__code03Fixture = {
        editorText: () => editorView().state.doc.toString(),
        sent: () => [...sent],
        setCode: (code: string) => {
          const target = editorView();
          target.dispatch({
            changes: { from: 0, insert: code, to: target.state.doc.length },
          });
        },
      };
      /* eslint-enable @typescript-eslint/no-explicit-any */

      const rootElement = document.getElementById("code-fixture-root");
      if (!rootElement) throw new Error("Fixture root is missing.");
      ReactDOM.createRoot(rootElement).render(
        h(
          "main",
          {
            className: "media-p403-room media-p405-room",
            "data-theme": "dark",
          },
          h(
            query.QueryClientProvider,
            { client: queryClient },
            h(
              i18n.I18nProvider,
              { initialLanguage: "vi" },
              h(components.RoomContext.Provider, { value: room }, h(Room)),
            ),
          ),
        ),
      );
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    },
    {
      classID: CLASS_ID,
      name: PEOPLE[role].name,
      role,
      spaceID: SPACE_ID,
      tenantID: TENANT_ID,
    },
  );
  await expect(page.locator(".media-p405-shell")).toBeVisible();
  return { context, errors, page };
}

async function openCodeTool(page: Page) {
  await page.locator("#media-p506-control-tools").click();
  await page.locator("#media-p506-tool-option-code").click();
  await expect(page.locator("#media-p506-stage-code")).toBeVisible();
  await expect(page.locator(".classroom-code .cm-editor")).toBeVisible({
    timeout: 30_000,
  });
}

async function setCode(page: Page, code: string) {
  await page.evaluate((text) => window.__code03Fixture?.setCode(text), code);
}

async function editorText(page: Page) {
  return page.evaluate(() => window.__code03Fixture?.editorText() ?? "");
}

const runButton = (page: Page) => page.locator(".classroom-code-run");
const runStatus = (page: Page) =>
  page.locator(".classroom-code-output__status");
const output = (page: Page) => page.locator(".classroom-code-output__pre");
const usage = (page: Page) => page.locator(".classroom-code__usage");
const snippetDrawer = (page: Page) =>
  page.getByRole("complementary", { name: "Kho Snippet" });
const workDrawer = (page: Page) =>
  page.getByRole("complementary", { name: "Bài học sinh" });
const fileTab = (page: Page, name: string) =>
  page
    .getByRole("group", { name: "Tệp trong phiên" })
    .getByRole("button", { exact: true, name });

async function runAndWait(page: Page, status: string, timeout = 90_000) {
  await runButton(page).click();
  await expect(runStatus(page)).toContainText(status, { timeout });
  await expect(runButton(page)).not.toHaveAttribute("data-running", "true");
}

async function expectSaved(page: Page) {
  await expect(usage(page)).toContainText("Đã lưu trên máy chủ", {
    timeout: 15_000,
  });
}

async function expectNoViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      nodes: violation.nodes.map((node) => ({
        data: JSON.stringify(node.any[0]?.data ?? null),
        target: node.target.join(" "),
      })),
    })),
  ).toEqual([]);
}

function seedPersonalSnippet(owner: Role, title: string) {
  const now = new Date().toISOString();
  state.snippets.push({
    classID: null,
    content: "print('snippet ca nhan')\n",
    createdAt: now,
    deleted: false,
    description: "Mẫu cá nhân",
    fileName: "ca_nhan.py",
    id: randomUUID(),
    language: "python",
    owner,
    title,
    updatedAt: now,
    version: 1,
    visibility: "personal",
  });
}

function seedSharedStudentDraft(content: string) {
  const now = new Date().toISOString();
  state.drafts.set("student", {
    activeIndex: 0,
    createdAt: now,
    files: [{ content, language: "python", name: "main.py" }],
    id: randomUUID(),
    shared: true,
    sharedAt: now,
    stdin: "",
    updatedAt: now,
    version: 3,
  });
}

test("ROOM-TOOLS-CODE-03 class snippet library: a teacher shares a Python snippet, a student opens and runs it", async ({
  browser,
}) => {
  const teacher = await mountClassroom(browser, "teacher");
  const student = await mountClassroom(browser, "student");
  try {
    await openCodeTool(teacher.page);
    await setCode(
      teacher.page,
      'for i in range(1, 4):\n    print(f"7 x {i} = {7 * i}")\n',
    );
    await teacher.page.getByRole("button", { name: "Kho Snippet" }).click();
    const drawer = snippetDrawer(teacher.page);
    await expect(drawer.getByRole("tab", { name: "Của lớp" })).toBeVisible();
    await drawer.getByRole("button", { name: "Lưu vào Kho" }).click();
    const form = teacher.page.getByRole("form", {
      name: "Lưu vào Kho Snippet",
    });
    await expect(form.getByLabel("Tiêu đề")).toBeFocused();
    await form.getByLabel("Tiêu đề").fill("Bảng cửu chương 7");
    await form.getByLabel("Mô tả ngắn (tùy chọn)").fill("Vòng lặp for");
    await form.getByLabel("Chia sẻ cho lớp").check();
    await form.getByRole("button", { name: "Lưu vào Kho" }).click();
    await expect(drawer.getByRole("tab", { name: "Của lớp" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      drawer.getByRole("heading", { name: "Bảng cửu chương 7" }),
    ).toBeVisible();
    expect(state.snippets).toHaveLength(1);
    expect(state.snippets[0]).toMatchObject({
      classID: CLASS_ID,
      owner: "teacher",
      visibility: "class",
    });

    // The student sees it in "Của lớp", opens it as a new file and runs it.
    await openCodeTool(student.page);
    await student.page.getByRole("button", { name: "Kho Snippet" }).click();
    const library = snippetDrawer(student.page);
    await library.getByRole("tab", { name: "Của lớp" }).click();
    const card = library.locator("article", {
      has: student.page.getByRole("heading", { name: "Bảng cửu chương 7" }),
    });
    await expect(card).toBeVisible();
    await expect(card).toContainText("Thu Hà");
    // Students never manage class snippets.
    await expect(card.getByRole("button", { name: /^Sửa/u })).toHaveCount(0);
    await expect(card.getByRole("button", { name: /^Xóa/u })).toHaveCount(0);
    await card.getByRole("button", { name: "Mở thành tệp mới" }).click();
    await expect(library).toHaveCount(0);
    await expect(fileTab(student.page, "main-2.py")).toBeVisible();
    expect(await editorText(student.page)).toContain("7 * i");
    // Opening never runs: the output is still empty.
    await expect(output(student.page)).toHaveAttribute("data-empty", "true");
    await runAndWait(student.page, "Thành công");
    await expect(output(student.page)).toContainText("7 x 3 = 21");

    // And the save form never offers class sharing to a student.
    await student.page.getByRole("button", { name: "Kho Snippet" }).click();
    await snippetDrawer(student.page)
      .getByRole("button", { name: "Lưu vào Kho" })
      .click();
    const studentForm = student.page.getByRole("form", {
      name: "Lưu vào Kho Snippet",
    });
    await expect(studentForm.getByLabel("Cá nhân")).toBeChecked();
    await expect(studentForm.getByLabel("Chia sẻ cho lớp")).toHaveCount(0);
    expect(teacher.errors).toEqual([]);
    expect(student.errors).toEqual([]);
  } finally {
    await teacher.context.close();
    await student.context.close();
  }
});

test("ROOM-TOOLS-CODE-03 durable draft and Gửi bài cho GV: teachers see only shared work, read-only, until it is revoked", async ({
  browser,
}) => {
  const teacher = await mountClassroom(browser, "teacher");
  const student = await mountClassroom(browser, "student");
  try {
    await openCodeTool(student.page);
    await setCode(
      student.page,
      'print("Bai lam cua Minh Anh:", sum(range(5)))\n',
    );
    await expectSaved(student.page);
    expect(state.drafts.get("student")).toMatchObject({
      shared: false,
      version: 1,
    });

    // Before consent the teacher's list is empty.
    await openCodeTool(teacher.page);
    const workButton = teacher.page.getByRole("button", {
      name: "Bài học sinh (0)",
    });
    await expect(workButton).toBeVisible();
    await workButton.click();
    const drawer = workDrawer(teacher.page);
    await expect(drawer).toContainText("Chưa có học sinh nào gửi bài.");

    // The student opts in; the badge says the teacher can see it.
    const share = student.page.getByRole("button", { name: "Gửi bài cho GV" });
    await expect(share).toHaveAttribute("aria-pressed", "false");
    await share.click();
    const stop = student.page.getByRole("button", {
      name: "Đã gửi GV · Ngừng chia sẻ",
    });
    await expect(stop).toHaveAttribute("aria-pressed", "true");
    expect(state.drafts.get("student")?.shared).toBe(true);

    await drawer.getByRole("button", { name: "Làm mới" }).click();
    await drawer.getByRole("button", { name: /^Minh Anh/u }).click();
    const code = drawer.getByLabel("Tệp main.py của Minh Anh (chỉ đọc)");
    await expect(code).toContainText("Bai lam cua Minh Anh");
    await expect(drawer.locator("[contenteditable]")).toHaveCount(0);
    await drawer
      .getByRole("button", { name: "Mở bản sao vào Nháp của tôi" })
      .click();
    await expect(drawer).toHaveCount(0);
    expect(await editorText(teacher.page)).toContain("Bai lam cua Minh Anh");
    await runAndWait(teacher.page, "Thành công");
    await expect(output(teacher.page)).toContainText(
      "Bai lam cua Minh Anh: 10",
    );
    // The copy is the teacher's own draft, saved under the teacher.
    await expectSaved(teacher.page);
    expect(state.drafts.get("teacher")?.files[0]?.content).toContain(
      "Bai lam cua Minh Anh",
    );

    // Revoking consent: the work disappears and its id is concealed.
    await stop.click();
    await expect(
      student.page.getByRole("button", { name: "Gửi bài cho GV" }),
    ).toHaveAttribute("aria-pressed", "false");
    await teacher.page.getByRole("button", { name: /^Bài học sinh/u }).click();
    await workDrawer(teacher.page)
      .getByRole("button", { name: "Làm mới" })
      .click();
    await expect(workDrawer(teacher.page)).toContainText(
      "Chưa có học sinh nào gửi bài.",
    );
    const studentDraftID = state.drafts.get("student")?.id ?? "";
    const status = await teacher.page.evaluate(
      async ({ id, space, tenant }) =>
        (
          await fetch(
            `/api/v1/media/spaces/${space}/shared-scratchpads/${id}`,
            {
              headers: { "X-TutorHub-Expected-Tenant-ID": tenant },
            },
          )
        ).status,
      { id: studentDraftID, space: SPACE_ID, tenant: TENANT_ID },
    );
    expect(status).toBe(404);
    // A student never asks for anyone's shared work.
    expect(
      state.requests.student.some((entry) =>
        entry.includes("shared-scratchpads"),
      ),
    ).toBe(false);
    expect(teacher.errors).toEqual([]);
    expect(student.errors).toEqual([]);
  } finally {
    await teacher.context.close();
    await student.context.close();
  }
});

test("ROOM-TOOLS-CODE-03 exports and re-imports a .tutorhub-code.json project, refuses a tampered one, and colours code in chat", async ({
  browser,
}) => {
  const student = await mountClassroom(browser, "student");
  const { page } = student;
  try {
    await openCodeTool(page);
    const original = "# Bai 3\nfor n in range(3):\n    print('lap', n)\n";
    await setCode(page, original);
    await page.getByRole("button", { name: "Thao tác khác với mã" }).click();
    const downloadPromise = page.waitForEvent("download");
    await page
      .getByRole("menuitem", { name: "Xuất gói dự án (.json)" })
      .click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("main.tutorhub-code.json");
    const exported = await readFile(await download.path(), "utf8");
    expect(JSON.parse(exported)).toMatchObject({
      format: "tutorhub.code.workspace.v1",
      schemaVersion: 1,
    });

    const importInput = page.locator('[data-testid="code-project-import"]');
    const tampered = exported.replace("'lap'", "'lặp'");
    expect(tampered).not.toBe(exported);
    await setCode(page, "print('da doi')\n");
    await importInput.setInputFiles({
      buffer: Buffer.from(tampered, "utf8"),
      mimeType: "application/json",
      name: "bai3.tutorhub-code.json",
    });
    await expect(page.locator(".classroom-code__alert")).toContainText(
      "sai mã kiểm tra checksum",
    );
    expect(await editorText(page)).toBe("print('da doi')\n");

    await importInput.setInputFiles({
      buffer: Buffer.from(exported, "utf8"),
      mimeType: "application/json",
      name: "main.tutorhub-code.json",
    });
    await expect.poll(() => editorText(page)).toBe(original);
    await expect(output(page)).toHaveAttribute("data-empty", "true");

    // Send to chat: the card colours the code lazily with text-node spans.
    await page.getByRole("button", { name: "Thao tác khác với mã" }).click();
    await page.getByRole("menuitem", { name: "Gửi vào Trò chuyện" }).click();
    const chat = page.getByRole("dialog", { name: "Trò chuyện trong phòng" });
    await expect(chat).toBeVisible();
    await chat.getByRole("button", { exact: true, name: "Gửi" }).click();
    const card = chat.locator(".classroom-chat__code").last();
    const body = card.locator('code[data-highlighted="true"]');
    await expect(body).toBeVisible();
    await expect(body.locator('span[data-token="keyword"]').first()).toHaveText(
      "for",
    );
    await expect(body.locator('span[data-token="comment"]')).toHaveText(
      "# Bai 3",
    );
    expect(await body.textContent()).toBe(original.replace(/\n$/u, ""));
    expect(
      await body.evaluate((node) =>
        Array.from(node.querySelectorAll("*")).every(
          (element) =>
            element.tagName === "SPAN" &&
            Array.from(element.childNodes).every(
              (child) => child.nodeType === Node.TEXT_NODE,
            ),
        ),
      ),
    ).toBe(true);
    await expectNoViolations(page);
    expect(student.errors).toEqual([]);
  } finally {
    await student.context.close();
  }
});

test("ROOM-TOOLS-CODE-03 has no WCAG A/AA violations on the library, student work and the conflict bar, at 1440 px and 320 px with forced colours", async ({
  browser,
}) => {
  seedPersonalSnippet("teacher", "Mẫu của Thu Hà");
  seedSharedStudentDraft("print('bai da gui')\n");
  const teacher = await mountClassroom(browser, "teacher");
  try {
    const { page } = teacher;
    await openCodeTool(page);
    await page.getByRole("button", { name: "Kho Snippet" }).click();
    const drawer = snippetDrawer(page);
    await drawer.getByRole("tab", { name: "Của tôi" }).click();
    await expect(
      drawer.getByRole("heading", { name: "Mẫu của Thu Hà" }),
    ).toBeVisible();
    await expectNoViolations(page);
    await drawer.getByRole("button", { name: "Lưu vào Kho" }).click();
    await expect(
      page.getByRole("form", { name: "Lưu vào Kho Snippet" }),
    ).toBeVisible();
    await expectNoViolations(page);
    await page.keyboard.press("Escape");
    await expect(drawer.getByRole("tablist")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Kho Snippet" }),
    ).toBeFocused();

    await page.getByRole("button", { name: "Bài học sinh (1)" }).click();
    const work = workDrawer(page);
    await work.getByRole("button", { name: /^Minh Anh/u }).click();
    await expect(
      work.getByLabel("Tệp main.py của Minh Anh (chỉ đọc)"),
    ).toBeVisible();
    await expectNoViolations(page);
    await page.keyboard.press("Escape");
    await expect(work).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^Bài học sinh/u }),
    ).toBeFocused();
  } finally {
    await teacher.context.close();
  }

  // The student at 320 CSS px with forced colours: drawer and conflict bar.
  const student = await mountClassroom(browser, "student", {
    forcedColors: true,
    viewport: { height: 720, width: 320 },
  });
  try {
    const { page } = student;
    await openCodeTool(page);
    await setCode(page, "print('ban dau')\n");
    await expectSaved(page);
    // Another tab saves a newer version meanwhile.
    const draft = state.drafts.get("student");
    if (!draft) throw new Error("draft missing");
    draft.files = [
      {
        content: "print('tu tab khac')\n",
        language: "python",
        name: "main.py",
      },
    ];
    draft.version += 1;
    await setCode(page, "print('tab nay')\n");
    const bar = page.getByRole("group", {
      name: /Bản nháp đã được cập nhật từ tab\/thiết bị khác/u,
    });
    await expect(bar).toBeVisible({ timeout: 15_000 });
    expect(await editorText(page)).toBe("print('tab nay')\n");
    const fits = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(fits).toBe(true);
    await expectNoViolations(page);
    await bar.getByRole("button", { name: "Tải bản trên máy chủ" }).click();
    await expect.poll(() => editorText(page)).toBe("print('tu tab khac')\n");
    await expect(bar).toHaveCount(0);

    await page.getByRole("button", { name: "Kho Snippet" }).click();
    const drawer = snippetDrawer(page);
    await expect(drawer).toBeVisible();
    const box = await drawer.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    await expectNoViolations(page);
    expect(student.errors).toEqual([]);
  } finally {
    await student.context.close();
  }
});
