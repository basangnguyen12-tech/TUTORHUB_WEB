import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * ROOM-TOOLS-CODE-01 (ADR-0043): Classroom tools popover, Code workspace,
 * opaque-origin client sandbox and chat code cards, mounted over a simulated
 * LiveKit room from Vite source modules (no Core API, no provider).
 */
const fixturePath = "/__room-tools-code-01-fixture";
const APP_ORIGIN = "http://127.0.0.1:5173";

test.skip(
  process.env.E2E_MODE === "staging",
  "The deterministic Code tool fixture loads Vite source modules.",
);

interface FixtureOptions {
  language?: "en" | "vi";
  chatPaused?: boolean;
  role?: "host" | "student";
}

declare global {
  interface Window {
    __codeFixture?: {
      sent: () => string[];
      setCode: (code: string) => void;
      editorText: () => string;
      clearPrivateSessionCache: () => Promise<void>;
    };
  }
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
        "<title>ROOM-TOOLS-CODE-01 fixture</title>",
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

async function mountCodeFixture(page: Page, options: FixtureOptions = {}) {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installFixtureDocument(page);
  await installMediaProbe(page);
  await page.goto(fixturePath);
  await page.evaluate(async (fixtureOptions) => {
    const dynamicImport = new Function(
      "specifier",
      "return import(specifier)",
    ) as <Module>(specifier: string) => Promise<Module>;
    const source = (path: string) =>
      fetch(path).then((response) => {
        if (!response.ok) throw new Error(`Could not load ${path}.`);
        return response.text();
      });
    const shellPath = "/src/features/media/ClassroomMediaShell.tsx";
    const [shellSource, editorSource, sessionSource] = await Promise.all([
      source(shellPath),
      source("/src/features/classroom-tools/codeEditor.ts"),
      source("/src/app/session.tsx"),
    ]);
    const pick = (text: string, pattern: RegExp, label: string) => {
      const value = text.match(pattern)?.[1];
      if (!value) throw new Error(`Could not resolve ${label}.`);
      return value;
    };
    const reactPath = pick(
      shellSource,
      /from "([^"]*\/react\.js\?v=[^"]+)"/,
      "React",
    );
    const componentsPath = pick(
      shellSource,
      /from "([^"]*\/@livekit_components-react\.js\?v=[^"]+)"/,
      "LiveKit components",
    );
    const liveKitPath = pick(
      shellSource,
      /from "([^"]*\/livekit-client\.js\?v=[^"]+)"/,
      "LiveKit client",
    );
    const i18nPath = pick(
      shellSource,
      /from "([^"]*\/src\/app\/i18n\.tsx(?:\?t=[^"]+)?)"/,
      "i18n",
    );
    const iconsPath = pick(
      shellSource,
      /from "([^"]*\/lucide-react\.js\?v=[^"]+)"/,
      "icons",
    );
    const viewPath = pick(
      editorSource,
      /from "([^"]*\/@codemirror_view\.js\?v=[^"]+)"/,
      "CodeMirror view",
    );
    const queryPath = pick(
      sessionSource,
      /from "([^"]*\/@tanstack_react-query\.js\?v=[^"]+)"/,
      "React Query",
    );
    /* eslint-disable @typescript-eslint/no-explicit-any -- browser-side fixture modules are untyped */
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
      sessionModule,
    ] = await Promise.all([
      dynamicImport<any>(reactPath),
      dynamicImport<any>("/@id/react-dom/client"),
      dynamicImport<any>(componentsPath),
      dynamicImport<any>(liveKitPath),
      dynamicImport<any>(shellPath),
      dynamicImport<any>(i18nPath),
      dynamicImport<any>(iconsPath),
      dynamicImport<any>("/src/features/classroom-tools/ClassroomCodeTool.tsx"),
      dynamicImport<any>("/src/features/classroom-tools/codeSession.ts"),
      dynamicImport<any>("/src/features/media/ClassroomChatPanel.tsx"),
      dynamicImport<any>("/src/features/media/classroomChatMedia.ts"),
      dynamicImport<any>("/src/features/classroom-tools/toolActions.ts"),
      dynamicImport<any>(viewPath),
      dynamicImport<any>(queryPath),
      dynamicImport<any>("/src/app/session.tsx"),
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
      loggerName: "room-tools-code-01-fixture",
    });
    livekit
      .getLogger("room-tools-code-01-fixture")
      .setLevel(livekit.LogLevel.silent);
    await room.simulateParticipants({
      participants: { audio: false, count: 3, video: false },
      publish: { audio: true, useRealTracks: false, video: false },
    });

    const vietnamese = (fixtureOptions.language ?? "vi") === "vi";
    const teacher = { display_name: "Thu Hà", user_id: "teacher-0001" };
    const student = { display_name: "Minh Anh", user_id: "student-0002" };
    const viewer = fixtureOptions.role === "student" ? student : teacher;
    const conversationID = "20000000-0000-4000-8000-000000000001";
    let sequence = 0;
    const message = (
      author: { display_name: string; user_id: string },
      content: string,
    ) => {
      sequence += 1;
      const at = new Date(Date.now() - (10 - sequence) * 60_000).toISOString();
      return {
        attachments: [],
        author,
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
    const seeded = [
      message(
        teacher,
        [
          vietnamese ? "Cả lớp thử đoạn này nhé:" : "Try this one:",
          "```python",
          "print('xin chao tu chat')",
          "```",
        ].join("\n"),
      ),
    ];
    const sent: string[] = [];
    const composerStore = chatMedia.createClassroomChatComposerStore();
    const session = codeSession.createClassroomCodeSession();
    const scope = {
      actorID: viewer.user_id,
      mediaSpaceID: "40000000-0000-4000-8000-000000000001",
      tenantID: "50000000-0000-4000-8000-000000000001",
    };

    const ChatContent = ({
      canPost,
      messages,
      onSend,
      open,
    }: {
      canPost: boolean;
      messages: unknown[];
      onSend: (input: { content: string }) => Promise<void>;
      open: boolean;
    }) => {
      const actions = React.useContext(toolActions.ClassroomToolActionsContext);
      const onOpenInCode =
        actions && actions.hasTool("code")
          ? (block: { code: string; language: string | null }) => {
              session.push(block);
              actions.openTool("code");
            }
          : undefined;
      return h(chatPanel.ClassroomChatPanel, {
        actorID: viewer.user_id,
        composerStore,
        conversation: {
          created_at: new Date().toISOString(),
          id: conversationID,
          kind: "room",
          media_space_id: scope.mediaSpaceID,
          media_space_status: "open",
          participant_chat_enabled: !fixtureOptions.chatPaused,
          participants: [],
          title: "Lớp 10A1",
          unread_count: 0,
          unread_count_capped: false,
          updated_at: new Date().toISOString(),
          viewer_access: {
            can_moderate_chat: viewer === teacher,
            can_post_messages: canPost,
            can_upload_attachments: canPost,
          },
        },
        hasOlder: false,
        loadAttachment: async () => new Blob([]),
        loadingOlder: false,
        messages,
        onDelete: async () => undefined,
        onEdit: async () => undefined,
        onLoadOlder: () => undefined,
        onOpenInCode,
        onSend,
        onToggleParticipantChat: async () => undefined,
        onUpload: async () => {
          throw new Error("No uploads in the fixture.");
        },
        open,
        tenantID: scope.tenantID,
      });
    };

    let boardMounts = 0;
    const Board = () => {
      React.useEffect(() => {
        boardMounts += 1;
      }, []);
      return h("div", {
        className: "room-tools-fixture-board",
        "data-board-mounts": String(boardMounts),
        style: {
          flex: "1 1 auto",
          background:
            "repeating-linear-gradient(#ffffff 0 31px, #e5e7eb 31px 32px)",
        },
      });
    };

    const Room = () => {
      const [open, setOpen] = React.useState(false);
      const [messages, setMessages] = React.useState(seeded);
      const canPost = viewer === teacher || !fixtureOptions.chatPaused;
      const onSend = async (input: { content: string }) => {
        sent.push(input.content);
        setMessages((current: unknown[]) => [
          ...current,
          message(viewer, input.content),
        ]);
      };
      return h(shell.ClassroomMediaShell, {
        canPublishCameraMicrophone: true,
        canShareScreen: true,
        canSubscribe: true,
        chat: h(ChatContent, { canPost, messages, onSend, open }),
        connectionStatus: "connected",
        onChatOpenChange: setOpen,
        onLeave: () => undefined,
        onTerminalMediaCleanup: async () => undefined,
        roomTitle: "Lớp 10A1 · Tin học",
        tools: [
          {
            content: h(Board),
            icon: h(icons.PenTool),
            id: "whiteboard",
            label: vietnamese ? "Bảng trắng" : "Whiteboard",
            title: vietnamese ? "Bảng trắng lớp học" : "Classroom whiteboard",
          },
          {
            content: h(codeTool.ClassroomCodeTool, {
              ...scope,
              chatCanPost: canPost,
              enabled: true,
              onSendToChat: (text: string) =>
                chatMedia.prefillClassroomChatComposer(composerStore, text),
              session,
            }),
            icon: h(icons.CodeXml),
            id: "code",
            label: "Code",
            title: vietnamese ? "Công cụ Code" : "Code tool",
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
    window.__codeFixture = {
      clearPrivateSessionCache: () =>
        sessionModule.clearPrivateSessionCache(
          new query.QueryClient({
            defaultOptions: { queries: { retry: false } },
          }),
        ),
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
        { className: "media-p403-room media-p405-room", "data-theme": "dark" },
        h(
          i18n.I18nProvider,
          { initialLanguage: fixtureOptions.language ?? "vi" },
          h(components.RoomContext.Provider, { value: room }, h(Room)),
        ),
      ),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  }, options);
  await expect(page.locator(".media-p405-shell")).toBeVisible();
  return pageErrors;
}

const toolsKey = (page: Page) => page.locator("#media-p506-control-tools");

async function openCodeTool(page: Page) {
  await toolsKey(page).click();
  await page.locator("#media-p506-tool-option-code").click();
  await expect(page.locator("#media-p506-stage-code")).toBeVisible();
  await expect(page.locator(".classroom-code .cm-editor")).toBeVisible({
    timeout: 30_000,
  });
}

async function setCode(page: Page, code: string) {
  await page.evaluate((text) => window.__codeFixture?.setCode(text), code);
}

const runButton = (page: Page) => page.locator(".classroom-code-run");
const output = (page: Page) => page.locator(".classroom-code-output__pre");
const runStatus = (page: Page) =>
  page.locator(".classroom-code-output__status");

async function runAndWait(page: Page, status: string, timeout = 60_000) {
  await runButton(page).click();
  await expect(runStatus(page)).toContainText(status, { timeout });
  await expect(runButton(page)).not.toHaveAttribute("data-running", "true");
}

async function chooseLanguage(page: Page, label: string) {
  await page
    .getByRole("combobox", { name: "Ngôn ngữ" })
    .selectOption({ label });
}

async function tileIdentity(page: Page) {
  return page.evaluate(() => {
    const tiles = Array.from(document.querySelectorAll(".media-p405-tile"));
    tiles.forEach((tile, index) => {
      (tile as HTMLElement & { __marker?: number }).__marker = index + 1;
    });
    return tiles.length;
  });
}

async function tilesKept(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".media-p405-tile")).every(
      (tile, index) =>
        (tile as HTMLElement & { __marker?: number }).__marker === index + 1,
    ),
  );
}

test("ROOM-TOOLS-CODE-01 opens the Classroom tools grid with 2D keys and swaps Whiteboard ↔ Code without remounting media", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await mountCodeFixture(page);
  const key = toolsKey(page);
  await expect(key).toHaveAttribute("aria-haspopup", "dialog");
  await expect(key).toHaveAttribute("aria-expanded", "false");
  await expect(key).toHaveAccessibleName("Công cụ lớp học");
  const tiles = await tileIdentity(page);
  expect(tiles).toBeGreaterThan(0);

  await key.focus();
  await page.keyboard.press("Enter");
  const popover = page.getByRole("dialog", { name: "Công cụ lớp học" });
  await expect(popover).toBeVisible();
  await expect(key).toHaveAttribute("aria-expanded", "true");
  const board = page.locator("#media-p506-tool-option-whiteboard");
  const code = page.locator("#media-p506-tool-option-code");
  await expect(board).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(code).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(board).toBeFocused();
  await page.keyboard.press("End");
  await expect(code).toBeFocused();
  await page.keyboard.press("Home");
  await expect(board).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(board).toBeFocused();
  // The popover sits above the Dock, inside the viewport, caret on the key.
  const popoverBox = await popover.boundingBox();
  const keyBox = await key.boundingBox();
  expect(popoverBox && keyBox).toBeTruthy();
  expect(popoverBox!.y + popoverBox!.height).toBeLessThanOrEqual(keyBox!.y);
  expect(popoverBox!.x).toBeGreaterThanOrEqual(0);
  expect(popoverBox!.x + popoverBox!.width).toBeLessThanOrEqual(1440);
  await page.screenshot({
    path: ".tmp/room-tools-code-01/screenshots/01-tools-popover-vi-1440x900.png",
  });
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(key).toBeFocused();

  // Whiteboard first, then Code on the same stage.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(page.locator("#media-p506-stage-whiteboard")).toBeVisible();
  await expect(
    page.locator("#media-p506-stage-title-whiteboard"),
  ).toBeFocused();
  await expect(key).toHaveClass(/th-button--primary/);
  await openCodeTool(page);
  await expect(page.locator("#media-p506-stage-whiteboard")).toHaveCount(0);
  await expect(page.locator("#media-p506-stage-title-code")).toBeFocused();
  expect(await tilesKept(page)).toBe(true);
  // Code sits beside the 256px camera column.
  const stageBox = await page.locator(".media-p506-tool-stage").boundingBox();
  const cameraBox = await page
    .locator(".media-p405-classroom--tool-stage > .media-p405-stage")
    .boundingBox();
  expect(stageBox && cameraBox).toBeTruthy();
  expect(Math.round(cameraBox!.width)).toBe(256);
  expect(stageBox!.x + stageBox!.width).toBeLessThanOrEqual(cameraBox!.x);
  // Top Bar controls live beside Close.
  const header = page.locator("header.media-p405-header");
  await expect(
    header.getByRole("combobox", { name: "Ngôn ngữ" }),
  ).toBeVisible();
  await expect(header.locator(".classroom-code-run")).toBeVisible();
  await expect(header.locator("#media-p506-close-code")).toBeVisible();
  await page.screenshot({
    path: ".tmp/room-tools-code-01/screenshots/02-code-stage-vi-1440x900.png",
  });

  // Back to the whiteboard and to Code again: media never remounts.
  await key.click();
  await board.click();
  await expect(page.locator("#media-p506-stage-whiteboard")).toBeVisible();
  await openCodeTool(page);
  expect(await tilesKept(page)).toBe(true);
  // Choosing the open tool again closes it and returns focus to the key.
  await key.click();
  await expect(code).toHaveAttribute("aria-pressed", "true");
  await code.click();
  await expect(page.locator("#media-p506-stage-code")).toHaveCount(0);
  await expect(key).toBeFocused();
  await openCodeTool(page);
  await page.locator("#media-p506-close-code").click();
  await expect(key).toBeFocused();
  expect(await tilesKept(page)).toBe(true);
  expect(errors).toEqual([]);
});

test("ROOM-TOOLS-CODE-01 runs Python, JavaScript, TypeScript, SQL and the HTML preview in the sandbox", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await mountCodeFixture(page);
  await openCodeTool(page);

  // Python starter (first run downloads the self-hosted runtime).
  await runAndWait(page, "Thành công", 90_000);
  await expect(output(page)).toContainText("5² = 25");

  // Python reads the Stdin tab.
  await setCode(
    page,
    "name = input()\ntotal = sum(int(x) for x in input().split())\nprint('Xin chào', name, total)\n",
  );
  await page.getByRole("tab", { name: "Đầu vào (Stdin)" }).click();
  await page.locator(".classroom-code-stdin").fill("Minh Anh\n4 5 6\n");
  await runAndWait(page, "Thành công");
  await expect(output(page)).toContainText("Xin chào Minh Anh 15");
  await page.screenshot({
    path: ".tmp/room-tools-code-01/screenshots/03-python-run-vi.png",
  });

  // An error is reported on stderr with the user's line.
  await setCode(page, "print('ok')\nprint(1 / 0)\n");
  await runAndWait(page, "Lỗi");
  await expect(output(page).locator('[data-stream="stderr"]')).toContainText(
    "ZeroDivisionError",
  );

  // JavaScript: the unedited starter converts in place.
  await setCode(page, "");
  await chooseLanguage(page, "JavaScript");
  await expect(page.locator(".classroom-code-file[data-active]")).toContainText(
    "main.js",
  );
  await runAndWait(page, "Thành công");
  await expect(output(page)).toContainText("Điểm trung bình:");
  await setCode(
    page,
    "const name = input();\nconsole.log(`Hi ${name}`, [1, 2, 3], { a: 1 });\nsetTimeout(() => console.log('later'), 50);\n",
  );
  await runAndWait(page, "Thành công");
  await expect(output(page)).toContainText("Hi Minh Anh [ 1, 2, 3 ] { a: 1 }");
  await expect(output(page)).toContainText("later");

  // TypeScript is transpiled in the parent (types only) and run sandboxed.
  await setCode(page, "");
  await chooseLanguage(page, "TypeScript");
  await runAndWait(page, "Thành công");
  await expect(output(page)).toContainText("Cao nhất: An (9)");

  // SQL renders a bounded result table.
  await setCode(page, "");
  await chooseLanguage(page, "SQL");
  await runAndWait(page, "Thành công", 60_000);
  const table = page.locator(".classroom-code-sql table");
  await expect(table.locator("th")).toHaveText(["name", "score"]);
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.locator("tbody tr").first()).toContainText("An");
  await page.screenshot({
    path: ".tmp/room-tools-code-01/screenshots/04-sql-table-vi.png",
  });

  // HTML / CSS / JS: Run opens the sandboxed preview.
  await setCode(page, "");
  await chooseLanguage(page, "HTML / CSS / JS");
  await runButton(page).click();
  await expect(page.getByRole("tab", { name: "Xem trước" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const frameElement = page.locator(".classroom-code-preview__frame");
  await expect(frameElement).toHaveAttribute("sandbox", "allow-scripts");
  const preview = page.frameLocator(".classroom-code-preview__frame");
  await expect(preview.locator("h1")).toHaveText("Xin chào!");
  await preview.locator("#count").click();
  await preview.locator("#count").click();
  await expect(preview.locator("#result")).toHaveText("2");
  await page.screenshot({
    path: ".tmp/room-tools-code-01/screenshots/05-html-preview-vi.png",
  });
  await page.getByRole("button", { name: "Dừng xem trước" }).click();
  await expect(frameElement).toHaveCount(0);

  // C / C++ / Java: honest Slice 4 notice, nothing runs.
  await setCode(page, "");
  await chooseLanguage(page, "C++");
  await runButton(page).click();
  await expect(page.locator(".classroom-code-output__notice")).toContainText(
    "Biên dịch trên máy chủ cô lập",
  );
  expect(errors).toEqual([]);
});

test("ROOM-TOOLS-CODE-01 cuts infinite loops within 5 s and runs again at once", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await mountCodeFixture(page);
  await openCodeTool(page);
  await chooseLanguage(page, "JavaScript");

  await setCode(page, "while (true) {}\n");
  const started = Date.now();
  await runButton(page).click();
  await expect(runButton(page)).toHaveAttribute("data-running", "true");
  // The classroom stays responsive while the loop spins in the sandbox.
  await expect(toolsKey(page)).toBeEnabled();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(resolve)),
  );
  await expect(runStatus(page)).toContainText("Quá thời gian 5s", {
    timeout: 8_000,
  });
  expect(Date.now() - started).toBeLessThan(7_500);
  await setCode(page, "console.log('again');\n");
  await runAndWait(page, "Thành công", 15_000);
  await expect(output(page)).toContainText("again");

  // Python's busy loop is cut too, and Python starts clean afterwards.
  await setCode(page, "");
  await chooseLanguage(page, "Python");
  await runAndWait(page, "Thành công", 90_000);
  await setCode(page, "while True:\n    pass\n");
  await runAndWait(page, "Quá thời gian 5s", 15_000);
  await setCode(page, "print('python again')\n");
  await runAndWait(page, "Thành công", 60_000);
  await expect(output(page)).toContainText("python again");

  // Runaway output is bounded at 64 KB.
  await chooseLanguage(page, "JavaScript");
  await setCode(page, "for (;;) console.log('x'.repeat(200));\n");
  await runAndWait(page, "Đã cắt ở 64 KB", 15_000);
  expect(errors).toEqual([]);
});

test("ROOM-TOOLS-CODE-01 keeps sandboxed code away from the API, cookies and the parent page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let apiHits = 0;
  await page.route("**/api/v1/**", async (route) => {
    apiHits += 1;
    await route.fulfill({ body: '{"email":"leak@example.com"}', status: 200 });
  });
  const errors = await mountCodeFixture(page);
  await page.evaluate(() => {
    document.cookie = "tutorhub_probe=parent-secret; path=/";
  });
  await openCodeTool(page);
  await chooseLanguage(page, "JavaScript");
  await setCode(
    page,
    [
      "const results = [];",
      "const attempt = async (label, action) => {",
      "  try { await action(); results.push(label + ':ALLOWED'); }",
      "  catch (error) { results.push(label + ':blocked'); }",
      "};",
      "await attempt('fetch-relative', () => fetch('/api/v1/auth/me'));",
      `await attempt('fetch-absolute', () => fetch('${APP_ORIGIN}/api/v1/auth/me', { credentials: 'include' }));`,
      `await attempt('xhr', () => { const x = new XMLHttpRequest(); x.open('GET', '${APP_ORIGIN}/api/v1/auth/me', false); x.send(); });`,
      `await attempt('import', () => import('${APP_ORIGIN}/src/app/session.tsx'));`,
      "results.push('cookie:' + (typeof document === 'undefined' ? 'none' : document.cookie));",
      "results.push('parent:' + (typeof window === 'undefined' ? 'none' : 'window'));",
      "results.push('origin:' + self.origin);",
      "console.log(results.join('\\n'));",
    ].join("\n"),
  );
  await runAndWait(page, "Thành công", 20_000);
  const text = await output(page).innerText();
  expect(text).toContain("fetch-relative:blocked");
  expect(text).toContain("fetch-absolute:blocked");
  expect(text).toContain("xhr:blocked");
  expect(text).toContain("import:blocked");
  expect(text).toContain("cookie:none");
  expect(text).toContain("parent:none");
  expect(text).toContain("origin:null");
  expect(text).not.toContain("ALLOWED");

  // Python's JavaScript bridge reaches the same locked-down worker.
  await chooseLanguage(page, "Python");
  await setCode(
    page,
    [
      "import js",
      `pending = js.fetch('${APP_ORIGIN}/api/v1/auth/me')`,
      "print('has-document:', hasattr(js, 'document'))",
    ].join("\n"),
  );
  await runAndWait(page, "Thành công", 90_000);
  await expect(output(page)).toContainText("has-document: False");

  // The HTML preview: an opaque origin with no network, cookie or parent DOM.
  await chooseLanguage(page, "HTML / CSS / JS");
  await setCode(
    page,
    [
      "<p id='out'>pending</p>",
      "<script>",
      "(async () => {",
      "  const results = [];",
      `  try { await fetch('${APP_ORIGIN}/api/v1/auth/me'); results.push('fetch:ALLOWED'); } catch (e) { results.push('fetch:blocked'); }`,
      "  try { results.push('cookie:' + document.cookie); } catch (e) { results.push('cookie:blocked'); }",
      "  try { results.push('parent:' + window.parent.document.title); } catch (e) { results.push('parent:blocked'); }",
      "  try { localStorage.setItem('x', '1'); results.push('storage:ALLOWED'); } catch (e) { results.push('storage:blocked'); }",
      "  document.getElementById('out').textContent = results.join(' ') + ' origin:' + window.origin;",
      "})();",
      "</script>",
    ].join("\n"),
  );
  await runButton(page).click();
  const preview = page.frameLocator(".classroom-code-preview__frame");
  await expect(preview.locator("#out")).toHaveText(
    "fetch:blocked cookie:blocked parent:blocked storage:blocked origin:null",
    { timeout: 15_000 },
  );

  // A runner frame exists only as the locked sandbox.
  const runner = page.locator(".classroom-code-sandbox-frame");
  await expect(runner).toHaveAttribute("sandbox", "allow-scripts");
  await expect(runner).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(runner).toHaveAttribute("allow", "");
  expect(await runner.getAttribute("srcdoc")).toContain("connect-src 'none'");
  expect(apiHits).toBe(0);
  expect(errors).toEqual([]);
});

test("ROOM-TOOLS-CODE-01 sends code to chat for review and opens a chat code card in Code without running it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await mountCodeFixture(page);
  await openCodeTool(page);
  await setCode(page, "print('gui vao tro chuyen')\n");

  await page.getByRole("button", { name: "Thao tác khác với mã" }).click();
  await page.getByRole("menuitem", { name: "Gửi vào Trò chuyện" }).click();
  const drawer = page.getByRole("dialog", { name: "Trò chuyện trong phòng" });
  await expect(drawer).toBeVisible();
  const composer = drawer.locator("textarea.classroom-chat__input");
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue(
    "```python\nprint('gui vao tro chuyen')\n```",
  );
  // Nothing is sent until the person presses Send.
  expect(await page.evaluate(() => window.__codeFixture?.sent())).toEqual([]);
  await drawer.getByRole("button", { exact: true, name: "Gửi" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__codeFixture?.sent().length))
    .toBe(1);
  const cards = drawer.locator(".classroom-chat__code");
  await expect(cards).toHaveCount(2);
  await expect(cards.last()).toContainText("print('gui vao tro chuyen')");
  await expect
    .poll(async () => {
      const closeBox = await page
        .locator("#media-p506-close-code")
        .boundingBox();
      const drawerBox = await drawer.boundingBox();
      if (!closeBox || !drawerBox) return false;
      return closeBox.x + closeBox.width <= drawerBox.x;
    })
    .toBe(true);
  await page.screenshot({
    path: ".tmp/room-tools-code-01/screenshots/06-chat-code-cards-vi.png",
  });

  // The teacher's card opens as a new tab; nothing runs.
  const frameCount = await page
    .locator(".classroom-code-sandbox-frame")
    .count();
  await cards.first().getByRole("button", { name: "Mở trong Code" }).click();
  await expect(page.locator(".classroom-code-file[data-active]")).toContainText(
    "chat-main.py",
  );
  await expect
    .poll(() => page.evaluate(() => window.__codeFixture?.editorText()))
    .toBe("print('xin chao tu chat')");
  await expect(runStatus(page)).toHaveText("");
  await expect(output(page)).toContainText("Nhấn ▶ Chạy");
  expect(await page.locator(".classroom-code-sandbox-frame").count()).toBe(
    frameCount,
  );
  expect(errors).toEqual([]);
});

test("ROOM-TOOLS-CODE-01 respects a paused chat for students", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await mountCodeFixture(page, {
    chatPaused: true,
    role: "student",
  });
  await openCodeTool(page);
  await page.getByRole("button", { name: "Thao tác khác với mã" }).click();
  await page.getByRole("menuitem", { name: "Gửi vào Trò chuyện" }).click();
  await expect(page.locator(".classroom-code__alert")).toContainText(
    "Trò chuyện đang tạm khóa",
  );
  await expect(
    page.getByRole("dialog", { name: "Trò chuyện trong phòng" }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("ROOM-TOOLS-CODE-01 restores the bounded draft after reload and wipes it on sign-out", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mountCodeFixture(page);
  await openCodeTool(page);
  await setCode(page, "print('ban nhap 42')\n");
  await page.locator(".classroom-code-file__add").click();
  await page.getByRole("menuitem", { name: "Tệp SQL" }).click();
  await expect(page.locator(".classroom-code-file")).toHaveCount(2);
  await expect(page.locator(".classroom-code__usage")).toContainText(
    "Đã lưu nháp",
    { timeout: 5_000 },
  );
  const keys = await page.evaluate(() =>
    Object.keys(localStorage).filter((key) =>
      key.startsWith("tutorhub:code-draft:v1:"),
    ),
  );
  expect(keys).toHaveLength(1);

  await page.reload();
  await mountCodeFixture(page);
  await openCodeTool(page);
  await expect(page.locator(".classroom-code-file")).toHaveCount(2);
  await expect(page.locator(".classroom-code-file[data-active]")).toContainText(
    "query.sql",
  );
  await page
    .locator(".classroom-code-file__name", { hasText: "main.py" })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.__codeFixture?.editorText()))
    .toBe("print('ban nhap 42')\n");

  await page.evaluate(() => window.__codeFixture?.clearPrivateSessionCache());
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) =>
        key.startsWith("tutorhub:code-draft:"),
      ),
    ),
  ).toEqual([]);
});

test("ROOM-TOOLS-CODE-01 never traps Tab in the editor (WCAG 2.1.2)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mountCodeFixture(page);
  await openCodeTool(page);
  await setCode(page, "x = 1\n");
  const content = page.locator(".classroom-code .cm-content");
  const inEditor = () =>
    page.evaluate(() =>
      Boolean(document.activeElement?.closest(".classroom-code .cm-editor")),
    );
  await content.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Tab");
  expect(await inEditor()).toBe(true);
  expect(await page.evaluate(() => window.__codeFixture?.editorText())).toBe(
    "x = 1\n    ",
  );

  // Escape then Tab leaves the editor.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  expect(await inEditor()).toBe(false);

  // Ctrl+M toggles a persistent "Tab moves focus" mode.
  await content.click();
  await page.keyboard.press("Control+m");
  await expect(page.locator(".classroom-code__help-state")).toHaveText(
    "Tab di chuyển focus: Bật",
  );
  await page.keyboard.press("Tab");
  expect(await inEditor()).toBe(false);
  await content.click();
  await page.keyboard.press("Control+m");
  await expect(page.locator(".classroom-code__help-state")).toHaveText(
    "Tab di chuyển focus: Tắt",
  );

  // With the search panel open, Escape first closes it, then Escape + Tab exits.
  await content.click();
  await page.keyboard.press("Control+f");
  const search = page.locator(".classroom-code .cm-search input").first();
  await expect(search).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".classroom-code .cm-search")).toHaveCount(0);
  expect(await inEditor()).toBe(true);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  expect(await inEditor()).toBe(false);

  // Ctrl+Enter runs from the editor.
  await content.click();
  await page.keyboard.press("Control+Enter");
  await expect(runStatus(page)).toContainText("Thành công", {
    timeout: 90_000,
  });
});

test("ROOM-TOOLS-CODE-01 snippet library inserts a template as a new file", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mountCodeFixture(page);
  await openCodeTool(page);
  await page.locator(".classroom-code-files__snippets").click();
  const library = page.locator(".classroom-code-snippets");
  await expect(library).toBeVisible();
  await expect(library.getByRole("searchbox")).toBeFocused();
  await library.getByRole("searchbox").fill("dijkstra");
  await expect(library.locator(".classroom-code-snippet")).toHaveCount(1);
  await page.screenshot({
    path: ".tmp/room-tools-code-01/screenshots/07-snippet-library-vi.png",
  });
  await library.getByRole("button", { name: "Chèn thành tệp mới" }).click();
  await expect(library).toHaveCount(0);
  await expect(page.locator(".classroom-code-file[data-active]")).toContainText(
    "dijkstra.py",
  );
  await runAndWait(page, "Thành công", 90_000);
  await expect(output(page)).toContainText("F 20");
});

async function expectNoViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
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

test("ROOM-TOOLS-CODE-01 has no Axe violations on desktop with the popover, Code, output and library", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mountCodeFixture(page);
  await toolsKey(page).click();
  await expect(
    page.getByRole("dialog", { name: "Công cụ lớp học" }),
  ).toBeVisible();
  await expectNoViolations(page);
  await page.keyboard.press("Escape");
  await openCodeTool(page);
  await runAndWait(page, "Thành công", 90_000);
  await expectNoViolations(page);
  await page.locator(".classroom-code-files__snippets").click();
  await expect(page.locator(".classroom-code-snippets")).toBeVisible();
  await expectNoViolations(page);
});

test("ROOM-TOOLS-CODE-01 reflows at 320 CSS pixels with forced colors and reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 720 });
  await mountCodeFixture(page);
  await toolsKey(page).click();
  const popover = page.getByRole("dialog", { name: "Công cụ lớp học" });
  await expect(popover).toBeVisible();
  const box = await popover.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  expect(
    await popover.evaluate((node) => getComputedStyle(node).animationName),
  ).toBe("none");
  await page.screenshot({
    path: ".tmp/room-tools-code-01/screenshots/08-tools-popover-320-forced-colors.png",
  });
  await page.keyboard.press("Escape");
  await openCodeTool(page);
  // Editor and Output become two views.
  const views = page.getByRole("group", { name: "Chế độ xem" });
  await expect(views).toBeVisible();
  await expect(views.getByRole("button", { name: "Mã" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await runAndWait(page, "Thành công", 90_000);
  await expect(views.getByRole("button", { name: "Kết quả" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(output(page)).toContainText("5² = 25");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".tmp/room-tools-code-01/screenshots/09-code-320-forced-colors.png",
  });
  await expectNoViolations(page);
});
