import {
  getMediaSpace,
  type MediaDiagnosticErrorCode,
} from "@tutorhub/api-client";
import { useQuery } from "@tanstack/react-query";
import { DisconnectReason } from "livekit-client";
import { CodeXml, PenTool } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useI18n, type TranslationKey } from "../app/i18n";
import {
  clearMediaRoomEscrow,
  finalizeMediaRoomEscrowClaim,
  takeMediaRoomEscrow,
} from "../app/mediaPrejoin";
import {
  mediaSignalIdempotencyKey,
  useMediaSignalSnapshot,
  useMutateMediaSignal,
} from "../app/mediaSignals";
import { useMediaModerationControls } from "../app/mediaModeration";
import { useSession } from "../app/session";
import {
  mediaDiagnosticPath,
  recordBoundedMediaDiagnostic,
} from "../app/mediaDiagnostics";
import {
  MediaLobbyPanel,
  MediaLobbyWaitingCountProvider,
} from "../components/MediaLobbyPanel";
import {
  MediaSpaceChatPanel,
  useMediaSpaceRoomChat,
} from "../components/MediaSpaceChatPanel";
import { ClassroomCodeTool } from "../features/classroom-tools/ClassroomCodeTool";
import { createClassroomCodeSession } from "../features/classroom-tools/codeSession";
import { ClassroomWhiteboardTool } from "../features/collaboration/ClassroomWhiteboardTool";
import {
  ClassroomLiveKitRoom,
  type ClassroomLiveKitRoomProps,
} from "../features/media/ClassroomLiveKitRoom";
import type {
  ClassroomConnectionStatus,
  ClassroomSignalControls,
} from "../features/media/ClassroomMediaShell";
import { prefillClassroomChatComposer } from "../features/media/classroomChatMedia";
import {
  projectClassroomSignalSnapshot,
  type ClassroomReactionType,
} from "../features/media/classroomSignals";

import { useTenantCapabilities } from "../app/tenantCapabilities";
import { useWhiteboardTool } from "../app/whiteboards";
import "./ClassroomRoomStage.css";

/** How often a connected room re-reads the whiteboard projection. */
const whiteboardPollIntervalMs = 4_000;

export function MediaSpaceRoomPage() {
  const { spaceId, roomInstanceId } = useParams();
  const session = useSession();
  const tenantId = session.currentUser?.active_tenant?.id ?? "";
  const userId = session.currentUser?.user.id ?? "";
  const scopeKey = `${tenantId}\u0000${userId}\u0000${spaceId ?? ""}\u0000${roomInstanceId ?? ""}`;

  return (
    <MediaSpaceRoomSession
      key={scopeKey}
      roomInstanceId={roomInstanceId}
      spaceId={spaceId}
      tenantId={tenantId}
      userId={userId}
      workspaceName={session.currentUser?.active_tenant?.name ?? null}
    />
  );
}

function MediaSpaceRoomSession({
  roomInstanceId,
  spaceId,
  tenantId,
  userId,
  workspaceName,
}: {
  roomInstanceId: string | undefined;
  spaceId: string | undefined;
  tenantId: string;
  userId: string;
  workspaceName: string | null;
}) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [roomStatus, setRoomStatus] =
    useState<ClassroomConnectionStatus>("connecting");
  const [roomError, setRoomError] = useState<TranslationKey | null>(null);
  const disconnectRecoveryActive = useRef(false);
  const connectStartedAt = useRef(0);
  const reconnectStartedAt = useRef(0);
  const [signalClock, setSignalClock] = useState({
    dataUpdatedAt: 0,
    now: 0,
  });
  const mediaSpace = useQuery({
    enabled: Boolean(spaceId && tenantId),
    queryKey: ["media-space-room", tenantId, spaceId],
    queryFn: ({ signal }) => getMediaSpace(tenantId, spaceId ?? "", { signal }),
    retry: false,
  });
  const tenantCapabilities = useTenantCapabilities(tenantId, Boolean(tenantId));
  const whiteboardEnabled =
    tenantCapabilities.data?.features.classroom_whiteboards.enabled === true;
  const [handoff, setHandoff] = useState(() => {
    if (!spaceId || !roomInstanceId || !tenantId || !userId) {
      clearMediaRoomEscrow();
      return null;
    }
    return takeMediaRoomEscrow({
      tenantId,
      userId,
      spaceId,
      roomInstanceId,
    });
  });
  const handoffMatchesScope = Boolean(
    handoff &&
    handoff.scope.tenantId === tenantId &&
    handoff.scope.userId === userId &&
    handoff.scope.spaceId === spaceId &&
    handoff.scope.roomInstanceId === roomInstanceId,
  );
  const handoffExpired = Boolean(
    handoff && credentialExpired(handoff.credential.expires_at),
  );
  const activeRoom = mediaSpace.data?.active_room_instance;
  // ROOM-SYNC-FIX-01: a brief ICE/transport recovery ("reconnecting") must
  // not tear down the roster and whiteboard projections; only a terminal
  // disconnect stops them.
  const roomLive = roomStatus === "connected" || roomStatus === "reconnecting";
  const viewerOperations = mediaP404ViewerOperations(
    mediaSpace.data?.viewer_operations,
  );
  const signalScopeReady = Boolean(
    tenantId &&
    spaceId &&
    activeRoom?.id === roomInstanceId &&
    activeRoom?.status === "active",
  );
  const signalQuery = useMediaSignalSnapshot(
    tenantId,
    spaceId ?? "",
    roomInstanceId ?? "",
    mediaSpace.data?.version ?? 0,
    activeRoom?.version ?? 0,
    signalScopeReady && roomLive,
  );
  // PREJOIN-UX-01: keep the server whiteboard projection fresh while the room
  // is connected so a viewer's stage follows the presenter. It shares the
  // tool's query key, so the mounted whiteboard reuses this cache entry.
  const whiteboardTool = useWhiteboardTool(
    tenantId,
    spaceId ?? "",
    whiteboardEnabled && signalScopeReady && roomLive,
    { pollIntervalMs: whiteboardPollIntervalMs },
  );
  // ROOM-CHAT-01: the room owns the chat controller so the Dock unread badge
  // syncs before the inspector is first opened and drafts survive closing.
  const [chatOpen, setChatOpen] = useState(false);
  const roomChat = useMediaSpaceRoomChat({
    actorID: userId,
    enabled: signalScopeReady && roomLive,
    mediaSpaceID: spaceId ?? "",
    open: chatOpen,
    tenantID: tenantId,
  });
  // ROOM-TOOLS-CODE-01: per-room-session Code tool memory (open files across
  // Whiteboard ↔ Code switches, chat "Open in Code" queue). "Send to chat"
  // only prefills the composer; the person still presses Send.
  const [codeSession] = useState(createClassroomCodeSession);
  const chatComposerStore = roomChat.composerStore;
  const sendCodeToChat = useCallback(
    (text: string) => prefillClassroomChatComposer(chatComposerStore, text),
    [chatComposerStore],
  );
  const chatCanPost =
    roomChat.conversation?.viewer_access.can_post_messages === true;
  const whiteboardDocument =
    whiteboardEnabled && whiteboardTool.isSuccess
      ? (whiteboardTool.data?.document ?? null)
      : null;
  const whiteboardAutoOpenKey =
    whiteboardDocument?.status === "open" &&
    whiteboardDocument.viewer_capabilities.can_exchange_grant
      ? `${whiteboardDocument.id}:${whiteboardDocument.current_generation}`
      : null;
  const signalMutation = useMutateMediaSignal(
    tenantId,
    spaceId ?? "",
    roomInstanceId ?? "",
    mediaSpace.data?.version ?? 0,
    activeRoom?.version ?? 0,
  );
  const signalProjection = useMemo(() => {
    if (!signalQuery.data) return null;
    const snapshotServerTime = Date.parse(signalQuery.data.server_time);
    const elapsedClientTime =
      signalClock.dataUpdatedAt === signalQuery.dataUpdatedAt
        ? Math.max(0, signalClock.now - signalQuery.dataUpdatedAt)
        : 0;
    return projectClassroomSignalSnapshot(
      signalQuery.data,
      snapshotServerTime + elapsedClientTime,
    );
  }, [signalClock, signalQuery.data, signalQuery.dataUpdatedAt]);

  const reportDiagnostic = useCallback(
    (
      stage:
        | "connect"
        | "media"
        | "reconnecting"
        | "reconnected"
        | "disconnected"
        | "leave",
      outcome: "started" | "succeeded" | "failed" | "cancelled",
      durationMS = 0,
      errorCode?: MediaDiagnosticErrorCode,
    ) => {
      if (!handoff || !spaceId || !roomInstanceId) return;
      void recordBoundedMediaDiagnostic({
        tenantID: tenantId,
        spaceID: spaceId,
        roomInstanceID: roomInstanceId,
        joinAttemptID: handoff.credential.join_attempt_id,
        stage,
        outcome,
        ...(errorCode ? { errorCode } : {}),
        mediaPath: mediaDiagnosticPath(handoff.choices),
        durationMS,
      });
    },
    [handoff, roomInstanceId, spaceId, tenantId],
  );

  useEffect(() => {
    connectStartedAt.current = performance.now();
    reportDiagnostic("connect", "started");
  }, [reportDiagnostic]);

  useEffect(() => {
    if (!signalQuery.data || !roomLive) return undefined;
    const dataUpdatedAt = signalQuery.dataUpdatedAt;
    const timer = globalThis.setInterval(() => {
      setSignalClock({ dataUpdatedAt, now: Date.now() });
    }, 500);
    return () => globalThis.clearInterval(timer);
  }, [roomLive, signalQuery.data, signalQuery.dataUpdatedAt]);

  const runSignalMutation = useCallback(
    async (
      kind:
        | "hand_raise"
        | "hand_lower"
        | "hand_lower_one"
        | "hand_lower_all"
        | "reaction",
      options: {
        reaction?: ClassroomReactionType;
        targetParticipantKey?: string;
      } = {},
    ) => {
      if (!signalProjection) {
        throw new Error("Classroom signal projection is not ready.");
      }
      await signalMutation.mutateAsync({
        expectedProjectionVersion: signalProjection.projection_version,
        idempotencyKey: mediaSignalIdempotencyKey(kind),
        kind,
        reaction: options.reaction,
        targetParticipantKey: options.targetParticipantKey,
      });
    },
    [signalMutation, signalProjection],
  );

  const signalControls = useMemo<ClassroomSignalControls>(
    () => ({
      error: signalQuery.isError,
      loading: signalQuery.isPending,
      mutating: signalMutation.isPending,
      projection: signalProjection,
      refreshing: signalQuery.isFetching && !signalQuery.isPending,
      onLowerAllHands: () => runSignalMutation("hand_lower_all"),
      onLowerHand: (targetParticipantKey) =>
        runSignalMutation("hand_lower_one", { targetParticipantKey }),
      onResync: async () => signalQuery.refetch(),
      onSendReaction: (reaction) => runSignalMutation("reaction", { reaction }),
      onToggleHand: () => {
        const ownHand = signalProjection?.raised_hands.some(
          ({ participant_key }) =>
            participant_key === signalProjection.self_participant_key,
        );
        return runSignalMutation(ownHand ? "hand_lower" : "hand_raise");
      },
    }),
    [
      runSignalMutation,
      signalMutation.isPending,
      signalProjection,
      signalQuery,
    ],
  );

  const handleConnected = useCallback(() => {
    setRoomStatus("connected");
    setRoomError(null);
    if (signalScopeReady) void signalQuery.refetch();
    if (reconnectStartedAt.current > 0) {
      reportDiagnostic(
        "reconnected",
        "succeeded",
        performance.now() - reconnectStartedAt.current,
      );
      reconnectStartedAt.current = 0;
    } else {
      const durationMS =
        connectStartedAt.current > 0
          ? performance.now() - connectStartedAt.current
          : 0;
      reportDiagnostic("media", "succeeded", durationMS);
    }
  }, [reportDiagnostic, signalQuery, signalScopeReady]);

  const handleReconnecting = useCallback(() => {
    reconnectStartedAt.current = performance.now();
    setRoomStatus("reconnecting");
    setRoomError(null);
    reportDiagnostic("reconnecting", "started");
  }, [reportDiagnostic]);

  const finishDisconnected = useCallback(
    (status: Extract<ClassroomConnectionStatus, "disconnected" | "failed">) => {
      setRoomStatus(status);
      setRoomError(
        status === "failed"
          ? "media.p403.providerUnavailable"
          : "media.room.disconnectedDescription",
      );
      setHandoff(null);
      clearMediaRoomEscrow();
    },
    [],
  );

  const handleDisconnected = useCallback(
    (reason?: DisconnectReason) => {
      const outcome = classroomDisconnectOutcome(reason);
      reportDiagnostic(
        "disconnected",
        "failed",
        0,
        disconnectDiagnosticCode(reason),
      );
      finishDisconnected("disconnected");
      setRoomError(outcome.messageKey);
      if (disconnectRecoveryActive.current) return;
      disconnectRecoveryActive.current = true;
      void mediaSpace
        .refetch()
        .then(({ data }) => {
          if (
            outcome.reauthorize &&
            data?.status === "open" &&
            data.active_room_instance?.status === "active" &&
            spaceId
          ) {
            void navigate(`/app/media/spaces/${spaceId}/prejoin`, {
              replace: true,
            });
          }
        })
        .finally(() => {
          disconnectRecoveryActive.current = false;
        });
    },
    [finishDisconnected, mediaSpace, navigate, reportDiagnostic, spaceId],
  );

  const handleProviderError = useCallback(() => {
    reportDiagnostic("disconnected", "failed", 0, "provider_error");
    finishDisconnected("failed");
  }, [finishDisconnected, reportDiagnostic]);

  const handleLeave = useCallback(() => {
    reportDiagnostic("leave", "succeeded");
    finishDisconnected("disconnected");
    void navigate(
      spaceId ? `/app/media/spaces/${spaceId}/prejoin` : "/app/home",
      { replace: true },
    );
  }, [finishDisconnected, navigate, reportDiagnostic, spaceId]);

  const moderationControls = useMediaModerationControls({
    enabled: signalScopeReady && roomStatus === "connected",
    tenantID: tenantId,
    spaceID: spaceId ?? "",
    roomInstanceID: roomInstanceId ?? "",
    expectedSpaceVersion: mediaSpace.data?.version ?? 0,
    expectedRoomInstanceVersion: activeRoom?.version ?? 0,
    projection: signalProjection,
    onRoomEnded: handleLeave,
  });

  useEffect(() => {
    if (!handoff || mediaSpace.data?.status !== "ended") return undefined;
    const frame = globalThis.requestAnimationFrame(handleLeave);
    return () => globalThis.cancelAnimationFrame(frame);
  }, [handoff, handleLeave, mediaSpace.data?.status]);

  useEffect(() => {
    if (
      handoffMatchesScope &&
      !handoffExpired &&
      spaceId &&
      roomInstanceId &&
      tenantId &&
      userId
    ) {
      finalizeMediaRoomEscrowClaim({
        tenantId,
        userId,
        spaceId,
        roomInstanceId,
      });
    }
  }, [
    handoffExpired,
    handoffMatchesScope,
    roomInstanceId,
    spaceId,
    tenantId,
    userId,
  ]);

  useEffect(() => {
    if (handoff && (!handoffMatchesScope || handoffExpired)) {
      clearMediaRoomEscrow();
    }
  }, [handoff, handoffExpired, handoffMatchesScope]);

  useEffect(
    () => () => {
      clearMediaRoomEscrow();
    },
    [],
  );

  if (
    !spaceId ||
    !roomInstanceId ||
    !handoff ||
    !handoffMatchesScope ||
    handoffExpired
  ) {
    return (
      <main className="media-p403-room-recovery">
        <h1>{t("media.room.recoveryTitle")}</h1>
        <p>{t(roomError ?? "media.room.credentialMissing")}</p>
        <Link
          to={spaceId ? `/app/media/spaces/${spaceId}/prejoin` : "/app/home"}
        >
          {t("media.room.returnToPrejoin")}
        </Link>
      </main>
    );
  }

  const lobbyScopeActive =
    viewerOperations.canManageAdmissions &&
    activeRoom?.id === roomInstanceId &&
    activeRoom.status === "active";
  const lobbyScope = {
    enabled: lobbyScopeActive,
    roomInstanceID: activeRoom?.id ?? "",
    roomInstanceVersion: activeRoom?.version ?? 0,
    spaceID: spaceId,
    spaceVersion: mediaSpace.data?.version ?? 0,
    tenantID: tenantId,
  };
  const lobby = lobbyScopeActive ? (
    <MediaLobbyPanel {...lobbyScope} />
  ) : undefined;

  // ROOM-COMPACT-05: the Top Bar names the lesson — the launcher's class name,
  // else the active workspace; with neither, only assistive technology hears
  // the generic room heading.
  const roomTitle = handoff.classTitle?.trim() || workspaceName?.trim() || null;

  const roomProps: ClassroomLiveKitRoomProps = {
    choices: handoff.choices,
    chat: <MediaSpaceChatPanel chat={roomChat} codeSession={codeSession} />,
    chatUnreadCapped: roomChat.unreadCapped,
    chatUnreadCount: roomChat.unreadCount,
    onChatOpenChange: setChatOpen,
    connectionStatus: roomStatus,
    credential: handoff.credential,
    lobby,
    ...(moderationControls ? { moderation: moderationControls } : {}),
    onConnected: handleConnected,
    onReconnecting: handleReconnecting,
    onDisconnected: handleDisconnected,
    onLeave: handleLeave,
    onProviderError: handleProviderError,
    roomTitle,
    signals: signalControls,
    tools: [
      {
        autoOpenKey: whiteboardAutoOpenKey,
        content: (
          <ClassroomWhiteboardTool
            actorID={userId}
            autoStart
            enabled={whiteboardEnabled}
            mediaSpaceID={spaceId}
            tenantID={tenantId}
          />
        ),
        icon: <PenTool />,
        id: "whiteboard",
        label: t("classroomTools.whiteboardLabel"),
        title: t("whiteboard.title"),
      },
      {
        content: (
          <ClassroomCodeTool
            actorID={userId}
            chatCanPost={chatCanPost}
            mediaSpaceID={spaceId}
            onSendToChat={sendCodeToChat}
            session={codeSession}
            tenantID={tenantId}
          />
        ),
        icon: <CodeXml />,
        id: "code",
        label: t("classroomTools.codeLabel"),
        title: t("classroomTools.codeTitle"),
      },
    ],
  };

  return (
    <main className="media-p403-room media-p405-room" data-theme="dark">
      {/*
        Always mounted (even when the viewer cannot manage admissions) so the
        LiveKit room subtree keeps a stable position and never reconnects.
      */}
      <MediaLobbyWaitingCountProvider {...lobbyScope}>
        <ClassroomLiveKitRoom {...roomProps} />
      </MediaLobbyWaitingCountProvider>
      {roomError && (
        <section className="media-p403-alert" role="alert">
          <p>{t(roomError)}</p>
          <Link to={`/app/media/spaces/${spaceId}/prejoin`}>
            {t("media.room.returnToPrejoin")}
          </Link>
        </section>
      )}
    </main>
  );
}

function credentialExpired(expiresAt: string): boolean {
  const parsed = Date.parse(expiresAt);
  return !Number.isFinite(parsed) || parsed <= Date.now();
}

function mediaP404ViewerOperations(value: unknown): {
  canManageAdmissions: boolean;
} {
  if (typeof value !== "object" || value === null) {
    return { canManageAdmissions: false };
  }
  return {
    canManageAdmissions:
      (value as Record<string, unknown>).can_manage_admissions === true,
  };
}

function classroomDisconnectOutcome(reason?: DisconnectReason): {
  messageKey: TranslationKey;
  reauthorize: boolean;
} {
  switch (reason) {
    case DisconnectReason.PARTICIPANT_REMOVED:
      return {
        messageKey: "media.p409.participantRemoved",
        reauthorize: false,
      };
    case DisconnectReason.ROOM_DELETED:
    case DisconnectReason.ROOM_CLOSED:
      return { messageKey: "media.p409.roomEnded", reauthorize: false };
    case DisconnectReason.DUPLICATE_IDENTITY:
      return {
        messageKey: "media.p409.duplicateIdentity",
        reauthorize: false,
      };
    case DisconnectReason.CLIENT_INITIATED:
      return {
        messageKey: "media.room.disconnectedDescription",
        reauthorize: false,
      };
    default:
      return {
        messageKey: "media.p409.reauthorizationRequired",
        reauthorize: true,
      };
  }
}

function disconnectDiagnosticCode(
  reason?: DisconnectReason,
): MediaDiagnosticErrorCode {
  switch (reason) {
    case DisconnectReason.PARTICIPANT_REMOVED:
      return "participant_removed";
    case DisconnectReason.ROOM_DELETED:
    case DisconnectReason.ROOM_CLOSED:
      return "room_ended";
    case DisconnectReason.DUPLICATE_IDENTITY:
      return "duplicate_identity";
    case DisconnectReason.CLIENT_INITIATED:
      return "client_leave";
    default:
      return "transport_disconnected";
  }
}
