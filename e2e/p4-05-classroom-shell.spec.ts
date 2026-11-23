import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const fixturePath = "/__p4-05-classroom-shell-fixture";

test.skip(
  process.env.E2E_MODE === "staging",
  "The deterministic P4-05 shell fixture loads Vite source modules; provider-backed staging acceptance runs separately.",
);

interface FixtureOptions {
  canPublishCameraMicrophone?: boolean;
  canShareScreen?: boolean;
  canSubscribe?: boolean;
  participantCount: number;
  /**
   * ROOM-STUDIO-02: mount the shell like the real room page — Vietnamese or
   * English copy, server roster names, chat, whiteboard and host controls,
   * with cameras off so the avatars show. Defaults keep the P4-05 fixture.
   */
  studio?: { language: "en" | "vi" };
}

interface MediaProbeState {
  enumerateDevicesCalls: number;
  getUserMediaCalls: number;
}

interface BrowserReactModule {
  createElement(
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ): unknown;
}

interface BrowserReactDOMModule {
  createRoot(element: Element): { render(node: unknown): void };
}

interface BrowserCommonJSModule<Module> {
  default: Module;
}

interface BrowserComponentsModule {
  RoomContext: { Provider: unknown };
}

interface BrowserParticipant {
  readonly attributes: Readonly<Record<string, string>>;
}

interface BrowserRoom {
  readonly localParticipant: BrowserParticipant;
  readonly remoteParticipants: Map<string, BrowserParticipant>;
  simulateParticipants(options: {
    participants: { audio: boolean; count: number; video: boolean };
    publish: { audio: boolean; useRealTracks: boolean; video: boolean };
  }): Promise<void>;
}

interface BrowserLiveKitModule {
  LogLevel: { silent: unknown };
  Room: new (options: {
    adaptiveStream: boolean;
    dynacast: boolean;
    loggerName: string;
  }) => BrowserRoom;
  getLogger(name: string): { setLevel(level: unknown): void };
  setLogLevel(level: unknown): void;
}

interface BrowserShellModule {
  ClassroomMediaShell: unknown;
}

interface BrowserI18nModule {
  I18nProvider: unknown;
}

interface BrowserIconModule {
  PenTool: unknown;
}

declare global {
  interface Window {
    __p405Fixture?: {
      leaveCalls: number;
      participantCount: number;
    };
    __p405MediaProbe?: MediaProbeState;
  }
}

async function installFixtureDocument(page: Page) {
  await page.route(`**${fixturePath}`, async (route) => {
    await route.fulfill({
      body: [
        "<!doctype html>",
        '<html lang="en">',
        "<head>",
        '<meta charset="UTF-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
        "<title>P4-05 classroom shell fixture</title>",
        '<script type="module">',
        "import RefreshRuntime from '/@react-refresh';",
        "RefreshRuntime.injectIntoGlobalHook(window);",
        "window.$RefreshReg$ = () => {};",
        "window.$RefreshSig$ = () => (type) => type;",
        "window.__vite_plugin_react_preamble_installed__ = true;",
        "</script>",
        "</head>",
        '<body><div id="p405-fixture-root"></div></body>',
        "</html>",
      ].join(""),
      contentType: "text/html",
      headers: {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
      status: 200,
    });
  });
}

async function installMediaProbe(page: Page) {
  await page.addInitScript(() => {
    const state: MediaProbeState = {
      enumerateDevicesCalls: 0,
      getUserMediaCalls: 0,
    };
    const events = new EventTarget();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        addEventListener: events.addEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
        enumerateDevices: async () => {
          state.enumerateDevicesCalls += 1;
          return [];
        },
        getSupportedConstraints: () => ({}),
        getUserMedia: async () => {
          state.getUserMediaCalls += 1;
          throw new DOMException(
            "The deterministic shell fixture must not capture media.",
            "NotAllowedError",
          );
        },
        removeEventListener: events.removeEventListener.bind(events),
      },
    });
    Object.defineProperty(window, "RTCRtpReceiver", {
      configurable: true,
      value: class FixtureRTCRtpReceiver {
        playoutDelayHint: number | null = null;

        async getStats() {
          return new Map();
        }
      },
    });
    window.__p405MediaProbe = state;
  });
}

async function mountClassroomFixture(page: Page, options: FixtureOptions) {
  const sockets: string[] = [];
  const pageErrors: string[] = [];
  page.on("websocket", (socket) => {
    const hostname = new URL(socket.url()).hostname;
    if (hostname !== "127.0.0.1" && hostname !== "localhost") {
      sockets.push(socket.url());
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installFixtureDocument(page);
  await installMediaProbe(page);
  await page.goto(fixturePath);

  await page.evaluate(async (fixtureOptions) => {
    const dynamicImport = new Function(
      "specifier",
      "return import(specifier)",
    ) as <Module>(specifier: string) => Promise<Module>;
    const shellModulePath = "/src/features/media/ClassroomMediaShell.tsx";
    const transformedShell = await fetch(shellModulePath).then((response) => {
      if (!response.ok) {
        throw new Error(`Could not load the P4-05 shell: ${response.status}.`);
      }
      return response.text();
    });
    const dependencyPath = (pattern: RegExp, label: string) => {
      const path = transformedShell.match(pattern)?.[1];
      if (!path)
        throw new Error(`Could not resolve the ${label} fixture module.`);
      return path;
    };
    const reactPath = dependencyPath(
      /from "([^"]*\/react\.js\?v=[^"]+)"/,
      "React",
    );
    const reactDOMPath = "/@id/react-dom/client";
    const componentsPath = dependencyPath(
      /from "([^"]*\/@livekit_components-react\.js\?v=[^"]+)"/,
      "LiveKit components",
    );
    const liveKitPath = dependencyPath(
      /from "([^"]*\/livekit-client\.js\?v=[^"]+)"/,
      "LiveKit client",
    );
    const i18nPath = dependencyPath(
      /from "([^"]*\/src\/app\/i18n\.tsx(?:\?t=[^"]+)?)"/,
      "TutorHub i18n",
    );
    const iconsPath = dependencyPath(
      /from "([^"]*\/lucide-react\.js\?v=[^"]+)"/,
      "Lucide icons",
    );
    const [
      ReactImport,
      ReactDOMImport,
      components,
      livekit,
      shell,
      i18n,
      icons,
    ] = await Promise.all([
      dynamicImport<BrowserCommonJSModule<BrowserReactModule>>(reactPath),
      dynamicImport<BrowserCommonJSModule<BrowserReactDOMModule>>(reactDOMPath),
      dynamicImport<BrowserComponentsModule>(componentsPath),
      dynamicImport<BrowserLiveKitModule>(liveKitPath),
      dynamicImport<BrowserShellModule>(shellModulePath),
      dynamicImport<BrowserI18nModule>(i18nPath),
      dynamicImport<BrowserIconModule>(iconsPath),
      dynamicImport<unknown>("/src/styles.css"),
    ]);
    const React = ReactImport.default;
    const ReactDOM = ReactDOMImport.default;

    livekit.setLogLevel(livekit.LogLevel.silent);
    const room = new livekit.Room({
      adaptiveStream: true,
      dynacast: true,
      loggerName: "tutorhub-p405-browser-fixture",
    });
    livekit
      .getLogger("tutorhub-p405-browser-fixture")
      .setLevel(livekit.LogLevel.silent);

    const studio = fixtureOptions.studio;
    const publishLocalVideo =
      !studio && (fixtureOptions.canPublishCameraMicrophone ?? true);
    await room.simulateParticipants({
      participants: {
        audio: false,
        count:
          fixtureOptions.participantCount +
          (publishLocalVideo || studio ? 0 : 1),
        video: !studio,
      },
      publish: {
        // Studio: a silent dummy microphone (live) and no camera (avatar).
        audio: Boolean(studio),
        useRealTracks: false,
        video: publishLocalVideo,
      },
    });

    const vietnamese = studio?.language === "vi";
    const studioNames = vietnamese
      ? [
          "Thu Hà (Giáo viên)",
          "Minh Anh",
          "Gia Bảo",
          "Khánh Linh",
          "Đức Huy",
          "Ngọc Trâm",
        ]
      : [
          "Teacher Ha",
          "Minh Anh",
          "Gia Bao",
          "Khanh Linh",
          "Duc Huy",
          "Ngoc Tram",
        ];
    const participantKey = (index: number) =>
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const studioProps: Record<string, unknown> = {};
    if (studio) {
      [room.localParticipant, ...room.remoteParticipants.values()].forEach(
        (participant, index) => {
          Object.defineProperty(participant, "_attributes", {
            configurable: true,
            value: { "tutorhub.participant_key": participantKey(index + 1) },
            writable: true,
          });
        },
      );
      const noop = async () => undefined;
      studioProps.signals = {
        error: false,
        loading: false,
        mutating: false,
        refreshing: false,
        projection: {
          room_instance_id: "10000000-0000-4000-8000-000000000001",
          projection_version: 1,
          last_signal_sequence: 0,
          self_participant_key: participantKey(1),
          viewer_operations: {
            can_raise_hand: true,
            can_send_reaction: true,
            can_moderate_hands: true,
          },
          roster: Array.from(
            { length: fixtureOptions.participantCount },
            (_, index) => ({
              participant_key: participantKey(index + 1),
              roster_sequence: index + 1,
              display_name:
                studioNames[index] ??
                `${vietnamese ? "Học viên" : "Student"} ${index}`,
              instance_role: index === 0 ? "host" : "attendee",
              connection_state: "connected",
            }),
          ),
          raised_hands: [],
          reactions: { clusters: [], hidden_cluster_count: 0, summary: [] },
          server_time: new Date().toISOString(),
        },
        onLowerAllHands: noop,
        onLowerHand: noop,
        onResync: noop,
        onSendReaction: noop,
        onToggleHand: noop,
      };
      studioProps.moderation = {
        roomLocked: false,
        canLockRoom: true,
        canEndRoom: true,
        participantOperations: [],
        mutationState: { status: "idle" },
        providerEffect: { status: "idle" },
        onSetRoomLocked: noop,
        onEndRoom: noop,
        onPromoteCoHost: noop,
        onDemoteCoHost: noop,
        onRemoteMute: noop,
        onRemoveParticipant: noop,
      };
      studioProps.chat = React.createElement(
        "p",
        null,
        vietnamese ? "Chưa có tin nhắn." : "No messages yet.",
      );
      studioProps.tools = [
        {
          id: "whiteboard",
          icon: React.createElement(icons.PenTool),
          label: vietnamese ? "Mở bảng trắng" : "Open whiteboard",
          title: vietnamese ? "Bảng trắng" : "Whiteboard",
          content: React.createElement("div", {
            className: "room-studio-fixture-board",
            style: {
              flex: "1 1 auto",
              minHeight: "0",
              borderRadius: "10px",
              background:
                "repeating-linear-gradient(#ffffff 0 31px, #e5e7eb 31px 32px)",
            },
          }),
        },
      ];
    }

    const fixtureState = {
      leaveCalls: 0,
      participantCount: fixtureOptions.participantCount,
    };
    window.__p405Fixture = fixtureState;
    const rootElement = document.getElementById("p405-fixture-root");
    if (!rootElement) throw new Error("P4-05 fixture root is missing.");
    const root = ReactDOM.createRoot(rootElement);
    root.render(
      React.createElement(
        "main",
        { className: "media-p403-room media-p405-room", "data-theme": "dark" },
        React.createElement(
          i18n.I18nProvider,
          { initialLanguage: studio?.language ?? "en" },
          React.createElement(
            components.RoomContext.Provider,
            { value: room },
            React.createElement(shell.ClassroomMediaShell, {
              canPublishCameraMicrophone:
                fixtureOptions.canPublishCameraMicrophone ?? true,
              canShareScreen: fixtureOptions.canShareScreen ?? true,
              canSubscribe: fixtureOptions.canSubscribe ?? true,
              connectionStatus: "connected",
              onLeave: () => {
                fixtureState.leaveCalls += 1;
              },
              ...studioProps,
            }),
          ),
        ),
      ),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  }, options);

  await page.waitForTimeout(50);
  expect(pageErrors).toEqual([]);
  await expect(page.locator(".media-p405-shell")).toBeVisible();
  expect(sockets).toEqual([]);
}

async function readMediaProbe(page: Page) {
  return page.evaluate(() => window.__p405MediaProbe);
}

for (const participantCount of [2, 5, 25, 50]) {
  test(`P4-05 bounds the ${participantCount}-participant desktop fixture`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1_280, height: 900 });
    await mountClassroomFixture(page, { participantCount });

    const expectedVisible = Math.min(participantCount, 12);
    await expect(page.locator(".media-p405-grid > li")).toHaveCount(
      expectedVisible,
    );
    await expect(page.locator(".media-p405-tile video")).toHaveCount(
      expectedVisible,
    );
    await expect(page.locator(".media-p405-grid--capacity-12")).toBeVisible();
    await expect(
      page.getByText(
        `Page 1 of ${Math.max(1, Math.ceil(participantCount / 12))}`,
        { exact: true },
      ),
    ).toBeVisible();
    expect(await readMediaProbe(page)).toEqual({
      enumerateDevicesCalls: 0,
      getUserMediaCalls: 0,
    });
  });
}

test("P4-05 keeps pagination focus and toolbar roving deterministic", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_280, height: 900 });
  await mountClassroomFixture(page, { participantCount: 25 });

  const toolbar = page.getByRole("toolbar", { name: "Classroom controls" });
  const microphone = page.getByRole("button", { name: "Turn microphone on" });
  const camera = page.getByRole("button", { name: "Turn camera off" });
  await microphone.focus();
  await expect(microphone).toBeFocused();
  await toolbar.press("ArrowRight");
  await expect(camera).toBeFocused();
  await toolbar.press("End");
  await expect(
    page.getByRole("button", { name: "Active speaker" }),
  ).toBeFocused();
  await toolbar.press("Home");
  await expect(microphone).toBeFocused();

  const nextPage = page.getByRole("button", { name: "Next video page" });
  await nextPage.click();
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  await expect(nextPage).toBeFocused();
  await expect(page.locator(".media-p405-grid > li")).toHaveCount(12);
  await expect(page.locator(".media-p405-tile video")).toHaveCount(12);

  const leaveRoom = page.getByRole("button", { name: "Leave room" });
  await leaveRoom.click();
  const leaveDialog = page.getByRole("dialog", {
    name: "Leave the classroom?",
  });
  await expect(leaveDialog).toBeVisible();
  await leaveDialog
    .getByRole("button", { name: "Stay" })
    .filter({ hasText: "Stay" })
    .click();
  await expect(leaveRoom).toBeFocused();

  await leaveRoom.click();
  await page.getByRole("button", { name: "Leave classroom" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__p405Fixture?.leaveCalls))
    .toBe(1);
});

test("P4-05 reflows at 320 CSS pixels and 200% without accessibility violations", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await mountClassroomFixture(page, { participantCount: 50 });

  await expect(page.locator(".media-p405-grid--capacity-4")).toBeVisible();
  await expect(page.locator(".media-p405-grid > li")).toHaveCount(4);
  await expect(page.locator(".media-p405-tile video")).toHaveCount(4);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
  expect(
    (await new AxeBuilder({ page }).include(".media-p405-shell").analyze())
      .violations,
  ).toEqual([]);

  await page.setViewportSize({ width: 640, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "200%";
  });
  await expect(page.locator(".media-p405-grid--capacity-4")).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);

  await page.getByRole("button", { name: "Active speaker" }).click();
  const participantDrawerTrigger = page
    .locator("button")
    .filter({ hasText: "Open participant list" });
  await participantDrawerTrigger.click();
  await expect(participantDrawerTrigger).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.locator(".media-p405-drawer")).toBeVisible();
  await page
    .locator(".media-p405-drawer")
    .getByRole("button", { name: "Close" })
    .filter({ hasText: "Close" })
    .click();
  await expect(participantDrawerTrigger).toBeFocused();
});

test("P4-05 listen-only fixture never captures media and exposes no publish controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_280, height: 900 });
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await mountClassroomFixture(page, {
    canPublishCameraMicrophone: false,
    canShareScreen: false,
    canSubscribe: true,
    participantCount: 5,
  });

  await expect(
    page.getByText("Listen-only mode", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "You are in listen-only mode; camera and microphone publishing was not granted.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Turn microphone|Turn camera/i }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Share screen|Stop sharing screen/i }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Backgrounds and effects" }),
  ).toHaveCount(0);
  await expect(page.locator(".media-p405-tile video")).toHaveCount(5);
  expect(await readMediaProbe(page)).toEqual({
    enumerateDevicesCalls: 0,
    getUserMediaCalls: 0,
  });
  expect(
    (await new AxeBuilder({ page }).include(".media-p405-shell").analyze())
      .violations,
  ).toEqual([]);
});

// VIDEO-FX-01 (ADR-0041): Teams-style effects drawer inside the classroom.
// Set VIDEO_FX_SCREENSHOT_DIR to save a reference screenshot for review.
const fxScreenshotDir = process.env.VIDEO_FX_SCREENSHOT_DIR?.trim() ?? "";

test("VIDEO-FX-01 opens a right effects drawer without remounting camera tiles", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_280, height: 900 });
  await mountClassroomFixture(page, { participantCount: 5 });
  // Load the same global styles as the app entry plus the room layout, so the
  // drawer is measured as in production.
  await page.evaluate(async () => {
    const dynamicImport = new Function(
      "specifier",
      "return import(specifier)",
    ) as (specifier: string) => Promise<unknown>;
    await Promise.all([
      dynamicImport("/@id/@tutorhub/design-tokens/tokens.css"),
      dynamicImport("/@id/@tutorhub/ui/styles.css"),
      dynamicImport("/src/pages/ClassroomRoomStage.css"),
    ]);
  });

  // Tag the live tiles so a remount would be visible.
  const taggedTiles = await page.evaluate(() => {
    const videos = Array.from(
      document.querySelectorAll<HTMLVideoElement>(".media-p405-tile video"),
    );
    videos.forEach((video, index) => {
      video.dataset.fxProbe = String(index);
    });
    return videos.length;
  });
  expect(taggedTiles).toBe(5);

  // The control sits right after Devices; roving order is unchanged.
  const toolbar = page.getByRole("toolbar", { name: "Classroom controls" });
  const devices = page.getByRole("button", { name: "Devices" });
  const effects = page.getByRole("button", { name: "Backgrounds and effects" });
  await devices.focus();
  await toolbar.press("ArrowRight");
  await expect(effects).toBeFocused();
  await expect(effects).toHaveAttribute("id", "media-p405-control-effects");

  await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog", { name: "Backgrounds and effects" });
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute("data-theme", "dark");
  // Wait for the slide-in to settle at the right edge.
  await expect
    .poll(async () => {
      const box = await drawer.boundingBox();
      return box ? Math.round(box.x + box.width) : 0;
    })
    .toBe(1_280);
  const drawerBox = await drawer.boundingBox();
  expect(drawerBox!.width).toBeLessThanOrEqual(361);
  // Wide rooms give the drawer its width: the stage reflows beside it.
  const stageBox = await page.locator(".media-p405-stage").boundingBox();
  expect(stageBox!.x + stageBox!.width).toBeLessThanOrEqual(drawerBox!.x + 1);
  await expect(
    page.getByRole("button", { name: "Effects: None" }),
  ).toHaveAttribute("aria-expanded", "true");
  // Non-modal: no overlay and the classroom stays interactive behind it.
  await expect(page.locator(".th-dialog-overlay")).toHaveCount(0);
  await expect(drawer.getByLabel("Your camera")).toBeVisible();

  const library = drawer.getByRole("button", { name: "Library" });
  await library.click();
  await expect(library).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Effects: Library" }),
  ).toBeVisible();
  await drawer.getByRole("tab", { name: "Lighting" }).click();
  await drawer.getByText("Studio bright").click();
  await expect(
    drawer.getByRole("radio", { name: "Studio bright" }),
  ).toBeChecked();
  await drawer.getByRole("tab", { name: "Backgrounds" }).click();

  // Same tiles, never remounted by the drawer or the effect choice.
  expect(
    await page.evaluate(
      () =>
        document.querySelectorAll(".media-p405-tile video[data-fx-probe]")
          .length,
    ),
  ).toBe(5);
  expect(
    (
      await new AxeBuilder({ page })
        .include(".media-p405-effects-drawer")
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(
    (await new AxeBuilder({ page }).include(".media-p405-shell").analyze())
      .violations,
  ).toEqual([]);
  if (fxScreenshotDir) {
    await page.waitForTimeout(1_500);
    await page.screenshot({
      path: `${fxScreenshotDir}/classroom-effects-drawer.png`,
    });
  }

  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(effects).toBeFocused();
  expect(await readMediaProbe(page)).toEqual({
    enumerateDevicesCalls: 0,
    getUserMediaCalls: 0,
  });
});

// ROOM-STUDIO-02: adaptive cinema stage, captioned floating Dock and a minimal
// header, measured with the real tokens, UI styles and room stylesheet.
// Set ROOM_STUDIO_SCREENSHOT_DIR to save the six review screenshots.
const roomStudioScreenshotDir =
  process.env.ROOM_STUDIO_SCREENSHOT_DIR?.trim() ?? "";

async function loadRoomStudioStyles(page: Page) {
  await page.evaluate(async () => {
    const dynamicImport = new Function(
      "specifier",
      "return import(specifier)",
    ) as (specifier: string) => Promise<unknown>;
    await Promise.all([
      dynamicImport("/@id/@tutorhub/design-tokens/tokens.css"),
      dynamicImport("/@id/@tutorhub/ui/styles.css"),
      dynamicImport("/src/pages/ClassroomRoomStage.css"),
    ]);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}

async function saveRoomStudioScreenshot(page: Page, name: string) {
  if (!roomStudioScreenshotDir) return;
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${roomStudioScreenshotDir}/${name}` });
}

async function gridTileBoxes(page: Page) {
  return page
    .locator(".media-p405-grid .media-p405-tile")
    .evaluateAll((tiles) =>
      tiles.map((tile) => {
        const box = tile.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      }),
    );
}

async function stageOverflow(page: Page) {
  return page
    .locator(".media-p405-stage")
    .evaluate((stage) => stage.scrollHeight - stage.clientHeight);
}

test("ROOM-STUDIO-02 centres one large 16:9 tile under a captioned floating Dock", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await mountClassroomFixture(page, {
    participantCount: 1,
    studio: { language: "vi" },
  });
  await loadRoomStudioStyles(page);

  await expect(page.locator(".media-p405-grid")).toHaveAttribute(
    "data-tile-count",
    "1",
  );
  const [tile] = await gridTileBoxes(page);
  expect(tile!.width).toBeGreaterThanOrEqual(760);
  expect(Math.abs(tile!.width / tile!.height - 16 / 9)).toBeLessThan(0.02);
  expect(Math.abs(tile!.x + tile!.width / 2 - 720)).toBeLessThanOrEqual(16);
  expect(await stageOverflow(page)).toBeLessThanOrEqual(1);

  // Header: a live clock hidden from AT beside the unchanged status line.
  const clock = page.locator(".media-p405-session-clock");
  await expect(clock).toHaveAttribute("aria-hidden", "true");
  await expect(clock).toHaveText(/^\d{2}:\d{2}$/);
  await expect(
    page.getByText("Đã kết nối / 1 người tham gia", { exact: true }),
  ).toBeVisible();

  // Dock: centred, captioned, split into four clusters, nothing overflows.
  const footer = page.locator(".media-p405-footer");
  const footerBox = await footer.boundingBox();
  expect(
    Math.abs(footerBox!.x + footerBox!.width / 2 - 720),
  ).toBeLessThanOrEqual(2);
  const toolbar = page.getByRole("toolbar", { name: "Điều khiển phòng học" });
  for (const caption of [
    "Micro",
    "Camera",
    "Chia sẻ",
    "Thiết bị",
    "Hiệu ứng",
    "Giơ tay",
    "Cảm xúc",
    "Trò chuyện",
    "Bảng trắng",
    "Thành viên",
    "Bố cục",
  ]) {
    await expect(
      toolbar.locator(".media-p405-dock-caption", { hasText: caption }),
    ).toBeVisible();
  }
  // Captions are decorative: the full accessible names are unchanged.
  await expect(
    toolbar.getByRole("button", { name: "Tắt micro", exact: true }),
  ).toBeVisible();
  await expect(
    toolbar.getByRole("button", { name: "Bật camera", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".media-p405-dock-divider:visible")).toHaveCount(3);
  expect(
    await footer.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);

  const leave = page.getByRole("button", { name: "Rời phòng", exact: true });
  await expect(leave).toHaveCSS("background-color", "rgb(220, 38, 38)");
  await expect(leave).toHaveCSS("color", "rgb(255, 255, 255)");
  const leaveBox = await leave.boundingBox();
  expect(leaveBox!.x + leaveBox!.width).toBeLessThanOrEqual(
    footerBox!.x + footerBox!.width,
  );
  await expect(
    page.getByRole("button", { name: "Kết thúc phòng", exact: true }),
  ).toHaveCSS("background-color", "rgb(220, 38, 38)");
  expect(
    (await new AxeBuilder({ page }).include(".media-p405-shell").analyze())
      .violations,
  ).toEqual([]);
  await saveRoomStudioScreenshot(page, "01-room-solo-vi-1440x900.png");

  // The captioned Dock still fits one row on a 1024px laptop.
  await page.setViewportSize({ width: 1_024, height: 768 });
  await expect(
    toolbar.locator(".media-p405-dock-caption", { hasText: "Trò chuyện" }),
  ).toBeVisible();
  const compactFooter = await footer.boundingBox();
  expect(compactFooter!.height).toBeLessThanOrEqual(72);
  expect(compactFooter!.x).toBeGreaterThanOrEqual(0);
  expect(compactFooter!.x + compactFooter!.width).toBeLessThanOrEqual(1_024);
});

test("ROOM-STUDIO-02 seats a one-to-one lesson side by side at the stage centre", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await mountClassroomFixture(page, {
    participantCount: 2,
    studio: { language: "vi" },
  });
  await loadRoomStudioStyles(page);

  await expect(page.locator(".media-p405-grid")).toHaveAttribute(
    "data-tile-count",
    "2",
  );
  const [teacher, student] = await gridTileBoxes(page);
  expect(Math.abs(teacher!.y - student!.y)).toBeLessThanOrEqual(2);
  expect(teacher!.x + teacher!.width).toBeLessThan(student!.x);
  expect(teacher!.width).toBeGreaterThanOrEqual(560);
  expect(Math.abs(student!.width / student!.height - 16 / 9)).toBeLessThan(
    0.02,
  );
  expect(
    Math.abs((teacher!.x + student!.x + student!.width) / 2 - 720),
  ).toBeLessThanOrEqual(16);
  expect(await stageOverflow(page)).toBeLessThanOrEqual(1);
  await saveRoomStudioScreenshot(page, "02-room-duo-vi-1440x900.png");
});

test("ROOM-STUDIO-02 fits five people in a centred 3 × 2 grid without scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await mountClassroomFixture(page, {
    participantCount: 5,
    studio: { language: "vi" },
  });
  await loadRoomStudioStyles(page);

  await expect(page.locator(".media-p405-grid")).toHaveAttribute(
    "data-tile-count",
    "5",
  );
  const boxes = await gridTileBoxes(page);
  expect(boxes).toHaveLength(5);
  const [first, , third, fourth, fifth] = boxes;
  expect(Math.abs(first!.y - third!.y)).toBeLessThanOrEqual(2);
  expect(Math.abs(fourth!.y - fifth!.y)).toBeLessThanOrEqual(2);
  expect(fourth!.y).toBeGreaterThan(first!.y);
  // The incomplete last row is centred under the first.
  const topCentre = (first!.x + third!.x + third!.width) / 2;
  const bottomCentre = (fourth!.x + fifth!.x + fifth!.width) / 2;
  expect(Math.abs(topCentre - bottomCentre)).toBeLessThanOrEqual(2);
  expect(Math.abs(topCentre - 720)).toBeLessThanOrEqual(16);
  expect(await stageOverflow(page)).toBeLessThanOrEqual(1);
  await saveRoomStudioScreenshot(page, "03-room-group5-vi-1440x900.png");
});

test("ROOM-STUDIO-02 opens the whiteboard stage beside a 256px camera strip without remounting tiles", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await mountClassroomFixture(page, {
    participantCount: 4,
    studio: { language: "vi" },
  });
  await loadRoomStudioStyles(page);
  const tagged = await page.evaluate(() => {
    const tiles = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".media-p405-grid .media-p405-tile",
      ),
    );
    tiles.forEach((tile, index) => {
      tile.dataset.studioProbe = String(index);
    });
    return tiles.length;
  });
  expect(tagged).toBe(4);

  const board = page.getByRole("button", { name: "Mở bảng trắng" });
  await board.click();
  await expect(board).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("heading", { name: "Bảng trắng", level: 2 }),
  ).toBeFocused();
  const toolBox = await page.locator(".media-p506-tool-stage").boundingBox();
  const stripBox = await page.locator(".media-p405-stage").boundingBox();
  expect(Math.abs(stripBox!.width - 256)).toBeLessThanOrEqual(2);
  expect(toolBox!.x + toolBox!.width).toBeLessThanOrEqual(stripBox!.x);
  expect(toolBox!.width).toBeGreaterThanOrEqual(1_000);
  const [stripTile] = await gridTileBoxes(page);
  expect(Math.abs(stripTile!.width / stripTile!.height - 16 / 9)).toBeLessThan(
    0.03,
  );
  expect(
    await page.evaluate(
      () =>
        document.querySelectorAll(".media-p405-tile[data-studio-probe]").length,
    ),
  ).toBe(4);
  expect(
    (await new AxeBuilder({ page }).include(".media-p405-shell").analyze())
      .violations,
  ).toEqual([]);
  await saveRoomStudioScreenshot(page, "04-room-whiteboard-vi-1440x900.png");
});

test("ROOM-STUDIO-02 centres the device popover over the Dock beside the effects drawer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await mountClassroomFixture(page, {
    participantCount: 2,
    studio: { language: "vi" },
  });
  await loadRoomStudioStyles(page);

  await page.getByRole("button", { name: "Nền và hiệu ứng" }).click();
  const drawer = page.getByRole("dialog", { name: "Nền và hiệu ứng" });
  await expect(drawer).toBeVisible();
  await expect
    .poll(async () => {
      const box = await drawer.boundingBox();
      return box ? Math.round(box.x + box.width) : 0;
    })
    .toBe(1_440);
  // The shared probe refuses capture; here the device list may ask for
  // permission, so grant an empty stream instead of showing a device error.
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => new MediaStream();
  });
  const devices = page.getByRole("button", { name: "Thiết bị", exact: true });
  await devices.click();
  await expect(devices).toHaveAttribute("aria-expanded", "true");
  await expect(drawer).toBeVisible();

  const panel = page.locator(".media-p405-device-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const panelBox = await panel.boundingBox();
  const footerBox = await page.locator(".media-p405-footer").boundingBox();
  const drawerBox = await drawer.boundingBox();
  const stageBox = await page.locator(".media-p405-stage").boundingBox();
  expect(
    Math.abs(
      panelBox!.x + panelBox!.width / 2 - (footerBox!.x + footerBox!.width / 2),
    ),
  ).toBeLessThanOrEqual(2);
  expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(footerBox!.y);
  expect(panelBox!.width).toBeLessThanOrEqual(561);
  expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(drawerBox!.x);
  expect(stageBox!.x + stageBox!.width).toBeLessThanOrEqual(drawerBox!.x + 1);
  await saveRoomStudioScreenshot(
    page,
    "05-room-effects-drawer-vi-1440x900.png",
  );
});

test("ROOM-STUDIO-02 reflows the studio room at 320 CSS pixels with forced colors and no violations", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await mountClassroomFixture(page, {
    participantCount: 2,
    studio: { language: "vi" },
  });
  await loadRoomStudioStyles(page);

  const horizontalOverflow = () =>
    page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
  expect(await horizontalOverflow()).toBeLessThanOrEqual(1);
  // Icon-only pills below 1024px, each a 44px touch target.
  await expect(page.locator(".media-p405-dock-caption").first()).toHaveCSS(
    "position",
    "absolute",
  );
  const controlHeights = await page
    .locator(".media-p405-footer .media-p405-dock-button")
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getBoundingClientRect().height),
    );
  expect(controlHeights.length).toBeGreaterThan(8);
  expect(Math.min(...controlHeights)).toBeGreaterThanOrEqual(44);
  const [teacher, student] = await gridTileBoxes(page);
  expect(student!.y).toBeGreaterThan(teacher!.y);
  expect(
    (await new AxeBuilder({ page }).include(".media-p405-shell").analyze())
      .violations,
  ).toEqual([]);
  await saveRoomStudioScreenshot(page, "06-room-mobile-vi-320x900.png");

  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  expect(await horizontalOverflow()).toBeLessThanOrEqual(1);
  await expect(page.locator(".media-p405-footer")).toHaveCSS(
    "border-top-style",
    "solid",
  );
  expect(
    (await new AxeBuilder({ page }).include(".media-p405-shell").analyze())
      .violations,
  ).toEqual([]);
});
