import {
  ParticipantTile,
  VideoTrack,
  isTrackReference,
  useLocalParticipant,
  useMediaDeviceSelect,
  useParticipants,
  useSpeakingParticipants,
  useTracks,
  type TrackReferenceOrPlaceholder,
} from "@livekit/components-react";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  DrawerTrigger,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@tutorhub/ui";
import {
  Camera,
  CameraOff,
  Check,
  ChevronLeft,
  ChevronRight,
  Grid2X2,
  Hand,
  LayoutGrid,
  LogOut,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  PhoneOff,
  Pin,
  PinOff,
  Power,
  Presentation,
  ScreenShare,
  ScreenShareOff,
  Settings2,
  Smile,
  Sparkles,
  MessageCircle,
  UserRound,
  Users,
  X,
} from "lucide-react";
import {
  ConnectionQuality,
  ParticipantEvent,
  RemoteTrackPublication,
  Track,
  VideoQuality,
  type LocalVideoTrack,
  type Participant,
  type TrackProcessor,
} from "livekit-client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import { useI18n, type TranslationKey } from "../../app/i18n";
import {
  DEFAULT_VISUAL_EFFECTS,
  effectiveVisualEffects,
  hasActiveVisualEffects,
  resolveVisualEffectsPlan,
  saveVisualEffectsPreference,
  useCustomBackgrounds,
  visualEffectsSummaryKey,
  type ClassroomVisualEffectsState,
  type VisualEffectsRenderPlan,
  type VisualEffectsScope,
} from "../../app/visualEffects";
import { VisualEffectsPicker } from "../../components/VisualEffectsPicker";
import { MediaLobbyWaitingCountContext } from "../../components/MediaLobbyPanel";
import { ClassroomToolsPopover } from "../classroom-tools/ClassroomToolsPopover";
import type { ClassroomToolID } from "../classroom-tools/registry";
import {
  ClassroomToolActionsContext,
  type ClassroomToolActions,
} from "../classroom-tools/toolActions";
import {
  ClassroomDegradationController,
  projectClassroomDegradation,
  type ClassroomDegradationSignal,
  type ClassroomDegradationStage,
} from "./classroomDegradation";
import {
  ActiveSpeakerHysteresis,
  enterPresentation,
  getGridCapacity,
  getRailCapacity,
  projectClassroomLayout,
  restorePresentation,
  type ClassroomLayoutItem,
  type ClassroomLayoutMode,
  type ClassroomLayoutState,
} from "./classroomLayout";
import {
  CLASSROOM_REACTION_TYPES,
  fnv1aHash,
  mediaTileTone,
  participantInitials,
  projectTileSignals,
  type ClassroomReactionType,
  type ClassroomReactionVisualCluster,
  type ClassroomSignalProjection,
  type ClassroomTileSignal,
} from "./classroomSignals";
import {
  ClassroomEndRoomDialog,
  ClassroomModerationControls,
  classroomModerationBusy,
  type ClassroomModerationControlsModel,
} from "./ClassroomModerationControls";
import {
  ClassroomPeoplePanel,
  type ClassroomPeopleMediaState,
} from "./ClassroomPeoplePanel";

/** ROOM-CHAT-01: the three inspectors that share the right-hand slot. */
export type ClassroomInspectorID = "chat" | "roster" | "effects";

export type ClassroomConnectionStatus =
  "connecting" | "connected" | "reconnecting" | "disconnected" | "failed";

export interface ClassroomMediaShellProps {
  canPublishCameraMicrophone: boolean;
  canShareScreen: boolean;
  canSubscribe: boolean;
  connectionStatus: ClassroomConnectionStatus;
  controlAbortSignal?: AbortSignal;
  chat?: ReactNode;
  /**
   * ROOM-CHAT-01: unread room messages for the Dock badge (shown while the
   * chat inspector is closed). `chatUnreadCapped` renders `99+`.
   */
  chatUnreadCount?: number;
  chatUnreadCapped?: boolean;
  /** ROOM-CHAT-01: the room page drives polling and read state from this. */
  onChatOpenChange?: (open: boolean) => void;
  lobby?: ReactNode;
  /**
   * Number of people waiting for admission. Defaults to the value published by
   * `MediaLobbyWaitingCountProvider`; only meaningful when `lobby` is present.
   */
  lobbyWaitingCount?: number;
  moderation?: ClassroomModerationControlsModel;
  /**
   * ROOM-COMPACT-05: the lesson or class name shown in the Top Bar. Without
   * it the heading stays for assistive technology only.
   */
  roomTitle?: string | null;
  signals?: ClassroomSignalControls;
  tools?: readonly ClassroomToolDefinition[];
  /**
   * ADR-0041 visual effects for the local camera. Optional: without it the
   * shell starts with no effect and no personal background library.
   */
  visualEffects?: ClassroomVisualEffectsModel;
  onLeave: () => void;
  onTerminalMediaCleanup: () => Promise<void>;
}

export interface ClassroomVisualEffectsModel {
  /** The choice carried over from Pre-Join (memory escrow). */
  readonly initialState?: ClassroomVisualEffectsState;
  /** Scope of the device-local preference and personal backgrounds. */
  readonly scope?: VisualEffectsScope | null;
  /** Test seam; defaults to a dynamic import of the effects pipeline. */
  readonly loadRuntime?: () => Promise<RoomVisualEffectsRuntime>;
}

export type RoomVisualEffectsStatus =
  "off" | "loading" | "active" | "unsupported" | "failed" | "overloaded";

export interface RoomVisualEffectsProcessor extends TrackProcessor<Track.Kind.Video> {
  readonly visualEffectsMode: "lighting" | "background";
  applyPlan(plan: VisualEffectsRenderPlan): Promise<boolean>;
}

export interface RoomVisualEffectsRuntime {
  supportsVisualEffects(mode: "lighting" | "background"): boolean;
  createVisualEffectsProcessor(
    plan: VisualEffectsRenderPlan,
    options: { onOverload?: () => void; onFailure?: () => void },
  ): Promise<RoomVisualEffectsProcessor>;
}

type ProcessableVideoTrack = Pick<
  LocalVideoTrack,
  "getProcessor" | "setProcessor" | "stopProcessor"
>;

function loadRoomVisualEffectsRuntime(): Promise<RoomVisualEffectsRuntime> {
  return import("./visualEffectsProcessor");
}

function isProcessableVideoTrack(
  track: unknown,
): track is ProcessableVideoTrack {
  if (typeof track !== "object" || track === null) return false;
  const candidate = track as Partial<
    Record<keyof ProcessableVideoTrack, unknown>
  >;
  return (
    typeof candidate.setProcessor === "function" &&
    typeof candidate.stopProcessor === "function" &&
    typeof candidate.getProcessor === "function"
  );
}

/**
 * Keeps the published camera track's processor in line with the effects
 * choice. LiveKit already restarts an attached processor when the camera is
 * re-enabled or switched, and destroys it when the track stops; this only
 * attaches, updates, swaps (mode change) and removes it. Serialised, and each
 * await re-checks that its inputs are still current.
 */
class LocalCameraEffectsController {
  private status: RoomVisualEffectsStatus = "off";
  private readonly listeners = new Set<() => void>();
  private desired: {
    track: ProcessableVideoTrack | null;
    cameraEnabled: boolean;
    plan: VisualEffectsRenderPlan | null;
    key: string;
  } = { track: null, cameraEnabled: false, plan: null, key: "" };
  private suspendedKey: string | null = null;
  private attached: {
    track: ProcessableVideoTrack;
    processor: RoomVisualEffectsProcessor;
    key: string;
  } | null = null;
  private queue: Promise<void> = Promise.resolve();
  private active = false;

  constructor(
    private readonly loadRuntime: () => Promise<RoomVisualEffectsRuntime>,
  ) {}

  getStatus = (): RoomVisualEffectsStatus => this.status;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  activate(): void {
    this.active = true;
    this.schedule();
  }

  /** Unmount / leave: removes the processor (idempotent). */
  deactivate(): void {
    this.active = false;
    this.schedule();
  }

  update(
    track: ProcessableVideoTrack | null,
    cameraEnabled: boolean,
    plan: VisualEffectsRenderPlan | null,
  ): void {
    const key = plan ? JSON.stringify(plan) : "";
    if (key !== this.desired.key) this.suspendedKey = null;
    this.desired = { track, cameraEnabled, plan, key };
    this.schedule();
  }

  private schedule(): void {
    this.queue = this.queue.then(() => this.reconcile()).catch(() => undefined);
  }

  private setStatus(status: RoomVisualEffectsStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.listeners) listener();
  }

  private ownsProcessorOn(track: ProcessableVideoTrack): boolean {
    const attached = this.attached;
    return Boolean(
      attached &&
      attached.track === track &&
      track.getProcessor() === attached.processor,
    );
  }

  private async detach(): Promise<void> {
    const attached = this.attached;
    this.attached = null;
    if (!attached) return;
    try {
      if (attached.track.getProcessor() === attached.processor) {
        await attached.track.stopProcessor();
      }
    } catch {
      // A stopped or unpublished track already destroyed its processor.
    }
    await attached.processor.destroy().catch(() => undefined);
  }

  private trip(
    processor: RoomVisualEffectsProcessor,
    status: "overloaded" | "failed",
  ): void {
    if (this.attached?.processor !== processor) return;
    this.suspendedKey = this.desired.key;
    this.setStatus(status);
    this.schedule();
  }

  private async reconcile(): Promise<void> {
    const { track, cameraEnabled, key } = this.desired;
    const suspended = this.suspendedKey !== null && this.suspendedKey === key;
    const plan = this.active && !suspended ? this.desired.plan : null;
    const isCurrent = () =>
      this.active &&
      this.desired.track === track &&
      this.desired.cameraEnabled === cameraEnabled &&
      this.desired.key === key &&
      this.suspendedKey !== key;

    if (!plan || !track) {
      await this.detach();
      if (!suspended) this.setStatus("off");
      return;
    }
    if (this.attached && this.attached.track !== track) {
      await this.detach();
    }
    const attached = this.attached;
    if (attached && this.ownsProcessorOn(track)) {
      if (attached.key === key) {
        this.setStatus("active");
        return;
      }
      const applied = await attached.processor
        .applyPlan(plan)
        .catch(() => false);
      if (!isCurrent()) return;
      if (applied) {
        attached.key = key;
        this.setStatus("active");
        return;
      }
    }
    // A new processor is only ever attached to a live camera.
    if (!cameraEnabled) {
      await this.detach();
      this.setStatus("off");
      return;
    }

    this.setStatus("loading");
    let runtime: RoomVisualEffectsRuntime;
    try {
      runtime = await this.loadRuntime();
    } catch {
      if (isCurrent()) this.setStatus("failed");
      return;
    }
    if (!isCurrent()) return;
    if (!runtime.supportsVisualEffects(plan.mode)) {
      await this.detach();
      this.setStatus("unsupported");
      return;
    }
    let processor: RoomVisualEffectsProcessor;
    try {
      processor = await runtime.createVisualEffectsProcessor(plan, {
        onOverload: () => this.trip(processor, "overloaded"),
        onFailure: () => this.trip(processor, "failed"),
      });
    } catch {
      if (isCurrent()) this.setStatus("failed");
      return;
    }
    if (!isCurrent()) {
      await processor.destroy().catch(() => undefined);
      return;
    }
    const previous = this.attached;
    try {
      // Replaces (and stops) a previous processor of the other mode.
      await track.setProcessor(processor);
    } catch {
      await processor.destroy().catch(() => undefined);
      await this.detach();
      if (isCurrent()) {
        this.suspendedKey = key;
        this.setStatus("failed");
      }
      return;
    }
    if (previous && previous.processor !== processor) {
      await previous.processor.destroy().catch(() => undefined);
    }
    this.attached = { track, processor, key };
    this.setStatus("active");
  }
}

export type { ClassroomToolID };

/**
 * ROOM-TOOLS-CODE-01 / ADR-0043 §1: a tool registered for this room. The
 * Dock shows one Classroom tools key; each registered tool is a tile in its
 * popover and, once chosen, the only tool on the main stage.
 */
export interface ClassroomToolDefinition {
  /**
   * PREJOIN-UX-01: a server-derived token (e.g. `documentID:generation`) that
   * asks the shell to bring this tool onto the stage once. Each distinct key
   * opens the stage at most one time without moving keyboard focus, so a
   * viewer who closes it keeps camera view until a new key arrives.
   */
  readonly autoOpenKey?: string | null;
  readonly content: ReactNode;
  readonly icon: ReactNode;
  readonly id: ClassroomToolID;
  /** Short name on the Classroom tools tile (e.g. "Bảng trắng", "Code"). */
  readonly label: string;
  /**
   * ROOM-TOOLS-FILES-01B: called when the person closes this tool's stage
   * (the Top Bar Close key, or choosing its open tile again) — not when
   * another tool replaces it — so a tool can release memory it keeps for
   * quick switching (the Documents tool drops its in-RAM file bytes).
   */
  readonly onStageClose?: () => void;
  /** Stage heading and region name. */
  readonly title: string;
}

/** ROOM-TOOLS-CODE-01: the Dock key that opens the Classroom tools popover. */
const TOOLS_CONTROL_ID = "media-p506-control-tools";

/**
 * Escape pressed inside the tools popover, the Code tool or the Documents
 * tool belongs to them (closing the popover, CodeMirror's Escape-then-Tab
 * exit, the document search / crop / library drawer), never to the
 * non-modal right-hand inspector that Radix would otherwise dismiss.
 */
function escapeBelongsToToolSurface(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      ".media-p506-tools-popover, .media-p506-tool-code, .media-p506-tool-files",
    ) !== null
  );
}

/**
 * ROOM-COMPACT-05: where an open classroom tool puts its compact controls —
 * the right end of the room's single Top Bar. `null` (the default) means the
 * content is rendered outside a classroom stage and keeps its own bars;
 * inside the stage `element` is the slot to portal into (briefly `null`
 * until the Top Bar has mounted).
 */
export interface ClassroomHeaderSlot {
  readonly element: HTMLElement | null;
}

// eslint-disable-next-line react-refresh/only-export-components -- Shared slot contract: tool content (the whiteboard) portals its Top Bar controls through it without a new prop on every tool.
export const ClassroomHeaderSlotContext =
  createContext<ClassroomHeaderSlot | null>(null);

export interface ClassroomSignalControls {
  readonly error: boolean;
  readonly loading: boolean;
  readonly mutating: boolean;
  readonly projection: ClassroomSignalProjection | null;
  readonly refreshing: boolean;
  readonly onLowerAllHands: () => Promise<void>;
  readonly onLowerHand: (participantKey: string) => Promise<void>;
  readonly onResync: () => Promise<unknown>;
  readonly onSendReaction: (reaction: ClassroomReactionType) => Promise<void>;
  readonly onToggleHand: () => Promise<void>;
}

interface MediaLayoutItem extends ClassroomLayoutItem {
  readonly displayName: string;
  readonly trackRef: TrackReferenceOrPlaceholder;
}

interface SessionParticipantProjection {
  readonly id: string;
  readonly sequence: number;
}

interface SessionParticipantProjectionSnapshot {
  readonly entries: WeakMap<object, SessionParticipantProjection>;
  readonly revision: number;
}

interface SessionParticipantProjectionStore {
  readonly getSnapshot: () => SessionParticipantProjectionSnapshot;
  readonly observe: (trackRefs: readonly TrackReferenceOrPlaceholder[]) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

interface MediaTileProps {
  attachVideo: boolean;
  item: MediaLayoutItem;
  pinned: boolean;
  /**
   * ROOM-STAGE-POLISH-04: this participant's hand / reaction badges. Ignored
   * on a screen-share tile, which never carries personal badges.
   */
  signal?: ClassroomTileSignal | undefined;
  /** ROOM-STAGE-POLISH-04: camera-off surface tone (0–7). */
  tone: number;
  /** ROOM-TILE-TEAMS-01: room-wide microphone and speaking cues. */
  mediaCues: MediaTileMediaCues;
  trackRef?: TrackReferenceOrPlaceholder;
  variant: "grid" | "rail" | "stage";
  onTogglePin: (item: MediaLayoutItem, focusTarget: HTMLElement) => void;
}

/**
 * ROOM-TILE-TEAMS-01: what the shell already knows about microphones. The
 * local state comes straight from `useLocalParticipant` (it flips the moment
 * the Dock key is pressed); remote unmuted microphones come from the shell's
 * microphone track references and speakers from `useSpeakingParticipants`.
 */
interface MediaTileMediaCues {
  readonly localMicrophoneEnabled: boolean;
  readonly speaking: ReadonlySet<Participant>;
  readonly unmutedMicrophones: ReadonlySet<Participant>;
}

/**
 * ROOM-TILE-TEAMS-01: participant events that can change a remote tile's
 * microphone or speaking cue. A mock may not define every name, so only real
 * event strings are subscribed.
 */
const TILE_MEDIA_EVENTS: readonly string[] = (
  [
    ParticipantEvent.TrackMuted,
    ParticipantEvent.TrackUnmuted,
    ParticipantEvent.TrackPublished,
    ParticipantEvent.TrackUnpublished,
    ParticipantEvent.IsSpeakingChanged,
  ] as readonly unknown[]
).filter((event): event is string => typeof event === "string");

interface TileParticipantEmitter {
  off(event: string, listener: () => void): unknown;
  on(event: string, listener: () => void): unknown;
}

function tileParticipantEmitter(
  participant: Participant | null,
): TileParticipantEmitter | null {
  if (!participant) return null;
  const candidate = participant as unknown as Partial<
    Record<keyof TileParticipantEmitter, unknown>
  >;
  return typeof candidate.on === "function" &&
    typeof candidate.off === "function"
    ? (participant as unknown as TileParticipantEmitter)
    : null;
}

/** A primitive snapshot ("10" = microphone on, not speaking) for the store. */
function tileParticipantMediaSnapshot(participant: Participant | null) {
  if (!participant) return "00";
  const fields = participant as unknown as Partial<
    Record<"isMicrophoneEnabled" | "isSpeaking", unknown>
  >;
  return `${fields.isMicrophoneEnabled === true ? 1 : 0}${
    fields.isSpeaking === true ? 1 : 0
  }`;
}

/**
 * ROOM-TILE-TEAMS-01: a remote participant's own microphone / speaking state,
 * re-read on every LiveKit mute, publish and speaking event. Only `data-*`
 * attributes and the avatar's content follow it, never the tile's key or its
 * <VideoTrack>, so toggling a microphone never remounts a <video>.
 */
function useRemoteTileMediaState(participant: Participant | null) {
  const subscribe = useCallback(
    (notify: () => void) => {
      const emitter = tileParticipantEmitter(participant);
      if (!emitter) return () => undefined;
      for (const event of TILE_MEDIA_EVENTS) emitter.on(event, notify);
      return () => {
        for (const event of TILE_MEDIA_EVENTS) emitter.off(event, notify);
      };
    },
    [participant],
  );
  const read = useCallback(
    () => tileParticipantMediaSnapshot(participant),
    [participant],
  );
  const snapshot = useSyncExternalStore(subscribe, read, read);
  return {
    microphoneEnabled: snapshot[0] === "1",
    speaking: snapshot[1] === "1",
  };
}

type ToolbarControlKey =
  | "microphone"
  | "camera"
  | "screen-share"
  | "devices"
  | "effects"
  | "hand"
  | "reaction"
  | "chat"
  | "roster"
  | "tools"
  | "layout";

const initialLayoutState: ClassroomLayoutState = {
  mode: "grid",
  requestedPage: 0,
  pinnedParticipantId: null,
  presenterId: null,
  focusTargetId: null,
  presentationRestore: null,
};

function classroomToolAutoOpenSeenKey(tool: ClassroomToolDefinition): string {
  return `${tool.id}\u0000${tool.autoOpenKey ?? ""}`;
}

const layoutModes: readonly ClassroomLayoutMode[] = [
  "grid",
  "active-speaker",
  "presentation",
];

function isClassroomLayoutMode(value: string): value is ClassroomLayoutMode {
  return (layoutModes as readonly string[]).includes(value);
}

/** The Dock key that owns the layout menu (focus fallback after changes). */
const LAYOUT_CONTROL_ID = "media-p405-control-layout";

export function ClassroomMediaShell({
  canPublishCameraMicrophone,
  canShareScreen,
  canSubscribe,
  connectionStatus,
  controlAbortSignal,
  chat,
  chatUnreadCount = 0,
  chatUnreadCapped = false,
  onChatOpenChange,
  lobby,
  lobbyWaitingCount,
  moderation,
  roomTitle,
  signals,
  tools = [],
  visualEffects: visualEffectsModel,
  onLeave,
  onTerminalMediaCleanup,
}: ClassroomMediaShellProps) {
  const { t } = useI18n();
  const contextWaitingCount = useContext(MediaLobbyWaitingCountContext);
  const waitingCount = lobby
    ? Math.max(0, lobbyWaitingCount ?? contextWaitingCount)
    : 0;
  const shellRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const speakerController = useRef(new ActiveSpeakerHysteresis());
  const previousPresenterID = useRef<string | null>(null);
  const managedRemoteVideos = useRef(new Set<RemoteTrackPublication>());
  const managedRemoteAudio = useRef(new Set<RemoteTrackPublication>());
  const degradationController = useRef(new ClassroomDegradationController());
  const controlLifecycle = useRef({ active: true, generation: 0 });
  const focusTimer = useRef<number | null>(null);
  const [width, setWidth] = useState(1_280);
  const [layoutState, setLayoutState] =
    useState<ClassroomLayoutState>(initialLayoutState);
  const [activeSpeakerID, setActiveSpeakerID] = useState<string | null>(null);
  const [devicePanelOpen, setDevicePanelOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  // ROOM-CHAT-01 / ADR-0042: Chat, People and Effects share one non-modal
  // right-hand inspector slot; opening one closes the others.
  const [inspector, setInspector] = useState<ClassroomInspectorID | null>(null);
  const inspectorRef = useRef<ClassroomInspectorID | null>(null);
  useLayoutEffect(() => {
    inspectorRef.current = inspector;
  }, [inspector]);
  const inspectorSetters = useMemo(() => {
    const setterFor =
      (id: ClassroomInspectorID) => (action: SetStateAction<boolean>) =>
        setInspector((current) => {
          const wasOpen = current === id;
          const next = typeof action === "function" ? action(wasOpen) : action;
          if (next) return id;
          return wasOpen ? null : current;
        });
    return {
      chat: setterFor("chat"),
      effects: setterFor("effects"),
      roster: setterFor("roster"),
    };
  }, []);
  const rosterOpen = inspector === "roster";
  const chatOpen = inspector === "chat";
  const setRosterOpen = inspectorSetters.roster;
  const setChatOpen = inspectorSetters.chat;
  const chatReturnFocus = useRef<HTMLButtonElement>(null);
  const rosterReturnFocus = useRef<HTMLButtonElement>(null);
  const [openToolID, setOpenToolID] = useState<ClassroomToolID | null>(null);
  // ROOM-TOOLS-CODE-01: one Dock key opens the Classroom tools popover.
  const [toolsPopoverOpen, setToolsPopoverOpen] = useState(false);
  const toolsTriggerRef = useRef<HTMLButtonElement>(null);
  const toolsPopoverID = useId();
  const toolsDescriptionID = useId();
  const [headerSlotElement, setHeaderSlotElement] =
    useState<HTMLDivElement | null>(null);
  const headerSlot = useMemo<ClassroomHeaderSlot>(
    () => ({ element: headerSlotElement }),
    [headerSlotElement],
  );
  const [autoOpenedToolID, setAutoOpenedToolID] =
    useState<ClassroomToolID | null>(null);
  const [stageFocus, setStageFocus] = useState(false);
  const fullscreen = useRoomFullscreen();
  const [seenAutoOpenKeys, setSeenAutoOpenKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [signalFeedback, setSignalFeedback] = useState<TranslationKey | null>(
    null,
  );
  const [reactionAnnouncement, setReactionAnnouncement] = useState("");
  const lastReactionAnnouncementAt = useRef(0);
  const reactionAnnouncementTimer = useRef<number | null>(null);
  const [pendingControl, setPendingControl] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState(false);
  const [controlsTerminated, setControlsTerminated] = useState(
    controlAbortSignal?.aborted ?? false,
  );
  const [toolbarFocusKey, setToolbarFocusKey] = useState<ToolbarControlKey>(
    () =>
      canPublishCameraMicrophone
        ? "microphone"
        : canShareScreen
          ? "screen-share"
          : "devices",
  );
  const cameraTrackRefs = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: true }],
    { onlySubscribed: false },
  );
  const liveKitParticipants = useParticipants();
  const screenShareTrackRefs = useTracks([Track.Source.ScreenShare], {
    onlySubscribed: false,
  });
  const audioTrackRefs = useTracks(
    [Track.Source.Microphone, Track.Source.ScreenShareAudio],
    { onlySubscribed: false },
  );
  const [sessionParticipantProjectionStore] =
    useState<SessionParticipantProjectionStore>(() =>
      createSessionParticipantProjectionStore(cameraTrackRefs),
    );
  const sessionParticipantProjection = useSyncExternalStore(
    sessionParticipantProjectionStore.subscribe,
    sessionParticipantProjectionStore.getSnapshot,
    sessionParticipantProjectionStore.getSnapshot,
  );
  const speakingParticipants = useSpeakingParticipants();
  const {
    cameraTrack: localCameraPublication,
    isCameraEnabled,
    isMicrophoneEnabled,
    isScreenShareEnabled,
    localParticipant,
  } = useLocalParticipant();
  const [localConnectionQuality, setLocalConnectionQuality] =
    useState<ConnectionQuality>(localParticipant.connectionQuality);
  const [degradationStage, setDegradationStage] =
    useState<ClassroomDegradationStage>("normal");

  // ADR-0041 visual effects (local camera only).
  const effectsScope = visualEffectsModel?.scope ?? null;
  const [effectsChoice, setEffectsChoice] =
    useState<ClassroomVisualEffectsState>(
      () => visualEffectsModel?.initialState ?? DEFAULT_VISUAL_EFFECTS,
    );
  const effectsOpen = inspector === "effects";
  const setEffectsOpen = inspectorSetters.effects;
  const effectsReturnFocus = useRef<HTMLElement | null>(null);
  const effectsDescriptionID = useId();
  const chatDescriptionID = useId();
  const backgroundLibrary = useCustomBackgrounds(effectsScope);
  const libraryStatus = backgroundLibrary.status;
  const libraryUrlFor = backgroundLibrary.urlFor;
  const visualEffects = useMemo(
    () =>
      effectiveVisualEffects(effectsChoice, {
        status: libraryStatus,
        urlFor: libraryUrlFor,
      }),
    [effectsChoice, libraryStatus, libraryUrlFor],
  );
  const visualEffectsPlan = useMemo(
    () => resolveVisualEffectsPlan(visualEffects, libraryUrlFor),
    [libraryUrlFor, visualEffects],
  );
  const loadEffectsRuntime =
    visualEffectsModel?.loadRuntime ?? loadRoomVisualEffectsRuntime;
  const [effectsController] = useState(
    () => new LocalCameraEffectsController(loadEffectsRuntime),
  );
  const effectsStatus = useSyncExternalStore(
    effectsController.subscribe,
    effectsController.getStatus,
    effectsController.getStatus,
  );
  const localCameraTrack = localCameraPublication?.track;

  const participantAttributeRevision = liveKitParticipants
    .map(
      (participant) =>
        participant.attributes?.["tutorhub.participant_key"] ?? "",
    )
    .join("\u0000");

  useLayoutEffect(() => {
    sessionParticipantProjectionStore.observe(cameraTrackRefs);
  }, [cameraTrackRefs, sessionParticipantProjectionStore]);

  const scheduleElementFocus = useCallback(
    (elementID: string | null, fallbackElementID?: string) => {
      if (!elementID && !fallbackElementID) return;
      if (focusTimer.current !== null) {
        globalThis.clearTimeout(focusTimer.current);
      }
      focusTimer.current = globalThis.setTimeout(() => {
        focusTimer.current = null;
        const target = elementID ? document.getElementById(elementID) : null;
        const fallback = fallbackElementID
          ? document.getElementById(fallbackElementID)
          : null;
        (target ?? fallback)?.focus();
      }, 0);
    },
    [],
  );

  const handleDeviceError = useCallback(() => {
    if (!controlLifecycle.current.active) return;
    controlLifecycle.current.generation += 1;
    setPendingControl(null);
    setMediaError(true);
  }, []);

  useEffect(() => {
    const lifecycle = controlLifecycle.current;
    lifecycle.active = true;
    return () => {
      lifecycle.active = false;
      lifecycle.generation += 1;
    };
  }, []);

  useEffect(
    () => () => {
      if (focusTimer.current !== null) {
        globalThis.clearTimeout(focusTimer.current);
        focusTimer.current = null;
      }
      if (reactionAnnouncementTimer.current !== null) {
        globalThis.clearTimeout(reactionAnnouncementTimer.current);
        reactionAnnouncementTimer.current = null;
      }
    },
    [],
  );

  const reactionSummaryKey =
    signals?.projection?.reactions.summary
      .map(({ reaction, count }) => `${reaction}:${count}`)
      .join("|") ?? "";
  const reactionTotal =
    signals?.projection?.reactions.summary.reduce(
      (count, item) => count + item.count,
      0,
    ) ?? 0;
  useEffect(() => {
    if (reactionTotal === 0) {
      return undefined;
    }
    const now = Date.now();
    const delay = Math.max(
      0,
      2_000 - (now - lastReactionAnnouncementAt.current),
    );
    if (reactionAnnouncementTimer.current !== null) {
      globalThis.clearTimeout(reactionAnnouncementTimer.current);
    }
    reactionAnnouncementTimer.current = globalThis.setTimeout(() => {
      reactionAnnouncementTimer.current = null;
      lastReactionAnnouncementAt.current = Date.now();
      setReactionAnnouncement(
        t("media.p406.reactionAnnouncement", { count: reactionTotal }),
      );
    }, delay);
    return () => {
      if (reactionAnnouncementTimer.current !== null) {
        globalThis.clearTimeout(reactionAnnouncementTimer.current);
        reactionAnnouncementTimer.current = null;
      }
    };
  }, [reactionSummaryKey, reactionTotal, t]);

  useEffect(() => {
    if (!controlAbortSignal) return undefined;
    const invalidateControls = () => {
      const lifecycle = controlLifecycle.current;
      lifecycle.active = false;
      lifecycle.generation += 1;
      setPendingControl(null);
      setMediaError(false);
      setDevicePanelOpen(false);
      setEffectsOpen(false);
      setControlsTerminated(true);
    };
    if (controlAbortSignal.aborted) {
      invalidateControls();
      return undefined;
    }
    controlAbortSignal.addEventListener("abort", invalidateControls, {
      once: true,
    });
    return () =>
      controlAbortSignal.removeEventListener("abort", invalidateControls);
  }, [controlAbortSignal, setEffectsOpen]);

  useEffect(() => {
    effectsController.activate();
    return () => effectsController.deactivate();
  }, [effectsController]);

  useEffect(() => {
    const publishing = canPublishCameraMicrophone && !controlsTerminated;
    effectsController.update(
      publishing && isProcessableVideoTrack(localCameraTrack)
        ? localCameraTrack
        : null,
      isCameraEnabled,
      publishing ? visualEffectsPlan : null,
    );
  }, [
    canPublishCameraMicrophone,
    controlsTerminated,
    effectsController,
    isCameraEnabled,
    localCameraTrack,
    visualEffectsPlan,
  ]);

  useEffect(() => {
    const handleConnectionQuality = (quality: ConnectionQuality) => {
      setLocalConnectionQuality(quality);
    };
    localParticipant.on(
      ParticipantEvent.ConnectionQualityChanged,
      handleConnectionQuality,
    );
    return () => {
      localParticipant.off(
        ParticipantEvent.ConnectionQualityChanged,
        handleConnectionQuality,
      );
    };
  }, [localParticipant]);

  // ROOM-STAGE-POLISH-04: top-right hand / reaction badges per tile, joined
  // only through the opaque participant key (the tile id once the server
  // roster is authoritative), and a per-room salt for camera-off tones.
  const signalProjection = signals?.projection;
  const tileSignals = useMemo(
    () => projectTileSignals(signalProjection),
    [signalProjection],
  );
  // ROOM-TILE-TEAMS-01: microphone / speaking cues every tile reads. Remote
  // microphones count as live only when their publication says unmuted.
  const tileMediaCues = useMemo<MediaTileMediaCues>(() => {
    const unmutedMicrophones = new Set<Participant>();
    for (const trackRef of audioTrackRefs) {
      if (
        trackRef.source === Track.Source.Microphone &&
        !trackRef.participant.isLocal &&
        trackRef.publication.isMuted === false
      ) {
        unmutedMicrophones.add(trackRef.participant);
      }
    }
    return {
      localMicrophoneEnabled: isMicrophoneEnabled,
      speaking: new Set<Participant>(speakingParticipants),
      unmutedMicrophones,
    };
  }, [audioTrackRefs, isMicrophoneEnabled, speakingParticipants]);
  const toneSalt = useMemo(
    () => fnv1aHash(signalProjection?.room_instance_id ?? ""),
    [signalProjection?.room_instance_id],
  );

  const allCameraItems = useMemo(() => {
    void participantAttributeRevision;
    return signals
      ? authoritativeMediaItems(
          cameraTrackRefs,
          signals.projection?.roster ?? [],
          signals.projection?.self_participant_key ?? null,
        )
      : stableMediaItems(
          cameraTrackRefs,
          sessionParticipantProjection.entries,
          t("media.p405.participantFallback"),
        );
  }, [
    cameraTrackRefs,
    participantAttributeRevision,
    sessionParticipantProjection,
    signals,
    t,
  ]);
  const cameraItems = useMemo(
    () =>
      canSubscribe
        ? allCameraItems
        : allCameraItems.filter(({ trackRef }) => trackRef.participant.isLocal),
    [allCameraItems, canSubscribe],
  );
  const itemByParticipant = useMemo(
    () =>
      new Map(
        allCameraItems.map(
          (item) => [item.trackRef.participant, item] as const,
        ),
      ),
    [allCameraItems],
  );
  const presenterTrackRef = screenShareTrackRefs[0];
  const presenterItem = presenterTrackRef
    ? (itemByParticipant.get(presenterTrackRef.participant) ?? null)
    : null;
  const presenterID = presenterItem?.id ?? null;
  const toolbarControlKeys = useMemo<readonly ToolbarControlKey[]>(
    () => [
      ...(canPublishCameraMicrophone &&
      pendingControl === null &&
      !controlsTerminated
        ? (["microphone", "camera"] as const)
        : []),
      ...(canShareScreen && pendingControl === null && !controlsTerminated
        ? (["screen-share"] as const)
        : []),
      ...(!controlsTerminated ? (["devices"] as const) : []),
      ...(canPublishCameraMicrophone && !controlsTerminated
        ? (["effects"] as const)
        : []),
      ...(signals?.projection?.viewer_operations.can_raise_hand
        ? (["hand"] as const)
        : []),
      ...(signals?.projection?.viewer_operations.can_send_reaction
        ? (["reaction"] as const)
        : []),
      ...(chat ? (["chat"] as const) : []),
      ...(tools.length > 0 ? (["tools"] as const) : []),
      "layout",
      ...(signals || lobby ? (["roster"] as const) : []),
    ],
    [
      canPublishCameraMicrophone,
      canShareScreen,
      chat,
      controlsTerminated,
      lobby,
      pendingControl,
      signals,
      tools,
    ],
  );
  const effectiveToolbarFocusKey = toolbarControlKeys.includes(toolbarFocusKey)
    ? toolbarFocusKey
    : toolbarControlKeys[0];
  const toolbarTabIndex = (key: ToolbarControlKey) =>
    effectiveToolbarFocusKey === key ? 0 : -1;

  const candidateSpeaker = speakingParticipants[0];
  const candidateSpeakerID = candidateSpeaker
    ? (itemByParticipant.get(candidateSpeaker)?.id ?? null)
    : null;
  const normalVisibleVideoItems =
    layoutState.mode === "grid"
      ? getGridCapacity(width)
      : 1 +
        getRailCapacity(
          width,
          layoutState.mode === "presentation"
            ? "presentation"
            : "active-speaker",
        );
  useLayoutEffect(() => {
    const element = shellRef.current;
    if (!element) return;

    const updateWidth = () => {
      const nextWidth = element.getBoundingClientRect().width;
      setWidth(nextWidth > 0 ? nextWidth : globalThis.innerWidth || 1_280);
    };
    updateWidth();

    if (typeof ResizeObserver === "undefined") {
      globalThis.addEventListener("resize", updateWidth);
      return () => globalThis.removeEventListener("resize", updateWidth);
    }
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const tick = () => {
      const selected = speakerController.current.observe(candidateSpeakerID);
      setActiveSpeakerID((current) =>
        current === selected ? current : selected,
      );
    };
    tick();
    const timer = globalThis.setInterval(tick, 200);
    return () => globalThis.clearInterval(timer);
  }, [candidateSpeakerID]);

  useLayoutEffect(() => {
    const previousPresenter = previousPresenterID.current;
    previousPresenterID.current = presenterID;

    if (presenterID && presenterID !== previousPresenter) {
      const activeElement = document.activeElement;
      const focusTargetId =
        activeElement instanceof HTMLElement &&
        shellRef.current?.contains(activeElement)
          ? activeElement.id || LAYOUT_CONTROL_ID
          : LAYOUT_CONTROL_ID;
      setLayoutState((current) =>
        enterPresentation({ ...current, focusTargetId }, presenterID),
      );
      return;
    }

    if (!presenterID && previousPresenter) {
      const restored = restorePresentation(layoutState, cameraItems, width);
      setLayoutState(restored.state);
      scheduleElementFocus(restored.state.focusTargetId, LAYOUT_CONTROL_ID);
    }
  }, [cameraItems, layoutState, presenterID, scheduleElementFocus, width]);

  useEffect(() => {
    if (
      layoutState.pinnedParticipantId &&
      !cameraItems.some(({ id }) => id === layoutState.pinnedParticipantId)
    ) {
      const timer = globalThis.setTimeout(
        () =>
          setLayoutState((current) => ({
            ...current,
            pinnedParticipantId: null,
          })),
        0,
      );
      return () => globalThis.clearTimeout(timer);
    }
    return undefined;
  }, [cameraItems, layoutState.pinnedParticipantId]);

  const projection = useMemo(
    () =>
      projectClassroomLayout({
        items: cameraItems,
        mode: layoutState.mode,
        width,
        requestedPage: layoutState.requestedPage,
        activeSpeakerId: activeSpeakerID,
        pinnedParticipantId: layoutState.pinnedParticipantId,
        presenterId: presenterID,
      }),
    [activeSpeakerID, cameraItems, layoutState, presenterID, width],
  );
  const degradationProjection = useMemo(
    () =>
      projectClassroomDegradation(degradationStage, {
        normalVideoSubscriptionLimit: normalVisibleVideoItems,
        hasPresentation: projection.stage?.kind === "presentation",
      }),
    [degradationStage, normalVisibleVideoItems, projection.stage?.kind],
  );

  const attachedCameraVideoItemIDs = useMemo(() => {
    const orderedCameraItemIDs = [
      ...(projection.stage?.kind === "participant"
        ? [projection.stage.item.id]
        : []),
      ...projection.items.map(({ id }) => id),
    ];
    return new Set(
      orderedCameraItemIDs.slice(0, degradationProjection.maxCameraVideoItems),
    );
  }, [
    degradationProjection.maxCameraVideoItems,
    projection.items,
    projection.stage,
  ]);
  const attachPresentationVideo = Boolean(
    degradationProjection.subscribePresentationVideo &&
    projection.stage?.kind === "presentation",
  );

  useEffect(() => {
    if (layoutState.requestedPage === projection.page) return undefined;
    const timer = globalThis.setTimeout(() => {
      setLayoutState((current) =>
        current.requestedPage === projection.page
          ? current
          : { ...current, requestedPage: projection.page },
      );
      scheduleElementFocus("media-p405-pagination");
    }, 0);
    return () => globalThis.clearTimeout(timer);
  }, [layoutState.requestedPage, projection.page, scheduleElementFocus]);

  const stageItem = projection.stage?.item ?? null;
  const stageTrackRef =
    projection.stage?.kind === "presentation" && presenterTrackRef
      ? presenterTrackRef
      : stageItem?.trackRef;
  const isResponsiveDrawer = width < 1_024;

  useEffect(() => {
    const currentPublications = new Set<RemoteTrackPublication>();
    const desiredPublications = new Map<RemoteTrackPublication, VideoQuality>();
    const collect = (
      refs: readonly TrackReferenceOrPlaceholder[],
      isPresentation: boolean,
    ) => {
      for (const trackRef of refs) {
        const publication = isTrackReference(trackRef)
          ? trackRef.publication
          : undefined;
        if (!isRemoteTrackPublication(publication)) continue;
        currentPublications.add(publication);
        managedRemoteVideos.current.add(publication);
        const item = itemByParticipant.get(trackRef.participant);
        const visible = Boolean(
          canSubscribe &&
          item &&
          (isPresentation
            ? attachPresentationVideo &&
              projection.stage?.kind === "presentation" &&
              item.id === projection.stage.item.id
            : attachedCameraVideoItemIDs.has(item.id)),
        );
        if (visible) {
          const quality =
            !isPresentation &&
            degradationProjection.remoteCameraQuality === "low"
              ? VideoQuality.LOW
              : VideoQuality.HIGH;
          desiredPublications.set(publication, quality);
        }
      }
    };

    collect(cameraTrackRefs, false);
    collect(screenShareTrackRefs, true);

    // Keep the hard bound true throughout a page/share transition: retire old
    // subscriptions before enabling any replacement, regardless of provider
    // publication order.
    for (const publication of managedRemoteVideos.current) {
      if (!desiredPublications.has(publication) && publication.isDesired) {
        publication.setSubscribed(false);
      }
      if (!currentPublications.has(publication)) {
        managedRemoteVideos.current.delete(publication);
      }
    }
    for (const [publication, quality] of desiredPublications) {
      if (!publication.isDesired) publication.setSubscribed(true);
      if (publication.videoQuality !== quality) {
        publication.setVideoQuality(quality);
      }
    }
  }, [
    attachPresentationVideo,
    attachedCameraVideoItemIDs,
    cameraTrackRefs,
    canSubscribe,
    degradationProjection.remoteCameraQuality,
    itemByParticipant,
    projection.stage,
    screenShareTrackRefs,
  ]);

  useEffect(
    () => () => {
      for (const publication of managedRemoteVideos.current) {
        if (publication.isDesired) publication.setSubscribed(false);
      }
      managedRemoteVideos.current.clear();
    },
    [],
  );

  useEffect(() => {
    const controller = degradationController.current;
    const tick = () => {
      const signal = classroomDegradationSignal(
        localConnectionQuality,
        managedRemoteVideos.current,
        document.visibilityState === "visible",
      );
      const nextStage = controller.observe(signal);
      setDegradationStage((current) =>
        current === nextStage ? current : nextStage,
      );
    };
    tick();
    const timer = globalThis.setInterval(tick, 1_000);
    return () => globalThis.clearInterval(timer);
  }, [localConnectionQuality, sessionParticipantProjection]);

  useEffect(() => {
    const currentPublications = new Set<RemoteTrackPublication>();
    for (const trackRef of audioTrackRefs) {
      const publication = isTrackReference(trackRef)
        ? trackRef.publication
        : undefined;
      if (!isRemoteTrackPublication(publication)) continue;
      currentPublications.add(publication);
      managedRemoteAudio.current.add(publication);
      if (publication.isDesired !== canSubscribe) {
        publication.setSubscribed(canSubscribe);
      }
    }
    for (const publication of managedRemoteAudio.current) {
      if (!currentPublications.has(publication)) {
        if (publication.isDesired) publication.setSubscribed(false);
        managedRemoteAudio.current.delete(publication);
      }
    }
  }, [audioTrackRefs, canSubscribe]);

  useEffect(
    () => () => {
      for (const publication of managedRemoteAudio.current) {
        if (publication.isDesired) publication.setSubscribed(false);
      }
      managedRemoteAudio.current.clear();
    },
    [],
  );

  const runControl = useCallback(
    async (name: string, action: () => Promise<unknown>) => {
      const lifecycle = controlLifecycle.current;
      if (!lifecycle.active) return;
      const generation = ++lifecycle.generation;
      setPendingControl(name);
      setMediaError(false);
      try {
        await action();
      } catch {
        if (lifecycle.active && lifecycle.generation === generation) {
          setMediaError(true);
        }
      } finally {
        if (!lifecycle.active) {
          await onTerminalMediaCleanup();
        }
        if (lifecycle.active && lifecycle.generation === generation) {
          setPendingControl(null);
        }
      }
    },
    [onTerminalMediaCleanup],
  );

  useEffect(() => {
    if (
      degradationStage !== "audio-only" ||
      !isCameraEnabled ||
      controlsTerminated
    ) {
      return;
    }
    void runControl("camera", () => localParticipant.setCameraEnabled(false));
  }, [
    controlsTerminated,
    degradationStage,
    isCameraEnabled,
    localParticipant,
    runControl,
  ]);

  const runSignalAction = useCallback(
    async (action: () => Promise<void>, successKey: TranslationKey) => {
      if (!signals || controlsTerminated || signals.mutating) return;
      setSignalFeedback(null);
      try {
        await action();
        if (controlLifecycle.current.active) {
          setSignalFeedback(successKey);
        }
      } catch (error) {
        if (controlLifecycle.current.active) {
          setSignalFeedback(signalMutationErrorKey(error));
        }
      }
    },
    [controlsTerminated, signals],
  );

  const handleLeave = useCallback(() => {
    const lifecycle = controlLifecycle.current;
    lifecycle.active = false;
    lifecycle.generation += 1;
    setPendingControl(null);
    onLeave();
  }, [onLeave]);

  const handleTogglePin = useCallback(
    (item: MediaLayoutItem, focusTarget: HTMLElement) => {
      const targetID = focusTarget.id;
      setLayoutState((current) => ({
        ...current,
        mode: "active-speaker",
        requestedPage: 0,
        pinnedParticipantId:
          current.pinnedParticipantId === item.id ? null : item.id,
        focusTargetId: targetID,
      }));
      scheduleElementFocus(targetID, LAYOUT_CONTROL_ID);
    },
    [scheduleElementFocus],
  );

  const handleToolbarKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      return;
    }
    const controls = Array.from(
      toolbarRef.current?.querySelectorAll<HTMLElement>(
        "[data-media-control]:not(:disabled)",
      ) ?? [],
    );
    const currentIndex = controls.indexOf(
      document.activeElement as HTMLElement,
    );
    if (currentIndex < 0 || controls.length === 0) return;
    event.preventDefault();
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? controls.length - 1
          : (currentIndex +
              (event.key === "ArrowRight" ? 1 : -1) +
              controls.length) %
            controls.length;
    const nextControl = controls[nextIndex];
    const nextKey = nextControl?.dataset.mediaControl as
      ToolbarControlKey | undefined;
    if (nextKey) {
      setToolbarFocusKey(nextKey);
    }
    nextControl?.focus();
  };

  // A presenter-driven key (for example the whiteboard opening a new
  // generation) brings its tool onto the stage exactly once per key and never
  // moves keyboard focus. A key already seen is ignored, so a manual close
  // sticks until the server projects a different key. This adjusts state
  // while rendering (React's "store information from previous renders"
  // pattern) instead of a synchronous setState inside an effect.
  const pendingAutoOpenTool = tools.find(
    (tool) =>
      Boolean(tool.autoOpenKey) &&
      !seenAutoOpenKeys.has(classroomToolAutoOpenSeenKey(tool)),
  );
  if (pendingAutoOpenTool) {
    const seenKey = classroomToolAutoOpenSeenKey(pendingAutoOpenTool);
    setSeenAutoOpenKeys((current) => new Set(current).add(seenKey));
    if (openToolID !== pendingAutoOpenTool.id) {
      setOpenToolID(pendingAutoOpenTool.id);
      setAutoOpenedToolID(pendingAutoOpenTool.id);
    }
  }

  const activeTool = tools.find((tool) => tool.id === openToolID) ?? null;

  // ROOM-UI-POLISH-01: Teams-style "Focus on content". With a tool on a
  // desktop stage the 256px camera column can step aside; CSS only hides
  // it, so no media node remounts. Closing the tool resets the choice.
  if (stageFocus && activeTool === null) setStageFocus(false);
  const stageFocusAvailable = activeTool !== null && width >= 960;
  const stageFocusActive = stageFocus && stageFocusAvailable;

  // ROOM-TOOLS-CODE-01: the tool stage is a non-modal region and the Dock
  // stays reachable. Choosing a tile closes the popover, puts that tool on
  // the stage (replacing another one; LiveKit media never remounts) and
  // focuses its stage heading; choosing the open tool again, or the Top Bar
  // Close key, closes the stage and returns focus to the Classroom tools key.
  const closeToolsPopover = useCallback((restoreFocus: boolean) => {
    setToolsPopoverOpen(false);
    if (restoreFocus) toolsTriggerRef.current?.focus();
  }, []);

  const selectTool = (toolID: ClassroomToolID) => {
    setToolsPopoverOpen(false);
    setAutoOpenedToolID(null);
    if (openToolID === toolID) {
      activeTool?.onStageClose?.();
      setOpenToolID(null);
      scheduleElementFocus(TOOLS_CONTROL_ID);
      return;
    }
    setOpenToolID(toolID);
    scheduleElementFocus(`media-p506-stage-title-${toolID}`);
  };

  const closeActiveTool = () => {
    if (!activeTool) return;
    activeTool.onStageClose?.();
    setAutoOpenedToolID(null);
    setOpenToolID(null);
    scheduleElementFocus(TOOLS_CONTROL_ID);
  };

  // Room actions for hosted content: the Code tool's "Send to chat" and the
  // chat's "Open in Code". Refs keep the value stable across renders.
  const registeredToolsRef = useRef(tools);
  const chatPresentRef = useRef(Boolean(chat));
  useLayoutEffect(() => {
    registeredToolsRef.current = tools;
    chatPresentRef.current = Boolean(chat);
  }, [chat, tools]);
  const toolActions = useMemo<ClassroomToolActions>(
    () => ({
      hasTool: (id) =>
        registeredToolsRef.current.some((tool) => tool.id === id),
      openChat: () => {
        if (!chatPresentRef.current) return false;
        setChatOpen(true);
        return true;
      },
      openTool: (id) => {
        if (!registeredToolsRef.current.some((tool) => tool.id === id)) {
          return false;
        }
        setToolsPopoverOpen(false);
        setAutoOpenedToolID(null);
        setOpenToolID(id);
        scheduleElementFocus(`media-p506-stage-title-${id}`);
        return true;
      },
    }),
    [scheduleElementFocus, setChatOpen],
  );

  const changeLayout = (mode: ClassroomLayoutMode) => {
    setLayoutState((current) => ({
      ...current,
      mode,
      requestedPage: 0,
      presenterId: mode === "presentation" ? presenterID : null,
    }));
  };

  const effectsActive = hasActiveVisualEffects(visualEffects);
  const effectsName = t(visualEffectsSummaryKey(visualEffects));
  const effectsProblem =
    effectsActive &&
    (effectsStatus === "unsupported" ||
      effectsStatus === "failed" ||
      effectsStatus === "overloaded")
      ? effectsStatus
      : null;
  const effectsAvailable = canPublishCameraMicrophone && !controlsTerminated;
  const localCameraTrackRef = cameraTrackRefs.find(
    (trackRef) => trackRef.participant.isLocal && isTrackReference(trackRef),
  );

  const chooseEffects = (next: ClassroomVisualEffectsState) => {
    setEffectsChoice(next);
    saveVisualEffectsPreference(effectsScope, next);
  };

  useEffect(() => {
    onChatOpenChange?.(chatOpen);
  }, [chatOpen, onChatOpenChange]);

  /**
   * A closing inspector returns focus to its Dock key, unless another
   * inspector replaced it (that one moves focus into itself).
   */
  const restoreInspectorFocus = (event: Event, id: ClassroomInspectorID) => {
    event.preventDefault();
    if (inspectorRef.current !== null && inspectorRef.current !== id) return;
    const opener =
      id === "chat"
        ? chatReturnFocus.current
        : id === "roster"
          ? rosterReturnFocus.current
          : effectsReturnFocus.current;
    opener?.focus();
  };

  const toggleEffectsDrawer = (opener: HTMLElement) => {
    if (!effectsAvailable) return;
    effectsReturnFocus.current = opener;
    setEffectsOpen((open) => !open);
  };

  const rail = (
    <ParticipantRail
      attachedVideoItemIDs={attachedCameraVideoItemIDs}
      items={projection.items}
      mediaCues={tileMediaCues}
      onTogglePin={handleTogglePin}
      pinnedID={layoutState.pinnedParticipantId}
      tileSignals={tileSignals}
      toneSalt={toneSalt}
    />
  );
  const selfHand = signals?.projection?.raised_hands.find(
    ({ participant_key }) =>
      participant_key === signals.projection?.self_participant_key,
  );
  const participantCount =
    signals?.projection?.roster.length ?? cameraItems.length;
  // ROOM-PEOPLE-03: mic-off / speaking cues for the People rows, joined only
  // through the server-signed participant key (never shown, never logged).
  const peopleMediaStates = rosterOpen
    ? classroomPeopleMediaStates(
        liveKitParticipants,
        speakingParticipants,
        isMicrophoneEnabled,
      )
    : undefined;
  // While People is open its own waiting group and polite live region take
  // over, so the stage banner steps aside instead of announcing twice.
  const lobbyBannerActive = waitingCount > 0 && !rosterOpen;
  // ROOM-MEET-DOCK-04: each icon-only control's accessible name doubles as
  // its floating tooltip, so both always follow the control's live state.
  const microphoneLabel = t(
    isMicrophoneEnabled
      ? "media.p405.microphoneOn"
      : "media.p405.microphoneOff",
  );
  const cameraLabel = t(
    isCameraEnabled ? "media.p405.cameraOn" : "media.p405.cameraOff",
  );
  const screenShareLabel = t(
    isScreenShareEnabled ? "media.p405.shareStop" : "media.p405.shareStart",
  );
  const handLabel = t(
    selfHand ? "media.p406.lowerOwnHand" : "media.p406.raiseHand",
  );
  const rosterLabel =
    waitingCount > 0
      ? t("media.p406.openRosterWaiting", { count: waitingCount })
      : t("media.p406.openRoster");
  // ROOM-CHAT-01: bounded unread badge (1..99, 99+) while chat is closed.
  const unreadForBadge = Math.max(0, Math.floor(chatUnreadCount));
  const chatBadge =
    !chatOpen && unreadForBadge > 0
      ? chatUnreadCapped || unreadForBadge > 99
        ? "99+"
        : String(unreadForBadge)
      : null;
  const chatLabel = chatBadge
    ? t("media.chat.openWithUnread", { count: chatBadge })
    : t("media.p408.openChat");

  return (
    <ClassroomToolActionsContext.Provider value={toolActions}>
      <div
        aria-busy={connectionStatus === "connecting" || undefined}
        className={`media-p405-shell${
          inspector !== null && (inspector !== "effects" || effectsAvailable)
            ? " media-p405-shell--inspector-open"
            : ""
        }${
          effectsOpen && effectsAvailable
            ? " media-p405-shell--effects-open"
            : ""
        }`}
        data-inspector={inspector ?? undefined}
        data-pseudo-fullscreen={fullscreen.pseudo ? "true" : undefined}
        ref={shellRef}
      >
        {/*
        ROOM-COMPACT-05: one slim Top Bar across the room. Left: the live
        clock capsule, the polite presence status, the host Lock key and the
        lesson name. Right: the open tool's compact controls (portalled into
        the slot) and its Close key. Effects and End room live in the Dock.
      */}
        <header className="media-p405-header">
          <div className="media-p405-header-title">
            <span className="media-p405-live-pill">
              <span
                aria-hidden="true"
                className="media-p405-connection-dot"
                data-connection={connectionStatus}
              />
              <SessionClock
                live={
                  connectionStatus === "connected" ||
                  connectionStatus === "reconnecting"
                }
              />
            </span>
            <p aria-live="polite" className="media-p405-presence" role="status">
              <Users aria-hidden="true" className="media-p405-presence-icon" />
              <span className="media-p405-presence-full">
                {`${t(roomStatusKey(connectionStatus))} / ${t(
                  "media.room.participantCount",
                  { count: participantCount },
                )}`}
              </span>
              <span aria-hidden="true" className="media-p405-presence-short">
                {t("media.room.participantCountShort", {
                  count: participantCount,
                })}
              </span>
            </p>
            {moderation && (
              <ClassroomModerationControls
                controls={moderation}
                disabled={
                  controlsTerminated || connectionStatus !== "connected"
                }
              />
            )}
            {roomTitle ? (
              <>
                <span
                  aria-hidden="true"
                  className="media-p405-header-divider"
                />
                <h1 className="media-p405-room-title" title={roomTitle}>
                  {roomTitle}
                </h1>
              </>
            ) : (
              <h1 className="media-p405-sr-only">{t("media.room.title")}</h1>
            )}
          </div>
          <div className="media-p405-header-actions">
            {!canPublishCameraMicrophone && (
              <div className="media-p405-header-badges">
                <span>{t("media.room.listenOnly")}</span>
              </div>
            )}
            <div
              className="media-p405-header-tool-slot"
              ref={setHeaderSlotElement}
            />
            {/*
              ROOM-UI-POLISH-01: window keys on the right edge of the Top Bar,
              far from the Dock's red leave key. Full screen is always
              available in the room (and via Shift+F); Stage focus appears
              whenever a desktop tool stage is open. Both flip their action
              verb label, so WAI-ARIA APG omits aria-pressed in favour of
              data-active styling.
            */}
            {stageFocusAvailable && (
              <IconButton
                className="media-p405-header-window-key media-p405-header-stage-focus"
                data-active={stageFocusActive ? "true" : undefined}
                data-tooltip={t(
                  stageFocusActive
                    ? "media.p405.stageFocusOff"
                    : "media.p405.stageFocusOn",
                )}
                data-tooltip-side="bottom"
                label={t(
                  stageFocusActive
                    ? "media.p405.stageFocusOff"
                    : "media.p405.stageFocusOn",
                )}
                onClick={() => setStageFocus((value) => !value)}
                size="sm"
                variant="quiet"
              >
                {stageFocusActive ? <PanelRightOpen /> : <PanelRightClose />}
              </IconButton>
            )}
            <IconButton
              aria-keyshortcuts="Shift+F"
              className="media-p405-header-window-key media-p405-header-fullscreen"
              data-active={fullscreen.active ? "true" : undefined}
              data-tooltip={t(
                fullscreen.active
                  ? "media.p405.fullscreenExit"
                  : "media.p405.fullscreenEnter",
              )}
              data-tooltip-side="bottom"
              label={t(
                fullscreen.active
                  ? "media.p405.fullscreenExit"
                  : "media.p405.fullscreenEnter",
              )}
              onClick={fullscreen.toggle}
              size="sm"
              variant="quiet"
            >
              {fullscreen.active ? <Minimize2 /> : <Maximize2 />}
            </IconButton>
            {activeTool && (
              <IconButton
                className="media-p405-header-close"
                data-tooltip={t("media.p405.close")}
                data-tooltip-side="bottom"
                id={`media-p506-close-${activeTool.id}`}
                label={t("media.p405.close")}
                onClick={closeActiveTool}
                size="sm"
                variant="quiet"
              >
                <X />
              </IconButton>
            )}
          </div>
        </header>

        {lobby && (
          // Stays mounted (visually collapsed while idle) so the polite live
          // region announces new waiting requests without taking stage height.
          <div
            className={`media-p406-lobby-banner${
              lobbyBannerActive ? "" : " media-p406-lobby-banner--idle"
            }`}
          >
            <p
              aria-atomic="true"
              aria-live="polite"
              className="media-p406-lobby-banner__text"
              role="status"
            >
              {lobbyBannerActive
                ? t("media.p406.lobbyWaiting", { count: waitingCount })
                : ""}
            </p>
            {lobbyBannerActive && (
              <Button
                disabled={controlsTerminated}
                leadingIcon={<Users />}
                onClick={() => setRosterOpen(true)}
                size="sm"
                variant="primary"
              >
                {t("media.p406.viewWaitingRoom")}
              </Button>
            )}
          </div>
        )}

        {!canPublishCameraMicrophone && (
          <p className="media-p405-notice">
            {t("media.p405.listenOnlyDescription")}
          </p>
        )}
        {!canSubscribe && (
          <p className="media-p405-notice" role="status">
            {t("media.p405.subscribeRestricted")}
          </p>
        )}
        {degradationStage !== "normal" && (
          <p
            aria-atomic="true"
            aria-live="polite"
            className="media-p405-notice media-p405-degradation-status"
            role="status"
          >
            {t(degradationStatusKey(degradationStage))}
          </p>
        )}
        {signals?.loading && (
          <p
            className="media-p405-notice media-p405-notice--sync"
            role="status"
          >
            {t("media.p406.loading")}
          </p>
        )}
        {signals?.error && (
          <div className="media-p405-error" role="alert">
            <span>{t("media.p406.loadError")}</span>
            <Button
              onClick={() => void signals.onResync()}
              size="sm"
              variant="quiet"
            >
              {t("media.p406.retry")}
            </Button>
          </div>
        )}
        <p
          aria-atomic="true"
          aria-live="polite"
          className="media-p406-status"
          role="status"
        >
          {signalFeedback ? t(signalFeedback) : ""}
          {selfHand
            ? ` ${t("media.p406.ownHandPosition", {
                position: selfHand.queue_position,
              })}`
            : ""}
        </p>
        <p
          aria-atomic="true"
          aria-live="polite"
          className="media-p406-sr-reactions"
          role="status"
        >
          {reactionTotal > 0 ? reactionAnnouncement : ""}
        </p>
        <p
          aria-atomic="true"
          aria-live="polite"
          className="visually-hidden"
          role="status"
        >
          {activeTool && autoOpenedToolID === activeTool.id
            ? t("media.p506.toolAutoOpened", { title: activeTool.title })
            : ""}
        </p>
        {mediaError && (
          <div className="media-p405-error" role="alert">
            <span>{t("media.p405.deviceUpdateError")}</span>
            <Button
              onClick={() => setMediaError(false)}
              size="sm"
              variant="quiet"
            >
              {t("media.room.dismiss")}
            </Button>
          </div>
        )}

        <div
          className={`media-p405-classroom media-p405-classroom--${projection.mode}${
            activeTool ? " media-p405-classroom--tool-stage" : ""
          }${stageFocusActive ? " media-p405-classroom--stage-focus" : ""}`}
        >
          {/*
          The tool stage occupies its own conditional slot ahead of the media
          stage, so opening/closing it never remounts the camera grid; CSS
          turns the media stage into the side camera strip.
        */}
          {activeTool && (
            <section
              aria-labelledby={`media-p506-stage-title-${activeTool.id}`}
              className={`media-p506-tool-stage media-p506-tool-${activeTool.id}`}
              id={`media-p506-stage-${activeTool.id}`}
            >
              {/*
              ROOM-COMPACT-05: no titlebar — the paper fills the card edge to
              edge. The heading stays for aria-labelledby and receives focus
              when the stage opens; Close sits in the Top Bar.
            */}
              <h2
                className="media-p405-sr-only"
                id={`media-p506-stage-title-${activeTool.id}`}
                tabIndex={-1}
              >
                {activeTool.title}
              </h2>
              <div className="media-p506-tool-stage__body">
                <ClassroomHeaderSlotContext.Provider value={headerSlot}>
                  {activeTool.content}
                </ClassroomHeaderSlotContext.Provider>
              </div>
            </section>
          )}
          {/*
          ROOM-STAGE-POLISH-04: Meet / Zoom style floating reactions. At most
          three server clusters (ADR-0031 §9) each fly up one lane above the
          Dock; a newer event in the same cluster remounts it (key) so it
          flies again. Reduced motion / forced colours keep static pills.
        */}
          {signals?.projection && (
            <div aria-hidden="true" className="media-p406-reactions">
              {signals.projection.reactions.clusters.map((cluster, lane) => (
                <FloatingReaction
                  cluster={cluster}
                  key={`${cluster.cluster_id}:${cluster.last_signal_sequence}`}
                  lane={lane}
                />
              ))}
            </div>
          )}
          <section
            aria-label={
              projection.mode === "grid"
                ? t("media.p405.gridLabel")
                : t("media.p405.stageLabel")
            }
            className="media-p405-stage"
          >
            {projection.mode === "grid" ? (
              projection.items.length > 0 ? (
                <ul
                  className={`media-p405-grid media-p405-grid--capacity-${projection.capacity}`}
                  data-tile-count={projection.items.length}
                >
                  {projection.items.map((item) => (
                    <li key={item.id}>
                      <MediaTile
                        attachVideo={attachedCameraVideoItemIDs.has(item.id)}
                        item={item}
                        mediaCues={tileMediaCues}
                        onTogglePin={handleTogglePin}
                        pinned={layoutState.pinnedParticipantId === item.id}
                        signal={tileSignals.get(item.id)}
                        tone={mediaTileTone(item.sequence, toneSalt)}
                        variant="grid"
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="media-p405-empty">
                  {t("media.p405.noParticipants")}
                </p>
              )
            ) : stageItem && stageTrackRef ? (
              <MediaTile
                attachVideo={
                  projection.stage?.kind === "presentation"
                    ? attachPresentationVideo
                    : attachedCameraVideoItemIDs.has(stageItem.id)
                }
                item={stageItem}
                mediaCues={tileMediaCues}
                onTogglePin={handleTogglePin}
                pinned={layoutState.pinnedParticipantId === stageItem.id}
                signal={tileSignals.get(stageItem.id)}
                tone={mediaTileTone(stageItem.sequence, toneSalt)}
                trackRef={stageTrackRef}
                variant="stage"
              />
            ) : (
              <p className="media-p405-empty">
                {t("media.p405.noParticipants")}
              </p>
            )}
          </section>

          {!isResponsiveDrawer && projection.mode !== "grid" && (
            <aside
              aria-label={t("media.p405.railLabel")}
              className="media-p405-rail"
            >
              {rail}
            </aside>
          )}
        </div>

        <div
          aria-label={t("media.p405.pagination")}
          className={`media-p405-pagination${
            projection.pageCount <= 1 ? " media-p405-pagination--single" : ""
          }`}
          id="media-p405-pagination"
          role="group"
          tabIndex={-1}
        >
          <IconButton
            disabled={projection.page <= 0}
            label={t("media.p405.previousPage")}
            onClick={() =>
              setLayoutState((current) => ({
                ...current,
                requestedPage: Math.max(0, projection.page - 1),
              }))
            }
            size="sm"
          >
            <ChevronLeft />
          </IconButton>
          <span aria-live="polite">
            {t("media.p405.page", {
              page: projection.page + 1,
              pages: projection.pageCount,
            })}
          </span>
          <IconButton
            disabled={projection.page >= projection.pageCount - 1}
            label={t("media.p405.nextPage")}
            onClick={() =>
              setLayoutState((current) => ({
                ...current,
                requestedPage: Math.min(
                  projection.pageCount - 1,
                  projection.page + 1,
                ),
              }))
            }
            size="sm"
          >
            <ChevronRight />
          </IconButton>
        </div>

        {isResponsiveDrawer && projection.mode !== "grid" && (
          <Drawer onOpenChange={setRailOpen} open={railOpen}>
            <DrawerTrigger asChild>
              <Button leadingIcon={<Users />} variant="secondary">
                {t("media.p405.openParticipants")}
              </Button>
            </DrawerTrigger>
            <DrawerContent
              className="media-p405-drawer"
              closeLabel={t("media.p405.close")}
              data-theme="dark"
            >
              <DrawerTitle>{t("media.p405.railLabel")}</DrawerTitle>
              {rail}
              <DrawerClose asChild>
                <Button variant="secondary">{t("media.p405.close")}</Button>
              </DrawerClose>
            </DrawerContent>
          </Drawer>
        )}

        <footer className="media-p405-footer">
          <div
            aria-label={t("media.p405.toolbar")}
            className="media-p405-toolbar"
            onKeyDown={handleToolbarKeyDown}
            ref={toolbarRef}
            role="toolbar"
          >
            {canPublishCameraMicrophone && (
              <>
                <IconButton
                  className="media-p405-dock-button media-p405-dock-button--av"
                  data-media-control="microphone"
                  data-tooltip={microphoneLabel}
                  disabled={pendingControl !== null || controlsTerminated}
                  id="media-p405-control-microphone"
                  label={microphoneLabel}
                  loading={pendingControl === "microphone"}
                  onClick={() =>
                    void runControl("microphone", () =>
                      localParticipant.setMicrophoneEnabled(
                        !isMicrophoneEnabled,
                      ),
                    )
                  }
                  onFocus={() => setToolbarFocusKey("microphone")}
                  tabIndex={toolbarTabIndex("microphone")}
                  variant={isMicrophoneEnabled ? "secondary" : "danger"}
                >
                  <DockIcon icon={isMicrophoneEnabled ? <Mic /> : <MicOff />} />
                </IconButton>
                <IconButton
                  className="media-p405-dock-button media-p405-dock-button--av"
                  data-media-control="camera"
                  data-tooltip={cameraLabel}
                  disabled={
                    pendingControl !== null ||
                    controlsTerminated ||
                    degradationStage === "audio-only"
                  }
                  id="media-p405-control-camera"
                  label={cameraLabel}
                  loading={pendingControl === "camera"}
                  onClick={() =>
                    void runControl("camera", () =>
                      localParticipant.setCameraEnabled(!isCameraEnabled),
                    )
                  }
                  onFocus={() => setToolbarFocusKey("camera")}
                  tabIndex={toolbarTabIndex("camera")}
                  variant={isCameraEnabled ? "secondary" : "danger"}
                >
                  <DockIcon
                    icon={isCameraEnabled ? <Camera /> : <CameraOff />}
                  />
                </IconButton>
              </>
            )}
            {canShareScreen && (
              <IconButton
                className="media-p405-dock-button"
                data-media-control="screen-share"
                data-tooltip={screenShareLabel}
                disabled={pendingControl !== null || controlsTerminated}
                id="media-p405-control-screen-share"
                label={screenShareLabel}
                loading={pendingControl === "screen-share"}
                onClick={() =>
                  void runControl("screen-share", () =>
                    localParticipant.setScreenShareEnabled(
                      !isScreenShareEnabled,
                    ),
                  )
                }
                onFocus={() => setToolbarFocusKey("screen-share")}
                tabIndex={toolbarTabIndex("screen-share")}
                variant={isScreenShareEnabled ? "danger" : "secondary"}
              >
                <DockIcon
                  icon={
                    isScreenShareEnabled ? <ScreenShareOff /> : <ScreenShare />
                  }
                />
              </IconButton>
            )}
            <IconButton
              aria-expanded={devicePanelOpen}
              className="media-p405-dock-button"
              data-media-control="devices"
              data-tooltip={t("media.p405.devices")}
              disabled={controlsTerminated}
              id="media-p405-control-devices"
              label={t("media.p405.devices")}
              onClick={() => setDevicePanelOpen((open) => !open)}
              onFocus={() => setToolbarFocusKey("devices")}
              tabIndex={toolbarTabIndex("devices")}
              variant="secondary"
            >
              <DockIcon icon={<Settings2 />} />
            </IconButton>

            {canPublishCameraMicrophone && (
              <IconButton
                aria-describedby={
                  effectsActive ? effectsDescriptionID : undefined
                }
                aria-expanded={effectsOpen && effectsAvailable}
                aria-haspopup="dialog"
                className="media-p405-dock-button"
                data-media-control="effects"
                data-tooltip={t("media.fx.openEffects")}
                disabled={controlsTerminated}
                id="media-p405-control-effects"
                label={t("media.fx.openEffects")}
                onClick={(event) => toggleEffectsDrawer(event.currentTarget)}
                onFocus={() => setToolbarFocusKey("effects")}
                tabIndex={toolbarTabIndex("effects")}
                variant={effectsActive ? "primary" : "secondary"}
              >
                <DockIcon icon={<Sparkles />} />
              </IconButton>
            )}
            {canPublishCameraMicrophone && effectsActive && (
              <span className="visually-hidden" id={effectsDescriptionID}>
                {t("media.fx.activeDescription", { name: effectsName })}
              </span>
            )}

            {signals?.projection?.viewer_operations.can_raise_hand && (
              <IconButton
                aria-pressed={Boolean(selfHand)}
                className="media-p405-dock-button"
                data-media-control="hand"
                data-tooltip={handLabel}
                disabled={
                  signals.mutating || signals.loading || controlsTerminated
                }
                id="media-p406-control-hand"
                label={handLabel}
                loading={signals.mutating}
                onClick={() =>
                  void runSignalAction(
                    signals.onToggleHand,
                    selfHand
                      ? "media.p406.loweredOwnHand"
                      : "media.p406.raisedHand",
                  )
                }
                onFocus={() => setToolbarFocusKey("hand")}
                tabIndex={toolbarTabIndex("hand")}
                variant={selfHand ? "primary" : "secondary"}
              >
                <DockIcon icon={<Hand />} />
              </IconButton>
            )}

            {signals?.projection?.viewer_operations.can_send_reaction && (
              <Menu modal={false}>
                <MenuTrigger asChild>
                  <IconButton
                    className="media-p405-dock-button"
                    data-media-control="reaction"
                    data-tooltip={t("media.p406.reactions")}
                    disabled={signals.mutating || controlsTerminated}
                    id="media-p406-control-reaction"
                    label={t("media.p406.reactions")}
                    onFocus={() => setToolbarFocusKey("reaction")}
                    tabIndex={toolbarTabIndex("reaction")}
                    variant="secondary"
                  >
                    <DockIcon icon={<Smile />} />
                  </IconButton>
                </MenuTrigger>
                <MenuContent
                  aria-label={t("media.p406.reactionMenu")}
                  className="media-p406-reaction-menu"
                  data-theme="dark"
                >
                  {CLASSROOM_REACTION_TYPES.map((reaction) => (
                    <MenuItem
                      key={reaction}
                      onSelect={() =>
                        void runSignalAction(
                          () => signals.onSendReaction(reaction),
                          "media.p406.reactionSent",
                        )
                      }
                    >
                      <span aria-hidden="true">{reactionGlyph(reaction)}</span>
                      {t(reactionLabelKey(reaction))}
                    </MenuItem>
                  ))}
                </MenuContent>
              </Menu>
            )}

            {chat && (
              <Drawer modal={false} onOpenChange={setChatOpen} open={chatOpen}>
                <DrawerTrigger asChild>
                  <IconButton
                    aria-expanded={chatOpen}
                    className="media-p405-dock-button media-p408-chat-control"
                    data-media-control="chat"
                    data-tooltip={chatLabel}
                    id="media-p408-control-chat"
                    label={chatLabel}
                    onFocus={() => setToolbarFocusKey("chat")}
                    ref={chatReturnFocus}
                    tabIndex={toolbarTabIndex("chat")}
                    variant={chatOpen ? "primary" : "secondary"}
                  >
                    <DockIcon icon={<MessageCircle />} />
                    {chatBadge && (
                      <span
                        aria-hidden="true"
                        className="media-p408-chat-badge"
                        data-testid="media-p408-chat-badge"
                      >
                        {chatBadge}
                      </span>
                    )}
                  </IconButton>
                </DrawerTrigger>
                <DrawerContent
                  aria-describedby={`${chatDescriptionID}`}
                  className="media-p408-chat-drawer"
                  closeLabel={t("media.p405.close")}
                  data-theme="dark"
                  onCloseAutoFocus={(event) =>
                    restoreInspectorFocus(event, "chat")
                  }
                  onEscapeKeyDown={(event) => {
                    // The emoji popover and inline edit own their Escape, and
                    // so do the tools popover and the Code tool.
                    const target = event.target;
                    if (
                      escapeBelongsToToolSurface(target) ||
                      (target instanceof Element &&
                        target.closest(
                          ".classroom-chat-emoji__popover, .classroom-chat__edit",
                        )) ||
                      document.querySelector(
                        ".media-p408-chat-drawer .classroom-chat-emoji__popover",
                      )
                    ) {
                      event.preventDefault();
                    }
                  }}
                  onInteractOutside={(event) => event.preventDefault()}
                >
                  <header className="media-p408-chat-drawer__header">
                    <DrawerTitle className="media-p408-chat-drawer__title">
                      {t("media.p408.title")}
                    </DrawerTitle>
                    <DrawerDescription
                      className="media-p408-chat-drawer__subtitle"
                      id={chatDescriptionID}
                    >
                      {t("media.chat.subtitle")}
                    </DrawerDescription>
                  </header>
                  {chat}
                </DrawerContent>
              </Drawer>
            )}

            {/*
            ROOM-TOOLS-CODE-01 / ADR-0043 §1: one Classroom tools key instead
            of a key per tool. It shows the open stage tool's icon (sapphire)
            or the tools grid, and opens a non-modal popover grid right after
            itself in the Tab order; tiles never carry `data-media-control`,
            so the Dock's own arrow-key roving skips them.
          */}
            {tools.length > 0 && (
              <>
                <IconButton
                  aria-controls={toolsPopoverOpen ? toolsPopoverID : undefined}
                  aria-describedby={activeTool ? toolsDescriptionID : undefined}
                  aria-expanded={toolsPopoverOpen}
                  aria-haspopup="dialog"
                  className="media-p405-dock-button media-p506-tools-trigger"
                  data-active-tool={activeTool?.id}
                  data-media-control="tools"
                  data-tooltip={t("classroomTools.trigger")}
                  id={TOOLS_CONTROL_ID}
                  label={t("classroomTools.trigger")}
                  onClick={() => setToolsPopoverOpen((open) => !open)}
                  onFocus={() => setToolbarFocusKey("tools")}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && toolsPopoverOpen) {
                      event.preventDefault();
                      event.stopPropagation();
                      setToolsPopoverOpen(false);
                    }
                  }}
                  ref={toolsTriggerRef}
                  tabIndex={toolbarTabIndex("tools")}
                  variant={activeTool ? "primary" : "secondary"}
                >
                  <DockIcon
                    icon={activeTool ? activeTool.icon : <LayoutGrid />}
                  />
                  {activeTool && (
                    <span
                      aria-hidden="true"
                      className="media-p506-tools-trigger__dot"
                    />
                  )}
                </IconButton>
                {activeTool && (
                  <span className="visually-hidden" id={toolsDescriptionID}>
                    {t("classroomTools.triggerActive", {
                      tool: activeTool.label,
                    })}
                  </span>
                )}
                {toolsPopoverOpen && (
                  <ClassroomToolsPopover
                    anchorRef={toolsTriggerRef}
                    id={toolsPopoverID}
                    onClose={closeToolsPopover}
                    onSelect={selectTool}
                    openToolID={activeTool?.id ?? null}
                    tools={tools}
                  />
                )}
              </>
            )}

            {/*
            ROOM-COMPACT-05: one round layout key opens a small menu (Grid,
            Active speaker, Presentation) instead of a three-key groove.
          */}
            <Menu modal={false}>
              <MenuTrigger asChild>
                <IconButton
                  className="media-p405-dock-button media-p405-layout-trigger"
                  data-media-control="layout"
                  data-tooltip={t("media.p405.layoutMenu")}
                  id={LAYOUT_CONTROL_ID}
                  label={t("media.p405.layoutMenu")}
                  onFocus={() => setToolbarFocusKey("layout")}
                  tabIndex={toolbarTabIndex("layout")}
                  variant="secondary"
                >
                  <DockIcon icon={<Grid2X2 />} />
                </IconButton>
              </MenuTrigger>
              <MenuContent
                aria-label={t("media.p405.layoutGroup")}
                className="media-p405-layout-menu"
                data-theme="dark"
                side="top"
                sideOffset={10}
              >
                <MenuRadioGroup
                  onValueChange={(value) => {
                    if (isClassroomLayoutMode(value)) changeLayout(value);
                  }}
                  value={projection.mode}
                >
                  {layoutModes.map((mode) => (
                    <MenuRadioItem
                      className="media-p405-layout-option"
                      disabled={mode === "presentation" && !presenterID}
                      id={`media-p405-layout-${mode}`}
                      key={mode}
                      value={mode}
                    >
                      <span
                        aria-hidden="true"
                        className="media-p405-layout-option__icon"
                      >
                        {mode === "grid" ? (
                          <Grid2X2 />
                        ) : mode === "active-speaker" ? (
                          <UserRound />
                        ) : (
                          <Presentation />
                        )}
                      </span>
                      <span className="media-p405-layout-option__label">
                        {t(layoutModeKey(mode))}
                      </span>
                      <Check
                        aria-hidden="true"
                        className="media-p405-layout-option__check"
                      />
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuContent>
            </Menu>

            {(signals || lobby) && (
              <Drawer
                modal={false}
                onOpenChange={setRosterOpen}
                open={rosterOpen}
              >
                <DrawerTrigger asChild>
                  <IconButton
                    aria-expanded={rosterOpen}
                    className="media-p405-dock-button media-p406-roster-control"
                    data-media-control="roster"
                    data-tooltip={rosterLabel}
                    disabled={controlsTerminated}
                    id="media-p406-control-roster"
                    label={rosterLabel}
                    onFocus={() => setToolbarFocusKey("roster")}
                    ref={rosterReturnFocus}
                    tabIndex={toolbarTabIndex("roster")}
                    variant={waitingCount > 0 ? "primary" : "secondary"}
                  >
                    <DockIcon icon={<Users />} />
                    {waitingCount > 0 && (
                      <span className="media-p406-roster-badge">
                        {waitingCount > 99 ? "99+" : waitingCount}
                      </span>
                    )}
                  </IconButton>
                </DrawerTrigger>
                {/*
                ROOM-PEOPLE-03: slim "People (N)" header + ✕ (no footer Close
                key), then the People panel: search, waiting group, in-class
                groups and the pinned host footer.
              */}
                <DrawerContent
                  aria-describedby={undefined}
                  className="media-p406-roster-drawer"
                  closeLabel={t("media.p405.close")}
                  data-theme="dark"
                  onCloseAutoFocus={(event) =>
                    restoreInspectorFocus(event, "roster")
                  }
                  onEscapeKeyDown={(event) => {
                    // Escape in a filled search box clears it, not the drawer.
                    const target = event.target;
                    if (
                      escapeBelongsToToolSurface(target) ||
                      (target instanceof HTMLInputElement &&
                        target.type === "search" &&
                        target.value !== "")
                    ) {
                      event.preventDefault();
                    }
                  }}
                  onInteractOutside={(event) => event.preventDefault()}
                >
                  <header className="media-p406-roster-drawer__header">
                    <DrawerTitle className="media-p406-roster-drawer__title">
                      {signals?.projection
                        ? t("media.people.title", {
                            count: signals.projection.roster.length,
                          })
                        : t("media.people.titlePlain")}
                    </DrawerTitle>
                  </header>
                  <ClassroomPeoplePanel
                    lobby={lobby}
                    mediaStates={peopleMediaStates}
                    moderation={moderation}
                    moderationDisabled={
                      controlsTerminated || connectionStatus !== "connected"
                    }
                    onLowerAll={() => {
                      if (!signals) return;
                      void runSignalAction(
                        signals.onLowerAllHands,
                        "media.p406.loweredAllHands",
                      );
                    }}
                    onLowerHand={(participantKey) => {
                      if (!signals) return;
                      void runSignalAction(
                        () => signals.onLowerHand(participantKey),
                        "media.p406.loweredHand",
                      );
                    }}
                    signals={signals}
                  />
                </DrawerContent>
              </Drawer>
            )}
          </div>

          <DockDivider />
          <LeaveRoomControl
            moderation={controlsTerminated ? undefined : moderation}
            moderationDisabled={
              controlsTerminated || connectionStatus !== "connected"
            }
            onLeave={handleLeave}
          />

          {/*
          Anchored to the Dock (not the shell) so the device popover stays
          centred above it whatever its height or a side drawer's width.
          Rendered after Leave, so the Tab order is unchanged.
        */}
          {devicePanelOpen && !controlsTerminated && (
            <DevicePanel
              canPublish={canPublishCameraMicrophone}
              onChange={(name, action) =>
                void runControl(name, () => Promise.resolve(action()))
              }
              onDeviceError={handleDeviceError}
            />
          )}
        </footer>

        {canPublishCameraMicrophone && (
          // Non-modal side panel (Teams-style): no overlay, the whiteboard and
          // camera grid stay interactive, and wide rooms reserve its width so
          // it never covers the stage. Closing returns focus to its opener.
          <Drawer
            modal={false}
            onOpenChange={setEffectsOpen}
            open={effectsOpen && effectsAvailable}
          >
            <DrawerContent
              aria-describedby={`${effectsDescriptionID}-drawer`}
              className="media-p405-effects-drawer"
              closeLabel={t("media.p405.close")}
              data-theme="dark"
              onCloseAutoFocus={(event) =>
                restoreInspectorFocus(event, "effects")
              }
              onEscapeKeyDown={(event) => {
                if (escapeBelongsToToolSurface(event.target)) {
                  event.preventDefault();
                }
              }}
              onInteractOutside={(event) => event.preventDefault()}
            >
              <DrawerTitle className="media-p405-effects-drawer__title">
                {t("media.fx.title")}
              </DrawerTitle>
              <DrawerDescription
                className="media-p405-effects-drawer__description"
                id={`${effectsDescriptionID}-drawer`}
              >
                {t("media.fx.drawerDescription")}
              </DrawerDescription>
              <div className="media-p405-effects-drawer__preview">
                {isCameraEnabled &&
                localCameraTrackRef &&
                isTrackReference(localCameraTrackRef) ? (
                  <VideoTrack
                    aria-label={t("media.fx.selfPreview")}
                    className="media-p405-video--mirror"
                    manageSubscription={false}
                    trackRef={localCameraTrackRef}
                  />
                ) : (
                  <p>{t("media.fx.drawerCameraOff")}</p>
                )}
                {isCameraEnabled && effectsStatus === "loading" && (
                  <span className="media-p405-effects-drawer__badge">
                    {t("media.fx.status.loading")}
                  </span>
                )}
              </div>
              <p
                aria-live="polite"
                className="media-p405-effects-drawer__status"
                role="status"
              >
                {effectsProblem ? t(`media.fx.status.${effectsProblem}`) : ""}
              </p>
              <VisualEffectsPicker
                disabled={controlsTerminated}
                library={backgroundLibrary}
                onChange={chooseEffects}
                surface="drawer"
                value={visualEffects}
              />
            </DrawerContent>
          </Drawer>
        )}
        <RoomTooltipLayer containerRef={shellRef} />
      </div>
    </ClassroomToolActionsContext.Provider>
  );
}

/**
 * ROOM-MEET-DOCK-04 Dock content: the icon only (Google Meet). The button's
 * accessible label names it and the room tooltip shows that same label on
 * hover or keyboard focus, so no caption text sits under the icon.
 */
function DockIcon({ icon }: { icon: ReactNode }) {
  return <span className="media-p405-dock-icon">{icon}</span>;
}

/*
 * ROOM-UI-POLISH-01 — Zoom / Teams / Meet style full screen. Only the
 * document element ever goes full screen, so every Radix portal on
 * `document.body` (menus, dialogs, drawers, tooltips) stays inside the
 * full-screen tree and React never remounts LiveKit or a <video>.
 */
interface FullscreenCapableDocument extends Document {
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
}

interface FullscreenCapableElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

function currentFullscreenElement(
  doc: FullscreenCapableDocument,
): Element | null {
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

function standardFullscreenAvailable(doc: FullscreenCapableDocument) {
  return (
    doc.fullscreenEnabled === true &&
    typeof doc.documentElement.requestFullscreen === "function"
  );
}

function webkitFullscreenAvailable(doc: FullscreenCapableDocument) {
  return (
    doc.webkitFullscreenEnabled === true &&
    typeof (doc.documentElement as FullscreenCapableElement)
      .webkitRequestFullscreen === "function"
  );
}

function requestDocumentFullscreen(
  doc: FullscreenCapableDocument,
): Promise<void> {
  try {
    if (standardFullscreenAvailable(doc)) {
      return Promise.resolve(
        doc.documentElement.requestFullscreen({ navigationUI: "hide" }),
      );
    }
    const root = doc.documentElement as FullscreenCapableElement;
    return Promise.resolve(root.webkitRequestFullscreen?.());
  } catch (error) {
    return Promise.reject(error);
  }
}

function exitDocumentFullscreen(doc: FullscreenCapableDocument): Promise<void> {
  try {
    if (doc.fullscreenElement && typeof doc.exitFullscreen === "function") {
      return Promise.resolve(doc.exitFullscreen());
    }
    if (
      doc.webkitFullscreenElement &&
      typeof doc.webkitExitFullscreen === "function"
    ) {
      return Promise.resolve(doc.webkitExitFullscreen());
    }
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  }
}

/** Typing, modal dialogs and open menus keep their own keys. */
const ROOM_SHORTCUT_IGNORED_TARGETS = [
  "input",
  "textarea",
  "select",
  '[contenteditable]:not([contenteditable="false"])',
  ".cm-editor",
  '[role="dialog"][aria-modal="true"]',
  '[role="alertdialog"]',
  ".th-dialog-content",
  '[role="menu"]',
  '[role="listbox"]',
].join(", ");

function isRoomShortcutIgnoredTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return target.closest(ROOM_SHORTCUT_IGNORED_TARGETS) !== null;
}

/** `Shift+F` without Ctrl / ⌘ / Alt, never while typing or in a modal. */
function isRoomFullscreenShortcut(event: globalThis.KeyboardEvent): boolean {
  if (event.key !== "F" && event.key !== "f") return false;
  if (!event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
    return false;
  }
  if (event.repeat || event.isComposing || event.defaultPrevented) {
    return false;
  }
  return !isRoomShortcutIgnoredTarget(event.target);
}

/**
 * Native full screen when the browser allows it; otherwise (an iPad web
 * view, a rejected request) a "pseudo" full screen that pins the room shell
 * over the viewport. Leaving the room undoes only what the room turned on.
 */
function useRoomFullscreen() {
  const [nativeActive, setNativeActive] = useState(
    () =>
      typeof document !== "undefined" &&
      currentFullscreenElement(document) !== null,
  );
  const [pseudoActive, setPseudoActive] = useState(false);
  const ownsNative = useRef(false);

  useEffect(() => {
    const doc: FullscreenCapableDocument = document;
    const sync = () => {
      const active = currentFullscreenElement(doc) !== null;
      if (!active) ownsNative.current = false;
      setNativeActive(active);
    };
    doc.addEventListener("fullscreenchange", sync);
    doc.addEventListener("webkitfullscreenchange", sync);
    return () => {
      doc.removeEventListener("fullscreenchange", sync);
      doc.removeEventListener("webkitfullscreenchange", sync);
      if (
        ownsNative.current &&
        currentFullscreenElement(doc) === doc.documentElement
      ) {
        ownsNative.current = false;
        void exitDocumentFullscreen(doc).catch(() => undefined);
      }
    };
  }, []);

  const toggle = useCallback(() => {
    const doc: FullscreenCapableDocument = document;
    if (pseudoActive) {
      setPseudoActive(false);
      return;
    }
    if (currentFullscreenElement(doc) !== null) {
      void exitDocumentFullscreen(doc).catch(() => undefined);
      return;
    }
    if (!standardFullscreenAvailable(doc) && !webkitFullscreenAvailable(doc)) {
      setPseudoActive(true);
      return;
    }
    ownsNative.current = true;
    requestDocumentFullscreen(doc).catch(() => {
      ownsNative.current = false;
      setPseudoActive(true);
    });
  }, [pseudoActive]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (isRoomFullscreenShortcut(event)) {
        event.preventDefault();
        toggle();
        return;
      }
      if (
        pseudoActive &&
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !isRoomShortcutIgnoredTarget(event.target)
      ) {
        setPseudoActive(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [pseudoActive, toggle]);

  return {
    active: nativeActive || pseudoActive,
    pseudo: pseudoActive,
    toggle,
  };
}

/** Elements that show the room tooltip (see `RoomTooltipLayer`). */
const ROOM_TOOLTIP_TARGET = "[data-tooltip], .whiteboard-paper-trigger";
/** Regions that act as app bars: their tooltips hang below the control. */
const ROOM_TOOLTIP_BOTTOM_REGIONS =
  ".media-p405-header, .whiteboard-tool-header, .whiteboard-engine-bar";
const ROOM_TOOLTIP_HOVER_DELAY_MS = 140;
const ROOM_TOOLTIP_WARM_WINDOW_MS = 400;
const ROOM_TOOLTIP_EDGE_PX = 8;
const ROOM_TOOLTIP_GAP_ABOVE_PX = 10;
const ROOM_TOOLTIP_GAP_BELOW_PX = 8;
const ROOM_TOOLTIP_TOP_ZONE_PX = 48;

type RoomTooltipSide = "top" | "bottom";

interface RoomTooltipState {
  readonly side: RoomTooltipSide;
  readonly target: HTMLElement;
  readonly text: string;
  /** Shown by a warm hand-off or keyboard focus: no entrance motion. */
  readonly instant: boolean;
}

function roomTooltipTarget(
  node: EventTarget | null,
  container: HTMLElement,
): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const target = node.closest<HTMLElement>(ROOM_TOOLTIP_TARGET);
  return target && container.contains(target) ? target : null;
}

function roomTooltipText(target: HTMLElement): string {
  const explicit = target.dataset.tooltip?.trim();
  if (explicit) return explicit;
  // The whiteboard paper picker names itself in its own label span (which the
  // room stylesheet hides visually), so its tooltip reads that live label.
  return (
    target
      .querySelector(".whiteboard-paper-trigger-label")
      ?.textContent?.trim() ?? ""
  );
}

/**
 * A tooltip never covers a popover, menu, drawer or disclosure its control
 * has opened (WCAG 1.4.13): an expanded control is silent unless it opts in
 * because what it expands lives elsewhere (`data-tooltip-expanded="show"`).
 */
function roomTooltipSuppressed(target: HTMLElement): boolean {
  if (!target.isConnected) return true;
  const expanded =
    target.getAttribute("aria-expanded") === "true" ||
    target.dataset.state === "open";
  if (expanded && target.dataset.tooltipExpanded !== "show") return true;
  const disclosure = target.parentElement;
  if (
    target.tagName === "SUMMARY" &&
    disclosure instanceof HTMLDetailsElement &&
    disclosure.open
  ) {
    return true;
  }
  return roomTooltipText(target) === "";
}

function roomTooltipSide(target: HTMLElement): RoomTooltipSide {
  const declared = target.dataset.tooltipSide;
  if (declared === "top" || declared === "bottom") return declared;
  if (target.closest(ROOM_TOOLTIP_BOTTOM_REGIONS)) return "bottom";
  return target.getBoundingClientRect().top < ROOM_TOOLTIP_TOP_ZONE_PX
    ? "bottom"
    : "top";
}

/**
 * Keyboard focus shows the tooltip; a click's focus does not. Engines that do
 * not resolve `:focus-visible` for a focus move fall back to the modality the
 * layer tracks itself (the last input was a key, not a pointer press).
 */
function roomTooltipFocusVisible(
  target: HTMLElement,
  keyboardModality: boolean,
): boolean {
  try {
    if (target.matches(":focus-visible")) return true;
  } catch {
    // An engine without `:focus-visible` uses the tracked modality.
  }
  return keyboardModality;
}

/**
 * ROOM-MEET-DOCK-04 — one floating tooltip for every icon-only room control
 * (Google Meet timing, Material plain-tooltip shape). Controls only carry
 * `data-tooltip` (and optionally `data-tooltip-side`); this layer listens by
 * delegation on the shell, so no Radix trigger is wrapped, no ref or roving
 * tabindex changes, and screen readers keep the control's own name (the
 * tooltip is `aria-hidden` and duplicates that name).
 *
 * Timing: a first mouse hover waits 140ms so a sweep across the Dock stays
 * quiet; within 400ms of a tooltip closing the next one moves over at once;
 * keyboard focus (`:focus-visible`) shows it at once; touch never shows it.
 * It hides on Escape (focus stays), on any press, on scroll or resize, and
 * as soon as its control opens a popover, menu or drawer.
 */
export function RoomTooltipLayer({
  containerRef,
}: {
  containerRef: RefObject<HTMLElement | null>;
}) {
  const [tooltip, setTooltip] = useState<RoomTooltipState | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const ownerDocument = container.ownerDocument;
    const view = ownerDocument.defaultView ?? window;
    let shown: HTMLElement | null = null;
    let pending: HTMLElement | null = null;
    let timer: number | null = null;
    let dismissed: HTMLElement | null = null;
    let lastHiddenAt = Number.NEGATIVE_INFINITY;
    let keyboardModality = false;
    let observer: MutationObserver | null = null;

    const clearPending = () => {
      if (timer !== null) view.clearTimeout(timer);
      timer = null;
      pending = null;
    };
    const warm = () =>
      shown !== null ||
      Date.now() - lastHiddenAt <= ROOM_TOOLTIP_WARM_WINDOW_MS;
    const hide = (warm: boolean) => {
      clearPending();
      observer?.disconnect();
      observer = null;
      if (!shown) return;
      shown = null;
      if (warm) lastHiddenAt = Date.now();
      setTooltip(null);
    };
    const show = (target: HTMLElement, instant: boolean) => {
      clearPending();
      if (roomTooltipSuppressed(target)) {
        if (shown === target) hide(false);
        return;
      }
      observer?.disconnect();
      shown = target;
      setTooltip({
        instant,
        side: roomTooltipSide(target),
        target,
        text: roomTooltipText(target),
      });
      // Follow the control's live state: a new name updates the text (Turn
      // microphone off ↔ on); opening its popover hides the tooltip.
      observer = new MutationObserver(() => {
        if (shown !== target) return;
        if (roomTooltipSuppressed(target)) {
          hide(false);
          return;
        }
        const text = roomTooltipText(target);
        setTooltip((current) =>
          current?.target === target && current.text !== text
            ? { ...current, text }
            : current,
        );
      });
      observer.observe(target, {
        attributeFilter: ["aria-expanded", "data-state", "data-tooltip"],
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      if (target.parentElement instanceof HTMLDetailsElement) {
        observer.observe(target.parentElement, {
          attributeFilter: ["open"],
          attributes: true,
        });
      }
    };

    const onPointerOver = (event: PointerEvent) => {
      // jsdom and older engines may omit pointerType: treat that as a mouse.
      if (event.pointerType === "touch") return;
      const target = roomTooltipTarget(event.target, container);
      if (!target || target === shown || target === pending) return;
      if (target === dismissed || roomTooltipSuppressed(target)) return;
      if (warm()) {
        show(target, true);
        return;
      }
      clearPending();
      pending = target;
      timer = view.setTimeout(() => {
        timer = null;
        pending = null;
        show(target, false);
      }, ROOM_TOOLTIP_HOVER_DELAY_MS);
    };
    const onPointerOut = (event: PointerEvent) => {
      const target = roomTooltipTarget(event.target, container);
      if (!target) return;
      const next = event.relatedTarget;
      if (next instanceof Node && target.contains(next)) return;
      if (target === dismissed) dismissed = null;
      if (target === pending) clearPending();
      if (target === shown) hide(true);
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = roomTooltipTarget(event.target, container);
      if (!target || target === shown) return;
      if (!roomTooltipFocusVisible(target, keyboardModality)) return;
      dismissed = null;
      show(target, warm());
    };
    const onFocusOut = (event: FocusEvent) => {
      const target = roomTooltipTarget(event.target, container);
      if (!target || target !== shown) return;
      const next = event.relatedTarget;
      if (next instanceof Node && target.contains(next)) return;
      hide(true);
    };
    const onPointerDown = (event: PointerEvent) => {
      keyboardModality = false;
      const target = roomTooltipTarget(event.target, container);
      if (target) dismissed = target;
      hide(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!event.altKey && !event.ctrlKey && !event.metaKey) {
        keyboardModality = true;
      }
      if (event.key !== "Escape" || !shown) return;
      // WCAG 1.4.13 dismissible: hide the open tooltip without moving focus or
      // closing an open non-modal drawer underneath on the same Escape press.
      event.preventDefault();
      event.stopPropagation();
      dismissed = shown;
      hide(false);
    };
    const onViewportChange = () => hide(false);

    container.addEventListener("pointerover", onPointerOver);
    container.addEventListener("pointerout", onPointerOut);
    container.addEventListener("focusin", onFocusIn);
    container.addEventListener("focusout", onFocusOut);
    ownerDocument.addEventListener("pointerdown", onPointerDown, true);
    ownerDocument.addEventListener("keydown", onKeyDown, true);
    view.addEventListener("scroll", onViewportChange, true);
    view.addEventListener("resize", onViewportChange);
    return () => {
      clearPending();
      observer?.disconnect();
      container.removeEventListener("pointerover", onPointerOver);
      container.removeEventListener("pointerout", onPointerOut);
      container.removeEventListener("focusin", onFocusIn);
      container.removeEventListener("focusout", onFocusOut);
      ownerDocument.removeEventListener("pointerdown", onPointerDown, true);
      ownerDocument.removeEventListener("keydown", onKeyDown, true);
      view.removeEventListener("scroll", onViewportChange, true);
      view.removeEventListener("resize", onViewportChange);
    };
  }, [containerRef]);

  // Place the pill once its text is laid out: centred on the control, kept
  // 8px inside the viewport, flipped when the preferred side has no room.
  useLayoutEffect(() => {
    const node = tooltipRef.current;
    if (!node || !tooltip) return;
    const root = node.ownerDocument.documentElement;
    const view = node.ownerDocument.defaultView ?? window;
    const viewportWidth = root.clientWidth || view.innerWidth;
    const viewportHeight = root.clientHeight || view.innerHeight;
    const anchor = tooltip.target.getBoundingClientRect();
    // offsetWidth/Height ignore the entrance transform but round the text's
    // sub-pixel box, so reserve that remainder to keep the 8px clamp exact.
    const width = node.offsetWidth + 1;
    const height = node.offsetHeight;
    const above = anchor.top - ROOM_TOOLTIP_GAP_ABOVE_PX - height;
    const below = anchor.bottom + ROOM_TOOLTIP_GAP_BELOW_PX;
    let side = tooltip.side;
    if (side === "top" && above < ROOM_TOOLTIP_EDGE_PX) side = "bottom";
    else if (
      side === "bottom" &&
      below + height > viewportHeight - ROOM_TOOLTIP_EDGE_PX &&
      above >= ROOM_TOOLTIP_EDGE_PX
    ) {
      side = "top";
    }
    const maxLeft = Math.max(
      ROOM_TOOLTIP_EDGE_PX,
      viewportWidth - ROOM_TOOLTIP_EDGE_PX - width,
    );
    const left = Math.min(
      Math.max(
        anchor.left + anchor.width / 2 - width / 2,
        ROOM_TOOLTIP_EDGE_PX,
      ),
      maxLeft,
    );
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(side === "top" ? above : below)}px`;
    node.dataset.side = side;
  }, [tooltip]);

  return (
    <div
      aria-hidden="true"
      className="media-p405-tooltip"
      data-instant={tooltip?.instant ? "true" : undefined}
      data-state={tooltip ? "open" : "closed"}
      data-testid="room-tooltip"
      hidden={!tooltip}
      ref={tooltipRef}
    >
      {tooltip?.text ?? ""}
    </div>
  );
}

function DockDivider() {
  return <span aria-hidden="true" className="media-p405-dock-divider" />;
}

/**
 * Elapsed time since the room first connected (kept through reconnects).
 * Its own component so only this text re-renders every second. Hidden from
 * assistive technology: the polite status line already conveys the room
 * state and a ticking value would be noise.
 */
function SessionClock({ live }: { live: boolean }) {
  const startedAt = useRef<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (!live) return undefined;
    startedAt.current ??= Date.now();
    const origin = startedAt.current;
    const timer = globalThis.setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - origin) / 1_000)));
    }, 1_000);
    return () => globalThis.clearInterval(timer);
  }, [live]);
  return (
    <span aria-hidden="true" className="media-p405-session-clock">
      {formatSessionClock(elapsedSeconds)}
    </span>
  );
}

function formatSessionClock(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds)
    ? Math.max(0, Math.floor(totalSeconds))
    : 0;
  const hours = Math.floor(safe / 3_600);
  const minutes = Math.floor((safe % 3_600) / 60);
  const seconds = safe % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

function MediaTile({
  attachVideo,
  item,
  mediaCues,
  onTogglePin,
  pinned,
  signal,
  tone,
  trackRef = item.trackRef,
  variant,
}: MediaTileProps) {
  const { t } = useI18n();
  const displayName = item.displayName;
  const isPresentation = trackRef.source === Track.Source.ScreenShare;
  const isLocal = item.isLocal === true;
  // A screen share is never a person's tile: no personal badges, no tone.
  const tileSignal = isPresentation ? undefined : signal;
  const label = t(
    isPresentation ? "media.p405.screenShare" : "media.p405.participantVideo",
    { name: displayName },
  );
  const pinButtonID = useId();
  // Self-view reads like a mirror; screen shares and other people never flip.
  const mirrorVideo = isLocal && !isPresentation;
  // ROOM-TILE-TEAMS-01: microphone and speaking cues of the person (never of
  // a screen share). Self reads the local hook; others their own events.
  const participant = trackRef.participant;
  const remoteMedia = useRemoteTileMediaState(
    isPresentation || isLocal ? null : participant,
  );
  const microphoneEnabled =
    !isPresentation &&
    (isLocal
      ? mediaCues.localMicrophoneEnabled
      : remoteMedia.microphoneEnabled ||
        mediaCues.unmutedMicrophones.has(participant));
  const speaking =
    microphoneEnabled &&
    (mediaCues.speaking.has(participant) || remoteMedia.speaking);
  const micState = isPresentation
    ? undefined
    : microphoneEnabled
      ? "on"
      : "off";
  const initials = participantInitials(displayName);
  const MicStateIcon = microphoneEnabled ? Mic : MicOff;

  return (
    <ParticipantTile
      aria-label={label}
      className={`media-p405-tile media-p405-tile--${variant}`}
      data-mic-state={micState}
      data-speaking={speaking ? "true" : undefined}
      data-tone={isPresentation ? undefined : tone}
      data-video-state={attachVideo ? "active" : "paused"}
      trackRef={trackRef}
    >
      {attachVideo && isTrackReference(trackRef) && (
        <VideoTrack
          aria-label={label}
          className={mirrorVideo ? "media-p405-video--mirror" : undefined}
          manageSubscription={false}
          trackRef={trackRef}
        />
      )}
      {/*
        Teams camera-off avatar: flat pastel initials while the microphone is
        off, a flat slate circle with a person glyph while it is live (ref-3).
      */}
      <div
        aria-hidden="true"
        className="media-p405-avatar"
        data-initials={Array.from(initials).length > 1 ? "2" : "1"}
        data-mic-state={micState}
        data-tone={tone}
      >
        {micState === "on" ? (
          <UserRound aria-hidden="true" strokeWidth={1.75} />
        ) : (
          initials
        )}
      </div>
      {tileSignal && (tileSignal.hand || tileSignal.reaction) ? (
        /*
          Decorative: the room's polite live region already announces hand
          queue changes and reaction summaries (ADR-0031 §8–9), so the
          top-right badges stay out of the accessibility tree. The hand sits
          in the corner; a transient reaction lands to its left.
        */
        <div aria-hidden="true" className="media-p406-tile-signals">
          {tileSignal.reaction ? (
            <span
              className="media-p406-tile-reaction"
              data-reaction={tileSignal.reaction.reaction}
              key={tileSignal.reaction.signal_sequence}
            >
              {reactionGlyph(tileSignal.reaction.reaction)}
            </span>
          ) : null}
          {tileSignal.hand ? (
            <span
              className="media-p406-tile-hand"
              data-queue-position={tileSignal.hand.queue_position}
            >
              <Hand strokeWidth={2.2} />
              {tileSignal.hand.show_position ? (
                <span className="media-p406-tile-hand__position">
                  {tileSignal.hand.queue_position}
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="media-p405-tile-meta">
        {/*
          The name span keeps `textContent === displayName`: the decorative
          microphone glyph is an empty <svg> floated after the name, so the
          name still truncates with an ellipsis before it.
        */}
        <span>
          {micState ? (
            <MicStateIcon
              aria-hidden="true"
              className="media-p405-tile-mic"
              data-mic-state={micState}
              strokeWidth={2.1}
            />
          ) : null}
          {displayName}
        </span>
        <IconButton
          aria-pressed={pinned}
          id={pinButtonID}
          label={t(pinned ? "media.p405.unpin" : "media.p405.pin", {
            name: displayName,
          })}
          onClick={(event) => {
            event.stopPropagation();
            onTogglePin(item, event.currentTarget);
          }}
          size="sm"
          variant="quiet"
        >
          {pinned ? <PinOff /> : <Pin />}
        </IconButton>
      </div>
    </ParticipantTile>
  );
}

/** Up to two trailing echo glyphs for a grouped burst; DOM stays bounded. */
const MAX_REACTION_ECHOES = 2;
/** Horizontal sway of one flight, in CSS px either side of its lane. */
const REACTION_DRIFT_PX = 28;

/**
 * ROOM-STAGE-POLISH-04: one floating reaction lane. The sway comes from the
 * cluster id and its latest sequence, so streams never stack on one straight
 * line and a re-render never changes an in-flight path.
 */
function FloatingReaction({
  cluster,
  lane,
}: {
  cluster: ClassroomReactionVisualCluster;
  lane: number;
}) {
  const glyph = reactionGlyph(cluster.reaction);
  const drift =
    (fnv1aHash(`${cluster.cluster_id}:${cluster.last_signal_sequence}`) %
      (REACTION_DRIFT_PX * 2 + 1)) -
    REACTION_DRIFT_PX;
  const echoes = Math.min(MAX_REACTION_ECHOES, cluster.count - 1);
  return (
    <span
      className="media-p406-reaction-cluster"
      data-lane={lane}
      data-reaction={cluster.reaction}
      style={{ "--reaction-drift-x": `${drift}px` } as CSSProperties}
    >
      <span className="media-p406-reaction-glyph">{glyph}</span>
      {Array.from({ length: echoes }, (_, index) => (
        <span
          className="media-p406-reaction-echo"
          data-echo={index + 1}
          key={index}
        >
          {glyph}
        </span>
      ))}
      {cluster.count > 1 ? (
        <span className="media-p406-reaction-count">
          ×{cluster.count_label}
        </span>
      ) : null}
    </span>
  );
}

function ParticipantRail({
  attachedVideoItemIDs,
  items,
  mediaCues,
  onTogglePin,
  pinnedID,
  tileSignals,
  toneSalt,
}: {
  attachedVideoItemIDs: ReadonlySet<string>;
  items: readonly MediaLayoutItem[];
  mediaCues: MediaTileMediaCues;
  onTogglePin: MediaTileProps["onTogglePin"];
  pinnedID: string | null;
  tileSignals: ReadonlyMap<string, ClassroomTileSignal>;
  toneSalt: number;
}) {
  const { t } = useI18n();
  if (items.length === 0) {
    return <p className="media-p405-empty">{t("media.p405.noParticipants")}</p>;
  }
  return (
    <ul className="media-p405-rail-list">
      {items.map((item) => (
        <li key={item.id}>
          <MediaTile
            attachVideo={attachedVideoItemIDs.has(item.id)}
            item={item}
            mediaCues={mediaCues}
            onTogglePin={onTogglePin}
            pinned={pinnedID === item.id}
            signal={tileSignals.get(item.id)}
            tone={mediaTileTone(item.sequence, toneSalt)}
            variant="rail"
          />
        </li>
      ))}
    </ul>
  );
}

type DeviceSelection = ReturnType<typeof useMediaDeviceSelect>;

function DevicePanel({
  canPublish,
  onChange,
  onDeviceError,
}: {
  canPublish: boolean;
  onChange: (name: string, action: () => Promise<unknown> | void) => void;
  onDeviceError: () => void;
}) {
  const { t } = useI18n();
  const speakerDevices = useMediaDeviceSelect({
    kind: "audiooutput",
    onError: onDeviceError,
  });
  return (
    <section className="media-p405-device-panel">
      {canPublish && (
        <PublishingDeviceSelectors
          onChange={onChange}
          onDeviceError={onDeviceError}
        />
      )}
      <DeviceSelect
        label={t("media.p405.speakerDevice")}
        name="speaker-device"
        onChange={onChange}
        selection={speakerDevices}
      />
    </section>
  );
}

function PublishingDeviceSelectors({
  onChange,
  onDeviceError,
}: {
  onChange: (name: string, action: () => Promise<unknown> | void) => void;
  onDeviceError: () => void;
}) {
  const { t } = useI18n();
  const microphoneDevices = useMediaDeviceSelect({
    kind: "audioinput",
    onError: onDeviceError,
  });
  const cameraDevices = useMediaDeviceSelect({
    kind: "videoinput",
    onError: onDeviceError,
  });
  return (
    <>
      <DeviceSelect
        label={t("media.p405.microphoneDevice")}
        name="microphone-device"
        onChange={onChange}
        selection={microphoneDevices}
      />
      <DeviceSelect
        label={t("media.p405.cameraDevice")}
        name="camera-device"
        onChange={onChange}
        selection={cameraDevices}
      />
    </>
  );
}

function DeviceSelect({
  label,
  name,
  onChange,
  selection,
}: {
  label: string;
  name: string;
  onChange: (name: string, action: () => Promise<unknown> | void) => void;
  selection: DeviceSelection;
}) {
  const { t } = useI18n();
  return (
    <label>
      <span>{label}</span>
      <select
        onChange={(event) =>
          onChange(name, () =>
            selection.setActiveMediaDevice(event.target.value),
          )
        }
        value={selection.activeDeviceId}
      >
        {selection.devices.length === 0 && (
          <option value="default">{t("media.p405.defaultDevice")}</option>
        )}
        {selection.devices.map((device, index) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label || `${label} ${index + 1}`}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Grace period before a hover-opened end-call popover closes. */
const LEAVE_POPOVER_CLOSE_DELAY_MS = 150;

/**
 * ROOM-MEET-DOCK-04 / ROOM-COMPACT-05: the Dock's ruby end-call pill. Its
 * words stay the accessible name but are hidden visually by the room's own
 * utility, never `.visually-hidden` (Excalidraw restyles that class).
 *
 * A participant gets one action: the pill opens "Leave the classroom?". A
 * host who may end the room (`moderation.canEndRoom`, an exact server
 * projection) gets a two-choice Liquid Glass popover instead — End room
 * (ruby) above Leave room (dark glass). Hovering the pill or the popover
 * keeps it open (a transparent bridge spans the gap; it closes 150ms after
 * the pointer leaves both); a click pins it; Enter / Space opens it with
 * focus on the first choice; Escape, an outside press or tabbing away
 * closes it, Escape returning focus to the pill. Both confirmations hand
 * focus back to the pill when they close.
 */
function LeaveRoomControl({
  moderation,
  moderationDisabled,
  onLeave,
}: {
  moderation?: ClassroomModerationControlsModel;
  moderationDisabled: boolean;
  onLeave: () => void;
}) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<number | null>(null);
  const pinned = useRef(false);
  const focusFirstOptionOnOpen = useRef(false);
  const popoverID = useId();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const endModeration = moderation?.canEndRoom ? moderation : null;
  const open = endModeration !== null && popoverOpen;

  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current !== null) {
      globalThis.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const closePopover = useCallback(
    (restoreFocus: boolean) => {
      clearCloseTimer();
      pinned.current = false;
      focusFirstOptionOnOpen.current = false;
      setPopoverOpen(false);
      if (restoreFocus) triggerRef.current?.focus();
    },
    [clearCloseTimer],
  );

  const focusOption = useCallback((index: "first" | "last" | 1 | -1) => {
    const options = Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>(
        ".media-p405-leave-option:not(:disabled)",
      ) ?? [],
    );
    if (options.length === 0) return;
    if (index === "first") {
      options[0]?.focus();
      return;
    }
    if (index === "last") {
      options[options.length - 1]?.focus();
      return;
    }
    const current = options.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const next =
      current < 0 ? 0 : (current + index + options.length) % options.length;
    options[next]?.focus();
  }, []);

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

  useEffect(() => {
    if (!open || !focusFirstOptionOnOpen.current) return;
    focusFirstOptionOnOpen.current = false;
    focusOption("first");
  }, [focusOption, open]);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (
        root &&
        event.target instanceof Node &&
        !root.contains(event.target)
      ) {
        closePopover(false);
      }
    };
    // A hover-opened popover never received focus, so the root's own Escape
    // handler cannot see the key: dismiss it here (WCAG 1.4.13) and hand
    // focus to the pill unless focus already rests on another control.
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const active = document.activeElement;
      const focusIsIdle =
        active === null ||
        active === document.body ||
        (active instanceof Node && rootRef.current?.contains(active) === true);
      closePopover(focusIsIdle);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closePopover, open]);

  const leaveDialogContent = (
    <DialogContent
      closeLabel={t("media.p405.leaveCancel")}
      data-theme="dark"
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        triggerRef.current?.focus();
      }}
    >
      <DialogTitle>{t("media.p405.leaveTitle")}</DialogTitle>
      <DialogDescription>{t("media.p405.leaveDescription")}</DialogDescription>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary">{t("media.p405.leaveCancel")}</Button>
        </DialogClose>
        <Button onClick={onLeave} variant="danger">
          {t("media.p405.leaveConfirm")}
        </Button>
      </DialogFooter>
    </DialogContent>
  );

  if (endModeration === null) {
    return (
      <Dialog onOpenChange={setLeaveOpen} open={leaveOpen}>
        <DialogTrigger asChild>
          <Button
            className="media-p405-dock-leave"
            data-tooltip={t("media.p405.leave")}
            id="media-p405-control-leave"
            leadingIcon={<PhoneOff />}
            ref={triggerRef}
            variant="danger"
          >
            <span className="media-p405-sr-only">{t("media.p405.leave")}</span>
          </Button>
        </DialogTrigger>
        {leaveDialogContent}
      </Dialog>
    );
  }

  const endDisabled =
    moderationDisabled || classroomModerationBusy(endModeration);

  const handleTriggerClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    // A keyboard activation (Enter / Space) reports no pointer clicks.
    const fromKeyboard = event.detail === 0;
    if (popoverOpen && pinned.current && !fromKeyboard) {
      closePopover(false);
      return;
    }
    clearCloseTimer();
    pinned.current = true;
    if (fromKeyboard) {
      if (popoverOpen) focusOption("first");
      else focusFirstOptionOnOpen.current = true;
    }
    setPopoverOpen(true);
  };

  return (
    <>
      <div
        className="media-p405-leave"
        onBlur={(event) => {
          const next = event.relatedTarget;
          if (!open || next === null) return;
          if (next instanceof Node && rootRef.current?.contains(next)) return;
          closePopover(false);
        }}
        onKeyDown={(event) => {
          if (!open) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closePopover(true);
            return;
          }
          const target = event.target;
          if (
            !(target instanceof HTMLElement) ||
            !target.classList.contains("media-p405-leave-option")
          ) {
            return;
          }
          const moves: Record<string, "first" | "last" | 1 | -1> = {
            ArrowDown: 1,
            ArrowUp: -1,
            End: "last",
            Home: "first",
          };
          const move = moves[event.key];
          if (move === undefined) return;
          event.preventDefault();
          focusOption(move);
        }}
        onPointerEnter={(event) => {
          if (event.pointerType === "touch") return;
          clearCloseTimer();
          setPopoverOpen(true);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === "touch" || pinned.current) return;
          clearCloseTimer();
          closeTimer.current = globalThis.setTimeout(() => {
            closeTimer.current = null;
            if (!pinned.current) setPopoverOpen(false);
          }, LEAVE_POPOVER_CLOSE_DELAY_MS);
        }}
        ref={rootRef}
      >
        <Button
          aria-controls={open ? popoverID : undefined}
          aria-expanded={open}
          className="media-p405-dock-leave"
          id="media-p405-control-leave"
          leadingIcon={<PhoneOff />}
          onClick={handleTriggerClick}
          ref={triggerRef}
          variant="danger"
        >
          <span className="media-p405-sr-only">
            {t("media.p405.leaveOrEnd")}
          </span>
        </Button>
        {open && (
          <div
            aria-label={t("media.p405.leaveOptions")}
            className="media-p405-leave-popover"
            data-testid="leave-end-popover"
            id={popoverID}
            role="group"
          >
            <button
              className="media-p405-leave-option media-p405-leave-option--end"
              disabled={endDisabled}
              onClick={() => {
                closePopover(false);
                setEndOpen(true);
              }}
              type="button"
            >
              <Power aria-hidden="true" />
              <span>{t("media.p407.endRoom")}</span>
            </button>
            <button
              className="media-p405-leave-option media-p405-leave-option--leave"
              onClick={() => {
                closePopover(false);
                setLeaveOpen(true);
              }}
              type="button"
            >
              <LogOut aria-hidden="true" />
              <span>{t("media.p405.leave")}</span>
            </button>
          </div>
        )}
      </div>
      <Dialog onOpenChange={setLeaveOpen} open={leaveOpen}>
        {leaveDialogContent}
      </Dialog>
      <ClassroomEndRoomDialog
        controls={endModeration}
        onOpenChange={setEndOpen}
        open={endOpen}
        returnFocusRef={triggerRef}
      />
    </>
  );
}

function stableMediaItems(
  trackRefs: readonly TrackReferenceOrPlaceholder[],
  participantProjection: WeakMap<object, SessionParticipantProjection>,
  participantFallback: string,
): readonly MediaLayoutItem[] {
  const observedItems: Array<{
    inputIndex: number;
    projection: SessionParticipantProjection;
    trackRef: TrackReferenceOrPlaceholder;
  }> = [];
  trackRefs.forEach((trackRef, inputIndex) => {
    const projection = participantProjection.get(trackRef.participant);
    if (projection) observedItems.push({ inputIndex, projection, trackRef });
  });
  return observedItems
    .sort(
      (left, right) =>
        left.projection.sequence - right.projection.sequence ||
        left.inputIndex - right.inputIndex,
    )
    .map(({ projection, trackRef }) => ({
      displayName: trackRef.participant.name?.trim() || participantFallback,
      id: projection.id,
      isLocal: trackRef.participant.isLocal,
      sequence: projection.sequence,
      trackRef,
    }));
}

function authoritativeMediaItems(
  trackRefs: readonly TrackReferenceOrPlaceholder[],
  roster: ClassroomSignalProjection["roster"],
  selfParticipantKey: string | null,
): readonly MediaLayoutItem[] {
  const rosterByParticipantKey = new Map(
    roster.map((participant) => [participant.participant_key, participant]),
  );
  const seen = new Set<string>();
  return trackRefs
    .flatMap((trackRef) => {
      const participantKey =
        trackRef.participant.attributes?.["tutorhub.participant_key"];
      if (typeof participantKey !== "string" || seen.has(participantKey)) {
        return [];
      }
      const participant = rosterByParticipantKey.get(participantKey);
      if (!participant) return [];
      seen.add(participantKey);
      return [
        {
          displayName: participant.display_name,
          id: participant.participant_key,
          isLocal: participant.participant_key === selfParticipantKey,
          sequence: participant.roster_sequence,
          trackRef,
        },
      ];
    })
    .sort(
      (left, right) =>
        left.sequence - right.sequence || left.id.localeCompare(right.id),
    );
}

function createSessionParticipantProjectionStore(
  initialTrackRefs: readonly TrackReferenceOrPlaceholder[],
): SessionParticipantProjectionStore {
  const entries = new WeakMap<object, SessionParticipantProjection>();
  const listeners = new Set<() => void>();
  let nextRemoteSequence = 1;
  let snapshot: SessionParticipantProjectionSnapshot = {
    entries,
    revision: 0,
  };
  const observe = (trackRefs: readonly TrackReferenceOrPlaceholder[]) => {
    let changed = false;
    const localFirstTrackRefs = [
      ...trackRefs.filter(({ participant }) => participant.isLocal),
      ...trackRefs.filter(({ participant }) => !participant.isLocal),
    ];
    for (const trackRef of localFirstTrackRefs) {
      if (entries.has(trackRef.participant)) continue;
      const isLocal = trackRef.participant.isLocal;
      const sequence = isLocal ? 0 : nextRemoteSequence;
      if (!isLocal) nextRemoteSequence += 1;
      entries.set(trackRef.participant, {
        id: isLocal
          ? "p405-session-local-participant"
          : `p405-session-participant-${sequence}`,
        sequence,
      });
      changed = true;
    }
    if (!changed) return;
    snapshot = { entries, revision: snapshot.revision + 1 };
    for (const listener of listeners) listener();
  };
  observe(initialTrackRefs);
  return {
    getSnapshot: () => snapshot,
    observe,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function isRemoteTrackPublication(
  value: unknown,
): value is RemoteTrackPublication {
  if (value instanceof RemoteTrackPublication) return true;
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    setSubscribed?: unknown;
    setVideoQuality?: unknown;
  };
  return (
    typeof candidate.setSubscribed === "function" &&
    typeof candidate.setVideoQuality === "function"
  );
}

function classroomDegradationSignal(
  quality: ConnectionQuality,
  publications: ReadonlySet<RemoteTrackPublication>,
  documentVisible: boolean,
): ClassroomDegradationSignal {
  if (!documentVisible || quality === ConnectionQuality.Lost) return "hold";
  const desiredVideoPaused = [...publications].some(
    (publication) =>
      publication.isDesired &&
      publication.isEnabled &&
      publication.track?.streamState === Track.StreamState.Paused,
  );
  if (desiredVideoPaused || quality === ConnectionQuality.Poor) {
    return "unstable";
  }
  if (
    quality === ConnectionQuality.Excellent ||
    quality === ConnectionQuality.Good
  ) {
    return "stable";
  }
  return "hold";
}

function degradationStatusKey(
  stage: Exclude<ClassroomDegradationStage, "normal">,
): TranslationKey {
  return `media.p405.degradation.${stage}` as TranslationKey;
}

function roomStatusKey(status: ClassroomConnectionStatus): TranslationKey {
  return `media.room.${status}` as TranslationKey;
}

function layoutModeKey(mode: ClassroomLayoutMode): TranslationKey {
  if (mode === "active-speaker") return "media.p405.layoutActiveSpeaker";
  if (mode === "presentation") return "media.p405.layoutPresentation";
  return "media.p405.layoutGrid";
}

function reactionGlyph(reaction: ClassroomReactionType): string {
  switch (reaction) {
    case "thumbs_up":
      return "👍";
    case "clap":
      return "👏";
    case "heart":
      return "❤️";
    case "celebrate":
      return "🎉";
    case "laugh":
      return "😂";
    case "surprised":
      return "😮";
  }
}

function reactionLabelKey(reaction: ClassroomReactionType): TranslationKey {
  return `media.p406.reaction.${reaction}` as TranslationKey;
}

/**
 * ROOM-PEOPLE-03: microphone and speaking cues per roster key. The only join
 * is the `tutorhub.participant_key` attribute that Core API signs into the
 * LiveKit token (participants cannot update their own attributes) — the same
 * key the grid already orders tiles by. Provider identities are never read;
 * a participant without the attribute, or a field the provider does not
 * expose, simply yields no cue.
 */
function classroomPeopleMediaStates(
  participants: readonly Participant[],
  speakingParticipants: readonly Participant[],
  localMicrophoneEnabled: boolean,
): ReadonlyMap<string, ClassroomPeopleMediaState> {
  const speaking = new Set<Participant>(speakingParticipants);
  const states = new Map<string, ClassroomPeopleMediaState>();
  for (const participant of participants) {
    const participantKey = participant.attributes?.["tutorhub.participant_key"];
    if (typeof participantKey !== "string" || states.has(participantKey)) {
      continue;
    }
    const microphoneEnabled: unknown = participant.isLocal
      ? localMicrophoneEnabled
      : participant.isMicrophoneEnabled;
    states.set(participantKey, {
      ...(typeof microphoneEnabled === "boolean" ? { microphoneEnabled } : {}),
      speaking: speaking.has(participant),
    });
  }
  return states;
}

function signalMutationErrorKey(error: unknown): TranslationKey {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return "media.p406.actionError";
  }
  const status = (error as { status?: unknown }).status;
  if (status === 403) return "media.p406.forbidden";
  if (status === 409) return "media.p406.conflict";
  if (status === 429) return "media.p406.rateLimited";
  return "media.p406.actionError";
}
