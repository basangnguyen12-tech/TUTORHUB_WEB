import type {
  ClassroomVisualEffectsState,
  MediaVisualEffectsRuntime,
  StandaloneVisualEffectsHandle,
  VisualEffectsRenderPlan,
} from "./visualEffects";

export const MEDIA_PREJOIN_ERROR_CODES = [
  "media_permission_denied_or_blocked",
  "media_device_not_found",
  "media_device_busy_or_unreadable",
  "media_constraints_unavailable",
  "media_probe_aborted",
  "media_capture_unsupported_or_policy_blocked",
  "audio_output_selection_unsupported",
  "media_playback_blocked",
  "media_device_unknown",
] as const;

export type MediaPrejoinErrorCode = (typeof MEDIA_PREJOIN_ERROR_CODES)[number];

export type MediaPrejoinStatus =
  | "idle"
  | "requesting_permission"
  | "preview_ready"
  | "switching_device"
  | "degraded"
  | "cleaning_up";

export type MediaAudioMode = "speech" | "original_sound";

export type SpeakerTestStatus =
  "idle" | "playing" | "success" | "blocked" | "unsupported" | "failed";

/**
 * Local visual-effects pipeline state for the preview. `off` covers both "no
 * effect chosen" and "camera off": a choice never opens the camera by itself.
 */
export type MediaPrejoinEffectsStatus =
  "off" | "loading" | "active" | "unsupported" | "failed" | "overloaded";

export interface MediaDeviceChoice {
  deviceId: string;
  label: string;
}

export interface MediaPrejoinSnapshot {
  status: MediaPrejoinStatus;
  permissionGranted: boolean;
  /** The microphone track is live and capturing (not muted by the user). */
  audioEnabled: boolean;
  /** A live camera track is attached to the preview. */
  videoEnabled: boolean;
  microphones: readonly MediaDeviceChoice[];
  cameras: readonly MediaDeviceChoice[];
  speakers: readonly MediaDeviceChoice[];
  selectedMicrophoneId: string;
  selectedCameraId: string;
  selectedSpeakerId: string;
  audioMode: MediaAudioMode;
  micLevel: number;
  actualAudioProcessing: {
    echoCancellation: boolean | null;
    noiseSuppression: boolean | null;
    autoGainControl: boolean | null;
  };
  errorCode: MediaPrejoinErrorCode | null;
  announcement: string;
  speakerTestStatus: SpeakerTestStatus;
  effectsStatus: MediaPrejoinEffectsStatus;
}

export interface MediaJoinChoices {
  audioEnabled: boolean;
  videoEnabled: boolean;
  audioDeviceId: string;
  videoDeviceId: string;
  speakerDeviceId: string;
  audioMode: MediaAudioMode;
  /** ADR-0041: carried through the memory escrow into the classroom. */
  visualEffects: ClassroomVisualEffectsState;
}

/**
 * The neutral effects choice. Defined here (not in `visualEffects.ts`) so this
 * entry-chunk module never pulls the effects module into the initial bundle.
 */
export const NO_VISUAL_EFFECTS: ClassroomVisualEffectsState = Object.freeze({
  background: Object.freeze({ kind: "none" }),
  lighting: Object.freeze({ brightness: "normal", tone: "natural" }),
}) as ClassroomVisualEffectsState;

/** IndexedDB database that holds personal background images (ADR-0041). */
export const VISUAL_EFFECTS_DATABASE_NAME = "tutorhub-visual-effects";
/** localStorage prefix for the light, per-(tenant, user) effect preference. */
export const VISUAL_EFFECTS_PREFERENCE_PREFIX = "tutorhub.visual-effects.v1:";

/**
 * Removes every stored effect preference and the personal background
 * database. Lives in this entry-chunk module so sign-out clears private
 * effect data without loading (or depending on the network for) the effects
 * chunk. Best effort and bounded: it never blocks sign-out for long.
 */
export async function clearVisualEffectsDeviceStorage(
  options: {
    storage?: Storage | null;
    databases?: IDBFactory | null;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const storage =
    options.storage === undefined ? safeLocalStorage() : options.storage;
  if (storage) {
    try {
      const keys: string[] = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith(VISUAL_EFFECTS_PREFERENCE_PREFIX)) keys.push(key);
      }
      for (const key of keys) storage.removeItem(key);
    } catch {
      // Storage may be blocked; scoped keys still prevent cross-user reads.
    }
  }
  const databases =
    options.databases === undefined
      ? typeof indexedDB === "undefined"
        ? null
        : indexedDB
      : options.databases;
  if (!databases) return;
  await new Promise<void>((resolve) => {
    const timer = globalThis.setTimeout(resolve, options.timeoutMs ?? 2_000);
    const finish = () => {
      globalThis.clearTimeout(timer);
      resolve();
    };
    try {
      const request = databases.deleteDatabase(VISUAL_EFFECTS_DATABASE_NAME);
      request.onsuccess = finish;
      request.onerror = finish;
      // Another tab still holds a connection: the deletion stays queued and
      // completes once it closes, so sign-out does not wait for it.
      request.onblocked = finish;
    } catch {
      finish();
    }
  });
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export interface MediaJoinAttemptProjection {
  join_attempt_id: string;
  participant_session_id: string;
  room_instance_id: string;
  status:
    | "waiting"
    | "admitted"
    | "joining"
    | "denied"
    | "cancelled"
    | "timeout"
    | "meeting_ended"
    | "provider_unavailable";
  version: number;
  admission_request_id?: string | null;
  admission_version?: number;
  expires_at?: string | null;
}

export interface MediaInstanceCredentialProjection {
  access_token: string;
  server_url: string;
  participant_session_id: string;
  room_instance_id: string;
  join_attempt_id: string;
  instance_role: "host" | "co_host" | "teaching_assistant" | "attendee";
  can_publish_camera_microphone: boolean;
  can_share_screen: boolean;
  can_subscribe: boolean;
  expires_at: string;
}

export interface MediaRoomEscrowScope {
  tenantId: string;
  userId: string;
  spaceId: string;
  roomInstanceId: string;
}

export interface MediaRoomEscrowValue {
  scope: MediaRoomEscrowScope;
  credential: MediaInstanceCredentialProjection;
  choices: MediaJoinChoices;
}

interface MediaRoomEscrowEntry {
  value: MediaRoomEscrowValue;
  claimed: boolean;
}

let mediaRoomEscrow: MediaRoomEscrowEntry | null = null;

export function putMediaRoomEscrow(value: MediaRoomEscrowValue): void {
  mediaRoomEscrow = { value, claimed: false };
}

export function takeMediaRoomEscrow(
  expected: MediaRoomEscrowScope,
): MediaRoomEscrowValue | null {
  const entry = mediaRoomEscrow;
  if (!entry) {
    return null;
  }
  if (!sameEscrowScope(entry.value.scope, expected)) {
    mediaRoomEscrow = null;
    return null;
  }
  // React StrictMode may evaluate a state initializer twice before the first
  // commit. Keep an exact-scope claim readable until that commit, then purge it
  // with finalizeMediaRoomEscrowClaim. The token never leaves process memory.
  entry.claimed = true;
  return entry.value;
}

export function finalizeMediaRoomEscrowClaim(
  expected: MediaRoomEscrowScope,
): void {
  const entry = mediaRoomEscrow;
  if (entry?.claimed && sameEscrowScope(entry.value.scope, expected)) {
    mediaRoomEscrow = null;
  }
}

export function clearMediaRoomEscrow(): void {
  mediaRoomEscrow = null;
}

function sameEscrowScope(
  left: MediaRoomEscrowScope,
  right: MediaRoomEscrowScope,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.userId === right.userId &&
    left.spaceId === right.spaceId &&
    left.roomInstanceId === right.roomInstanceId
  );
}

type AudioOutputElement = Omit<HTMLAudioElement, "setSinkId"> & {
  setSinkId?: (deviceId: string) => Promise<void>;
};

interface MediaPrejoinEnvironment {
  mediaDevices: MediaDevices;
  createAudioContext: () => AudioContext | null;
  createAudioElement: () => AudioOutputElement;
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (handle: number) => void;
  setTimer: (callback: () => void, delay: number) => number;
  clearTimer: (handle: number) => void;
  /**
   * Loads the visual-effects runtime on demand (a dynamic import). Without it
   * the controller only ever shows the raw camera.
   */
  loadVisualEffects: (() => Promise<MediaVisualEffectsRuntime>) | null;
}

export type MediaPreviewSlot = "main" | "effects";

type SnapshotListener = () => void;

type CaptureKind = "audio" | "video";

interface CaptureRequest {
  audio: boolean;
  video: boolean;
}

const emptyAudioProcessing = {
  echoCancellation: null,
  noiseSuppression: null,
  autoGainControl: null,
} as const;

export class MediaPrejoinController {
  private readonly environment: MediaPrejoinEnvironment;
  private readonly listeners = new Set<SnapshotListener>();
  private currentSnapshot: MediaPrejoinSnapshot = {
    status: "idle",
    permissionGranted: false,
    audioEnabled: false,
    videoEnabled: false,
    microphones: [],
    cameras: [],
    speakers: [],
    selectedMicrophoneId: "",
    selectedCameraId: "",
    selectedSpeakerId: "",
    audioMode: "speech",
    micLevel: 0,
    actualAudioProcessing: emptyAudioProcessing,
    errorCode: null,
    announcement: "",
    speakerTestStatus: "idle",
    effectsStatus: "off",
  };
  // Each device kind owns its own track so the camera can be released (and
  // its hardware light turned off) while the microphone keeps running.
  // `ownedTracks` holds every live track this controller must stop exactly
  // once; tracks the browser returns but we did not ask for are stopped at
  // once and never enter it.
  private audioTrack: MediaStreamTrack | null = null;
  private videoTrack: MediaStreamTrack | null = null;
  private audioStream: MediaStream | null = null;
  private videoStream: MediaStream | null = null;
  private readonly ownedTracks = new Set<MediaStreamTrack>();
  private readonly kindGenerations: Record<CaptureKind, number> = {
    audio: 0,
    video: 0,
  };
  private readonly previewElements = new Map<
    MediaPreviewSlot,
    HTMLVideoElement
  >();
  // Visual effects (ADR-0041). The plan is only a choice: it is applied to a
  // camera track that already exists and never opens the camera itself.
  private visualEffectsState: ClassroomVisualEffectsState = NO_VISUAL_EFFECTS;
  private effectsPlan: VisualEffectsRenderPlan | null = null;
  private effectsPlanKey = "";
  private effectsSuspended = false;
  private effectsHandle: StandaloneVisualEffectsHandle | null = null;
  private effectsSource: MediaStreamTrack | null = null;
  private effectsAppliedKey = "";
  private effectsQueue: Promise<void> = Promise.resolve();
  private meterContext: AudioContext | null = null;
  private meterSource: MediaStreamAudioSourceNode | null = null;
  private meterAnalyser: AnalyserNode | null = null;
  private meterFrame: number | null = null;
  private speakerContext: AudioContext | null = null;
  private speakerOscillator: OscillatorNode | null = null;
  private speakerElement: AudioOutputElement | null = null;
  private speakerTimer: number | null = null;
  private speakerGeneration = 0;
  private speakerTestInFlight = false;
  private deviceChangeTimer: number | null = null;
  private generation = 0;
  private connected = false;
  private disposed = false;

  constructor(environment?: Partial<MediaPrejoinEnvironment>) {
    const mediaDevices =
      environment?.mediaDevices ??
      (typeof navigator === "undefined" ? undefined : navigator.mediaDevices);
    if (!mediaDevices) {
      throw new Error("MediaDevices is unavailable");
    }
    this.environment = {
      mediaDevices,
      createAudioContext:
        environment?.createAudioContext ??
        (() => {
          const Constructor = globalThis.AudioContext;
          return Constructor ? new Constructor() : null;
        }),
      createAudioElement:
        environment?.createAudioElement ??
        (() => document.createElement("audio") as AudioOutputElement),
      requestFrame:
        environment?.requestFrame ??
        ((callback) => globalThis.requestAnimationFrame(callback)),
      cancelFrame:
        environment?.cancelFrame ??
        ((handle) => globalThis.cancelAnimationFrame(handle)),
      setTimer:
        environment?.setTimer ??
        ((callback, delay) => globalThis.setTimeout(callback, delay)),
      clearTimer:
        environment?.clearTimer ??
        ((handle) => globalThis.clearTimeout(handle)),
      loadVisualEffects: environment?.loadVisualEffects ?? null,
    };
  }

  getSnapshot = (): MediaPrejoinSnapshot => this.currentSnapshot;

  subscribe = (listener: SnapshotListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  connect(): void {
    if (this.connected || this.disposed) {
      return;
    }
    this.environment.mediaDevices.addEventListener(
      "devicechange",
      this.handleDeviceChange,
    );
    this.connected = true;
  }

  /**
   * Points a preview `<video>` at the camera output (the processed track while
   * an effect runs, the raw track otherwise). The Pre-Join frame uses the
   * `main` slot and the effects studio its own `effects` slot.
   */
  attachPreview(
    element: HTMLVideoElement | null,
    slot: MediaPreviewSlot = "main",
  ): void {
    const previous = this.previewElements.get(slot);
    if (previous && previous !== element) {
      previous.srcObject = null;
    }
    if (element) {
      this.previewElements.set(slot, element);
    } else {
      this.previewElements.delete(slot);
    }
    this.syncPreview();
  }

  /**
   * Records the effects choice and applies it to the live camera, if any.
   * Choosing an effect while the camera is off only stores the choice.
   */
  setVisualEffects(
    state: ClassroomVisualEffectsState,
    plan: VisualEffectsRenderPlan | null,
  ): void {
    if (this.disposed) {
      return;
    }
    this.visualEffectsState = state;
    const key = plan ? JSON.stringify(plan) : "";
    if (key !== this.effectsPlanKey) {
      this.effectsPlanKey = key;
      this.effectsPlan = plan;
      // A new explicit choice is a retry after an overload or failure.
      this.effectsSuspended = false;
    }
    this.scheduleEffects();
  }

  setAudioMode(mode: MediaAudioMode): void {
    if (this.currentSnapshot.audioMode === mode || this.disposed) {
      return;
    }
    this.update({ audioMode: mode });
    // Only the microphone depends on the audio profile; the camera keeps
    // running while the new constraints are applied.
    if (this.audioTrack) {
      void this.acquireKind("audio", this.currentSnapshot.audioEnabled);
    }
  }

  setSpeakerDevice(deviceId: string): void {
    if (this.disposed) {
      return;
    }
    this.update({ selectedSpeakerId: deviceId });
  }

  /**
   * Explicit "test camera and microphone" action: one capture for both
   * devices followed by one device enumeration. Both devices end up enabled.
   */
  async startPreview(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const generation = ++this.generation;
    const status = this.hasLiveTracks()
      ? "switching_device"
      : "requesting_permission";
    this.update({ status, errorCode: null, announcement: "" });
    await this.releasePreviewResources();

    const request = { audio: true, video: true };
    let stream: MediaStream;
    try {
      stream = await this.capture(request);
    } catch (error) {
      this.handleProbeFailure(generation, error);
      return;
    }

    if (this.disposed || generation !== this.generation) {
      stopStream(stream);
      return;
    }
    this.adoptStream(stream, request);
    await this.refreshDevices(false);
    if (this.disposed || generation !== this.generation) {
      await this.releasePreviewResources();
      return;
    }
    if (this.audioStream) {
      this.startMeter(this.audioStream);
    }
    this.update({
      status: "preview_ready",
      permissionGranted: true,
      audioEnabled: Boolean(this.audioTrack),
      videoEnabled: Boolean(this.videoTrack),
      errorCode: null,
      actualAudioProcessing: audioProcessing(this.audioTrack),
    });
  }

  /**
   * Mutes or unmutes the microphone. Without a live microphone track (no
   * permission yet, or the preview was stopped) this user action captures the
   * microphone only, so pressing the microphone never opens the camera.
   */
  async toggleMicrophone(): Promise<void> {
    if (this.disposed || this.isBusy()) {
      return;
    }
    if (this.audioTrack) {
      const enabled = !this.currentSnapshot.audioEnabled;
      this.audioTrack.enabled = enabled;
      this.update({ audioEnabled: enabled, micLevel: 0 });
      return;
    }
    await this.acquireKind("audio", true);
  }

  /**
   * Turning the camera off stops its track so the hardware indicator goes
   * dark; turning it on captures the selected camera again. Without
   * permission this user action captures the camera only.
   */
  async toggleCamera(): Promise<void> {
    if (this.disposed || this.isBusy()) {
      return;
    }
    if (this.videoTrack) {
      ++this.kindGenerations.video;
      this.releaseKind("video");
      this.update({ videoEnabled: false });
      return;
    }
    await this.acquireKind("video", true);
  }

  async switchDevice(
    kind: "audioinput" | "videoinput",
    deviceId: string,
  ): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.update(
      kind === "audioinput"
        ? { selectedMicrophoneId: deviceId }
        : { selectedCameraId: deviceId },
    );
    // A device that is off only records the choice; it opens on next enable.
    if (kind === "audioinput" && this.audioTrack) {
      await this.acquireKind("audio", this.currentSnapshot.audioEnabled);
    } else if (kind === "videoinput" && this.videoTrack) {
      await this.acquireKind("video", true);
    }
  }

  async stopPreview(): Promise<void> {
    if (this.disposed) {
      return;
    }
    ++this.generation;
    this.update({ status: "cleaning_up" });
    await this.releasePreviewResources();
    this.update({
      status: "idle",
      audioEnabled: false,
      videoEnabled: false,
      micLevel: 0,
      actualAudioProcessing: emptyAudioProcessing,
      errorCode: null,
    });
  }

  async testSpeaker(): Promise<void> {
    if (
      this.disposed ||
      this.speakerTestInFlight ||
      this.currentSnapshot.speakerTestStatus === "playing"
    ) {
      return;
    }
    const generation = ++this.speakerGeneration;
    this.speakerTestInFlight = true;

    try {
      await this.releaseSpeakerResources();
      if (!this.speakerOperationIsCurrent(generation)) {
        return;
      }
      const context = this.environment.createAudioContext();
      if (!context) {
        this.update({ speakerTestStatus: "unsupported" });
        return;
      }
      this.speakerContext = context;
      if (!this.speakerOperationIsCurrent(generation)) {
        await this.releaseSpeakerResources();
        return;
      }
      const audio = this.environment.createAudioElement();
      this.speakerElement = audio;
      const selected = this.currentSnapshot.selectedSpeakerId;
      if (selected && typeof audio.setSinkId !== "function") {
        await this.releaseSpeakerResources();
        if (this.speakerOperationIsCurrent(generation)) {
          this.update({
            speakerTestStatus: "unsupported",
            errorCode: "audio_output_selection_unsupported",
          });
        }
        return;
      }
      const destination = context.createMediaStreamDestination();
      const oscillator = context.createOscillator();
      this.speakerOscillator = oscillator;
      oscillator.frequency.value = 440;
      oscillator.connect(destination);
      audio.srcObject = destination.stream;
      if (selected && audio.setSinkId) {
        await audio.setSinkId(selected);
      }
      if (!this.speakerOperationIsCurrent(generation)) {
        return;
      }
      await context.resume();
      if (!this.speakerOperationIsCurrent(generation)) {
        return;
      }
      await audio.play();
      if (!this.speakerOperationIsCurrent(generation)) {
        return;
      }
      oscillator.start();
      this.update({ speakerTestStatus: "playing", errorCode: null });
      this.speakerTimer = this.environment.setTimer(() => {
        void this.releaseSpeakerResources().then(() => {
          if (this.speakerOperationIsCurrent(generation)) {
            this.update({ speakerTestStatus: "success" });
          }
        });
      }, 700);
    } catch (error) {
      await this.releaseSpeakerResources();
      if (!this.speakerOperationIsCurrent(generation)) {
        return;
      }
      const code =
        (error instanceof DOMException || error instanceof Error) &&
        error.name === "NotAllowedError"
          ? "media_playback_blocked"
          : mediaPrejoinErrorCode(error);
      this.update({
        speakerTestStatus:
          code === "media_playback_blocked" ? "blocked" : "failed",
        errorCode: code,
      });
    } finally {
      if (generation === this.speakerGeneration) {
        this.speakerTestInFlight = false;
      }
    }
  }

  async stopSpeakerTest(): Promise<void> {
    ++this.speakerGeneration;
    this.speakerTestInFlight = false;
    await this.releaseSpeakerResources();
    if (!this.disposed) {
      this.update({ speakerTestStatus: "idle" });
    }
  }

  choices(listenOnly = false): MediaJoinChoices {
    return {
      audioEnabled:
        !listenOnly &&
        this.currentSnapshot.audioEnabled &&
        Boolean(this.audioTrack),
      videoEnabled:
        !listenOnly &&
        this.currentSnapshot.videoEnabled &&
        Boolean(this.videoTrack),
      audioDeviceId: listenOnly
        ? ""
        : this.currentSnapshot.selectedMicrophoneId,
      videoDeviceId: listenOnly ? "" : this.currentSnapshot.selectedCameraId,
      speakerDeviceId: this.currentSnapshot.selectedSpeakerId,
      audioMode: this.currentSnapshot.audioMode,
      visualEffects: listenOnly ? NO_VISUAL_EFFECTS : this.visualEffectsState,
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    await this.disconnect();
    this.listeners.clear();
  }

  async disconnect(): Promise<void> {
    ++this.generation;
    ++this.speakerGeneration;
    this.speakerTestInFlight = false;
    if (this.deviceChangeTimer !== null) {
      this.environment.clearTimer(this.deviceChangeTimer);
      this.deviceChangeTimer = null;
    }
    if (this.connected) {
      this.environment.mediaDevices.removeEventListener(
        "devicechange",
        this.handleDeviceChange,
      );
      this.connected = false;
    }
    await Promise.all([
      this.releasePreviewResources(),
      this.releaseSpeakerResources(),
    ]);
  }

  private readonly handleDeviceChange = (): void => {
    if (!this.currentSnapshot.permissionGranted || this.disposed) {
      return;
    }
    if (this.deviceChangeTimer !== null) {
      this.environment.clearTimer(this.deviceChangeTimer);
    }
    this.deviceChangeTimer = this.environment.setTimer(() => {
      this.deviceChangeTimer = null;
      void this.refreshDevices(true);
    }, 150);
  };

  private async refreshDevices(announceFallback: boolean): Promise<void> {
    let devices: MediaDeviceInfo[];
    try {
      devices = await this.environment.mediaDevices.enumerateDevices();
    } catch {
      return;
    }
    if (this.disposed) {
      return;
    }
    const microphones = deviceChoices(devices, "audioinput", "Microphone");
    const cameras = deviceChoices(devices, "videoinput", "Camera");
    const speakers = deviceChoices(devices, "audiooutput", "Speaker");
    const microphone = retainDevice(
      this.currentSnapshot.selectedMicrophoneId,
      microphones,
    );
    const camera = retainDevice(this.currentSnapshot.selectedCameraId, cameras);
    const speaker = retainDevice(
      this.currentSnapshot.selectedSpeakerId,
      speakers,
    );
    const changed =
      Boolean(
        this.currentSnapshot.selectedMicrophoneId && !microphone.retained,
      ) ||
      Boolean(this.currentSnapshot.selectedCameraId && !camera.retained) ||
      Boolean(this.currentSnapshot.selectedSpeakerId && !speaker.retained);
    this.update({
      microphones,
      cameras,
      speakers,
      selectedMicrophoneId: microphone.deviceId,
      selectedCameraId: camera.deviceId,
      selectedSpeakerId: speaker.deviceId,
      announcement:
        announceFallback && changed ? "media_device_selection_reset" : "",
    });
  }

  /**
   * Captures (or replaces) a single device kind without touching the other
   * one. Used by the per-device toggles, device switching and audio-profile
   * changes. The previous track of that kind is stopped first so devices that
   * cannot be opened twice still switch cleanly.
   */
  private async acquireKind(
    kind: CaptureKind,
    enabled: boolean,
  ): Promise<void> {
    if (this.disposed) {
      return;
    }
    const generation = this.generation;
    const kindGeneration = ++this.kindGenerations[kind];
    const isCurrent = () =>
      !this.disposed &&
      generation === this.generation &&
      kindGeneration === this.kindGenerations[kind];
    const hadTracks = this.hasLiveTracks();
    this.releaseKind(kind);
    this.update({
      status: hadTracks ? "switching_device" : "requesting_permission",
      errorCode: null,
      announcement: "",
    });

    const request = { audio: kind === "audio", video: kind === "video" };
    let stream: MediaStream;
    try {
      stream = await this.capture(request);
    } catch (error) {
      if (isCurrent()) {
        this.handleKindFailure(kind, error);
      }
      return;
    }
    if (!isCurrent()) {
      stopStream(stream);
      return;
    }
    this.adoptStream(stream, request);
    await this.refreshDevices(false);
    // A newer stop, restart or same-kind capture has already released what
    // this call adopted.
    if (!isCurrent()) {
      return;
    }
    if (kind === "audio") {
      if (this.audioTrack) {
        this.audioTrack.enabled = enabled;
      }
      if (this.audioStream) {
        this.startMeter(this.audioStream);
      }
    }
    this.update({
      status: "preview_ready",
      permissionGranted: true,
      errorCode: null,
      ...(kind === "audio"
        ? {
            audioEnabled: Boolean(this.audioTrack) && enabled,
            micLevel: 0,
            actualAudioProcessing: audioProcessing(this.audioTrack),
          }
        : { videoEnabled: Boolean(this.videoTrack) }),
    });
  }

  private async capture(request: CaptureRequest): Promise<MediaStream> {
    try {
      return await this.environment.mediaDevices.getUserMedia(
        this.mediaConstraints(request),
      );
    } catch (error) {
      if (!isOverconstrainedError(error)) {
        throw error;
      }
      return this.environment.mediaDevices.getUserMedia({
        audio: request.audio,
        video: request.video,
      });
    }
  }

  private adoptStream(stream: MediaStream, request: CaptureRequest): void {
    const audio = request.audio ? (stream.getAudioTracks()[0] ?? null) : null;
    const video = request.video ? (stream.getVideoTracks()[0] ?? null) : null;
    for (const track of stream.getTracks()) {
      if (track !== audio && track !== video) {
        track.stop();
      }
    }
    if (audio) {
      if (this.currentSnapshot.audioMode === "original_sound") {
        try {
          audio.contentHint = "music";
        } catch {
          // contentHint is progressive enhancement only.
        }
      }
      this.audioTrack = audio;
      this.audioStream = stream;
      this.ownedTracks.add(audio);
    }
    if (video) {
      this.videoTrack = video;
      this.videoStream = stream;
      this.ownedTracks.add(video);
      this.syncPreview();
      this.scheduleEffects();
    }
  }

  private releaseKind(kind: CaptureKind): void {
    if (kind === "audio") {
      void this.stopMeter();
      const track = this.audioTrack;
      this.audioTrack = null;
      this.audioStream = null;
      if (track && this.ownedTracks.delete(track)) {
        track.stop();
      }
      return;
    }
    const track = this.videoTrack;
    this.videoTrack = null;
    this.videoStream = null;
    void this.detachEffects();
    if (track && this.ownedTracks.delete(track)) {
      track.stop();
    }
    this.syncPreview();
    this.scheduleEffects();
  }

  private handleKindFailure(kind: CaptureKind, error: unknown): void {
    this.update({
      status: this.hasLiveTracks() ? "preview_ready" : "degraded",
      errorCode: mediaPrejoinErrorCode(error),
      ...(kind === "audio"
        ? {
            audioEnabled: false,
            micLevel: 0,
            actualAudioProcessing: emptyAudioProcessing,
          }
        : { videoEnabled: false }),
    });
  }

  private hasLiveTracks(): boolean {
    return Boolean(this.audioTrack || this.videoTrack);
  }

  private isBusy(): boolean {
    const { status } = this.currentSnapshot;
    return (
      status === "requesting_permission" ||
      status === "switching_device" ||
      status === "cleaning_up"
    );
  }

  /** Points every preview at the current camera output only when it changed. */
  private syncPreview(): void {
    const stream =
      this.effectsHandle && this.effectsSource === this.videoTrack
        ? this.effectsHandle.stream
        : this.videoStream;
    for (const element of this.previewElements.values()) {
      element.muted = true;
      if (element.srcObject === stream) {
        continue;
      }
      element.srcObject = stream;
      if (stream) {
        void element.play().catch(() => undefined);
      }
    }
  }

  private scheduleEffects(): void {
    this.effectsQueue = this.effectsQueue
      .then(() => this.reconcileEffects())
      .catch(() => undefined);
  }

  /**
   * Serialised: brings the effects pipeline in line with the latest choice and
   * camera track. Every await re-checks that the track and plan it started
   * with are still current, so a newer choice or a stopped camera wins.
   */
  private async reconcileEffects(): Promise<void> {
    const track = this.videoTrack;
    const plan = this.effectsSuspended ? null : this.effectsPlan;
    const planKey = this.effectsPlanKey;
    const load = this.environment.loadVisualEffects;
    if (this.disposed || !track || !plan || !load) {
      await this.detachEffects();
      if (!this.disposed && !this.effectsSuspended) {
        const settled =
          plan && track && !load ? "unsupported" : ("off" as const);
        this.updateEffectsStatus(settled);
      }
      return;
    }
    const isCurrent = () =>
      !this.disposed &&
      !this.effectsSuspended &&
      this.videoTrack === track &&
      this.effectsPlanKey === planKey;

    const handle = this.effectsHandle;
    if (handle && this.effectsSource === track) {
      if (this.effectsAppliedKey === planKey) {
        this.updateEffectsStatus("active");
        return;
      }
      const applied = await handle.apply(plan).catch(() => false);
      if (!isCurrent()) return;
      if (applied) {
        this.effectsAppliedKey = planKey;
        this.updateEffectsStatus("active");
        return;
      }
    }

    await this.detachEffects();
    if (!isCurrent()) return;
    this.updateEffectsStatus("loading");
    let runtime: MediaVisualEffectsRuntime;
    try {
      runtime = await load();
    } catch {
      if (isCurrent()) this.updateEffectsStatus("failed");
      return;
    }
    if (!isCurrent()) return;
    if (!runtime.supportsVisualEffects(plan.mode)) {
      this.updateEffectsStatus("unsupported");
      return;
    }
    let started: StandaloneVisualEffectsHandle;
    try {
      started = await runtime.startStandaloneVisualEffects(track, plan, {
        onOverload: () => this.handleEffectsOverload(started),
      });
    } catch {
      if (isCurrent()) this.updateEffectsStatus("failed");
      return;
    }
    if (!isCurrent()) {
      await started.destroy().catch(() => undefined);
      return;
    }
    this.effectsHandle = started;
    this.effectsSource = track;
    this.effectsAppliedKey = planKey;
    this.syncPreview();
    this.updateEffectsStatus("active");
  }

  /** Runtime guard (ADR-0031 §11): fall back to the raw camera, no auto-retry. */
  private handleEffectsOverload(handle: StandaloneVisualEffectsHandle): void {
    if (this.disposed || this.effectsHandle !== handle) {
      return;
    }
    this.effectsSuspended = true;
    this.updateEffectsStatus("overloaded");
    this.scheduleEffects();
  }

  /** Drops the pipeline reference at once (preview back to raw), then frees it. */
  private detachEffects(): Promise<void> {
    const handle = this.effectsHandle;
    this.effectsHandle = null;
    this.effectsSource = null;
    this.effectsAppliedKey = "";
    this.syncPreview();
    return handle ? handle.destroy().catch(() => undefined) : Promise.resolve();
  }

  private updateEffectsStatus(status: MediaPrejoinEffectsStatus): void {
    if (this.currentSnapshot.effectsStatus !== status) {
      this.update({ effectsStatus: status });
    }
  }

  private mediaConstraints(request: CaptureRequest): MediaStreamConstraints {
    const supported = this.environment.mediaDevices.getSupportedConstraints();
    const original = this.currentSnapshot.audioMode === "original_sound";
    const audio: MediaTrackConstraints = {};
    if (this.currentSnapshot.selectedMicrophoneId) {
      audio.deviceId = { exact: this.currentSnapshot.selectedMicrophoneId };
    }
    if (supported.echoCancellation) {
      audio.echoCancellation = { ideal: !original };
    }
    if (supported.noiseSuppression) {
      audio.noiseSuppression = { ideal: !original };
    }
    if (supported.autoGainControl) {
      audio.autoGainControl = { ideal: !original };
    }
    const video: MediaTrackConstraints = {};
    if (this.currentSnapshot.selectedCameraId) {
      video.deviceId = { exact: this.currentSnapshot.selectedCameraId };
    }
    return {
      audio: request.audio ? audio : false,
      video: request.video ? video : false,
    };
  }

  private handleProbeFailure(generation: number, error: unknown): void {
    if (this.disposed || generation !== this.generation) {
      return;
    }
    this.update({
      status: "degraded",
      audioEnabled: false,
      videoEnabled: false,
      errorCode: mediaPrejoinErrorCode(error),
      micLevel: 0,
      actualAudioProcessing: emptyAudioProcessing,
    });
  }

  private startMeter(stream: MediaStream): void {
    const context = this.environment.createAudioContext();
    if (!context || stream.getAudioTracks().length === 0) {
      if (context) {
        void context.close().catch(() => undefined);
      }
      return;
    }
    try {
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      this.meterContext = context;
      this.meterSource = source;
      this.meterAnalyser = analyser;
      const samples = new Uint8Array(analyser.fftSize);
      const sample = () => {
        if (this.disposed || this.meterAnalyser !== analyser) {
          return;
        }
        let level = 0;
        if (this.currentSnapshot.audioEnabled) {
          analyser.getByteTimeDomainData(samples);
          let peak = 0;
          for (const value of samples) {
            peak = Math.max(peak, Math.abs(value - 128));
          }
          // 5% steps keep the meter smooth without re-rendering every frame.
          level = Math.round(Math.min(1, peak / 64) * 20) / 20;
        }
        if (level !== this.currentSnapshot.micLevel) {
          this.update({ micLevel: level });
        }
        this.meterFrame = this.environment.requestFrame(sample);
      };
      void context.resume().catch(() => undefined);
      this.meterFrame = this.environment.requestFrame(sample);
    } catch {
      void context.close().catch(() => undefined);
    }
  }

  private async stopMeter(): Promise<void> {
    if (this.meterFrame !== null) {
      this.environment.cancelFrame(this.meterFrame);
      this.meterFrame = null;
    }
    this.meterSource?.disconnect();
    this.meterAnalyser?.disconnect();
    this.meterSource = null;
    this.meterAnalyser = null;
    const meterContext = this.meterContext;
    this.meterContext = null;
    if (meterContext) {
      await meterContext.close().catch(() => undefined);
    }
  }

  private async releasePreviewResources(): Promise<void> {
    const meterStopped = this.stopMeter();
    const effectsReleased = this.detachEffects();
    for (const track of this.ownedTracks) {
      track.stop();
    }
    this.ownedTracks.clear();
    this.audioTrack = null;
    this.videoTrack = null;
    this.audioStream = null;
    this.videoStream = null;
    this.syncPreview();
    await Promise.all([meterStopped, effectsReleased]);
  }

  private async releaseSpeakerResources(): Promise<void> {
    const timer = this.speakerTimer;
    this.speakerTimer = null;
    if (timer !== null) {
      this.environment.clearTimer(timer);
    }
    const oscillator = this.speakerOscillator;
    this.speakerOscillator = null;
    if (oscillator) {
      try {
        oscillator.stop();
      } catch {
        // Already stopped.
      }
      oscillator.disconnect();
    }
    const element = this.speakerElement;
    this.speakerElement = null;
    if (element) {
      element.pause();
      element.srcObject = null;
    }
    const context = this.speakerContext;
    this.speakerContext = null;
    if (context) {
      await context.close().catch(() => undefined);
    }
  }

  private speakerOperationIsCurrent(generation: number): boolean {
    return !this.disposed && generation === this.speakerGeneration;
  }

  private update(patch: Partial<MediaPrejoinSnapshot>): void {
    this.currentSnapshot = { ...this.currentSnapshot, ...patch };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function mediaPrejoinErrorCode(error: unknown): MediaPrejoinErrorCode {
  const name =
    error instanceof DOMException || error instanceof Error ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "media_permission_denied_or_blocked";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "media_device_not_found";
    case "NotReadableError":
    case "TrackStartError":
      return "media_device_busy_or_unreadable";
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return "media_constraints_unavailable";
    case "AbortError":
      return "media_probe_aborted";
    case "TypeError":
      return "media_capture_unsupported_or_policy_blocked";
    case "NotSupportedError":
      return "audio_output_selection_unsupported";
    default:
      if (name === "NotAllowedPlaybackError") {
        return "media_playback_blocked";
      }
      return "media_device_unknown";
  }
}

export type MediaNetworkStatus =
  "checking" | "ready" | "offline" | "unavailable";

export interface MediaNetworkProbeResult {
  status: Exclude<MediaNetworkStatus, "checking">;
  latency: "fast" | "moderate" | "slow" | "unknown";
}

export async function probeMediaNetwork(
  options: {
    baseUrl?: string;
    fetch?: typeof globalThis.fetch;
    signal?: AbortSignal;
    online?: boolean;
    now?: () => number;
  } = {},
): Promise<MediaNetworkProbeResult> {
  const online =
    options.online ??
    (typeof navigator === "undefined" ? true : navigator.onLine);
  if (!online) {
    return { status: "offline", latency: "unknown" };
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") {
    return { status: "unavailable", latency: "unknown" };
  }
  const now = options.now ?? (() => performance.now());
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = globalThis.setTimeout(abort, 5_000);
  const baseUrl = (
    options.baseUrl ??
    import.meta.env.VITE_API_BASE_URL ??
    "/api"
  ).replace(/\/$/, "");
  const startedAt = now();
  try {
    const response = await fetcher(`${baseUrl}/health`, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { status: "unavailable", latency: "unknown" };
    }
    const duration = Math.max(0, now() - startedAt);
    return {
      status: "ready",
      latency: duration < 350 ? "fast" : duration < 1_200 ? "moderate" : "slow",
    };
  } catch {
    return {
      status:
        controller.signal.aborted && options.signal?.aborted
          ? "offline"
          : "unavailable",
      latency: "unknown",
    };
  } finally {
    globalThis.clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

function deviceChoices(
  devices: readonly MediaDeviceInfo[],
  kind: MediaDeviceKind,
  genericLabel: string,
): MediaDeviceChoice[] {
  let index = 0;
  return devices
    .filter((device) => device.kind === kind)
    .map((device) => {
      index += 1;
      return {
        deviceId: device.deviceId,
        label: device.label.trim() || `${genericLabel} ${index}`,
      };
    });
}

function retainDevice(
  current: string,
  devices: readonly MediaDeviceChoice[],
): { deviceId: string; retained: boolean } {
  if (current && devices.some((device) => device.deviceId === current)) {
    return { deviceId: current, retained: true };
  }
  return { deviceId: devices[0]?.deviceId ?? "", retained: !current };
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function booleanSetting(value: boolean | undefined): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function audioProcessing(
  track: MediaStreamTrack | null,
): MediaPrejoinSnapshot["actualAudioProcessing"] {
  if (!track) {
    return emptyAudioProcessing;
  }
  const settings = track.getSettings();
  return {
    echoCancellation: booleanSetting(settings.echoCancellation),
    noiseSuppression: booleanSetting(settings.noiseSuppression),
    autoGainControl: booleanSetting(settings.autoGainControl),
  };
}

function isOverconstrainedError(error: unknown): boolean {
  return (
    (error instanceof DOMException || error instanceof Error) &&
    (error.name === "OverconstrainedError" ||
      error.name === "ConstraintNotSatisfiedError")
  );
}
