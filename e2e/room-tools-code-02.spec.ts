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
import { createRequire } from "node:module";
import path from "node:path";

/**
 * ROOM-TOOLS-CODE-02B (ADR-0043 Slice 2): the shared "Chung lớp" Code
 * workspace between a teacher page and a student page. Both pages mount the
 * real classroom shell, People panel and Code tool from Vite source modules;
 * the shared files travel through a real `@hocuspocus/server` (the patched
 * copy the whiteboard runtime uses) started inside this test process, whose
 * hooks emulate the runtime's `readOnly` view grants and its awareness
 * sanitizer (`user` rewrite + server-stamped `tutorhub.capability`). The
 * Core API routes answer from one in-test state shared by both pages.
 */
const fixturePath = "/__room-tools-code-02-fixture";
const TENANT_ID = "50000000-0000-4000-8000-000000000001";
const SPACE_ID = "40000000-0000-4000-8000-000000000001";
const ROOM_INSTANCE_ID = "60000000-0000-4000-8000-000000000001";
const CSRF_TOKEN = "room-tools-code-02-csrf-token";

test.skip(
  process.env.E2E_MODE === "staging",
  "The shared Code fixture loads Vite source modules and a local runtime.",
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

interface RuntimeScope {
  readonly actorId: string;
  readonly capability: Capability;
  readonly documentName: string;
  readonly generation: number;
}

interface WorkspaceState {
  generation: number;
  readonly id: string;
  revokeGeneration: number;
  status: "created" | "open" | "suspended" | "closed";
  version: number;
}

/** One classroom: the Core API projection both pages read. */
interface ClassroomState {
  readonly grants: Map<string, string>;
  readonly tokens: Map<string, RuntimeScope>;
  workspace: WorkspaceState | null;
}

/* Minimal structural types for the CommonJS `@hocuspocus/server` entry. */
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

interface AuthenticatePayload {
  readonly connectionConfig: { readOnly: boolean };
  readonly documentName: string;
  readonly token: string;
}

interface AwarenessPayload {
  readonly context?: RuntimeScope;
  readonly states: Map<number, Record<string, unknown>>;
}

declare global {
  interface Window {
    __sharedCodeFixture?: {
      editorText: () => string;
      selfCursorColor: () => string;
    };
  }
}

let state: ClassroomState;
let runtime: HocuspocusServer;
let providerUrl = "";

function loadHocuspocus(): HocuspocusModule {
  const fromRuntime = createRequire(
    path.resolve(__dirname, "../services/whiteboard-runtime/package.json"),
  );
  return fromRuntime("@hocuspocus/server") as HocuspocusModule;
}

function providerDocumentName(workspaceID: string): string {
  return `cw_${workspaceID.replaceAll("-", "")}`;
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
  const { Server } = loadHocuspocus();
  runtime = new Server({
    address: "127.0.0.1",
    port: 0,
    quiet: true,
    stopOnSignals: false,
    timeout: 30_000,
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
    async beforeHandleAwareness({ context, states }: AwarenessPayload) {
      if (!context) throw new Error("grant_denied");
      // The runtime sanitizer: clients may only keep a display name; the
      // server stamps who they are and what they may do.
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
  state = { grants: new Map(), tokens: new Map(), workspace: null };
});

function capabilityOf(role: Role): Capability {
  if (role === "teacher") return "present";
  return state.workspace?.status === "open" &&
    state.grants.has(PEOPLE.student.participantKey)
    ? "edit"
    : "view";
}

function workspaceView(role: Role) {
  const workspace = state.workspace;
  if (!workspace) return null;
  const teacher = role === "teacher";
  const open = workspace.status === "open";
  return {
    created_at: "2030-08-03T00:00:00Z",
    current_generation: workspace.generation,
    id: workspace.id,
    media_space_id: SPACE_ID,
    revoke_generation: workspace.revokeGeneration,
    status: workspace.status,
    updated_at: new Date().toISOString(),
    version: workspace.version,
    viewer_capabilities: {
      can_close: teacher && open,
      can_exchange_grant: open,
      can_manage_editor_grants: teacher && open,
      can_open: teacher && workspace.status === "created",
      can_resume: teacher && workspace.status === "suspended",
      can_suspend: teacher && open,
      capability: capabilityOf(role),
    },
  };
}

function projectionFor(role: Role) {
  const workspace = state.workspace;
  return {
    active_editor_grants:
      workspace?.status === "open"
        ? [...state.grants].map(([participant_key, expires_at]) => ({
            expires_at,
            participant_key,
          }))
        : [],
    can_create:
      role === "teacher" && (!workspace || workspace.status === "closed"),
    workspace: workspaceView(role),
  };
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
    body: JSON.stringify({ code, status, title: code }),
    contentType: "application/problem+json",
    status,
  });
}

/** The Core API for one page (its role decides every capability). */
async function installCoreApi(page: Page, role: Role) {
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const { pathname } = new URL(request.url());
    if (pathname === "/api/v1/auth/csrf" && method === "GET") {
      return json(route, { csrf_token: CSRF_TOKEN });
    }
    if (pathname === `/api/v1/media/spaces/${SPACE_ID}/code-workspace`) {
      if (method === "GET") return json(route, projectionFor(role));
      if (method === "POST" && role === "teacher") {
        state.workspace = {
          generation: 1,
          id: randomUUID(),
          revokeGeneration: 1,
          status: "created",
          version: 1,
        };
        state.grants.clear();
        return json(route, workspaceView(role), 201);
      }
      return problem(route, 403, "forbidden");
    }
    const match =
      /^\/api\/v1\/code-workspaces\/([0-9a-f-]{36})\/(open|suspend|resume|close|grant-exchanges|actor-grants\/[0-9a-f-]{36})$/u.exec(
        pathname,
      );
    const workspace = state.workspace;
    if (!match || !workspace || match[1] !== workspace.id) {
      return problem(route, 404, "not_found");
    }
    const action = match[2] as string;
    if (request.headers()["x-csrf-token"] !== CSRF_TOKEN) {
      return problem(route, 403, "csrf_invalid");
    }
    if (action === "grant-exchanges" && method === "POST") {
      const body = request.postDataJSON() as { capability: Capability };
      if (
        workspace.status !== "open" ||
        body.capability !== capabilityOf(role)
      ) {
        return problem(route, 403, "code_workspace_grant_denied");
      }
      const credential = `${role}.${body.capability}.${randomUUID()}`;
      state.tokens.set(credential, {
        actorId: PEOPLE[role].actorId,
        capability: body.capability,
        documentName: providerDocumentName(workspace.id),
        generation: workspace.generation,
      });
      return json(route, {
        capability: body.capability,
        credential,
        document_id: workspace.id,
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        generation: workspace.generation,
        provider_url: providerUrl,
        revoke_generation: workspace.revokeGeneration,
      });
    }
    if (role !== "teacher") return problem(route, 403, "forbidden");
    if (action.startsWith("actor-grants/")) {
      const participantKey = action.slice("actor-grants/".length);
      if (method === "PUT") {
        const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
        state.grants.set(participantKey, expiresAt);
        return json(route, {
          expires_at: expiresAt,
          participant_key: participantKey,
        });
      }
      if (method === "DELETE") {
        state.grants.delete(participantKey);
        // Revoking fences every older provider session of that workspace.
        workspace.revokeGeneration += 1;
        return route.fulfill({ status: 204 });
      }
    }
    if (method === "POST") {
      workspace.status =
        action === "open" || action === "resume"
          ? "open"
          : action === "suspend"
            ? "suspended"
            : "closed";
      workspace.version += 1;
      return json(route, workspaceView(role));
    }
    return problem(route, 405, "method_not_allowed");
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
        "<title>ROOM-TOOLS-CODE-02 fixture</title>",
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
  viewport = { height: 900, width: 1440 },
): Promise<MountedPage> {
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:5173",
    locale: "vi-VN",
    // The fixture document is fulfilled by `page.route` (no network
    // address), so Chromium's Local Network Access checks would treat it as
    // public and block the loopback runtime WebSocket.
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
      const shellPath = "/src/features/media/ClassroomMediaShell.tsx";
      const workspacesPath = "/src/app/codeWorkspaces.ts";
      const [shellSource, editorSource, workspacesSource] = await Promise.all([
        source(shellPath),
        source("/src/features/classroom-tools/codeEditor.ts"),
        source(workspacesPath),
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
        workspaces,
        grantsContext,
        presence,
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
        dynamicImport<any>(workspacesPath),
        dynamicImport<any>(
          "/src/features/classroom-tools/codeEditorGrantsContext.ts",
        ),
        dynamicImport<any>("/src/features/classroom-tools/codePresence.ts"),
        dynamicImport<any>(
          pick(
            editorSource,
            /from "([^"]*\/@codemirror_view\.js\?v=[^"]+)"/,
            "CodeMirror view",
          ),
        ),
        dynamicImport<any>(
          pick(
            workspacesSource,
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
        loggerName: "room-tools-code-02-fixture",
      });
      livekit
        .getLogger("room-tools-code-02-fixture")
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
      const codeRoster = {
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
      const session = codeSession.createClassroomCodeSession();
      const queryClient = new query.QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      // The room page's ROOM-TOOLS-CODE-02B wiring (MediaSpaceRoomPage):
      // projection poll, auto-open key and the People panel's grants.
      const Room = () => {
        const tool = workspaces.useCodeWorkspaceTool(
          fixture.tenantID,
          fixture.spaceID,
          true,
          { pollIntervalMs: 500 },
        );
        const projection = tool.isSuccess ? tool.data : undefined;
        const workspace = projection?.workspace ?? null;
        const put = workspaces.usePutCodeWorkspaceEditorGrant(
          fixture.tenantID,
          fixture.spaceID,
        );
        const revoke = workspaces.useDeleteCodeWorkspaceEditorGrant(
          fixture.tenantID,
          fixture.spaceID,
        );
        const [grantError, setGrantError] = React.useState(null);
        const [pendingKey, setPendingKey] = React.useState(null);
        const autoOpenKey =
          workspace?.status === "open" &&
          workspace.viewer_capabilities.can_exchange_grant
            ? `${workspace.id}:${workspace.current_generation}`
            : null;
        const grants =
          workspace === null
            ? null
            : {
                activeParticipantKeys: new Set(
                  projection.active_editor_grants.map(
                    (grant: { participant_key: string }) =>
                      grant.participant_key,
                  ),
                ),
                canManage:
                  workspace.status === "open" &&
                  workspace.viewer_capabilities.can_manage_editor_grants,
                error: grantError,
                maxEditors: workspaces.CODE_WORKSPACE_MAX_EDITORS,
                pendingParticipantKey: pendingKey,
                onDismissError: () => setGrantError(null),
                onGrant: (participantKey: string) => {
                  setGrantError(null);
                  setPendingKey(participantKey);
                  put.mutate(
                    { participantKey, workspaceID: workspace.id },
                    {
                      onError: (error: unknown) =>
                        setGrantError(
                          workspaces.isCodeWorkspaceEditorLimitError(error)
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
                    { participantKey, workspaceID: workspace.id },
                    {
                      onError: () => setGrantError("failed"),
                      onSettled: () => setPendingKey(null),
                    },
                  );
                },
              };
        return h(
          grantsContext.ClassroomCodeEditorGrantsContext.Provider,
          { value: grants },
          h(shell.ClassroomMediaShell, {
            canPublishCameraMicrophone: true,
            canShareScreen: true,
            canSubscribe: true,
            connectionStatus: "connected",
            onLeave: () => undefined,
            onTerminalMediaCleanup: async () => undefined,
            roomTitle: "Lớp 10A1 · Tin học",
            signals,
            tools: [
              {
                autoOpenKey,
                content: h(codeTool.ClassroomCodeTool, {
                  actorID: self.actorId,
                  chatCanPost: true,
                  codeRoster,
                  collaborationEnabled: true,
                  displayName: self.name,
                  enabled: true,
                  mediaSpaceID: fixture.spaceID,
                  session,
                  tenantID: fixture.tenantID,
                }),
                icon: h(icons.CodeXml),
                id: "code",
                label: "Code",
                title: "Công cụ Code",
              },
            ],
          }),
        );
      };

      const editorView = () => {
        const element = document.querySelector(".classroom-code .cm-editor");
        const found = element ? view.EditorView.findFromDOM(element) : null;
        if (!found) throw new Error("The Code editor is not mounted.");
        return found;
      };
      window.__sharedCodeFixture = {
        editorText: () => editorView().state.doc.toString(),
        selfCursorColor: () =>
          presence.codeCursorColor(
            presence.localPresenceIdentity(codeRoster, self.name).tone,
          ).color,
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

const codeStage = (page: Page) => page.locator("#media-p506-stage-code");
const liveBar = (page: Page) =>
  page.getByRole("group", { name: "Trạng thái buổi code chung" });
const modeButton = (page: Page, name: "Chung lớp" | "Nháp của tôi") =>
  page
    .getByRole("group", { name: "Chế độ Code" })
    .getByRole("button", { name: new RegExp(`^${name}`, "u") });
const fileTab = (page: Page, name: string) =>
  page
    .getByRole("group", { name: "Tệp trong phiên" })
    .getByRole("button", { exact: true, name });
const followKey = (page: Page) =>
  liveBar(page).getByRole("button", { name: "Theo dõi GV" });
const editorContent = (page: Page) =>
  page.locator(".classroom-code .cm-content");
const runButton = (page: Page) => page.locator(".classroom-code-run");
const runStatus = (page: Page) =>
  page.locator(".classroom-code-output__status");
const output = (page: Page) => page.locator(".classroom-code-output__pre");

async function editorText(page: Page) {
  return page.evaluate(() => window.__sharedCodeFixture?.editorText() ?? "");
}

async function expectEditorText(page: Page, matcher: (text: string) => void) {
  await expect(async () => matcher(await editorText(page))).toPass({
    timeout: 15_000,
  });
}

/** Caret at the end of the open file, then one input event (no autoclose). */
async function appendText(page: Page, text: string) {
  await editorContent(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(text);
}

async function runAndWait(page: Page, status: string, timeout = 90_000) {
  await runButton(page).click();
  await expect(runStatus(page)).toContainText(status, { timeout });
  await expect(runButton(page)).not.toHaveAttribute("data-running", "true");
}

async function openCodeTool(page: Page) {
  await page.locator("#media-p506-control-tools").click();
  await page.locator("#media-p506-tool-option-code").click();
  await expect(codeStage(page)).toBeVisible();
}

/** Teacher starts class coding; the student's stage opens on its own. */
async function startClassCoding(teacher: Page, student: Page) {
  await openCodeTool(teacher);
  await expect(modeButton(teacher, "Chung lớp")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await teacher
    .getByRole("button", { name: "Bắt đầu buổi code chung" })
    .click();
  await expect(liveBar(teacher)).toContainText(
    "Bạn đang trình bày — cả lớp thấy mã này",
    { timeout: 30_000 },
  );
  await expect(editorContent(teacher)).toBeVisible();

  await expect(codeStage(student)).toBeVisible({ timeout: 30_000 });
  await expect(modeButton(student, "Chung lớp")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(liveBar(student)).toContainText(
    "Chế độ xem — giáo viên đang giảng mẫu",
    { timeout: 30_000 },
  );
  await expectEditorText(student, (text) =>
    expect(text).toContain("def square(n: int) -> int:"),
  );
}

async function openPeople(page: Page) {
  await page.locator("#media-p406-control-roster").click();
  const drawer = page.getByRole("dialog", { name: "Người tham gia (2)" });
  await expect(drawer).toBeVisible();
  return drawer;
}

async function studentMenu(page: Page) {
  const row = page
    .getByRole("list", { name: "Học sinh" })
    .getByRole("listitem")
    .filter({ hasText: PEOPLE.student.name });
  await row.getByRole("button", { name: "Thao tác với Minh Anh" }).click();
  const menu = page.getByRole("menu", { name: "Thao tác với Minh Anh" });
  await expect(menu).toBeVisible();
  return { menu, row };
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

test("ROOM-TOOLS-CODE-02 syncs the teacher's live code, files and 8-tone cursor, and Follow teacher hands control back on a manual tab", async ({
  browser,
}) => {
  const teacher = await mountClassroom(browser, "teacher");
  const student = await mountClassroom(browser, "student");
  await startClassCoding(teacher.page, student.page);

  // Typing reaches the student in real time.
  await appendText(teacher.page, '\nprint("Tong:", 2 + 3)\n');
  await expectEditorText(student.page, (text) =>
    expect(text).toContain('print("Tong:", 2 + 3)'),
  );
  await expect(followKey(student.page)).toHaveAttribute("aria-pressed", "true");

  // A second file: the follower lands on the teacher's file.
  await teacher.page.getByRole("button", { name: "Thêm tệp" }).click();
  await teacher.page.getByRole("menuitem", { name: "Tệp Python" }).click();
  await expect(fileTab(teacher.page, "main-2.py")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(fileTab(student.page, "main-2.py")).toBeVisible();
  await expect(fileTab(student.page, "main-2.py")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await appendText(teacher.page, "\n# tep thu hai cua GV\n");
  await expectEditorText(student.page, (text) =>
    expect(text).toContain("# tep thu hai cua GV"),
  );

  // The teacher's caret and name label carry the teacher's 8-tone colour.
  const teacherColor = await teacher.page.evaluate(
    () => window.__sharedCodeFixture?.selfCursorColor() ?? "",
  );
  expect(teacherColor).toMatch(/^#[0-9a-f]{6}$/u);
  const caret = student.page.locator(".classroom-code .cm-ySelectionCaret");
  await expect(caret).toHaveCount(1);
  await expect(caret).toHaveAttribute(
    "style",
    new RegExp(`border-color: ${teacherColor}`, "u"),
  );
  await expect(caret.locator(".cm-ySelectionInfo")).toHaveText(
    PEOPLE.teacher.name,
  );
  // The tab shows who has it open (presenter stamped by the server).
  await expect(
    fileTab(student.page, "main-2.py").locator(
      ".classroom-code-presence-dot[data-presenter]",
    ),
  ).toHaveCount(1);

  // Choosing the first tab yourself turns Follow teacher off.
  await fileTab(student.page, "main.py").click();
  await expect(fileTab(student.page, "main.py")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(followKey(student.page)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await appendText(teacher.page, "# van o tep 2\n");
  await expectEditorText(teacher.page, (text) =>
    expect(text).toContain("# van o tep 2"),
  );
  await expect(fileTab(student.page, "main.py")).toHaveAttribute(
    "aria-current",
    "true",
  );

  expect(teacher.errors).toEqual([]);
  expect(student.errors).toEqual([]);
  await closeAll(teacher, student);
});

test("ROOM-TOOLS-CODE-02 keeps view read-only, runs in the student's sandbox and forks to My draft in one tap", async ({
  browser,
}) => {
  const teacher = await mountClassroom(browser, "teacher");
  const student = await mountClassroom(browser, "student");
  await startClassCoding(teacher.page, student.page);
  const shared = await editorText(teacher.page);

  // Typing in view mode changes nothing, anywhere.
  await editorContent(student.page).click();
  await student.page.keyboard.press("Control+End");
  await student.page.keyboard.type("hacked");
  await expect(editorContent(student.page)).toHaveAttribute(
    "aria-readonly",
    "true",
  );
  expect(await editorText(student.page)).toBe(shared);
  expect(await editorText(teacher.page)).toBe(shared);

  // ▶ Run still works: the class code runs in the student's own sandbox.
  await runAndWait(student.page, "Thành công");
  await expect(output(student.page)).toContainText("5² = 25");

  // "Tạo bản nháp từ mẫu" copies the class code into My draft.
  await liveBar(student.page)
    .getByRole("button", { name: "Tạo bản nháp từ mẫu" })
    .click();
  await expect(modeButton(student.page, "Nháp của tôi")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(liveBar(student.page)).toHaveCount(0);
  await expectEditorText(student.page, (text) => expect(text).toBe(shared));
  await expect(editorContent(student.page)).not.toHaveAttribute(
    "aria-readonly",
    "true",
  );
  await appendText(student.page, '\nprint("ban nhap cua HS")\n');
  await runAndWait(student.page, "Thành công");
  await expect(output(student.page)).toContainText("ban nhap cua HS");

  // The class workspace never changed.
  expect(await editorText(teacher.page)).toBe(shared);
  await modeButton(student.page, "Chung lớp").click();
  await expect(liveBar(student.page)).toContainText("Chế độ xem", {
    timeout: 30_000,
  });
  await expectEditorText(student.page, (text) => expect(text).toBe(shared));

  expect(teacher.errors).toEqual([]);
  expect(student.errors).toEqual([]);
  await closeAll(teacher, student);
});

test("ROOM-TOOLS-CODE-02 grants Code editing from People, keeps undo per person and revokes smoothly", async ({
  browser,
}) => {
  const teacher = await mountClassroom(browser, "teacher");
  const student = await mountClassroom(browser, "student");
  await startClassCoding(teacher.page, student.page);

  // Grant from the People panel (the teacher has no room moderation here).
  const drawer = await openPeople(teacher.page);
  let { menu, row } = await studentMenu(teacher.page);
  await menu
    .getByRole("menuitem", { name: "Cho phép sửa Code (10 phút)" })
    .click();
  await expect(
    row.getByRole("img", { name: "Đang được phép sửa Code" }),
  ).toBeVisible();
  await drawer.getByRole("button", { name: "Đóng" }).click();
  await expect(drawer).toBeHidden();

  // The student's session swaps to edit on its own.
  await expect(liveBar(student.page)).toContainText(
    "Bạn đang được quyền sửa tạm thời",
    { timeout: 30_000 },
  );
  await expect(codeStage(student.page)).toBeVisible();
  await expect(editorContent(student.page)).not.toHaveAttribute(
    "aria-readonly",
    "true",
  );

  // Teacher writes, then the student adds a function.
  await appendText(teacher.page, "\n# GV ghi chu\n");
  await expectEditorText(student.page, (text) =>
    expect(text).toContain("# GV ghi chu"),
  );
  // Past Y.UndoManager's capture window, so edits stay separate.
  await teacher.page.waitForTimeout(700);
  await appendText(student.page, "def tong(a, b):\n    return a + b\n");
  await expectEditorText(teacher.page, (text) =>
    expect(text).toContain("def tong(a, b):\n    return a + b\n"),
  );

  // Ctrl+Z on the teacher's editor undoes only the teacher's edit.
  await editorContent(teacher.page).click();
  await teacher.page.keyboard.press("Control+z");
  for (const page of [teacher.page, student.page]) {
    await expectEditorText(page, (text) => {
      expect(text).not.toContain("# GV ghi chu");
      expect(text).toContain("def tong(a, b):\n    return a + b\n");
    });
  }

  // Revoke: the student drops back to view, stays on stage, code intact.
  await openPeople(teacher.page);
  ({ menu, row } = await studentMenu(teacher.page));
  await menu.getByRole("menuitem", { name: "Thu hồi quyền sửa Code" }).click();
  await expect(
    row.getByRole("img", { name: "Đang được phép sửa Code" }),
  ).toHaveCount(0);
  await expect(liveBar(student.page)).toContainText(
    "Chế độ xem — giáo viên đang giảng mẫu",
    { timeout: 30_000 },
  );
  await expect(codeStage(student.page)).toBeVisible();
  await expect(modeButton(student.page, "Chung lớp")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(editorContent(student.page)).toHaveAttribute(
    "aria-readonly",
    "true",
  );
  await expectEditorText(student.page, (text) =>
    expect(text).toContain("def tong(a, b):\n    return a + b\n"),
  );
  await expect(
    student.page.getByText(
      "Quyền sửa tạm thời đã kết thúc — chuyển về chế độ xem.",
    ),
  ).toBeAttached();
  const before = await editorText(student.page);
  await editorContent(student.page).click();
  await student.page.keyboard.type("x");
  expect(await editorText(student.page)).toBe(before);

  expect(teacher.errors).toEqual([]);
  expect(student.errors).toEqual([]);
  await closeAll(teacher, student);
});

test("ROOM-TOOLS-CODE-02 has no Axe violations with a remote cursor and the edit badge, and reflows at 320 px with forced colors", async ({
  browser,
}) => {
  const teacher = await mountClassroom(browser, "teacher");
  const student = await mountClassroom(browser, "student");
  await startClassCoding(teacher.page, student.page);
  await appendText(teacher.page, "\n# con tro cua GV\n");
  await expect(
    student.page.locator(".classroom-code .cm-ySelectionCaret"),
  ).toHaveCount(1);
  await expectNoViolations(student.page);

  const drawer = await openPeople(teacher.page);
  const { menu, row } = await studentMenu(teacher.page);
  await menu
    .getByRole("menuitem", { name: "Cho phép sửa Code (10 phút)" })
    .click();
  await expect(
    row.getByRole("img", { name: "Đang được phép sửa Code" }),
  ).toBeVisible();
  await expect(drawer).toBeVisible();
  await expectNoViolations(teacher.page);
  await expect(liveBar(student.page)).toContainText(
    "Bạn đang được quyền sửa tạm thời",
    { timeout: 30_000 },
  );
  await expectNoViolations(student.page);
  await closeAll(teacher, student);

  // 320 CSS px with forced colors: the shared stage reflows.
  state = { grants: new Map(), tokens: new Map(), workspace: null };
  const narrowTeacher = await mountClassroom(browser, "teacher");
  const narrowStudent = await mountClassroom(browser, "student", {
    height: 720,
    width: 320,
  });
  await narrowStudent.page.emulateMedia({
    forcedColors: "active",
    reducedMotion: "reduce",
  });
  await startClassCoding(narrowTeacher.page, narrowStudent.page);
  for (const locator of [
    modeButton(narrowStudent.page, "Chung lớp"),
    modeButton(narrowStudent.page, "Nháp của tôi"),
    followKey(narrowStudent.page),
    liveBar(narrowStudent.page).getByRole("button", {
      name: "Tạo bản nháp từ mẫu",
    }),
  ]) {
    await expect(locator).toBeVisible();
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  }
  expect(
    await narrowStudent.page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expectNoViolations(narrowStudent.page);
  expect(narrowTeacher.errors).toEqual([]);
  expect(narrowStudent.errors).toEqual([]);
  await closeAll(narrowTeacher, narrowStudent);
});
