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
  MenuTrigger,
} from "@tutorhub/ui";
import {
  Camera,
  CameraOff,
  ChevronLeft,
  ChevronRight,
  Grid2X2,
  Hand,
  LogOut,
  Mic,
  MicOff,
  Pin,
  PinOff,
  Presentation,
  ScreenShare,
  ScreenShareOff,
  Settings2,
  Smile,
  Sparkles,
  MessageCircle,
  UserRound,
  Users,
} from "lucide-react";
import {
  ConnectionQuality,
  ParticipantEvent,
  RemoteTrackPublication,
  Track,
  VideoQuality,
  type LocalVideoTrack,
  type TrackProcessor,
} from "livekit-client";
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
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
  type ClassroomReactionType,
  type ClassroomSignalProjection,
} from "./classroomSignals";
import {
  ClassroomModerationControls,
  ClassroomParticipantModerationMenu,
  type ClassroomModerationControlsModel,
} from "./ClassroomModerationControls";

export type ClassroomConnectionStatus =
  "connecting" | "connected" | "reconnecting" | "disconnected" | "failed";

export interface ClassroomMediaShellProps {
  canPublishCameraMicrophone: boolean;
  canShareScreen: boolean;
  canSubscribe: boolean;
  connectionStatus: ClassroomConnectionStatus;
  controlAbortSignal?: AbortSignal;
  chat?: ReactNode;
  lobby?: ReactNode;
  /**
   * Number of people waiting for admission. Defaults to the value published by
   * `MediaLobbyWaitingCountProvider`; only meaningful when `lobby` is present.
   */
  lobbyWaitingCount?: number;
  moderation?: ClassroomModerationControlsModel;
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

export type ClassroomToolID = "whiteboard";

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
  readonly label: string;
  readonly title: string;
}

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
  trackRef?: TrackReferenceOrPlaceholder;
  variant: "grid" | "rail" | "stage";
  onTogglePin: (item: MediaLayoutItem, focusTarget: HTMLElement) => void;
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
  | `tool-${ClassroomToolID}`
  | "layout-grid"
  | "layout-active-speaker"
  | "layout-presentation";

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

export function ClassroomMediaShell({
  canPublishCameraMicrophone,
  canShareScreen,
  canSubscribe,
  connectionStatus,
  controlAbortSignal,
  chat,
  lobby,
  lobbyWaitingCount,
  moderation,
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
  const [rosterOpen, setRosterOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [openToolID, setOpenToolID] = useState<ClassroomToolID | null>(null);
  const [autoOpenedToolID, setAutoOpenedToolID] =
    useState<ClassroomToolID | null>(null);
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
  const [effectsOpen, setEffectsOpen] = useState(false);
  const effectsReturnFocus = useRef<HTMLElement | null>(null);
  const effectsDescriptionID = useId();
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
  }, [controlAbortSignal]);

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
      ...tools.map(({ id }) => `tool-${id}` as const),
      ...(signals || lobby ? (["roster"] as const) : []),
      "layout-grid",
      "layout-active-speaker",
      ...(presenterID ? (["layout-presentation"] as const) : []),
    ],
    [
      canPublishCameraMicrophone,
      canShareScreen,
      chat,
      controlsTerminated,
      lobby,
      pendingControl,
      presenterID,
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
          ? activeElement.id || "media-p405-layout-grid"
          : "media-p405-layout-grid";
      setLayoutState((current) =>
        enterPresentation({ ...current, focusTargetId }, presenterID),
      );
      return;
    }

    if (!presenterID && previousPresenter) {
      const restored = restorePresentation(layoutState, cameraItems, width);
      setLayoutState(restored.state);
      scheduleElementFocus(
        restored.state.focusTargetId,
        `media-p405-layout-${restored.state.mode}`,
      );
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
      scheduleElementFocus(targetID, "media-p405-layout-active-speaker");
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

  // The tool stage is a non-modal region: the classroom Dock stays reachable
  // while drawing, so opening moves focus to the stage heading and closing
  // returns it to the exact toolbar control that owns the tool.
  const toggleTool = (toolID: ClassroomToolID) => {
    setAutoOpenedToolID(null);
    if (openToolID === toolID) {
      setOpenToolID(null);
      return;
    }
    setOpenToolID(toolID);
    scheduleElementFocus(`media-p506-stage-title-${toolID}`);
  };

  const closeActiveTool = () => {
    if (!activeTool) return;
    setAutoOpenedToolID(null);
    setOpenToolID(null);
    scheduleElementFocus(`media-p506-control-${activeTool.id}`);
  };

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
  const effectsLabel = effectsActive
    ? t("media.fx.header", { name: effectsName })
    : t("media.p405.effectsNone");
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

  const toggleEffectsDrawer = (opener: HTMLElement) => {
    if (!effectsAvailable) return;
    effectsReturnFocus.current = opener;
    setEffectsOpen((open) => !open);
  };

  const rail = (
    <ParticipantRail
      attachedVideoItemIDs={attachedCameraVideoItemIDs}
      items={projection.items}
      onTogglePin={handleTogglePin}
      pinnedID={layoutState.pinnedParticipantId}
    />
  );
  const selfHand = signals?.projection?.raised_hands.find(
    ({ participant_key }) =>
      participant_key === signals.projection?.self_participant_key,
  );
  const participantCount =
    signals?.projection?.roster.length ?? cameraItems.length;

  return (
    <div
      aria-busy={connectionStatus === "connecting" || undefined}
      className={`media-p405-shell${
        effectsOpen && effectsAvailable ? " media-p405-shell--effects-open" : ""
      }`}
      ref={shellRef}
    >
      <header className="media-p405-header">
        <div className="media-p405-header-title">
          <span
            aria-hidden="true"
            className="media-p405-connection-dot"
            data-connection={connectionStatus}
          />
          <h1>{t("media.room.title")}</h1>
          <span aria-hidden="true" className="media-p405-header-divider" />
          <SessionClock
            live={
              connectionStatus === "connected" ||
              connectionStatus === "reconnecting"
            }
          />
          <p aria-live="polite" role="status">
            {t(roomStatusKey(connectionStatus))}
            {" / "}
            {t("media.room.participantCount", { count: participantCount })}
          </p>
        </div>
        <div className="media-p405-header-actions">
          <div className="media-p405-header-badges">
            {!canPublishCameraMicrophone && (
              <span>{t("media.room.listenOnly")}</span>
            )}
            {canPublishCameraMicrophone ? (
              <button
                aria-expanded={effectsOpen && effectsAvailable}
                aria-haspopup="dialog"
                className={`media-p405-effects-badge${
                  effectsActive ? " media-p405-effects-badge--on" : ""
                }`}
                disabled={controlsTerminated}
                onClick={(event) => toggleEffectsDrawer(event.currentTarget)}
                type="button"
              >
                <span>
                  <Sparkles aria-hidden="true" />
                  {effectsLabel}
                </span>
              </button>
            ) : (
              <span>{effectsLabel}</span>
            )}
          </div>
          {moderation && (
            <ClassroomModerationControls
              controls={moderation}
              disabled={controlsTerminated || connectionStatus !== "connected"}
            />
          )}
        </div>
      </header>

      {lobby && (
        // Stays mounted (visually collapsed while idle) so the polite live
        // region announces new waiting requests without taking stage height.
        <div
          className={`media-p406-lobby-banner${
            waitingCount > 0 ? "" : " media-p406-lobby-banner--idle"
          }`}
        >
          <p
            aria-atomic="true"
            aria-live="polite"
            className="media-p406-lobby-banner__text"
            role="status"
          >
            {waitingCount > 0
              ? t("media.p406.lobbyWaiting", { count: waitingCount })
              : ""}
          </p>
          {waitingCount > 0 && (
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
        <p className="media-p405-notice" role="status">
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
        }`}
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
            <header className="media-p506-tool-stage__header">
              <h2 id={`media-p506-stage-title-${activeTool.id}`} tabIndex={-1}>
                {activeTool.title}
              </h2>
              <Button onClick={closeActiveTool} size="sm" variant="secondary">
                {t("media.p405.close")}
              </Button>
            </header>
            <div className="media-p506-tool-stage__body">
              {activeTool.content}
            </div>
          </section>
        )}
        {signals?.projection && (
          <div aria-hidden="true" className="media-p406-reactions">
            {signals.projection.reactions.clusters.map((cluster) => (
              <span
                className="media-p406-reaction-cluster"
                data-reaction={cluster.reaction}
                key={cluster.cluster_id}
              >
                <span>{reactionGlyph(cluster.reaction)}</span>
                <span>{cluster.count_label}</span>
              </span>
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
                      onTogglePin={handleTogglePin}
                      pinned={layoutState.pinnedParticipantId === item.id}
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
              onTogglePin={handleTogglePin}
              pinned={layoutState.pinnedParticipantId === stageItem.id}
              trackRef={stageTrackRef}
              variant="stage"
            />
          ) : (
            <p className="media-p405-empty">{t("media.p405.noParticipants")}</p>
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
                disabled={pendingControl !== null || controlsTerminated}
                id="media-p405-control-microphone"
                label={t(
                  isMicrophoneEnabled
                    ? "media.p405.microphoneOn"
                    : "media.p405.microphoneOff",
                )}
                loading={pendingControl === "microphone"}
                onClick={() =>
                  void runControl("microphone", () =>
                    localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled),
                  )
                }
                onFocus={() => setToolbarFocusKey("microphone")}
                tabIndex={toolbarTabIndex("microphone")}
                variant={isMicrophoneEnabled ? "secondary" : "danger"}
              >
                <DockGlyph
                  caption={t("media.room.dock.mic")}
                  icon={isMicrophoneEnabled ? <Mic /> : <MicOff />}
                />
              </IconButton>
              <IconButton
                className="media-p405-dock-button media-p405-dock-button--av"
                data-media-control="camera"
                disabled={
                  pendingControl !== null ||
                  controlsTerminated ||
                  degradationStage === "audio-only"
                }
                id="media-p405-control-camera"
                label={t(
                  isCameraEnabled
                    ? "media.p405.cameraOn"
                    : "media.p405.cameraOff",
                )}
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
                <DockGlyph
                  caption={t("media.room.dock.camera")}
                  icon={isCameraEnabled ? <Camera /> : <CameraOff />}
                />
              </IconButton>
              <DockDivider />
            </>
          )}
          {canShareScreen && (
            <IconButton
              className="media-p405-dock-button"
              data-media-control="screen-share"
              disabled={pendingControl !== null || controlsTerminated}
              id="media-p405-control-screen-share"
              label={t(
                isScreenShareEnabled
                  ? "media.p405.shareStop"
                  : "media.p405.shareStart",
              )}
              loading={pendingControl === "screen-share"}
              onClick={() =>
                void runControl("screen-share", () =>
                  localParticipant.setScreenShareEnabled(!isScreenShareEnabled),
                )
              }
              onFocus={() => setToolbarFocusKey("screen-share")}
              tabIndex={toolbarTabIndex("screen-share")}
              variant={isScreenShareEnabled ? "danger" : "secondary"}
            >
              <DockGlyph
                caption={t(
                  isScreenShareEnabled
                    ? "media.room.dock.shareStop"
                    : "media.room.dock.share",
                )}
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
            disabled={controlsTerminated}
            id="media-p405-control-devices"
            label={t("media.p405.devices")}
            onClick={() => setDevicePanelOpen((open) => !open)}
            onFocus={() => setToolbarFocusKey("devices")}
            tabIndex={toolbarTabIndex("devices")}
            variant="secondary"
          >
            <DockGlyph
              caption={t("media.room.dock.devices")}
              icon={<Settings2 />}
            />
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
              disabled={controlsTerminated}
              id="media-p405-control-effects"
              label={t("media.fx.openEffects")}
              onClick={(event) => toggleEffectsDrawer(event.currentTarget)}
              onFocus={() => setToolbarFocusKey("effects")}
              tabIndex={toolbarTabIndex("effects")}
              variant={effectsActive ? "primary" : "secondary"}
            >
              <DockGlyph
                caption={t("media.room.dock.effects")}
                icon={<Sparkles />}
              />
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
              disabled={
                signals.mutating || signals.loading || controlsTerminated
              }
              id="media-p406-control-hand"
              label={t(
                selfHand ? "media.p406.lowerOwnHand" : "media.p406.raiseHand",
              )}
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
              <DockGlyph
                caption={t(
                  selfHand ? "media.room.dock.lower" : "media.room.dock.raise",
                )}
                icon={<Hand />}
              />
            </IconButton>
          )}

          {signals?.projection?.viewer_operations.can_send_reaction && (
            <Menu modal={false}>
              <MenuTrigger asChild>
                <IconButton
                  className="media-p405-dock-button"
                  data-media-control="reaction"
                  disabled={signals.mutating || controlsTerminated}
                  id="media-p406-control-reaction"
                  label={t("media.p406.reactions")}
                  onFocus={() => setToolbarFocusKey("reaction")}
                  tabIndex={toolbarTabIndex("reaction")}
                  variant="secondary"
                >
                  <DockGlyph
                    caption={t("media.room.dock.react")}
                    icon={<Smile />}
                  />
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
            <Drawer onOpenChange={setChatOpen} open={chatOpen}>
              <DrawerTrigger asChild>
                <IconButton
                  className="media-p405-dock-button"
                  data-media-control="chat"
                  id="media-p408-control-chat"
                  label={t("media.p408.openChat")}
                  onFocus={() => setToolbarFocusKey("chat")}
                  tabIndex={toolbarTabIndex("chat")}
                  variant="secondary"
                >
                  <DockGlyph
                    caption={t("media.room.dock.chat")}
                    icon={<MessageCircle />}
                  />
                </IconButton>
              </DrawerTrigger>
              <DrawerContent
                className="media-p408-chat-drawer"
                closeLabel={t("media.p405.close")}
                data-theme="dark"
              >
                <DrawerTitle>{t("media.p408.title")}</DrawerTitle>
                {chat}
                <DrawerClose asChild>
                  <Button variant="secondary">{t("media.p405.close")}</Button>
                </DrawerClose>
              </DrawerContent>
            </Drawer>
          )}

          {tools.map((tool) => {
            const open = openToolID === tool.id;
            return (
              <IconButton
                aria-controls={open ? `media-p506-stage-${tool.id}` : undefined}
                aria-expanded={open}
                className="media-p405-dock-button"
                data-media-control={`tool-${tool.id}`}
                id={`media-p506-control-${tool.id}`}
                key={tool.id}
                label={tool.label}
                onClick={() => toggleTool(tool.id)}
                onFocus={() => setToolbarFocusKey(`tool-${tool.id}`)}
                tabIndex={toolbarTabIndex(`tool-${tool.id}`)}
                variant={open ? "primary" : "secondary"}
              >
                <DockGlyph
                  caption={t(toolCaptionKey(tool.id))}
                  icon={tool.icon}
                />
              </IconButton>
            );
          })}

          {(signals || lobby) && (
            <Drawer onOpenChange={setRosterOpen} open={rosterOpen}>
              <DrawerTrigger asChild>
                <IconButton
                  className="media-p405-dock-button media-p406-roster-control"
                  data-media-control="roster"
                  disabled={controlsTerminated}
                  id="media-p406-control-roster"
                  label={
                    waitingCount > 0
                      ? t("media.p406.openRosterWaiting", {
                          count: waitingCount,
                        })
                      : t("media.p406.openRoster")
                  }
                  onFocus={() => setToolbarFocusKey("roster")}
                  tabIndex={toolbarTabIndex("roster")}
                  variant={waitingCount > 0 ? "primary" : "secondary"}
                >
                  <DockGlyph
                    caption={t("media.room.dock.people")}
                    icon={<Users />}
                  />
                  {waitingCount > 0 && (
                    <span className="media-p406-roster-badge">
                      {waitingCount > 99 ? "99+" : waitingCount}
                    </span>
                  )}
                </IconButton>
              </DrawerTrigger>
              <DrawerContent
                className="media-p406-roster-drawer"
                closeLabel={t("media.p405.close")}
                data-theme="dark"
              >
                <DrawerTitle>{t("media.p406.rosterTitle")}</DrawerTitle>
                {lobby && (
                  <div className="media-p406-roster-lobby">{lobby}</div>
                )}
                {signals && (
                  <ClassroomRoster
                    moderation={moderation}
                    moderationDisabled={
                      controlsTerminated || connectionStatus !== "connected"
                    }
                    onLowerAll={() =>
                      void runSignalAction(
                        signals.onLowerAllHands,
                        "media.p406.loweredAllHands",
                      )
                    }
                    onLowerHand={(participantKey) =>
                      void runSignalAction(
                        () => signals.onLowerHand(participantKey),
                        "media.p406.loweredHand",
                      )
                    }
                    signals={signals}
                  />
                )}
                <DrawerClose asChild>
                  <Button variant="secondary">{t("media.p405.close")}</Button>
                </DrawerClose>
              </DrawerContent>
            </Drawer>
          )}

          <DockDivider />
          <div
            aria-label={t("media.p405.layoutGroup")}
            className="media-p405-layout-controls"
            role="group"
          >
            <div className="media-p405-layout-pill">
              {layoutModes.map((mode) => (
                <IconButton
                  aria-pressed={projection.mode === mode}
                  className="media-p405-layout-button"
                  data-media-control={`layout-${mode}`}
                  disabled={mode === "presentation" && !presenterID}
                  id={`media-p405-layout-${mode}`}
                  key={mode}
                  label={t(layoutModeKey(mode))}
                  onClick={() => changeLayout(mode)}
                  onFocus={() => setToolbarFocusKey(`layout-${mode}`)}
                  tabIndex={toolbarTabIndex(`layout-${mode}`)}
                  variant={projection.mode === mode ? "primary" : "quiet"}
                >
                  {mode === "grid" ? (
                    <Grid2X2 />
                  ) : mode === "active-speaker" ? (
                    <UserRound />
                  ) : (
                    <Presentation />
                  )}
                </IconButton>
              ))}
            </div>
            <DockCaption>{t("media.room.dock.layout")}</DockCaption>
          </div>
        </div>

        <DockDivider />
        <LeaveRoomDialog onLeave={handleLeave} />

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
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              effectsReturnFocus.current?.focus();
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
    </div>
  );
}

/**
 * ROOM-STUDIO-02 Dock content: icon plus a short caption. The caption is
 * decorative (`aria-hidden`); the button keeps its full accessible label.
 * It stays visually hidden unless the room stylesheet reveals it on wide
 * screens, so hosts that only load the base styles keep 40px icon buttons.
 */
function DockGlyph({ caption, icon }: { caption: string; icon: ReactNode }) {
  return (
    <>
      <span className="media-p405-dock-icon">{icon}</span>
      <DockCaption>{caption}</DockCaption>
    </>
  );
}

function DockCaption({ children }: { children: string }) {
  return (
    <span
      aria-hidden="true"
      className="media-p405-dock-caption visually-hidden"
    >
      {children}
    </span>
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

function ClassroomRoster({
  moderation,
  moderationDisabled,
  onLowerAll,
  onLowerHand,
  signals,
}: {
  moderation?: ClassroomModerationControlsModel;
  moderationDisabled: boolean;
  onLowerAll: () => void;
  onLowerHand: (participantKey: string) => void;
  signals: ClassroomSignalControls;
}) {
  const { t } = useI18n();
  const projection = signals.projection;
  if (signals.loading && !projection) {
    return <p className="media-p405-empty">{t("media.p406.loading")}</p>;
  }
  if (signals.error && !projection) {
    return (
      <div className="media-p406-roster-state" role="alert">
        <p>{t("media.p406.loadError")}</p>
        <Button onClick={() => void signals.onResync()} size="sm">
          {t("media.p406.retry")}
        </Button>
      </div>
    );
  }
  if (!projection || projection.roster.length === 0) {
    return <p className="media-p405-empty">{t("media.p406.rosterEmpty")}</p>;
  }

  const raisedByParticipant = new Map(
    projection.raised_hands.map((hand) => [hand.participant_key, hand]),
  );
  const canModerate = projection.viewer_operations.can_moderate_hands;
  return (
    <section className="media-p406-roster">
      <div className="media-p406-roster-summary">
        <span>
          {t("media.room.participantCount", {
            count: projection.roster.length,
          })}
        </span>
        {signals.refreshing && <span>{t("media.p406.refreshing")}</span>}
        {canModerate && projection.raised_hands.length > 0 && (
          <Button
            disabled={signals.mutating}
            onClick={onLowerAll}
            size="sm"
            variant="secondary"
          >
            {t("media.p406.lowerAllHands")}
          </Button>
        )}
      </div>
      <ol aria-label={t("media.p406.rosterLabel")}>
        {projection.roster.map((participant) => {
          const hand = raisedByParticipant.get(participant.participant_key);
          const isSelf =
            participant.participant_key === projection.self_participant_key;
          return (
            <li key={participant.participant_key}>
              <div className="media-p406-roster-person">
                <strong>{participant.display_name}</strong>
                {isSelf && (
                  <span className="media-p406-roster-self">
                    {" "}
                    ({t("media.p406.you")})
                  </span>
                )}
                <span
                  className="media-p406-roster-role"
                  data-role={participant.instance_role}
                >
                  {t(instanceRoleKey(participant.instance_role))}
                </span>
                <span
                  className="media-p406-roster-connection"
                  data-connection={participant.connection_state}
                >
                  {t(connectionStateKey(participant.connection_state))}
                </span>
              </div>
              {moderation && (
                <ClassroomParticipantModerationMenu
                  controls={moderation}
                  disabled={moderationDisabled}
                  displayName={participant.display_name}
                  isSelf={isSelf}
                  participantKey={participant.participant_key}
                />
              )}
              {hand && (
                <div className="media-p406-hand-state">
                  <span>
                    {t("media.p406.handQueuePosition", {
                      position: hand.queue_position,
                    })}
                  </span>
                  {canModerate && !isSelf && (
                    <Button
                      disabled={signals.mutating}
                      onClick={() => onLowerHand(participant.participant_key)}
                      size="sm"
                      variant="quiet"
                    >
                      {t("media.p406.lowerNamedHand", {
                        name: participant.display_name,
                      })}
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function MediaTile({
  attachVideo,
  item,
  onTogglePin,
  pinned,
  trackRef = item.trackRef,
  variant,
}: MediaTileProps) {
  const { t } = useI18n();
  const displayName = item.displayName;
  const isPresentation = trackRef.source === Track.Source.ScreenShare;
  const label = t(
    isPresentation ? "media.p405.screenShare" : "media.p405.participantVideo",
    { name: displayName },
  );
  const pinButtonID = useId();
  // Self-view reads like a mirror; screen shares and other people never flip.
  const mirrorVideo = item.isLocal && !isPresentation;

  return (
    <ParticipantTile
      aria-label={label}
      className={`media-p405-tile media-p405-tile--${variant}`}
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
      <div
        aria-hidden="true"
        className="media-p405-avatar"
        data-tone={avatarTone(displayName)}
      >
        {displayName.slice(0, 1).toLocaleUpperCase()}
      </div>
      <div className="media-p405-tile-meta">
        <span>{displayName}</span>
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

/** A stable colour slot (0–5) for the camera-off avatar, from the name. */
function avatarTone(name: string): number {
  let hash = 0;
  for (const character of name) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  }
  return hash % 6;
}

function ParticipantRail({
  attachedVideoItemIDs,
  items,
  onTogglePin,
  pinnedID,
}: {
  attachedVideoItemIDs: ReadonlySet<string>;
  items: readonly MediaLayoutItem[];
  onTogglePin: MediaTileProps["onTogglePin"];
  pinnedID: string | null;
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
            onTogglePin={onTogglePin}
            pinned={pinnedID === item.id}
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

function LeaveRoomDialog({ onLeave }: { onLeave: () => void }) {
  const { t } = useI18n();
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          className="media-p405-dock-leave"
          id="media-p405-control-leave"
          leadingIcon={<LogOut />}
          variant="danger"
        >
          {t("media.p405.leave")}
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel={t("media.p405.leaveCancel")} data-theme="dark">
        <DialogTitle>{t("media.p405.leaveTitle")}</DialogTitle>
        <DialogDescription>
          {t("media.p405.leaveDescription")}
        </DialogDescription>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">{t("media.p405.leaveCancel")}</Button>
          </DialogClose>
          <Button onClick={onLeave} variant="danger">
            {t("media.p405.leaveConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

function toolCaptionKey(toolID: ClassroomToolID): TranslationKey {
  switch (toolID) {
    case "whiteboard":
      return "media.room.dock.board";
  }
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

function instanceRoleKey(
  role: ClassroomSignalProjection["roster"][number]["instance_role"],
): TranslationKey {
  return `media.p406.role.${role}` as TranslationKey;
}

function connectionStateKey(
  state: ClassroomSignalProjection["roster"][number]["connection_state"],
): TranslationKey {
  return `media.p406.connection.${state}` as TranslationKey;
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
