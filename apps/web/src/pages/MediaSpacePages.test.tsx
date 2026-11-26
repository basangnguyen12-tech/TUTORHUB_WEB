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
import {
  APIRequestError,
  type CurrentUser,
  type CodeWorkspaceProjection,
  type MediaSpace,
  type WhiteboardToolProjection,
} from "@tutorhub/api-client";
import { StrictMode } from "react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../app/i18n";
import {
  clearMediaRoomEscrow,
  finalizeMediaRoomEscrowClaim,
  NO_VISUAL_EFFECTS,
  putMediaRoomEscrow,
  takeMediaRoomEscrow,
  type MediaInstanceCredentialProjection,
} from "../app/mediaPrejoin";
import { SessionProvider } from "../app/session";
import { MediaSpacePreJoinPage } from "./MediaSpacePages";
import { MediaSpaceRoomPage } from "./MediaSpaceRoomPage";

import { availableTenantCapabilities } from "../test/tenantCapabilities";

const apiMocks = vi.hoisted(() => ({
  cancelJoinAttempt: vi.fn(),
  createJoinAttempt: vi.fn(),
  getCurrentCSRF: vi.fn(),
  getJoinAttempt: vi.fn(),
  getMediaSpace: vi.fn(),
  getTenantCapabilities: vi.fn(),
  issueJoinCredential: vi.fn(),
  listParticipants: vi.fn(),
  mutateSignal: vi.fn(),
  recordDiagnostic: vi.fn(),
  recoverMediaSpace: vi.fn(),
  resolveCodeWorkspace: vi.fn(),
  resolveWhiteboard: vi.fn(),
  rotateCSRFToken: vi.fn(),
  updateProfile: vi.fn(),
}));

interface MockLocalTrack {
  detach: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

const liveKitMocks = vi.hoisted(() => {
  const trackPublications = new Map<string, { track?: MockLocalTrack }>();
  const unpublishTrack = vi.fn(
    async (track: MockLocalTrack, stopOnUnpublish: boolean) => {
      void stopOnUnpublish;
      for (const [trackID, publication] of trackPublications) {
        if (publication.track === track) trackPublications.delete(trackID);
      }
    },
  );
  return {
    codeGrantsRender: vi.fn(),
    listeners: new Map<string, Set<(...args: unknown[]) => void>>(),
    roomConnect: vi.fn().mockResolvedValue(undefined),
    roomConstruct: vi.fn(),
    roomDisconnect: vi.fn().mockResolvedValue(undefined),
    setCameraEnabled: vi.fn().mockResolvedValue(undefined),
    shellRender: vi.fn(),
    setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
    setScreenShareEnabled: vi.fn().mockResolvedValue(undefined),
    setComponentsLogLevel: vi.fn(),
    setRoomLogLevel: vi.fn(),
    startAudioRender: vi.fn(),
    switchActiveDevice: vi.fn().mockResolvedValue(undefined),
    trackPublications,
    unpublishTrack,
  };
});

const effectsRuntime = vi.hoisted(() => {
  const started: Array<{
    stream: MediaStream;
    destroy: ReturnType<typeof vi.fn>;
  }> = [];
  const runtime = {
    supportsVisualEffects: vi.fn(() => true),
    startStandaloneVisualEffects: vi.fn(
      async (
        _track: MediaStreamTrack,
        plan: { mode: "lighting" | "background" },
      ) => {
        const handle = {
          mode: plan.mode,
          stream: { id: "processed-preview" } as unknown as MediaStream,
          apply: vi.fn(
            async (next: { mode: string }) => next.mode === plan.mode,
          ),
          destroy: vi.fn(async () => undefined),
        };
        started.push(handle);
        return handle;
      },
    ),
  };
  return { runtime, started };
});

vi.mock("../features/media/visualEffectsProcessor", () => ({
  visualEffectsRuntime: effectsRuntime.runtime,
}));

vi.mock("@tutorhub/api-client", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@tutorhub/api-client")>();
  return {
    ...original,
    cancelMediaJoinAttempt: apiMocks.cancelJoinAttempt,
    createMediaSpaceJoinAttempt: apiMocks.createJoinAttempt,
    getCurrentCSRFToken: apiMocks.getCurrentCSRF,
    getMediaJoinAttempt: apiMocks.getJoinAttempt,
    getMediaSpace: apiMocks.getMediaSpace,
    getTenantCapabilities: apiMocks.getTenantCapabilities,
    issueMediaSpaceJoinCredential: apiMocks.issueJoinCredential,
    listMediaSpaceParticipants: apiMocks.listParticipants,
    mutateMediaSpaceSignal: apiMocks.mutateSignal,
    recordMediaSpaceDiagnostic: apiMocks.recordDiagnostic,
    recoverMediaSpace: apiMocks.recoverMediaSpace,
    resolveCodeWorkspace: apiMocks.resolveCodeWorkspace,
    resolveWhiteboard: apiMocks.resolveWhiteboard,
    rotateCSRFToken: apiMocks.rotateCSRFToken,
    updateProfile: apiMocks.updateProfile,
  };
});

vi.mock("@livekit/components-react", () => ({
  RoomContext: {
    Provider: (props: { children?: React.ReactNode }) => props.children ?? null,
  },
  RoomAudioRenderer: () => null,
  StartAudio: (props: { label: string }) => {
    liveKitMocks.startAudioRender(props);
    return <button type="button">{props.label}</button>;
  },
  setLogLevel: liveKitMocks.setComponentsLogLevel,
}));

vi.mock("../features/media/ClassroomMediaShell", async () => {
  const { useContext } = await import("react");
  const { ClassroomCodeEditorGrantsContext } =
    await import("../features/classroom-tools/codeEditorGrantsContext");
  return {
    ClassroomMediaShell: (props: {
      controlAbortSignal?: AbortSignal;
      onLeave: () => void;
      onTerminalMediaCleanup: () => Promise<void>;
      tools?: Array<{
        autoOpenKey?: string | null;
        content?: { props?: { enabled?: boolean } };
        id: string;
      }>;
    }) => {
      liveKitMocks.shellRender(props);
      // ROOM-TOOLS-CODE-02B: the room provides Code edit grants around the
      // LiveKit room (read by the People panel inside the shell).
      liveKitMocks.codeGrantsRender(
        useContext(ClassroomCodeEditorGrantsContext),
      );
      return (
        <section>
          <h1>TutorHub classroom</h1>
          <button onClick={props.onLeave} type="button">
            Mock leave room
          </button>
        </section>
      );
    },
  };
});

vi.mock("livekit-client", () => ({
  DisconnectReason: {
    UNKNOWN_REASON: 0,
    CLIENT_INITIATED: 1,
    DUPLICATE_IDENTITY: 2,
    PARTICIPANT_REMOVED: 4,
    ROOM_DELETED: 5,
    ROOM_CLOSED: 10,
  },
  getLogger: () => ({ setLevel: liveKitMocks.setRoomLogLevel }),
  LogLevel: { silent: 5 },
  RoomEvent: {
    Connected: "connected",
    Disconnected: "disconnected",
    Reconnected: "reconnected",
    Reconnecting: "reconnecting",
    SignalConnected: "signalConnected",
  },
  Room: class MockRoom {
    localParticipant = {
      setCameraEnabled: liveKitMocks.setCameraEnabled,
      setMicrophoneEnabled: liveKitMocks.setMicrophoneEnabled,
      setScreenShareEnabled: liveKitMocks.setScreenShareEnabled,
      trackPublications: liveKitMocks.trackPublications,
      unpublishTrack: liveKitMocks.unpublishTrack,
    };
    connect = liveKitMocks.roomConnect;
    disconnect = liveKitMocks.roomDisconnect;
    switchActiveDevice = liveKitMocks.switchActiveDevice;

    constructor() {
      liveKitMocks.roomConstruct();
    }

    on(event: string, listener: (...args: unknown[]) => void) {
      const listeners = liveKitMocks.listeners.get(event) ?? new Set();
      listeners.add(listener);
      liveKitMocks.listeners.set(event, listeners);
      return this;
    }

    off(event: string, listener: (...args: unknown[]) => void) {
      liveKitMocks.listeners.get(event)?.delete(listener);
      return this;
    }
  },
}));

function emitRoomEvent(
  event:
    | "connected"
    | "disconnected"
    | "reconnected"
    | "reconnecting"
    | "signalConnected",
  ...args: unknown[]
) {
  for (const listener of liveKitMocks.listeners.get(event) ?? []) {
    listener(...args);
  }
}

const tenantID = "4b18543a-74de-419f-9fe8-d0c3dfc991eb";
const userID = "1d7d65eb-904e-4a0d-bd24-a8ec1b453d64";
const spaceID = "c2dc1048-1d90-4c90-ae50-5fb436bfb607";
const otherSpaceID = "595666d8-969e-49cb-bb12-25d624d1aad6";
const sessionID = "8477ee76-c4aa-431f-bb65-405f4b6575c9";
const roomInstanceID = "c5f918a5-a09e-4f94-9fab-fb0ab5702a4d";
const participantSessionID = "f680fd29-c7f1-4083-af9b-52ad1db14ba9";
const joinAttemptID = "a860f06d-34f9-4c57-89f8-1541bfb3b6d7";
const participantOpaqueID = "018f4c7b-9b0a-7a34-8a4c-96d26cb87221";
const whiteboardDocumentID = "6f1d7e2a-3b9c-4d8e-9f10-2a3b4c5d6e7f";

function tenantCapabilitiesWithWhiteboard(enabled: boolean) {
  const capabilities = availableTenantCapabilities(tenantID);
  return {
    ...capabilities,
    features: {
      ...capabilities.features,
      classroom_whiteboards: {
        ...capabilities.features.classroom_whiteboards,
        enabled,
      },
    },
  };
}

const currentUser: CurrentUser = {
  user: {
    id: userID,
    email: "student@example.test",
    display_name: "Student One",
    locale: "en",
    timezone: "Asia/Ho_Chi_Minh",
  },
  active_tenant: {
    id: tenantID,
    slug: "tutorhub-test",
    name: "TutorHub Test",
    role: "student",
    is_active: true,
    status: "active",
    version: 1,
  },
  memberships: [],
  permissions: ["session.join"],
};

const mediaSpace: MediaSpace = {
  id: spaceID,
  source: { kind: "class_session", class_session_id: sessionID },
  status: "open",
  version: 4,
  active_room_instance: {
    id: roomInstanceID,
    status: "active",
    version: 2,
    created_at: "2030-08-03T00:00:00Z",
    updated_at: "2030-08-03T00:01:00Z",
  },
  recovery_room_instance: null,
  viewer_operations: {
    can_start: false,
    can_end: false,
    can_cancel: false,
    can_manage_admissions: false,
    can_manage_invites: false,
    can_recover: false,
  },
  created_at: "2030-08-03T00:00:00Z",
  updated_at: "2030-08-03T00:01:00Z",
};

type FakeTrack = Omit<MediaStreamTrack, "stop"> & {
  stop: ReturnType<typeof vi.fn>;
};

function fakeTrack(kind: "audio" | "video", deviceId: string): FakeTrack {
  return {
    contentHint: "",
    getSettings: () =>
      kind === "audio"
        ? {
            autoGainControl: true,
            deviceId,
            echoCancellation: true,
            noiseSuppression: true,
          }
        : { deviceId },
    kind,
    stop: vi.fn(),
  } as unknown as FakeTrack;
}

function fakeStream() {
  const audio = fakeTrack("audio", "microphone-1");
  const video = fakeTrack("video", "camera-1");
  const stream = {
    getAudioTracks: () => [audio],
    getTracks: () => [audio, video],
    getVideoTracks: () => [video],
  } as unknown as MediaStream;
  return { audio, stream, video };
}

function device(
  kind: MediaDeviceKind,
  deviceId: string,
  label: string,
): MediaDeviceInfo {
  return {
    deviceId,
    groupId: `${deviceId}-group`,
    kind,
    label,
    toJSON: () => ({ deviceId, kind, label }),
  };
}

function fakeMediaDevices(stream: MediaStream) {
  const events = new EventTarget();
  return {
    addEventListener: events.addEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    enumerateDevices: vi
      .fn()
      .mockResolvedValue([
        device("audioinput", "microphone-1", "Class microphone"),
        device("videoinput", "camera-1", "Class camera"),
        device("audiooutput", "speaker-1", "Class speaker"),
      ]),
    getSupportedConstraints: () => ({
      autoGainControl: true,
      echoCancellation: true,
      noiseSuppression: true,
    }),
    getUserMedia: vi.fn().mockResolvedValue(stream),
    removeEventListener: events.removeEventListener.bind(events),
  } as unknown as MediaDevices & {
    enumerateDevices: ReturnType<typeof vi.fn>;
    getUserMedia: ReturnType<typeof vi.fn>;
  };
}

function LocationProbe() {
  const location = useLocation();
  return (
    <>
      <output data-testid="route-path">{location.pathname}</output>
      <output data-testid="route-state">
        {JSON.stringify(location.state)}
      </output>
    </>
  );
}

function RoomScopeNavigation() {
  const navigate = useNavigate();
  return (
    <nav aria-label="Test room scope">
      <button
        onClick={() =>
          void navigate(
            `/app/media/spaces/${otherSpaceID}/instances/${roomInstanceID}/room`,
          )
        }
        type="button"
      >
        Open other room scope
      </button>
      <button
        onClick={() =>
          void navigate(
            `/app/media/spaces/${spaceID}/instances/${roomInstanceID}/room`,
          )
        }
        type="button"
      >
        Return to original room scope
      </button>
    </nav>
  );
}

function renderPrejoin(
  mediaDevices: MediaDevices,
  routeState?: unknown,
  user: CurrentUser = currentUser,
) {
  vi.stubGlobal("navigator", {
    mediaDevices,
    onLine: true,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    ),
  );
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLanguage="en">
        <SessionProvider mode={{ kind: "static", currentUser: user }}>
          <MemoryRouter
            initialEntries={[
              {
                pathname: `/app/media/spaces/${spaceID}/prejoin`,
                state: routeState,
              },
            ]}
          >
            <Routes>
              <Route
                element={<MediaSpacePreJoinPage />}
                path="/app/media/spaces/:spaceId/prejoin"
              />
              <Route
                element={<p>Canonical room destination</p>}
                path="/app/media/spaces/:spaceId/instances/:roomInstanceId/room"
              />
            </Routes>
            <LocationProbe />
          </MemoryRouter>
        </SessionProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

/** Joins with whatever the preview holds — nothing opened unless enabled. */
function clickJoin() {
  fireEvent.click(screen.getByRole("button", { name: "Join" }));
}

/** Records the request order of a join that ends in the waiting room. */
function trackJoinOrder(): string[] {
  const order: string[] = [];
  apiMocks.rotateCSRFToken.mockImplementation(async () => {
    order.push("csrf");
    return { csrf_token: "media-csrf" };
  });
  apiMocks.createJoinAttempt.mockImplementation(async () => {
    order.push("attempt");
    return {
      admission_request_id: "d48a301d-c468-4f65-8da2-029fc379ee74",
      admission_version: 1,
      join_attempt_id: joinAttemptID,
      participant_session_id: participantSessionID,
      room_instance_id: roomInstanceID,
      status: "waiting",
      version: 1,
    };
  });
  return order;
}

function renderCanonicalRoom() {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  return render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLanguage="en">
          <SessionProvider mode={{ kind: "static", currentUser }}>
            <MemoryRouter
              initialEntries={[
                `/app/media/spaces/${spaceID}/instances/${roomInstanceID}/room`,
              ]}
            >
              <Routes>
                <Route
                  element={<MediaSpaceRoomPage />}
                  path="/app/media/spaces/:spaceId/instances/:roomInstanceId/room"
                />
              </Routes>
              <RoomScopeNavigation />
              <LocationProbe />
            </MemoryRouter>
          </SessionProvider>
        </I18nProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

function renderedWhiteboardEnabled(): boolean | undefined {
  const shellProps = liveKitMocks.shellRender.mock.lastCall?.[0] as
    | {
        tools?: Array<{
          content?: { props?: { enabled?: boolean } };
          id: string;
        }>;
      }
    | undefined;

  return shellProps?.tools?.find((tool) => tool.id === "whiteboard")?.content
    ?.props?.enabled;
}

function renderedCodeToolEnabled(): boolean | undefined {
  const shellProps = liveKitMocks.shellRender.mock.lastCall?.[0] as
    | {
        tools?: Array<{
          content?: { props?: { enabled?: boolean } };
          id: string;
        }>;
      }
    | undefined;

  return shellProps?.tools?.find((tool) => tool.id === "code")?.content?.props
    ?.enabled;
}

function tenantCapabilitiesWithCodeTool(enabled: boolean) {
  const capabilities = tenantCapabilitiesWithWhiteboard(true);
  return {
    ...capabilities,
    features: {
      ...capabilities.features,
      classroom_code_tool: {
        ...capabilities.features.classroom_code_tool,
        enabled,
      },
    },
  };
}

function renderedWhiteboardAutoOpenKey(): string | null | undefined {
  const shellProps = liveKitMocks.shellRender.mock.lastCall?.[0] as
    { tools?: Array<{ autoOpenKey?: string | null; id: string }> } | undefined;

  return shellProps?.tools?.find((tool) => tool.id === "whiteboard")
    ?.autoOpenKey;
}

function whiteboardProjection(
  overrides: {
    canExchangeGrant?: boolean;
    generation?: number;
    status?: "created" | "open" | "suspended" | "closed";
  } = {},
): WhiteboardToolProjection {
  return {
    can_create: false,
    document: {
      id: whiteboardDocumentID,
      media_space_id: spaceID,
      status: overrides.status ?? "open",
      current_generation: overrides.generation ?? 3,
      revoke_generation: 1,
      version: 5,
      created_at: "2030-08-03T00:00:00Z",
      updated_at: "2030-08-03T00:02:00Z",
      viewer_capabilities: {
        can_close: false,
        can_create_snapshot: false,
        can_exchange_grant: overrides.canExchangeGrant ?? true,
        can_export: false,
        can_open: false,
        can_restore: false,
        can_resume: false,
        can_suspend: false,
        capability: "view",
      },
    },
  };
}

const codeWorkspaceID = "5b0c6f0e-3d7a-4c38-9f15-2a7f9a3d1c11";

function tenantCapabilitiesWithCodeCollaboration(
  codeTool: boolean,
  collaboration: boolean,
) {
  const capabilities = tenantCapabilitiesWithCodeTool(codeTool);
  return {
    ...capabilities,
    features: {
      ...capabilities.features,
      classroom_code_collaboration: {
        configured_enabled: collaboration,
        enabled: collaboration,
      },
    },
  };
}

function codeWorkspaceProjection(
  overrides: {
    canExchangeGrant?: boolean;
    status?: "created" | "open" | "suspended" | "closed";
  } = {},
): CodeWorkspaceProjection {
  return {
    active_editor_grants: [
      {
        expires_at: "2030-08-03T00:10:00Z",
        participant_key: participantOpaqueID,
      },
    ],
    can_create: false,
    workspace: {
      created_at: "2030-08-03T00:00:00Z",
      current_generation: 4,
      id: codeWorkspaceID,
      media_space_id: spaceID,
      revoke_generation: 2,
      status: overrides.status ?? "open",
      updated_at: "2030-08-03T00:02:00Z",
      version: 6,
      viewer_capabilities: {
        can_close: false,
        can_exchange_grant: overrides.canExchangeGrant ?? true,
        can_manage_editor_grants: false,
        can_open: false,
        can_resume: false,
        can_suspend: false,
        capability: "view",
      },
    },
  };
}

function renderedCodeTool():
  | {
      autoOpenKey?: string | null;
      props?: {
        classID?: string | null;
        codeRoster?: unknown;
        collaborationEnabled?: boolean;
        displayName?: string;
        enabled?: boolean;
        isStaff?: boolean;
        libraryEnabled?: boolean;
      };
    }
  | undefined {
  const shellProps = liveKitMocks.shellRender.mock.lastCall?.[0] as
    | {
        tools?: Array<{
          autoOpenKey?: string | null;
          content?: {
            props?: {
              classID?: string | null;
              codeRoster?: unknown;
              collaborationEnabled?: boolean;
              displayName?: string;
              enabled?: boolean;
              isStaff?: boolean;
              libraryEnabled?: boolean;
            };
          };
          id: string;
        }>;
      }
    | undefined;
  const tool = shellProps?.tools?.find((candidate) => candidate.id === "code");
  return tool
    ? { autoOpenKey: tool.autoOpenKey, props: tool.content?.props }
    : undefined;
}

function putCanonicalRoomEscrow(
  choices: {
    audioEnabled: boolean;
    videoEnabled: boolean;
    audioDeviceId: string;
    videoDeviceId: string;
    speakerDeviceId: string;
    audioMode: "speech" | "original_sound";
  } = {
    audioEnabled: false,
    videoEnabled: false,
    audioDeviceId: "",
    videoDeviceId: "",
    speakerDeviceId: "",
    audioMode: "speech",
  },
  credentialOverrides: Partial<MediaInstanceCredentialProjection> = {},
) {
  putMediaRoomEscrow({
    scope: {
      tenantId: tenantID,
      userId: userID,
      spaceId: spaceID,
      roomInstanceId: roomInstanceID,
    },
    credential: {
      access_token: "strict-mode-memory-token",
      server_url: "wss://media.example.test",
      participant_session_id: participantSessionID,
      room_instance_id: roomInstanceID,
      join_attempt_id: joinAttemptID,
      instance_role: "attendee",
      can_publish_camera_microphone: true,
      can_share_screen: false,
      can_subscribe: true,
      expires_at: "2030-08-03T00:05:00Z",
      ...credentialOverrides,
    },
    choices: { ...choices, visualEffects: NO_VISUAL_EFFECTS },
  });
}

describe("MediaSpacePreJoinPage P4-03 boundaries", () => {
  beforeEach(() => {
    clearMediaRoomEscrow();
    apiMocks.getMediaSpace.mockResolvedValue(mediaSpace);
    apiMocks.getTenantCapabilities.mockResolvedValue(
      tenantCapabilitiesWithWhiteboard(false),
    );
    apiMocks.listParticipants.mockResolvedValue({
      room_instance_id: roomInstanceID,
      projection_version: 1,
      last_signal_sequence: 0,
      self_participant_key: participantOpaqueID,
      viewer_operations: {
        can_raise_hand: true,
        can_send_reaction: true,
        can_moderate_hands: false,
      },
      participants: [
        {
          participant_key: participantOpaqueID,
          roster_sequence: 1,
          display_name: "Student One",
          instance_role: "attendee",
          connection_state: "connected",
        },
      ],
      raised_hands: [],
      reaction_clusters: [],
      server_time: "2030-08-03T00:00:00Z",
    });
    apiMocks.getJoinAttempt.mockResolvedValue({
      admission_request_id: "d48a301d-c468-4f65-8da2-029fc379ee74",
      admission_version: 1,
      join_attempt_id: joinAttemptID,
      participant_session_id: participantSessionID,
      room_instance_id: roomInstanceID,
      status: "waiting",
      version: 1,
    });
    apiMocks.rotateCSRFToken.mockResolvedValue({ csrf_token: "media-csrf" });
    apiMocks.getCurrentCSRF.mockReturnValue("media-csrf");
    apiMocks.recordDiagnostic.mockResolvedValue(undefined);
    apiMocks.recoverMediaSpace.mockResolvedValue(mediaSpace);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
      () => undefined,
    );
  });

  afterEach(async () => {
    cleanup();
    await Promise.resolve();
    clearMediaRoomEscrow();
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    apiMocks.createJoinAttempt.mockReset();
    apiMocks.getCurrentCSRF.mockReset();
    apiMocks.cancelJoinAttempt.mockReset();
    apiMocks.getJoinAttempt.mockReset();
    apiMocks.getMediaSpace.mockReset();
    apiMocks.getTenantCapabilities.mockReset();
    apiMocks.issueJoinCredential.mockReset();
    apiMocks.listParticipants.mockReset();
    apiMocks.mutateSignal.mockReset();
    apiMocks.recordDiagnostic.mockReset();
    apiMocks.recoverMediaSpace.mockReset();
    apiMocks.resolveCodeWorkspace.mockReset();
    apiMocks.resolveWhiteboard.mockReset();
    apiMocks.rotateCSRFToken.mockReset();
    apiMocks.updateProfile.mockReset();
    liveKitMocks.codeGrantsRender.mockReset();
    liveKitMocks.listeners.clear();
    liveKitMocks.roomConnect.mockReset().mockResolvedValue(undefined);
    liveKitMocks.roomConstruct.mockClear();
    liveKitMocks.shellRender.mockReset();
    liveKitMocks.roomDisconnect.mockClear();
    liveKitMocks.setCameraEnabled.mockReset().mockResolvedValue(undefined);
    liveKitMocks.setMicrophoneEnabled.mockReset().mockResolvedValue(undefined);
    liveKitMocks.setScreenShareEnabled.mockReset().mockResolvedValue(undefined);
    liveKitMocks.setComponentsLogLevel.mockClear();
    liveKitMocks.setRoomLogLevel.mockClear();
    liveKitMocks.startAudioRender.mockReset();
    liveKitMocks.switchActiveDevice.mockClear();
    liveKitMocks.trackPublications.clear();
    liveKitMocks.unpublishTrack.mockClear();
  });

  it("keeps whiteboard fail-closed while capabilities load and enables only exact true", async () => {
    const capabilities =
      createDeferred<ReturnType<typeof tenantCapabilitiesWithWhiteboard>>();
    apiMocks.getTenantCapabilities.mockReturnValue(capabilities.promise);
    putCanonicalRoomEscrow();
    renderCanonicalRoom();

    await screen.findByRole("heading", { name: "TutorHub classroom" });
    expect(renderedWhiteboardEnabled()).toBe(false);

    await act(async () => {
      capabilities.resolve(tenantCapabilitiesWithWhiteboard(true));
      await capabilities.promise;
    });

    await waitFor(() => expect(renderedWhiteboardEnabled()).toBe(true));
  });

  it("keeps whiteboard disabled when the tenant capability is false", async () => {
    apiMocks.getTenantCapabilities.mockResolvedValue(
      tenantCapabilitiesWithWhiteboard(false),
    );
    putCanonicalRoomEscrow();
    renderCanonicalRoom();

    await screen.findByRole("heading", { name: "TutorHub classroom" });
    await waitFor(() => {
      expect(apiMocks.getTenantCapabilities).toHaveBeenCalledWith(
        tenantID,
        expect.any(Object),
      );
      expect(renderedWhiteboardEnabled()).toBe(false);
    });
  });

  it("keeps whiteboard disabled when capability resolution fails closed", async () => {
    apiMocks.getTenantCapabilities.mockResolvedValue(
      availableTenantCapabilities(otherSpaceID),
    );
    putCanonicalRoomEscrow();
    renderCanonicalRoom();

    await screen.findByRole("heading", { name: "TutorHub classroom" });
    await waitFor(() => {
      expect(apiMocks.getTenantCapabilities).toHaveBeenCalledWith(
        tenantID,
        expect.any(Object),
      );
      expect(renderedWhiteboardEnabled()).toBe(false);
    });
  });

  it("registers both the whiteboard and code tools for the classroom (ROOM-TOOLS-CODE-01)", async () => {
    apiMocks.getTenantCapabilities.mockResolvedValue(
      tenantCapabilitiesWithWhiteboard(true),
    );
    putCanonicalRoomEscrow();
    renderCanonicalRoom();

    await screen.findByRole("heading", { name: "TutorHub classroom" });
    await waitFor(() => expect(renderedWhiteboardEnabled()).toBe(true));
    const shellProps = liveKitMocks.shellRender.mock.lastCall?.[0] as
      | {
          chat?: { props?: { codeSession?: unknown } };
          tools?: Array<{
            content?: {
              props?: {
                actorID?: string;
                chatCanPost?: boolean;
                enabled?: boolean;
                mediaSpaceID?: string;
                onSendToChat?: unknown;
                session?: unknown;
                tenantID?: string;
              };
            };
            icon?: unknown;
            id: string;
            label: string;
            title: string;
          }>;
        }
      | undefined;
    const tools = shellProps?.tools ?? [];
    expect(tools.map((tool) => tool.id)).toEqual(["whiteboard", "code"]);
    expect(tools.map(({ label, title }) => ({ label, title }))).toEqual([
      { label: "Whiteboard", title: "Classroom whiteboard" },
      { label: "Code", title: "Code tool" },
    ]);
    for (const tool of tools) expect(tool.icon).toBeTruthy();

    const code = tools.find((tool) => tool.id === "code")?.content?.props;
    expect(code).toMatchObject({
      actorID: userID,
      enabled: true,
      mediaSpaceID: spaceID,
      tenantID,
    });
    expect(typeof code?.chatCanPost).toBe("boolean");
    expect(typeof code?.onSendToChat).toBe("function");
    // One per-room-session Code memory shared with chat "Open in Code".
    expect(code?.session).toBeTruthy();
    expect(shellProps?.chat?.props?.codeSession).toBe(code?.session);
  });

  it("binds the Code tool to the classroom_code_tool kill-switch (ROOM-TOOLS-CODE-02A)", async () => {
    apiMocks.getTenantCapabilities.mockResolvedValue(
      tenantCapabilitiesWithCodeTool(false),
    );
    putCanonicalRoomEscrow();
    renderCanonicalRoom();

    await screen.findByRole("heading", { name: "TutorHub classroom" });
    await waitFor(() => expect(renderedWhiteboardEnabled()).toBe(true));
    expect(renderedCodeToolEnabled()).toBe(false);
  });

  it("passes a presenter auto-open key only for an open whiteboard the viewer can join", async () => {
    apiMocks.getTenantCapabilities.mockResolvedValue(
      tenantCapabilitiesWithWhiteboard(true),
    );
    apiMocks.resolveWhiteboard.mockResolvedValue(whiteboardProjection());
    putCanonicalRoomEscrow();
    renderCanonicalRoom();

    await screen.findByRole("heading", { name: "TutorHub classroom" });
    await waitFor(() => expect(renderedWhiteboardEnabled()).toBe(true));
    // The projection is only read once the LiveKit room is connected.
    expect(apiMocks.resolveWhiteboard).not.toHaveBeenCalled();
    expect(renderedWhiteboardAutoOpenKey()).toBeNull();

    act(() => emitRoomEvent("connected"));

    await waitFor(() =>
      expect(renderedWhiteboardAutoOpenKey()).toBe(`${whiteboardDocumentID}:3`),
    );
    expect(apiMocks.resolveWhiteboard).toHaveBeenCalledWith(
      tenantID,
      spaceID,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each([
    { label: "a suspended board", overrides: { status: "suspended" as const } },
    {
      label: "a board without a grant",
      overrides: { canExchangeGrant: false },
    },
  ])("keeps the whiteboard stage closed for $label", async ({ overrides }) => {
    apiMocks.getTenantCapabilities.mockResolvedValue(
      tenantCapabilitiesWithWhiteboard(true),
    );
    apiMocks.resolveWhiteboard.mockResolvedValue(
      whiteboardProjection(overrides),
    );
    putCanonicalRoomEscrow();
    renderCanonicalRoom();
    await screen.findByRole("heading", { name: "TutorHub classroom" });
    await waitFor(() => expect(renderedWhiteboardEnabled()).toBe(true));

    act(() => emitRoomEvent("connected"));

    await waitFor(() =>
      expect(apiMocks.resolveWhiteboard).toHaveBeenCalledTimes(1),
    );
    await act(async () => Promise.resolve());
    expect(renderedWhiteboardAutoOpenKey()).toBeNull();
  });

  it("keeps roster and whiteboard projections active while LiveKit is reconnecting", async () => {
    const space = createDeferred<MediaSpace>();
    apiMocks.getMediaSpace.mockReturnValue(space.promise);
    apiMocks.getTenantCapabilities.mockResolvedValue(
      tenantCapabilitiesWithWhiteboard(true),
    );
    apiMocks.resolveWhiteboard.mockResolvedValue(whiteboardProjection());
    putCanonicalRoomEscrow();
    renderCanonicalRoom();

    await screen.findByRole("heading", { name: "TutorHub classroom" });
    act(() => emitRoomEvent("connected"));
    act(() => emitRoomEvent("reconnecting"));
    expect(apiMocks.listParticipants).not.toHaveBeenCalled();
    expect(apiMocks.resolveWhiteboard).not.toHaveBeenCalled();

    // The room scope only becomes ready during the transient ICE recovery; the
    // projections must start (not wait for "reconnected") and stay mounted.
    await act(async () => {
      space.resolve(mediaSpace);
      await space.promise;
    });

    await waitFor(() => {
      expect(apiMocks.listParticipants).toHaveBeenCalledWith(
        tenantID,
        spaceID,
        roomInstanceID,
        mediaSpace.version,
        mediaSpace.active_room_instance?.version,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(apiMocks.resolveWhiteboard).toHaveBeenCalledWith(
        tenantID,
        spaceID,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
    await waitFor(() =>
      expect(renderedWhiteboardAutoOpenKey()).toBe(`${whiteboardDocumentID}:3`),
    );
  });

  it("turns on shared Code and auto-opens it only with both switches and an open, exchangeable workspace (ROOM-TOOLS-CODE-02B)", async () => {
    apiMocks.getTenantCapabilities.mockResolvedValue(
      tenantCapabilitiesWithCodeCollaboration(true, true),
    );
    apiMocks.resolveWhiteboard.mockResolvedValue(
      whiteboardProjection({ status: "suspended" }),
    );
    apiMocks.resolveCodeWorkspace.mockResolvedValue(codeWorkspaceProjection());
    putCanonicalRoomEscrow();
    renderCanonicalRoom();

    await screen.findByRole("heading", { name: "TutorHub classroom" });
    await waitFor(() =>
      expect(renderedCodeTool()?.props?.collaborationEnabled).toBe(true),
    );
    // Read only once the LiveKit room is connected.
    expect(apiMocks.resolveCodeWorkspace).not.toHaveBeenCalled();
    expect(renderedCodeTool()?.autoOpenKey).toBeNull();
    expect(liveKitMocks.codeGrantsRender).toHaveBeenLastCalledWith(null);

    act(() => emitRoomEvent("connected"));

    await waitFor(() =>
      expect(renderedCodeTool()?.autoOpenKey).toBe(`${codeWorkspaceID}:4`),
    );
    expect(apiMocks.resolveCodeWorkspace).toHaveBeenCalledWith(
      tenantID,
      spaceID,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const code = renderedCodeTool()?.props;
    expect(code).toMatchObject({
      collaborationEnabled: true,
      displayName: "Student One",
      enabled: true,
    });
    await waitFor(() =>
      expect(renderedCodeTool()?.props?.codeRoster).toEqual({
        participants: [
          expect.objectContaining({
            display_name: "Student One",
            participant_key: participantOpaqueID,
          }),
        ],
        roomInstanceID,
        selfParticipantKey: participantOpaqueID,
      }),
    );
    // The People panel reads the grants from the room context; a viewer
    // without can_manage_editor_grants only sees who is editing.
    const grants = liveKitMocks.codeGrantsRender.mock.lastCall?.[0] as
      | {
          activeParticipantKeys: ReadonlySet<string>;
          canManage: boolean;
          maxEditors: number;
        }
      | null
      | undefined;
    expect(grants?.canManage).toBe(false);
    expect(grants?.maxEditors).toBe(3);
    expect([...(grants?.activeParticipantKeys ?? [])]).toEqual([
      participantOpaqueID,
    ]);
  });

  it.each([
    { code: true, collaboration: false, label: "the collaboration switch off" },
    { code: false, collaboration: true, label: "the Code tool switch off" },
  ])(
    "keeps the personal Code tool and never polls the workspace with $label",
    async ({ code, collaboration }) => {
      apiMocks.getTenantCapabilities.mockResolvedValue(
        tenantCapabilitiesWithCodeCollaboration(code, collaboration),
      );
      apiMocks.resolveWhiteboard.mockResolvedValue(whiteboardProjection());
      apiMocks.resolveCodeWorkspace.mockResolvedValue(
        codeWorkspaceProjection(),
      );
      putCanonicalRoomEscrow();
      renderCanonicalRoom();

      await screen.findByRole("heading", { name: "TutorHub classroom" });
      await waitFor(() => expect(renderedCodeToolEnabled()).toBe(code));
      act(() => emitRoomEvent("connected"));
      await waitFor(() =>
        expect(renderedWhiteboardAutoOpenKey()).toBe(
          `${whiteboardDocumentID}:3`,
        ),
      );
      expect(apiMocks.resolveCodeWorkspace).not.toHaveBeenCalled();
      expect(renderedCodeTool()?.props?.collaborationEnabled).toBe(false);
      expect(renderedCodeTool()?.autoOpenKey).toBeNull();
      expect(liveKitMocks.codeGrantsRender).toHaveBeenLastCalledWith(null);
    },
  );

  it.each([
    {
      label: "a workspace that is not open",
      overrides: { status: "suspended" as const },
    },
    {
      label: "a workspace without a grant exchange",
      overrides: { canExchangeGrant: false },
    },
  ])("keeps the Code stage closed for $label", async ({ overrides }) => {
    apiMocks.getTenantCapabilities.mockResolvedValue(
      tenantCapabilitiesWithCodeCollaboration(true, true),
    );
    apiMocks.resolveWhiteboard.mockResolvedValue(
      whiteboardProjection({ status: "suspended" }),
    );
    apiMocks.resolveCodeWorkspace.mockResolvedValue(
      codeWorkspaceProjection(overrides),
    );
    putCanonicalRoomEscrow();
    renderCanonicalRoom();
    await screen.findByRole("heading", { name: "TutorHub classroom" });
    await waitFor(() =>
      expect(renderedCodeTool()?.props?.collaborationEnabled).toBe(true),
    );

    act(() => emitRoomEvent("connected"));

    await waitFor(() =>
      expect(apiMocks.resolveCodeWorkspace).toHaveBeenCalledTimes(1),
    );
    await act(async () => Promise.resolve());
    expect(renderedCodeTool()?.autoOpenKey).toBeNull();
    expect(renderedCodeTool()?.props?.collaborationEnabled).toBe(true);
  });

  it("wires the durable Code library, the class and the staff hint from server projections only (ROOM-TOOLS-CODE-03B)", async () => {
    const classID = "2a6f4d0b-0f27-4c3e-9a40-6c7d3c1d5e21";
    const capabilities = tenantCapabilitiesWithCodeTool(true);
    apiMocks.getTenantCapabilities.mockResolvedValue({
      ...capabilities,
      features: {
        ...capabilities.features,
        code_snippet_library: { configured_enabled: true, enabled: true },
      },
    });
    apiMocks.resolveWhiteboard.mockResolvedValue(
      whiteboardProjection({ status: "suspended" }),
    );
    apiMocks.getMediaSpace.mockResolvedValue({
      ...mediaSpace,
      source: {
        ...mediaSpace.source,
        class_id: classID,
      } as unknown as MediaSpace["source"],
    });
    const attendee = await apiMocks.listParticipants();
    apiMocks.listParticipants.mockResolvedValue({
      ...attendee,
      participants: attendee.participants.map(
        (participant: Record<string, unknown>) => ({
          ...participant,
          instance_role: "teaching_assistant",
        }),
      ),
    });
    putCanonicalRoomEscrow();
    renderCanonicalRoom();

    await screen.findByRole("heading", { name: "TutorHub classroom" });
    await waitFor(() =>
      expect(renderedCodeTool()?.props?.libraryEnabled).toBe(true),
    );
    // Before the server roster arrives, a student account is not staff.
    expect(renderedCodeTool()?.props).toMatchObject({
      classID,
      isStaff: false,
      libraryEnabled: true,
    });

    act(() => emitRoomEvent("connected"));
    await waitFor(() => expect(renderedCodeTool()?.props?.isStaff).toBe(true));
    expect(renderedCodeTool()?.props?.classID).toBe(classID);
  });

  it.each([
    {
      label: "the library switch off",
      library: false,
      source: { kind: "class_session", class_session_id: sessionID },
    },
    {
      label: "a study meeting",
      library: true,
      source: {
        class_id: "2a6f4d0b-0f27-4c3e-9a40-6c7d3c1d5e21",
        kind: "study_meeting",
        study_meeting_id: sessionID,
      },
    },
  ])(
    "keeps the class snippets and the library closed for $label",
    async ({ library, source }) => {
      const capabilities = tenantCapabilitiesWithCodeTool(true);
      apiMocks.getTenantCapabilities.mockResolvedValue({
        ...capabilities,
        features: {
          ...capabilities.features,
          code_snippet_library: {
            configured_enabled: library,
            enabled: library,
          },
        },
      });
      apiMocks.resolveWhiteboard.mockResolvedValue(
        whiteboardProjection({ status: "suspended" }),
      );
      apiMocks.getMediaSpace.mockResolvedValue({
        ...mediaSpace,
        source: source as unknown as MediaSpace["source"],
      });
      putCanonicalRoomEscrow();
      renderCanonicalRoom();

      await screen.findByRole("heading", { name: "TutorHub classroom" });
      await waitFor(() => expect(renderedCodeToolEnabled()).toBe(true));
      act(() => emitRoomEvent("connected"));
      await waitFor(() => expect(apiMocks.listParticipants).toHaveBeenCalled());
      expect(renderedCodeTool()?.props).toMatchObject({
        classID: null,
        isStaff: false,
        libraryEnabled: library,
      });
    },
  );

  it("renders the Enter Meeting studio with only the reference surfaces", async () => {
    renderPrejoin(fakeMediaDevices(fakeStream().stream), {
      returnTo: "/app/classrooms/abc",
      classTitle: "  Physics\u0000 10A  ",
    });

    const heading = await screen.findByRole("heading", {
      level: 1,
      name: "Enter Meeting",
    });
    expect(screen.getByRole("main")).toContainElement(heading);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);

    // Thin header: back link with the sanitized class and workspace names,
    // the language switch on the right, no app navigation and no footer.
    const banner = screen.getByRole("banner");
    expect(
      within(banner).getByRole("link", { name: "← Back to class" }),
    ).toHaveAttribute("href", "/app/classrooms/abc");
    expect(within(banner).getByText("Physics 10A")).toBeInTheDocument();
    expect(within(banner).getByText("TutorHub Test")).toBeInTheDocument();
    const language = within(banner).getByRole("combobox", {
      name: "Language",
    });
    expect(language.closest(".language-select")).not.toBeNull();
    expect(
      screen.queryByRole("navigation", { name: "Main navigation" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("student@example.test");

    // Camera frame: name top-left, ⋮ top-right, one question and one CTA.
    const stage = document.querySelector(".media-p403-preview") as HTMLElement;
    expect(within(stage).getByText("Student One")).toHaveClass(
      "media-p403-preview__name",
    );
    expect(
      within(stage).getByRole("button", { name: "More options" }),
    ).toHaveAttribute("aria-haspopup", "menu");
    expect(
      within(stage).getByText(
        "Do you want people to see and hear you in the meeting?",
      ),
    ).toBeVisible();
    expect(
      within(stage).getByRole("button", {
        name: "Allow microphone and camera",
      }),
    ).toBeInTheDocument();

    // Exactly three separate round buttons along the bottom edge.
    const controls = within(stage).getByRole("group", {
      name: "Microphone and camera",
    });
    expect(within(controls).getAllByRole("button")).toHaveLength(3);
    expect(
      within(controls).getByRole("button", { name: "Microphone" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      within(controls).getByRole("button", { name: "Camera" }),
    ).toHaveAttribute("aria-pressed", "false");
    // ADR-0041: the third circle opens Backgrounds and effects.
    const effects = within(controls).getByRole("button", {
      name: "Backgrounds and effects",
    });
    expect(effects).toHaveAttribute("aria-haspopup", "dialog");
    expect(effects).not.toHaveAttribute("aria-pressed");

    // Four disabled "Permission needed" pills; nothing is enumerated yet.
    const pills = screen.getByRole("group", { name: "Devices" });
    const placeholders = within(pills).getAllByRole("combobox");
    expect(placeholders.map((pill) => pill.getAttribute("aria-label"))).toEqual(
      ["Microphone", "Speaker", "Camera", "Audio mode"],
    );
    for (const pill of placeholders) {
      expect(pill).toBeDisabled();
      expect(pill).toHaveDisplayValue("Permission needed");
    }

    // Flat form: name, remember checkbox, Join and the two-link terms line.
    const name = screen.getByRole("textbox", { name: "Your Name" });
    expect(name).toHaveValue("Student One");
    expect(name).toHaveAttribute("maxlength", "80");
    expect(
      screen.getByRole("checkbox", {
        name: "Remember my name for future meetings",
      }),
    ).toBeChecked();
    expect(screen.getByRole("button", { name: "Join" })).toHaveAttribute(
      "type",
      "submit",
    );
    const terms = screen.getByText(/By clicking “Join”, you agree to our/);
    expect(terms).toHaveTextContent(
      "By clicking “Join”, you agree to our Terms of Service and Privacy Statement.",
    );
    for (const link of ["Terms of Service", "Privacy Statement"]) {
      expect(within(terms).getByRole("button", { name: link })).toHaveAttribute(
        "aria-haspopup",
        "dialog",
      );
    }

    // Nothing from the earlier, wordier drafts.
    for (const removed of [
      "Join now",
      "Join listen-only",
      "Don't use audio",
      "Computer audio",
      "Cancel",
      "Live session open",
      "Connection diagnostics (24h)",
      "Signed in as",
      "Enter your name.",
      "Get ready for class",
    ]) {
      expect(document.body).not.toHaveTextContent(removed);
    }
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      document.querySelector(
        ".media-p403-hud, .media-p403-dock, .media-p403-audio-cards, .media-p403-studio__avatar",
      ),
    ).toBeNull();
    expect(document.body).not.toHaveTextContent(
      /Core API|credential|SDP|health endpoint/,
    );

    fireEvent.change(language, { target: { value: "vi" } });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Vào phòng học" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Tên của bạn" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", {
        name: "Ghi nhớ tên của tôi cho các buổi học sau",
      }),
    ).toBeChecked();
    expect(
      screen.getByRole("button", { name: "Tham gia" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Cho phép micro và camera" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Bạn có muốn mọi người nhìn thấy và nghe thấy bạn trong buổi học?",
      ),
    ).toBeVisible();
    expect(screen.getAllByDisplayValue("Cần cấp quyền")).toHaveLength(4);
    expect(screen.getByText(/Bằng việc nhấn “Tham gia”/)).toHaveTextContent(
      "Bằng việc nhấn “Tham gia”, bạn đồng ý với Điều khoản dịch vụ và Chính sách bảo mật của chúng tôi.",
    );
    expect(
      within(banner).getByRole("link", { name: "← Quay lại lớp học" }),
    ).toBeInTheDocument();
  });

  it("drops a non-text class title and shortens an oversized one", async () => {
    renderPrejoin(fakeMediaDevices(fakeStream().stream), {
      returnTo: "/app/classrooms/abc",
      classTitle: { html: "<img src=x>" },
    });
    await screen.findByRole("heading", { level: 1, name: "Enter Meeting" });
    const banner = screen.getByRole("banner");
    expect(banner.querySelector(".media-p403-studio__class")).toBeNull();
    expect(document.querySelector("img")).toBeNull();

    cleanup();
    renderPrejoin(fakeMediaDevices(fakeStream().stream), {
      classTitle: "A".repeat(200),
    });
    await screen.findByRole("heading", { level: 1, name: "Enter Meeting" });
    expect(
      screen.getByRole("banner").querySelector(".media-p403-studio__class"),
    ).toHaveTextContent(new RegExp(`^${"A".repeat(80)}…$`));
  });

  it("keeps the language switch and back link available while the space loads", async () => {
    const space = createDeferred<MediaSpace>();
    apiMocks.getMediaSpace.mockReset().mockReturnValue(space.promise);
    renderPrejoin(fakeMediaDevices(fakeStream().stream));

    const banner = await screen.findByRole("banner");
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");
    expect(
      within(banner).getByRole("combobox", { name: "Language" }),
    ).toBeInTheDocument();
    expect(
      within(banner).getByRole("link", { name: "← Back to Home" }),
    ).toHaveAttribute("href", "/app/home");

    await act(async () => {
      space.resolve(mediaSpace);
      await space.promise;
    });
    expect(
      await screen.findByRole("heading", { name: "Enter Meeting" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("main")).not.toHaveAttribute("aria-busy");
  });

  it("moves focus from the Allow button to the camera button once access is granted", async () => {
    const media = fakeMediaDevices(fakeStream().stream);
    renderPrejoin(media);
    await screen.findByRole("heading", { name: "Enter Meeting" });

    const allow = screen.getByRole("button", {
      name: "Allow microphone and camera",
    });
    allow.focus();
    fireEvent.click(allow);

    const camera = screen.getByRole("button", { name: "Camera" });
    await waitFor(() => expect(camera).toHaveAttribute("aria-pressed", "true"));
    expect(camera).toHaveFocus();
    expect(
      screen.queryByRole("button", { name: "Allow microphone and camera" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "Do you want people to see and hear you in the meeting?",
      ),
    ).not.toBeInTheDocument();
    expect(document.querySelector(".media-p403-preview")).toHaveClass(
      "media-p403-preview--video",
    );
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
    expect(media.enumerateDevices).toHaveBeenCalledTimes(1);

    // Granted: the four pills become the real device and audio-mode choices.
    expect(screen.getByRole("combobox", { name: "Microphone" })).toHaveValue(
      "microphone-1",
    );
    const speaker = screen.getByRole("combobox", { name: "Speaker" });
    expect(speaker).toHaveValue("speaker-1");
    expect(
      within(speaker).getByRole("option", { name: "Default speaker" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Camera" })).toHaveValue(
      "camera-1",
    );
    const audioMode = screen.getByRole("combobox", { name: "Audio mode" });
    expect(audioMode).toHaveDisplayValue("Voice");

    fireEvent.change(audioMode, { target: { value: "original_sound" } });
    await waitFor(() => expect(media.getUserMedia).toHaveBeenCalledTimes(2));
    expect(media.getUserMedia).toHaveBeenLastCalledWith({
      audio: {
        autoGainControl: { ideal: false },
        deviceId: { exact: "microphone-1" },
        echoCancellation: { ideal: false },
        noiseSuppression: { ideal: false },
      },
      video: false,
    });
    expect(audioMode).toHaveValue("original_sound");
  });

  it("does not capture media or create a join attempt during initial render", async () => {
    const media = fakeMediaDevices(fakeStream().stream);
    renderPrejoin(media);

    expect(
      await screen.findByRole("heading", { name: "Enter Meeting" }),
    ).toBeInTheDocument();
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(media.enumerateDevices).not.toHaveBeenCalled();
    expect(apiMocks.rotateCSRFToken).not.toHaveBeenCalled();
    expect(apiMocks.createJoinAttempt).not.toHaveBeenCalled();
    expect(apiMocks.issueJoinCredential).not.toHaveBeenCalled();
    expect(liveKitMocks.roomConnect).not.toHaveBeenCalled();
  });

  it("gives the microphone and camera buttons a permission hint before any capture", async () => {
    const media = fakeMediaDevices(fakeStream().stream);
    renderPrejoin(media);
    await screen.findByRole("heading", { name: "Enter Meeting" });

    for (const name of ["Camera", "Microphone"]) {
      const toggle = screen.getByRole("button", { name });
      expect(toggle).toHaveAttribute("aria-pressed", "false");
      expect(toggle).toHaveClass("media-p403-round--needs-permission");
      expect(toggle).toHaveAccessibleDescription(
        "Your browser will ask for permission when you turn this on.",
      );
    }
    // Playwright matches names by substring; the CTA and Join stay unique.
    expect(
      screen.getAllByRole("button", { name: /allow microphone and camera/i }),
    ).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^join$/i })).toHaveLength(1);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(media.enumerateDevices).not.toHaveBeenCalled();
  });

  it("toggles the camera and microphone independently and joins with that choice", async () => {
    const cameraCapture = fakeStream();
    const microphoneCapture = fakeStream();
    const media = fakeMediaDevices(cameraCapture.stream);
    media.getUserMedia
      .mockReset()
      .mockResolvedValueOnce(cameraCapture.stream)
      .mockResolvedValueOnce(microphoneCapture.stream);
    apiMocks.createJoinAttempt.mockResolvedValue({
      admission_request_id: null,
      join_attempt_id: joinAttemptID,
      participant_session_id: participantSessionID,
      room_instance_id: roomInstanceID,
      status: "admitted",
      version: 1,
    });
    apiMocks.issueJoinCredential.mockResolvedValue({
      access_token: "independent-toggle-token",
      server_url: "wss://media.example.test",
      participant_session_id: participantSessionID,
      room_instance_id: roomInstanceID,
      join_attempt_id: joinAttemptID,
      instance_role: "attendee",
      can_publish_camera_microphone: true,
      can_share_screen: false,
      can_subscribe: true,
      expires_at: "2030-08-03T00:05:00Z",
    });
    renderPrejoin(media);
    await screen.findByRole("heading", { name: "Enter Meeting" });
    const cameraButton = screen.getByRole("button", { name: "Camera" });
    const microphoneButton = screen.getByRole("button", { name: "Microphone" });
    const stage = document.querySelector(".media-p403-preview") as HTMLElement;

    // Camera first: only the camera is requested; the microphone stays off.
    fireEvent.click(cameraButton);
    await waitFor(() =>
      expect(cameraButton).toHaveAttribute("aria-pressed", "true"),
    );
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
    expect(media.getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: {},
    });
    expect(media.enumerateDevices).toHaveBeenCalledTimes(1);
    expect(cameraCapture.audio.stop).toHaveBeenCalledTimes(1);
    expect(microphoneButton).toHaveAttribute("aria-pressed", "false");
    expect(microphoneButton).toHaveClass("media-p403-round--off");
    expect(screen.getByRole("combobox", { name: "Camera" })).toHaveValue(
      "camera-1",
    );
    expect(stage).toHaveClass("media-p403-preview--video");

    // Microphone next: an audio-only capture of the selected microphone.
    fireEvent.click(microphoneButton);
    await waitFor(() =>
      expect(microphoneButton).toHaveAttribute("aria-pressed", "true"),
    );
    expect(media.getUserMedia).toHaveBeenCalledTimes(2);
    expect(media.getUserMedia).toHaveBeenLastCalledWith({
      audio: {
        autoGainControl: { ideal: true },
        deviceId: { exact: "microphone-1" },
        echoCancellation: { ideal: true },
        noiseSuppression: { ideal: true },
      },
      video: false,
    });
    expect(microphoneCapture.video.stop).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("combobox", { name: "Microphone" })).toHaveValue(
      "microphone-1",
    );

    // Turning the camera off releases its track; the microphone keeps going
    // and the frame shows the name monogram instead of the video.
    fireEvent.click(cameraButton);
    await waitFor(() =>
      expect(cameraButton).toHaveAttribute("aria-pressed", "false"),
    );
    expect(cameraButton).toHaveClass("media-p403-round--off");
    expect(cameraCapture.video.stop).toHaveBeenCalledTimes(1);
    expect(microphoneCapture.audio.stop).not.toHaveBeenCalled();
    expect(stage).not.toHaveClass("media-p403-preview--video");
    expect(
      stage.querySelector(".media-p403-preview__monogram"),
    ).toHaveTextContent("SO");
    expect(media.getUserMedia).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    await screen.findByText("Canonical room destination");
    // An unchanged name never triggers a profile save.
    expect(apiMocks.updateProfile).not.toHaveBeenCalled();
    expect(
      takeMediaRoomEscrow({
        tenantId: tenantID,
        userId: userID,
        spaceId: spaceID,
        roomInstanceId: roomInstanceID,
      }),
    ).toMatchObject({
      choices: {
        audioEnabled: true,
        videoEnabled: false,
        audioDeviceId: "microphone-1",
      },
    });
  });

  it("keeps speaker test, audio mode and stop preview inside the ⋮ menu", async () => {
    const media = fakeMediaDevices(fakeStream().stream);
    renderPrejoin(media);
    await screen.findByRole("heading", { name: "Enter Meeting" });

    const openMenu = async () => {
      fireEvent.pointerDown(
        screen.getByRole("button", { name: "More options" }),
        { button: 0, ctrlKey: false },
      );
      return screen.findByRole("menu");
    };

    let menu = await openMenu();
    expect(
      within(menu).getByRole("menuitemradio", { name: "Voice" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      within(menu).queryByRole("menuitem", { name: "Stop preview" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Test speaker" }),
    );
    // jsdom has no AudioContext: the bounded status is announced politely.
    expect(
      await screen.findByText(
        "The browser will use the system default speaker.",
      ),
    ).toBeInTheDocument();

    menu = await openMenu();
    fireEvent.click(
      within(menu).getByRole("menuitemradio", { name: "Original sound" }),
    );
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    // Neither the speaker test nor the audio profile opens a device.
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(media.enumerateDevices).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Allow microphone and camera" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Camera" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(media.getUserMedia).toHaveBeenCalledWith({
      audio: {
        autoGainControl: { ideal: false },
        echoCancellation: { ideal: false },
        noiseSuppression: { ideal: false },
      },
      video: {},
    });

    menu = await openMenu();
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Stop preview" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Camera" })).toHaveAttribute(
        "aria-pressed",
        "false",
      ),
    );
    expect(screen.getByRole("button", { name: "Microphone" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("opens the existing terms dialog from the agreement line and restores focus", async () => {
    renderPrejoin(fakeMediaDevices(fakeStream().stream));
    await screen.findByRole("heading", { name: "Enter Meeting" });

    const terms = screen.getByRole("button", { name: "Terms of Service" });
    terms.focus();
    fireEvent.click(terms);
    const dialog = await screen.findByRole("dialog", {
      name: "Terms & Privacy Policy",
    });
    expect(
      within(dialog).getByRole("tab", { name: "User Agreement" }),
    ).toHaveAttribute("aria-selected", "true");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(terms).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Privacy Statement" }));
    const privacy = await screen.findByRole("dialog", {
      name: "Terms & Privacy Policy",
    });
    expect(
      within(privacy).getByRole("tab", { name: "Privacy Policy" }),
    ).toHaveAttribute("aria-selected", "true");
    // Reading the terms is informational: nothing is sent.
    expect(apiMocks.rotateCSRFToken).not.toHaveBeenCalled();
    expect(apiMocks.updateProfile).not.toHaveBeenCalled();
  });

  it("shows org admins the same minimal studio without diagnostics or role badges", async () => {
    const admin: CurrentUser = {
      ...currentUser,
      active_tenant: currentUser.active_tenant
        ? { ...currentUser.active_tenant, role: "org_admin" }
        : null,
    };
    renderPrejoin(fakeMediaDevices(fakeStream().stream), undefined, admin);
    await screen.findByRole("heading", { name: "Enter Meeting" });

    expect(screen.queryByText("Organization admin")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Connection diagnostics (24h)" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
  });

  it("saves a remembered, edited display name once, before the join attempt", async () => {
    const media = fakeMediaDevices(fakeStream().stream);
    const order: string[] = [];
    apiMocks.rotateCSRFToken.mockImplementation(async () => {
      order.push("csrf");
      return { csrf_token: "media-csrf" };
    });
    apiMocks.updateProfile.mockImplementation(
      async (input: { display_name: string }) => {
        order.push("profile");
        return {
          user: { ...currentUser.user, display_name: input.display_name },
        };
      },
    );
    apiMocks.createJoinAttempt
      .mockImplementationOnce(async () => {
        order.push("attempt");
        throw new APIRequestError(500, {
          type: "urn:tutorhub:problem:http-500",
          title: "Unavailable",
          status: 500,
        });
      })
      .mockImplementation(async () => {
        order.push("attempt");
        return {
          admission_request_id: "d48a301d-c468-4f65-8da2-029fc379ee74",
          admission_version: 1,
          join_attempt_id: joinAttemptID,
          participant_session_id: participantSessionID,
          room_instance_id: roomInstanceID,
          status: "waiting",
          version: 1,
        };
      });
    renderPrejoin(media);
    await screen.findByRole("heading", { name: "Enter Meeting" });

    const name = screen.getByRole("textbox", { name: "Your Name" });
    fireEvent.change(name, { target: { value: "  Lan Anh  " } });
    // The frame label follows the field as the viewer types.
    expect(
      document.querySelector(".media-p403-preview__name"),
    ).toHaveTextContent(/^Lan Anh$/);
    clickJoin();

    expect(
      await screen.findByRole("heading", {
        name: "Unable to join the classroom",
      }),
    ).toBeInTheDocument();
    expect(apiMocks.updateProfile).toHaveBeenCalledTimes(1);
    expect(apiMocks.updateProfile).toHaveBeenCalledWith(
      { display_name: "Lan Anh" },
      "media-csrf",
      { signal: expect.any(AbortSignal) },
    );

    // The session now carries the saved name, so a retry sends no second save.
    clickJoin();
    await screen.findByRole("heading", { name: "Waiting to be admitted" });
    expect(order).toEqual(["csrf", "profile", "attempt", "csrf", "attempt"]);
    expect(apiMocks.updateProfile).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("textbox", { name: "Your Name" }),
    ).not.toBeInTheDocument();
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(media.enumerateDevices).not.toHaveBeenCalled();
    expect(document.body).not.toHaveTextContent("student@example.test");
  });

  it("sends no profile request when only surrounding spaces change", async () => {
    const order = trackJoinOrder();
    renderPrejoin(fakeMediaDevices(fakeStream().stream));
    await screen.findByRole("heading", { name: "Enter Meeting" });

    fireEvent.change(screen.getByRole("textbox", { name: "Your Name" }), {
      target: { value: "  Student One " },
    });
    clickJoin();

    await screen.findByRole("heading", { name: "Waiting to be admitted" });
    expect(order).toEqual(["csrf", "attempt"]);
    expect(apiMocks.updateProfile).not.toHaveBeenCalled();
  });

  it("sends no profile request when Remember my name is unchecked", async () => {
    const order = trackJoinOrder();
    renderPrejoin(fakeMediaDevices(fakeStream().stream));
    await screen.findByRole("heading", { name: "Enter Meeting" });

    fireEvent.change(screen.getByRole("textbox", { name: "Your Name" }), {
      target: { value: "Lan Anh" },
    });
    const remember = screen.getByRole("checkbox", {
      name: "Remember my name for future meetings",
    });
    fireEvent.click(remember);
    expect(remember).not.toBeChecked();
    clickJoin();

    await screen.findByRole("heading", { name: "Waiting to be admitted" });
    expect(order).toEqual(["csrf", "attempt"]);
    expect(apiMocks.updateProfile).not.toHaveBeenCalled();
  });

  it("falls back to the account name when the name field is cleared", async () => {
    const order = trackJoinOrder();
    renderPrejoin(fakeMediaDevices(fakeStream().stream));
    await screen.findByRole("heading", { name: "Enter Meeting" });

    const name = screen.getByRole("textbox", { name: "Your Name" });
    fireEvent.change(name, { target: { value: "   " } });
    expect(
      document.querySelector(".media-p403-preview__name"),
    ).toHaveTextContent(/^Student One$/);
    expect(name).not.toHaveAttribute("aria-invalid");
    clickJoin();

    await screen.findByRole("heading", { name: "Waiting to be admitted" });
    expect(order).toEqual(["csrf", "attempt"]);
    expect(apiMocks.updateProfile).not.toHaveBeenCalled();
  });

  it("reports a failed name save without creating a join attempt", async () => {
    apiMocks.updateProfile.mockRejectedValue(
      new APIRequestError(422, {
        type: "urn:tutorhub:problem:http-422",
        title: "Invalid profile",
        status: 422,
      }),
    );
    renderPrejoin(fakeMediaDevices(fakeStream().stream));
    await screen.findByRole("heading", { name: "Enter Meeting" });

    fireEvent.change(screen.getByRole("textbox", { name: "Your Name" }), {
      target: { value: "New Name" },
    });
    clickJoin();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Your new name couldn't be saved. Try again.",
    );
    // The alert sits directly under Join, above the terms line.
    const join = screen.getByRole("button", { name: "Join" });
    expect(join.nextElementSibling).toBe(alert);
    expect(apiMocks.createJoinAttempt).not.toHaveBeenCalled();
    expect(apiMocks.issueJoinCredential).not.toHaveBeenCalled();
    expect(join).not.toHaveAttribute("aria-disabled");
  });

  it("recovers only the exact failed room projection with fresh CSRF", async () => {
    const failedRoomID = "aa66c9ca-bf3f-4919-828a-acde86a43be4";
    const failedSpace: MediaSpace = {
      ...mediaSpace,
      version: 7,
      active_room_instance: null,
      recovery_room_instance: {
        id: failedRoomID,
        status: "failed",
        version: 3,
        created_at: "2030-08-03T00:00:00Z",
        updated_at: "2030-08-03T00:02:00Z",
      },
      viewer_operations: {
        ...mediaSpace.viewer_operations,
        can_recover: true,
      },
    };
    apiMocks.getMediaSpace
      .mockReset()
      .mockResolvedValueOnce(failedSpace)
      .mockResolvedValue(mediaSpace);
    apiMocks.recoverMediaSpace.mockResolvedValue(mediaSpace);
    renderPrejoin(fakeMediaDevices(fakeStream().stream));

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Create recovery instance",
      }),
    );

    await waitFor(() =>
      expect(apiMocks.recoverMediaSpace).toHaveBeenCalledTimes(1),
    );
    expect(apiMocks.rotateCSRFToken).toHaveBeenCalledTimes(1);
    expect(apiMocks.recoverMediaSpace).toHaveBeenCalledWith(
      tenantID,
      spaceID,
      expect.objectContaining({
        expected_space_version: 7,
        expected_room_instance_id: failedRoomID,
        expected_room_instance_version: 3,
      }),
      "media-csrf",
    );
    expect(
      apiMocks.recoverMediaSpace.mock.calls[0]?.[2].idempotency_key,
    ).toMatch(/^media-recover-[0-9a-f-]{36}$/);
    expect(
      await screen.findByRole("heading", { name: "Enter Meeting" }),
    ).toBeInTheDocument();
  });

  it("starts one local preview only after the explicit Allow action", async () => {
    const media = fakeMediaDevices(fakeStream().stream);
    renderPrejoin(media);
    await screen.findByRole("heading", { name: "Enter Meeting" });

    fireEvent.click(
      screen.getByRole("button", { name: "Allow microphone and camera" }),
    );

    await waitFor(() => expect(media.getUserMedia).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(media.enumerateDevices).toHaveBeenCalledTimes(1),
    );
    expect(screen.getByRole("combobox", { name: "Microphone" })).toHaveValue(
      "microphone-1",
    );
    expect(screen.getByRole("combobox", { name: "Camera" })).toHaveValue(
      "camera-1",
    );
    expect(media.getUserMedia).toHaveBeenCalledWith({
      audio: {
        autoGainControl: { ideal: true },
        echoCancellation: { ideal: true },
        noiseSuppression: { ideal: true },
      },
      video: {},
    });
    expect(apiMocks.createJoinAttempt).not.toHaveBeenCalled();
    expect(apiMocks.issueJoinCredential).not.toHaveBeenCalled();
  });

  it("keeps a device-free waiting request outside LiveKit and does not request a credential", async () => {
    const media = fakeMediaDevices(fakeStream().stream);
    apiMocks.createJoinAttempt.mockResolvedValue({
      admission_request_id: "d48a301d-c468-4f65-8da2-029fc379ee74",
      admission_version: 1,
      join_attempt_id: joinAttemptID,
      participant_session_id: participantSessionID,
      room_instance_id: roomInstanceID,
      status: "waiting",
      version: 1,
    });
    renderPrejoin(media);
    await screen.findByRole("heading", { name: "Enter Meeting" });

    clickJoin();

    const waitingHeading = await screen.findByRole("heading", {
      level: 1,
      name: "Waiting to be admitted",
    });
    // The waiting state replaces the form in the right column; focus follows.
    expect(waitingHeading).toHaveFocus();
    const side = waitingHeading.closest(".media-p403-side") as HTMLElement;
    expect(side).not.toBeNull();
    expect(
      within(side).getByRole("button", { name: "Leave waiting room" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Enter Meeting" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Join" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Your Name" }),
    ).not.toBeInTheDocument();
    // A sent request locks the device buttons (they stay focusable).
    expect(screen.getByRole("button", { name: "Camera" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(media.enumerateDevices).not.toHaveBeenCalled();
    expect(apiMocks.createJoinAttempt).toHaveBeenCalledTimes(1);
    expect(apiMocks.issueJoinCredential).not.toHaveBeenCalled();
    expect(liveKitMocks.roomConnect).not.toHaveBeenCalled();
    expect(screen.getByTestId("route-path")).toHaveTextContent(
      `/app/media/spaces/${spaceID}/prejoin`,
    );
  });

  it("renders an immediate terminal provider projection without requesting a credential", async () => {
    const media = fakeMediaDevices(fakeStream().stream);
    apiMocks.createJoinAttempt.mockResolvedValue({
      join_attempt_id: joinAttemptID,
      participant_session_id: participantSessionID,
      room_instance_id: roomInstanceID,
      status: "provider_unavailable",
      version: 1,
    });
    renderPrejoin(media);
    await screen.findByRole("heading", { name: "Enter Meeting" });

    clickJoin();

    const terminalHeading = await screen.findByRole("heading", {
      name: "The media service is unavailable",
    });
    expect(terminalHeading).toHaveFocus();
    expect(apiMocks.issueJoinCredential).not.toHaveBeenCalled();
    expect(liveKitMocks.roomConnect).not.toHaveBeenCalled();
  });

  it.each([
    {
      status: "timeout" as const,
      heading: "Your join request expired",
      canCreateNewRequest: true,
    },
    {
      status: "meeting_ended" as const,
      heading: "The classroom session ended",
      canCreateNewRequest: false,
    },
  ])(
    "renders the $status terminal projection with the bounded recovery action",
    async ({ status, heading, canCreateNewRequest }) => {
      const media = fakeMediaDevices(fakeStream().stream);
      apiMocks.createJoinAttempt.mockResolvedValue({
        join_attempt_id: joinAttemptID,
        participant_session_id: participantSessionID,
        room_instance_id: roomInstanceID,
        status,
        version: 1,
      });
      renderPrejoin(media);
      await screen.findByRole("heading", { name: "Enter Meeting" });

      clickJoin();

      const terminalHeading = await screen.findByRole("heading", {
        name: heading,
      });
      expect(terminalHeading).toHaveFocus();
      const newRequest = screen.queryByRole("button", {
        name: "Create a new join request",
      });
      if (canCreateNewRequest) {
        expect(newRequest).toBeVisible();
        fireEvent.click(newRequest!);
        expect(screen.getByRole("button", { name: "Join" })).toBeEnabled();
      } else {
        expect(newRequest).not.toBeInTheDocument();
      }
      expect(apiMocks.issueJoinCredential).not.toHaveBeenCalled();
      expect(liveKitMocks.roomConnect).not.toHaveBeenCalled();
    },
  );

  it("retains the original device choices while admission polling completes", async () => {
    const token = "admitted-after-wait-token";
    const media = fakeMediaDevices(fakeStream().stream);
    const waitingAttempt = {
      admission_request_id: "d48a301d-c468-4f65-8da2-029fc379ee74",
      admission_version: 1,
      join_attempt_id: joinAttemptID,
      participant_session_id: participantSessionID,
      room_instance_id: roomInstanceID,
      status: "waiting" as const,
      version: 1,
      expires_at: "2030-08-03T00:07:00Z",
    };
    apiMocks.createJoinAttempt.mockResolvedValue(waitingAttempt);
    apiMocks.getJoinAttempt
      .mockResolvedValueOnce(waitingAttempt)
      .mockResolvedValue({ ...waitingAttempt, status: "admitted", version: 2 });
    apiMocks.issueJoinCredential.mockResolvedValue({
      access_token: token,
      server_url: "wss://media.example.test",
      participant_session_id: participantSessionID,
      room_instance_id: roomInstanceID,
      join_attempt_id: joinAttemptID,
      instance_role: "attendee",
      can_publish_camera_microphone: true,
      can_share_screen: false,
      can_subscribe: true,
      expires_at: "2030-08-03T00:05:00Z",
    });
    renderPrejoin(media);
    await screen.findByRole("heading", { name: "Enter Meeting" });
    fireEvent.click(
      screen.getByRole("button", { name: "Allow microphone and camera" }),
    );
    await waitFor(() => expect(media.getUserMedia).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    await screen.findByRole("heading", { name: "Waiting to be admitted" });
    expect(screen.getByText(/waiting request expires at/i)).toBeVisible();
    await waitFor(() =>
      expect(apiMocks.getJoinAttempt).toHaveBeenCalledTimes(1),
    );
    const refresh = screen.getByRole("button", {
      name: "Check admission status",
    });
    await waitFor(() => expect(refresh).toBeEnabled());
    fireEvent.click(refresh);

    await screen.findByText("Canonical room destination");
    const handoff = takeMediaRoomEscrow({
      tenantId: tenantID,
      userId: userID,
      spaceId: spaceID,
      roomInstanceId: roomInstanceID,
    });
    expect(handoff).toMatchObject({
      choices: {
        audioEnabled: true,
        videoEnabled: true,
        audioDeviceId: "microphone-1",
        videoDeviceId: "camera-1",
      },
      credential: { access_token: token },
    });
  });

  it("keeps the admitted credential request alive while rendering its progress state", async () => {
    const token = "delayed-admission-token";
    const media = fakeMediaDevices(fakeStream().stream);
    const waitingAttempt = {
      admission_request_id: "d48a301d-c468-4f65-8da2-029fc379ee74",
      admission_version: 1,
      join_attempt_id: joinAttemptID,
      participant_session_id: participantSessionID,
      room_instance_id: roomInstanceID,
      status: "waiting" as const,
      version: 1,
      expires_at: "2030-08-03T00:07:00Z",
    };
    let resolveCredential!: (
      credential: MediaInstanceCredentialProjection,
    ) => void;
    const credentialPromise = new Promise<MediaInstanceCredentialProjection>(
      (resolve) => {
        resolveCredential = resolve;
      },
    );
    let credentialSignal: AbortSignal | undefined;
    apiMocks.createJoinAttempt.mockResolvedValue(waitingAttempt);
    apiMocks.getJoinAttempt
      .mockResolvedValueOnce(waitingAttempt)
      .mockResolvedValue({ ...waitingAttempt, status: "admitted", version: 2 });
    apiMocks.issueJoinCredential.mockImplementation((...args: unknown[]) => {
      credentialSignal = (args[4] as { signal?: AbortSignal } | undefined)
        ?.signal;
      return credentialPromise;
    });
    renderPrejoin(media);
    await screen.findByRole("heading", { name: "Enter Meeting" });

    clickJoin();
    await screen.findByRole("heading", { name: "Waiting to be admitted" });
    await waitFor(() =>
      expect(apiMocks.getJoinAttempt).toHaveBeenCalledTimes(1),
    );
    const refresh = screen.getByRole("button", {
      name: "Check admission status",
    });
    await waitFor(() => expect(refresh).toBeEnabled());
    fireEvent.click(refresh);

    await waitFor(() =>
      expect(apiMocks.issueJoinCredential).toHaveBeenCalledOnce(),
    );
    await act(async () => Promise.resolve());
    expect(credentialSignal?.aborted).toBe(false);

    await act(async () => {
      resolveCredential({
        access_token: token,
        server_url: "wss://media.example.test",
        participant_session_id: participantSessionID,
        room_instance_id: roomInstanceID,
        join_attempt_id: joinAttemptID,
        instance_role: "attendee",
        can_publish_camera_microphone: true,
        can_share_screen: false,
        can_subscribe: true,
        expires_at: "2030-08-03T00:05:00Z",
      });
      await credentialPromise;
    });
    expect(await screen.findByText("Canonical room destination")).toBeVisible();
  });

  it("cancels a waiting request without minting a credential", async () => {
    const media = fakeMediaDevices(fakeStream().stream);
    const waitingAttempt = {
      admission_request_id: "d48a301d-c468-4f65-8da2-029fc379ee74",
      admission_version: 1,
      join_attempt_id: joinAttemptID,
      participant_session_id: participantSessionID,
      room_instance_id: roomInstanceID,
      status: "waiting" as const,
      version: 1,
    };
    apiMocks.createJoinAttempt.mockResolvedValue(waitingAttempt);
    apiMocks.cancelJoinAttempt.mockResolvedValue({
      ...waitingAttempt,
      status: "cancelled",
      version: 2,
    });
    renderPrejoin(media);
    await screen.findByRole("heading", { name: "Enter Meeting" });
    clickJoin();
    await screen.findByRole("heading", { name: "Waiting to be admitted" });
    fireEvent.click(screen.getByRole("button", { name: "Leave waiting room" }));

    const cancelledHeading = await screen.findByRole("heading", {
      name: "You left the waiting room",
    });
    expect(cancelledHeading).toBeVisible();
    expect(cancelledHeading).toHaveFocus();
    expect(cancelledHeading.closest(".media-p403-side")).not.toBeNull();
    expect(apiMocks.cancelJoinAttempt).toHaveBeenCalledWith(
      tenantID,
      spaceID,
      joinAttemptID,
      expect.objectContaining({
        expected_space_version: 4,
        expected_room_instance_id: roomInstanceID,
        expected_room_instance_version: 2,
        expected_admission_version: 1,
      }),
      "media-csrf",
    );
    expect(apiMocks.issueJoinCredential).not.toHaveBeenCalled();
    expect(liveKitMocks.roomConnect).not.toHaveBeenCalled();
  });

  it("requests an admitted attempt before the credential and hands the token off outside history state", async () => {
    const token = "memory-only-livekit-token";
    const order: string[] = [];
    const media = fakeMediaDevices(fakeStream().stream);
    apiMocks.rotateCSRFToken.mockImplementation(async () => {
      order.push("csrf");
      return { csrf_token: "media-csrf" };
    });
    apiMocks.createJoinAttempt.mockImplementation(async () => {
      order.push("attempt");
      return {
        admission_request_id: null,
        join_attempt_id: joinAttemptID,
        participant_session_id: participantSessionID,
        room_instance_id: roomInstanceID,
        status: "admitted",
        version: 1,
      };
    });
    apiMocks.issueJoinCredential.mockImplementation(async () => {
      order.push("credential");
      return {
        access_token: token,
        server_url: "wss://media.example.test",
        participant_session_id: participantSessionID,
        room_instance_id: roomInstanceID,
        join_attempt_id: joinAttemptID,
        instance_role: "attendee",
        can_publish_camera_microphone: true,
        can_share_screen: false,
        can_subscribe: true,
        expires_at: "2030-08-03T00:05:00Z",
      };
    });
    renderPrejoin(media);
    await screen.findByRole("heading", { name: "Enter Meeting" });

    clickJoin();

    expect(
      await screen.findByText("Canonical room destination"),
    ).toBeInTheDocument();
    expect(order).toEqual(["csrf", "attempt", "credential"]);
    expect(apiMocks.recordDiagnostic).toHaveBeenCalledTimes(2);
    expect(apiMocks.createJoinAttempt).toHaveBeenCalledWith(
      tenantID,
      spaceID,
      expect.objectContaining({
        expected_room_instance_id: roomInstanceID,
        expected_space_version: mediaSpace.version,
      }),
      "media-csrf",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(apiMocks.issueJoinCredential).toHaveBeenCalledWith(
      tenantID,
      spaceID,
      { join_attempt_id: joinAttemptID },
      "media-csrf",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByTestId("route-state")).toHaveTextContent("null");
    expect(screen.getByTestId("route-path")).toHaveTextContent(
      `/app/media/spaces/${spaceID}/instances/${roomInstanceID}/room`,
    );
    expect(window.location.href).not.toContain(token);
    expect(JSON.stringify(window.history.state ?? null)).not.toContain(token);
    expect(window.localStorage).toHaveLength(0);
    expect(window.sessionStorage).toHaveLength(0);
    expect(liveKitMocks.roomConnect).not.toHaveBeenCalled();

    const handoff = takeMediaRoomEscrow({
      tenantId: tenantID,
      userId: userID,
      spaceId: spaceID,
      roomInstanceId: roomInstanceID,
    });
    expect(handoff).toMatchObject({
      choices: { audioEnabled: false, videoEnabled: false },
      credential: { access_token: token },
    });
    finalizeMediaRoomEscrowClaim({
      tenantId: tenantID,
      userId: userID,
      spaceId: spaceID,
      roomInstanceId: roomInstanceID,
    });
    expect(
      takeMediaRoomEscrow({
        tenantId: tenantID,
        userId: userID,
        spaceId: spaceID,
        roomInstanceId: roomInstanceID,
      }),
    ).toBeNull();
  });

  it.each([
    { state: undefined, href: "/app/home", label: "← Back to Home" },
    {
      state: { returnTo: "/app/classrooms/abc", classTitle: "Security" },
      href: "/app/classrooms/abc",
      label: "← Back to class",
    },
    {
      state: { returnTo: "https://evil.example/app/" },
      href: "/app/home",
      label: "← Back to Home",
    },
    {
      state: { returnTo: "//evil.example/app/" },
      href: "/app/home",
      label: "← Back to Home",
    },
  ])(
    "links back to the launching class only for in-app return paths ($href)",
    async ({ state, href, label }) => {
      renderPrejoin(fakeMediaDevices(fakeStream().stream), state);
      await screen.findByRole("heading", { level: 1 });
      expect(screen.getByRole("link", { name: label })).toHaveAttribute(
        "href",
        href,
      );
    },
  );

  it("recovers once from a stale 409 by re-reading the space and using a new attempt id", async () => {
    const media = fakeMediaDevices(fakeStream().stream);
    const refreshedSpace = { ...mediaSpace, version: mediaSpace.version + 1 };
    apiMocks.getMediaSpace
      .mockResolvedValueOnce(mediaSpace)
      .mockResolvedValue(refreshedSpace);
    apiMocks.createJoinAttempt
      .mockRejectedValueOnce(
        new APIRequestError(409, {
          type: "urn:tutorhub:problem:http-409",
          title: "Media space changed",
          status: 409,
        }),
      )
      .mockResolvedValueOnce({
        admission_request_id: null,
        join_attempt_id: joinAttemptID,
        participant_session_id: participantSessionID,
        room_instance_id: roomInstanceID,
        status: "admitted",
        version: 1,
      });
    apiMocks.issueJoinCredential.mockResolvedValue({
      access_token: "retry-memory-token",
      server_url: "wss://media.example.test",
      participant_session_id: participantSessionID,
      room_instance_id: roomInstanceID,
      join_attempt_id: joinAttemptID,
      instance_role: "attendee",
      can_publish_camera_microphone: true,
      can_share_screen: false,
      can_subscribe: true,
      expires_at: "2030-08-03T00:05:00Z",
    });
    renderPrejoin(media);
    await screen.findByRole("heading", { name: "Enter Meeting" });

    clickJoin();

    expect(
      await screen.findByText("Canonical room destination"),
    ).toBeInTheDocument();
    expect(apiMocks.createJoinAttempt).toHaveBeenCalledTimes(2);
    const [firstCall, retryCall] = apiMocks.createJoinAttempt.mock.calls;
    expect(firstCall?.[2]).toMatchObject({
      expected_space_version: mediaSpace.version,
    });
    expect(retryCall?.[2]).toMatchObject({
      expected_room_instance_id: roomInstanceID,
      expected_space_version: refreshedSpace.version,
    });
    expect(retryCall?.[2].join_attempt_id).not.toBe(
      firstCall?.[2].join_attempt_id,
    );
    expect(apiMocks.getMediaSpace).toHaveBeenCalledTimes(2);
  });

  it("stops after a single 409 retry and shows the error under Join", async () => {
    const media = fakeMediaDevices(fakeStream().stream);
    apiMocks.createJoinAttempt.mockRejectedValue(
      new APIRequestError(409, {
        type: "urn:tutorhub:problem:http-409",
        title: "Media space changed",
        status: 409,
      }),
    );
    renderPrejoin(media);
    await screen.findByRole("heading", { name: "Enter Meeting" });

    clickJoin();

    const errorHeading = await screen.findByRole("heading", {
      name: "Unable to join the classroom",
    });
    // The compact alert sits in the form column, directly under Join.
    expect(errorHeading.closest("[role='alert']")).not.toBeNull();
    expect(errorHeading.closest(".media-p403-side")).not.toBeNull();
    expect(apiMocks.createJoinAttempt).toHaveBeenCalledTimes(2);
    expect(apiMocks.issueJoinCredential).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Join" })).toBeEnabled();
  });

  it.each([
    {
      code: "participant_session_conflict",
      message:
        "This account already has this classroom open in another tab or device. Close the other session or wait a few seconds and try again.",
    },
    {
      code: "room_locked",
      message: "The room is locked and is not accepting new join attempts.",
    },
  ])(
    "maps the Core API problem.code $code to its specific join error",
    async ({ code, message }) => {
      const media = fakeMediaDevices(fakeStream().stream);
      apiMocks.createJoinAttempt.mockRejectedValue(
        new APIRequestError(409, {
          type: "urn:tutorhub:problem:http-409",
          code,
          title: "Join attempt rejected",
          status: 409,
        }),
      );
      renderPrejoin(media);
      await screen.findByRole("heading", { name: "Enter Meeting" });

      clickJoin();

      const alert = await screen.findByRole("alert");
      expect(alert.closest(".media-p403-side")).not.toBeNull();
      expect(alert).toHaveTextContent(message);
      expect(alert).not.toHaveTextContent(
        "A room credential could not be issued",
      );
      // One stale-version retry with a fresh attempt id, then the mapped error.
      expect(apiMocks.createJoinAttempt).toHaveBeenCalledTimes(2);
      expect(apiMocks.issueJoinCredential).not.toHaveBeenCalled();
    },
  );

  it.each([
    { serverURL: "ws://127.0.0.1:7880", accepted: true },
    { serverURL: "ws://media.example.test", accepted: false },
    { serverURL: "wss://media.example.test/rtc", accepted: false },
  ])(
    "applies the loopback-only ws:// policy to $serverURL on a localhost page",
    async ({ serverURL, accepted }) => {
      const media = fakeMediaDevices(fakeStream().stream);
      apiMocks.createJoinAttempt.mockResolvedValue({
        admission_request_id: null,
        join_attempt_id: joinAttemptID,
        participant_session_id: participantSessionID,
        room_instance_id: roomInstanceID,
        status: "admitted",
        version: 1,
      });
      apiMocks.issueJoinCredential.mockResolvedValue({
        access_token: "loopback-memory-token",
        server_url: serverURL,
        participant_session_id: participantSessionID,
        room_instance_id: roomInstanceID,
        join_attempt_id: joinAttemptID,
        instance_role: "attendee",
        can_publish_camera_microphone: true,
        can_share_screen: false,
        can_subscribe: true,
        expires_at: "2030-08-03T00:05:00Z",
      });
      renderPrejoin(media);
      await screen.findByRole("heading", { name: "Enter Meeting" });

      clickJoin();

      if (accepted) {
        expect(
          await screen.findByText("Canonical room destination"),
        ).toBeInTheDocument();
        return;
      }
      expect(
        await screen.findByRole("heading", {
          name: "Unable to join the classroom",
        }),
      ).toBeInTheDocument();
      expect(screen.queryByText("Canonical room destination")).toBeNull();
      expect(
        takeMediaRoomEscrow({
          tenantId: tenantID,
          userId: userID,
          spaceId: spaceID,
          roomInstanceId: roomInstanceID,
        }),
      ).toBeNull();
    },
  );

  it("survives StrictMode handoff and applies the original-sound profile to LiveKit", async () => {
    const token = "strict-mode-memory-token";
    putCanonicalRoomEscrow({
      audioEnabled: true,
      videoEnabled: false,
      audioDeviceId: "microphone-1",
      videoDeviceId: "",
      speakerDeviceId: "speaker-1",
      audioMode: "original_sound",
    });

    const view = renderCanonicalRoom();

    expect(
      await screen.findByRole("heading", { name: "TutorHub classroom" }),
    ).toBeInTheDocument();
    expect(liveKitMocks.roomConnect).toHaveBeenCalledTimes(1);
    expect(liveKitMocks.roomConstruct).toHaveBeenCalledTimes(1);
    expect(liveKitMocks.roomConnect).toHaveBeenCalledWith(
      "wss://media.example.test",
      token,
      { autoSubscribe: false },
    );
    act(() => emitRoomEvent("signalConnected"));
    await waitFor(() =>
      expect(liveKitMocks.setMicrophoneEnabled).toHaveBeenCalledWith(true, {
        deviceId: "microphone-1",
        echoCancellation: { ideal: false },
        noiseSuppression: { ideal: false },
        autoGainControl: { ideal: false },
      }),
    );
    expect(liveKitMocks.setCameraEnabled).toHaveBeenCalledWith(
      false,
      undefined,
    );
    act(() => emitRoomEvent("signalConnected"));
    expect(liveKitMocks.setMicrophoneEnabled).toHaveBeenCalledTimes(1);
    expect(liveKitMocks.setCameraEnabled).toHaveBeenCalledTimes(1);
    expect(liveKitMocks.setScreenShareEnabled).not.toHaveBeenCalled();
    expect(screen.getByRole("main")).toHaveClass("media-p403-room");
    expect(
      screen.getByRole("button", { name: "Enable classroom audio" }),
    ).toBeInTheDocument();
    expect(liveKitMocks.startAudioRender).toHaveBeenCalled();
    await act(async () => Promise.resolve());
    expect(liveKitMocks.roomDisconnect).not.toHaveBeenCalled();
    expect(liveKitMocks.setRoomLogLevel).toHaveBeenCalledWith(5);
    expect(liveKitMocks.setComponentsLogLevel).toHaveBeenCalledWith(5, {
      liveKitClientLogLevel: 5,
    });
    expect(liveKitMocks.listeners.get("connected")?.size).toBe(1);
    expect(liveKitMocks.listeners.get("disconnected")?.size).toBe(1);
    act(() => emitRoomEvent("connected"));
    expect(liveKitMocks.switchActiveDevice).toHaveBeenCalledWith(
      "audiooutput",
      "speaker-1",
    );
    expect(
      takeMediaRoomEscrow({
        tenantId: tenantID,
        userId: userID,
        spaceId: spaceID,
        roomInstanceId: roomInstanceID,
      }),
    ).toBeNull();
    view.unmount();
    await act(async () => Promise.resolve());
    expect(liveKitMocks.roomDisconnect).toHaveBeenCalledTimes(1);
    expect(liveKitMocks.roomDisconnect).toHaveBeenCalledWith(true);
  });

  it("hard-stops initial capture that resolves after terminal leave", async () => {
    const microphone = createDeferred<void>();
    const camera = createDeferred<void>();
    liveKitMocks.setMicrophoneEnabled.mockReturnValueOnce(microphone.promise);
    liveKitMocks.setCameraEnabled.mockReturnValueOnce(camera.promise);
    putCanonicalRoomEscrow({
      audioEnabled: true,
      videoEnabled: true,
      audioDeviceId: "microphone-1",
      videoDeviceId: "camera-1",
      speakerDeviceId: "",
      audioMode: "speech",
    });

    renderCanonicalRoom();
    await screen.findByRole("heading", { name: "TutorHub classroom" });
    act(() => emitRoomEvent("signalConnected"));
    fireEvent.click(screen.getByRole("button", { name: "Mock leave room" }));
    await waitFor(() =>
      expect(liveKitMocks.roomDisconnect).toHaveBeenCalledWith(true),
    );
    const microphoneTrack = createMockLocalTrack();
    const cameraTrack = createMockLocalTrack();
    liveKitMocks.trackPublications.set("microphone", {
      track: microphoneTrack,
    });
    liveKitMocks.trackPublications.set("camera", { track: cameraTrack });

    await act(async () => {
      microphone.resolve();
      await microphone.promise;
    });
    await waitFor(() =>
      expect(liveKitMocks.unpublishTrack).toHaveBeenCalledTimes(2),
    );
    await act(async () => {
      camera.resolve();
      await camera.promise;
    });

    expect(liveKitMocks.unpublishTrack).toHaveBeenCalledWith(
      microphoneTrack,
      true,
    );
    expect(liveKitMocks.unpublishTrack).toHaveBeenCalledWith(cameraTrack, true);
    expect(microphoneTrack.detach).toHaveBeenCalledTimes(1);
    expect(microphoneTrack.stop).toHaveBeenCalledTimes(1);
    expect(cameraTrack.detach).toHaveBeenCalledTimes(1);
    expect(cameraTrack.stop).toHaveBeenCalledTimes(1);
  });

  it("hard-stops initial capture that resolves after room unmount", async () => {
    const camera = createDeferred<void>();
    liveKitMocks.setCameraEnabled.mockReturnValueOnce(camera.promise);
    putCanonicalRoomEscrow({
      audioEnabled: false,
      videoEnabled: true,
      audioDeviceId: "",
      videoDeviceId: "camera-1",
      speakerDeviceId: "",
      audioMode: "speech",
    });

    const view = renderCanonicalRoom();
    await screen.findByRole("heading", { name: "TutorHub classroom" });
    act(() => emitRoomEvent("signalConnected"));
    view.unmount();
    const cameraTrack = createMockLocalTrack();
    liveKitMocks.trackPublications.set("late-camera", { track: cameraTrack });
    await act(async () => {
      camera.resolve();
      await camera.promise;
    });
    await waitFor(() =>
      expect(liveKitMocks.unpublishTrack).toHaveBeenCalledWith(
        cameraTrack,
        true,
      ),
    );
    expect(cameraTrack.detach).toHaveBeenCalledTimes(1);
    expect(cameraTrack.stop).toHaveBeenCalledTimes(1);
  });

  it("clamps prejoin capture choices to the exact camera and microphone grant", async () => {
    putCanonicalRoomEscrow(
      {
        audioEnabled: true,
        videoEnabled: true,
        audioDeviceId: "microphone-1",
        videoDeviceId: "camera-1",
        speakerDeviceId: "speaker-1",
        audioMode: "speech",
      },
      { can_publish_camera_microphone: false },
    );

    renderCanonicalRoom();
    await screen.findByRole("heading", { name: "TutorHub classroom" });
    act(() => emitRoomEvent("signalConnected"));
    await waitFor(() =>
      expect(liveKitMocks.setMicrophoneEnabled).toHaveBeenCalledWith(
        false,
        undefined,
      ),
    );
    expect(liveKitMocks.setCameraEnabled).toHaveBeenCalledWith(
      false,
      undefined,
    );
    expect(liveKitMocks.setScreenShareEnabled).not.toHaveBeenCalled();
  });

  it("terminates a provider connection failure without logging raw errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    liveKitMocks.roomConnect.mockRejectedValueOnce(
      new Error("provider-identity secret-room-sid"),
    );
    putCanonicalRoomEscrow();
    renderCanonicalRoom();
    await screen.findByRole("heading", { name: "TutorHub classroom" });
    const shellProps = liveKitMocks.shellRender.mock.lastCall?.[0] as
      { controlAbortSignal?: AbortSignal } | undefined;

    expect(
      await screen.findByRole("heading", {
        name: "Return to the prejoin check",
      }),
    ).toBeInTheDocument();
    expect(shellProps?.controlAbortSignal?.aborted).toBe(true);
    expect(screen.getByTestId("route-path")).toHaveTextContent(
      `/app/media/spaces/${spaceID}/instances/${roomInstanceID}/room`,
    );
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps a double leave ahead of a racing provider error", async () => {
    liveKitMocks.setMicrophoneEnabled.mockRejectedValueOnce(
      new Error("late provider failure"),
    );
    putCanonicalRoomEscrow();
    renderCanonicalRoom();
    await screen.findByRole("heading", { name: "TutorHub classroom" });
    const leave = screen.getByRole("button", { name: "Mock leave room" });

    act(() => {
      emitRoomEvent("signalConnected");
      fireEvent.click(leave);
      fireEvent.click(leave);
    });

    await waitFor(() =>
      expect(screen.getByTestId("route-path")).toHaveTextContent(
        `/app/media/spaces/${spaceID}/prejoin`,
      ),
    );
  });

  it("suppresses a late leave callback after the room scope unmounts", async () => {
    let resolveDisconnect: (() => void) | undefined;
    liveKitMocks.roomDisconnect.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveDisconnect = resolve;
      }),
    );
    putCanonicalRoomEscrow();
    renderCanonicalRoom();
    await screen.findByRole("heading", { name: "TutorHub classroom" });

    fireEvent.click(screen.getByRole("button", { name: "Mock leave room" }));
    expect(liveKitMocks.roomDisconnect).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Open other room scope" }),
    );

    await screen.findByRole("heading", {
      name: "Return to the prejoin check",
    });
    expect(screen.getByTestId("route-path")).toHaveTextContent(
      `/app/media/spaces/${otherSpaceID}/instances/${roomInstanceID}/room`,
    );
    await act(async () => {
      resolveDisconnect?.();
      await Promise.resolve();
    });
    expect(screen.getByTestId("route-path")).toHaveTextContent(
      `/app/media/spaces/${otherSpaceID}/instances/${roomInstanceID}/room`,
    );
    expect(liveKitMocks.roomDisconnect).toHaveBeenCalledTimes(1);
  });

  it("ignores a connected event that arrives after terminal leave starts", async () => {
    putCanonicalRoomEscrow();
    renderCanonicalRoom();
    await screen.findByRole("heading", { name: "TutorHub classroom" });

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Mock leave room" }));
      emitRoomEvent("connected");
    });

    expect(liveKitMocks.switchActiveDevice).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("route-path")).toHaveTextContent(
        `/app/media/spaces/${spaceID}/prejoin`,
      ),
    );
  });

  it("terminates the room handoff after disconnect without reconnecting", async () => {
    putCanonicalRoomEscrow();
    renderCanonicalRoom();

    await screen.findByRole("heading", { name: "TutorHub classroom" });
    const before = liveKitMocks.roomConnect.mock.calls.length;
    const shellProps = liveKitMocks.shellRender.mock.lastCall?.[0] as
      { controlAbortSignal?: AbortSignal } | undefined;
    expect(liveKitMocks.listeners.get("disconnected")?.size).toBe(1);
    expect(shellProps?.controlAbortSignal?.aborted).toBe(false);

    act(() => emitRoomEvent("disconnected", 4));
    expect(shellProps?.controlAbortSignal?.aborted).toBe(true);

    expect(
      await screen.findByRole("heading", {
        name: "Return to the prejoin check",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveClass("media-p403-room-recovery");
    expect(liveKitMocks.roomConnect.mock.calls.length).toBe(before);
    await act(async () => Promise.resolve());
    expect(liveKitMocks.roomDisconnect).not.toHaveBeenCalled();
    expect(
      takeMediaRoomEscrow({
        tenantId: tenantID,
        userId: userID,
        spaceId: spaceID,
        roomInstanceId: roomInstanceID,
      }),
    ).toBeNull();
  });

  it("purges the in-memory credential across an A to B to A route scope change", async () => {
    putCanonicalRoomEscrow();
    renderCanonicalRoom();

    await screen.findByRole("heading", { name: "TutorHub classroom" });
    const initialRoomConnections = liveKitMocks.roomConnect.mock.calls.length;
    fireEvent.click(
      screen.getByRole("button", { name: "Open other room scope" }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "Return to the prejoin check",
      }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Return to original room scope" }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "Return to the prejoin check",
      }),
    ).toBeInTheDocument();
    expect(liveKitMocks.roomConnect.mock.calls.length).toBe(
      initialRoomConnections,
    );
    expect(liveKitMocks.roomDisconnect).toHaveBeenCalledTimes(1);
    expect(
      takeMediaRoomEscrow({
        tenantId: tenantID,
        userId: userID,
        spaceId: spaceID,
        roomInstanceId: roomInstanceID,
      }),
    ).toBeNull();
  });
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createMockLocalTrack(): MockLocalTrack {
  return { detach: vi.fn(), stop: vi.fn() };
}

describe("MediaSpacePreJoinPage ADR-0041 effects studio", () => {
  beforeEach(() => {
    clearMediaRoomEscrow();
    localStorage.clear();
    effectsRuntime.started.length = 0;
    vi.mocked(effectsRuntime.runtime.startStandaloneVisualEffects).mockClear();
    apiMocks.getMediaSpace.mockResolvedValue(mediaSpace);
    apiMocks.getTenantCapabilities.mockResolvedValue(
      tenantCapabilitiesWithWhiteboard(false),
    );
    apiMocks.rotateCSRFToken.mockResolvedValue({ csrf_token: "media-csrf" });
    apiMocks.getCurrentCSRF.mockReturnValue("media-csrf");
    apiMocks.recordDiagnostic.mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
      () => undefined,
    );
  });

  afterEach(async () => {
    cleanup();
    await Promise.resolve();
    clearMediaRoomEscrow();
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    apiMocks.createJoinAttempt.mockReset();
    apiMocks.issueJoinCredential.mockReset();
    apiMocks.getMediaSpace.mockReset();
  });

  it("opens a two-column studio and records a choice without opening the camera", async () => {
    const media = fakeMediaDevices(fakeStream().stream);
    renderPrejoin(media);
    await screen.findByRole("heading", { name: "Enter Meeting" });
    const trigger = screen.getByRole("button", {
      name: "Backgrounds and effects",
    });
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(trigger);

    const studio = await screen.findByRole("dialog", {
      name: "Backgrounds and effects",
    });
    expect(
      within(studio).getByText(
        "Your camera is off. You can still pick an effect; the camera only turns on when you ask.",
      ),
    ).toBeInTheDocument();
    expect(
      within(studio).getByRole("button", { name: "Turn on camera to preview" }),
    ).toBeInTheDocument();
    expect(
      within(studio).getByLabelText("Effects preview"),
    ).toBeInTheDocument();
    expect(
      within(studio).getByRole("tab", { name: "Backgrounds" }),
    ).toHaveAttribute("aria-selected", "true");

    fireEvent.click(within(studio).getByRole("button", { name: "Library" }));
    expect(
      within(studio).getByRole("button", { name: "Library" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(studio).getByRole("button", { name: "Turn off all effects" }),
    ).toBeInTheDocument();
    // A choice alone never opens hardware.
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(media.enumerateDevices).not.toHaveBeenCalled();
    expect(
      effectsRuntime.runtime.startStandaloneVisualEffects,
    ).not.toHaveBeenCalled();

    fireEvent.keyDown(studio, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveClass("media-p403-round--effects-on");
    expect(trigger).toHaveAccessibleDescription("On: Library");
    // Remembered per (tenant, user) for the next class.
    expect(JSON.stringify(Object.entries(localStorage))).toContain(
      "academic-library",
    );
  });

  it("starts the camera only from the explicit preview button and previews the effect", async () => {
    const capture = fakeStream();
    const media = fakeMediaDevices(capture.stream);
    renderPrejoin(media);
    await screen.findByRole("heading", { name: "Enter Meeting" });
    fireEvent.click(
      screen.getByRole("button", { name: "Backgrounds and effects" }),
    );
    const studio = await screen.findByRole("dialog", {
      name: "Backgrounds and effects",
    });
    fireEvent.click(
      within(studio).getByRole("button", { name: "Slight blur" }),
    );
    expect(media.getUserMedia).not.toHaveBeenCalled();

    fireEvent.click(
      within(studio).getByRole("button", { name: "Turn on camera to preview" }),
    );
    await waitFor(() => expect(media.getUserMedia).toHaveBeenCalledTimes(1));
    expect(media.getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: {},
    });
    await waitFor(() =>
      expect(
        effectsRuntime.runtime.startStandaloneVisualEffects,
      ).toHaveBeenCalledWith(
        capture.video,
        {
          mode: "background",
          background: { kind: "blur", blurRadius: 8 },
          lighting: { brightness: "normal", tone: "natural" },
        },
        expect.objectContaining({ onOverload: expect.any(Function) }),
      ),
    );
    await waitFor(() =>
      expect(
        within(studio).queryByRole("button", {
          name: "Turn on camera to preview",
        }),
      ).toBeNull(),
    );
    const preview = within(studio).getByLabelText(
      "Effects preview",
    ) as HTMLVideoElement & { srcObject: unknown };
    await waitFor(() =>
      expect(preview.srcObject).toBe(effectsRuntime.started[0]?.stream),
    );

    fireEvent.click(
      within(studio).getByRole("button", { name: "Turn off all effects" }),
    );
    await waitFor(() =>
      expect(effectsRuntime.started[0]?.destroy).toHaveBeenCalled(),
    );
    expect(
      within(studio).getByRole("button", { name: "None" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("hands the latest effects choice to the classroom without opening the camera", async () => {
    const media = fakeMediaDevices(fakeStream().stream);
    apiMocks.createJoinAttempt.mockResolvedValue({
      admission_request_id: null,
      join_attempt_id: joinAttemptID,
      participant_session_id: participantSessionID,
      room_instance_id: roomInstanceID,
      status: "admitted",
      version: 1,
    });
    apiMocks.issueJoinCredential.mockResolvedValue({
      access_token: "effects-token",
      server_url: "wss://media.example.test",
      participant_session_id: participantSessionID,
      room_instance_id: roomInstanceID,
      join_attempt_id: joinAttemptID,
      instance_role: "attendee",
      can_publish_camera_microphone: true,
      can_share_screen: false,
      can_subscribe: true,
      expires_at: "2030-08-03T00:05:00Z",
    });
    renderPrejoin(media);
    await screen.findByRole("heading", { name: "Enter Meeting" });
    fireEvent.click(
      screen.getByRole("button", { name: "Backgrounds and effects" }),
    );
    const studio = await screen.findByRole("dialog", {
      name: "Backgrounds and effects",
    });
    fireEvent.click(
      within(studio).getByRole("button", { name: "Lecture hall" }),
    );
    fireEvent.mouseDown(within(studio).getByRole("tab", { name: "Lighting" }), {
      button: 0,
    });
    fireEvent.click(
      within(studio).getByRole("radio", { name: "Low-light boost" }),
    );
    fireEvent.keyDown(studio, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    await screen.findByText("Canonical room destination");
    expect(
      takeMediaRoomEscrow({
        tenantId: tenantID,
        userId: userID,
        spaceId: spaceID,
        roomInstanceId: roomInstanceID,
      })?.choices.visualEffects,
    ).toEqual({
      background: { kind: "preset", presetId: "lecture-studio" },
      lighting: { brightness: "low_light", tone: "natural" },
    });
    expect(media.getUserMedia).not.toHaveBeenCalled();
  });
});
