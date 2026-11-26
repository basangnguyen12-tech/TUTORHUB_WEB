import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { createHash } from "node:crypto";

/**
 * ROOM-TOOLS-FILES-01B (ADR-0045 Slice 1B): the classroom Documents tool —
 * room library upload → verifier → view capability → in-memory bytes →
 * virtualized pdf.js viewer (≤ 5 / ≤ 2 live canvases), zero-scripting link
 * policy, and "Đưa vùng sang Bảng trắng" into a real Excalidraw canvas over
 * a local canonical authority. Mounted over a simulated LiveKit room from
 * Vite source modules; the Core API and object storage are page routes on
 * 127.0.0.1, so nothing ever leaves this machine.
 */
const fixturePath = "/__room-tools-files-01-fixture";
const APP_ORIGIN = "http://127.0.0.1:5173";
const SPACE_ID = "40000000-0000-4000-8000-000000000001";
const TENANT_ID = "50000000-0000-4000-8000-000000000001";

test.skip(
  process.env.E2E_MODE === "staging",
  "The deterministic Documents fixture loads Vite source modules.",
);

// ---- PDF fixtures (built in the test, no binary in Git) -----------------

interface FixturePage {
  readonly annots?: readonly string[];
  readonly lines: readonly string[];
}

function pdfString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function buildPdf(pages: readonly FixturePage[], catalogExtra = ""): Buffer {
  const bodies = new Map<number, string>();
  const pageRefs: number[] = [];
  let next = 4;
  for (const page of pages) {
    const pageNumber = next++;
    const contentNumber = next++;
    const annotNumbers = (page.annots ?? []).map(() => next++);
    pageRefs.push(pageNumber);
    const content = [
      "0.93 0.96 1 rg 48 560 499 240 re f",
      "0.2 0.3 0.6 RG 3 w 48 560 499 240 re S",
      "0 0 0 rg",
      ...page.lines.map(
        (line, index) =>
          `BT /F1 ${index === 0 ? 30 : 18} Tf 72 ${740 - index * 40} Td (${pdfString(line)}) Tj ET`,
      ),
    ].join("\n");
    bodies.set(
      contentNumber,
      `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    );
    page.annots?.forEach((annot, index) => {
      bodies.set(annotNumbers[index]!, annot);
    });
    bodies.set(
      pageNumber,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNumber} 0 R${
        annotNumbers.length > 0
          ? ` /Annots [${annotNumbers.map((n) => `${n} 0 R`).join(" ")}]`
          : ""
      } >>`,
    );
  }
  bodies.set(1, `<< /Type /Catalog /Pages 2 0 R ${catalogExtra}>>`);
  bodies.set(
    2,
    `<< /Type /Pages /Kids [${pageRefs.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageRefs.length} >>`,
  );
  bodies.set(
    3,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );
  let output = "%PDF-1.7\n%âãÏÓ\n";
  const offsets: number[] = [0];
  for (let number = 1; number < next; number += 1) {
    offsets[number] = Buffer.byteLength(output, "latin1");
    output += `${number} 0 obj\n${bodies.get(number) ?? "null"}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output, "latin1");
  output += `xref\n0 ${next}\n0000000000 65535 f \n`;
  for (let number = 1; number < next; number += 1) {
    output += `${String(offsets[number]).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${next} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, "latin1");
}

function linkAnnot(rect: string, action: string): string {
  return `<< /Type /Annot /Subtype /Link /Rect [${rect}] /Border [0 0 0] /A ${action} >>`;
}

const LONG_PDF = buildPdf(
  Array.from({ length: 150 }, (_, index) => ({
    lines: [
      `Trang ${index + 1}`,
      index === 74 ? "Bai tap phuong trinh bac hai" : "On tap chuong",
      "x^2 - 5x + 6 = 0",
    ],
  })),
);

const SHORT_PDF = buildPdf([
  {
    lines: [
      "De kiem tra",
      "Cau 1. Giai phuong trinh 2x + 3 = 7",
      "Cau 2. Tinh dien tich hinh tron r = 3",
    ],
  },
  { lines: ["Trang 2", "Cau 3. Rut gon bieu thuc"] },
  { lines: ["Trang 3", "Dap an"] },
]);

const MALICIOUS_PDF = buildPdf(
  [
    {
      annots: [
        linkAnnot(
          "72 690 400 720",
          "<< /S /URI /URI (javascript:alert\\(1\\)) >>",
        ),
        linkAnnot(
          "72 650 400 680",
          "<< /S /URI /URI (data:text/html,<script>alert\\(1\\)</script>) >>",
        ),
        linkAnnot(
          "72 610 400 640",
          "<< /S /URI /URI (http://insecure.example) >>",
        ),
        linkAnnot(
          "72 570 400 600",
          "<< /S /URI /URI (https://safe.example.org/bai-tap) >>",
        ),
        linkAnnot(
          "72 530 400 560",
          "<< /S /JavaScript /JS (app.alert\\(3\\)) >>",
        ),
      ],
      lines: [
        "Tai lieu doc hai",
        "javascript link",
        "data link",
        "http link",
        "https link",
        "JavaScript action",
      ],
    },
  ],
  "/OpenAction << /S /JavaScript /JS (app.alert\\(1\\); this.print\\(\\);) >> /AA << /WC << /S /JavaScript /JS (app.alert\\(2\\)) >> >> ",
);

// ---- Fake Core API + object storage on 127.0.0.1 ------------------------

interface StoredDocument {
  activeContent: boolean;
  bytes: Buffer;
  id: string;
  name: string;
  pages: number;
  readyAfterLists: number;
  type: string;
  version: number;
}

interface FakeServer {
  documents: StoredDocument[];
  externalRequests: string[];
  uploads: { name: string; scope: string; size: number }[];
}

function documentJSON(document: StoredDocument, listCount: number) {
  const ready = listCount >= document.readyAfterLists;
  return {
    active_content: ready && document.activeContent,
    allow_student_download: true,
    class_id: null,
    created_at: "2030-08-08T01:00:00Z",
    declared_media_type: document.type,
    display_name: document.name,
    expected_size_bytes: document.bytes.byteLength,
    expires_at: null,
    first_page_aspect: ready ? 595 / 842 : null,
    id: document.id,
    media_space_id: SPACE_ID,
    owner_kind: "media_space",
    page_count: ready ? document.pages : null,
    rejection_reason: null,
    status: ready ? "ready" : "processing",
    updated_at: "2030-08-08T01:00:00Z",
    uploaded_by_viewer: true,
    version: document.version,
    viewer_access: {
      can_download_original: true,
      can_manage: true,
      can_retry_upload: false,
      can_view: ready,
    },
  };
}

async function installFakeServer(
  page: Page,
  documents: StoredDocument[] = [],
): Promise<FakeServer> {
  const server: FakeServer = { documents, externalRequests: [], uploads: [] };
  let lists = 0;
  const pending = new Map<
    string,
    { name: string; size: number; type: string }
  >();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      (url.protocol === "http:" ||
        url.protocol === "https:" ||
        url.protocol === "ws:" ||
        url.protocol === "wss:") &&
      url.hostname !== "127.0.0.1"
    ) {
      server.externalRequests.push(request.url());
    }
  });
  // Belt and braces: nothing may leave 127.0.0.1 even if something tried.
  await page.route(/^(?!http:\/\/127\.0\.0\.1:5173\/).*/, (route) => {
    const url = route.request().url();
    return url.startsWith("data:") || url.startsWith("blob:")
      ? route.continue()
      : route.abort();
  });
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      body: JSON.stringify(body),
      contentType: "application/json",
      headers: { "Cache-Control": "no-store" },
      status,
    });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^.*?\/api\/v1\//, "/");
    const method = request.method();
    if (path === "/auth/csrf")
      return json(route, { csrf_token: "csrf-fixture" });
    if (path === `/media/spaces/${SPACE_ID}/documents` && method === "GET") {
      lists += 1;
      return json(route, {
        items: server.documents.map((document) =>
          documentJSON(document, lists),
        ),
        next_cursor: null,
        viewer_access: {
          can_manage: true,
          can_present: true,
          can_upload: true,
          can_upload_to_class: false,
        },
      });
    }
    if (path === `/media/spaces/${SPACE_ID}/documents/upload-intents`) {
      const body = request.postDataJSON() as {
        declared_media_type: string;
        display_name: string;
        expected_size_bytes: number;
        scope: string;
      };
      const id = `60000000-0000-4000-8000-${String(server.documents.length + pending.size + 1).padStart(12, "0")}`;
      pending.set(id, {
        name: body.display_name,
        size: body.expected_size_bytes,
        type: body.declared_media_type,
      });
      server.uploads.push({
        name: body.display_name,
        scope: body.scope,
        size: body.expected_size_bytes,
      });
      return json(route, {
        created_at: "2030-08-08T01:00:00Z",
        declared_media_type: body.declared_media_type,
        display_name: body.display_name,
        expected_size_bytes: body.expected_size_bytes,
        id,
        status: "pending",
        updated_at: "2030-08-08T01:00:00Z",
        version: 1,
        viewer_access: { can_download: false, can_retry_upload: true },
      });
    }
    const upload = path.match(/^\/files\/([^/]+)\/upload-capability$/);
    if (upload) {
      return json(route, {
        content_length_bytes: pending.get(upload[1]!)?.size ?? 0,
        expires_at: "2030-08-08T01:05:00Z",
        method: "PUT",
        required_headers: {},
        url: `${APP_ORIGIN}/__storage/${upload[1]}`,
      });
    }
    const finalize = path.match(/^\/files\/([^/]+)\/finalize$/);
    if (finalize) {
      return json(route, { id: finalize[1], status: "processing", version: 2 });
    }
    const view = path.match(
      /^\/media\/spaces\/[^/]+\/documents\/([^/]+)\/view-capabilities$/,
    );
    if (view) {
      const document = server.documents.find((item) => item.id === view[1]);
      if (!document) return json(route, { title: "Not found" }, 404);
      return json(route, {
        active_content: document.activeContent,
        content_length_bytes: document.bytes.byteLength,
        expires_at: "2030-08-08T01:05:00Z",
        first_page_aspect: 595 / 842,
        media_type: document.type,
        method: "GET",
        page_count: document.pages,
        sha256: createHash("sha256").update(document.bytes).digest("hex"),
        url: `${APP_ORIGIN}/__storage/${document.id}?X-Amz-Signature=fixture`,
        version_id: `v${document.version}`,
      });
    }
    return json(route, { title: "Not handled by the fixture" }, 404);
  });
  const uploaded = new Map<string, Buffer>();
  await page.route("**/__storage/**", async (route) => {
    const request = route.request();
    const id = new URL(request.url()).pathname.split("/").pop() ?? "";
    if (request.method() === "PUT") {
      const body = request.postDataBuffer() ?? Buffer.alloc(0);
      uploaded.set(id, body);
      const meta = pending.get(id);
      if (meta) {
        server.documents.push({
          activeContent: false,
          bytes: body,
          id,
          name: meta.name,
          pages: 150,
          readyAfterLists: lists + 2,
          type: meta.type,
          version: 2,
        });
        pending.delete(id);
      }
      return route.fulfill({
        headers: {
          "Access-Control-Expose-Headers": "x-amz-version-id, etag",
          etag: '"etag-fixture"',
          "x-amz-version-id": "v2",
        },
        status: 200,
      });
    }
    const document = server.documents.find((item) => item.id === id);
    if (!document) return route.fulfill({ status: 404 });
    return route.fulfill({
      body: document.bytes,
      contentType: document.type,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
      status: 200,
    });
  });
  return server;
}

// ---- Fixture page ------------------------------------------------------

declare global {
  interface Window {
    __filesFixture?: {
      liveCanvases: () => number;
      maxLiveCanvases: () => number;
      opened: () => { features: string; url: string }[];
      resetMax: () => void;
      scene: () => {
        elements: Record<string, unknown>[];
        files: Record<string, { dataURL?: string; mimeType?: string }>;
      };
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
        "<title>ROOM-TOOLS-FILES-01 fixture</title>",
        '<script type="module">',
        "import RefreshRuntime from '/@react-refresh';",
        "RefreshRuntime.injectIntoGlobalHook(window);",
        "window.$RefreshReg$ = () => {};",
        "window.$RefreshSig$ = () => (type) => type;",
        "window.__vite_plugin_react_preamble_installed__ = true;",
        "</script>",
        "</head>",
        '<body><div id="files-fixture-root"></div></body>',
        "</html>",
      ].join(""),
      contentType: "text/html",
      headers: { "Cache-Control": "no-store" },
      status: 200,
    });
  });
}

async function installProbes(page: Page) {
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
    const opened: { features: string; url: string }[] = [];
    (window as unknown as { __opened: typeof opened }).__opened = opened;
    window.open = ((
      url?: string | URL,
      _target?: string,
      features?: string,
    ) => {
      opened.push({ features: features ?? "", url: String(url ?? "") });
      return null;
    }) as typeof window.open;
    // Live page canvases holding pixels, sampled every frame.
    let max = 0;
    const count = () =>
      Array.from(
        document.querySelectorAll<HTMLCanvasElement>("canvas[data-pdf-page]"),
      ).filter((canvas) => canvas.width > 0 && canvas.height > 0).length;
    const sample = () => {
      max = Math.max(max, count());
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    (window as unknown as Record<string, unknown>).__canvasProbe = {
      count,
      max: () => max,
      reset: () => {
        max = count();
      },
    };
  });
}

async function mountFilesFixture(
  page: Page,
  options: { language?: "en" | "vi" } = {},
) {
  const pageErrors: string[] = [];
  const dialogs: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await installFixtureDocument(page);
  await installProbes(page);
  await page.goto(fixturePath);
  await page.evaluate(
    async ({ fixtureOptions, spaceID, tenantID }) => {
      const dynamicImport = new Function(
        "specifier",
        "return import(specifier)",
      ) as <Module>(specifier: string) => Promise<Module>;
      const source = (path: string) =>
        fetch(path).then((response) => {
          if (!response.ok) throw new Error(`Could not load ${path}.`);
          return response.text();
        });
      const pick = (text: string, pattern: RegExp, label: string) => {
        const value = text.match(pattern)?.[1];
        if (!value) throw new Error(`Could not resolve ${label}.`);
        return value;
      };
      const shellPath = "/src/features/media/ClassroomMediaShell.tsx";
      const enginePath = "/src/features/collaboration/LazyWhiteboardEngine.tsx";
      const [shellSource, sessionSource, engineSource] = await Promise.all([
        source(shellPath),
        source("/src/app/session.tsx"),
        source(enginePath),
      ]);
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
      const queryPath = pick(
        sessionSource,
        /from "([^"]*\/@tanstack_react-query\.js\?v=[^"]+)"/,
        "React Query",
      );
      const collaborationPath = pick(
        engineSource,
        /from "([^"]*collaboration-client[^"]*)"/,
        "collaboration client",
      );
      const authorityPath = collaborationPath.replace(
        /index\.ts(\?.*)?$/,
        "canonicalAuthority.ts",
      );
      const authoritySource = await source(authorityPath);
      const yjsPath = pick(
        authoritySource,
        /from "([^"]*\/yjs\.js\?v=[^"]+)"/,
        "Yjs",
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
        query,
        collaboration,
        Y,
        engine,
        filesTool,
        filesSession,
        bridgeModule,
      ] = await Promise.all([
        dynamicImport<any>(reactPath),
        dynamicImport<any>("/@id/react-dom/client"),
        dynamicImport<any>(componentsPath),
        dynamicImport<any>(liveKitPath),
        dynamicImport<any>(shellPath),
        dynamicImport<any>(i18nPath),
        dynamicImport<any>(iconsPath),
        dynamicImport<any>(queryPath),
        dynamicImport<any>(collaborationPath),
        dynamicImport<any>(yjsPath),
        dynamicImport<any>(enginePath),
        dynamicImport<any>(
          "/src/features/classroom-tools/ClassroomFilesTool.tsx",
        ),
        dynamicImport<any>("/src/features/classroom-tools/filesSession.ts"),
        dynamicImport<any>(
          "/src/features/collaboration/whiteboardSnippetBridge.ts",
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
        loggerName: "room-tools-files-01-fixture",
      });
      livekit
        .getLogger("room-tools-files-01-fixture")
        .setLevel(livekit.LogLevel.silent);
      await room.simulateParticipants({
        participants: { audio: false, count: 3, video: false },
        publish: { audio: true, useRealTracks: false, video: false },
      });

      const authority = new collaboration.CanonicalExcalidrawAuthority(
        new Y.Doc(),
        { documentId: "board-1", generation: 1, tenantId: tenantID },
        "teacher-0001",
      );
      authority.initialize({
        elements: [],
        files: {},
        page: { backgroundColor: "#ffffff", id: "page-1", name: "Page 1" },
        schemaVersion: 1,
      });
      const bridge = bridgeModule.createWhiteboardSnippetBridge();
      const session = filesSession.createClassroomFilesSession();
      const queryClient = new query.QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const vietnamese = (fixtureOptions.language ?? "vi") === "vi";

      const Board = () =>
        h(engine.CanonicalExcalidrawCanvas, {
          authority,
          classroom: true,
          connectionStatus: "connected",
          readOnly: false,
          snippetBridge: bridge,
        });
      const Code = () =>
        h("div", {
          className: "room-tools-fixture-code",
          style: { flex: "1 1 auto" },
        });

      const Room = () =>
        h(shell.ClassroomMediaShell, {
          canPublishCameraMicrophone: true,
          canShareScreen: true,
          canSubscribe: true,
          connectionStatus: "connected",
          onLeave: () => undefined,
          onTerminalMediaCleanup: async () => undefined,
          roomTitle: "Lớp 10A1 · Toán",
          tools: [
            {
              content: h(Board),
              icon: h(icons.PenTool),
              id: "whiteboard",
              label: vietnamese ? "Bảng trắng" : "Whiteboard",
              title: vietnamese ? "Bảng trắng lớp học" : "Classroom whiteboard",
            },
            {
              content: h(Code),
              icon: h(icons.CodeXml),
              id: "code",
              label: "Code",
              title: vietnamese ? "Công cụ Code" : "Code tool",
            },
            {
              content: h(filesTool.ClassroomFilesTool, {
                actorID: "teacher-0001",
                enabled: true,
                mediaSpaceID: spaceID,
                session,
                snippetBridge: bridge,
                tenantID,
                whiteboardCanEdit: true,
                whiteboardEnabled: true,
              }),
              icon: h(icons.FileText),
              id: "files",
              label: vietnamese ? "Tài liệu" : "Documents",
              onStageClose: () => session.releaseBytes(),
              title: vietnamese ? "Công cụ Tài liệu" : "Documents tool",
            },
          ],
        });

      const probe = (window as unknown as Record<string, any>).__canvasProbe;
      window.__filesFixture = {
        liveCanvases: () => probe.count(),
        maxLiveCanvases: () => probe.max(),
        opened: () => [...(window as unknown as Record<string, any>).__opened],
        resetMax: () => probe.reset(),
        scene: () => authority.getScene(),
      };
      /* eslint-enable @typescript-eslint/no-explicit-any */

      const rootElement = document.getElementById("files-fixture-root");
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
              { initialLanguage: fixtureOptions.language ?? "vi" },
              h(components.RoomContext.Provider, { value: room }, h(Room)),
            ),
          ),
        ),
      );
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    },
    { fixtureOptions: options, spaceID: SPACE_ID, tenantID: TENANT_ID },
  );
  await expect(page.locator(".media-p405-shell")).toBeVisible();
  return { dialogs, pageErrors };
}

const toolsKey = (page: Page) => page.locator("#media-p506-control-tools");

async function chooseTool(page: Page, id: "code" | "files" | "whiteboard") {
  await toolsKey(page).click();
  await page.locator(`#media-p506-tool-option-${id}`).click();
  await expect(page.locator(`#media-p506-stage-${id}`)).toBeVisible();
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

const liveCanvases = (page: Page) =>
  page.evaluate(() => window.__filesFixture!.liveCanvases());
const maxLiveCanvases = (page: Page) =>
  page.evaluate(() => window.__filesFixture!.maxLiveCanvases());

async function openDocument(page: Page, name: string) {
  await page.getByRole("button", { name: `Mở ${name}` }).click();
  await expect(page.locator(".classroom-files-viewer__region")).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(() => liveCanvases(page), { timeout: 30_000 })
    .toBeGreaterThan(0);
}

async function goToPage(page: Page, pageNumber: number) {
  const input = page.locator(".classroom-files-topbar__page input");
  await input.fill(String(pageNumber));
  await input.press("Enter");
  await expect(input).toHaveValue(String(pageNumber));
}

async function scrollThrough(page: Page, from: number, to: number) {
  // Real wheel-like scrolling across the virtualized pages.
  await page.evaluate(
    async ({ start, end }) => {
      const container = document.querySelector<HTMLElement>(
        ".classroom-files-pages",
      )!;
      const frame = (page: number) =>
        container.querySelector<HTMLElement>(`[data-page-frame="${page}"]`)!;
      const target = frame(end).offsetTop;
      let position = frame(start).offsetTop;
      const step =
        Math.sign(target - position) *
        Math.max(200, container.clientHeight / 2);
      while (Math.abs(target - position) > Math.abs(step)) {
        position += step;
        container.scrollTop = position;
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
      }
      container.scrollTop = target;
    },
    { end: to, start: from },
  );
}

async function expectNoViolations(page: Page) {
  // Let slide-in animations settle so contrast is measured on final colours.
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().map((animation) => animation.finished),
    ),
  );
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

function shortDocument(
  overrides: Partial<StoredDocument> = {},
): StoredDocument {
  return {
    activeContent: false,
    bytes: SHORT_PDF,
    id: "70000000-0000-4000-8000-000000000001",
    name: "De kiem tra.pdf",
    pages: 3,
    readyAfterLists: 0,
    type: "application/pdf",
    version: 1,
    ...overrides,
  };
}

// ---- Tests --------------------------------------------------------------

test("ROOM-TOOLS-FILES-01B uploads a 150-page PDF, keeps ≤ 5 live canvases (≤ 2 at 320px) and swaps tools without remounting media", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const server = await installFakeServer(page);
  const { dialogs, pageErrors } = await mountFilesFixture(page);
  expect(await tileIdentity(page)).toBeGreaterThan(0);

  await chooseTool(page, "files");
  await expect(page.getByText("Chưa có tài liệu nào")).toBeVisible();
  await page
    .locator('.classroom-files-upload input[type="file"]')
    .setInputFiles({
      buffer: LONG_PDF,
      mimeType: "application/pdf",
      name: "On tap 150 trang.pdf",
    });
  // Verifier in flight → the row polls itself to ready.
  await expect(page.getByText("Đang kiểm tra tệp…")).toBeVisible({
    timeout: 20_000,
  });
  expect(server.uploads).toEqual([
    {
      name: "On tap 150 trang.pdf",
      scope: "media_space",
      size: LONG_PDF.byteLength,
    },
  ]);
  await expect(
    page.getByRole("button", { name: "Mở On tap 150 trang.pdf" }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("PDF · 150 trang")).toBeVisible();
  await openDocument(page, "On tap 150 trang.pdf");
  await expect(page.locator("[data-page-frame]")).toHaveCount(150);
  await expect(page.locator(".classroom-files-topbar__page")).toContainText(
    "/ 150",
  );

  await page.evaluate(() => window.__filesFixture!.resetMax());
  await scrollThrough(page, 1, 75);
  await expect(page.locator(".classroom-files-topbar__page input")).toHaveValue(
    "75",
  );
  await expect
    .poll(() => page.locator('canvas[data-pdf-page="75"]').count())
    .toBe(1);
  await scrollThrough(page, 75, 150);
  await expect(page.locator(".classroom-files-topbar__page input")).toHaveValue(
    "150",
  );
  await goToPage(page, 1);
  await goToPage(page, 75);
  const desktopMax = await maxLiveCanvases(page);
  expect(desktopMax).toBeLessThanOrEqual(5);
  expect(
    await page.locator("canvas[data-pdf-page]").count(),
  ).toBeLessThanOrEqual(5);
  await page.screenshot({
    path: ".tmp/room-tools-files-01b/screenshots/01-viewer-150-pages-1440.png",
  });

  // Documents ↔ Code ↔ Whiteboard: media tiles never remount and the
  // document reopens on the same page from RAM (no second download).
  const viewRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/__storage/")) viewRequests.push(request.url());
  });
  await chooseTool(page, "code");
  await expect(page.locator("canvas[data-pdf-page]")).toHaveCount(0);
  await chooseTool(page, "whiteboard");
  await chooseTool(page, "files");
  await expect(page.locator(".classroom-files-topbar__page input")).toHaveValue(
    "75",
    { timeout: 20_000 },
  );
  // The bytes come from RAM; only the pdf.js worker starts again.
  await expect(page.locator('canvas[data-pdf-page="75"]')).toHaveCount(1, {
    timeout: 20_000,
  });
  expect(viewRequests).toEqual([]);
  expect(await tilesKept(page)).toBe(true);

  // 320×640: at most two live canvases.
  await page.setViewportSize({ width: 320, height: 640 });
  await page.evaluate(() => window.__filesFixture!.resetMax());
  await scrollThrough(page, 75, 90);
  await goToPage(page, 140);
  await goToPage(page, 2);
  await expect.poll(() => liveCanvases(page)).toBeGreaterThan(0);
  const mobileMax = await maxLiveCanvases(page);
  expect(mobileMax).toBeLessThanOrEqual(2);
  test.info().annotations.push({
    description: JSON.stringify({ desktopMax, mobileMax }),
    type: "FILES_01B_LIVE_CANVASES",
  });
  console.log(
    "FILES_01B_LIVE_CANVASES",
    JSON.stringify({ desktopMax, mobileMax }),
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".tmp/room-tools-files-01b/screenshots/02-viewer-320.png",
  });
  expect(server.externalRequests).toEqual([]);
  expect(dialogs).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("ROOM-TOOLS-FILES-01B never runs PDF scripts, keeps dangerous links inert and confirms https by host", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const server = await installFakeServer(page, [
    shortDocument({
      activeContent: true,
      bytes: MALICIOUS_PDF,
      id: "70000000-0000-4000-8000-000000000009",
      name: "Doc hai.pdf",
      pages: 1,
    }),
  ]);
  const { dialogs, pageErrors } = await mountFilesFixture(page);
  await chooseTool(page, "files");
  await expect(page.getByText("Có nội dung chủ động")).toBeVisible();
  await openDocument(page, "Doc hai.pdf");
  const links = page.locator(".classroom-files-link");
  await expect(links).toHaveCount(1);
  await expect(links.first()).toHaveAccessibleName(
    "Liên kết ngoài: safe.example.org",
  );
  // Nothing in the viewer carries a script, data, http or javascript target.
  expect(
    await page.evaluate(() =>
      Array.from(
        document.querySelectorAll(
          ".classroom-files-viewer [href], .classroom-files-viewer [src]",
        ),
      )
        .map(
          (node) => node.getAttribute("href") ?? node.getAttribute("src") ?? "",
        )
        // Local thumbnail images are the only URLs (in-memory blob:).
        .filter((value) => !value.startsWith("blob:http://127.0.0.1:5173/")),
    ),
  ).toEqual([]);
  // Clicking where the dangerous links are does nothing.
  const pageBox = await page.locator('[data-page-frame="1"]').boundingBox();
  expect(pageBox).toBeTruthy();
  const yFor = (pdfY: number) =>
    pageBox!.y + ((842 - pdfY) / 842) * pageBox!.height;
  const xFor = (pdfX: number) => pageBox!.x + (pdfX / 595) * pageBox!.width;
  for (const pdfY of [705, 665, 625, 545]) {
    await page.mouse.click(xFor(200), yFor(pdfY));
  }
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  await links.first().click();
  const dialog = page.getByRole("alertdialog", { name: "Mở liên kết ngoài?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("link-host")).toHaveText("safe.example.org");
  await expect(dialog.getByRole("button", { name: "Hủy" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(links.first()).toBeFocused();
  await links.first().click();
  await dialog.getByRole("button", { name: "Mở liên kết" }).click();
  expect(await page.evaluate(() => window.__filesFixture!.opened())).toEqual([
    {
      features: "noopener,noreferrer",
      url: "https://safe.example.org/bai-tap",
    },
  ]);
  await page.screenshot({
    path: ".tmp/room-tools-files-01b/screenshots/03-malicious-pdf.png",
  });
  expect(dialogs).toEqual([]);
  expect(server.externalRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("ROOM-TOOLS-FILES-01B crops a region and sends it to the whiteboard as a locked ≤ 40 KiB WebP with its source", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const server = await installFakeServer(page, [shortDocument()]);
  const { pageErrors } = await mountFilesFixture(page);
  await chooseTool(page, "files");
  await openDocument(page, "De kiem tra.pdf");

  await page.getByRole("button", { name: "Đưa sang Bảng trắng" }).click();
  await page.getByRole("menuitem", { name: "Kéo chọn vùng cắt" }).click();
  const crop = page.locator(".classroom-files-crop");
  await expect(crop).toBeFocused();
  const box = (await crop.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.08, box.y + box.height * 0.06);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.2, {
    steps: 8,
  });
  await page.mouse.move(box.x + box.width * 0.92, box.y + box.height * 0.34, {
    steps: 8,
  });
  await page.mouse.up();
  await page.screenshot({
    path: ".tmp/room-tools-files-01b/screenshots/04-crop-region.png",
  });
  await page
    .getByRole("button", { name: "Đưa vùng này sang Bảng trắng" })
    .click();

  await expect(page.locator("#media-p506-stage-whiteboard")).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window
              .__filesFixture!.scene()
              .elements.filter((element) => element.type === "image").length,
        ),
      { timeout: 20_000 },
    )
    .toBe(1);
  const inserted = await page.evaluate(() => {
    const scene = window.__filesFixture!.scene();
    const image = scene.elements.find((element) => element.type === "image")!;
    const caption = scene.elements.find((element) => element.type === "text")!;
    const file = scene.files[String(image.fileId)]!;
    const payload = (file.dataURL ?? "").split(",")[1] ?? "";
    return {
      bytes: atob(payload).length,
      caption: caption.text,
      captionLocked: caption.locked,
      dataPrefix: (file.dataURL ?? "").slice(0, 23),
      fileId: image.fileId,
      locked: image.locked,
      mimeType: file.mimeType,
    };
  });
  expect(inserted.locked).toBe(true);
  expect(inserted.captionLocked).toBe(true);
  expect(inserted.caption).toBe("Trích từ De kiem tra.pdf — trang 1");
  expect(inserted.mimeType).toBe("image/webp");
  expect(inserted.dataPrefix).toBe("data:image/webp;base64,");
  expect(inserted.bytes).toBeGreaterThan(500);
  expect(inserted.bytes).toBeLessThanOrEqual(40_960);
  console.log("FILES_01B_SNIPPET_BYTES", inserted.bytes);
  expect(String(inserted.fileId)).toMatch(/^doc-snip-/);
  await expect(
    page.getByText("Đã chèn ảnh trích từ tài liệu vào Bảng trắng."),
  ).toBeVisible();
  await page.screenshot({
    path: ".tmp/room-tools-files-01b/screenshots/05-snippet-on-whiteboard.png",
  });

  // "Đưa nguyên trang" from the keyboard path also fits the budget.
  await chooseTool(page, "files");
  await expect
    .poll(() => liveCanvases(page), { timeout: 20_000 })
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "Đưa sang Bảng trắng" }).click();
  await page
    .getByRole("menuitem", { name: "Đưa nguyên trang hiện tại" })
    .click();
  await expect(page.locator("#media-p506-stage-whiteboard")).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.values(window.__filesFixture!.scene().files).map(
          (file) => atob((file.dataURL ?? "").split(",")[1] ?? "").length,
        ),
      ),
    )
    .toHaveLength(2);
  const sizes = await page.evaluate(() =>
    Object.values(window.__filesFixture!.scene().files).map(
      (file) => atob((file.dataURL ?? "").split(",")[1] ?? "").length,
    ),
  );
  expect(sizes.every((size) => size <= 40_960)).toBe(true);
  expect(server.externalRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("ROOM-TOOLS-FILES-01B has no Axe violations at 1440×900 and 320×640 forced colors, with PageDown/PageUp and Escape", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installFakeServer(page, [
    shortDocument(),
    shortDocument({
      activeContent: true,
      id: "70000000-0000-4000-8000-000000000002",
      name: "Phieu bai tap.pdf",
    }),
  ]);
  const { pageErrors } = await mountFilesFixture(page);
  await chooseTool(page, "files");
  await expect(
    page.getByRole("button", { name: "Mở De kiem tra.pdf" }),
  ).toBeVisible();
  await expectNoViolations(page);
  await openDocument(page, "De kiem tra.pdf");
  await expectNoViolations(page);

  const region = page.getByRole("region", {
    name: /Trình xem tài liệu: De kiem tra\.pdf/,
  });
  const pageInput = page.locator(".classroom-files-topbar__page input");
  await region.focus();
  await page.keyboard.press("PageDown");
  await expect(pageInput).toHaveValue("2");
  await page.keyboard.press("PageDown");
  await expect(pageInput).toHaveValue("3");
  await page.keyboard.press("PageUp");
  await expect(pageInput).toHaveValue("2");
  await page.keyboard.press("Home");
  await expect(pageInput).toHaveValue("1");
  await page.keyboard.press("Control+f");
  const search = page.getByRole("searchbox", { name: "Tìm trong tài liệu" });
  await expect(search).toBeFocused();
  await search.fill("phuong trinh");
  await expect(
    page.getByRole("status").filter({ hasText: "kết quả" }),
  ).toHaveText("1 kết quả trên 1 trang", { timeout: 20_000 });
  await expectNoViolations(page);
  await page.keyboard.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(region).toBeFocused();
  // The library drawer opens from the Top Bar file key and Escape closes it.
  await page.locator(".classroom-files-topbar__file").click();
  const drawer = page.getByRole("region", { name: "Kho tài liệu" });
  await expect(drawer).toBeVisible();
  await expectNoViolations(page);
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);

  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 640 });
  await expect.poll(() => liveCanvases(page)).toBeGreaterThan(0);
  expect(await liveCanvases(page)).toBeLessThanOrEqual(2);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const header = await page.locator("header.media-p405-header").boundingBox();
  expect(header!.x + header!.width).toBeLessThanOrEqual(320);
  await page.screenshot({
    path: ".tmp/room-tools-files-01b/screenshots/06-viewer-320-forced-colors.png",
  });
  await expectNoViolations(page);
  await region.focus();
  await page.keyboard.press("PageDown");
  await expect(pageInput).toHaveValue("2");
  expect(pageErrors).toEqual([]);
});
