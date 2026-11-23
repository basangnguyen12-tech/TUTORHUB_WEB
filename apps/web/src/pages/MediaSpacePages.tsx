import {
  APIRequestError,
  createMediaSpaceJoinAttempt,
  getMediaSpace,
  issueMediaSpaceJoinCredential,
  recoverMediaSpace,
  rotateCSRFToken,
  type RecoverMediaSpaceRequest,
} from "@tutorhub/api-client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@tutorhub/ui";
import { Building2, MicOff, VideoOff } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { useI18n, type TranslationKey } from "../app/i18n";
import { isAllowedLiveKitServerURL } from "../app/media";
import {
  clearMediaRoomEscrow,
  MediaPrejoinController,
  probeMediaNetwork,
  putMediaRoomEscrow,
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
import { MediaDiagnosticsPanel } from "../components/MediaDiagnosticsPanel";
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
const unsupportedSnapshot: MediaPrejoinSnapshot = {
  status: "degraded",
  permissionGranted: false,
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
};

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
  const organizationRole = session.currentUser?.active_tenant?.role ?? "";
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
    return new MediaPrejoinController();
  }, [spaceId, supported, tenantId, userId]);
  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? emptySubscribe,
    controller?.getSnapshot ?? getUnsupportedSnapshot,
    getUnsupportedSnapshot,
  );
  const previewActive =
    snapshot.status === "preview_ready" ||
    snapshot.status === "switching_device";
  const placeholderPreviewAction = useRef<HTMLButtonElement>(null);
  const activePreviewAction = useRef<HTMLButtonElement>(null);
  const previewFocusHandoff = useRef(false);

  // The device-check button lives inside the 16:9 frame while the preview is
  // off and below it once the preview runs. Keep keyboard focus on the
  // equivalent control when one replaces the other instead of dropping it.
  useLayoutEffect(() => {
    if (!previewFocusHandoff.current) {
      return;
    }
    const target = previewActive
      ? activePreviewAction.current
      : placeholderPreviewAction.current;
    if (target) {
      previewFocusHandoff.current = false;
      target.focus();
    }
  }, [previewActive]);

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
      await controller?.stopPreview();
      const effectiveChoices = {
        ...choices,
        audioEnabled:
          choices.audioEnabled && credential.can_publish_camera_microphone,
        videoEnabled:
          choices.videoEnabled && credential.can_publish_camera_microphone,
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
      });
      handoffCreated.current = true;
      void navigate(
        `/app/media/spaces/${spaceId}/instances/${credential.room_instance_id}/room`,
      );
    },
    [
      controller,
      joinScopeKey,
      navigate,
      networkLatency,
      spaceId,
      tenantId,
      userId,
    ],
  );

  const submitJoin = async (choices: MediaJoinChoices) => {
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

  useLayoutEffect(() => {
    if (isTerminalJoinStatus(currentJoinStatus)) {
      terminalHeading.current?.focus();
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
  const previewButtonDisabled =
    !controller ||
    snapshot.status === "requesting_permission" ||
    snapshot.status === "switching_device";
  const previewButtonLabel = snapshot.permissionGranted
    ? t("media.p403.retryPreview")
    : t("media.p403.startPreview");

  return (
    <PrejoinStudioFrame {...frameProps}>
      <div className="media-p403-heading">
        <p>{t("media.prejoin.kicker")}</p>
        <h1>{t("media.p403.title")}</h1>
        <span>{t("media.p403.description")}</span>
      </div>

      <section className="media-p403-grid" aria-busy={joinInFlight}>
        <div className="media-p403-preview-panel">
          <div
            className={`media-p403-preview${
              previewActive ? " media-p403-preview--active" : ""
            }`}
          >
            <video
              aria-label={t("media.p403.previewLabel")}
              autoPlay
              muted
              playsInline
              ref={(element) => controller?.attachPreview(element)}
            />
            {!previewActive && (
              <div className="media-p403-preview-placeholder">
                <span
                  aria-hidden="true"
                  className="media-p403-preview-placeholder__icons"
                >
                  <VideoOff />
                  <MicOff />
                </span>
                <strong>{t("media.p403.previewOff")}</strong>
                <span>{t("media.p403.previewConsent")}</span>
                <Button
                  className="media-p403-preview-placeholder__action"
                  disabled={previewButtonDisabled}
                  onClick={(event) => {
                    previewFocusHandoff.current =
                      document.activeElement === event.currentTarget;
                    void controller?.startPreview();
                  }}
                  ref={placeholderPreviewAction}
                  size="md"
                  variant="primary"
                >
                  {previewButtonLabel}
                </Button>
              </div>
            )}
          </div>

          {previewActive && (
            <div className="media-p403-actions">
              <Button
                disabled={previewButtonDisabled}
                onClick={() => void controller?.startPreview()}
                ref={activePreviewAction}
                size="md"
                variant="secondary"
              >
                {previewButtonLabel}
              </Button>
              <Button
                onClick={(event) => {
                  previewFocusHandoff.current =
                    document.activeElement === event.currentTarget;
                  void controller?.stopPreview();
                }}
                size="md"
                variant="quiet"
              >
                {t("media.p403.stopPreview")}
              </Button>
            </div>
          )}

          {snapshot.errorCode && (
            <section className="media-p403-alert" role="alert">
              <strong>{t("media.p403.deviceProblem")}</strong>
              <p>{t(deviceErrorKey(snapshot.errorCode))}</p>
            </section>
          )}

          {snapshot.permissionGranted && controller && (
            <DeviceControls controller={controller} snapshot={snapshot} />
          )}
        </div>

        <aside
          className="media-p403-readiness"
          aria-label={t("media.p403.readinessLabel")}
        >
          <h2>{t("media.p403.readyHeading")}</h2>
          <p className="media-p403-readiness__lead">
            {t("media.p403.readyDescription")}
          </p>

          <div className="media-p403-join-actions">
            <Button
              className="media-p403-join-primary"
              disabled={joinActionLocked}
              onClick={() =>
                void submitJoin(
                  controller?.choices(false) ?? listenOnlyChoices(),
                )
              }
              size="lg"
              variant="primary"
            >
              {joinInFlight
                ? t("media.p403.joining")
                : t("media.p403.joinWithDevices")}
            </Button>
            <Button
              className="media-p403-join-secondary"
              disabled={joinActionLocked}
              onClick={() =>
                void submitJoin(
                  controller?.choices(true) ?? listenOnlyChoices(),
                )
              }
              size="md"
              variant="secondary"
            >
              {t("media.p403.joinListenOnly")}
            </Button>
          </div>
          {currentJoinErrorKey && (
            <section
              className="media-p403-alert media-p403-join-error"
              role="alert"
            >
              <h2>{t("media.prejoin.cannotJoin")}</h2>
              <p>{t(currentJoinErrorKey)}</p>
              <button
                onClick={() => {
                  setJoinState((current) =>
                    current.scopeKey === joinScopeKey
                      ? { ...current, status: "idle", errorKey: null }
                      : {
                          scopeKey: joinScopeKey,
                          status: "idle",
                          errorKey: null,
                          attempt: null,
                          choices: null,
                        },
                  );
                }}
                type="button"
              >
                {t("state.retry")}
              </button>
            </section>
          )}

          <dl>
            <div>
              <dt>{t("media.p403.network")}</dt>
              <dd aria-live="polite">
                {t(networkStatusKey(networkStatus))}
                {networkStatus === "ready" && networkLatency !== "unknown"
                  ? ` · ${t(networkLatencyKey(networkLatency))}`
                  : ""}
              </dd>
            </div>
            <div>
              <dt>{t("media.p403.effect")}</dt>
              <dd>{t("media.p403.effectNone")}</dd>
            </div>
          </dl>
          <p className="media-p403-readiness__note">
            {t("media.p403.networkPrivacy")}
          </p>
        </aside>
      </section>

      {currentJoinStatus === "waiting" && (
        <section className="media-p403-waiting">
          <h2>{t("media.p403.waitingTitle")}</h2>
          <p aria-live="polite" role="status">
            {t("media.p403.waitingDescription")}
          </p>
          {currentJoinAttempt?.expires_at && (
            <p>
              {t("media.p404.waiting.expiresAt", {
                time: formatLobbyExpiry(
                  currentJoinAttempt.expires_at,
                  language,
                ),
              })}
            </p>
          )}
          <button
            disabled={joinAttemptStatus.isFetching}
            onClick={() => void joinAttemptStatus.refetch()}
            type="button"
          >
            {joinAttemptStatus.isFetching
              ? t("media.p404.waiting.checking")
              : t("media.p403.checkAdmission")}
          </button>
          <button
            disabled={
              cancelJoinAttempt.isPending ||
              !currentJoinAttempt?.admission_version
            }
            onClick={cancelWaiting}
            type="button"
          >
            {cancelJoinAttempt.isPending
              ? t("media.p404.waiting.cancelling")
              : t("media.p404.waiting.cancel")}
          </button>
          {(joinAttemptStatus.isError || cancelJoinAttempt.isError) && (
            <p className="media-p404-error" role="alert">
              {t(
                cancelJoinAttempt.isError
                  ? "media.p404.waiting.cancelError"
                  : "media.p404.waiting.statusError",
              )}
            </p>
          )}
        </section>
      )}

      {isTerminalJoinStatus(currentJoinStatus) && (
        <section className="media-p403-alert" role="alert">
          <h2 ref={terminalHeading} tabIndex={-1}>
            {t(terminalJoinTitleKey(currentJoinStatus))}
          </h2>
          <p>{t(terminalJoinDescriptionKey(currentJoinStatus))}</p>
          <div className="media-p404-terminal-actions">
            {(currentJoinStatus === "cancelled" ||
              currentJoinStatus === "timeout") && (
              <button onClick={resetJoinRequest} type="button">
                {t("media.p404.waiting.newRequest")}
              </button>
            )}
            {(currentJoinStatus === "denied" ||
              currentJoinStatus === "provider_unavailable") && (
              <button onClick={recheckTerminalAdmission} type="button">
                {t("media.p404.waiting.checkAgain")}
              </button>
            )}
          </div>
        </section>
      )}

      {snapshot.announcement && (
        <p className="sr-only" role="status" aria-live="polite">
          {t("media.p403.deviceReset")}
        </p>
      )}

      <MediaSpaceInvitePanel
        enabled={
          mediaSpace.data.source.kind === "study_meeting" &&
          viewerOperations.canManageInvites
        }
        spaceID={spaceId}
        spaceVersion={mediaSpace.data.version}
        tenantID={tenantId}
      />
      {organizationRole === "org_admin" && (
        <MediaDiagnosticsPanel tenantID={tenantId} />
      )}
    </PrejoinStudioFrame>
  );
}

function emptySubscribe(): () => void {
  return () => undefined;
}

function getUnsupportedSnapshot(): MediaPrejoinSnapshot {
  return unsupportedSnapshot;
}

function DeviceControls({
  controller,
  snapshot,
}: {
  controller: MediaPrejoinController;
  snapshot: MediaPrejoinSnapshot;
}) {
  const { t } = useI18n();
  const submitAudioMode = (event: FormEvent<HTMLInputElement>) => {
    controller.setAudioMode(
      event.currentTarget.value === "original_sound"
        ? "original_sound"
        : "speech",
    );
  };
  return (
    <div className="media-p403-device-controls">
      <label>
        <span>{t("media.prejoin.microphone")}</span>
        <select
          onChange={(event) =>
            void controller.switchDevice(
              "audioinput",
              event.currentTarget.value,
            )
          }
          value={snapshot.selectedMicrophoneId}
        >
          {snapshot.microphones.map((item) => (
            <option key={item.deviceId} value={item.deviceId}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{t("media.prejoin.camera")}</span>
        <select
          onChange={(event) =>
            void controller.switchDevice(
              "videoinput",
              event.currentTarget.value,
            )
          }
          value={snapshot.selectedCameraId}
        >
          {snapshot.cameras.map((item) => (
            <option key={item.deviceId} value={item.deviceId}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{t("media.p403.speaker")}</span>
        <select
          onChange={(event) =>
            controller.setSpeakerDevice(event.currentTarget.value)
          }
          value={snapshot.selectedSpeakerId}
        >
          <option value="">{t("media.p403.systemDefault")}</option>
          {snapshot.speakers.map((item) => (
            <option key={item.deviceId} value={item.deviceId}>
              {item.label}
            </option>
          ))}
        </select>
      </label>

      <div className="media-p403-meter">
        <label htmlFor="media-p403-mic-level">{t("media.p403.micLevel")}</label>
        <meter
          id="media-p403-mic-level"
          min="0"
          max="1"
          value={snapshot.micLevel}
        />
      </div>

      <fieldset>
        <legend>{t("media.p403.audioMode")}</legend>
        <label>
          <input
            checked={snapshot.audioMode === "speech"}
            name="media-audio-mode"
            onChange={submitAudioMode}
            type="radio"
            value="speech"
          />
          {t("media.p403.speech")}
        </label>
        <label>
          <input
            checked={snapshot.audioMode === "original_sound"}
            name="media-audio-mode"
            onChange={submitAudioMode}
            type="radio"
            value="original_sound"
          />
          {t("media.p403.originalSound")}
        </label>
      </fieldset>

      <p className="media-p403-processing">
        {t("media.p403.actualProcessing", {
          echo: processingValue(
            snapshot.actualAudioProcessing.echoCancellation,
            t,
          ),
          noise: processingValue(
            snapshot.actualAudioProcessing.noiseSuppression,
            t,
          ),
          gain: processingValue(
            snapshot.actualAudioProcessing.autoGainControl,
            t,
          ),
        })}
      </p>

      <div className="media-p403-speaker-actions">
        <button
          disabled={snapshot.speakerTestStatus === "playing"}
          onClick={() => void controller.testSpeaker()}
          type="button"
        >
          {snapshot.speakerTestStatus === "playing"
            ? t("media.prejoin.speakerPlaying")
            : t("media.prejoin.speakerTest")}
        </button>
        {snapshot.speakerTestStatus === "playing" && (
          <button
            onClick={() => void controller.stopSpeakerTest()}
            type="button"
          >
            {t("media.p403.stopSpeaker")}
          </button>
        )}
        <span aria-live="polite">
          {t(speakerStatusKey(snapshot.speakerTestStatus))}
        </span>
      </div>
    </div>
  );
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
 * PREJOIN-UX-01 focused studio frame: a thin header (back link, brand, class,
 * workspace, language) above a centred `<main>`, rendered for every Pre-Join
 * state so the viewer can always switch language or leave.
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
          <span aria-hidden="true" className="media-p403-studio__divider" />
          <span className="media-p403-studio__brand">
            <span aria-hidden="true" className="media-p403-studio__mark">
              TH
            </span>
            <strong>{t("brand.product")}</strong>
            {classTitle && (
              <span className="media-p403-studio__class" title={classTitle}>
                <span className="visually-hidden">
                  {t("media.p403.studioClass")}:{" "}
                </span>
                {classTitle}
              </span>
            )}
          </span>
        </div>
        <div className="media-p403-studio__end">
          {workspaceName && (
            <span
              className="media-p403-studio__workspace"
              title={workspaceName}
            >
              <Building2 aria-hidden="true" />
              <span className="visually-hidden">
                {t("workspace.activeLabel")}:{" "}
              </span>
              <span className="media-p403-studio__workspace-name">
                {workspaceName}
              </span>
            </span>
          )}
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
        </div>
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

function networkStatusKey(status: MediaNetworkStatus): TranslationKey {
  return `media.p403.network.${status}` as TranslationKey;
}

function networkLatencyKey(
  latency: "fast" | "moderate" | "slow",
): TranslationKey {
  return `media.p403.network.${latency}` as TranslationKey;
}

function speakerStatusKey(
  status: MediaPrejoinSnapshot["speakerTestStatus"],
): TranslationKey {
  return `media.p403.speaker.${status}` as TranslationKey;
}

function processingValue(
  value: boolean | null,
  t: (key: TranslationKey, values?: Record<string, string | number>) => string,
): string {
  if (value === null) return t("media.p403.unknown");
  return value ? t("media.p403.on") : t("media.p403.off");
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
