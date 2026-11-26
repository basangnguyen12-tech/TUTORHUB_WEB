import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

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
  studio?: {
    /** ROOM-COMPACT-05: the paper fixture's heading (scene text). */
    boardTitle?: string;
    language: "en" | "vi";
    /**
     * ROOM-COMPACT-05: `student` projects no Lock / End room authority, so
     * the Dock's end-call pill is a plain Leave key. Defaults to `host`.
     */
    role?: "host" | "student";
    /** ROOM-COMPACT-05: the lesson name shown in the Top Bar. */
    roomTitle?: string;
    /**
     * ROOM-CHAT-01: mount the production `ClassroomChatPanel` over a local
     * in-memory message store (no Core API) with seeded lesson messages.
     * `paused` projects the host posting switch off for the viewer.
     */
    chat?: { paused?: boolean };
    /**
     * WHITEBOARD-PAPER-01: mount the production `CanonicalExcalidrawCanvas`
     * over a real local `CanonicalExcalidrawAuthority` (Y.Doc, no grant, no
     * socket) instead of the static whiteboard placeholder.
     */
    whiteboard?: "paper";
    /**
     * ROOM-PEOPLE-03: a host People inspector — the production
     * `MediaLobbyPanel` over React Query (admissions JSON routed by the test,
     * no Core API), raised hands, a co-host, one reconnecting student and
     * server moderation operations for every student.
     */
    people?: {
      /** Roster indexes (0 = the host, you) with a raised hand, FIFO. */
      raisedHands?: number[];
      /** Roster index projected as `co_host`. */
      coHost?: number;
      /** Roster index projected as `reconnecting`. */
      reconnecting?: number;
      /**
       * ROOM-STAGE-POLISH-04: each roster index's newest unexpired reaction
       * (`participant_reactions`, top-right tile badge).
       */
      reactions?: { index: number; reaction: string }[];
      /** ROOM-STAGE-POLISH-04: room-level clusters that float up. */
      floating?: { reaction: string; count: number }[];
    };
  };
}

interface PaperFixtureElement {
  id: string;
  strokeColor?: unknown;
  type: string;
}

interface PaperFixtureAuthority {
  getScene(): {
    elements: PaperFixtureElement[];
    page: Record<string, unknown>;
  };
  initialize(scene: unknown): void;
}

interface BrowserWhiteboardEngineModule {
  CanonicalExcalidrawCanvas: unknown;
}

interface BrowserCollaborationModule {
  CanonicalExcalidrawAuthority: new (
    document: unknown,
    scope: { documentId: string; generation: number; tenantId: string },
    actorId: string,
  ) => PaperFixtureAuthority;
}

interface BrowserYjsModule {
  Doc: new () => unknown;
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
  useCallback<Callback>(callback: Callback, deps: unknown[]): Callback;
  useContext<Value>(context: unknown): Value;
  useEffect(effect: () => void | (() => void), deps?: unknown[]): void;
  useState<Value>(
    initial: Value | (() => Value),
  ): [Value, (next: Value | ((current: Value) => Value)) => void];
}

interface BrowserChatPanelModule {
  ClassroomChatPanel: unknown;
}

interface ChatFixtureAttachment {
  conversation_id: string;
  created_at: string;
  display_name: string;
  height_px?: number;
  id: string;
  kind: "image" | "file";
  media_type: string;
  size_bytes: number;
  width_px?: number;
}

interface ChatFixtureMessage {
  attachments?: ChatFixtureAttachment[];
  author: { display_name: string; user_id: string };
  client_message_id: string;
  content?: string;
  conversation_id: string;
  created_at: string;
  deleted_at?: string;
  edited_at?: string;
  id: string;
  sequence: number;
  state: "active" | "deleted";
  updated_at: string;
  version: number;
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
  ClassroomHeaderSlotContext: unknown;
  ClassroomMediaShell: unknown;
}

interface BrowserI18nModule {
  I18nProvider: unknown;
}

interface BrowserIconModule {
  PenTool: unknown;
}

interface BrowserQueryModule {
  QueryClient: new (options: {
    defaultOptions: { queries: { retry: boolean } };
  }) => { invalidateQueries(): Promise<void> };
  QueryClientProvider: unknown;
}

interface BrowserLobbyModule {
  MediaLobbyPanel: unknown;
  MediaLobbyWaitingCountProvider: unknown;
}

declare global {
  interface Window {
    __p405Fixture?: {
      leaveCalls: number;
      participantCount: number;
    };
    __p405MediaProbe?: MediaProbeState;
    __paperFixtureAuthority?: PaperFixtureAuthority;
    __roomPeopleFixture?: {
      refetch: () => Promise<void>;
    };
    __roomChatFixture?: {
      participantChatEnabled: () => boolean;
      receive: (content: string) => void;
      sent: () => number;
    };
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
      const people = studio.people;
      const rosterName = (index: number) =>
        studioNames[index] ?? `${vietnamese ? "Học viên" : "Student"} ${index}`;
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
            can_moderate_hands: studio.role !== "student",
          },
          roster: Array.from(
            { length: fixtureOptions.participantCount },
            (_, index) => ({
              participant_key: participantKey(index + 1),
              roster_sequence: index + 1,
              display_name: rosterName(index),
              instance_role:
                index === 0
                  ? "host"
                  : index === people?.coHost
                    ? "co_host"
                    : "attendee",
              connection_state:
                index === people?.reconnecting ? "reconnecting" : "connected",
            }),
          ),
          raised_hands: (people?.raisedHands ?? []).map(
            (index, queueIndex) => ({
              participant_key: participantKey(index + 1),
              signal_sequence: queueIndex + 1,
              raised_at: new Date(
                Date.now() - (10 - queueIndex) * 1_000,
              ).toISOString(),
              display_name: rosterName(index),
              queue_position: queueIndex + 1,
            }),
          ),
          participant_reactions: (people?.reactions ?? []).map(
            ({ index, reaction }, order) => ({
              participant_key: participantKey(index + 1),
              reaction,
              signal_sequence: 40 - order,
              accepted_at: new Date(Date.now() - 1_000).toISOString(),
              expires_at: new Date(Date.now() + 9_000).toISOString(),
            }),
          ),
          reactions: {
            clusters: (people?.floating ?? []).map(
              ({ reaction, count }, order) => ({
                cluster_id: `${reaction}:${10 + order * 5}`,
                reaction,
                count,
                count_label: count > 99 ? "99+" : String(count),
                first_signal_sequence: 10 + order * 5,
                last_signal_sequence: 10 + order * 5 + count - 1,
                accepted_at: new Date(Date.now() - 300).toISOString(),
                expires_at: new Date(Date.now() + 60_000).toISOString(),
              }),
            ),
            hidden_cluster_count: 0,
            summary: [],
          },
          server_time: new Date().toISOString(),
        },
        onLowerAllHands: noop,
        onLowerHand: noop,
        onResync: noop,
        onSendReaction: noop,
        onToggleHand: noop,
      };
      if (studio.roomTitle) studioProps.roomTitle = studio.roomTitle;
      const host = studio.role !== "student";
      studioProps.moderation = {
        roomLocked: false,
        canLockRoom: host,
        canEndRoom: host,
        // ROOM-PEOPLE-03: the server grants the host every operation on
        // students (never on the host's own row).
        participantOperations:
          people && host
            ? Array.from(
                { length: fixtureOptions.participantCount - 1 },
                (_, index) => ({
                  participantKey: participantKey(index + 2),
                  canPromoteCoHost: index + 1 !== people.coHost,
                  canDemoteCoHost: index + 1 === people.coHost,
                  canRemoteMute: true,
                  canRemove: true,
                }),
              )
            : [],
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
      let whiteboardContent: unknown = React.createElement("div", {
        className: "room-studio-fixture-board",
        style: {
          flex: "1 1 auto",
          minHeight: "0",
          borderRadius: "10px",
          background:
            "repeating-linear-gradient(#ffffff 0 31px, #e5e7eb 31px 32px)",
        },
      });
      if (studio.whiteboard === "paper") {
        const enginePath =
          "/src/features/collaboration/LazyWhiteboardEngine.tsx";
        const engineSource = await fetch(enginePath).then((response) =>
          response.text(),
        );
        const collaborationPath = engineSource.match(
          /from "([^"]*collaboration-client[^"]*)"/,
        )?.[1];
        if (!collaborationPath) {
          throw new Error("Could not resolve the collaboration client module.");
        }
        const authorityPath = collaborationPath.replace(
          /index\.ts(\?[^"]*)?$/,
          "canonicalAuthority.ts",
        );
        const authoritySource = await fetch(authorityPath).then((response) =>
          response.text(),
        );
        const yjsPath = authoritySource.match(
          /from "([^"]*\/yjs\.js\?v=[^"]+)"/,
        )?.[1];
        if (!yjsPath) throw new Error("Could not resolve the Yjs module.");
        const [engine, collaboration, Y] = await Promise.all([
          dynamicImport<BrowserWhiteboardEngineModule>(enginePath),
          dynamicImport<BrowserCollaborationModule>(collaborationPath),
          dynamicImport<BrowserYjsModule>(yjsPath),
        ]);
        const authority = new collaboration.CanonicalExcalidrawAuthority(
          new Y.Doc(),
          {
            documentId: "board-paper-fixture",
            generation: 1,
            tenantId: "tenant-paper-fixture",
          },
          "teacher-paper-fixture",
        );
        const ink = (sequence: number, element: Record<string, unknown>) => ({
          angle: 0,
          backgroundColor: "transparent",
          boundElements: null,
          fillStyle: "solid",
          frameId: null,
          groupIds: [],
          index: null,
          isDeleted: false,
          link: null,
          locked: false,
          opacity: 100,
          roughness: 1,
          roundness: null,
          seed: 4_200 + sequence,
          strokeStyle: "solid",
          strokeWidth: 2,
          updated: 1_788_000_000_000 + sequence,
          version: 1,
          versionNonce: 8_400 + sequence,
          ...element,
        });
        const title =
          studio.boardTitle ??
          (vietnamese ? "Bài 3 · Phân số" : "Lesson 3 · Fractions");
        authority.initialize({
          elements: [
            ink(1, {
              autoResize: true,
              containerId: null,
              fontFamily: 2,
              fontSize: 28,
              height: 35,
              id: "paper-title",
              lineHeight: 1.25,
              originalText: title,
              strokeColor: "#c2255c",
              text: title,
              textAlign: "left",
              type: "text",
              verticalAlign: "top",
              // Room for a longer ROOM-COMPACT-05 lesson heading.
              width: studio.boardTitle ? 640 : 280,
              x: 110,
              y: 40,
            }),
            ink(2, {
              backgroundColor: "#a5d8ff",
              fillStyle: "hachure",
              height: 110,
              id: "paper-box",
              strokeColor: "#1971c2",
              type: "rectangle",
              width: 220,
              x: 110,
              y: 120,
            }),
            ink(3, {
              elbowed: false,
              endArrowhead: "arrow",
              endBinding: null,
              height: 0,
              id: "paper-arrow",
              lastCommittedPoint: null,
              points: [
                [0, 0],
                [52, 0],
              ],
              startArrowhead: null,
              startBinding: null,
              strokeColor: "#e8590c",
              type: "arrow",
              width: 52,
              x: 344,
              y: 175,
            }),
            ink(4, {
              backgroundColor: "#b2f2bb",
              fillStyle: "solid",
              height: 110,
              id: "paper-circle",
              strokeColor: "#2f9e44",
              type: "ellipse",
              width: 140,
              x: 410,
              y: 120,
            }),
          ],
          files: {},
          page: {
            backgroundColor: "#ffffff",
            id: "page-paper-fixture",
            name: title,
          },
          schemaVersion: 1,
        });
        window.__paperFixtureAuthority = authority;
        // ROOM-COMPACT-05: like the production `ClassroomWhiteboardTool`, read
        // the room's Top Bar slot and hand it to the canvas in classroom mode,
        // so the paper picker is portalled into the Top Bar.
        const ClassroomPaperCanvas = () => {
          const slot = React.useContext<{ element: HTMLElement | null } | null>(
            shell.ClassroomHeaderSlotContext,
          );
          return React.createElement(engine.CanonicalExcalidrawCanvas, {
            authority,
            classroom: slot !== null,
            connectionStatus: "connected",
            readOnly: false,
            toolbarSlot: slot?.element ?? null,
          });
        };
        whiteboardContent = React.createElement(ClassroomPaperCanvas);
      }
      studioProps.tools = [
        {
          id: "whiteboard",
          icon: React.createElement(icons.PenTool),
          label: vietnamese ? "Bảng trắng" : "Whiteboard",
          title: vietnamese ? "Bảng trắng" : "Whiteboard",
          content: whiteboardContent,
        },
      ];
    }

    const fixtureState = {
      leaveCalls: 0,
      participantCount: fixtureOptions.participantCount,
    };
    window.__p405Fixture = fixtureState;

    // ROOM-PEOPLE-03: the production waiting room over React Query. The test
    // routes the admissions JSON; `refetch` stands in for the 2.5s poll.
    let wrapShell = (node: unknown) => node;
    if (studio?.people) {
      const lobbySource = await fetch("/src/app/mediaLobby.ts").then(
        (response) => response.text(),
      );
      const queryPath = lobbySource.match(
        /from "([^"]*\/@tanstack_react-query\.js\?v=[^"]+)"/,
      )?.[1];
      if (!queryPath) throw new Error("Could not resolve React Query.");
      const [query, lobbyModule] = await Promise.all([
        dynamicImport<BrowserQueryModule>(queryPath),
        dynamicImport<BrowserLobbyModule>(
          "/src/components/MediaLobbyPanel.tsx",
        ),
      ]);
      const client = new query.QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      window.__roomPeopleFixture = {
        refetch: () => client.invalidateQueries(),
      };
      const scope = {
        enabled: true,
        roomInstanceID: "10000000-0000-4000-8000-000000000001",
        roomInstanceVersion: 1,
        spaceID: "40000000-0000-4000-8000-000000000001",
        spaceVersion: 1,
        tenantID: "50000000-0000-4000-8000-000000000001",
      };
      studioProps.lobby = React.createElement(
        lobbyModule.MediaLobbyPanel,
        scope,
      );
      wrapShell = (node) =>
        React.createElement(
          query.QueryClientProvider,
          { client },
          React.createElement(
            lobbyModule.MediaLobbyWaitingCountProvider,
            scope,
            node,
          ),
        );
    }

    // ROOM-CHAT-01: a stateful room wrapper drives the real chat panel and
    // the Dock unread badge from an in-memory message store.
    let ChatRoom: unknown = null;
    if (studio?.chat) {
      const chatModule = await dynamicImport<BrowserChatPanelModule>(
        "/src/features/media/ClassroomChatPanel.tsx",
      );
      const conversationID = "20000000-0000-4000-8000-000000000001";
      const host = {
        display_name: studioNames[0] ?? "Teacher",
        user_id: participantKey(1),
      };
      const viewerIsHost = studio.role !== "student";
      const viewer = viewerIsHost
        ? host
        : {
            display_name: studioNames[1] ?? "Student",
            user_id: participantKey(2),
          };
      const drawWorksheet = () =>
        new Promise<Blob>((resolve) => {
          const canvas = document.createElement("canvas");
          canvas.width = 640;
          canvas.height = 420;
          const context = canvas.getContext("2d")!;
          context.fillStyle = "#fffdf7";
          context.fillRect(0, 0, 640, 420);
          context.strokeStyle = "#cbd5e1";
          for (let line = 70; line < 420; line += 34) {
            context.beginPath();
            context.moveTo(24, line);
            context.lineTo(616, line);
            context.stroke();
          }
          context.fillStyle = "#c2255c";
          context.font = "bold 30px sans-serif";
          context.fillText(
            vietnamese ? "Bài 3 · Phương trình" : "Lesson 3",
            32,
            50,
          );
          context.fillStyle = "#1e3a8a";
          context.font = "26px serif";
          context.fillText("x² − 5x + 6 = 0", 40, 128);
          context.fillText("Δ = 25 − 24 = 1", 40, 196);
          context.fillText("x₁ = 3 ;  x₂ = 2", 40, 264);
          context.strokeStyle = "#16a34a";
          context.lineWidth = 4;
          context.beginPath();
          context.arc(460, 230, 70, 0, Math.PI * 2);
          context.stroke();
          canvas.toBlob((blob) => resolve(blob!), "image/png");
        });
      const blobs = new Map<string, Blob>();
      const uploadedMeta = new Map<string, ChatFixtureAttachment>();
      const minutesAgo = (minutes: number) =>
        new Date(Date.now() - minutes * 60_000).toISOString();
      const worksheet = await drawWorksheet();
      const worksheetAttachment: ChatFixtureAttachment = {
        conversation_id: conversationID,
        created_at: minutesAgo(9),
        display_name: vietnamese ? "bai-3-minh-anh.png" : "lesson-3.png",
        height_px: 420,
        id: "30000000-0000-4000-8000-000000000001",
        kind: "image",
        media_type: "image/png",
        size_bytes: worksheet.size,
        width_px: 640,
      };
      blobs.set(worksheetAttachment.id, worksheet);
      const outline = new Blob(["%PDF-1.7\n% ROOM-CHAT-01 fixture\n%%EOF\n"], {
        type: "application/pdf",
      });
      const outlineAttachment: ChatFixtureAttachment = {
        conversation_id: conversationID,
        created_at: minutesAgo(4),
        display_name: vietnamese
          ? "De-cuong-on-tap-Chuong-2.pdf"
          : "Chapter-2-review.pdf",
        id: "30000000-0000-4000-8000-000000000002",
        kind: "file",
        media_type: "application/pdf",
        size_bytes: 1_258_291,
      };
      blobs.set(outlineAttachment.id, outline);
      let sequence = 0;
      const activeMessage = (
        author: { display_name: string; user_id: string },
        content: string,
        created_at: string,
        attachments: ChatFixtureAttachment[] = [],
      ): ChatFixtureMessage => {
        sequence += 1;
        return {
          attachments,
          author,
          client_message_id: crypto.randomUUID(),
          content,
          conversation_id: conversationID,
          created_at,
          id: crypto.randomUUID(),
          sequence,
          state: "active",
          updated_at: created_at,
          version: 1,
        };
      };
      const student = (index: number) => ({
        display_name: studioNames[index] ?? `Student ${index}`,
        user_id: participantKey(index + 1),
      });
      const seeded: ChatFixtureMessage[] = [
        activeMessage(
          student(1),
          vietnamese
            ? "Em chào cô ạ! Em gửi ảnh bài 3 nhé"
            : "Hi! Here is my lesson 3 photo",
          minutesAgo(9),
          [worksheetAttachment],
        ),
        activeMessage(
          student(2),
          vietnamese
            ? "Cô ơi phần b) em chưa hiểu cách đặt ẩn ạ"
            : "I am stuck on part b)",
          minutesAgo(7),
        ),
        activeMessage(student(3), "👍👏", minutesAgo(6)),
        activeMessage(
          host,
          vietnamese
            ? "Cả lớp xem đề cương ôn tập Chương 2 nhé: https://tutorhub.example/on-tap"
            : "Please review chapter 2: https://tutorhub.example/review",
          minutesAgo(4),
          [outlineAttachment],
        ),
      ];
      let sentCount = 0;
      const paused = Boolean(studio.chat.paused);
      ChatRoom = () => {
        const [open, setOpen] = React.useState(false);
        const [unread, setUnread] = React.useState(0);
        const [participantChatEnabled, setParticipantChatEnabled] =
          React.useState(!paused);
        const [messages, setMessages] =
          React.useState<ChatFixtureMessage[]>(seeded);
        const onChatOpenChange = React.useCallback((next: boolean) => {
          setOpen(next);
          if (next) setUnread(0);
        }, []);
        React.useEffect(() => {
          window.__roomChatFixture = {
            participantChatEnabled: () => participantChatEnabled,
            receive: (content: string) => {
              setMessages((current) => [
                ...current,
                activeMessage(host, content, new Date().toISOString()),
              ]);
              if (!open) setUnread((count) => count + 1);
            },
            sent: () => sentCount,
          };
        }, [open, participantChatEnabled]);
        const canModerate = viewerIsHost;
        const canPost = canModerate || participantChatEnabled;
        const conversation = {
          created_at: minutesAgo(30),
          id: conversationID,
          kind: "room",
          media_space_id: "40000000-0000-4000-8000-000000000001",
          media_space_status: "open",
          participant_chat_enabled: participantChatEnabled,
          participants: [],
          title: studio.roomTitle ?? "Classroom",
          unread_count: 0,
          unread_count_capped: false,
          updated_at: minutesAgo(1),
          viewer_access: {
            can_moderate_chat: canModerate,
            can_post_messages: canPost,
            can_upload_attachments: canPost,
          },
        };
        const chatNode = React.createElement(chatModule.ClassroomChatPanel, {
          actorID: viewer.user_id,
          conversation,
          hasOlder: false,
          loadAttachment: async (attachment: ChatFixtureAttachment) =>
            blobs.get(attachment.id) ?? new Blob([]),
          loadingOlder: false,
          messages,
          onDelete: async (message: ChatFixtureMessage) => {
            setMessages((current) =>
              current.map((item) =>
                item.id === message.id
                  ? {
                      ...item,
                      attachments: undefined,
                      content: undefined,
                      deleted_at: new Date().toISOString(),
                      state: "deleted",
                      version: item.version + 1,
                    }
                  : item,
              ),
            );
          },
          onEdit: async (message: ChatFixtureMessage, content: string) => {
            setMessages((current) =>
              current.map((item) =>
                item.id === message.id
                  ? {
                      ...item,
                      content,
                      edited_at: new Date().toISOString(),
                      version: item.version + 1,
                    }
                  : item,
              ),
            );
          },
          onLoadOlder: () => undefined,
          onSend: async (input: {
            attachmentIDs: string[];
            content: string;
          }) => {
            sentCount += 1;
            const attachments = input.attachmentIDs.flatMap((id) => {
              const blob = blobs.get(id);
              const meta = uploadedMeta.get(id);
              return blob && meta ? [meta] : [];
            });
            setMessages((current) => [
              ...current,
              activeMessage(
                viewer,
                input.content,
                new Date().toISOString(),
                attachments,
              ),
            ]);
          },
          onToggleParticipantChat: async (enabled: boolean) => {
            setParticipantChatEnabled(enabled);
          },
          onUpload: async (input: {
            clientAttachmentID: string;
            file: Blob;
            fileName: string;
            heightPx?: number;
            widthPx?: number;
          }) => {
            const image = input.file.type.startsWith("image/");
            const meta: ChatFixtureAttachment = {
              conversation_id: conversationID,
              created_at: new Date().toISOString(),
              display_name: input.fileName,
              height_px: image ? input.heightPx : undefined,
              id: input.clientAttachmentID,
              kind: image ? "image" : "file",
              media_type: input.file.type || "application/octet-stream",
              size_bytes: input.file.size,
              width_px: image ? input.widthPx : undefined,
            };
            blobs.set(meta.id, input.file);
            uploadedMeta.set(meta.id, meta);
            return meta;
          },
          open,
          tenantID: "50000000-0000-4000-8000-000000000001",
        });
        return React.createElement(shell.ClassroomMediaShell, {
          canPublishCameraMicrophone:
            fixtureOptions.canPublishCameraMicrophone ?? true,
          canShareScreen: fixtureOptions.canShareScreen ?? true,
          canSubscribe: fixtureOptions.canSubscribe ?? true,
          connectionStatus: "connected",
          onLeave: () => {
            fixtureState.leaveCalls += 1;
          },
          ...studioProps,
          chat: chatNode,
          chatUnreadCount: unread,
          onChatOpenChange,
        });
      };
    }
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
            wrapShell(
              ChatRoom
                ? React.createElement(ChatRoom)
                : React.createElement(shell.ClassroomMediaShell, {
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

/**
 * ROOM-TOOLS-CODE-01: one Classroom tools key in the Dock opens the tools
 * popover; its Whiteboard tile puts the board on the stage.
 */
async function openWhiteboardStage(page: Page) {
  await page.locator("#media-p506-control-tools").click();
  await page.locator("#media-p506-tool-option-whiteboard").click();
}

async function readMediaProbe(page: Page) {
  return page.evaluate(() => window.__p405MediaProbe);
}

/**
 * ROOM-COMPACT-05: the Dock's one round layout key opens a menu of
 * `menuitemradio` choices; picking one closes it and returns focus to the key.
 */
async function chooseLayout(
  page: Page,
  optionName: string,
  { keyboard = false }: { keyboard?: boolean } = {},
) {
  const layoutKey = page.locator("#media-p405-control-layout");
  const option = page.getByRole("menuitemradio", {
    name: optionName,
    exact: true,
  });
  if (keyboard) {
    // Enter opens the menu on its first choice; arrows rove to the target.
    await layoutKey.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitemradio").first()).toBeFocused();
    for (let step = 0; step < 3; step += 1) {
      if (await option.evaluate((item) => item === document.activeElement)) {
        break;
      }
      await page.keyboard.press("ArrowDown");
    }
    await expect(option).toBeFocused();
    await page.keyboard.press("Enter");
  } else {
    await layoutKey.click();
    await option.click();
  }
  await expect(page.getByRole("menuitemradio")).toHaveCount(0);
  await expect(layoutKey).toBeFocused();
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
  // ROOM-COMPACT-05: one round layout key ends the roving row.
  const layoutKey = page.locator("#media-p405-control-layout");
  await expect(layoutKey).toBeFocused();
  await expect(layoutKey).toHaveAccessibleName("Change layout");
  await expect(layoutKey).toHaveAttribute("aria-haspopup", "menu");
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

  // `zoom` on the root (this fixture's 200% emulation) doubles the floating
  // menu's offset in Radix positioning, which real browser zoom does not;
  // choose from the keyboard here. ROOM-COMPACT-05 checks the menu's pointer
  // placement at a real 320px viewport.
  await chooseLayout(page, "Active speaker", { keyboard: true });
  await expect(page.locator(".media-p405-tile--stage")).toBeVisible();
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
  // ROOM-COMPACT-05: the Dock key is the only effects control (no header pill).
  await expect(effects).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".media-p405-effects-badge")).toHaveCount(0);
  await expect(
    page.locator(".media-p405-header").getByRole("button", {
      name: /effects/i,
    }),
  ).toHaveCount(0);
  // Non-modal: no overlay and the classroom stays interactive behind it.
  await expect(page.locator(".th-dialog-overlay")).toHaveCount(0);
  await expect(drawer.getByLabel("Your camera")).toBeVisible();

  const library = drawer.getByRole("button", { name: "Library" });
  await library.click();
  await expect(library).toHaveAttribute("aria-pressed", "true");
  await expect(effects).toHaveAccessibleDescription("On: Library");
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
// ROOM-MACOS-03 adds the Liquid Glass material checks (translucent blur,
// specular rim, FaceTime corners, tactile press) on the same fixtures.
// Set ROOM_MACOS_SCREENSHOT_DIR (or the older ROOM_STUDIO_SCREENSHOT_DIR) to
// save the six review screenshots.
const roomStudioScreenshotDir =
  process.env.ROOM_MACOS_SCREENSHOT_DIR?.trim() ||
  process.env.ROOM_STUDIO_SCREENSHOT_DIR?.trim() ||
  "";

interface GlassStyle {
  backdropFilter: string;
  backgroundImage: string;
  borderTopLeftRadius: string;
  boxShadow: string;
  display: string;
}

/** Computed glass material of an element or of its `::before` layer. */
async function readGlass(
  locator: Locator,
  pseudo: "::before" | null = null,
): Promise<GlassStyle> {
  return locator.evaluate((element, pseudoElement) => {
    const style = getComputedStyle(element, pseudoElement);
    return {
      backdropFilter:
        style.backdropFilter ||
        style.getPropertyValue("-webkit-backdrop-filter"),
      backgroundImage: style.backgroundImage,
      borderTopLeftRadius: style.borderTopLeftRadius,
      boxShadow: style.boxShadow,
      display: style.display,
    };
  }, pseudo);
}

/**
 * Where `corner-shape: squircle` paints, the room scales each radius by 1.8
 * (Apple-style continuous corners); elsewhere the nominal radius applies.
 */
async function expectedCornerRadius(page: Page, nominal: number) {
  const squircle = await page.evaluate(() =>
    CSS.supports("corner-shape", "squircle"),
  );
  return `${squircle ? Math.round(nominal * 18) / 10 : nominal}px`;
}

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
    // Excalidraw's lazy bundle injects `.visually-hidden { position: absolute !important }`;
    // mirror it so Dock captions are proven immune to that global rule.
    const excalidrawRule = document.createElement("style");
    excalidrawRule.textContent =
      ".visually-hidden { position: absolute !important; width: 1px; height: 1px; overflow: hidden; }";
    document.head.append(excalidrawRule);
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

test("ROOM-STUDIO-02 centres one large 16:9 tile under an icon-only floating Dock", async ({
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

  // Top Bar: a live clock hidden from AT; the polite status keeps the full
  // sentence for AT while sighted users read the short count.
  const clock = page.locator(".media-p405-session-clock");
  await expect(clock).toHaveAttribute("aria-hidden", "true");
  await expect(clock).toHaveText(/^\d{2}:\d{2}$/);
  await expect(page.locator(".media-p405-presence-full")).toHaveText(
    "Đã kết nối / 1 người tham gia",
  );
  await expect(page.locator(".media-p405-presence-short")).toBeVisible();
  await expect(page.locator(".media-p405-presence-short")).toHaveText(
    "1 người",
  );

  // Dock (ROOM-MEET-DOCK-04 / ROOM-COMPACT-05): a centred 56px pill of
  // icon-only 42px round keys, no caption under any icon, nothing overflows.
  const footer = page.locator(".media-p405-footer");
  const footerBox = await footer.boundingBox();
  expect(
    Math.abs(footerBox!.x + footerBox!.width / 2 - 720),
  ).toBeLessThanOrEqual(2);
  expect(Math.round(footerBox!.height)).toBe(56);
  await expect(footer).toHaveCSS("border-top-left-radius", "999px");
  const toolbar = page.getByRole("toolbar", { name: "Điều khiển phòng học" });
  await expect(page.locator(".media-p405-dock-caption")).toHaveCount(0);
  const dockNames = [
    "Tắt micro",
    "Bật camera",
    "Chia sẻ màn hình",
    "Thiết bị",
    "Nền và hiệu ứng",
    "Giơ tay",
    "Gửi reaction",
    "Mở trò chuyện trong phòng",
    "Công cụ lớp học",
    "Bố cục",
    "Mở danh sách lớp học",
  ];
  for (const name of dockNames) {
    const key = toolbar.getByRole("button", { name, exact: true });
    await expect(key).toBeVisible();
    await expect(key).toHaveAttribute("data-tooltip", name);
    const box = await key.boundingBox();
    expect(Math.round(box!.width)).toBe(42);
    expect(Math.round(box!.height)).toBe(42);
    await expect(key).toHaveCSS("border-top-left-radius", "999px");
  }
  // Layout: one round key that opens a menu, no three-key groove.
  const layoutKey = toolbar.locator("#media-p405-control-layout");
  await expect(layoutKey).toHaveAttribute("data-media-control", "layout");
  await expect(layoutKey).toHaveAttribute("aria-haspopup", "menu");
  await expect(toolbar.locator(".media-p405-layout-pill")).toHaveCount(0);
  await expect(
    toolbar.getByRole("button", { name: "Người đang nói", exact: true }),
  ).toHaveCount(0);
  const micButton = toolbar.getByRole("button", {
    name: "Tắt micro",
    exact: true,
  });
  // One divider only, setting the ruby end-call pill apart.
  await expect(page.locator(".media-p405-dock-divider:visible")).toHaveCount(1);
  const dividerBox = await page
    .locator(".media-p405-dock-divider:visible")
    .first()
    .boundingBox();
  expect(Math.round(dividerBox!.height)).toBe(24);
  expect(
    await footer.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);

  // Leave: a ruby end-call pill, icon only. For a host it is the disclosure
  // of the End room / Leave room popover, named for both.
  const leave = page.locator("#media-p405-control-leave");
  await expect(leave).toHaveAccessibleName("Rời hoặc kết thúc phòng");
  await expect(leave).toHaveAttribute("aria-expanded", "false");
  await expect(leave).toHaveCSS("background-color", "rgb(220, 38, 38)");
  await expect(leave).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(leave).toHaveCSS("border-top-left-radius", "999px");
  await expect(leave.locator(".media-p405-sr-only")).toHaveText(
    "Rời hoặc kết thúc phòng",
  );
  await expect(leave.locator(".media-p405-sr-only")).toHaveCSS(
    "position",
    "absolute",
  );
  const leaveBox = await leave.boundingBox();
  expect(Math.round(leaveBox!.height)).toBe(42);
  expect(leaveBox!.width).toBeGreaterThanOrEqual(56);
  expect(leaveBox!.width).toBeGreaterThan(leaveBox!.height);
  expect(dividerBox!.x).toBeLessThan(leaveBox!.x);
  expect(leaveBox!.x + leaveBox!.width).toBeLessThanOrEqual(
    footerBox!.x + footerBox!.width,
  );
  // End room moved off the Top Bar into the (closed) end-call popover.
  await expect(
    page.getByRole("button", { name: "Kết thúc phòng", exact: true }),
  ).toHaveCount(0);

  // ROOM-MACOS-03: the Dock is Liquid Glass. The material sits on ::before so
  // the footer never becomes the Backdrop Root of the device popover.
  const dockGlass = await readGlass(footer, "::before");
  expect(dockGlass.backdropFilter).toMatch(/blur\(28px\)/);
  expect(dockGlass.backdropFilter).toMatch(/saturate\((1\.85|185%)\)/);
  expect(dockGlass.backgroundImage).toContain("linear-gradient");
  expect(dockGlass.boxShadow).toMatch(/inset/);
  const dockFrame = await readGlass(footer);
  expect(dockFrame.backdropFilter).toBe("none");
  expect(dockFrame.boxShadow).not.toBe("none");
  await expect(footer).toHaveCSS(
    "border-top-color",
    "rgba(255, 255, 255, 0.14)",
  );
  // Anodized ruby: the sheen is a background-image over the unchanged fill.
  expect((await readGlass(leave)).backgroundImage).toContain("linear-gradient");
  expect((await readGlass(leave)).boxShadow).toMatch(/inset/);
  // FaceTime framing: a solo tile gets the soft 20px corner and a rim.
  const soloTile = page.locator(".media-p405-grid .media-p405-tile").first();
  await expect(soloTile).toHaveCSS(
    "border-top-left-radius",
    await expectedCornerRadius(page, 20),
  );
  expect((await readGlass(soloTile)).boxShadow).toMatch(/inset/);
  const namePill = soloTile.locator(".media-p405-tile-meta > span");
  expect((await readGlass(namePill)).backdropFilter).toMatch(/blur\(16px\)/);
  // Apple HIG type and the spring curve on every Dock key.
  expect(
    await page
      .locator(".media-p405-room")
      .evaluate((room) => getComputedStyle(room).fontFamily),
  ).toMatch(/^-apple-system, BlinkMacSystemFont/);
  await expect(micButton).toHaveCSS(
    "transition-timing-function",
    /cubic-bezier\(0\.22, 1, 0\.36, 1\)/,
  );
  // ROOM-COMPACT-05: the Top Bar keeps no effects key; its Lock key is a
  // 28px round glass key with a specular rim.
  await expect(page.locator(".media-p405-effects-badge")).toHaveCount(0);
  const lockKey = page
    .locator(".media-p405-header")
    .getByRole("button", { name: "Khóa phòng", exact: true });
  expect((await readGlass(lockKey)).boxShadow).toMatch(/inset/);
  expect(
    (await new AxeBuilder({ page }).include(".media-p405-shell").analyze())
      .violations,
  ).toEqual([]);
  await saveRoomStudioScreenshot(page, "01-macos-solo-vi-1440x900.png");

  // Tactile press: the key sinks to 96.5% while held. Releasing off the key
  // dispatches no click on it, so the microphone state is untouched.
  const micBox = await micButton.boundingBox();
  await page.mouse.move(
    micBox!.x + micBox!.width / 2,
    micBox!.y + micBox!.height / 2,
  );
  await page.mouse.down();
  await expect
    .poll(() =>
      micButton.evaluate((button) => getComputedStyle(button).transform),
    )
    .toBe("matrix(0.965, 0, 0, 0.965, 0, 0)");
  await page.mouse.move(4, 4);
  await page.mouse.up();
  await expect(micButton).toHaveAccessibleName("Tắt micro");

  // The icon-only Dock fits one 56px row on a 1024px laptop, still captionless.
  await page.setViewportSize({ width: 1_024, height: 768 });
  await expect(page.locator(".media-p405-dock-caption")).toHaveCount(0);
  await expect(
    toolbar.getByRole("button", {
      name: "Mở trò chuyện trong phòng",
      exact: true,
    }),
  ).toBeVisible();
  const compactFooter = await footer.boundingBox();
  expect(compactFooter!.height).toBeLessThanOrEqual(58.5);
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
  // ROOM-MACOS-03: a one-to-one lesson keeps the 20px FaceTime corner.
  await expect(
    page.locator(".media-p405-grid .media-p405-tile").nth(1),
  ).toHaveCSS("border-top-left-radius", await expectedCornerRadius(page, 20));
  await saveRoomStudioScreenshot(page, "02-macos-duo-vi-1440x900.png");
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
  // ROOM-MACOS-03: groups tighten to 16px corners.
  await expect(
    page.locator(".media-p405-grid .media-p405-tile").first(),
  ).toHaveCSS("border-top-left-radius", await expectedCornerRadius(page, 16));

  // The reaction menu is a frosted Control Center module above the Dock.
  const reactions = page.getByRole("button", {
    name: "Gửi reaction",
    exact: true,
  });
  await reactions.click();
  const reactionMenu = page.getByRole("menu", { name: "Chọn reaction" });
  await expect(reactionMenu).toBeVisible();
  await expect(reactions).toHaveAttribute("aria-expanded", "true");
  const menuGlass = await readGlass(reactionMenu);
  expect(menuGlass.backdropFilter).toMatch(/blur\(30px\)/);
  expect(menuGlass.backgroundImage).toContain("linear-gradient");
  expect(menuGlass.boxShadow).toMatch(/inset/);
  const menuBox = await reactionMenu.boundingBox();
  const triggerBox = await reactions.boundingBox();
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(triggerBox!.y);
  await reactionMenu.getByRole("menuitem", { name: "Vỗ tay" }).hover();
  expect(
    (
      await new AxeBuilder({ page })
        .include(".media-p406-reaction-menu")
        .analyze()
    ).violations,
  ).toEqual([]);
  await saveRoomStudioScreenshot(
    page,
    "03-macos-group5-reactions-vi-1440x900.png",
  );
  await page.keyboard.press("Escape");
  await expect(reactionMenu).toHaveCount(0);
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

  const board = page.locator("#media-p506-control-tools");
  await openWhiteboardStage(page);
  await expect(board).toHaveClass(/th-button--primary/);
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
  // ROOM-COMPACT-05: an edge-to-edge paper card (16px corners) with no
  // titlebar; its Close key is a 28px round key in the Top Bar.
  const toolStage = page.locator(".media-p506-tool-stage");
  await expect(toolStage).toHaveCSS(
    "border-top-left-radius",
    await expectedCornerRadius(page, 16),
  );
  await expect(page.locator(".media-p506-tool-stage__header")).toHaveCount(0);
  const close = page
    .locator(".media-p405-header")
    .getByRole("button", { name: "Đóng", exact: true });
  await expect(close).toHaveAttribute("id", "media-p506-close-whiteboard");
  const closeBox = await close.boundingBox();
  expect(Math.round(closeBox!.width)).toBe(28);
  expect(Math.round(closeBox!.height)).toBe(28);
  // A pointer open shows no ring on the visually hidden heading's card.
  await expect(toolStage).toHaveCSS("outline-style", "none");
  expect(
    (await new AxeBuilder({ page }).include(".media-p405-shell").analyze())
      .violations,
  ).toEqual([]);
  await saveRoomStudioScreenshot(page, "04-macos-whiteboard-vi-1440x900.png");

  // Close (Top Bar) returns focus to the Dock key; reopening it from the
  // keyboard rings the whole paper card around the focused, hidden heading.
  await close.click();
  await expect(toolStage).toHaveCount(0);
  await expect(board).toBeFocused();
  await expect(board).toHaveAttribute("aria-expanded", "false");
  // Enter opens the tools popover on its first tile; Enter chooses it.
  await page.keyboard.press("Enter");
  await expect(
    page.locator("#media-p506-tool-option-whiteboard"),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Bảng trắng", level: 2 }),
  ).toBeFocused();
  await expect(toolStage).toHaveCSS("outline-style", "solid");
  await expect(toolStage).toHaveCSS("outline-width", "2px");
  await expect(toolStage).toHaveCSS("outline-color", "rgb(147, 197, 253)");
  await expect(toolStage).toHaveCSS("outline-offset", "2px");
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

  // ROOM-MACOS-03: Control Center popover and inspector drawer are two
  // separate glass layers; both frost what is behind them.
  const panelGlass = await readGlass(panel);
  expect(panelGlass.backdropFilter).toMatch(/blur\(30px\)/);
  expect(panelGlass.backdropFilter).toMatch(/saturate\((1\.9|190%)\)/);
  expect(panelGlass.backgroundImage).toContain("linear-gradient");
  expect(panelGlass.boxShadow).toMatch(/inset/);
  await expect(panel).toHaveCSS(
    "border-top-left-radius",
    await expectedCornerRadius(page, 20),
  );
  const drawerGlass = await readGlass(drawer);
  expect(drawerGlass.backdropFilter).toMatch(/blur\(32px\)/);
  expect(drawerGlass.backgroundImage).toContain("linear-gradient");
  expect(drawerGlass.boxShadow).toMatch(/inset/);
  await expect(drawer).toHaveCSS(
    "border-left-color",
    "rgba(255, 255, 255, 0.12)",
  );
  // Width and edge are unchanged by the glass (VIDEO-FX-01 geometry).
  expect(drawerBox!.width).toBeLessThanOrEqual(361);
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
  await saveRoomStudioScreenshot(
    page,
    "05-macos-control-center-vi-1440x900.png",
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
  // Icon-only keys at every width: 42px round keys with a fine pointer
  // (ROOM-COMPACT-05; the stylesheet raises them to 44px on coarse pointers),
  // well above the 24px WCAG 2.5.8 minimum.
  await expect(page.locator(".media-p405-dock-caption")).toHaveCount(0);
  const controlHeights = await page
    .locator(".media-p405-footer .media-p405-dock-button")
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getBoundingClientRect().height),
    );
  expect(controlHeights.length).toBeGreaterThan(8);
  expect(Math.min(...controlHeights)).toBeGreaterThanOrEqual(42);
  const [teacher, student] = await gridTileBoxes(page);
  expect(student!.y).toBeGreaterThan(teacher!.y);
  expect(
    (await new AxeBuilder({ page }).include(".media-p405-shell").analyze())
      .violations,
  ).toEqual([]);
  await saveRoomStudioScreenshot(page, "06-macos-mobile-vi-320x900.png");

  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  expect(await horizontalOverflow()).toBeLessThanOrEqual(1);
  await expect(page.locator(".media-p405-footer")).toHaveCSS(
    "border-top-style",
    "solid",
  );
  // ROOM-MACOS-03: forced colours drop the glass layer; reduced motion drops
  // the spring transitions and the press transform.
  expect(
    (await readGlass(page.locator(".media-p405-footer"), "::before")).display,
  ).toBe("none");
  // (styles.css forces 0.01ms !important under reduced motion: effectively 0.)
  const dockKeyMotion = await page
    .locator(".media-p405-footer .media-p405-dock-button")
    .first()
    .evaluate((button) => {
      const style = getComputedStyle(button);
      return {
        duration: Math.max(
          ...style.transitionDuration
            .split(",")
            .map((value) => parseFloat(value)),
        ),
        transform: style.transform,
      };
    });
  expect(dockKeyMotion.duration).toBeLessThan(0.001);
  expect(dockKeyMotion.transform).toBe("none");
  expect(
    (await new AxeBuilder({ page }).include(".media-p405-shell").analyze())
      .violations,
  ).toEqual([]);
});

// WHITEBOARD-PAPER-01: classroom paper modes on the production canvas, chosen
// from a Liquid Glass popover. Set WHITEBOARD_PAPER_SCREENSHOT_DIR (for
// example `.tmp/whiteboard-paper-01`) to save the acceptance screenshots.
const whiteboardPaperScreenshotDir =
  process.env.WHITEBOARD_PAPER_SCREENSHOT_DIR?.trim() || "";

async function saveWhiteboardPaperScreenshot(page: Page, name: string) {
  if (!whiteboardPaperScreenshotDir) return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${whiteboardPaperScreenshotDir}/${name}` });
}

/** Device-pixel columns on the middle row of the backdrop that match `rgb`. */
async function backdropColumns(
  page: Page,
  rgb: readonly [number, number, number],
) {
  return page
    .getByTestId("whiteboard-paper-backdrop")
    .evaluate((canvas, target) => {
      const element = canvas as HTMLCanvasElement;
      const context = element.getContext("2d");
      if (!context) return { columns: [] as number[], ratio: 1 };
      const row = Math.floor(element.height / 2);
      const { data } = context.getImageData(0, row, element.width, 1);
      const columns: number[] = [];
      for (let x = 0; x < element.width; x += 1) {
        const offset = x * 4;
        if (
          Math.abs((data[offset] ?? 0) - target[0]) <= 6 &&
          Math.abs((data[offset + 1] ?? 0) - target[1]) <= 6 &&
          Math.abs((data[offset + 2] ?? 0) - target[2]) <= 6
        ) {
          columns.push(x);
        }
      }
      return { columns, ratio: element.width / element.clientWidth };
    }, rgb);
}

async function readFixtureScene(page: Page) {
  return page.evaluate(() => {
    const scene = window.__paperFixtureAuthority?.getScene();
    return {
      elements: (scene?.elements ?? []).map((element) => ({
        id: element.id,
        strokeColor: element.strokeColor,
        type: element.type,
      })),
      page: scene?.page ?? {},
    };
  });
}

async function freedrawColours(page: Page) {
  return (await readFixtureScene(page)).elements
    .filter((element) => element.type === "freedraw")
    .map((element) => element.strokeColor);
}

async function drawFreehandStroke(page: Page, offsetY: number) {
  // Excalidraw draws its tool icon over the visually hidden radio input.
  await page.getByRole("radio", { name: "Draw" }).click({ force: true });
  await expect(page.getByRole("radio", { name: "Draw" })).toBeChecked();
  const box = await page
    .getByRole("region", { name: "Bề mặt bảng trắng tương tác" })
    .boundingBox();
  if (!box) throw new Error("The whiteboard canvas has no box.");
  const startX = box.x + box.width * 0.55;
  const startY = box.y + box.height * 0.6 + offsetY;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let step = 1; step <= 12; step += 1) {
    await page.mouse.move(startX + step * 14, startY + Math.sin(step) * 18);
  }
  await page.mouse.up();
  // Back to the selection tool with nothing selected: Excalidraw's own
  // drawing-properties panel (an upstream unnamed colour-picker dialog) is
  // outside this task's scope and closes with it.
  await page.getByRole("radio", { name: "Selection" }).click({ force: true });
  await page.keyboard.press("Escape");
}

async function expectNoShellViolations(page: Page) {
  expect(
    (await new AxeBuilder({ page }).include(".media-p405-shell").analyze())
      .violations,
  ).toEqual([]);
}

test("WHITEBOARD-PAPER-01 picks classroom paper from a Liquid Glass popover and keeps it anchored", async ({
  page,
}) => {
  // Hermetic: Excalidraw may ask a CDN for optional fonts; stay on localhost.
  await page.route(
    /^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])[^/]+\//,
    (route) => route.abort(),
  );
  await page.setViewportSize({ width: 1_440, height: 900 });
  await mountClassroomFixture(page, {
    participantCount: 2,
    studio: { language: "vi", whiteboard: "paper" },
  });
  await loadRoomStudioStyles(page);
  await openWhiteboardStage(page);

  const canvasRegion = page.getByRole("region", {
    name: "Bề mặt bảng trắng tương tác",
  });
  await expect(canvasRegion).toBeVisible();
  await expect(
    page.locator(".whiteboard-engine-canvas > .excalidraw"),
  ).toHaveCSS("z-index", "1");
  const backdrop = page.getByTestId("whiteboard-paper-backdrop");
  await expect(backdrop).toHaveAttribute("aria-hidden", "true");
  await expect(backdrop).toHaveAttribute("data-paper-mode", "plain");
  await expect(page.getByRole("radio", { name: "Selection" })).toHaveCount(1);

  // Teacher trigger: a glass pill naming the current paper, portalled into
  // the room's Top Bar slot (ROOM-COMPACT-05).
  const trigger = page.getByTestId("whiteboard-paper-trigger");
  await expect(
    page
      .locator(".media-p405-header .media-p405-header-tool-slot")
      .getByTestId("whiteboard-paper-trigger"),
  ).toHaveCount(1);
  await expect(trigger).toHaveAccessibleName("Giấy: Bảng trắng (Trơn)");
  await expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
  expect((await readGlass(trigger)).backdropFilter).toMatch(/blur\(18px\)/);

  await trigger.click();
  const popover = page.getByRole("dialog", { name: "Chọn chế độ giấy" });
  await expect(popover).toBeVisible();
  const glass = await readGlass(popover);
  expect(glass.backdropFilter).toMatch(/blur\(30px\)/);
  expect(glass.boxShadow).toMatch(/inset/);
  await expect(popover.locator("button[data-paper-mode]")).toHaveCount(9);
  await expect(
    popover.locator("button[data-paper-mode] .whiteboard-paper-card-name"),
  ).toHaveText([
    "Bảng trắng (Trơn)",
    "Kẻ ngang",
    "Ô ly vuông",
    "Vở học sinh",
    "Chấm bi",
    "Khuông nhạc",
    "Giấy vẽ (Canvas)",
    "Bản thiết kế",
    "Bảng phấn",
  ]);
  await expect(popover.getByRole("radio")).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Selection" })).toHaveCount(1);
  const lightTone = popover.getByRole("button", { name: "Nền sáng" });
  const darkTone = popover.getByRole("button", { name: "Nền tối" });
  await expect(lightTone).toHaveAttribute("aria-pressed", "true");
  await expect(darkTone).toHaveAttribute("aria-pressed", "false");
  const popoverBox = await popover.boundingBox();
  expect(popoverBox!.width).toBeLessThanOrEqual(352.5);
  expect(popoverBox!.x).toBeGreaterThanOrEqual(0);
  expect(popoverBox!.x + popoverBox!.width).toBeLessThanOrEqual(1_440);
  await expectNoShellViolations(page);

  const choose = async (name: string, mode: string) => {
    const card = popover.getByRole("button", { name, exact: true });
    await card.click();
    await expect(card).toHaveAttribute("aria-pressed", "true");
    await expect(backdrop).toHaveAttribute("data-paper-mode", mode);
    await expect
      .poll(async () => (await readFixtureScene(page)).page.paperMode)
      .toBe(mode);
  };

  await choose("Vở học sinh", "notebook");
  await expect(trigger).toHaveAccessibleName("Giấy: Vở học sinh");
  expect((await readFixtureScene(page)).page).toEqual({
    backgroundColor: "#fdfdfd",
    id: "page-paper-fixture",
    name: "Bài 3 · Phân số",
    paperDark: false,
    paperMode: "notebook",
  });
  await expectNoShellViolations(page);
  await saveWhiteboardPaperScreenshot(page, "01-paper-popover-vi-1440x900.png");

  // Escape closes the non-modal popover and returns focus to the trigger.
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await saveWhiteboardPaperScreenshot(
    page,
    "02-paper-notebook-vi-1440x900.png",
  );

  // The red margin is anchored to scene x = 80: a pan moves it with the ink.
  const margin = [252, 165, 165] as const;
  const before = await backdropColumns(page, margin);
  expect(before.columns.length).toBeGreaterThanOrEqual(1);
  expect(before.columns.length).toBeLessThanOrEqual(3 * before.ratio);
  const box = await canvasRegion.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(-90, 0);
  await expect
    .poll(async () => (await backdropColumns(page, margin)).columns[0] ?? -1)
    .toBeGreaterThan((before.columns[0] ?? 0) + 60 * before.ratio);
  const after = await backdropColumns(page, margin);
  expect(
    Math.abs(
      (after.columns[0] ?? 0) - (before.columns[0] ?? 0) - 90 * before.ratio,
    ),
  ).toBeLessThanOrEqual(2 * before.ratio);

  for (const [name, mode, file] of [
    ["Khuông nhạc", "music", "03-paper-music-vi-1440x900.png"],
    ["Bản thiết kế", "blueprint", "04-paper-blueprint-vi-1440x900.png"],
    ["Giấy vẽ (Canvas)", "canvas", "06-paper-canvas-vi-1440x900.png"],
  ] as const) {
    await trigger.click();
    await choose(name, mode);
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await saveWhiteboardPaperScreenshot(page, file);
  }

  // Blackboard is a fixed dark surface: the next stroke is chalk white while
  // existing elements keep their colours.
  await trigger.click();
  await choose("Bảng phấn", "blackboard");
  await expect(darkTone).toBeDisabled();
  await expect(popover).toHaveAccessibleDescription(
    "Bản thiết kế và Bảng phấn luôn giữ màu nền đặc trưng.",
  );
  await expectNoShellViolations(page);
  await page.keyboard.press("Escape");
  await expect(canvasRegion).toHaveAttribute("data-paper-surface", "dark");
  await drawFreehandStroke(page, 0);
  await expect.poll(() => freedrawColours(page)).toEqual(["#ffffff"]);
  const blackboardScene = await readFixtureScene(page);
  expect(
    blackboardScene.elements.find((element) => element.id === "paper-box")
      ?.strokeColor,
  ).toBe("#1971c2");
  expect(blackboardScene.page).toMatchObject({
    backgroundColor: "#1b3d2b",
    paperMode: "blackboard",
  });
  await expectNoShellViolations(page);
  await saveWhiteboardPaperScreenshot(
    page,
    "05-paper-blackboard-vi-1440x900.png",
  );

  // Dark grid keeps chalk; returning to light paper restores the default ink.
  await trigger.click();
  await choose("Ô ly vuông", "grid");
  await darkTone.click();
  await expect(darkTone).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () => (await readFixtureScene(page)).page.paperDark)
    .toBe(true);
  await saveWhiteboardPaperScreenshot(
    page,
    "07-paper-popover-dark-grid-vi-1440x900.png",
  );
  await lightTone.click();
  await expect(canvasRegion).toHaveAttribute("data-paper-surface", "light");
  await page.keyboard.press("Escape");
  await drawFreehandStroke(page, 60);
  await expect
    .poll(() => freedrawColours(page))
    .toEqual(["#ffffff", "#1e1e1e"]);
  await expectNoShellViolations(page);
});

// ROOM-MEET-DOCK-04: Google Meet icon-only controls with one floating Liquid
// Glass tooltip (140ms first hover, 0ms warm hand-off, Escape, never over an
// open popover, clamped 8px inside the viewport). Set
// ROOM_MEET_DOCK_SCREENSHOT_DIR (for example `.tmp/dock-meet-04`) to save the
// acceptance screenshots.
const roomMeetDockScreenshotDir =
  process.env.ROOM_MEET_DOCK_SCREENSHOT_DIR?.trim() || "";

async function saveRoomMeetDockScreenshot(page: Page, name: string) {
  if (!roomMeetDockScreenshotDir) return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${roomMeetDockScreenshotDir}/${name}` });
}

async function horizontalPageOverflow(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
}

/** The tooltip sits on the requested side of `key`, clamped 8px inside. */
async function expectTooltipBeside(
  page: Page,
  key: Locator,
  side: "above" | "below",
) {
  const tooltip = page.getByTestId("room-tooltip");
  const keyBox = (await key.boundingBox())!;
  const tipBox = (await tooltip.boundingBox())!;
  const viewport = page.viewportSize()!;
  if (side === "above") {
    expect(
      Math.abs(tipBox.y + tipBox.height - (keyBox.y - 10)),
    ).toBeLessThanOrEqual(1.5);
  } else {
    expect(
      Math.abs(tipBox.y - (keyBox.y + keyBox.height + 8)),
    ).toBeLessThanOrEqual(1.5);
  }
  expect(tipBox.x).toBeGreaterThanOrEqual(7.5);
  expect(tipBox.x + tipBox.width).toBeLessThanOrEqual(viewport.width - 7.5);
  const centred =
    Math.abs(tipBox.x + tipBox.width / 2 - (keyBox.x + keyBox.width / 2)) <=
    1.5;
  const clamped =
    Math.abs(tipBox.x - 8) <= 1 ||
    Math.abs(tipBox.x + tipBox.width - (viewport.width - 8)) <= 1;
  expect(centred || clamped).toBe(true);
  expect(await horizontalPageOverflow(page)).toBeLessThanOrEqual(0);
}

test("ROOM-MEET-DOCK-04 shows a Meet tooltip above Dock keys and hands it off along the Dock", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await mountClassroomFixture(page, {
    participantCount: 1,
    studio: { language: "vi" },
  });
  await loadRoomStudioStyles(page);

  const tooltip = page.getByTestId("room-tooltip");
  await expect(tooltip).toHaveAttribute("aria-hidden", "true");
  await expect(tooltip).toBeHidden();
  const toolbar = page.getByRole("toolbar", { name: "Điều khiển phòng học" });
  const share = toolbar.getByRole("button", {
    name: "Chia sẻ màn hình",
    exact: true,
  });
  const board = toolbar.getByRole("button", {
    name: "Công cụ lớp học",
    exact: true,
  });
  const layoutKey = toolbar.getByRole("button", {
    name: "Bố cục",
    exact: true,
  });
  // ROOM-COMPACT-05: the host's end-call pill opens a popover instead.
  const leave = page.locator("#media-p405-control-leave");

  // First hover: shown after the 140ms intent delay, above the key.
  await share.hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText("Chia sẻ màn hình");
  await expect(tooltip).not.toHaveAttribute("data-instant", "true");
  await expect(tooltip).toHaveAttribute("data-side", "top");
  await page.waitForTimeout(200);
  await expectTooltipBeside(page, share, "above");

  // Material plain tooltip in dark Liquid Glass.
  const tipStyle = await tooltip.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backdropFilter:
        style.backdropFilter ||
        style.getPropertyValue("-webkit-backdrop-filter"),
      borderRadius: style.borderTopLeftRadius,
      color: style.color,
      fontSize: style.fontSize,
      pointerEvents: style.pointerEvents,
      position: style.position,
      whiteSpace: style.whiteSpace,
    };
  });
  expect(tipStyle).toMatchObject({
    borderRadius: "8px",
    color: "rgb(248, 250, 252)",
    fontSize: "12px",
    pointerEvents: "none",
    position: "fixed",
    whiteSpace: "nowrap",
  });
  expect(tipStyle.backdropFilter).toMatch(/blur\(14px\)/);
  // Axe stays clean while the tooltip is open.
  expect(
    (await new AxeBuilder({ page }).include(".media-p405-shell").analyze())
      .violations,
  ).toEqual([]);
  await saveRoomMeetDockScreenshot(
    page,
    "01-dock-solo-hover-share-vi-1440x900.png",
  );

  // Warm hand-off: sliding to the next keys moves the tooltip at once.
  await board.hover();
  await expect(tooltip).toHaveText("Công cụ lớp học");
  await expect(tooltip).toHaveAttribute("data-instant", "true");
  await expectTooltipBeside(page, board, "above");
  await layoutKey.hover();
  await expect(tooltip).toHaveText("Bố cục");
  await expect(tooltip).toHaveAttribute("data-instant", "true");
  await expectTooltipBeside(page, layoutKey, "above");

  // Escape hides it at once (WCAG 1.4.13) and it stays down on that key.
  await page.keyboard.press("Escape");
  await expect(tooltip).toBeHidden();
  await page.waitForTimeout(300);
  await expect(tooltip).toBeHidden();

  // The host's end-call pill names no tooltip: hovering it opens the End
  // room / Leave room popover, and the tooltip never covers it.
  await leave.hover();
  await expect(page.getByTestId("leave-end-popover")).toBeVisible();
  await expect(tooltip).toBeHidden();
  await saveRoomMeetDockScreenshot(page, "02-dock-hover-leave-vi-1440x900.png");
  await page.mouse.move(720, 300);
  await expect(page.getByTestId("leave-end-popover")).toHaveCount(0);

  // Keyboard roving shows each control's live name with no delay.
  await page.mouse.move(720, 300);
  const microphone = toolbar.getByRole("button", {
    name: "Tắt micro",
    exact: true,
  });
  await microphone.focus();
  await page.keyboard.press("ArrowRight");
  const camera = toolbar.getByRole("button", {
    name: "Bật camera",
    exact: true,
  });
  await expect(camera).toBeFocused();
  await expect(tooltip).toHaveText("Bật camera");
  await expectTooltipBeside(page, camera, "above");
  await page.keyboard.press("Escape");
  await expect(tooltip).toBeHidden();
  await expect(camera).toBeFocused();

  // Opening the device popover hides the tooltip; it never covers it.
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => new MediaStream();
  });
  const devices = toolbar.getByRole("button", {
    name: "Thiết bị",
    exact: true,
  });
  await page.mouse.move(720, 300);
  await page.waitForTimeout(450);
  await devices.hover();
  await expect(tooltip).toHaveText("Thiết bị");
  await devices.click();
  await expect(devices).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".media-p405-device-panel")).toBeVisible();
  await expect(tooltip).toBeHidden();
  await page.mouse.move(720, 300);
  await devices.hover();
  await page.waitForTimeout(400);
  await expect(tooltip).toBeHidden();
  await devices.click();
  await expect(devices).toHaveAttribute("aria-expanded", "false");

  // Touch never leaves a tooltip behind.
  await page.mouse.move(720, 300);
  await page.waitForTimeout(450);
  await share.dispatchEvent("pointerover", { pointerType: "touch" });
  await page.waitForTimeout(400);
  await expect(tooltip).toBeHidden();
});

test("ROOM-MEET-DOCK-04 / ROOM-COMPACT-05 keeps one 28px Lock key in the Top Bar whose tooltip hangs below inside the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await mountClassroomFixture(page, {
    participantCount: 1,
    studio: { language: "vi" },
  });
  await loadRoomStudioStyles(page);

  const tooltip = page.getByTestId("room-tooltip");
  const header = page.locator(".media-p405-header");
  // Effects and End room moved to the Dock: the Top Bar keeps Lock on the left
  // and the 28px Full screen key on the right (ROOM-UI-POLISH-01).
  await expect(page.locator(".media-p405-effects-badge")).toHaveCount(0);
  await expect(
    header.getByRole("button", { name: /Hiệu ứng|Nền và hiệu ứng/ }),
  ).toHaveCount(0);
  await expect(
    header.getByRole("button", { name: "Kết thúc phòng", exact: true }),
  ).toHaveCount(0);
  await expect(header.getByRole("button")).toHaveCount(2);
  const lock = header.getByRole("button", { name: "Khóa phòng", exact: true });
  const fullscreen = header.getByRole("button", {
    name: "Toàn màn hình (Shift+F)",
    exact: true,
  });
  const lockBox = await lock.boundingBox();
  const fullscreenBox = await fullscreen.boundingBox();
  expect(Math.round(lockBox!.width)).toBe(28);
  expect(Math.round(lockBox!.height)).toBe(28);
  expect(Math.round(fullscreenBox!.width)).toBe(28);
  expect(Math.round(fullscreenBox!.height)).toBe(28);
  await expect(lock).toHaveCSS("border-top-left-radius", "999px");
  // The text is gone visually but stays the control's accessible name.
  await expect(lock.locator(".media-p405-button-label")).toHaveCSS(
    "position",
    "absolute",
  );
  // Left side, right after the participant count, vertically centred.
  const presenceBox = await page
    .locator(".media-p405-presence-short")
    .boundingBox();
  const headerBox = await header.boundingBox();
  expect(lockBox!.x).toBeGreaterThan(presenceBox!.x + presenceBox!.width);
  expect(lockBox!.x - (presenceBox!.x + presenceBox!.width)).toBeLessThan(24);
  expect(lockBox!.x + lockBox!.width).toBeLessThan(720);
  expect(
    Math.abs(
      lockBox!.y + lockBox!.height / 2 - (headerBox!.y + headerBox!.height / 2),
    ),
  ).toBeLessThanOrEqual(1.5);
  // No open tool: the right side holds only the 28px Full screen key.
  const actionsBox = await page
    .locator(".media-p405-header-actions")
    .boundingBox();
  expect(Math.round(actionsBox?.width ?? 0)).toBeLessThanOrEqual(32);

  await lock.hover();
  await expect(tooltip).toHaveText("Khóa phòng");
  await expect(tooltip).toHaveAttribute("data-side", "bottom");
  await page.waitForTimeout(200);
  await expectTooltipBeside(page, lock, "below");
  const tipBox = await tooltip.boundingBox();
  expect(tipBox!.y + tipBox!.height).toBeLessThanOrEqual(900);
  expect(
    (await new AxeBuilder({ page }).include(".media-p405-shell").analyze())
      .violations,
  ).toEqual([]);
  await saveRoomMeetDockScreenshot(
    page,
    "03-header-hover-lock-vi-1440x900.png",
  );

  // Escape hides it without moving focus elsewhere.
  await page.keyboard.press("Escape");
  await expect(tooltip).toBeHidden();
});

test("ROOM-MEET-DOCK-04 keeps a one-person speaker view free of the empty rail text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await mountClassroomFixture(page, {
    participantCount: 1,
    studio: { language: "vi" },
  });
  await loadRoomStudioStyles(page);

  await chooseLayout(page, "Người đang nói");
  await expect(page.locator(".media-p405-tile--stage")).toBeVisible();
  await expect(
    page.getByText("Chưa có video người tham gia để hiển thị.", {
      exact: true,
    }),
  ).toBeHidden();
  await expect(page.locator(".media-p405-rail")).toBeHidden();
  // The stage takes the whole row, so the single speaker stays centred.
  const stageBox = await page.locator(".media-p405-stage").boundingBox();
  expect(stageBox!.width).toBeGreaterThanOrEqual(1_400);
  const tileBox = await page.locator(".media-p405-tile--stage").boundingBox();
  expect(Math.abs(tileBox!.x + tileBox!.width / 2 - 720)).toBeLessThanOrEqual(
    16,
  );
  expect(
    (await new AxeBuilder({ page }).include(".media-p405-shell").analyze())
      .violations,
  ).toEqual([]);
  await saveRoomMeetDockScreenshot(
    page,
    "04-speaker-solo-clean-vi-1440x900.png",
  );
});

test("ROOM-MEET-DOCK-04 compacts the whiteboard keys and never covers the paper popover", async ({
  page,
}) => {
  // Hermetic: Excalidraw may ask a CDN for optional fonts; stay on localhost.
  await page.route(
    /^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])[^/]+\//,
    (route) => route.abort(),
  );
  await page.setViewportSize({ width: 1_440, height: 900 });
  await mountClassroomFixture(page, {
    participantCount: 1,
    studio: { language: "vi", whiteboard: "paper" },
  });
  await loadRoomStudioStyles(page);
  // The reference scene: one person, speaker view, whiteboard on stage.
  await chooseLayout(page, "Người đang nói");
  await openWhiteboardStage(page);
  await expect(
    page.getByRole("region", { name: "Bề mặt bảng trắng tương tác" }),
  ).toBeVisible();
  await expect(
    page.getByText("Chưa có video người tham gia để hiển thị.", {
      exact: true,
    }),
  ).toBeHidden();

  const tooltip = page.getByTestId("room-tooltip");
  const header = page.locator(".media-p405-header");
  // ROOM-COMPACT-05: Close is a 28px round X key in the Top Bar, still
  // named "Đóng"; the paper card has no titlebar of its own.
  await expect(page.locator(".media-p506-tool-stage__header")).toHaveCount(0);
  const close = header.getByRole("button", { name: "Đóng", exact: true });
  const closeBox = await close.boundingBox();
  expect(Math.round(closeBox!.width)).toBe(28);
  expect(Math.round(closeBox!.height)).toBe(28);
  await expect(close).toHaveAttribute("data-tooltip", "Đóng");
  await close.hover();
  await expect(tooltip).toHaveText("Đóng");
  await page.waitForTimeout(200);
  await expectTooltipBeside(page, close, "below");

  // No engine bar in the classroom: no text-view key and no visible
  // connection line. The status stays a 1px polite live region for AT and
  // the text alternative stays in the DOM for the canvas description.
  await expect(page.locator(".whiteboard-engine-bar")).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Đọc bảng trắng dạng văn bản",
      exact: true,
    }),
  ).toHaveCount(0);
  const connection = page.locator(".whiteboard-connection-status");
  await expect(connection).toHaveAttribute("aria-live", "polite");
  await expect(connection).toHaveText("Bảng trắng đã kết nối.");
  const connectionBox = await connection.boundingBox();
  expect(connectionBox!.width).toBeLessThanOrEqual(1);
  expect(connectionBox!.height).toBeLessThanOrEqual(1);

  // Paper (ROOM-STAGE-POLISH-04): a 28px round palette key in the Top Bar
  // beside Close, level with it; the full paper name is the tooltip.
  const trigger = header.getByTestId("whiteboard-paper-trigger");
  await expect(trigger).toHaveAccessibleName("Giấy: Bảng trắng (Trơn)");
  const triggerBox = await trigger.boundingBox();
  expect(Math.round(triggerBox!.width)).toBe(28);
  expect(Math.round(triggerBox!.height)).toBe(28);
  expect(Math.round(triggerBox!.y)).toBe(Math.round(closeBox!.y));
  expect(triggerBox!.x + triggerBox!.width).toBeLessThan(closeBox!.x);
  await expect(trigger).toHaveCSS("border-top-left-radius", "999px");
  await expect(trigger.locator(".whiteboard-paper-swatch")).toHaveCount(0);
  const paletteBox = await trigger.locator("svg.lucide-palette").boundingBox();
  expect(Math.round(paletteBox!.width)).toBe(15);
  expect(Math.round(paletteBox!.height)).toBe(15);
  await trigger.hover();
  await expect(tooltip).toHaveText("Giấy: Bảng trắng (Trơn)");
  await expectTooltipBeside(page, trigger, "below");
  expect(
    (await new AxeBuilder({ page }).include(".media-p405-shell").analyze())
      .violations,
  ).toEqual([]);
  await saveRoomMeetDockScreenshot(
    page,
    "05-whiteboard-hover-paper-vi-1440x900.png",
  );

  await trigger.click();
  const popover = page.getByRole("dialog", { name: "Chọn chế độ giấy" });
  await expect(popover).toBeVisible();
  await expect(tooltip).toBeHidden();
  await popover
    .getByRole("button", { name: "Vở học sinh", exact: true })
    .click();
  await expect(trigger).toHaveAccessibleName("Giấy: Vở học sinh");
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await page.mouse.move(720, 450);
  await page.waitForTimeout(450);
  await trigger.hover();
  await expect(tooltip).toHaveText("Giấy: Vở học sinh");
  await saveRoomMeetDockScreenshot(
    page,
    "06-whiteboard-hover-notebook-vi-1440x900.png",
  );
});

// ROOM-COMPACT-05: one full-bleed 40px Top Bar (clock, presence, Lock, lesson
// name, paper picker, Close), an edge-to-edge paper card level with the camera
// column, a 56px pill Dock with one layout key, and End room / Leave room
// merged into the ruby end-call pill. Set ROOM_COMPACT_SCREENSHOT_DIR (for
// example `.tmp/room-compact-05`) to save the acceptance screenshots.
const roomCompactScreenshotDir =
  process.env.ROOM_COMPACT_SCREENSHOT_DIR?.trim() || "";
const roomCompactTitle = "Lớp Toán 10 – Phương trình bậc hai";

async function saveRoomCompactScreenshot(page: Page, name: string) {
  if (!roomCompactScreenshotDir) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${roomCompactScreenshotDir}/${name}` });
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Expected a rendered box.");
  return box;
}

test("ROOM-COMPACT-05 frees the board under one full-bleed Top Bar and merges End room / Leave room into the end-call pill", async ({
  page,
}) => {
  // Hermetic: Excalidraw may ask a CDN for optional fonts; stay on localhost.
  await page.route(
    /^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])[^/]+\//,
    (route) => route.abort(),
  );
  await page.setViewportSize({ width: 1_440, height: 900 });
  await mountClassroomFixture(page, {
    participantCount: 1,
    studio: {
      boardTitle: "Bài 3 · Phương trình bậc hai & Đồ thị hàm số",
      language: "vi",
      roomTitle: roomCompactTitle,
      whiteboard: "paper",
    },
  });
  await loadRoomStudioStyles(page);
  await openWhiteboardStage(page);
  await expect(
    page.getByRole("region", { name: "Bề mặt bảng trắng tương tác" }),
  ).toBeVisible();

  // "Vở học sinh" from the Top Bar paper picker.
  const header = page.locator(".media-p405-header");
  const trigger = header.getByTestId("whiteboard-paper-trigger");
  await trigger.click();
  const paperPopover = page.getByRole("dialog", { name: "Chọn chế độ giấy" });
  await paperPopover
    .getByRole("button", { name: "Vở học sinh", exact: true })
    .click();
  await expect(page.getByTestId("whiteboard-paper-backdrop")).toHaveAttribute(
    "data-paper-mode",
    "notebook",
  );
  await page.keyboard.press("Escape");
  await expect(paperPopover).toHaveCount(0);
  await expect(trigger).toHaveAccessibleName("Giấy: Vở học sinh");

  // ---- Top Bar: one full-bleed row, at most 44px tall. ----
  const headerBox = await boxOf(header);
  expect(Math.round(headerBox.x)).toBe(0);
  expect(Math.round(headerBox.width)).toBe(1_440);
  expect(headerBox.y).toBeLessThanOrEqual(0.5);
  expect(headerBox.height).toBeLessThanOrEqual(44);
  const clock = header.locator(".media-p405-session-clock");
  await expect(clock).toHaveText(/^\d{2}:\d{2}$/);
  const presence = header.locator(".media-p405-presence-short");
  await expect(presence).toBeVisible();
  await expect(presence).toHaveText("1 người");
  await expect(header.locator(".media-p405-presence-full")).toHaveText(
    "Đã kết nối / 1 người tham gia",
  );
  const lock = header.getByRole("button", { name: "Khóa phòng", exact: true });
  const title = header.getByRole("heading", {
    level: 1,
    name: roomCompactTitle,
  });
  await expect(title).toBeVisible();
  const close = header.getByRole("button", { name: "Đóng", exact: true });
  const clockBox = await boxOf(clock);
  const presenceBox = await boxOf(presence);
  const lockBox = await boxOf(lock);
  const titleBox = await boxOf(title);
  const triggerBox = await boxOf(trigger);
  const closeBox = await boxOf(close);
  for (const key of [lockBox, closeBox]) {
    expect(Math.round(key.width)).toBe(28);
    expect(Math.round(key.height)).toBe(28);
  }
  expect(Math.round(triggerBox.height)).toBe(28);
  // Left to right: clock, people, Lock, lesson name | paper picker, Close.
  expect(clockBox.x + clockBox.width).toBeLessThan(presenceBox.x);
  expect(presenceBox.x + presenceBox.width).toBeLessThan(lockBox.x);
  expect(lockBox.x + lockBox.width).toBeLessThan(titleBox.x);
  expect(titleBox.x + titleBox.width).toBeLessThan(triggerBox.x);
  expect(triggerBox.x + triggerBox.width).toBeLessThan(closeBox.x);
  expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(1_440 - 8);
  for (const box of [clockBox, presenceBox, lockBox, titleBox, closeBox]) {
    expect(box.y).toBeGreaterThanOrEqual(headerBox.y);
    expect(box.y + box.height).toBeLessThanOrEqual(
      headerBox.y + headerBox.height,
    );
  }
  // The old chrome is gone: generic heading, trial notice, text-view key.
  await expect(page.getByText("Phòng học TutorHub")).toHaveCount(0);
  await expect(page.getByText("Thông tin phiên bản")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Đọc bảng trắng dạng văn bản" }),
  ).toHaveCount(0);
  await expect(page.locator(".media-p506-tool-stage__header")).toHaveCount(0);

  // ---- The paper card is level with the camera column and taller. ----
  const canvasBox = await boxOf(page.locator(".whiteboard-engine-canvas"));
  const toolBox = await boxOf(page.locator(".media-p506-tool-stage"));
  const tileBox = await boxOf(page.locator(".media-p405-tile").first());
  const footer = page.locator(".media-p405-footer");
  const footerBox = await boxOf(footer);
  expect(Math.abs(canvasBox.y - tileBox.y)).toBeLessThanOrEqual(2);
  expect(canvasBox.height).toBeGreaterThanOrEqual(740);
  expect(canvasBox.x + canvasBox.width).toBeLessThanOrEqual(tileBox.x);
  expect(toolBox.y + toolBox.height).toBeLessThanOrEqual(footerBox.y);
  expect(Math.round(footerBox.height)).toBe(56);
  console.log(
    `[ROOM-COMPACT-05 metrics] ${JSON.stringify({
      canvas: canvasBox,
      dock: footerBox,
      header: headerBox,
      tile: tileBox,
      toolStage: toolBox,
      topEdgeDelta: Math.abs(canvasBox.y - tileBox.y),
    })}`,
  );

  // ---- Host end-call pill: hover opens End room / Leave room. ----
  // A pointer user with nothing focused: clicking the plain title text
  // releases the paper trigger's focus.
  await title.click();
  await expect(trigger).not.toBeFocused();
  const tooltip = page.getByTestId("room-tooltip");
  const leave = page.locator("#media-p405-control-leave");
  const endPopover = page.getByTestId("leave-end-popover");
  await expect(leave).toHaveAccessibleName("Rời hoặc kết thúc phòng");
  await expect(leave).not.toHaveAttribute("data-tooltip");
  await expect(endPopover).toHaveCount(0);
  await leave.hover();
  await expect(endPopover).toBeVisible();
  await expect(leave).toHaveAttribute("aria-expanded", "true");
  await expect(leave).toHaveAttribute(
    "aria-controls",
    (await endPopover.getAttribute("id"))!,
  );
  await expect(endPopover).toHaveAttribute("role", "group");
  await expect(endPopover).toHaveAccessibleName("Tùy chọn rời phòng");
  await expect(endPopover.getByRole("button")).toHaveText([
    "Kết thúc phòng",
    "Rời phòng",
  ]);
  const endRoom = endPopover.getByRole("button", {
    name: "Kết thúc phòng",
    exact: true,
  });
  await expect(endRoom).toHaveCSS("background-color", "rgb(220, 38, 38)");
  await expect(endRoom).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(tooltip).toBeHidden();
  // Settled 10px above the pill, right-aligned with it.
  await page.waitForTimeout(250);
  const leaveBox = await boxOf(leave);
  const popoverBox = await boxOf(endPopover);
  expect(Math.round(popoverBox.width)).toBe(216);
  expect(
    Math.abs(leaveBox.y - (popoverBox.y + popoverBox.height) - 10),
  ).toBeLessThanOrEqual(1.5);
  expect(
    Math.abs(popoverBox.x + popoverBox.width - (leaveBox.x + leaveBox.width)),
  ).toBeLessThanOrEqual(1.5);

  // Hover bridge: slide from the pill straight up across the 10px gap onto
  // End room; the popover never closes on the way or after the grace period.
  const endBox = await boxOf(endRoom);
  const startX = leaveBox.x + leaveBox.width / 2;
  await page.mouse.move(startX, leaveBox.y + leaveBox.height / 2);
  await page.mouse.move(startX, endBox.y + endBox.height / 2, { steps: 16 });
  await expect(endPopover).toBeVisible();
  await page.mouse.move(
    endBox.x + endBox.width / 2,
    endBox.y + endBox.height / 2,
    { steps: 6 },
  );
  await page.waitForTimeout(400);
  await expect(endPopover).toBeVisible();
  await expect(endRoom).toHaveCSS("background-color", "rgb(185, 28, 28)");
  await expect(tooltip).toBeHidden();

  // Axe: whiteboard open and the popover open.
  expect(
    (await new AxeBuilder({ page }).include(".media-p405-shell").analyze())
      .violations,
  ).toEqual([]);
  await saveRoomCompactScreenshot(
    page,
    "01-compact-whiteboard-host-end-popover-vi-1440x900.png",
  );

  // Escape closes it and hands focus to the end-call pill.
  await page.keyboard.press("Escape");
  await expect(endPopover).toHaveCount(0);
  await expect(leave).toBeFocused();
  await expect(leave).toHaveAttribute("aria-expanded", "false");
});

test("ROOM-COMPACT-05 keeps a student's end-call pill a plain Leave key and opens the layout menu from one round Dock key", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await mountClassroomFixture(page, {
    participantCount: 2,
    studio: { language: "vi", role: "student", roomTitle: roomCompactTitle },
  });
  await loadRoomStudioStyles(page);

  // No moderation authority: no Lock key, only the Full screen key on the right;
  // the lesson name still shows.
  const header = page.locator(".media-p405-header");
  await expect(header.getByRole("button")).toHaveCount(1);
  await expect(
    header.getByRole("button", {
      name: "Toàn màn hình (Shift+F)",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    header.getByRole("heading", { level: 1, name: roomCompactTitle }),
  ).toBeVisible();
  await expect(header.locator(".media-p405-presence-short")).toHaveText(
    "2 người",
  );
  const headerBox = await boxOf(header);
  expect(headerBox.height).toBeLessThanOrEqual(44);

  // The expanded video stage starts right under the slim Top Bar.
  const stageBox = await boxOf(page.locator(".media-p405-stage"));
  const footerBox = await boxOf(page.locator(".media-p405-footer"));
  expect(stageBox.y - (headerBox.y + headerBox.height)).toBeLessThanOrEqual(10);
  expect(stageBox.y + stageBox.height).toBeLessThanOrEqual(footerBox.y);
  console.log(
    `[ROOM-COMPACT-05 metrics] ${JSON.stringify({
      studentVideoStage: stageBox,
    })}`,
  );

  // Student: hovering the ruby pill shows the "Rời phòng" tooltip only.
  const tooltip = page.getByTestId("room-tooltip");
  const leave = page.locator("#media-p405-control-leave");
  await expect(leave).toHaveAccessibleName("Rời phòng");
  await expect(leave).toHaveAttribute("data-tooltip", "Rời phòng");
  await leave.hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText("Rời phòng");
  await page.waitForTimeout(200);
  await expectTooltipBeside(page, leave, "above");
  await page.waitForTimeout(300);
  await expect(page.getByTestId("leave-end-popover")).toHaveCount(0);
  expect(
    (await new AxeBuilder({ page }).include(".media-p405-shell").analyze())
      .violations,
  ).toEqual([]);
  await saveRoomCompactScreenshot(
    page,
    "02-compact-video-student-leave-tooltip-vi-1440x900.png",
  );

  // Layout: one round key opens Grid / Active speaker / Presentation.
  await page.mouse.move(720, 300);
  await page.waitForTimeout(450);
  const layoutKey = page.locator("#media-p405-control-layout");
  await expect(layoutKey).toHaveAccessibleName("Bố cục");
  const layoutBox = await boxOf(layoutKey);
  expect(Math.round(layoutBox.width)).toBe(42);
  expect(Math.round(layoutBox.height)).toBe(42);
  await layoutKey.click();
  const menu = page.getByRole("menu", { name: "Chế độ bố cục" });
  await expect(menu).toBeVisible();
  await expect(layoutKey).toHaveAttribute("aria-expanded", "true");
  await expect(tooltip).toBeHidden();
  const options = menu.getByRole("menuitemradio");
  await expect(options).toHaveText(["Lưới", "Người đang nói", "Trình bày"]);
  await expect(options.nth(0)).toHaveAttribute("aria-checked", "true");
  await expect(options.nth(1)).toHaveAttribute("aria-checked", "false");
  // Nobody presents, so Presentation is unavailable.
  await expect(options.nth(2)).toHaveAttribute("aria-disabled", "true");
  await page.waitForTimeout(250);
  const menuBox = await boxOf(menu);
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(layoutBox.y);
  expect(menuBox.x).toBeGreaterThanOrEqual(0);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(1_440);
  expect(
    (
      await new AxeBuilder({ page })
        .include(".media-p405-layout-menu")
        .analyze()
    ).violations,
  ).toEqual([]);
  await saveRoomCompactScreenshot(
    page,
    "03-compact-layout-menu-vi-1440x900.png",
  );

  await options.nth(1).click();
  await expect(menu).toHaveCount(0);
  await expect(layoutKey).toBeFocused();
  await expect(page.locator(".media-p405-tile--stage")).toBeVisible();
  await layoutKey.press("Enter");
  await expect(
    page.getByRole("menuitemradio", { name: "Người đang nói", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(layoutKey).toBeFocused();
});

test("ROOM-COMPACT-05 reflows the Top Bar and the end-call popover at 320 CSS pixels with forced colors and no violations", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await mountClassroomFixture(page, {
    participantCount: 2,
    studio: { language: "vi", roomTitle: roomCompactTitle },
  });
  await loadRoomStudioStyles(page);

  const horizontalOverflow = () =>
    page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
  expect(await horizontalOverflow()).toBeLessThanOrEqual(1);
  const header = page.locator(".media-p405-header");
  await expect(
    header.getByRole("heading", { level: 1, name: roomCompactTitle }),
  ).toBeVisible();

  // The layout menu opens from the round key and stays on screen.
  const layoutKey = page.locator("#media-p405-control-layout");
  await layoutKey.click();
  const layoutMenu = page.getByRole("menu", { name: "Chế độ bố cục" });
  await expect(layoutMenu).toBeVisible();
  const layoutMenuBox = await boxOf(layoutMenu);
  expect(layoutMenuBox.x).toBeGreaterThanOrEqual(0);
  expect(layoutMenuBox.x + layoutMenuBox.width).toBeLessThanOrEqual(320);
  expect(layoutMenuBox.y).toBeGreaterThanOrEqual(0);
  expect(
    (
      await new AxeBuilder({ page })
        .include(".media-p405-layout-menu")
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(layoutMenu).toHaveCount(0);
  await expect(layoutKey).toBeFocused();

  // Whiteboard open: Close joins the Top Bar and nothing overflows.
  await openWhiteboardStage(page);
  await expect(
    header.getByRole("button", { name: "Đóng", exact: true }),
  ).toBeVisible();
  expect(await horizontalOverflow()).toBeLessThanOrEqual(1);

  // Keyboard: Enter on the end-call pill opens the popover on End room.
  const leave = page.locator("#media-p405-control-leave");
  await leave.focus();
  await page.keyboard.press("Enter");
  const endPopover = page.getByTestId("leave-end-popover");
  await expect(endPopover).toBeVisible();
  await expect(
    endPopover.getByRole("button", { name: "Kết thúc phòng", exact: true }),
  ).toBeFocused();
  const popoverBox = await boxOf(endPopover);
  expect(popoverBox.x).toBeGreaterThanOrEqual(0);
  expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual(320);
  expect(await horizontalOverflow()).toBeLessThanOrEqual(1);
  await expect(endPopover).toHaveCSS("border-top-style", "solid");
  expect(
    (await new AxeBuilder({ page }).include(".media-p405-shell").analyze())
      .violations,
  ).toEqual([]);

  await page.keyboard.press("ArrowDown");
  await expect(
    endPopover.getByRole("button", { name: "Rời phòng", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(endPopover).toHaveCount(0);
  await expect(leave).toBeFocused();
});

// ---- ROOM-CHAT-01 (ADR-0042) classroom chat inspector -------------------

// Set ROOM_CHAT_SCREENSHOT_DIR to save the acceptance screenshots.
const roomChatScreenshotDir =
  process.env.ROOM_CHAT_SCREENSHOT_DIR?.trim() ?? "";

async function saveRoomChatScreenshot(page: Page, name: string) {
  if (!roomChatScreenshotDir) return;
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${roomChatScreenshotDir}/${name}` });
}

async function lessonImagePNG(page: Page) {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 480;
    canvas.height = 320;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#f8fafc";
    context.fillRect(0, 0, 480, 320);
    context.fillStyle = "#1d4ed8";
    context.font = "bold 28px sans-serif";
    context.fillText("Lời giải mẫu", 24, 48);
    context.strokeStyle = "#f59e0b";
    context.lineWidth = 6;
    context.beginPath();
    context.moveTo(40, 260);
    context.quadraticCurveTo(240, 40, 440, 260);
    context.stroke();
    return canvas.toDataURL("image/png").split(",")[1] ?? "";
  });
  return Buffer.from(base64, "base64");
}

const roomChatExternalRoute =
  /^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])[^/]+\//;

test("ROOM-CHAT-01 docks a 360px chat beside the whiteboard and camera column with emoji, attachments and a lightbox", async ({
  page,
}) => {
  await page.route(roomChatExternalRoute, (route) => route.abort());
  await page.setViewportSize({ width: 1_440, height: 900 });
  await mountClassroomFixture(page, {
    participantCount: 4,
    studio: {
      chat: {},
      language: "vi",
      roomTitle: roomCompactTitle,
      whiteboard: "paper",
    },
  });
  await loadRoomStudioStyles(page);
  await openWhiteboardStage(page);
  await expect(page.locator(".whiteboard-engine-canvas")).toBeVisible();
  const probe = await page.evaluate(() => {
    const tiles = Array.from(
      document.querySelectorAll<HTMLElement>(".media-p405-tile"),
    );
    tiles.forEach((tile, index) => {
      tile.dataset.chatProbe = String(index);
    });
    const videos = Array.from(
      document.querySelectorAll<HTMLElement>(".media-p405-shell video"),
    );
    videos.forEach((video, index) => {
      video.dataset.chatProbe = String(index);
    });
    return { tiles: tiles.length, videos: videos.length };
  });
  expect(probe.tiles).toBeGreaterThan(0);
  const canvasBefore = await boxOf(page.locator(".whiteboard-engine-canvas"));

  const chatKey = page.locator("#media-p408-control-chat");
  await expect(chatKey).toHaveAttribute("aria-expanded", "false");
  await chatKey.click();
  const drawer = page.getByRole("dialog", { name: "Trò chuyện trong phòng" });
  await expect(drawer).toBeVisible();
  await expect(chatKey).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".media-p405-shell")).toHaveClass(
    /media-p405-shell--inspector-open/u,
  );
  // Let the 200ms reserve transition settle before measuring.
  await page.waitForTimeout(450);

  // ---- Geometry: a 360px inspector that covers nothing. ----
  const drawerBox = await boxOf(drawer);
  const canvasBox = await boxOf(page.locator(".whiteboard-engine-canvas"));
  const tileBox = await boxOf(page.locator(".media-p405-tile").first());
  const headerBox = await boxOf(page.locator(".media-p405-header"));
  const dockBox = await boxOf(page.locator(".media-p405-footer"));
  expect(Math.round(drawerBox.width)).toBe(360);
  expect(Math.round(drawerBox.x)).toBe(1_080);
  expect(Math.round(drawerBox.height)).toBe(900);
  expect(Math.abs(tileBox.width - 256)).toBeLessThanOrEqual(2);
  expect(tileBox.x + tileBox.width).toBeLessThanOrEqual(drawerBox.x);
  expect(canvasBox.x + canvasBox.width).toBeLessThanOrEqual(tileBox.x);
  expect(headerBox.x + headerBox.width).toBeLessThanOrEqual(drawerBox.x);
  expect(dockBox.x + dockBox.width).toBeLessThanOrEqual(drawerBox.x);
  expect(await page.locator(".th-dialog-overlay").count()).toBe(0);
  expect(
    await page.evaluate(() => ({
      tiles: document.querySelectorAll(".media-p405-tile[data-chat-probe]")
        .length,
      videos: document.querySelectorAll(
        ".media-p405-shell video[data-chat-probe]",
      ).length,
    })),
  ).toEqual(probe);
  console.log(
    `[ROOM-CHAT-01 metrics] ${JSON.stringify({
      canvasAfter: canvasBox,
      canvasBefore,
      dock: dockBox,
      drawer: drawerBox,
      header: headerBox,
      tile: tileBox,
    })}`,
  );

  // ---- Host switch, seeded messages, image thumbnail and PDF card. ----
  const toggle = drawer.getByRole("switch", {
    name: "Cho phép người tham gia gửi tin nhắn",
  });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(
    drawer.getByText("Tin nhắn được lưu cho thành viên lớp · Đến: Mọi người"),
  ).toBeVisible();
  await expect(
    drawer.getByRole("button", { name: "Xem ảnh bai-3-minh-anh.png" }),
  ).toBeEnabled();
  await expect(drawer.getByText("De-cuong-on-tap-Chuong-2.pdf")).toBeVisible();
  await expect(drawer.locator("[data-jumbo]")).toHaveText("👍👏");
  await expect(drawer.getByText("Làm mới tin nhắn")).toHaveCount(0);
  await expect(drawer.getByText("Lịch sử tin nhắn")).toHaveCount(0);
  await saveRoomChatScreenshot(
    page,
    "01-chat-with-whiteboard-host-vi-1440x900.png",
  );

  // ---- Composer: emoji popover + staged image and PDF. ----
  const composer = drawer.getByRole("textbox", { name: "Nội dung tin nhắn" });
  await composer.fill("Cô gửi lời giải mẫu ");
  await drawer.getByRole("button", { name: "Biểu tượng cảm xúc" }).click();
  const picker = page.getByRole("dialog", { name: "Chọn biểu tượng cảm xúc" });
  await expect(picker).toBeVisible();
  await page.getByTestId("classroom-chat-image-input").setInputFiles({
    buffer: await lessonImagePNG(page),
    mimeType: "image/png",
    name: "loi-giai-mau.png",
  });
  await page.getByTestId("classroom-chat-file-input").setInputFiles({
    buffer: Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n"),
    mimeType: "application/pdf",
    name: "Phieu-bai-tap-tuan-12.pdf",
  });
  const strip = drawer.getByRole("list", { name: "Tệp đang chờ gửi" });
  await expect(strip.locator('[data-status="ready"]')).toHaveCount(2);
  await expect(strip.locator("img")).toHaveCount(1);
  const pickerBox = await boxOf(picker);
  expect(pickerBox.x).toBeGreaterThanOrEqual(drawerBox.x);
  expect(pickerBox.x + pickerBox.width).toBeLessThanOrEqual(1_440);
  await saveRoomChatScreenshot(
    page,
    "02-chat-emoji-picker-and-staged-files-vi-1440x900.png",
  );
  // ROOM-CHAT-EMOJI-02: picking keeps the popover open; sending closes it.
  await picker
    .getByRole("searchbox", { name: "Tìm biểu tượng cảm xúc" })
    .fill("vo tay");
  await picker.getByRole("button", { name: "vỗ tay", exact: true }).click();
  await expect(picker).toBeVisible();
  await expect(composer).toHaveValue("Cô gửi lời giải mẫu 👏");
  await composer.press("Enter");
  await expect(picker).toHaveCount(0);
  await expect(strip).toHaveCount(0);
  await expect(composer).toHaveValue("");
  await expect(drawer.getByText("Cô gửi lời giải mẫu 👏")).toBeVisible();
  await expect(
    drawer.getByRole("button", { name: "Xem ảnh loi-giai-mau.png" }),
  ).toBeEnabled();
  await expect(drawer.getByText("Phieu-bai-tap-tuan-12.pdf")).toBeVisible();
  expect(await page.evaluate(() => window.__roomChatFixture?.sent())).toBe(1);

  // ---- Lightbox. ----
  await drawer
    .getByRole("button", { name: "Xem ảnh bai-3-minh-anh.png" })
    .click();
  const lightbox = page.getByRole("dialog", { name: "bai-3-minh-anh.png" });
  await expect(
    lightbox.getByRole("img", { name: "bai-3-minh-anh.png" }),
  ).toBeVisible();
  await expect(
    lightbox.getByRole("link", { name: "Tải ảnh gốc" }),
  ).toHaveAttribute("download", "bai-3-minh-anh.png");
  await saveRoomChatScreenshot(page, "03-chat-image-lightbox-vi-1440x900.png");
  expect(
    (
      await new AxeBuilder({ page })
        .include(".classroom-chat-lightbox")
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(lightbox).toHaveCount(0);
  await expect(drawer).toBeVisible();

  // ---- Host pauses participant chat. ----
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(
    await page.evaluate(() =>
      window.__roomChatFixture?.participantChatEnabled(),
    ),
  ).toBe(false);
  await expect(composer).toBeVisible();

  expect(
    (
      await new AxeBuilder({ page })
        .include(".media-p408-chat-drawer")
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(
    (await new AxeBuilder({ page }).include(".media-p405-footer").analyze())
      .violations,
  ).toEqual([]);

  // Escape closes the inspector, returns focus and gives the width back.
  await composer.focus();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(chatKey).toBeFocused();
  await expect(chatKey).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".media-p405-shell")).not.toHaveClass(
    /media-p405-shell--inspector-open/u,
  );
});

test("ROOM-CHAT-01 shows students the unread badge and a calm read-only notice when the teacher pauses chat", async ({
  page,
}) => {
  await page.route(roomChatExternalRoute, (route) => route.abort());
  await page.setViewportSize({ width: 1_440, height: 900 });
  await mountClassroomFixture(page, {
    participantCount: 4,
    studio: {
      chat: { paused: true },
      language: "vi",
      role: "student",
      roomTitle: roomCompactTitle,
    },
  });
  await loadRoomStudioStyles(page);
  const chatKey = page.locator("#media-p408-control-chat");
  const badge = page.getByTestId("media-p408-chat-badge");
  await expect(badge).toHaveCount(0);

  await page.evaluate(() => {
    window.__roomChatFixture?.receive("Cả lớp tập trung nghe cô giảng nhé.");
    window.__roomChatFixture?.receive(
      "Cô sẽ mở lại trò chuyện sau phần ví dụ.",
    );
  });
  await expect(badge).toHaveText("2");
  await expect(chatKey).toHaveAccessibleName(
    "Mở trò chuyện trong phòng, 2 tin nhắn chưa đọc",
  );
  const keyBox = await boxOf(chatKey);
  const badgeBox = await boxOf(badge);
  expect(badgeBox.x + badgeBox.width).toBeGreaterThan(
    keyBox.x + keyBox.width - 4,
  );
  expect(badgeBox.y).toBeLessThan(keyBox.y + 4);
  expect(
    (await new AxeBuilder({ page }).include(".media-p405-footer").analyze())
      .violations,
  ).toEqual([]);
  await saveRoomChatScreenshot(
    page,
    "05-chat-student-unread-badge-closed-vi-1440x900.png",
  );

  await chatKey.click();
  const drawer = page.getByRole("dialog", { name: "Trò chuyện trong phòng" });
  await expect(drawer).toBeVisible();
  await expect(badge).toHaveCount(0);
  await expect(
    drawer.getByText("Giáo viên đã tạm tắt gửi tin nhắn cho người tham gia."),
  ).toBeVisible();
  await expect(drawer.getByRole("switch")).toHaveCount(0);
  await expect(
    drawer.getByRole("textbox", { name: "Nội dung tin nhắn" }),
  ).toHaveCount(0);
  await expect(
    drawer.getByText("Cô sẽ mở lại trò chuyện sau phần ví dụ."),
  ).toBeVisible();
  expect(
    (
      await new AxeBuilder({ page })
        .include(".media-p408-chat-drawer")
        .analyze()
    ).violations,
  ).toEqual([]);
  await saveRoomChatScreenshot(
    page,
    "04-chat-student-readonly-and-unread-badge-vi-1440x900.png",
  );
});

test("ROOM-CHAT-01 reflows the chat inspector and emoji popover at 320 CSS pixels with forced colors and no violations", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await mountClassroomFixture(page, {
    participantCount: 2,
    studio: { chat: {}, language: "vi", roomTitle: roomCompactTitle },
  });
  await loadRoomStudioStyles(page);
  const horizontalOverflow = () =>
    page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );

  const chatKey = page.locator("#media-p408-control-chat");
  await chatKey.scrollIntoViewIfNeeded();
  await chatKey.click();
  const drawer = page.getByRole("dialog", { name: "Trò chuyện trong phòng" });
  await expect(drawer).toBeVisible();
  // The sheet slides in from the right edge; measure once it has settled.
  await expect.poll(async () => Math.round((await boxOf(drawer)).x)).toBe(0);
  const drawerBox = await boxOf(drawer);
  expect(drawerBox.x).toBeGreaterThanOrEqual(0);
  expect(drawerBox.x + drawerBox.width).toBeLessThanOrEqual(320);
  expect(await horizontalOverflow()).toBeLessThanOrEqual(1);

  const emoji = drawer.getByRole("button", { name: "Biểu tượng cảm xúc" });
  await emoji.click();
  const picker = page.getByRole("dialog", { name: "Chọn biểu tượng cảm xúc" });
  await expect(picker).toBeVisible();
  await expect(
    picker.getByRole("searchbox", { name: "Tìm biểu tượng cảm xúc" }),
  ).toBeFocused();
  const pickerBox = await boxOf(picker);
  expect(pickerBox.x).toBeGreaterThanOrEqual(0);
  expect(pickerBox.x + pickerBox.width).toBeLessThanOrEqual(320);
  expect(pickerBox.y).toBeGreaterThanOrEqual(0);
  expect(await horizontalOverflow()).toBeLessThanOrEqual(1);
  await expect(picker).toHaveCSS("border-top-style", "solid");
  expect(
    (
      await new AxeBuilder({ page })
        .include(".media-p408-chat-drawer")
        .analyze()
    ).violations,
  ).toEqual([]);

  // Escape closes the popover first (focus back on its key), then the panel.
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(emoji).toBeFocused();
  await expect(drawer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(chatKey).toBeFocused();
});

// ---- ROOM-CHAT-EMOJI-02 Zalo-style emoji popover -------------------------

// Set ROOM_CHAT_EMOJI_SCREENSHOT_DIR to save the acceptance screenshots.
const roomChatEmojiScreenshotDir =
  process.env.ROOM_CHAT_EMOJI_SCREENSHOT_DIR?.trim() ?? "";

async function saveRoomChatEmojiScreenshot(page: Page, name: string) {
  if (!roomChatEmojiScreenshotDir) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${roomChatEmojiScreenshotDir}/${name}` });
}

async function openRoomChatEmojiPicker(page: Page) {
  const chatKey = page.locator("#media-p408-control-chat");
  await chatKey.scrollIntoViewIfNeeded();
  await chatKey.click();
  const drawer = page.getByRole("dialog", { name: "Trò chuyện trong phòng" });
  await expect(drawer).toBeVisible();
  const trigger = drawer.getByRole("button", { name: "Biểu tượng cảm xúc" });
  await trigger.click();
  const picker = page.getByRole("dialog", { name: "Chọn biểu tượng cảm xúc" });
  await expect(picker).toBeVisible();
  await expect(
    picker.getByRole("button", { name: "mặt cười toe toét", exact: true }),
  ).toBeVisible();
  return {
    chatKey,
    composer: drawer.getByRole("textbox", { name: "Nội dung tin nhắn" }),
    drawer,
    picker,
    stream: picker.locator(".classroom-chat-emoji__stream"),
    trigger,
  };
}

/** Every section's real offsetTop must equal the virtualiser's arithmetic. */
async function emojiSectionOffsets(stream: Locator) {
  return stream.evaluate((element) =>
    Array.from(
      element.querySelectorAll<HTMLElement>(".classroom-chat-emoji__section"),
    ).map((section) => ({
      expected: Number(section.dataset.top),
      height: section.getBoundingClientRect().height,
      id: section.dataset.section ?? "",
      offsetTop: section.offsetTop,
      styleHeight: Number.parseFloat(section.style.height),
    })),
  );
}

async function emojiSectionTop(stream: Locator, id: string) {
  const offsets = await emojiSectionOffsets(stream);
  const section = offsets.find((item) => item.id === id);
  if (!section) throw new Error(`Missing emoji section ${id}.`);
  return section.expected;
}

test("ROOM-CHAT-EMOJI-02 shows a Zalo-style emoji popover with Recent, scroll-spy, bottom topic bar and multi-pick", async ({
  page,
}) => {
  await page.route(roomChatExternalRoute, (route) => route.abort());
  await page.setViewportSize({ width: 1_440, height: 900 });
  await mountClassroomFixture(page, {
    participantCount: 4,
    studio: { chat: {}, language: "vi", roomTitle: roomCompactTitle },
  });
  await loadRoomStudioStyles(page);
  const { composer, drawer, picker, stream, trigger } =
    await openRoomChatEmojiPicker(page);
  // Opening alone stores nothing.
  expect(
    await page.evaluate(() =>
      Object.keys(window.localStorage).filter((key) =>
        key.startsWith("tutorhub:chat-emoji-recent:"),
      ),
    ),
  ).toEqual([]);

  // ---- Geometry: 344×410 popover, search → stream → bottom topic bar. ----
  const pickerBox = await boxOf(picker);
  const drawerBox = await boxOf(drawer);
  const searchBox = await boxOf(
    picker.getByRole("searchbox", { name: "Tìm biểu tượng cảm xúc" }),
  );
  const streamBox = await boxOf(stream);
  const tablist = picker.getByRole("tablist", { name: "Danh mục biểu tượng" });
  const tabsBox = await boxOf(tablist);
  expect(Math.round(pickerBox.width)).toBe(344);
  expect(Math.round(pickerBox.height)).toBe(410);
  expect(pickerBox.x).toBeGreaterThanOrEqual(drawerBox.x);
  expect(pickerBox.x + pickerBox.width).toBeLessThanOrEqual(
    drawerBox.x + drawerBox.width,
  );
  expect(searchBox.y + searchBox.height).toBeLessThanOrEqual(streamBox.y);
  expect(tabsBox.y).toBeGreaterThanOrEqual(streamBox.y + streamBox.height - 1);
  expect(
    Math.abs(pickerBox.y + pickerBox.height - (tabsBox.y + tabsBox.height)),
  ).toBeLessThanOrEqual(2);
  // A 40px bar (1px top hairline included) at the very bottom edge.
  expect(
    Math.round(
      (await boxOf(picker.locator(".classroom-chat-emoji__nav"))).height,
    ),
  ).toBe(40);
  await expect(tablist.getByRole("tab")).toHaveCount(10);
  await expect(picker.getByRole("tab", { name: "Cảm xúc" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // 8 even columns of 36px-high cells with a large colour glyph.
  const cellBoxes = await picker
    .locator('[data-cell^="smileys:"]')
    .evaluateAll((cells) =>
      cells.slice(0, 9).map((cell) => {
        const box = cell.getBoundingClientRect();
        return { height: box.height, x: box.x, y: box.y };
      }),
    );
  expect(new Set(cellBoxes.slice(0, 8).map((box) => box.y)).size).toBe(1);
  expect(cellBoxes[8]!.y).toBeGreaterThan(cellBoxes[0]!.y);
  expect(Math.round(cellBoxes[0]!.height)).toBe(36);
  await expect(picker.locator('[data-cell="smileys:0"]')).toHaveCSS(
    "font-size",
    "25px",
  );
  // CSS layout and the virtualiser agree to the pixel, so jumps are exact.
  for (const section of await emojiSectionOffsets(stream)) {
    expect(section.offsetTop, section.id).toBe(section.expected);
    expect(Math.round(section.height), section.id).toBe(section.styleHeight);
  }
  // Only the rows near the viewport exist (~1.9k emoji in the catalogue).
  expect(await picker.locator("[data-cell]").count()).toBeLessThan(260);

  // ---- Scroll-spy: wheel into Animals & Nature, then Food. ----
  const natureTop = await emojiSectionTop(stream, "nature");
  const foodTop = await emojiSectionTop(stream, "food");
  await stream.hover();
  await page.mouse.wheel(0, natureTop + 60);
  await expect(
    picker.getByRole("tab", { name: "Động vật & Thiên nhiên" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(picker.getByRole("tab", { name: "Cảm xúc" })).toHaveAttribute(
    "aria-selected",
    "false",
  );
  await page.mouse.wheel(
    0,
    foodTop + 40 - (await stream.evaluate((element) => element.scrollTop)),
  );
  await expect(
    picker.getByRole("tab", { name: "Ẩm thực & Đồ uống" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    picker.getByRole("button", { name: "chùm nho", exact: true }),
  ).toBeVisible();
  await saveRoomChatEmojiScreenshot(
    page,
    "02-zalo-emoji-scrollspy-food-nature-vi-1440x900.png",
  );

  // ---- Bottom bar jumps land on the exact first row (even the last topic). ----
  await picker.getByRole("tab", { name: "Cờ" }).click();
  await expect(picker.getByRole("tab", { name: "Cờ" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(await stream.evaluate((element) => element.scrollTop)).toBe(
    await emojiSectionTop(stream, "flags"),
  );
  const vietnam = picker.getByRole("button", {
    name: "cờ: Việt Nam",
    exact: true,
  });
  await expect(vietnam).toBeVisible();
  const vietnamBox = await boxOf(vietnam);
  expect(vietnamBox.y).toBeGreaterThanOrEqual(streamBox.y + 28);
  expect(vietnamBox.y + vietnamBox.height).toBeLessThanOrEqual(
    streamBox.y + streamBox.height,
  );
  await picker.getByRole("tab", { name: "Ẩm thực & Đồ uống" }).click();
  expect(await stream.evaluate((element) => element.scrollTop)).toBe(foodTop);
  await expect(
    picker.getByRole("tab", { name: "Ẩm thực & Đồ uống" }),
  ).toHaveAttribute("aria-selected", "true");

  // ---- Multi-pick: two emoji in a row, the stream does not jump. ----
  await picker.getByRole("tab", { name: "Con người & Cử chỉ" }).click();
  const clap = picker.getByRole("button", { name: "vỗ tay", exact: true });
  await expect(clap).toBeVisible();
  const clapBefore = await boxOf(clap);
  await clap.click();
  await expect(picker).toBeVisible();
  // "Recent" appeared above, but the clicked emoji stayed under the pointer.
  const clapAfter = await boxOf(clap);
  expect(Math.abs(clapAfter.y - clapBefore.y)).toBeLessThanOrEqual(1);
  await picker.getByRole("tab", { name: "Đồ vật & Học tập" }).click();
  await picker
    .getByRole("button", { name: "mũ tốt nghiệp", exact: true })
    .click();
  await expect(picker).toBeVisible();
  await expect(composer).toHaveValue("👏🎓");
  expect(
    await page.evaluate(() =>
      Object.entries(window.localStorage)
        .filter(([key]) => key.startsWith("tutorhub:chat-emoji-recent:v1:"))
        .map(([, value]) => JSON.parse(value) as string[]),
    ),
  ).toEqual([["🎓", "👏"]]);

  // Escape closes only the popover and returns focus to the emoji key.
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(drawer).toBeVisible();

  // ---- Reopen: "Recent" leads the stream, newest first. ----
  // Metrics only (dev-mode React, no timing assertion): the reopen commit and
  // its first frame with the virtualised rows.
  const openCost = await page.evaluate(async () => {
    const key = document.querySelector<HTMLButtonElement>(
      ".classroom-chat-emoji > .classroom-chat-tool",
    );
    const start = performance.now();
    key?.click();
    await Promise.resolve();
    const commitMs = performance.now() - start;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => setTimeout(resolve, 0)),
    );
    return {
      cells: document.querySelectorAll("[data-cell]").length,
      commitMs: Math.round(commitMs * 10) / 10,
      frameMs: Math.round((performance.now() - start) * 10) / 10,
    };
  });
  console.log(`[ROOM-CHAT-EMOJI-02 metrics] ${JSON.stringify(openCost)}`);
  await expect(picker).toBeVisible();
  expect(openCost.cells).toBeLessThan(260);
  const recent = picker.getByRole("group", { name: "Gần đây" });
  await expect(recent.getByRole("button")).toHaveText(["🎓", "👏"]);
  await expect(picker.getByRole("tab", { name: "Gần đây" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    picker.getByRole("group", { name: "Cảm xúc" }).getByRole("heading"),
  ).toBeVisible();
  expect(
    (
      await new AxeBuilder({ page })
        .include(".media-p408-chat-drawer")
        .analyze()
    ).violations,
  ).toEqual([]);
  await saveRoomChatEmojiScreenshot(
    page,
    "01-zalo-emoji-recent-and-smileys-vi-1440x900.png",
  );

  // ---- Keyboard: search → grid → across topics. ----
  const search = picker.getByRole("searchbox", {
    name: "Tìm biểu tượng cảm xúc",
  });
  await search.focus();
  await page.keyboard.press("ArrowDown");
  await expect(picker.locator('[data-cell="recent:0"]')).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(picker.locator('[data-cell="smileys:0"]')).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(picker.locator('[data-cell="smileys:1"]')).toBeFocused();
  await page.keyboard.press("Control+End");
  await expect(
    picker.getByRole("button", { name: "cờ: Xứ Wales", exact: true }),
  ).toBeFocused();
  await expect(picker.getByRole("tab", { name: "Cờ" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // ---- Vietnamese search with and without diacritics. ----
  await search.fill("bong da");
  await expect(picker.locator('[data-cell="results:0"]')).toHaveAccessibleName(
    "bóng đá",
  );
  await search.fill("mũ tốt nghiệp");
  await expect(picker.locator('[data-cell="results:0"]')).toHaveText("🎓");
  await search.fill("trai tim");
  await expect(
    picker.getByRole("button", { name: "trái tim màu đỏ", exact: true }),
  ).toBeVisible();
  await expect(
    picker.getByRole("heading", { name: /^\d+ kết quả$/u }),
  ).toBeVisible();
  for (const tab of await tablist.getByRole("tab").all()) {
    await expect(tab).toHaveAttribute("aria-selected", "false");
  }
  expect(
    (
      await new AxeBuilder({ page })
        .include(".media-p408-chat-drawer")
        .analyze()
    ).violations,
  ).toEqual([]);
  await saveRoomChatEmojiScreenshot(
    page,
    "03-zalo-emoji-vietnamese-search-vi-1440x900.png",
  );
  await search.fill("zzzz");
  await expect(picker.locator(".classroom-chat-emoji__empty")).toHaveText(
    "Không tìm thấy biểu tượng phù hợp.",
  );
  await expect(picker.getByRole("status")).toHaveText(
    "Không tìm thấy biểu tượng phù hợp.",
  );
  await picker.getByRole("button", { name: "Xóa từ khóa tìm kiếm" }).click();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();

  // ---- Sending closes the popover. ----
  await composer.press("Enter");
  await expect(picker).toHaveCount(0);
  await expect(composer).toHaveValue("");
  await expect(drawer.getByText("👏🎓")).toBeVisible();
});

test("ROOM-CHAT-EMOJI-02 reflows the emoji popover at 320 CSS pixels with forced colors and no violations", async ({
  page,
}) => {
  await page.route(roomChatExternalRoute, (route) => route.abort());
  await page.setViewportSize({ width: 320, height: 900 });
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await mountClassroomFixture(page, {
    participantCount: 2,
    studio: { chat: {}, language: "vi", roomTitle: roomCompactTitle },
  });
  await loadRoomStudioStyles(page);
  const { drawer, picker, stream, trigger } =
    await openRoomChatEmojiPicker(page);
  await expect.poll(async () => Math.round((await boxOf(drawer)).x)).toBe(0);
  const pickerBox = await boxOf(picker);
  expect(pickerBox.x).toBeGreaterThanOrEqual(0);
  expect(pickerBox.x + pickerBox.width).toBeLessThanOrEqual(320);
  expect(Math.round(pickerBox.width)).toBe(296);
  expect(pickerBox.y).toBeGreaterThanOrEqual(0);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await expect(picker).toHaveCSS("border-top-style", "solid");

  // The topic bar overflows: only the forward arrow shows at the start.
  const nav = picker.locator(".classroom-chat-emoji__nav");
  const navBox = await boxOf(nav);
  const streamBox = await boxOf(stream);
  expect(navBox.y).toBeGreaterThanOrEqual(streamBox.y + streamBox.height - 1);
  await expect(nav.locator('[data-side="end"]')).toBeVisible();
  await expect(nav.locator('[data-side="start"]')).toHaveCount(0);
  await nav.locator('[data-side="end"]').click();
  await expect(nav.locator('[data-side="start"]')).toBeVisible();
  // Keyboard End brings the last topic into view; its tab is selected.
  await picker.getByRole("tab", { name: "Cảm xúc" }).focus();
  await page.keyboard.press("End");
  const flagsTab = picker.getByRole("tab", { name: "Cờ" });
  await expect(flagsTab).toBeFocused();
  await expect(flagsTab).toHaveAttribute("aria-selected", "true");
  await expect(nav.locator('[data-side="end"]')).toHaveCount(0);
  const flagsTabBox = await boxOf(flagsTab);
  expect(flagsTabBox.x + flagsTabBox.width).toBeLessThanOrEqual(
    pickerBox.x + pickerBox.width,
  );
  await page.keyboard.press("Home");
  await expect(picker.getByRole("tab", { name: "Gần đây" })).toBeFocused();
  await expect(
    picker.getByText("Emoji bạn dùng sẽ xuất hiện tại đây"),
  ).toBeVisible();
  await picker.getByRole("tab", { name: "Cảm xúc" }).click();

  expect(
    (
      await new AxeBuilder({ page })
        .include(".media-p408-chat-drawer")
        .analyze()
    ).violations,
  ).toEqual([]);
  await saveRoomChatEmojiScreenshot(
    page,
    "04-zalo-emoji-320px-forced-colors.png",
  );

  // Escape closes the popover first (focus back on its key), then the panel.
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(drawer).toBeVisible();
});

// ---------------------------------------------------------------------------
// ROOM-PEOPLE-03: the People inspector (Google Meet × Teams × Zoom) — a slim
// "Người tham gia (N)" header, one accent-insensitive search, a waiting group
// that only exists while someone waits, collapsible in-class groups of 52px
// rows with hover/focus actions and a pinned host footer. Set
// ROOM_PEOPLE_SCREENSHOT_DIR (for example `.tmp/room-people-03`) to save the
// acceptance screenshots.
const roomPeopleScreenshotDir =
  process.env.ROOM_PEOPLE_SCREENSHOT_DIR?.trim() || "";

async function saveRoomPeopleScreenshot(page: Page, name: string) {
  if (!roomPeopleScreenshotDir) return;
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${roomPeopleScreenshotDir}/${name}` });
}

interface AdmissionCommand {
  action: "admit" | "deny";
  admissionID: string;
  body: Record<string, unknown>;
  csrf: string | null;
}

/**
 * Routes the host's admissions queue (no Core API): GET returns the current
 * waiting people, CSRF rotates, and admit/deny record the exact command and
 * drop that person from the queue.
 */
async function installRoomPeopleAdmissions(page: Page, names: string[]) {
  let sequence = 0;
  const entry = (name: string) => {
    sequence += 1;
    return {
      id: `70000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
      name,
    };
  };
  const state = {
    commands: [] as AdmissionCommand[],
    waiting: names.map(entry),
    add(name: string) {
      state.waiting.push(entry(name));
    },
  };
  await page.route(
    /\/api\/v1\/media\/spaces\/[^/]+\/admissions(\?|$)/,
    (route) =>
      route.fulfill({
        json: {
          items: state.waiting.map(({ id, name }) => ({
            created_at: new Date().toISOString(),
            display_name: name,
            expires_at: new Date(Date.now() + 600_000).toISOString(),
            id,
            status: "waiting",
            version: 1,
          })),
        },
      }),
  );
  await page.route("**/api/v1/auth/csrf", (route) =>
    route.fulfill({ json: { csrf_token: "room-people-fixture-csrf" } }),
  );
  await page.route(
    /\/api\/v1\/media\/spaces\/[^/]+\/admissions\/[^/]+\/(admit|deny)$/,
    async (route) => {
      const request = route.request();
      const segments = new URL(request.url()).pathname.split("/");
      const action = segments.at(-1) as "admit" | "deny";
      const admissionID = segments.at(-2) ?? "";
      state.commands.push({
        action,
        admissionID,
        body: request.postDataJSON() as Record<string, unknown>,
        csrf: request.headers()["x-csrf-token"] ?? null,
      });
      const resolved = state.waiting.find(({ id }) => id === admissionID);
      state.waiting = state.waiting.filter(({ id }) => id !== admissionID);
      await route.fulfill({
        json: {
          created_at: new Date().toISOString(),
          display_name: resolved?.name ?? "",
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          id: admissionID,
          status: action === "admit" ? "admitted" : "denied",
          version: 2,
        },
      });
    },
  );
  return state;
}

async function openRoomPeople(page: Page, title: string) {
  await page.locator("#media-p406-control-roster").click();
  const drawer = page.getByRole("dialog", { name: title });
  await expect(drawer).toBeVisible();
  const viewport = page.viewportSize()!;
  await expect
    .poll(async () => {
      const box = await drawer.boundingBox();
      return box ? Math.round(box.x + box.width) : 0;
    })
    .toBe(viewport.width);
  return drawer;
}

test("ROOM-PEOPLE-03 gives a host a slim People inspector with a waiting group, in-class groups and hover actions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await installRoomPeopleAdmissions(page, ["Phạm Quỳnh Như", "Lê Hoàng Nam"]);
  await mountClassroomFixture(page, {
    participantCount: 6,
    studio: {
      language: "vi",
      people: { coHost: 1, raisedHands: [3, 2], reconnecting: 4 },
      roomTitle: "Toán 9A · Phương trình bậc hai",
    },
  });
  await loadRoomStudioStyles(page);

  // The Dock key keeps its id, name and waiting badge.
  const peopleKey = page.locator("#media-p406-control-roster");
  await expect(peopleKey).toHaveAccessibleName(
    "Mở danh sách lớp học (2 người đang chờ vào phòng)",
  );
  await expect(page.locator(".media-p406-roster-badge")).toHaveText("2");

  const drawer = await openRoomPeople(page, "Người tham gia (6)");
  const drawerBox = (await drawer.boundingBox())!;
  expect(drawerBox.width).toBeLessThanOrEqual(361);
  // Non-modal inspector: the stage reflows beside it.
  const stageBox = await page.locator(".media-p405-stage").boundingBox();
  expect(stageBox!.x + stageBox!.width).toBeLessThanOrEqual(drawerBox.x + 1);

  // Header: 16px / 600, the ✕ is the only Close key, no manual refresh.
  const title = drawer.getByRole("heading", { name: "Người tham gia (6)" });
  await expect(title).toHaveCSS("font-size", "16px");
  await expect(title).toHaveCSS("font-weight", "600");
  await expect(drawer.getByRole("button", { name: "Đóng" })).toHaveCount(1);
  await expect(drawer.getByRole("button", { name: /Làm mới/ })).toHaveCount(0);
  const searchBox = drawer.locator(".media-p406-people__search");
  expect(Math.round((await searchBox.boundingBox())!.height)).toBe(36);

  // Waiting group: uppercase label, counted box, inline Admit + ⋮.
  const waitingLabel = drawer.getByRole("heading", {
    name: "Đang chờ vào lớp",
  });
  await expect(waitingLabel).toHaveCSS("text-transform", "uppercase");
  await expect(waitingLabel).toHaveCSS("font-size", "11px");
  await expect(
    drawer.getByRole("button", { name: "Đang chờ được cho phép 2" }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(
    drawer.getByRole("button", { name: "Cho Phạm Quỳnh Như vào" }),
  ).toHaveText("Chấp nhận");
  await expect(
    drawer.getByRole("button", { name: "Thao tác khác cho Lê Hoàng Nam" }),
  ).toBeVisible();
  await expect(
    drawer.locator(".media-p406-people-group[data-group='waiting']"),
  ).toHaveCSS("border-top-left-radius", "12px");

  // In class: staff and students with counts; you first, then hands FIFO,
  // then roster_sequence; the default "connected" state stays silent.
  await expect(
    drawer.getByRole("button", { name: "Giáo viên & người tổ chức 2" }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(
    drawer.getByRole("button", { name: "Học sinh 4" }),
  ).toBeVisible();
  await expect(
    drawer
      .getByRole("list", { name: "Giáo viên & người tổ chức" })
      .locator(".media-p406-people-row__display"),
  ).toHaveText(["Thu Hà (Giáo viên)", "Minh Anh"]);
  await expect(
    drawer
      .getByRole("list", { name: "Học sinh" })
      .locator(".media-p406-people-row__display"),
  ).toHaveText(["Khánh Linh", "Gia Bảo", "Đức Huy", "Ngọc Trâm"]);
  await expect(drawer.getByText("(Bạn)")).toBeVisible();
  await expect(drawer.getByText("Chủ phòng", { exact: true })).toBeVisible();
  await expect(drawer.getByText("Người đồng tổ chức")).toBeVisible();
  await expect(drawer.getByText("Đã kết nối")).toHaveCount(0);
  await expect(drawer.getByText("Đang kết nối lại…")).toBeVisible();
  await expect(drawer.locator("ol")).toHaveCount(0);
  await expect(drawer).not.toContainText("00000000-0000-4000-8000");

  // Every row is a slim line (no card, no ordinal): ≤ 56px.
  const rowHeights = await drawer
    .locator(".media-p406-people-row")
    .evaluateAll((rows) =>
      rows.map((row) => row.getBoundingClientRect().height),
    );
  expect(rowHeights).toHaveLength(8);
  for (const height of rowHeights) expect(height).toBeLessThanOrEqual(56);
  await expect(
    drawer
      .getByRole("list", { name: "Học sinh" })
      .getByRole("listitem")
      .first(),
  ).toHaveCSS("border-top-width", "0px");

  // Pinned host footer with the only server-backed bulk action.
  const footer = drawer.getByRole("group", {
    name: "Thao tác của người chủ trì",
  });
  const lowerAll = footer.getByRole("button", { name: "Hạ tất cả tay (2)" });
  expect(Math.round((await lowerAll.boundingBox())!.height)).toBe(32);
  const footerBox = (await footer.boundingBox())!;
  expect(
    Math.abs(footerBox.y + footerBox.height - drawerBox.height),
  ).toBeLessThanOrEqual(1);

  expect(
    (
      await new AxeBuilder({ page })
        .include(".media-p406-roster-drawer")
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.mouse.move(540, 720);
  await saveRoomPeopleScreenshot(
    page,
    "01-people-host-waiting-and-in-class-vi-1440x900.png",
  );

  // Row actions stay quiet until hover, then a soft 10px glass wash.
  const students = drawer.getByRole("list", { name: "Học sinh" });
  const khanh = students
    .getByRole("listitem")
    .filter({ hasText: "Khánh Linh" });
  const khanhActions = khanh.locator(".media-p406-people-row__actions");
  await expect(khanhActions).toHaveCSS("opacity", "0");
  await khanh.hover();
  await expect(khanhActions).toHaveCSS("opacity", "1");
  await expect(khanh).toHaveCSS("border-top-left-radius", "10px");
  await expect(khanh).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(
    khanh.getByRole("button", { name: "Quản trị Khánh Linh" }),
  ).toBeVisible();
  await khanh.getByRole("button", { name: "Hạ tay của Khánh Linh" }).hover();
  await expect(khanh.getByText("Tay đang giơ, vị trí 1")).toHaveCount(1);
  await saveRoomPeopleScreenshot(
    page,
    "02-people-hover-actions-raised-hand-vi-1440x900.png",
  );

  // Keyboard focus reveals the next row's actions without a pointer.
  await khanh.getByRole("button", { name: "Quản trị Khánh Linh" }).focus();
  await page.mouse.move(540, 720);
  await page.keyboard.press("Tab");
  const gia = students.getByRole("listitem").filter({ hasText: "Gia Bảo" });
  await expect(
    gia.getByRole("button", { name: "Hạ tay của Gia Bảo" }),
  ).toBeFocused();
  await expect(gia.locator(".media-p406-people-row__actions")).toHaveCSS(
    "opacity",
    "1",
  );
  await page.keyboard.press("Tab");
  const giaMenu = gia.getByRole("button", { name: "Quản trị Gia Bảo" });
  await expect(giaMenu).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("menu", { name: "Quản trị Gia Bảo" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(giaMenu).toBeFocused();

  // Groups collapse with aria-expanded.
  const staffToggle = drawer.getByRole("button", {
    name: "Giáo viên & người tổ chức 2",
  });
  await staffToggle.click();
  await expect(staffToggle).toHaveAttribute("aria-expanded", "false");
  await expect(
    drawer.locator(".media-p406-people-group[data-group='staff'] ul"),
  ).toBeHidden();
});

test("ROOM-PEOPLE-03 hides an empty waiting group, then opens and announces a new request and admits it with the exact command", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  const admissions = await installRoomPeopleAdmissions(page, []);
  await mountClassroomFixture(page, {
    participantCount: 3,
    studio: { language: "vi", people: {} },
  });
  await loadRoomStudioStyles(page);
  const drawer = await openRoomPeople(page, "Người tham gia (3)");

  // Nobody waiting: no label, no box, no description card — zero height.
  await expect(
    drawer.getByRole("heading", { name: "Đang chờ vào lớp" }),
  ).toHaveCount(0);
  const lobbySlot = drawer.locator(".media-p406-roster-lobby");
  expect(Math.round((await lobbySlot.boundingBox())?.height ?? 0)).toBe(0);
  const live = drawer.locator(
    ".media-p406-people-waiting [aria-live='polite']",
  );
  await expect(live).toHaveText("");

  admissions.add("Phạm Quỳnh Như");
  await page.evaluate(() => window.__roomPeopleFixture?.refetch());
  const waitingToggle = drawer.getByRole("button", {
    name: "Đang chờ được cho phép 1",
  });
  await expect(waitingToggle).toHaveAttribute("aria-expanded", "true");
  await expect(live).toHaveText("Có người mới xin vào lớp. 1 người đang chờ.");
  await expect(page.locator(".media-p406-roster-badge")).toHaveText("1");
  // The stage banner steps aside while People is open (no double reading).
  await expect(page.locator(".media-p406-lobby-banner")).toHaveClass(
    /media-p406-lobby-banner--idle/,
  );

  await drawer.getByRole("button", { name: "Cho Phạm Quỳnh Như vào" }).click();
  await expect.poll(() => admissions.commands.length).toBe(1);
  expect(admissions.commands[0]).toEqual({
    action: "admit",
    admissionID: "70000000-0000-4000-8000-000000000001",
    body: {
      expected_space_version: 1,
      expected_room_instance_id: "10000000-0000-4000-8000-000000000001",
      expected_room_instance_version: 1,
      expected_admission_version: 1,
      idempotency_key: expect.stringMatching(/^media-admission-admit-/),
    },
    csrf: "room-people-fixture-csrf",
  });
  const feedback = drawer.getByText("Đã cho Phạm Quỳnh Như vào.");
  await expect(feedback).toBeVisible();
  await expect(feedback).toBeFocused();
  await expect(
    drawer.getByRole("heading", { name: "Đang chờ vào lớp" }),
  ).toHaveCount(0);
  await expect(page.locator(".media-p406-roster-badge")).toHaveCount(0);
});

for (const count of [25, 50]) {
  test(`ROOM-PEOPLE-03 scrolls a ${count}-person class and searches names without accents`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await installRoomPeopleAdmissions(page, []);
    await mountClassroomFixture(page, {
      participantCount: count,
      studio: { language: "vi", people: { raisedHands: [12, 7] } },
    });
    await loadRoomStudioStyles(page);
    const drawer = await openRoomPeople(page, `Người tham gia (${count})`);
    const body = drawer.locator(".media-p406-people__body");

    // At least ten people fit one screen; the body scrolls, the page does not.
    const visibleRows = await body.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return Array.from(
        element.querySelectorAll(".media-p406-people-row"),
      ).filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.top >= box.top - 0.5 && rect.bottom <= box.bottom + 0.5;
      }).length;
    });
    expect(visibleRows).toBeGreaterThanOrEqual(10);
    const scroll = await body.evaluate((element) => ({
      client: element.clientHeight,
      height: element.scrollHeight,
    }));
    expect(scroll.height).toBeGreaterThan(scroll.client);
    await body.evaluate((element) =>
      element.scrollTo({ top: element.scrollHeight }),
    );
    await expect(
      drawer.getByText(`Học viên ${count - 1}`, { exact: true }),
    ).toBeInViewport();
    await body.evaluate((element) => element.scrollTo({ top: 0 }));
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);

    const search = drawer.getByRole("searchbox", { name: "Tìm người" });
    await search.fill("hoc vien 1");
    await expect(
      drawer.getByRole("list", { name: "Học sinh" }).getByRole("listitem"),
    ).toHaveCount(10);
    await expect(
      drawer.getByRole("button", { name: "Học sinh 10" }),
    ).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: /Giáo viên & người tổ chức/ }),
    ).toHaveCount(0);
    // A raised hand still leads the filtered group.
    await expect(
      drawer
        .getByRole("list", { name: "Học sinh" })
        .locator(".media-p406-people-row__display")
        .first(),
    ).toHaveText("Học viên 12");
    await expect(
      drawer.getByRole("button", { name: "Xóa tìm kiếm" }),
    ).toBeVisible();
    if (count === 25) {
      await page.mouse.move(540, 720);
      await saveRoomPeopleScreenshot(
        page,
        "03-people-25-participants-search-vi-1440x900.png",
      );
    }

    await search.fill("không có ai");
    await expect(
      drawer.getByText("Không tìm thấy “không có ai”"),
    ).toBeVisible();
    // Escape clears a filled box and keeps the inspector open.
    await search.press("Escape");
    await expect(search).toHaveValue("");
    await expect(drawer).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: `Học sinh ${count - 1}` }),
    ).toBeVisible();
  });
}

test("ROOM-PEOPLE-03 reflows the People inspector at 320 CSS pixels with forced colors and no violations", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await installRoomPeopleAdmissions(page, ["Phạm Quỳnh Như"]);
  await mountClassroomFixture(page, {
    participantCount: 6,
    studio: {
      language: "vi",
      people: { coHost: 1, raisedHands: [2], reconnecting: 4 },
    },
  });
  await loadRoomStudioStyles(page);
  const drawer = await openRoomPeople(page, "Người tham gia (6)");
  expect((await drawer.boundingBox())!.width).toBeLessThanOrEqual(320);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
  expect(
    await drawer.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);

  // System borders, actions always shown, group chevrons snap.
  await expect(drawer.locator(".media-p406-people-group").first()).toHaveCSS(
    "border-top-width",
    "2px",
  );
  await expect(
    drawer.locator(".media-p406-people-row__actions").first(),
  ).toHaveCSS("opacity", "1");
  await expect(
    drawer.locator(".media-p406-people-group__chevron").first(),
  ).toHaveCSS("transition-duration", "0s");
  await expect(
    drawer.getByRole("button", { name: "Cho Phạm Quỳnh Như vào" }),
  ).toBeVisible();

  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await saveRoomPeopleScreenshot(page, "04-people-320px-forced-colors.png");
});

// ROOM-STAGE-POLISH-04: a round palette paper key, Google Meet tones on
// camera-off tiles, top-right hand / reaction badges on the sender's own
// tile and Zoom / Meet floating reactions. Set
// ROOM_STAGE_POLISH_SCREENSHOT_DIR (for example
// `.tmp/room-stage-polish-04/screenshots`) to save the acceptance shots.
const roomStagePolishScreenshotDir =
  process.env.ROOM_STAGE_POLISH_SCREENSHOT_DIR?.trim() || "";

async function saveRoomStagePolishScreenshot(page: Page, name: string) {
  if (!roomStagePolishScreenshotDir) return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${roomStagePolishScreenshotDir}/${name}` });
}

function boxesIntersect(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
) {
  return (
    first.x < second.x + second.width &&
    second.x < first.x + first.width &&
    first.y < second.y + second.height &&
    second.y < first.y + first.height
  );
}

function roomTile(page: Page, name: string, scope: Page | Locator = page) {
  return scope.locator(".media-p405-tile").filter({
    has: page.locator(".media-p405-tile-meta > span", { hasText: name }),
  });
}

/** Lets the badge pop-in settle so boxes are measured at scale 1. */
async function settleTileBadges(tile: Locator) {
  await tile
    .locator(".media-p406-tile-signals")
    .evaluate((element) =>
      Promise.all(
        element
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished),
      ),
    );
}

/** Asserts the badge cluster hugs the tile's top-right corner, clear of the HUD. */
async function expectTopRightBadges(tile: Locator, inset: number) {
  await settleTileBadges(tile);
  const tileBox = await boxOf(tile);
  const badges = tile.locator(".media-p406-tile-signals");
  await expect(badges).toHaveAttribute("aria-hidden", "true");
  await expect(badges).toHaveCSS("pointer-events", "none");
  const badgeBox = await boxOf(badges);
  // `top / right: inset` from the padding box, inside the tile's 1px rim.
  for (const measured of [
    tileBox.x + tileBox.width - (badgeBox.x + badgeBox.width),
    badgeBox.y - tileBox.y,
  ]) {
    expect(measured).toBeGreaterThanOrEqual(inset - 0.5);
    expect(measured).toBeLessThanOrEqual(inset + 1.5);
  }
  expect(
    boxesIntersect(badgeBox, await boxOf(tile.locator(".media-p405-avatar"))),
  ).toBe(false);
  expect(
    boxesIntersect(
      badgeBox,
      await boxOf(tile.locator(".media-p405-tile-meta > span")),
    ),
  ).toBe(false);
  return badgeBox;
}

/** Freezes each floating lane at a different height for a stable screenshot. */
async function freezeFloatingReactions(page: Page) {
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      const effect = animation.effect;
      const target = effect instanceof KeyframeEffect ? effect.target : null;
      if (!(target instanceof HTMLElement)) continue;
      const cluster = target.closest<HTMLElement>(
        ".media-p406-reaction-cluster",
      );
      if (!cluster) continue;
      const lane = Number(cluster.dataset.lane ?? "0");
      animation.pause();
      animation.currentTime = 760 + lane * 420;
    }
  });
}

test("ROOM-STAGE-POLISH-04 gives every camera-off tile its own Google Meet tone with readable initials", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await installRoomPeopleAdmissions(page, []);
  await mountClassroomFixture(page, {
    participantCount: 6,
    studio: {
      language: "vi",
      roomTitle: "Lớp Toán 10 – Phương trình bậc hai",
    },
  });
  await loadRoomStudioStyles(page);

  const tiles = page.locator(".media-p405-grid .media-p405-tile");
  await expect(tiles).toHaveCount(6);
  const surfaces = await tiles.evaluateAll((elements) =>
    elements.map((element) => {
      const avatar = element.querySelector<HTMLElement>(".media-p405-avatar")!;
      const style = getComputedStyle(element);
      const avatarStyle = getComputedStyle(avatar);
      const luminance = (hex: string) => {
        const value = Number.parseInt(hex.trim().slice(1), 16);
        const channel = (shift: number) => {
          const c = ((value >> shift) & 255) / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
      };
      const whiteOn = (hex: string) => 1.05 / (luminance(hex) + 0.05);
      return {
        avatarTone: avatar.dataset.tone,
        background: style.backgroundImage,
        minAvatarContrast: Math.min(
          whiteOn(avatarStyle.getPropertyValue("--avatar-from")),
          whiteOn(avatarStyle.getPropertyValue("--avatar-to")),
        ),
        minTileContrast: Math.min(
          whiteOn(style.getPropertyValue("--tile-from")),
          whiteOn(style.getPropertyValue("--tile-to")),
        ),
        tone: (element as HTMLElement).dataset.tone,
      };
    }),
  );
  // Six people, six different surfaces; each medallion shares its tile tone.
  expect(new Set(surfaces.map(({ tone }) => tone)).size).toBe(6);
  expect(new Set(surfaces.map(({ background }) => background)).size).toBe(6);
  for (const surface of surfaces) {
    expect(surface.tone).toMatch(/^[0-7]$/);
    expect(surface.avatarTone).toBe(surface.tone);
    expect(surface.background).toContain("linear-gradient");
    expect(surface.minAvatarContrast).toBeGreaterThanOrEqual(5);
    expect(surface.minTileContrast).toBeGreaterThanOrEqual(9);
  }
  expect(
    (await new AxeBuilder({ page }).include(".media-p405-shell").analyze())
      .violations,
  ).toEqual([]);
  await saveRoomStagePolishScreenshot(
    page,
    "02-google-meet-diverse-tile-colors-grid.png",
  );
});

test("ROOM-STAGE-POLISH-04 pins hand and reaction badges to the sender's top-right corner while reactions float up above the Dock", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await installRoomPeopleAdmissions(page, []);
  await mountClassroomFixture(page, {
    participantCount: 5,
    studio: {
      language: "vi",
      roomTitle: "Lớp Toán 10 – Phương trình bậc hai",
      people: {
        raisedHands: [1, 3],
        reactions: [
          { index: 1, reaction: "heart" },
          { index: 2, reaction: "clap" },
          { index: 0, reaction: "thumbs_up" },
        ],
        floating: [
          { reaction: "heart", count: 3 },
          { reaction: "clap", count: 2 },
          { reaction: "celebrate", count: 1 },
        ],
      },
    },
  });
  await loadRoomStudioStyles(page);

  // Minh Anh: first in the hand queue and just sent a heart.
  const minhAnh = roomTile(page, "Minh Anh");
  await expectTopRightBadges(minhAnh, 10);
  await expect(minhAnh.locator(".media-p406-tile-signals > *")).toHaveCount(2);
  await expect(minhAnh.locator(".media-p406-tile-reaction")).toHaveText("❤️");
  await expect(minhAnh.locator(".media-p406-tile-hand__position")).toHaveText(
    "1",
  );
  const handBox = await boxOf(minhAnh.locator(".media-p406-tile-hand"));
  const reactionBox = await boxOf(minhAnh.locator(".media-p406-tile-reaction"));
  expect(reactionBox.x + reactionBox.width).toBeLessThanOrEqual(handBox.x - 4);
  await expect(minhAnh.locator(".media-p406-tile-hand")).toHaveCSS(
    "color",
    "rgb(31, 20, 0)",
  );
  await expect(
    roomTile(page, "Khánh Linh").locator(".media-p406-tile-hand__position"),
  ).toHaveText("2");
  await expect(
    roomTile(page, "Gia Bảo").locator(".media-p406-tile-reaction"),
  ).toHaveText("👏");
  await expect(
    roomTile(page, "Thu Hà").locator(".media-p406-tile-reaction"),
  ).toHaveText("👍");
  await expect(
    roomTile(page, "Đức Huy").locator(".media-p406-tile-signals"),
  ).toHaveCount(0);

  // Floating reactions: at most three lanes, rising from the bottom-left of
  // the stage just above the Dock, never catching the pointer.
  const region = page.locator(".media-p406-reactions");
  await expect(region).toHaveAttribute("aria-hidden", "true");
  const clusters = region.locator(".media-p406-reaction-cluster");
  await expect(clusters).toHaveCount(3);
  await expect(clusters.first()).toHaveCSS(
    "animation-name",
    "media-p406-reaction-float",
  );
  await expect(clusters.first()).toHaveCSS("pointer-events", "none");
  await expect(
    clusters.nth(0).locator(".media-p406-reaction-count"),
  ).toHaveText("×3");
  await expect(
    clusters.nth(2).locator(".media-p406-reaction-count"),
  ).toHaveCount(0);
  await expect(region.locator(".media-p406-reaction-echo")).toHaveCount(3);
  const regionBox = await boxOf(region);
  const footerBox = await boxOf(page.locator(".media-p405-footer"));
  const stageBox = await boxOf(page.locator(".media-p405-classroom"));
  expect(regionBox.y + regionBox.height).toBeLessThanOrEqual(footerBox.y);
  expect(regionBox.x).toBeGreaterThanOrEqual(stageBox.x);
  expect(regionBox.x - stageBox.x).toBeLessThanOrEqual(32);

  expect(
    (await new AxeBuilder({ page }).include(".media-p405-shell").analyze())
      .violations,
  ).toEqual([]);
  await freezeFloatingReactions(page);
  await saveRoomStagePolishScreenshot(
    page,
    "03-top-right-hand-and-reaction-plus-floating-zoom.png",
  );

  // The 360px People inspector never covers the launch strip.
  const drawer = await openRoomPeople(page, "Người tham gia (5)");
  const drawerBox = await boxOf(drawer);
  const shiftedRegion = await boxOf(region);
  expect(shiftedRegion.x + shiftedRegion.width).toBeLessThanOrEqual(
    drawerBox.x,
  );
  await page.keyboard.press("Escape");

  // Reduced motion: still pills, no travel, no pop — badges stay.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(clusters.first()).toHaveCSS("animation-name", "none");
  await expect(minhAnh.locator(".media-p406-tile-reaction")).toHaveCSS(
    "animation-name",
    "none",
  );
  await expect(
    region.locator(".media-p406-reaction-echo").first(),
  ).toBeHidden();
  await expect(minhAnh.locator(".media-p406-tile-hand")).toBeVisible();
});

test("ROOM-STAGE-POLISH-04 keeps a round palette key in the Top Bar and compact badges on the 256px camera strip", async ({
  page,
}) => {
  // Hermetic: Excalidraw may ask a CDN for optional fonts; stay on localhost.
  await page.route(
    /^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])[^/]+\//,
    (route) => route.abort(),
  );
  await page.setViewportSize({ width: 1_440, height: 900 });
  await installRoomPeopleAdmissions(page, []);
  await mountClassroomFixture(page, {
    participantCount: 4,
    studio: {
      boardTitle: "Bài 3 · Phương trình bậc hai & Đồ thị hàm số",
      language: "vi",
      roomTitle: "Lớp Toán 10 – Phương trình bậc hai",
      whiteboard: "paper",
      people: {
        raisedHands: [1],
        reactions: [
          { index: 1, reaction: "heart" },
          { index: 2, reaction: "clap" },
        ],
        floating: [
          { reaction: "heart", count: 2 },
          { reaction: "clap", count: 1 },
        ],
      },
    },
  });
  await loadRoomStudioStyles(page);
  await openWhiteboardStage(page);
  await expect(
    page.getByRole("region", { name: "Bề mặt bảng trắng tương tác" }),
  ).toBeVisible();

  // ---- Top Bar: palette key level with ⋯ and Close. ----
  const header = page.locator(".media-p405-header");
  const trigger = header.getByTestId("whiteboard-paper-trigger");
  const close = header.getByRole("button", { name: "Đóng", exact: true });
  await expect(trigger).toHaveAccessibleName("Giấy: Bảng trắng (Trơn)");
  await expect(trigger).toHaveAttribute(
    "data-tooltip",
    "Giấy: Bảng trắng (Trơn)",
  );
  const triggerBox = await boxOf(trigger);
  const closeBox = await boxOf(close);
  expect(Math.round(triggerBox.width)).toBe(28);
  expect(Math.round(triggerBox.height)).toBe(28);
  expect(Math.round(triggerBox.y)).toBe(Math.round(closeBox.y));
  const toolMenu = header.locator(".whiteboard-topbar-menu-trigger");
  if ((await toolMenu.count()) > 0) {
    const menuBox = await boxOf(toolMenu.first());
    expect(Math.round(menuBox.width)).toBe(28);
    expect(Math.round(menuBox.y)).toBe(Math.round(triggerBox.y));
  }
  await expect(trigger).toHaveCSS("border-top-left-radius", "999px");
  expect((await readGlass(trigger)).backdropFilter).toMatch(/blur\(18px\)/);
  const palette = trigger.locator("svg.lucide-palette");
  await expect(palette).toHaveAttribute("aria-hidden", "true");
  const paletteBox = await boxOf(palette);
  expect(Math.round(paletteBox.width)).toBe(15);
  expect(Math.round(paletteBox.height)).toBe(15);
  await expect(trigger.locator(".whiteboard-paper-swatch")).toHaveCount(0);

  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect((await readGlass(trigger)).backgroundImage).toContain(
    "linear-gradient",
  );
  const popover = page.getByRole("dialog", { name: "Chọn chế độ giấy" });
  await expect(popover).toBeVisible();
  await expect(popover.locator("button[data-paper-mode]")).toHaveCount(9);
  expect(
    (await new AxeBuilder({ page }).include(".media-p405-shell").analyze())
      .violations,
  ).toEqual([]);
  await saveRoomStagePolishScreenshot(
    page,
    "01-topbar-palette-icon-and-popover.png",
  );
  await popover
    .getByRole("button", { name: "Vở học sinh", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(trigger).toHaveAccessibleName("Giấy: Vở học sinh");
  await expect(trigger.locator("svg.lucide-palette")).toHaveCount(1);
  await page.mouse.move(720, 450);

  // ---- 256px camera strip: toned tiles with compact top-right badges. ----
  const strip = page.locator(
    ".media-p405-classroom--tool-stage > .media-p405-stage",
  );
  const stripBox = await boxOf(strip);
  expect(Math.round(stripBox.width)).toBe(256);
  const stripTiles = strip.locator(".media-p405-tile");
  await expect(stripTiles).toHaveCount(4);
  const tones = await stripTiles.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-tone")),
  );
  expect(new Set(tones).size).toBe(4);
  const minhAnh = roomTile(page, "Minh Anh", strip);
  const badgeBox = await expectTopRightBadges(minhAnh, 6);
  expect(Math.round(badgeBox.height)).toBe(24);
  await expect(minhAnh.locator(".media-p406-tile-hand")).toHaveCSS(
    "height",
    "22px",
  );
  await expect(minhAnh.locator(".media-p406-tile-hand__position")).toHaveCount(
    0,
  );
  const pin = minhAnh.locator(".media-p405-tile-meta .th-button");
  expect(boxesIntersect(badgeBox, await boxOf(pin))).toBe(false);

  // Reactions launch from the board's bottom-left, clear of the strip.
  const region = page.locator(".media-p406-reactions");
  await expect(region.locator(".media-p406-reaction-cluster")).toHaveCount(2);
  const regionBox = await boxOf(region);
  expect(regionBox.x + regionBox.width).toBeLessThan(stripBox.x);
  // ... and above the board's own bottom row (zoom / undo), inset from its edge.
  const boardBox = await boxOf(page.locator(".media-p506-tool-stage"));
  expect(
    boardBox.y + boardBox.height - (regionBox.y + regionBox.height),
  ).toBeGreaterThanOrEqual(60);
  expect(regionBox.x - boardBox.x).toBeGreaterThanOrEqual(30);
  await trigger.evaluate((element) => element.blur());
  await freezeFloatingReactions(page);
  await saveRoomStagePolishScreenshot(
    page,
    "04-whiteboard-camera-strip-signals-and-tones.png",
  );
});
