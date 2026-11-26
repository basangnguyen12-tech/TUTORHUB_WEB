import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * ROOM-TOOLS-FILES-02B (ADR-0045 Slice 2): "Trình chiếu lớp" between a
 * teacher page and a student page. Both pages mount the real classroom
 * shell, People panel and Documents tool from Vite source modules; the
 * `pdf.annotations.v1` layer travels through a real `@hocuspocus/server` (the
 * copy the collaboration runtime uses) started in this test process, whose
 * hooks emulate the runtime's read-only `view` grants and its awareness
 * sanitizer (server-stamped `tutorhub.capability`). The Core API and object
 * storage (with HTTP Range) answer from one in-test state on 127.0.0.1.
 */
const fixturePath = "/__room-tools-files-02-fixture";
const APP_ORIGIN = "http://127.0.0.1:5173";
const TENANT_ID = "50000000-0000-4000-8000-000000000001";
const SPACE_ID = "40000000-0000-4000-8000-000000000001";
const ROOM_INSTANCE_ID = "60000000-0000-4000-8000-000000000001";
const CSRF_TOKEN = "room-tools-files-02-csrf-token";
const DOC_A = "70000000-0000-4000-8000-00000000000a";
const DOC_B = "70000000-0000-4000-8000-00000000000b";
const DOC_BIG = "70000000-0000-4000-8000-0000000000bb";

test.skip(
  process.env.E2E_MODE === "staging",
  "The PDF presentation fixture loads Vite source modules and a local runtime.",
);

type Role = "teacher" | "student";
type Capability = "view" | "edit" | "present";

interface Person {
  readonly actorId: string;
  readonly name: string;
  readonly participantKey: string;
  readonly sequence: number;
}

const PEOPLE: Readonly<Record<Role, Person>> = {
  student: {
    actorId: "10000000-0000-4000-8000-000000000002",
    name: "Minh Anh",
    participantKey: "00000000-0000-4000-8000-000000000002",
    sequence: 2,
  },
  teacher: {
    actorId: "10000000-0000-4000-8000-000000000001",
    name: "Thu Hà",
    participantKey: "00000000-0000-4000-8000-000000000001",
    sequence: 1,
  },
};

// ---- PDF fixtures (built in the test, no binary in Git) -----------------

function pdfString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

/** A valid PDF with a standard xref; `fillerBytes` adds one unused stream. */
function buildPdf(pages: readonly string[][], fillerBytes = 0): Buffer {
  const bodies = new Map<number, Buffer>();
  const pageRefs: number[] = [];
  let next = 4;
  for (const lines of pages) {
    const pageNumber = next++;
    const contentNumber = next++;
    pageRefs.push(pageNumber);
    const content = [
      "0.93 0.96 1 rg 48 560 499 240 re f",
      "0 0 0 rg",
      ...lines.map(
        (line, index) =>
          `BT /F1 ${index === 0 ? 30 : 18} Tf 72 ${740 - index * 40} Td (${pdfString(line)}) Tj ET`,
      ),
    ].join("\n");
    bodies.set(
      contentNumber,
      Buffer.from(
        `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
        "latin1",
      ),
    );
    bodies.set(
      pageNumber,
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNumber} 0 R >>`,
        "latin1",
      ),
    );
  }
  if (fillerBytes > 0) {
    const fillerNumber = next++;
    bodies.set(
      fillerNumber,
      Buffer.concat([
        Buffer.from(`<< /Length ${fillerBytes} >>\nstream\n`, "latin1"),
        Buffer.alloc(fillerBytes, 0x30),
        Buffer.from("\nendstream", "latin1"),
      ]),
    );
  }
  bodies.set(1, Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"));
  bodies.set(
    2,
    Buffer.from(
      `<< /Type /Pages /Kids [${pageRefs.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageRefs.length} >>`,
      "latin1",
    ),
  );
  bodies.set(
    3,
    Buffer.from(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
      "latin1",
    ),
  );
  const parts: Buffer[] = [Buffer.from("%PDF-1.7\n%âãÏÓ\n", "latin1")];
  let length = parts[0]!.byteLength;
  const offsets: number[] = [0];
  for (let number = 1; number < next; number += 1) {
    offsets[number] = length;
    const object = Buffer.concat([
      Buffer.from(`${number} 0 obj\n`, "latin1"),
      bodies.get(number) ?? Buffer.from("null", "latin1"),
      Buffer.from("\nendobj\n", "latin1"),
    ]);
    parts.push(object);
    length += object.byteLength;
  }
  let tail = `xref\n0 ${next}\n0000000000 65535 f \n`;
  for (let number = 1; number < next; number += 1) {
    tail += `${String(offsets[number]).padStart(10, "0")} 00000 n \n`;
  }
  tail += `trailer\n<< /Size ${next} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(Buffer.from(tail, "latin1"));
  return Buffer.concat(parts);
}

const PDF_A = buildPdf(
  Array.from({ length: 5 }, (_, index) => [
    `De A - Trang ${index + 1}`,
    `Cau ${index + 1}. Giai phuong trinh`,
  ]),
);
const PDF_B = buildPdf(
  Array.from({ length: 3 }, (_, index) => [`De B - Trang ${index + 1}`]),
);
const BIG_FILLER_BYTES = 35 * 1024 * 1024;
let PDF_BIG: Buffer | null = null;
function bigPdf(): Buffer {
  PDF_BIG ??= buildPdf(
    [["De lon 35 MiB - Trang 1"], ["Trang 2"], ["Trang 3"]],
    BIG_FILLER_BYTES,
  );
  return PDF_BIG;
}

interface StoredDocument {
  readonly bytes: () => Buffer;
  readonly id: string;
  readonly name: string;
  readonly pages: number;
}

const DOCUMENTS: readonly StoredDocument[] = [
  { bytes: () => PDF_A, id: DOC_A, name: "De-A.pdf", pages: 5 },
  { bytes: () => PDF_B, id: DOC_B, name: "De-B.pdf", pages: 3 },
  { bytes: bigPdf, id: DOC_BIG, name: "De-lon.pdf", pages: 3 },
];

// ---- In-test Core API state ---------------------------------------------

interface RuntimeScope {
  readonly actorId: string;
  readonly capability: Capability;
  readonly documentName: string;
  readonly generation: number;
}

interface PresentationRow {
  readonly fileId: string;
  readonly generation: number;
  readonly grants: Map<string, string>;
  readonly id: string;
  revokeGeneration: number;
  status: "open" | "suspended" | "closed";
  updatedAt: number;
  version: number;
}

interface ClassroomState {
  presentations: PresentationRow[];
  readonly rangeStatuses: number[];
  readonly storageBytes: Map<string, number>;
  readonly tokens: Map<string, RuntimeScope>;
}

/* Minimal structural types for the CommonJS runtime packages. */
interface HocuspocusServer {
  readonly address: { readonly port: number };
  destroy(): Promise<void>;
  listen(): Promise<unknown>;
}

interface HocuspocusModule {
  readonly Server: new (
    configuration: Record<string, unknown>,
  ) => HocuspocusServer;
}

interface YDocLike {
  readonly __brand?: "ydoc";
}

interface YjsModule {
  applyUpdate(document: YDocLike, update: Uint8Array): void;
  encodeStateAsUpdate(document: YDocLike): Uint8Array;
}

interface AuthenticatePayload {
  readonly connectionConfig: { readOnly: boolean };
  readonly documentName: string;
  readonly token: string;
}

interface AwarenessPayload {
  readonly context?: RuntimeScope;
  readonly states: Map<number, Record<string, unknown>>;
}

let state: ClassroomState;
let runtime: HocuspocusServer;
let providerUrl = "";
const storedDocuments = new Map<string, Uint8Array>();

function runtimeRequire() {
  return createRequire(
    path.resolve(__dirname, "../services/whiteboard-runtime/package.json"),
  );
}

function providerDocumentName(presentationID: string): string {
  return `pd_${presentationID.replaceAll("-", "")}`;
}

const FORBIDDEN_AWARENESS_FIELDS = [
  "actorId",
  "authorityLease",
  "capability",
  "documentId",
  "generation",
  "grant",
  "sessionId",
  "tenantId",
];

test.beforeAll(async () => {
  const require = runtimeRequire();
  const { Server } = require("@hocuspocus/server") as HocuspocusModule;
  const Y = require("yjs") as YjsModule;
  runtime = new Server({
    address: "127.0.0.1",
    debounce: 50,
    maxDebounce: 200,
    port: 0,
    quiet: true,
    stopOnSignals: false,
    timeout: 30_000,
    unloadImmediately: true,
    async onAuthenticate({
      connectionConfig,
      documentName,
      token,
    }: AuthenticatePayload) {
      const scope = state.tokens.get(token);
      if (!scope || scope.documentName !== documentName) {
        throw new Error("grant_denied");
      }
      // Like the runtime: a `view` grant is a read-only provider session.
      connectionConfig.readOnly = scope.capability === "view";
      return scope;
    },
    // Like the runtime's checkpoints: a presentation keeps its ink when the
    // room switches A → B → A.
    async onLoadDocument({
      document,
      documentName,
    }: {
      document: YDocLike;
      documentName: string;
    }) {
      const saved = storedDocuments.get(documentName);
      if (saved) Y.applyUpdate(document, saved);
      return document;
    },
    async onStoreDocument({
      document,
      documentName,
    }: {
      document: YDocLike;
      documentName: string;
    }) {
      storedDocuments.set(documentName, Y.encodeStateAsUpdate(document));
    },
    async beforeHandleAwareness({ context, states }: AwarenessPayload) {
      if (!context) throw new Error("grant_denied");
      // The runtime sanitizer: the server stamps who a client is and what
      // it may do; a client cannot claim `present` for itself.
      for (const value of states.values()) {
        for (const field of FORBIDDEN_AWARENESS_FIELDS) delete value[field];
        const user =
          typeof value.user === "object" && value.user !== null
            ? (value.user as Record<string, unknown>)
            : null;
        const displayName = user?.displayName;
        value.user = {
          id: context.actorId,
          ...(typeof displayName === "string" && displayName.length <= 128
            ? { displayName }
            : {}),
        };
        value.tutorhub = {
          actorId: context.actorId,
          capability: context.capability,
          generation: context.generation,
        };
      }
    },
  });
  await runtime.listen();
  providerUrl = `ws://127.0.0.1:${runtime.address.port}`;
});

test.afterAll(async () => {
  await runtime?.destroy();
});

test.beforeEach(() => {
  storedDocuments.clear();
  state = {
    presentations: [],
    rangeStatuses: [],
    storageBytes: new Map(),
    tokens: new Map(),
  };
});

function currentPresentation(): PresentationRow | null {
  const open = state.presentations.find((row) => row.status === "open");
  if (open) return open;
  return (
    [...state.presentations]
      .filter((row) => row.status === "suspended")
      .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null
  );
}

function capabilityOf(role: Role, row: PresentationRow): Capability {
  if (role === "teacher") return "present";
  return row.status === "open" && row.grants.has(PEOPLE.student.participantKey)
    ? "edit"
    : "view";
}

function presentationView(role: Role, row: PresentationRow) {
  const teacher = role === "teacher";
  const open = row.status === "open";
  const document = DOCUMENTS.find((item) => item.id === row.fileId)!;
  return {
    created_at: "2030-08-08T00:00:00Z",
    current_generation: row.generation,
    document: {
      active_content: false,
      allow_student_download: true,
      display_name: document.name,
      file_id: document.id,
      first_page_aspect: 595 / 842,
      media_type: "application/pdf",
      page_count: document.pages,
      version_id: "v1",
    },
    file_id: row.fileId,
    id: row.id,
    media_space_id: SPACE_ID,
    page_count: document.pages,
    revoke_generation: row.revokeGeneration,
    status: row.status,
    updated_at: new Date(row.updatedAt).toISOString(),
    version: row.version,
    version_id: "v1",
    viewer_capabilities: {
      can_close: teacher && row.status !== "closed",
      can_exchange_grant: open,
      can_manage: teacher,
      can_manage_annotator_grants: teacher && open,
      can_resume: teacher && row.status === "suspended",
      can_suspend: teacher && open,
      capability: capabilityOf(role, row),
    },
  };
}

function projectionFor(role: Role) {
  const row = currentPresentation();
  return {
    active_annotator_grants:
      row?.status === "open"
        ? [...row.grants].map(([participant_key, expires_at]) => ({
            expires_at,
            participant_key,
          }))
        : [],
    can_present: role === "teacher",
    presentation: row ? presentationView(role, row) : null,
  };
}

function documentJSON(role: Role, document: StoredDocument) {
  return {
    active_content: false,
    allow_student_download: true,
    class_id: null,
    created_at: "2030-08-08T01:00:00Z",
    declared_media_type: "application/pdf",
    display_name: document.name,
    expected_size_bytes: document.bytes().byteLength,
    expires_at: null,
    first_page_aspect: 595 / 842,
    id: document.id,
    media_space_id: SPACE_ID,
    owner_kind: "media_space",
    page_count: document.pages,
    rejection_reason: null,
    status: "ready",
    updated_at: "2030-08-08T01:00:00Z",
    uploaded_by_viewer: role === "teacher",
    version: 2,
    viewer_access: {
      can_download_original: role === "teacher",
      can_manage: role === "teacher",
      can_retry_upload: false,
      can_view: true,
    },
  };
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    body: JSON.stringify(body),
    contentType: "application/json",
    headers: { "Cache-Control": "no-store" },
    status,
  });
}

async function problem(route: Route, status: number, code: string) {
  await route.fulfill({
    body: JSON.stringify({ code, status, title: code }),
    contentType: "application/problem+json",
    status,
  });
}

/** The Core API and object storage for one page (its role decides all). */
async function installCoreApi(page: Page, role: Role) {
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const { pathname } = new URL(request.url());
    const path = pathname.replace(/^.*?\/api\/v1\//, "/");
    if (path === "/auth/csrf" && method === "GET") {
      return json(route, { csrf_token: CSRF_TOKEN });
    }
    if (path === `/media/spaces/${SPACE_ID}/documents` && method === "GET") {
      return json(route, {
        items: DOCUMENTS.map((document) => documentJSON(role, document)),
        next_cursor: null,
        viewer_access: {
          can_manage: role === "teacher",
          can_present: role === "teacher",
          can_upload: role === "teacher",
          can_upload_to_class: false,
        },
      });
    }
    const view =
      /^\/media\/spaces\/[^/]+\/documents\/([^/]+)\/view-capabilities$/u.exec(
        path,
      );
    if (view && method === "POST") {
      const document = DOCUMENTS.find((item) => item.id === view[1]);
      if (!document) return problem(route, 404, "not_found");
      const bytes = document.bytes();
      return json(route, {
        active_content: false,
        content_length_bytes: bytes.byteLength,
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        first_page_aspect: 595 / 842,
        media_type: "application/pdf",
        method: "GET",
        page_count: document.pages,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        url: `${APP_ORIGIN}/__storage/${document.id}?X-Amz-Signature=fixture`,
        version_id: "v1",
      });
    }
    if (path === `/media/spaces/${SPACE_ID}/pdf-presentation`) {
      if (method === "GET") return json(route, projectionFor(role));
      if (method !== "POST" || role !== "teacher") {
        return problem(route, 404, "not_found");
      }
      if (request.headers()["x-csrf-token"] !== CSRF_TOKEN) {
        return problem(route, 403, "csrf_invalid");
      }
      const body = request.postDataJSON() as { file_id: string };
      const now = Date.now();
      // One open presentation per room: switching suspends the open one.
      for (const row of state.presentations) {
        if (row.status === "open" && row.fileId !== body.file_id) {
          row.status = "suspended";
          row.version += 1;
          row.revokeGeneration += 1;
          row.updatedAt = now;
          row.grants.clear();
        }
      }
      let target = state.presentations.find(
        (row) => row.fileId === body.file_id && row.status !== "closed",
      );
      if (target) {
        if (target.status !== "open") {
          target.status = "open";
          target.version += 1;
          target.updatedAt = now;
        }
      } else {
        target = {
          fileId: body.file_id,
          generation: 1,
          grants: new Map(),
          id: randomUUID(),
          revokeGeneration: 1,
          status: "open",
          updatedAt: now,
          version: 1,
        };
        state.presentations.push(target);
      }
      return json(route, presentationView(role, target), 201);
    }
    const match =
      /^\/pdf-presentations\/([0-9a-f-]{36})\/(suspend|resume|close|grant-exchanges|actor-grants\/[0-9a-f-]{36})$/u.exec(
        path,
      );
    const row = match
      ? state.presentations.find((item) => item.id === match[1])
      : undefined;
    if (!match || !row) return problem(route, 404, "not_found");
    if (request.headers()["x-csrf-token"] !== CSRF_TOKEN) {
      return problem(route, 403, "csrf_invalid");
    }
    const action = match[2]!;
    if (action === "grant-exchanges" && method === "POST") {
      const body = request.postDataJSON() as {
        capability: Capability;
        expected_generation: number;
        expected_revoke_generation: number;
      };
      if (
        row.status !== "open" ||
        body.capability !== capabilityOf(role, row) ||
        body.expected_generation !== row.generation ||
        body.expected_revoke_generation !== row.revokeGeneration
      ) {
        return problem(route, 409, "pdf_presentation_grant_stale");
      }
      const credential = `${role}.${body.capability}.${randomUUID()}`;
      state.tokens.set(credential, {
        actorId: PEOPLE[role].actorId,
        capability: body.capability,
        documentName: providerDocumentName(row.id),
        generation: row.generation,
      });
      return json(route, {
        capability: body.capability,
        credential,
        document_id: row.id,
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        generation: row.generation,
        provider_url: providerUrl,
        revoke_generation: row.revokeGeneration,
      });
    }
    if (role !== "teacher") return problem(route, 404, "not_found");
    if (action.startsWith("actor-grants/")) {
      const participantKey = action.slice("actor-grants/".length);
      if (method === "PUT") {
        const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
        row.grants.set(participantKey, expiresAt);
        return json(route, {
          expires_at: expiresAt,
          participant_key: participantKey,
        });
      }
      if (method === "DELETE") {
        row.grants.delete(participantKey);
        return route.fulfill({ status: 204 });
      }
    }
    if (method === "POST") {
      row.status =
        action === "resume"
          ? "open"
          : action === "suspend"
            ? "suspended"
            : "closed";
      if (action !== "resume") row.revokeGeneration += 1;
      row.version += 1;
      row.updatedAt = Date.now();
      return json(route, presentationView(role, row));
    }
    return problem(route, 405, "method_not_allowed");
  });

  // Object storage with HTTP Range (206 + Content-Range), like B2.
  await page.route("**/__storage/**", async (route) => {
    const request = route.request();
    const id = new URL(request.url()).pathname.split("/").pop() ?? "";
    const document = DOCUMENTS.find((item) => item.id === id);
    if (!document) return route.fulfill({ status: 404 });
    const bytes = document.bytes();
    const range = /^bytes=(\d+)-(\d+)$/u.exec(request.headers().range ?? "");
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), bytes.byteLength - 1);
      const body = bytes.subarray(start, end + 1);
      state.storageBytes.set(
        id,
        (state.storageBytes.get(id) ?? 0) + body.byteLength,
      );
      state.rangeStatuses.push(206);
      return route.fulfill({
        body,
        headers: {
          "Cache-Control": "no-store",
          "Content-Range": `bytes ${start}-${end}/${bytes.byteLength}`,
          "Content-Type": "application/pdf",
        },
        status: 206,
      });
    }
    state.storageBytes.set(
      id,
      (state.storageBytes.get(id) ?? 0) + bytes.byteLength,
    );
    return route.fulfill({
      body: bytes,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/pdf",
      },
      status: 200,
    });
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
        "<title>ROOM-TOOLS-FILES-02 fixture</title>",
        '<script type="module">',
        "import RefreshRuntime from '/@react-refresh';",
        "RefreshRuntime.injectIntoGlobalHook(window);",
        "window.$RefreshReg$ = () => {};",
        "window.$RefreshSig$ = () => (type) => type;",
        "window.__vite_plugin_react_preamble_installed__ = true;",
        "</script>",
        "</head>",
        '<body><div id="files-02-fixture-root"></div></body>',
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
  viewport = { height: 900, width: 1440 },
): Promise<MountedPage> {
  const context = await browser.newContext({
    baseURL: APP_ORIGIN,
    locale: "vi-VN",
    // The fixture document is fulfilled by `page.route`, so Chromium's Local
    // Network Access checks would otherwise block the loopback WebSocket.
    permissions: ["local-network-access"],
    viewport,
  });
  const page = await context.newPage();
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
      const pick = (text: string, pattern: RegExp, label: string) => {
        const value = text.match(pattern)?.[1];
        if (!value) throw new Error(`Could not resolve ${label}.`);
        return value;
      };
      const shellPath = "/src/features/media/ClassroomMediaShell.tsx";
      const presentationsPath = "/src/app/pdfPresentations.ts";
      const [shellSource, presentationsSource] = await Promise.all([
        source(shellPath),
        source(presentationsPath),
      ]);
      /* eslint-disable @typescript-eslint/no-explicit-any -- browser-side fixture modules are untyped Vite source modules */
      const [
        ReactImport,
        ReactDOMImport,
        components,
        livekit,
        shell,
        i18n,
        icons,
        filesTool,
        filesSession,
        presentations,
        grantsContext,
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
          "/src/features/classroom-tools/ClassroomFilesTool.tsx",
        ),
        dynamicImport<any>("/src/features/classroom-tools/filesSession.ts"),
        dynamicImport<any>(presentationsPath),
        dynamicImport<any>(
          "/src/features/classroom-tools/pdfAnnotatorGrantsContext.ts",
        ),
        dynamicImport<any>(
          pick(
            presentationsSource,
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
        loggerName: "room-tools-files-02-fixture",
      });
      livekit
        .getLogger("room-tools-files-02-fixture")
        .setLevel(livekit.LogLevel.silent);
      await room.simulateParticipants({
        participants: { audio: false, count: 1, video: false },
        publish: { audio: true, useRealTracks: false, video: false },
      });

      const self = fixture.people[fixture.role];
      const roster = [fixture.people.teacher, fixture.people.student].map(
        (person) => ({
          connection_state: "connected",
          display_name: person.name,
          instance_role:
            person === fixture.people.teacher ? "host" : "attendee",
          participant_key: person.participantKey,
          roster_sequence: person.sequence,
        }),
      );
      const signalProjection = {
        last_signal_sequence: 0,
        projection_version: 1,
        raised_hands: [],
        reactions: { clusters: [], hidden_cluster_count: 0, summary: [] },
        room_instance_id: fixture.roomInstanceID,
        roster,
        self_participant_key: self.participantKey,
        server_time: new Date().toISOString(),
        viewer_operations: {
          can_moderate_hands: fixture.role === "teacher",
          can_raise_hand: true,
          can_send_reaction: true,
        },
      };
      const presenceRoster = {
        participants: roster,
        roomInstanceID: fixture.roomInstanceID,
        selfParticipantKey: self.participantKey,
      };
      const signals = {
        error: false,
        loading: false,
        mutating: false,
        projection: signalProjection,
        refreshing: false,
        onLowerAllHands: async () => undefined,
        onLowerHand: async () => undefined,
        onResync: async () => undefined,
        onSendReaction: async () => undefined,
        onToggleHand: async () => undefined,
      };
      const session = filesSession.createClassroomFilesSession();
      const queryClient = new query.QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      // The room page's ROOM-TOOLS-FILES-02B wiring (MediaSpaceRoomPage):
      // projection poll, auto-open key and the People panel's PDF grants.
      const Room = () => {
        const tool = presentations.usePdfPresentationTool(
          fixture.tenantID,
          fixture.spaceID,
          true,
          { pollIntervalMs: 500 },
        );
        const projection = tool.isSuccess ? tool.data : undefined;
        const presentation = projection?.presentation ?? null;
        const put = presentations.usePutPdfPresentationAnnotatorGrant(
          fixture.tenantID,
          fixture.spaceID,
        );
        const revoke = presentations.useDeletePdfPresentationAnnotatorGrant(
          fixture.tenantID,
          fixture.spaceID,
        );
        const [grantError, setGrantError] = React.useState(null);
        const [pendingKey, setPendingKey] = React.useState(null);
        const grants =
          presentation === null || presentation.status !== "open"
            ? null
            : {
                activeParticipantKeys: new Set(
                  projection.active_annotator_grants.map(
                    (grant: { participant_key: string }) =>
                      grant.participant_key,
                  ),
                ),
                canManage:
                  presentation.viewer_capabilities.can_manage_annotator_grants,
                error: grantError,
                maxAnnotators: presentations.PDF_PRESENTATION_MAX_ANNOTATORS,
                pendingParticipantKey: pendingKey,
                onDismissError: () => setGrantError(null),
                onGrant: (participantKey: string) => {
                  setGrantError(null);
                  setPendingKey(participantKey);
                  put.mutate(
                    { participantKey, presentationID: presentation.id },
                    {
                      onError: (error: unknown) =>
                        setGrantError(
                          presentations.isPdfAnnotatorLimitError(error)
                            ? "limit"
                            : "failed",
                        ),
                      onSettled: () => setPendingKey(null),
                    },
                  );
                },
                onRevoke: (participantKey: string) => {
                  setGrantError(null);
                  setPendingKey(participantKey);
                  revoke.mutate(
                    { participantKey, presentationID: presentation.id },
                    {
                      onError: () => setGrantError("failed"),
                      onSettled: () => setPendingKey(null),
                    },
                  );
                },
              };
        return h(
          grantsContext.ClassroomPdfAnnotatorGrantsContext.Provider,
          { value: grants },
          h(shell.ClassroomMediaShell, {
            canPublishCameraMicrophone: true,
            canShareScreen: true,
            canSubscribe: true,
            connectionStatus: "connected",
            onLeave: () => undefined,
            onTerminalMediaCleanup: async () => undefined,
            roomTitle: "Lớp 10A1 · Toán",
            signals,
            tools: [
              {
                autoOpenKey:
                  presentations.pdfPresentationAutoOpenKey(presentation),
                content: h(filesTool.ClassroomFilesTool, {
                  actorID: self.actorId,
                  collaborationEnabled: true,
                  displayName: self.name,
                  enabled: true,
                  mediaSpaceID: fixture.spaceID,
                  presenceRoster,
                  session,
                  tenantID: fixture.tenantID,
                }),
                icon: h(icons.FileText),
                id: "files",
                label: "Tài liệu",
                onStageClose: () => session.releaseBytes(),
                title: "Công cụ Tài liệu",
              },
            ],
          }),
        );
      };
      /* eslint-enable @typescript-eslint/no-explicit-any */

      const rootElement = document.getElementById("files-02-fixture-root");
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
      people: PEOPLE,
      role,
      roomInstanceID: ROOM_INSTANCE_ID,
      spaceID: SPACE_ID,
      tenantID: TENANT_ID,
    },
  );
  await expect(page.locator(".media-p405-shell")).toBeVisible();
  return { context, errors, page };
}

// ---- Page helpers ---------------------------------------------------------

const filesStage = (page: Page) => page.locator("#media-p506-stage-files");
const modeButton = (page: Page, name: "Trình chiếu lớp" | "Xem riêng") =>
  page
    .getByRole("group", { name: "Chế độ Tài liệu" })
    .getByRole("button", { name: new RegExp(`^${name}`, "u") });
const liveBar = (page: Page) =>
  page.getByRole("group", { name: "Trạng thái trình chiếu" });
const inkToolbar = (page: Page) =>
  page.getByRole("toolbar", { name: "Công cụ chú thích" });
const inkTool = (page: Page, name: string) =>
  inkToolbar(page).getByRole("button", { exact: true, name });
const followKey = (page: Page) =>
  liveBar(page).getByRole("button", { name: "Theo dõi GV" });
const pageInput = (page: Page) =>
  page.locator(".classroom-files-topbar__page input");
const inkPaths = (page: Page, pageNumber: number, tool?: string) =>
  page.locator(
    `[data-pdf-ink-page="${pageNumber}"] path[data-stroke-id]${tool ? `[data-stroke-tool="${tool}"]` : ""}`,
  );

async function openFilesTool(page: Page) {
  await page.locator("#media-p506-control-tools").click();
  await page.locator("#media-p506-tool-option-files").click();
  await expect(filesStage(page)).toBeVisible();
}

async function presentFromStage(page: Page, name: string) {
  await page
    .getByRole("button", { name: `Trình chiếu ${name} cho lớp` })
    .click();
}

async function presentFromDrawer(page: Page, name: string) {
  await page.locator(".classroom-files-topbar__file").click();
  const drawer = page.locator(".classroom-files-drawer");
  await expect(drawer).toBeVisible();
  await drawer
    .getByRole("button", { name: `Trình chiếu ${name} cho lớp` })
    .click();
  await expect(drawer).toBeHidden();
}

/** Waits until the live bar's connection hint disappears (session ready). */
async function expectLive(page: Page, text: string) {
  await expect(liveBar(page)).toContainText(text, { timeout: 30_000 });
  await expect(liveBar(page).getByText("Đang kết nối nét chữa…")).toHaveCount(
    0,
    { timeout: 30_000 },
  );
}

/** Teacher opens Documents and presents `name`; the student's stage opens. */
async function startPresentation(teacher: Page, student: Page, name: string) {
  await openFilesTool(teacher);
  await presentFromStage(teacher, name);
  await expect(modeButton(teacher, "Trình chiếu lớp")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expectLive(teacher, "Bạn đang trình chiếu");
  await expect(filesStage(student)).toBeVisible({ timeout: 30_000 });
  await expect(modeButton(student, "Trình chiếu lớp")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expectLive(student, "Đang xem giáo viên trình chiếu");
  await expect(
    student.locator('canvas[data-pdf-page="1"]').first(),
  ).toBeVisible();
}

async function drawStroke(
  page: Page,
  pageNumber: number,
  from: readonly [number, number],
  to: readonly [number, number],
) {
  const surface = page.locator(`[data-pdf-ink-page="${pageNumber}"]`);
  await surface.scrollIntoViewIfNeeded();
  const box = await surface.boundingBox();
  if (!box) throw new Error(`Page ${pageNumber} has no ink surface.`);
  await page.mouse.move(
    box.x + box.width * from[0],
    box.y + box.height * from[1],
  );
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], {
    steps: 12,
  });
  await page.mouse.up();
}

async function goToPage(page: Page, pageNumber: number) {
  await pageInput(page).fill(String(pageNumber));
  await pageInput(page).press("Enter");
  await expect(pageInput(page)).toHaveValue(String(pageNumber));
}

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

async function closeAll(...mounted: MountedPage[]) {
  for (const item of mounted) await item.context.close();
}

// ---- Tests ----------------------------------------------------------------

test("ROOM-TOOLS-FILES-02 presents in one tap, syncs pen and highlighter ink, and keeps A's ink across A → B → A", async ({
  browser,
}) => {
  const teacher = await mountClassroom(browser, "teacher");
  const student = await mountClassroom(browser, "student");
  await startPresentation(teacher.page, student.page, "De-A.pdf");

  // The student has no ink tools in view mode.
  await expect(inkToolbar(student.page)).toHaveCount(0);

  await inkTool(teacher.page, "Bút viết").click();
  await drawStroke(teacher.page, 1, [0.2, 0.3], [0.6, 0.35]);
  await inkTool(teacher.page, "Bút dạ quang").click();
  await drawStroke(teacher.page, 1, [0.15, 0.12], [0.7, 0.12]);
  await expect(inkPaths(teacher.page, 1)).toHaveCount(2);
  await expect(inkPaths(student.page, 1, "pen")).toHaveCount(1);
  await expect(inkPaths(student.page, 1, "highlighter")).toHaveCount(1);

  // A → B: the class follows the switch at once.
  await presentFromDrawer(teacher.page, "De-B.pdf");
  await expect(
    teacher.page.locator(".classroom-files-topbar__file"),
  ).toContainText("De-B.pdf");
  await expect(
    student.page.locator(".classroom-files-topbar__file"),
  ).toContainText("De-B.pdf", { timeout: 30_000 });
  await expect(student.page.locator("[data-page-frame]")).toHaveCount(3);
  await expectLive(student.page, "Đang xem giáo viên trình chiếu");
  await expect(inkPaths(student.page, 1)).toHaveCount(0);

  // B → A: the same presentation row, with all of A's ink.
  await presentFromDrawer(teacher.page, "De-A.pdf");
  await expect(
    student.page.locator(".classroom-files-topbar__file"),
  ).toContainText("De-A.pdf", { timeout: 30_000 });
  await expect(student.page.locator("[data-page-frame]")).toHaveCount(5);
  await expect(inkPaths(student.page, 1, "pen")).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(inkPaths(student.page, 1, "highlighter")).toHaveCount(1);
  await expect(inkPaths(teacher.page, 1)).toHaveCount(2);

  expect(teacher.errors).toEqual([]);
  expect(student.errors).toEqual([]);
  await closeAll(teacher, student);
});

test("ROOM-TOOLS-FILES-02 follows the teacher, hands control back on a manual scroll, hides pages by original number and locks follow", async ({
  browser,
}) => {
  const teacher = await mountClassroom(browser, "teacher");
  const student = await mountClassroom(browser, "student");
  await startPresentation(teacher.page, student.page, "De-A.pdf");
  await expect(followKey(student.page)).toHaveAttribute("aria-pressed", "true");

  // The teacher moves to page 3: a following student lands there too.
  await goToPage(teacher.page, 3);
  await expect(pageInput(student.page)).toHaveValue("3", { timeout: 15_000 });

  // The student reads on their own: "Tự xem" + "Quay về trang GV".
  await student.page.locator(".classroom-files-pages").focus();
  await student.page.keyboard.press("Home");
  await expect(pageInput(student.page)).toHaveValue("1");
  await expect(followKey(student.page)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  const back = student.page.getByRole("button", {
    name: "Quay về trang GV (Trang 3)",
  });
  await expect(back).toBeVisible();
  await back.click();
  await expect(pageInput(student.page)).toHaveValue("3");
  await expect(followKey(student.page)).toHaveAttribute("aria-pressed", "true");

  // A wheel scroll is a manual move too.
  const pages = student.page.locator(".classroom-files-pages");
  const box = await pages.boundingBox();
  await student.page.mouse.move(box!.x + box!.width / 2, box!.y + 200);
  await student.page.mouse.wheel(0, -600);
  await expect(followKey(student.page)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await followKey(student.page).click();
  await expect(followKey(student.page)).toHaveAttribute("aria-pressed", "true");
  await expect(pageInput(student.page)).toHaveValue("3");

  // Hide page 2 from students (the teacher still sees it, marked).
  await goToPage(teacher.page, 2);
  await expect(pageInput(student.page)).toHaveValue("2");
  await liveBar(teacher.page)
    .getByRole("button", { name: "Ẩn trang 2 với HS" })
    .click();
  await expect(
    teacher.page.locator('[data-page-frame="2"][data-hidden-for-students]'),
  ).toHaveCount(1);
  await expect(student.page.locator('[data-page-frame="2"]')).toHaveCount(0);
  await expect(student.page.locator("[data-page-frame]")).toHaveCount(4);
  await expect(
    student.page.getByRole("group", { name: "Trang 4", exact: true }),
  ).toHaveCount(1);
  await goToPage(teacher.page, 3);
  await expect(pageInput(student.page)).toHaveValue("3");

  // Ink on page 3 lands on the student's page 3 (original numbering).
  await inkTool(teacher.page, "Bút viết").click();
  await drawStroke(teacher.page, 3, [0.25, 0.4], [0.55, 0.45]);
  await expect(inkPaths(student.page, 3)).toHaveCount(1);
  await expect(inkPaths(student.page, 4)).toHaveCount(0);

  // Lock follow: the student is pinned to the teacher's page.
  await liveBar(teacher.page)
    .getByRole("button", { name: "Khóa theo dõi" })
    .click();
  await expect(liveBar(student.page)).toContainText("GV đang khóa theo dõi");
  await expect(followKey(student.page)).toBeDisabled();
  await expect(pageInput(student.page)).toBeDisabled();
  await student.page.locator(".classroom-files-pages").focus();
  await student.page.keyboard.press("Home");
  await expect(pageInput(student.page)).toHaveValue("3");
  await goToPage(teacher.page, 5);
  await expect(pageInput(student.page)).toHaveValue("5");

  expect(teacher.errors).toEqual([]);
  expect(student.errors).toEqual([]);
  await closeAll(teacher, student);
});

test("ROOM-TOOLS-FILES-02 rejects view writes on the runtime and ignores spoofed lasers while showing the presenter's", async ({
  browser,
}) => {
  const teacher = await mountClassroom(browser, "teacher");
  const student = await mountClassroom(browser, "student");
  await startPresentation(teacher.page, student.page, "De-A.pdf");
  const row = state.presentations.find((item) => item.status === "open")!;

  // A raw `view` connection from the student's browser tries to write ink
  // into the `pd_*` document and to fake the presenter's laser.
  const credential = `student.view.attack.${randomUUID()}`;
  state.tokens.set(credential, {
    actorId: PEOPLE.student.actorId,
    capability: "view",
    documentName: providerDocumentName(row.id),
    generation: row.generation,
  });
  await student.page.evaluate(
    async ({ credential: token, name, url }) => {
      const dynamicImport = new Function(
        "specifier",
        "return import(specifier)",
      ) as <Module>(specifier: string) => Promise<Module>;
      const text = (modulePath: string) =>
        fetch(modulePath).then((response) => response.text());
      const pick = (source: string, pattern: RegExp) => {
        const value = source.match(pattern)?.[1];
        if (!value) throw new Error(`Could not resolve ${String(pattern)}.`);
        return value;
      };
      const live = await text(
        "/src/features/classroom-tools/livePdfCollaboration.ts",
      );
      const clientIndex = pick(live, /from "([^"]*collaboration-client[^"]*)"/);
      const sessionSource = await text(
        clientIndex.replace(/index\.ts(\?.*)?$/u, "browserSession.ts"),
      );
      const authoritySource = await text(
        clientIndex.replace(/index\.ts(\?.*)?$/u, "pdfAnnotationAuthority.ts"),
      );
      /* eslint-disable @typescript-eslint/no-explicit-any -- untyped Vite deps */
      const provider = await dynamicImport<any>(
        pick(
          sessionSource,
          /from "([^"]*\/@hocuspocus_provider\.js\?v=[^"]+)"/,
        ),
      );
      const Y = await dynamicImport<any>(
        pick(authoritySource, /from "([^"]*\/yjs\.js\?v=[^"]+)"/),
      );
      const doc = new Y.Doc();
      const socket = new provider.HocuspocusProviderWebsocket({
        autoConnect: false,
        url,
      });
      let synced: () => void = () => undefined;
      const syncedPromise = new Promise<void>((resolve) => {
        synced = resolve;
      });
      const connection = new provider.HocuspocusProvider({
        document: doc,
        name,
        onSynced: () => synced(),
        sessionAwareness: true,
        token,
        websocketProvider: socket,
      });
      connection.attach();
      await socket.connect();
      await Promise.race([
        syncedPromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("sync timeout")), 15_000),
        ),
      ]);
      const pageMap = doc.getMap("pages").get("p:1");
      pageMap.set("zzattack0001", "1|pen|1|l|attackeractor1|AAAAAA");
      connection.setAwarenessField("pdfLaser", { page: 1, x: 0.5, y: 0.5 });
      (window as unknown as Record<string, unknown>).__attacker = {
        destroy: () => {
          connection.destroy();
          socket.destroy();
        },
      };
      /* eslint-enable @typescript-eslint/no-explicit-any */
    },
    {
      credential,
      name: providerDocumentName(row.id),
      url: providerUrl,
    },
  );

  // The runtime drops the read-only write; a real stroke still syncs.
  await inkTool(teacher.page, "Bút viết").click();
  await drawStroke(teacher.page, 1, [0.2, 0.5], [0.5, 0.55]);
  await expect(inkPaths(student.page, 1)).toHaveCount(1);
  await expect(inkPaths(teacher.page, 1)).toHaveCount(1);
  await expect(
    teacher.page.locator('[data-stroke-id="zzattack0001"]'),
  ).toHaveCount(0);
  await expect(
    student.page.locator('[data-stroke-id="zzattack0001"]'),
  ).toHaveCount(0);

  // The spoofed laser (stamped `view` by the server) is never drawn.
  await student.page.waitForTimeout(800);
  await expect(
    student.page.locator('[data-pdf-laser="presenter"]'),
  ).toHaveCount(0);

  // The presenter's laser (stamped `present`) is.
  await inkTool(teacher.page, "Laser chỉ bài").click();
  const surface = teacher.page.locator('[data-pdf-ink-page="1"]');
  const box = await surface.boundingBox();
  await teacher.page.mouse.move(
    box!.x + box!.width * 0.3,
    box!.y + box!.height * 0.3,
  );
  await teacher.page.mouse.move(
    box!.x + box!.width * 0.4,
    box!.y + box!.height * 0.32,
    {
      steps: 6,
    },
  );
  await expect(
    student.page.locator('[data-pdf-laser="presenter"]'),
  ).toHaveCount(1);
  await expect(
    student.page.getByRole("img", { name: "Laser của Thu Hà" }),
  ).toBeVisible();

  await student.page.evaluate(() =>
    (
      (window as unknown as Record<string, unknown>).__attacker as {
        destroy(): void;
      }
    ).destroy(),
  );
  expect(teacher.errors).toEqual([]);
  expect(student.errors).toEqual([]);
  await closeAll(teacher, student);
});

test("ROOM-TOOLS-FILES-02 grants drawing from People without reloading the PDF, keeps Follow while drawing, protects others' ink and revokes", async ({
  browser,
}) => {
  const teacher = await mountClassroom(browser, "teacher");
  const student = await mountClassroom(browser, "student");
  await startPresentation(teacher.page, student.page, "De-A.pdf");
  await inkTool(teacher.page, "Bút viết").click();
  await drawStroke(teacher.page, 1, [0.2, 0.3], [0.7, 0.3]);
  await expect(inkPaths(student.page, 1)).toHaveCount(1);

  // Mark the student's page frame: it must survive the capability swap.
  await student.page.evaluate(() => {
    const frame = document.querySelector('[data-page-frame="1"]');
    if (frame) (frame as unknown as Record<string, unknown>).__kept = true;
  });
  const fetchedBefore = state.storageBytes.get(DOC_A) ?? 0;

  await teacher.page.locator("#media-p406-control-roster").click();
  const drawer = teacher.page.getByRole("dialog", {
    name: "Người tham gia (2)",
  });
  await expect(drawer).toBeVisible();
  const row = teacher.page
    .getByRole("list", { name: "Học sinh" })
    .getByRole("listitem")
    .filter({ hasText: PEOPLE.student.name });
  await row.getByRole("button", { name: "Thao tác với Minh Anh" }).click();
  await teacher.page
    .getByRole("menuitem", { name: "Cho phép vẽ lên Tài liệu (10 phút)" })
    .click();
  await expect(
    row.getByRole("img", { name: "Đang được phép vẽ lên Tài liệu" }),
  ).toBeVisible();
  await drawer.getByRole("button", { name: "Đóng" }).click();

  // The student's session swaps to `edit` in place.
  await expectLive(student.page, "Bạn đang được phép vẽ tạm thời");
  await expect(inkToolbar(student.page)).toBeVisible();
  await expect(inkTool(student.page, "Laser chỉ bài")).toHaveCount(0);
  expect(
    await student.page.evaluate(
      () =>
        (
          document.querySelector('[data-page-frame="1"]') as unknown as Record<
            string,
            unknown
          > | null
        )?.__kept === true,
    ),
  ).toBe(true);
  expect(state.storageBytes.get(DOC_A) ?? 0).toBe(fetchedBefore);

  // Drawing never turns "Theo dõi GV" off.
  await inkTool(student.page, "Bút viết").click();
  await drawStroke(student.page, 1, [0.25, 0.42], [0.6, 0.45]);
  await expect(inkPaths(teacher.page, 1)).toHaveCount(2);
  await expect(followKey(student.page)).toHaveAttribute("aria-pressed", "true");

  // The eraser only removes the student's own ink.
  await inkTool(student.page, "Tẩy nét").click();
  await drawStroke(student.page, 1, [0.4, 0.29], [0.45, 0.31]);
  await expect(
    student.page.getByText("Bạn chỉ xóa được nét của chính mình."),
  ).toBeVisible();
  await expect(inkPaths(teacher.page, 1)).toHaveCount(2);
  await drawStroke(student.page, 1, [0.4, 0.43], [0.45, 0.44]);
  await expect(inkPaths(teacher.page, 1)).toHaveCount(1);
  await expect(followKey(student.page)).toHaveAttribute("aria-pressed", "true");

  // Revoke: back to view, still on the same page and PDF.
  await teacher.page.locator("#media-p406-control-roster").click();
  await row.getByRole("button", { name: "Thao tác với Minh Anh" }).click();
  await teacher.page
    .getByRole("menuitem", { name: "Thu hồi quyền vẽ Tài liệu" })
    .click();
  await expect(
    row.getByRole("img", { name: "Đang được phép vẽ lên Tài liệu" }),
  ).toHaveCount(0);
  await expectLive(student.page, "Đang xem giáo viên trình chiếu");
  await expect(inkToolbar(student.page)).toHaveCount(0);
  await expect(inkPaths(student.page, 1)).toHaveCount(1);
  expect(state.storageBytes.get(DOC_A) ?? 0).toBe(fetchedBefore);

  expect(teacher.errors).toEqual([]);
  expect(student.errors).toEqual([]);
  await closeAll(teacher, student);
});

test("ROOM-TOOLS-FILES-02 streams a 35 MiB PDF over HTTP Range without downloading it", async ({
  browser,
}) => {
  const teacher = await mountClassroom(browser, "teacher");
  await openFilesTool(teacher.page);
  await teacher.page.getByRole("button", { name: "Mở De-lon.pdf" }).click();
  const firstCanvas = teacher.page.locator('canvas[data-pdf-page="1"]');
  await expect(firstCanvas).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(
      () =>
        firstCanvas.evaluate(
          (canvas) => (canvas as HTMLCanvasElement).width > 0,
        ),
      { timeout: 60_000 },
    )
    .toBe(true);
  await expect(teacher.page.locator("[data-page-frame]")).toHaveCount(3);
  const total = bigPdf().byteLength;
  const transferred = state.storageBytes.get(DOC_BIG) ?? 0;
  expect(total).toBeGreaterThan(35 * 1024 * 1024);
  expect(transferred).toBeGreaterThan(0);
  expect(transferred).toBeLessThan(4 * 1024 * 1024);
  expect(state.rangeStatuses.length).toBeGreaterThan(0);
  expect(state.rangeStatuses.every((status) => status === 206)).toBe(true);
  expect(teacher.errors).toEqual([]);
  await closeAll(teacher);
});

test("ROOM-TOOLS-FILES-02 has no Axe violations while presenting with ink tools, and reflows at 320 px with forced colors", async ({
  browser,
}) => {
  const teacher = await mountClassroom(browser, "teacher");
  const student = await mountClassroom(browser, "student", {
    height: 640,
    width: 320,
  });
  await student.page.emulateMedia({
    forcedColors: "active",
    reducedMotion: "reduce",
  });
  await startPresentation(teacher.page, student.page, "De-A.pdf");
  await inkTool(teacher.page, "Bút viết").click();
  await drawStroke(teacher.page, 1, [0.2, 0.3], [0.6, 0.35]);
  await expect(inkPaths(student.page, 1)).toHaveCount(1);
  await expectNoViolations(teacher.page);

  // Grant the student, so the 320 px stage shows the ink toolbar too.
  await teacher.page.locator("#media-p406-control-roster").click();
  const row = teacher.page
    .getByRole("list", { name: "Học sinh" })
    .getByRole("listitem")
    .filter({ hasText: PEOPLE.student.name });
  await row.getByRole("button", { name: "Thao tác với Minh Anh" }).click();
  await teacher.page
    .getByRole("menuitem", { name: "Cho phép vẽ lên Tài liệu (10 phút)" })
    .click();
  await expect(
    row.getByRole("img", { name: "Đang được phép vẽ lên Tài liệu" }),
  ).toBeVisible();
  await expectNoViolations(teacher.page);

  await expectLive(student.page, "Bạn đang được phép vẽ tạm thời");
  await expect(inkToolbar(student.page)).toBeVisible();
  await student.page.locator(".classroom-files-pages").focus();
  await student.page.keyboard.press("End");
  await expect(
    student.page.getByRole("button", { name: /^Quay về trang GV/u }),
  ).toBeVisible();
  for (const locator of [
    modeButton(student.page, "Trình chiếu lớp"),
    modeButton(student.page, "Xem riêng"),
    followKey(student.page),
    student.page.getByRole("button", { name: /^Quay về trang GV/u }),
  ]) {
    await expect(locator).toBeVisible();
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  }
  expect(
    await student.page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  // At most 2 live page canvases on a phone.
  expect(
    await student.page.evaluate(
      () =>
        Array.from(
          document.querySelectorAll<HTMLCanvasElement>("canvas[data-pdf-page]"),
        ).filter((canvas) => canvas.width > 0).length,
    ),
  ).toBeLessThanOrEqual(2);
  await expectNoViolations(student.page);

  expect(teacher.errors).toEqual([]);
  expect(student.errors).toEqual([]);
  await closeAll(teacher, student);
});
