import {
  APIRequestError,
  createMediaSpaceJoinAttempt,
  getMediaSpace,
  issueMediaSpaceJoinCredential,
  recoverMediaSpace,
  rotateCSRFToken,
  updateProfile,
  type ProfileResponse,
  type RecoverMediaSpaceRequest,
} from "@tutorhub/api-client";
import { useQuery } from "@tanstack/react-query";
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@tutorhub/ui";
import {
  AlertTriangle,
  EllipsisVertical,
  Layers,
  Mic,
  MicOff,
  PowerOff,
  RefreshCw,
  Sparkles,
  Video,
  VideoOff,
  Volume2,
} from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { useI18n, type TranslationKey } from "../app/i18n";
import { isAllowedLiveKitServerURL } from "../app/media";
import {
  clearMediaRoomEscrow,
  MediaPrejoinController,
  NO_VISUAL_EFFECTS,
  probeMediaNetwork,
  putMediaRoomEscrow,
  type MediaAudioMode,
  type MediaJoinChoices,
  type MediaJoinAttemptProjection,
  type MediaNetworkStatus,
  type MediaPrejoinErrorCode,
  type MediaPrejoinSnapshot,
} from "../app/mediaPrejoin";
import {
  mediaLobbyIdempotencyKey,
  useCancelMediaJoinAttempt,
  useMediaJoinAttemptStatus,
} from "../app/mediaLobby";
import { useSession } from "../app/session";
import {
  mediaDiagnosticNetwork,
  mediaDiagnosticPath,
  recordBoundedMediaDiagnostic,
} from "../app/mediaDiagnostics";
import { MediaSpaceInvitePanel } from "../components/MediaSpaceInvitePanel";
import { VisualEffectsPicker } from "../components/VisualEffectsPicker";
import {
  DEFAULT_VISUAL_EFFECTS,
  effectiveVisualEffects,
  hasActiveVisualEffects,
  loadVisualEffectsPreference,
  resolveVisualEffectsPlan,
  saveVisualEffectsPreference,
  useCustomBackgrounds,
  visualEffectsScopeKey,
  visualEffectsSummaryKey,
  type ClassroomVisualEffectsState,
  type MediaVisualEffectsRuntime,
  type VisualEffectsScope,
} from "../app/visualEffects";
import { SignInLegalDialog } from "./SignInLegalDialog";
import type { SignInLegalTab } from "./signInLegalContent";
import "./SignInPage.css";
import "./MediaSpacePrejoin.css";

type JoinStatus =
  | "idle"
  | "creating_attempt"
  | "waiting"
  | "credential"
  | "denied"
  | "cancelled"
  | "timeout"
  | "meeting_ended"
  | "provider_unavailable"
  | "failed";
interface MediaJoinState {
  scopeKey: string;
  status: JoinStatus;
  errorKey: TranslationKey | null;
  attempt: MediaJoinAttemptProjection | null;
  choices: MediaJoinChoices | null;
}
/** The Pre-Join name input accepts this many characters (the API allows 120). */
const prejoinDisplayNameLimit = 80;

/** Marks a failed profile save so it maps to its own, actionable message. */
class PrejoinNameSaveError extends Error {
  constructor() {
    super("prejoin_display_name_not_saved");
    this.name = "PrejoinNameSaveError";
  }
}
const unsupportedSnapshot: MediaPrejoinSnapshot = {
  status: "degraded",
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
  actualAudioProcessing: {
    echoCancellation: null,
    noiseSuppression: null,
    autoGainControl: null,
  },
  errorCode: "media_capture_unsupported_or_policy_blocked",
  announcement: "",
  speakerTestStatus: "unsupported",
  effectsStatus: "off",
};

/** ADR-0041: the effects pipeline is only fetched once an effect runs. */
function loadVisualEffectsRuntime(): Promise<MediaVisualEffectsRuntime> {
  return import("../features/media/visualEffectsProcessor").then(
    (module) => module.visualEffectsRuntime,
  );
}

export function MediaSpacePreJoinPage() {
  const { spaceId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = prejoinReturnPath(location.state);
  const classTitle = prejoinClassTitle(location.state);
  const { language, t } = useI18n();
  const session = useSession();
  const tenantId = session.currentUser?.active_tenant?.id ?? "";
  const userId = session.currentUser?.user.id ?? "";
  // Only the display name is ever rendered; the account email never is.
  const sessionDisplayName = session.currentUser?.user.display_name ?? "";
  // `null` until the viewer types, so the field follows the session name
  // (including when the session finishes loading) without an effect.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [rememberName, setRememberName] = useState(true);
  const nameFieldId = useId();
  const nameValue = nameDraft ?? sessionDisplayName;
  // The camera frame shows the typed name, or the account name when empty.
  const previewName = nameValue.trim() || sessionDisplayName.trim();
  const [legalOpen, setLegalOpen] = useState(false);
  const [legalTab, setLegalTab] = useState<SignInLegalTab>("agreement");
  const legalReturnFocus = useRef<HTMLElement | null>(null);
  const [joinState, setJoinState] = useState<MediaJoinState>({
    scopeKey: "",
    status: "idle",
    errorKey: null,
    attempt: null,
    choices: null,
  });
  const [networkStatus, setNetworkStatus] =
    useState<MediaNetworkStatus>("checking");
  const [networkLatency, setNetworkLatency] = useState<
    "fast" | "moderate" | "slow" | "unknown"
  >("unknown");
  const [recoveryCommand, setRecoveryCommand] =
    useState<RecoverMediaSpaceRequest | null>(null);
  const [recoveryPending, setRecoveryPending] = useState(false);
  const [recoveryError, setRecoveryError] = useState(false);
  const handoffCreated = useRef(false);
  const terminalHeading = useRef<HTMLHeadingElement>(null);
  const waitingHeading = useRef<HTMLHeadingElement>(null);
  const cameraToggle = useRef<HTMLButtonElement>(null);
  const allowFocusHandoff = useRef(false);
  const activeJoinRequest = useRef<AbortController | null>(null);
  const cancelCommand = useRef<{ attemptID: string; key: string } | null>(null);
  const joinScopeKey = `${tenantId}\u0000${userId}\u0000${spaceId ?? ""}`;
  const joinStateIsCurrent = joinState.scopeKey === joinScopeKey;
  const currentJoinStatus: JoinStatus = joinStateIsCurrent
    ? joinState.status
    : "idle";
  const currentJoinErrorKey = joinStateIsCurrent ? joinState.errorKey : null;
  const currentJoinAttempt = joinStateIsCurrent ? joinState.attempt : null;

  const supported = Boolean(
    typeof navigator !== "undefined" &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function" &&
    typeof navigator.mediaDevices.enumerateDevices === "function",
  );
  const controller = useMemo(() => {
    if (!supported || !spaceId || !tenantId || !userId) {
      return null;
    }
    return new MediaPrejoinController({
      loadVisualEffects: loadVisualEffectsRuntime,
    });
  }, [spaceId, supported, tenantId, userId]);
  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? emptySubscribe,
    controller?.getSnapshot ?? getUnsupportedSnapshot,
    getUnsupportedSnapshot,
  );
  const previewActive =
    snapshot.status === "preview_ready" ||
    snapshot.status === "switching_device";
  // A stable ref callback: an inline arrow would detach and re-attach the
  // preview stream on every render (the mic meter re-renders often).
  const attachPreview = useCallback(
    (element: HTMLVideoElement | null) => controller?.attachPreview(element),
    [controller],
  );
  const attachEffectsPreview = useCallback(
    (element: HTMLVideoElement | null) =>
      controller?.attachPreview(element, "effects"),
    [controller],
  );

  // ADR-0041 visual effects: a per-(tenant, user) choice that never opens the
  // camera by itself. It follows the viewer into the classroom.
  const effectsScope = useMemo<VisualEffectsScope | null>(
    () => (tenantId && userId ? { tenantId, userId } : null),
    [tenantId, userId],
  );
  const effectsScopeKey = effectsScope
    ? visualEffectsScopeKey(effectsScope)
    : "";
  const [effectsChoice, setEffectsChoice] = useState(() => ({
    scopeKey: effectsScopeKey,
    state: loadVisualEffectsPreference(effectsScope),
  }));
  let chosenEffects = effectsChoice.state;
  if (effectsChoice.scopeKey !== effectsScopeKey) {
    // Another workspace or account: restore that principal's own choice.
    const restored = {
      scopeKey: effectsScopeKey,
      state: loadVisualEffectsPreference(effectsScope),
    };
    setEffectsChoice(restored);
    chosenEffects = restored.state;
  }
  const backgroundLibrary = useCustomBackgrounds(effectsScope);
  const libraryStatus = backgroundLibrary.status;
  const libraryUrlFor = backgroundLibrary.urlFor;
  const visualEffects = useMemo(
    () =>
      effectiveVisualEffects(chosenEffects, {
        status: libraryStatus,
        urlFor: libraryUrlFor,
      }),
    [chosenEffects, libraryStatus, libraryUrlFor],
  );
  const visualEffectsPlan = useMemo(
    () => resolveVisualEffectsPlan(visualEffects, libraryUrlFor),
    [libraryUrlFor, visualEffects],
  );
  const [effectsOpen, setEffectsOpen] = useState(false);
  const effectsDescriptionId = useId();

  useEffect(() => {
    controller?.setVisualEffects(visualEffects, visualEffectsPlan);
  }, [controller, visualEffects, visualEffectsPlan]);

  // "Allow microphone and camera" leaves the frame once access is granted;
  // keep keyboard focus on the camera button that now sits in its place.
  useLayoutEffect(() => {
    if (!allowFocusHandoff.current) {
      return;
    }
    if (snapshot.permissionGranted) {
      allowFocusHandoff.current = false;
      cameraToggle.current?.focus();
    } else if (snapshot.status === "degraded") {
      allowFocusHandoff.current = false;
    }
  }, [snapshot.permissionGranted, snapshot.status]);

  useEffect(() => {
    if (!controller) {
      return;
    }
    controller.connect();
    return () => {
      void controller.disconnect();
      if (!handoffCreated.current) {
        clearMediaRoomEscrow();
      }
    };
  }, [controller]);

  useEffect(() => {
    const abort = new AbortController();
    void probeMediaNetwork({ signal: abort.signal }).then((result) => {
      if (!abort.signal.aborted) {
        setNetworkStatus(result.status);
        setNetworkLatency(result.latency);
      }
    });
    return () => abort.abort();
  }, [spaceId, tenantId, userId]);

  useEffect(
    () => () => {
      activeJoinRequest.current?.abort();
      activeJoinRequest.current = null;
      cancelCommand.current = null;
    },
    [spaceId, tenantId, userId],
  );

  const mediaSpace = useQuery({
    enabled: Boolean(spaceId && tenantId),
    queryKey: ["media-space-prejoin", tenantId, spaceId],
    queryFn: ({ signal }) => getMediaSpace(tenantId, spaceId ?? "", { signal }),
    retry: false,
  });
  const projectedRoom = mediaSpace.data?.active_room_instance;
  const joinAttemptStatus = useMediaJoinAttemptStatus(
    tenantId,
    spaceId ?? "",
    currentJoinAttempt?.join_attempt_id ?? "",
    projectedRoom?.id ?? "",
    mediaSpace.data?.version ?? 0,
    projectedRoom?.version ?? 0,
    currentJoinStatus === "waiting",
  );
  const cancelJoinAttempt = useCancelMediaJoinAttempt(tenantId, spaceId ?? "");

  const recoverFailedRoom = async () => {
    const space = mediaSpace.data;
    const failedRoom = space?.recovery_room_instance;
    const command =
      recoveryCommand ??
      (space && failedRoom
        ? {
            expected_space_version: space.version,
            expected_room_instance_id: failedRoom.id,
            expected_room_instance_version: failedRoom.version,
            idempotency_key: `media-recover-${globalThis.crypto.randomUUID()}`,
          }
        : null);
    if (!spaceId || !tenantId || !command || recoveryPending) return;
    setRecoveryCommand(command);
    setRecoveryPending(true);
    setRecoveryError(false);
    try {
      const csrf = await rotateCSRFToken();
      await recoverMediaSpace(tenantId, spaceId, command, csrf.csrf_token);
      setRecoveryCommand(null);
      await mediaSpace.refetch();
    } catch {
      setRecoveryError(true);
      await mediaSpace.refetch();
    } finally {
      setRecoveryPending(false);
    }
  };

  const completeCredentialHandoff = useCallback(
    async (
      attempt: MediaJoinAttemptProjection,
      choices: MediaJoinChoices,
      csrfToken: string,
      abort: AbortController,
    ) => {
      if (
        !spaceId ||
        !tenantId ||
        !userId ||
        (attempt.status !== "admitted" && attempt.status !== "joining")
      ) {
        return;
      }
      setJoinState({
        scopeKey: joinScopeKey,
        status: "credential",
        errorKey: null,
        attempt,
        choices,
      });
      const credentialStartedAt = performance.now();
      const credential = await issueMediaSpaceJoinCredential(
        tenantId,
        spaceId,
        { join_attempt_id: attempt.join_attempt_id },
        csrfToken,
        { signal: abort.signal },
      );
      if (abort.signal.aborted) {
        return;
      }
      if (
        credential.room_instance_id !== attempt.room_instance_id ||
        credential.participant_session_id !== attempt.participant_session_id ||
        credential.join_attempt_id !== attempt.join_attempt_id ||
        !isAllowedLiveKitServerURL(credential.server_url) ||
        Date.parse(credential.expires_at) <= Date.now()
      ) {
        throw new Error("invalid_media_credential_projection");
      }
      void recordBoundedMediaDiagnostic({
        tenantID: tenantId,
        spaceID: spaceId,
        roomInstanceID: credential.room_instance_id,
        joinAttemptID: credential.join_attempt_id,
        stage: "credential",
        outcome: "succeeded",
        networkQuality: mediaDiagnosticNetwork(networkLatency),
        mediaPath: mediaDiagnosticPath(choices),
        durationMS: performance.now() - credentialStartedAt,
      });
      // Effects may change while waiting for admission; hand over the latest.
      const latestEffects =
        controller?.choices(false).visualEffects ?? choices.visualEffects;
      await controller?.stopPreview();
      const effectiveChoices = {
        ...choices,
        audioEnabled:
          choices.audioEnabled && credential.can_publish_camera_microphone,
        videoEnabled:
          choices.videoEnabled && credential.can_publish_camera_microphone,
        visualEffects: credential.can_publish_camera_microphone
          ? latestEffects
          : NO_VISUAL_EFFECTS,
      };
      putMediaRoomEscrow({
        scope: {
          tenantId,
          userId,
          spaceId,
          roomInstanceId: credential.room_instance_id,
        },
        credential,
        choices: effectiveChoices,
        classTitle,
      });
      handoffCreated.current = true;
      void navigate(
        `/app/media/spaces/${spaceId}/instances/${credential.room_instance_id}/room`,
      );
    },
    [
      classTitle,
      controller,
      joinScopeKey,
      navigate,
      networkLatency,
      spaceId,
      tenantId,
      userId,
    ],
  );

  /**
   * `profileName` is the edited name to remember, or `null` to join with the
   * account name as it is (no profile request at all).
   */
  const submitJoin = async (
    choices: MediaJoinChoices,
    profileName: string | null,
  ) => {
    const room = mediaSpace.data?.active_room_instance;
    if (
      !spaceId ||
      !tenantId ||
      !userId ||
      !room ||
      room.status !== "active" ||
      mediaSpace.data?.status !== "open" ||
      activeJoinRequest.current !== null ||
      currentJoinStatus === "creating_attempt" ||
      currentJoinStatus === "credential"
    ) {
      return;
    }
    const currentAttempt = currentJoinAttempt;
    setJoinState({
      scopeKey: joinScopeKey,
      status: "creating_attempt",
      errorKey: null,
      attempt: currentAttempt,
      choices,
    });
    const attemptId =
      currentAttempt?.join_attempt_id ?? globalThis.crypto.randomUUID();
    const abort = new AbortController();
    activeJoinRequest.current = abort;
    const joinStartedAt = performance.now();
    try {
      let csrfToken = (await rotateCSRFToken({ signal: abort.signal }))
        .csrf_token;
      if (abort.signal.aborted) {
        return;
      }
      // Save a remembered, edited display name before the join attempt so the
      // room roster and the LiveKit identity issued for this attempt use it.
      const currentUser = session.currentUser;
      if (
        currentUser &&
        profileName &&
        profileName !== currentUser.user.display_name.trim().normalize("NFC")
      ) {
        let profile: ProfileResponse;
        try {
          profile = await updateProfile(
            { display_name: profileName },
            csrfToken,
            { signal: abort.signal },
          );
        } catch {
          if (abort.signal.aborted) {
            return;
          }
          throw new PrejoinNameSaveError();
        }
        if (abort.signal.aborted) {
          return;
        }
        session.replaceCurrentUser({ ...currentUser, user: profile.user });
      }
      let attempt: MediaJoinAttemptProjection;
      try {
        attempt = (await createMediaSpaceJoinAttempt(
          tenantId,
          spaceId,
          {
            join_attempt_id: attemptId,
            expected_room_instance_id: room.id,
            expected_space_version: mediaSpace.data.version,
          },
          csrfToken,
          { signal: abort.signal },
        )) as MediaJoinAttemptProjection;
      } catch (error) {
        // A reloaded Pre-Join page can hold a stale attempt or space version.
        // Drop the local attempt, re-read the space, and retry exactly once.
        if (
          abort.signal.aborted ||
          !(error instanceof APIRequestError) ||
          error.status !== 409
        ) {
          throw error;
        }
        setJoinState((current) =>
          current.scopeKey === joinScopeKey
            ? { ...current, attempt: null }
            : current,
        );
        const refreshed = await mediaSpace.refetch();
        if (abort.signal.aborted) {
          return;
        }
        const refreshedSpace = refreshed.data;
        const refreshedRoom = refreshedSpace?.active_room_instance;
        if (
          refreshed.isError ||
          !refreshedSpace ||
          refreshedSpace.status !== "open" ||
          !refreshedRoom ||
          refreshedRoom.status !== "active"
        ) {
          throw error;
        }
        csrfToken = (await rotateCSRFToken({ signal: abort.signal }))
          .csrf_token;
        if (abort.signal.aborted) {
          return;
        }
        attempt = (await createMediaSpaceJoinAttempt(
          tenantId,
          spaceId,
          {
            join_attempt_id: globalThis.crypto.randomUUID(),
            expected_room_instance_id: refreshedRoom.id,
            expected_space_version: refreshedSpace.version,
          },
          csrfToken,
          { signal: abort.signal },
        )) as MediaJoinAttemptProjection;
      }
      void recordBoundedMediaDiagnostic({
        tenantID: tenantId,
        spaceID: spaceId,
        roomInstanceID: attempt.room_instance_id,
        joinAttemptID: attempt.join_attempt_id,
        stage: "join_attempt",
        outcome: "succeeded",
        networkQuality: mediaDiagnosticNetwork(networkLatency),
        mediaPath: mediaDiagnosticPath(choices),
        durationMS: performance.now() - joinStartedAt,
      });
      if (abort.signal.aborted) {
        return;
      }
      if (attempt.status === "waiting") {
        setJoinState({
          scopeKey: joinScopeKey,
          status: "waiting",
          errorKey: null,
          attempt,
          choices,
        });
        return;
      }
      if (isTerminalJoinStatus(attempt.status)) {
        const terminalStatus: TerminalJoinStatus = attempt.status;
        setJoinState({
          scopeKey: joinScopeKey,
          status: terminalStatus,
          errorKey: null,
          attempt,
          choices,
        });
        return;
      }
      await completeCredentialHandoff(attempt, choices, csrfToken, abort);
    } catch (error) {
      if (abort.signal.aborted) {
        return;
      }
      setJoinState((current) =>
        current.scopeKey === joinScopeKey
          ? {
              ...current,
              status: "failed",
              errorKey: joinProblemKey(error),
            }
          : current,
      );
    } finally {
      if (activeJoinRequest.current === abort) {
        activeJoinRequest.current = null;
      }
    }
  };

  useEffect(() => {
    const attempt = joinAttemptStatus.data;
    const choices =
      currentJoinAttempt?.join_attempt_id === attempt?.join_attempt_id
        ? joinState.choices
        : null;
    if (
      !attempt ||
      !choices ||
      currentJoinStatus !== "waiting" ||
      activeJoinRequest.current !== null
    ) {
      return;
    }
    if (attempt.status === "waiting") {
      setJoinState((current) =>
        current.scopeKey === joinScopeKey &&
        current.attempt?.version !== attempt.version
          ? { ...current, attempt }
          : current,
      );
      return;
    }
    if (isTerminalJoinStatus(attempt.status)) {
      const terminalStatus: TerminalJoinStatus = attempt.status;
      setJoinState((current) =>
        current.scopeKey === joinScopeKey
          ? {
              ...current,
              attempt,
              errorKey: null,
              status: terminalStatus,
            }
          : current,
      );
      return;
    }
    if (attempt.status !== "admitted" && attempt.status !== "joining") {
      return;
    }

    const abort = new AbortController();
    activeJoinRequest.current = abort;
    void (async () => {
      try {
        const csrf = await rotateCSRFToken({ signal: abort.signal });
        if (!abort.signal.aborted) {
          await completeCredentialHandoff(
            attempt,
            choices,
            csrf.csrf_token,
            abort,
          );
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          setJoinState((current) =>
            current.scopeKey === joinScopeKey
              ? {
                  ...current,
                  status: "failed",
                  errorKey: joinProblemKey(error),
                }
              : current,
          );
        }
      } finally {
        if (activeJoinRequest.current === abort) {
          activeJoinRequest.current = null;
        }
      }
    })();
  }, [
    completeCredentialHandoff,
    currentJoinAttempt?.join_attempt_id,
    currentJoinStatus,
    joinAttemptStatus.data,
    joinScopeKey,
    joinState.choices,
  ]);

  // The Join form leaves the right column once a request is sent; move focus
  // to the heading that replaces it so it never drops to the document body.
  useLayoutEffect(() => {
    if (isTerminalJoinStatus(currentJoinStatus)) {
      terminalHeading.current?.focus();
    } else if (currentJoinStatus === "waiting") {
      waitingHeading.current?.focus();
    }
  }, [currentJoinStatus]);

  const cancelWaiting = () => {
    const attempt = currentJoinAttempt;
    if (
      !attempt ||
      !attempt.admission_version ||
      !projectedRoom ||
      cancelJoinAttempt.isPending
    ) {
      return;
    }
    if (cancelCommand.current?.attemptID !== attempt.join_attempt_id) {
      cancelCommand.current = {
        attemptID: attempt.join_attempt_id,
        key: mediaLobbyIdempotencyKey("join-cancel"),
      };
    }
    cancelJoinAttempt.mutate(
      {
        attemptID: attempt.join_attempt_id,
        input: {
          expected_space_version: mediaSpace.data?.version ?? 0,
          expected_room_instance_id: attempt.room_instance_id,
          expected_room_instance_version: projectedRoom.version,
          expected_admission_version: attempt.admission_version,
          idempotency_key: cancelCommand.current.key,
        },
      },
      {
        onSuccess: (cancelled) => {
          cancelCommand.current = null;
          setJoinState((current) =>
            current.scopeKey === joinScopeKey
              ? {
                  ...current,
                  attempt: cancelled,
                  errorKey: null,
                  status: "cancelled",
                }
              : current,
          );
        },
      },
    );
  };

  const resetJoinRequest = () => {
    cancelJoinAttempt.reset();
    cancelCommand.current = null;
    setJoinState({
      scopeKey: joinScopeKey,
      status: "idle",
      errorKey: null,
      attempt: null,
      choices: null,
    });
  };

  const recheckTerminalAdmission = () => {
    setJoinState((current) =>
      current.scopeKey === joinScopeKey
        ? { ...current, status: "waiting", errorKey: null }
        : current,
    );
    void joinAttemptStatus.refetch();
  };

  const frameProps = { classTitle, returnTo };
  if (!spaceId || !tenantId || !userId) {
    return (
      <PrejoinStudioFrame {...frameProps}>
        <MediaSpaceFailure message={t("media.p403.invalidSpace")} />
      </PrejoinStudioFrame>
    );
  }
  if (mediaSpace.isPending) {
    return (
      <PrejoinStudioFrame {...frameProps} busy>
        <p className="media-p403-studio__status" role="status">
          {t("media.p403.loadingSpace")}
        </p>
      </PrejoinStudioFrame>
    );
  }
  if (mediaSpace.isError) {
    return (
      <PrejoinStudioFrame {...frameProps}>
        <section className="media-p403-alert" role="alert">
          <h1>{t("media.p403.spaceUnavailable")}</h1>
          <p>{t("media.p403.spaceUnavailableDescription")}</p>
          <button onClick={() => void mediaSpace.refetch()} type="button">
            {t("state.retry")}
          </button>
        </section>
      </PrejoinStudioFrame>
    );
  }
  const room = projectedRoom;
  const viewerOperations = mediaP404ViewerOperations(
    mediaSpace.data.viewer_operations,
  );
  if (mediaSpace.data.status !== "open" || room?.status !== "active") {
    const failedRoom = mediaSpace.data.recovery_room_instance;
    if (
      mediaSpace.data.status === "open" &&
      ((failedRoom && viewerOperations.canRecover) || recoveryCommand)
    ) {
      return (
        <PrejoinStudioFrame {...frameProps}>
          <section className="media-p403-alert" role="alert">
            <h1>{t("media.p409.recoveryTitle")}</h1>
            <p>
              {t(
                recoveryError
                  ? "media.p409.recoveryRetryDescription"
                  : "media.p409.recoveryDescription",
              )}
            </p>
            <button
              disabled={recoveryPending}
              onClick={() => void recoverFailedRoom()}
              type="button"
            >
              {t(
                recoveryPending
                  ? "media.p409.recoveryPending"
                  : recoveryCommand
                    ? "media.p409.recoveryRetry"
                    : "media.p409.recoveryAction",
              )}
            </button>
          </section>
        </PrejoinStudioFrame>
      );
    }
    return (
      <PrejoinStudioFrame {...frameProps}>
        <MediaSpaceFailure message={t("media.p403.roomNotOpen")} />
      </PrejoinStudioFrame>
    );
  }
  const joinActionLocked =
    currentJoinStatus !== "idle" && currentJoinStatus !== "failed";
  const joinInFlight =
    currentJoinStatus === "creating_attempt" ||
    currentJoinStatus === "credential";
  // While a capture or cleanup runs the device controls stay focusable
  // (aria-disabled) so keyboard focus survives the state change.
  const previewBusy =
    !controller ||
    snapshot.status === "requesting_permission" ||
    snapshot.status === "switching_device" ||
    snapshot.status === "cleaning_up";
  // A sent request carries the devices chosen at that moment; lock the
  // controls so the preview never suggests a change the request lacks.
  const deviceControlsLocked = previewBusy || joinActionLocked;
  const showVideo = previewActive && snapshot.videoEnabled;
  const microphoneState = deviceToggleState(
    snapshot.permissionGranted,
    snapshot.audioEnabled,
  );
  const cameraState = deviceToggleState(
    snapshot.permissionGranted,
    snapshot.videoEnabled,
  );
  const joinPanel =
    currentJoinStatus === "waiting"
      ? "waiting"
      : isTerminalJoinStatus(currentJoinStatus)
        ? "terminal"
        : "actions";
  const speakerPlaying = snapshot.speakerTestStatus === "playing";
  const effectsActive = hasActiveVisualEffects(visualEffects);
  const effectsName = t(visualEffectsSummaryKey(visualEffects));
  const effectsProblem =
    effectsActive &&
    (snapshot.effectsStatus === "unsupported" ||
      snapshot.effectsStatus === "failed" ||
      snapshot.effectsStatus === "overloaded")
      ? snapshot.effectsStatus
      : null;

  const chooseEffects = (next: ClassroomVisualEffectsState) => {
    setEffectsChoice({ scopeKey: effectsScopeKey, state: next });
    saveVisualEffectsPreference(effectsScope, next);
  };

  // The only path from the effects studio to the camera: an explicit press.
  const turnOnCameraForPreview = () => {
    if (!controller || deviceControlsLocked || snapshot.videoEnabled) {
      return;
    }
    void controller.toggleCamera();
  };

  const joinNow = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (joinActionLocked) {
      return;
    }
    const typedName = nameValue.trim().normalize("NFC");
    const accountName =
      session.currentUser?.user.display_name.trim().normalize("NFC") ?? "";
    // An empty field joins with the account name; an unchanged or
    // not-remembered name sends no profile request.
    const profileName =
      rememberName && typedName && typedName !== accountName ? typedName : null;
    void submitJoin(
      controller?.choices(false) ?? listenOnlyChoices(),
      profileName,
    );
  };

  const allowDevices = (event: MouseEvent<HTMLButtonElement>) => {
    if (!controller || deviceControlsLocked) {
      return;
    }
    allowFocusHandoff.current = document.activeElement === event.currentTarget;
    void controller.startPreview();
  };

  // The audio profile may change while a capture runs (the controller
  // re-applies it), so only a sent request locks it.
  const setAudioMode = (mode: MediaAudioMode) => {
    if (!joinActionLocked) {
      controller?.setAudioMode(mode);
    }
  };

  const openLegal = (
    tab: SignInLegalTab,
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    legalReturnFocus.current = event.currentTarget;
    setLegalTab(tab);
    setLegalOpen(true);
  };

  const alerts = (
    <>
      {snapshot.errorCode && (
        <InlineAlert>
          <strong>{t("media.p403.deviceProblem")}</strong>{" "}
          {t(deviceErrorKey(snapshot.errorCode))}
        </InlineAlert>
      )}
      {networkStatus === "offline" && (
        <InlineAlert>{t("media.p403.network.offline")}</InlineAlert>
      )}
      {effectsProblem && (
        <p className="media-p403-fx-notice" role="status">
          {t(`media.fx.status.${effectsProblem}`)}
        </p>
      )}
    </>
  );

  return (
    <PrejoinStudioFrame {...frameProps}>
      <div className="media-p403-clone" aria-busy={joinInFlight}>
        <div className="media-p403-stage">
          <div
            className={[
              "media-p403-preview",
              showVideo && "media-p403-preview--video",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <video
              aria-label={t("media.p403.previewLabel")}
              autoPlay
              muted
              playsInline
              ref={attachPreview}
            />
            {previewName && (
              <p className="media-p403-preview__name">{previewName}</p>
            )}
            <Menu>
              <MenuTrigger asChild>
                <button
                  aria-label={t("media.p403.moreOptions")}
                  className="media-p403-preview__more"
                  title={t("media.p403.moreOptions")}
                  type="button"
                >
                  <EllipsisVertical aria-hidden="true" />
                </button>
              </MenuTrigger>
              <MenuContent align="end" className="media-p403-menu">
                <MenuItem
                  disabled={!controller}
                  onSelect={() =>
                    void (speakerPlaying
                      ? controller?.stopSpeakerTest()
                      : controller?.testSpeaker())
                  }
                >
                  <Volume2 aria-hidden="true" />
                  {speakerPlaying
                    ? t("media.p403.stopSpeaker")
                    : t("media.prejoin.speakerTest")}
                </MenuItem>
                <MenuSeparator />
                <MenuLabel>{t("media.p403.audioMode")}</MenuLabel>
                <MenuRadioGroup
                  onValueChange={(value) => setAudioMode(audioModeValue(value))}
                  value={snapshot.audioMode}
                >
                  <MenuRadioItem disabled={joinActionLocked} value="speech">
                    {t("media.p403.speech")}
                  </MenuRadioItem>
                  <MenuRadioItem
                    disabled={joinActionLocked}
                    value="original_sound"
                  >
                    {t("media.p403.originalSound")}
                  </MenuRadioItem>
                </MenuRadioGroup>
                {previewActive && (
                  <>
                    <MenuSeparator />
                    <MenuItem
                      disabled={joinActionLocked}
                      onSelect={() => void controller?.stopPreview()}
                    >
                      <PowerOff aria-hidden="true" />
                      {t("media.p403.stopPreview")}
                    </MenuItem>
                  </>
                )}
              </MenuContent>
            </Menu>

            {!snapshot.permissionGranted ? (
              <div className="media-p403-preview__invite">
                <p className="media-p403-preview__question">
                  {t("media.p403.inviteQuestion")}
                </p>
                <button
                  aria-disabled={deviceControlsLocked || undefined}
                  className="media-p403-preview__allow"
                  onClick={allowDevices}
                  type="button"
                >
                  {t("media.p403.allowDevices")}
                </button>
              </div>
            ) : !showVideo ? (
              <span aria-hidden="true" className="media-p403-preview__monogram">
                {monogram(previewName)}
              </span>
            ) : null}

            <div
              aria-label={t("media.p403.deviceControls")}
              className="media-p403-preview__controls"
              role="group"
            >
              <DeviceToggle
                device="microphone"
                disabled={deviceControlsLocked}
                level={snapshot.micLevel}
                onToggle={() => void controller?.toggleMicrophone()}
                state={microphoneState}
              />
              <DeviceToggle
                device="camera"
                disabled={deviceControlsLocked}
                onToggle={() => void controller?.toggleCamera()}
                ref={cameraToggle}
                state={cameraState}
              />
              <Dialog onOpenChange={setEffectsOpen} open={effectsOpen}>
                <DialogTrigger asChild>
                  <button
                    aria-describedby={
                      effectsActive ? effectsDescriptionId : undefined
                    }
                    aria-label={t("media.fx.openEffects")}
                    className={`media-p403-round media-p403-round--effects${
                      effectsActive ? " media-p403-round--effects-on" : ""
                    }`}
                    title={t("media.fx.openEffects")}
                    type="button"
                  >
                    <Sparkles aria-hidden="true" />
                    {effectsActive && (
                      <span
                        aria-hidden="true"
                        className="media-p403-round__dot"
                      />
                    )}
                  </button>
                </DialogTrigger>
                <DialogContent
                  aria-describedby={undefined}
                  className="media-p403-fx-dialog"
                  closeLabel={t("media.fx.close")}
                >
                  <DialogTitle className="media-p403-fx-dialog__title">
                    {t("media.fx.title")}
                  </DialogTitle>
                  <div className="media-p403-fx-dialog__body">
                    <div className="media-p403-fx-stage">
                      <div
                        className={[
                          "media-p403-fx-preview",
                          showVideo && "media-p403-fx-preview--video",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      >
                        <video
                          aria-label={t("media.fx.previewLabel")}
                          autoPlay
                          muted
                          playsInline
                          ref={attachEffectsPreview}
                        />
                        {!showVideo && (
                          <div className="media-p403-fx-preview__off">
                            <p>{t("media.fx.cameraOff")}</p>
                            <button
                              aria-disabled={
                                !controller || deviceControlsLocked || undefined
                              }
                              className="media-p403-fx-preview__camera"
                              onClick={turnOnCameraForPreview}
                              type="button"
                            >
                              <Video aria-hidden="true" />
                              {t("media.fx.turnOnCamera")}
                            </button>
                          </div>
                        )}
                        {showVideo && snapshot.effectsStatus === "loading" && (
                          <p className="media-p403-fx-preview__badge">
                            {t("media.fx.status.loading")}
                          </p>
                        )}
                        {effectsActive && (
                          <button
                            aria-label={t("media.fx.resetAll")}
                            className="media-p403-fx-preview__reset"
                            onClick={() =>
                              chooseEffects(DEFAULT_VISUAL_EFFECTS)
                            }
                            title={t("media.fx.resetAll")}
                            type="button"
                          >
                            <Layers aria-hidden="true" />
                          </button>
                        )}
                      </div>
                      <p
                        aria-live="polite"
                        className="media-p403-fx-status"
                        role="status"
                      >
                        {effectsProblem
                          ? t(`media.fx.status.${effectsProblem}`)
                          : ""}
                      </p>
                      <p className="media-p403-fx-hint">
                        {t("media.fx.onDeviceHint")}
                      </p>
                    </div>
                    <div className="media-p403-fx-side">
                      <VisualEffectsPicker
                        library={backgroundLibrary}
                        onChange={chooseEffects}
                        surface="modal"
                        value={visualEffects}
                      />
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
              {effectsActive && (
                <span className="visually-hidden" id={effectsDescriptionId}>
                  {t("media.fx.activeDescription", { name: effectsName })}
                </span>
              )}
              {!snapshot.permissionGranted && (
                <span className="visually-hidden" id={permissionHintId}>
                  {t("media.p403.permissionHint")}
                </span>
              )}
            </div>
          </div>

          <div
            aria-label={t("media.p403.devicesLabel")}
            className="media-p403-pills"
            role="group"
          >
            {snapshot.permissionGranted && controller ? (
              <>
                <DevicePill
                  disabled={joinActionLocked}
                  icon={<Mic />}
                  label={t("media.prejoin.microphone")}
                  onChange={(value) =>
                    void controller.switchDevice("audioinput", value)
                  }
                  value={snapshot.selectedMicrophoneId}
                >
                  <DeviceOptions
                    devices={snapshot.microphones}
                    emptyLabel={t("media.p403.noDevice")}
                  />
                </DevicePill>
                <DevicePill
                  disabled={joinActionLocked}
                  icon={<Volume2 />}
                  label={t("media.p403.speaker")}
                  onChange={(value) => controller.setSpeakerDevice(value)}
                  value={snapshot.selectedSpeakerId}
                >
                  <option value="">{t("media.p403.systemDefault")}</option>
                  {snapshot.speakers.map((item) => (
                    <option key={item.deviceId} value={item.deviceId}>
                      {item.label}
                    </option>
                  ))}
                </DevicePill>
                <DevicePill
                  disabled={joinActionLocked}
                  icon={<Video />}
                  label={t("media.prejoin.camera")}
                  onChange={(value) =>
                    void controller.switchDevice("videoinput", value)
                  }
                  value={snapshot.selectedCameraId}
                >
                  <DeviceOptions
                    devices={snapshot.cameras}
                    emptyLabel={t("media.p403.noDevice")}
                  />
                </DevicePill>
                <DevicePill
                  disabled={joinActionLocked}
                  icon={<Sparkles />}
                  label={t("media.p403.audioMode")}
                  onChange={(value) => setAudioMode(audioModeValue(value))}
                  value={snapshot.audioMode}
                >
                  <option value="speech">{t("media.p403.speech")}</option>
                  <option value="original_sound">
                    {t("media.p403.originalSound")}
                  </option>
                </DevicePill>
              </>
            ) : (
              // Before access is granted nothing is enumerated: four quiet,
              // disabled placeholders keep the row's shape.
              (
                [
                  ["microphone", <Mic key="icon" />],
                  ["speaker", <Volume2 key="icon" />],
                  ["camera", <Video key="icon" />],
                  ["audioMode", <Sparkles key="icon" />],
                ] as const
              ).map(([kind, icon]) => (
                <DevicePill
                  disabled
                  icon={icon}
                  key={kind}
                  label={t(pillLabelKey[kind])}
                  onChange={ignoreChange}
                  value=""
                >
                  <option value="">{t("media.p403.permissionNeeded")}</option>
                </DevicePill>
              ))
            )}
          </div>
        </div>

        <div className="media-p403-side">
          {joinPanel === "actions" && (
            <form className="media-p403-form" noValidate onSubmit={joinNow}>
              <h1>{t("media.p403.title")}</h1>
              <label className="media-p403-form__label" htmlFor={nameFieldId}>
                {t("media.p403.nameLabel")}
              </label>
              <input
                autoComplete="name"
                className="media-p403-form__name"
                id={nameFieldId}
                maxLength={prejoinDisplayNameLimit}
                onChange={(event) => setNameDraft(event.currentTarget.value)}
                readOnly={joinActionLocked}
                spellCheck={false}
                type="text"
                value={nameValue}
              />
              <label className="media-p403-form__remember">
                <input
                  checked={rememberName}
                  disabled={joinActionLocked}
                  onChange={(event) =>
                    setRememberName(event.currentTarget.checked)
                  }
                  type="checkbox"
                />
                <span>{t("media.p403.rememberName")}</span>
              </label>
              <button
                aria-disabled={joinActionLocked || undefined}
                className="media-p403-form__join"
                type="submit"
              >
                {joinInFlight ? t("media.p403.joining") : t("media.p403.join")}
              </button>
              {currentJoinErrorKey && (
                <section className="media-p403-inline-alert" role="alert">
                  <AlertTriangle aria-hidden="true" />
                  <div>
                    <h2>{t("media.prejoin.cannotJoin")}</h2>
                    <p>{t(currentJoinErrorKey)}</p>
                  </div>
                </section>
              )}
              {alerts}
              <p className="media-p403-form__terms">
                {t("media.p403.termsLead")}
                <button
                  aria-haspopup="dialog"
                  className="media-p403-form__link"
                  onClick={(event) => openLegal("agreement", event)}
                  type="button"
                >
                  {t("media.p403.termsOfService")}
                </button>
                {t("media.p403.termsJoin")}
                <button
                  aria-haspopup="dialog"
                  className="media-p403-form__link"
                  onClick={(event) => openLegal("privacy", event)}
                  type="button"
                >
                  {t("media.p403.privacyStatement")}
                </button>
                {t("media.p403.termsTail")}
              </p>
            </form>
          )}

          {joinPanel === "waiting" && (
            <section className="media-p403-waitroom">
              <h1 ref={waitingHeading} tabIndex={-1}>
                {t("media.p403.waitingTitle")}
              </h1>
              <p aria-live="polite" role="status">
                {t("media.p403.waitingDescription")}
              </p>
              {currentJoinAttempt?.expires_at && (
                <p className="media-p403-waitroom__expiry">
                  {t("media.p404.waiting.expiresAt", {
                    time: formatLobbyExpiry(
                      currentJoinAttempt.expires_at,
                      language,
                    ),
                  })}
                </p>
              )}
              <div className="media-p403-side__actions">
                <Button
                  disabled={joinAttemptStatus.isFetching}
                  leadingIcon={<RefreshCw />}
                  onClick={() => void joinAttemptStatus.refetch()}
                  size="md"
                  variant="secondary"
                >
                  {joinAttemptStatus.isFetching
                    ? t("media.p404.waiting.checking")
                    : t("media.p403.checkAdmission")}
                </Button>
                <Button
                  disabled={
                    cancelJoinAttempt.isPending ||
                    !currentJoinAttempt?.admission_version
                  }
                  onClick={cancelWaiting}
                  size="md"
                  variant="quiet"
                >
                  {cancelJoinAttempt.isPending
                    ? t("media.p404.waiting.cancelling")
                    : t("media.p404.waiting.cancel")}
                </Button>
              </div>
              {(joinAttemptStatus.isError || cancelJoinAttempt.isError) && (
                <p className="media-p404-error" role="alert">
                  {t(
                    cancelJoinAttempt.isError
                      ? "media.p404.waiting.cancelError"
                      : "media.p404.waiting.statusError",
                  )}
                </p>
              )}
              {alerts}
            </section>
          )}

          {joinPanel === "terminal" &&
            isTerminalJoinStatus(currentJoinStatus) && (
              <section
                className={`media-p403-terminal media-p403-terminal--${terminalJoinTone(
                  currentJoinStatus,
                )}`}
                role="alert"
              >
                <h1 ref={terminalHeading} tabIndex={-1}>
                  {t(terminalJoinTitleKey(currentJoinStatus))}
                </h1>
                <p>{t(terminalJoinDescriptionKey(currentJoinStatus))}</p>
                {(currentJoinStatus === "cancelled" ||
                  currentJoinStatus === "timeout") && (
                  <div className="media-p403-side__actions">
                    <Button
                      onClick={resetJoinRequest}
                      size="md"
                      variant="secondary"
                    >
                      {t("media.p404.waiting.newRequest")}
                    </Button>
                  </div>
                )}
                {(currentJoinStatus === "denied" ||
                  currentJoinStatus === "provider_unavailable") && (
                  <div className="media-p403-side__actions">
                    <Button
                      onClick={recheckTerminalAdmission}
                      size="md"
                      variant="secondary"
                    >
                      {t("media.p404.waiting.checkAgain")}
                    </Button>
                  </div>
                )}
              </section>
            )}
        </div>
      </div>

      <span aria-live="polite" className="visually-hidden">
        {snapshot.speakerTestStatus === "idle"
          ? ""
          : t(speakerStatusKey(snapshot.speakerTestStatus))}
      </span>
      {snapshot.announcement && (
        <p className="sr-only" role="status" aria-live="polite">
          {t("media.p403.deviceReset")}
        </p>
      )}

      <SignInLegalDialog
        activeTab={legalTab}
        // Reading the terms here is informational; nothing is recorded.
        onAccept={() => undefined}
        onOpenChange={setLegalOpen}
        onTabChange={setLegalTab}
        open={legalOpen}
        returnFocusRef={legalReturnFocus}
      />

      <MediaSpaceInvitePanel
        enabled={
          mediaSpace.data.source.kind === "study_meeting" &&
          viewerOperations.canManageInvites
        }
        spaceID={spaceId}
        spaceVersion={mediaSpace.data.version}
        tenantID={tenantId}
      />
    </PrejoinStudioFrame>
  );
}

function emptySubscribe(): () => void {
  return () => undefined;
}

function getUnsupportedSnapshot(): MediaPrejoinSnapshot {
  return unsupportedSnapshot;
}

function ignoreChange(): void {
  // Placeholder pills are disabled; there is nothing to change yet.
}

function audioModeValue(value: string): MediaAudioMode {
  return value === "original_sound" ? "original_sound" : "speech";
}

const permissionHintId = "media-p403-permission-hint";

const pillLabelKey = {
  microphone: "media.prejoin.microphone",
  speaker: "media.p403.speaker",
  camera: "media.prejoin.camera",
  audioMode: "media.p403.audioMode",
} as const satisfies Record<string, TranslationKey>;

type DeviceToggleState = "needs-permission" | "on" | "off";

function deviceToggleState(
  permissionGranted: boolean,
  enabled: boolean,
): DeviceToggleState {
  if (!permissionGranted) return "needs-permission";
  return enabled ? "on" : "off";
}

/**
 * Round microphone / camera button inside the camera frame. The accessible
 * name stays "Microphone" / "Camera" and `aria-pressed` reports on/off; before
 * access is granted a yellow "!" marks it and the hint explains the prompt.
 * It stays focusable while a capture runs (aria-disabled instead of disabled).
 */
const DeviceToggle = forwardRef<
  HTMLButtonElement,
  {
    device: "microphone" | "camera";
    disabled: boolean;
    level?: number;
    onToggle: () => void;
    state: DeviceToggleState;
  }
>(function DeviceToggle({ device, disabled, level = 0, onToggle, state }, ref) {
  const { t } = useI18n();
  const on = state === "on";
  const label =
    device === "microphone"
      ? t("media.prejoin.microphone")
      : t("media.prejoin.camera");
  const Icon =
    device === "microphone"
      ? state === "off"
        ? MicOff
        : Mic
      : state === "off"
        ? VideoOff
        : Video;
  const levelStyle =
    device === "microphone" && on
      ? ({ "--media-p403-level": String(level) } as CSSProperties)
      : undefined;
  return (
    <button
      aria-describedby={
        state === "needs-permission" ? permissionHintId : undefined
      }
      aria-disabled={disabled || undefined}
      aria-label={label}
      aria-pressed={on}
      className={`media-p403-round media-p403-round--${state}`}
      onClick={() => {
        if (!disabled) onToggle();
      }}
      ref={ref}
      style={levelStyle}
      title={label}
      type="button"
    >
      <Icon aria-hidden="true" />
      {state === "needs-permission" && (
        <span aria-hidden="true" className="media-p403-round__badge">
          !
        </span>
      )}
    </button>
  );
});

/** One of the four slim device pills under the camera frame. */
function DevicePill({
  children,
  disabled,
  icon,
  label,
  onChange,
  value,
}: {
  children: ReactNode;
  disabled: boolean;
  icon: ReactNode;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <span className="media-p403-pill">
      <span aria-hidden="true" className="media-p403-pill__icon">
        {icon}
      </span>
      <select
        aria-label={label}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
        title={label}
        value={value}
      >
        {children}
      </select>
      <span aria-hidden="true" className="media-p403-pill__caret" />
    </span>
  );
}

function DeviceOptions({
  devices,
  emptyLabel,
}: {
  devices: MediaPrejoinSnapshot["microphones"];
  emptyLabel: string;
}) {
  if (devices.length === 0) {
    return <option value="">{emptyLabel}</option>;
  }
  return (
    <>
      {devices.map((item) => (
        <option key={item.deviceId} value={item.deviceId}>
          {item.label}
        </option>
      ))}
    </>
  );
}

function InlineAlert({ children }: { children: ReactNode }) {
  return (
    <div className="media-p403-inline-alert" role="alert">
      <AlertTriangle aria-hidden="true" />
      <p>{children}</p>
    </div>
  );
}

/** First letters of the first and last name words, e.g. "Student One" → "SO". */
function monogram(name: string): string {
  const words = name.split(/\s+/u).filter(Boolean);
  if (words.length === 0) return "?";
  const first = Array.from(words[0] ?? "")[0] ?? "";
  const last =
    words.length > 1
      ? (Array.from(words[words.length - 1] ?? "")[0] ?? "")
      : "";
  return `${first}${last}`.toLocaleUpperCase();
}

/**
 * Accepts only an in-app destination supplied by a TutorHub launcher so the
 * Pre-Join back link can never become an open redirect.
 */
function prejoinReturnPath(state: unknown): string {
  if (typeof state === "object" && state !== null && "returnTo" in state) {
    const value = (state as { returnTo?: unknown }).returnTo;
    if (
      typeof value === "string" &&
      value.startsWith("/app/") &&
      !value.startsWith("//") &&
      !value.includes("\\") &&
      !value.includes("://")
    ) {
      return value;
    }
  }
  return "/app/home";
}

const prejoinClassTitleLimit = 80;

/**
 * Accepts a launcher-provided class name only as short plain text; anything
 * else is dropped so route state can never inject markup or a huge string.
 */
function prejoinClassTitle(state: unknown): string | null {
  if (typeof state !== "object" || state === null || !("classTitle" in state)) {
    return null;
  }
  const value = (state as { classTitle?: unknown }).classTitle;
  if (typeof value !== "string") {
    return null;
  }
  const normalized = Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : character;
  })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) {
    return null;
  }
  const codePoints = Array.from(normalized);
  return codePoints.length > prejoinClassTitleLimit
    ? `${codePoints.slice(0, prejoinClassTitleLimit).join("").trimEnd()}…`
    : normalized;
}

/**
 * PREJOIN-CLONE-04 frame: a thin header (back link with the class and
 * workspace names on the left, the language switch on the right) over a
 * vertically centred `<main>`, closed by one hairline rule. Rendered for every
 * Pre-Join state so the viewer can always switch language or leave. There is
 * no footer and the account email is never rendered.
 */
function PrejoinStudioFrame({
  busy = false,
  children,
  classTitle,
  returnTo,
}: {
  busy?: boolean;
  children: ReactNode;
  classTitle: string | null;
  returnTo: string;
}) {
  const { language, setLanguage, t } = useI18n();
  const session = useSession();
  const workspaceName = session.currentUser?.active_tenant?.name?.trim() ?? "";

  return (
    <div className="media-p403-page media-p403-studio">
      <header className="media-p403-studio__bar">
        <div className="media-p403-studio__start">
          <Link className="media-p403-studio__back" to={returnTo}>
            {returnTo === "/app/home"
              ? t("media.p403.back")
              : t("media.p403.backToClass")}
          </Link>
          {(classTitle || workspaceName) && (
            <p className="media-p403-studio__context">
              {classTitle && (
                <span className="media-p403-studio__class" title={classTitle}>
                  {classTitle}
                </span>
              )}
              {workspaceName && (
                <span
                  className="media-p403-studio__workspace"
                  title={workspaceName}
                >
                  <span className="visually-hidden">
                    {t("workspace.activeLabel")}:{" "}
                  </span>
                  {workspaceName}
                </span>
              )}
            </p>
          )}
        </div>
        <label className="language-select">
          <span className="visually-hidden">{t("shell.language")}</span>
          <select
            aria-label={t("shell.language")}
            onChange={(event) =>
              setLanguage(event.target.value as typeof language)
            }
            value={language}
          >
            <option value="vi">Tiếng Việt</option>
            <option value="en">English</option>
          </select>
        </label>
      </header>
      <main aria-busy={busy || undefined} className="media-p403-studio__main">
        {children}
      </main>
    </div>
  );
}

function MediaSpaceFailure({ message }: { message: string }) {
  const { t } = useI18n();
  return (
    <section className="media-p403-alert" role="alert">
      <h1>{t("media.prejoin.unavailableTitle")}</h1>
      <p>{message}</p>
      <Link to="/app/home">{t("media.p403.back")}</Link>
    </section>
  );
}

function listenOnlyChoices(): MediaJoinChoices {
  return {
    audioEnabled: false,
    videoEnabled: false,
    audioDeviceId: "",
    videoDeviceId: "",
    speakerDeviceId: "",
    audioMode: "speech",
    visualEffects: NO_VISUAL_EFFECTS,
  };
}

function formatLobbyExpiry(expiresAt: string, language: "vi" | "en"): string {
  const parsed = new Date(expiresAt);
  if (!Number.isFinite(parsed.getTime())) {
    return expiresAt;
  }
  return new Intl.DateTimeFormat(language === "vi" ? "vi-VN" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

function deviceErrorKey(code: MediaPrejoinErrorCode): TranslationKey {
  return `media.p403.error.${code}` as TranslationKey;
}

// Core API puts the machine-readable reason in `problem.code`; `problem.type`
// is the generic `urn:tutorhub:problem:http-<status>`. Accept both so an older
// or proxied response that encodes the reason as a type suffix still maps.
function joinProblemMatches(error: APIRequestError, code: string): boolean {
  return (
    error.problem?.code === code ||
    (error.problem?.type ?? "").endsWith(`:${code}`)
  );
}

function joinProblemKey(error: unknown): TranslationKey {
  if (error instanceof PrejoinNameSaveError) {
    return "media.p403.nameSaveError";
  }
  if (error instanceof APIRequestError) {
    if (joinProblemMatches(error, "room_not_open"))
      return "media.p403.roomNotOpen";
    if (joinProblemMatches(error, "room_locked"))
      return "media.p403.roomLocked";
    if (joinProblemMatches(error, "admission_required"))
      return "media.p403.waitingDescription";
    if (joinProblemMatches(error, "feature_disabled"))
      return "media.p403.featureDisabled";
    if (joinProblemMatches(error, "quota_exceeded"))
      return "media.p403.quotaExceeded";
    if (joinProblemMatches(error, "participant_session_conflict"))
      return "media.p403.participantConflict";
    if (error.status === 404) return "media.p403.spaceUnavailableDescription";
    if (error.status === 429) return "media.p403.rateLimited";
    if (error.status === 503) return "media.p403.providerUnavailable";
  }
  return "media.prejoin.joinError";
}

function speakerStatusKey(
  status: MediaPrejoinSnapshot["speakerTestStatus"],
): TranslationKey {
  return `media.p403.speaker.${status}` as TranslationKey;
}

type TerminalJoinStatus = Extract<
  JoinStatus,
  "denied" | "cancelled" | "timeout" | "meeting_ended" | "provider_unavailable"
>;

function isTerminalJoinStatus(
  status: JoinStatus | MediaJoinAttemptProjection["status"],
): status is TerminalJoinStatus {
  return (
    status === "denied" ||
    status === "cancelled" ||
    status === "timeout" ||
    status === "meeting_ended" ||
    status === "provider_unavailable"
  );
}

/** Leaving or an expired request is neutral; a denial or outage is an error. */
function terminalJoinTone(status: TerminalJoinStatus): "neutral" | "danger" {
  return status === "denied" || status === "provider_unavailable"
    ? "danger"
    : "neutral";
}

function terminalJoinTitleKey(status: TerminalJoinStatus): TranslationKey {
  return `media.p404.waiting.${status}.title` as TranslationKey;
}

function terminalJoinDescriptionKey(
  status: TerminalJoinStatus,
): TranslationKey {
  return `media.p404.waiting.${status}.description` as TranslationKey;
}

function mediaP404ViewerOperations(value: unknown): {
  canManageAdmissions: boolean;
  canManageInvites: boolean;
  canRecover: boolean;
} {
  if (typeof value !== "object" || value === null) {
    return {
      canManageAdmissions: false,
      canManageInvites: false,
      canRecover: false,
    };
  }
  const operations = value as Record<string, unknown>;
  return {
    canManageAdmissions: operations.can_manage_admissions === true,
    canManageInvites: operations.can_manage_invites === true,
    canRecover: operations.can_recover === true,
  };
}
