import {
  getMediaSpace,
  type MediaDiagnosticErrorCode,
} from "@tutorhub/api-client";
import { useQuery } from "@tanstack/react-query";
import { DisconnectReason } from "livekit-client";
import { CodeXml, FileText, PenTool } from "lucide-react";
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
import {
  registerPrivateSessionMemoryCleanup,
  useSession,
} from "../app/session";
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
import { ClassroomFilesTool } from "../features/classroom-tools/ClassroomFilesTool";
import {
  ClassroomCodeEditorGrantsContext,
  type ClassroomCodeEditorGrantError,
  type ClassroomCodeEditorGrantsModel,
} from "../features/classroom-tools/codeEditorGrantsContext";
import type { CodePresenceRoster } from "../features/classroom-tools/codePresence";
import { createClassroomCodeSession } from "../features/classroom-tools/codeSession";
import { createClassroomFilesSession } from "../features/classroom-tools/filesSession";
import {
  ClassroomPdfAnnotatorGrantsContext,
  type ClassroomPdfAnnotatorGrantError,
  type ClassroomPdfAnnotatorGrantsModel,
} from "../features/classroom-tools/pdfAnnotatorGrantsContext";
import { ClassroomWhiteboardTool } from "../features/collaboration/ClassroomWhiteboardTool";
import { createWhiteboardSnippetBridge } from "../features/collaboration/whiteboardSnippetBridge";
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

import {
  CODE_WORKSPACE_MAX_EDITORS,
  isCodeWorkspaceEditorLimitError,
  useCodeWorkspaceTool,
  useDeleteCodeWorkspaceEditorGrant,
  usePutCodeWorkspaceEditorGrant,
} from "../app/codeWorkspaces";
import {
  isPdfAnnotatorLimitError,
  PDF_PRESENTATION_MAX_ANNOTATORS,
  PDF_PRESENTATION_POLL_INTERVAL_MS,
  pdfPresentationAutoOpenKey,
  useDeletePdfPresentationAnnotatorGrant,
  usePdfPresentationTool,
  usePutPdfPresentationAnnotatorGrant,
} from "../app/pdfPresentations";
import { useTenantCapabilities } from "../app/tenantCapabilities";
import { useWhiteboardTool } from "../app/whiteboards";
import "./ClassroomRoomStage.css";

/** How often a connected room re-reads the whiteboard projection. */
const whiteboardPollIntervalMs = 4_000;
/** ROOM-TOOLS-CODE-02B: the shared code workspace projection poll. */
const codeWorkspacePollIntervalMs = 4_000;
const NO_EDITOR_GRANTS: readonly { readonly participant_key: string }[] = [];
const NO_ANNOTATOR_GRANTS: readonly { readonly participant_key: string }[] = [];

export function MediaSpaceRoomPage() {
  const { spaceId, roomInstanceId } = useParams();
  const session = useSession();
  const tenantId = session.currentUser?.active_tenant?.id ?? "";
  const userId = session.currentUser?.user.id ?? "";
  const scopeKey = `${tenantId}\u0000${userId}\u0000${spaceId ?? ""}\u0000${roomInstanceId ?? ""}`;

  return (
    <MediaSpaceRoomSession
      displayName={session.currentUser?.user.display_name ?? ""}
      key={scopeKey}
      organizationAdmin={
        session.currentUser?.active_tenant?.role === "org_admin"
      }
      roomInstanceId={roomInstanceId}
      spaceId={spaceId}
      tenantId={tenantId}
      userId={userId}
      workspaceName={session.currentUser?.active_tenant?.name ?? null}
    />
  );
}

function MediaSpaceRoomSession({
  displayName,
  organizationAdmin,
  roomInstanceId,
  spaceId,
  tenantId,
  userId,
  workspaceName,
}: {
  displayName: string;
  /** ROOM-TOOLS-CODE-03B: display hint only; the server enforces rights. */
  organizationAdmin: boolean;
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
  // ROOM-TOOLS-CODE-02A: the personal Code tool stays on by default but obeys
  // the Ops kill-switch; a failed capability read fails closed.
  const codeToolEnabled = tenantCapabilities.data
    ? tenantCapabilities.data.features.classroom_code_tool.enabled === true
    : tenantCapabilities.isError
      ? false
      : undefined;
  // ROOM-TOOLS-CODE-02B: the shared "Chung lớp" mode needs both switches.
  const codeCollaborationEnabled =
    codeToolEnabled === true &&
    tenantCapabilities.data?.features.classroom_code_collaboration.enabled ===
      true;
  // ROOM-TOOLS-CODE-03B: durable snippets, the server draft and "Gửi bài cho
  // GV" need both the Code tool and `code_snippet_library`.
  const codeLibraryEnabled =
    codeToolEnabled === true &&
    tenantCapabilities.data?.features.code_snippet_library.enabled === true;
  const codeClassID = mediaSpaceClassID(mediaSpace.data?.source);
  // ROOM-TOOLS-FILES-01B (ADR-0045): the Documents tool needs both
  // `classroom_files_tool` and `file_uploads`; a failed read fails closed.
  const filesToolEnabled = tenantCapabilities.data
    ? tenantCapabilities.data.features.classroom_files_tool?.enabled === true &&
      tenantCapabilities.data.features.file_uploads?.enabled === true
    : tenantCapabilities.isError
      ? false
      : undefined;
  // ROOM-TOOLS-FILES-02B (ADR-0045 Slice 2): the shared "Trình chiếu lớp"
  // presentation, page-scoped annotations and laser need all three switches.
  // Off (or unreadable) keeps Slice 1 exactly: no /pdf-presentation request.
  const pdfCollaborationEnabled =
    filesToolEnabled === true &&
    tenantCapabilities.data?.features.classroom_pdf_collaboration?.enabled ===
      true;
  // Per-room-session Documents memory (open document, page, verified bytes
  // in RAM only) and the "Đưa sang Bảng trắng" snippet bridge. Both are
  // wiped on sign-out (clearPrivateSessionCache) and when the room unmounts.
  const [filesSession] = useState(createClassroomFilesSession);
  const [snippetBridge] = useState(createWhiteboardSnippetBridge);
  useEffect(() => {
    const wipe = () => {
      filesSession.clear();
      snippetBridge.clear();
    };
    const unregister = registerPrivateSessionMemoryCleanup(wipe);
    return () => {
      unregister();
      wipe();
    };
  }, [filesSession, snippetBridge]);
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
  // Display hint for "Đưa sang Bảng trắng": a viewer on an open board with a
  // `view` capability cannot insert (the live board re-checks anyway).
  const whiteboardCanEdit =
    whiteboardDocument?.status === "open"
      ? whiteboardDocument.viewer_capabilities.capability !== "view"
      : undefined;
  const whiteboardAutoOpenKey =
    whiteboardDocument?.status === "open" &&
    whiteboardDocument.viewer_capabilities.can_exchange_grant
      ? `${whiteboardDocument.id}:${whiteboardDocument.current_generation}`
      : null;
  // ROOM-TOOLS-CODE-02B: like the whiteboard, an open shared code workspace
  // brings the Code tool onto every stage once per workspace generation; the
  // tool reuses this cache entry.
  const codeWorkspaceTool = useCodeWorkspaceTool(
    tenantId,
    spaceId ?? "",
    codeCollaborationEnabled && signalScopeReady && roomLive,
    { pollIntervalMs: codeWorkspacePollIntervalMs },
  );
  const codeProjection =
    codeCollaborationEnabled && codeWorkspaceTool.isSuccess
      ? codeWorkspaceTool.data
      : undefined;
  const codeWorkspace = codeProjection?.workspace ?? null;
  const codeAutoOpenKey =
    codeWorkspace?.status === "open" &&
    codeWorkspace.viewer_capabilities.can_exchange_grant
      ? `${codeWorkspace.id}:${codeWorkspace.current_generation}`
      : null;
  const signalSnapshot = signalQuery.data;
  const codeRoster = useMemo<CodePresenceRoster | null>(
    () =>
      signalSnapshot
        ? {
            participants: signalSnapshot.participants,
            roomInstanceID: signalSnapshot.room_instance_id,
            selfParticipantKey: signalSnapshot.self_participant_key,
          }
        : null,
    [signalSnapshot],
  );
  // ROOM-TOOLS-FILES-02B: an open PDF presentation brings the Documents tool
  // onto every stage once per `id:generation:revoke_generation` (A → B → A
  // and suspend → resume reopen it; a pen grant change does not).
  const pdfPresentationTool = usePdfPresentationTool(
    tenantId,
    spaceId ?? "",
    pdfCollaborationEnabled && signalScopeReady && roomLive,
    { pollIntervalMs: PDF_PRESENTATION_POLL_INTERVAL_MS },
  );
  const pdfProjection =
    pdfCollaborationEnabled && pdfPresentationTool.isSuccess
      ? pdfPresentationTool.data
      : undefined;
  const pdfPresentation = pdfProjection?.presentation ?? null;
  const pdfAutoOpenKey = pdfPresentationAutoOpenKey(pdfPresentation);
  const putAnnotatorGrant = usePutPdfPresentationAnnotatorGrant(
    tenantId,
    spaceId ?? "",
  );
  const deleteAnnotatorGrant = useDeletePdfPresentationAnnotatorGrant(
    tenantId,
    spaceId ?? "",
  );
  const { mutate: grantAnnotator } = putAnnotatorGrant;
  const { mutate: revokeAnnotator } = deleteAnnotatorGrant;
  const [pdfGrantError, setPdfGrantError] =
    useState<ClassroomPdfAnnotatorGrantError | null>(null);
  const [pendingPdfGrantKey, setPendingPdfGrantKey] = useState<string | null>(
    null,
  );
  const pdfPresentationID = pdfPresentation?.id ?? null;
  const pdfGrantsManageable =
    pdfPresentation?.status === "open" &&
    pdfPresentation.viewer_capabilities.can_manage_annotator_grants;
  const activeAnnotatorGrants =
    pdfProjection?.active_annotator_grants ?? NO_ANNOTATOR_GRANTS;
  const pdfAnnotatorGrants = useMemo<ClassroomPdfAnnotatorGrantsModel | null>(
    () =>
      pdfPresentationID === null || pdfPresentation?.status !== "open"
        ? null
        : {
            activeParticipantKeys: new Set(
              activeAnnotatorGrants.map((grant) => grant.participant_key),
            ),
            canManage: pdfGrantsManageable,
            error: pdfGrantError,
            maxAnnotators: PDF_PRESENTATION_MAX_ANNOTATORS,
            pendingParticipantKey: pendingPdfGrantKey,
            onDismissError: () => setPdfGrantError(null),
            onGrant: (participantKey) => {
              setPdfGrantError(null);
              setPendingPdfGrantKey(participantKey);
              grantAnnotator(
                { participantKey, presentationID: pdfPresentationID },
                {
                  onError: (error) =>
                    setPdfGrantError(
                      isPdfAnnotatorLimitError(error) ? "limit" : "failed",
                    ),
                  onSettled: () => setPendingPdfGrantKey(null),
                },
              );
            },
            onRevoke: (participantKey) => {
              setPdfGrantError(null);
              setPendingPdfGrantKey(participantKey);
              revokeAnnotator(
                { participantKey, presentationID: pdfPresentationID },
                {
                  onError: () => setPdfGrantError("failed"),
                  onSettled: () => setPendingPdfGrantKey(null),
                },
              );
            },
          },
    [
      activeAnnotatorGrants,
      grantAnnotator,
      pdfGrantError,
      pdfGrantsManageable,
      pdfPresentation?.status,
      pdfPresentationID,
      pendingPdfGrantKey,
      revokeAnnotator,
    ],
  );
  const putEditorGrant = usePutCodeWorkspaceEditorGrant(
    tenantId,
    spaceId ?? "",
  );
  const deleteEditorGrant = useDeleteCodeWorkspaceEditorGrant(
    tenantId,
    spaceId ?? "",
  );
  const { mutate: grantEditor } = putEditorGrant;
  const { mutate: revokeEditor } = deleteEditorGrant;
  const [codeGrantError, setCodeGrantError] =
    useState<ClassroomCodeEditorGrantError | null>(null);
  const [pendingGrantKey, setPendingGrantKey] = useState<string | null>(null);
  const codeWorkspaceID = codeWorkspace?.id ?? null;
  const codeGrantsManageable =
    codeWorkspace?.status === "open" &&
    codeWorkspace.viewer_capabilities.can_manage_editor_grants;
  const activeEditorGrants =
    codeProjection?.active_editor_grants ?? NO_EDITOR_GRANTS;
  const codeEditorGrants = useMemo<ClassroomCodeEditorGrantsModel | null>(
    () =>
      codeWorkspaceID === null
        ? null
        : {
            activeParticipantKeys: new Set(
              activeEditorGrants.map((grant) => grant.participant_key),
            ),
            canManage: codeGrantsManageable,
            error: codeGrantError,
            maxEditors: CODE_WORKSPACE_MAX_EDITORS,
            pendingParticipantKey: pendingGrantKey,
            onDismissError: () => setCodeGrantError(null),
            onGrant: (participantKey) => {
              setCodeGrantError(null);
              setPendingGrantKey(participantKey);
              grantEditor(
                { participantKey, workspaceID: codeWorkspaceID },
                {
                  onError: (error) =>
                    setCodeGrantError(
                      isCodeWorkspaceEditorLimitError(error)
                        ? "limit"
                        : "failed",
                    ),
                  onSettled: () => setPendingGrantKey(null),
                },
              );
            },
            onRevoke: (participantKey) => {
              setCodeGrantError(null);
              setPendingGrantKey(participantKey);
              revokeEditor(
                { participantKey, workspaceID: codeWorkspaceID },
                {
                  onError: () => setCodeGrantError("failed"),
                  onSettled: () => setPendingGrantKey(null),
                },
              );
            },
          },
    [
      activeEditorGrants,
      codeGrantError,
      codeGrantsManageable,
      codeWorkspaceID,
      grantEditor,
      pendingGrantKey,
      revokeEditor,
    ],
  );
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
  // ROOM-TOOLS-CODE-03B: teaching-staff UI ("Bài học sinh", class snippets)
  // for the room's host / co-host / TA, an org admin or an admissions manager.
  // Display only — the server answers 404/403 to anyone else.
  const selfInstanceRole = signalProjection?.roster.find(
    (participant) =>
      participant.participant_key === signalProjection.self_participant_key,
  )?.instance_role;
  const isCodeStaff =
    selfInstanceRole === "host" ||
    selfInstanceRole === "co_host" ||
    selfInstanceRole === "teaching_assistant" ||
    organizationAdmin ||
    viewerOperations.canManageAdmissions;

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
            snippetBridge={snippetBridge}
            tenantID={tenantId}
          />
        ),
        icon: <PenTool />,
        id: "whiteboard",
        label: t("classroomTools.whiteboardLabel"),
        title: t("whiteboard.title"),
      },
      {
        autoOpenKey: codeAutoOpenKey,
        content: (
          <ClassroomCodeTool
            actorID={userId}
            chatCanPost={chatCanPost}
            classID={codeClassID}
            codeRoster={codeRoster}
            collaborationEnabled={codeCollaborationEnabled}
            displayName={displayName}
            enabled={codeToolEnabled}
            isStaff={isCodeStaff}
            libraryEnabled={codeLibraryEnabled}
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
      {
        autoOpenKey: pdfAutoOpenKey,
        content: (
          <ClassroomFilesTool
            actorID={userId}
            collaborationEnabled={pdfCollaborationEnabled}
            displayName={displayName}
            enabled={filesToolEnabled}
            mediaSpaceID={spaceId}
            presenceRoster={codeRoster}
            session={filesSession}
            snippetBridge={snippetBridge}
            tenantID={tenantId}
            whiteboardCanEdit={whiteboardCanEdit}
            whiteboardEnabled={whiteboardEnabled}
          />
        ),
        icon: <FileText />,
        id: "files",
        label: t("classroomTools.filesLabel"),
        // Closing the stage releases the in-RAM bytes; switching keeps them.
        onStageClose: () => filesSession.releaseBytes(),
        title: t("classroomTools.filesTitle"),
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
        {/*
          ROOM-TOOLS-CODE-02B: always rendered (value may be null) so the
          LiveKit room keeps its position; the People panel reads the Code
          edit grants from here.
        */}
        <ClassroomCodeEditorGrantsContext value={codeEditorGrants}>
          {/*
            ROOM-TOOLS-FILES-02B: always rendered too (null without a PDF
            presentation), so adding it never remounts the LiveKit room.
          */}
          <ClassroomPdfAnnotatorGrantsContext value={pdfAnnotatorGrants}>
            <ClassroomLiveKitRoom {...roomProps} />
          </ClassroomPdfAnnotatorGrantsContext>
        </ClassroomCodeEditorGrantsContext>
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * ROOM-TOOLS-CODE-03B: the class behind a class room, when the server source
 * projects one (`class_id`); a study meeting or a source without it has none
 * (the "Của lớp" snippets stay hidden and the server stays the authority).
 */
function mediaSpaceClassID(source: unknown): string | null {
  if (typeof source !== "object" || source === null) return null;
  const record = source as Record<string, unknown>;
  if (record.kind === "study_meeting") return null;
  const classID = record.class_id;
  return typeof classID === "string" && UUID_PATTERN.test(classID)
    ? classID
    : null;
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
