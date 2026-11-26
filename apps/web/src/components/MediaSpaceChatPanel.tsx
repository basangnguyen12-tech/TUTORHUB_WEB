/* eslint-disable react-refresh/only-export-components -- The room chat controller hook and its live-sync cadence are colocated with the panel that renders them. */
import {
  APIRequestError,
  type ActiveMessage,
  type Conversation,
  type Message,
  type MessageAttachment,
} from "@tutorhub/api-client";
import {
  Button,
  DrawerClose,
  EmptyState,
  ErrorState,
  ForbiddenState,
  Skeleton,
  SkeletonGroup,
} from "@tutorhub/ui";
import { RefreshCw } from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  fetchConversationAttachmentBlob,
  useConversation,
  useConversationMessages,
  useDeleteConversationMessage,
  useEditConversationMessage,
  useEnsureMediaSpaceConversation,
  useMarkConversationRead,
  useSendConversationMessage,
  useUpdateRoomConversationSettings,
  useUploadConversationAttachment,
} from "../app/conversations";
import { useI18n } from "../app/i18n";
import { shouldConcealTenantScopedData } from "../app/tenantDataAccess";
import type { ClassroomCodeSession } from "../features/classroom-tools/codeSession";
import {
  supportsChatDocument,
  type ChatDocumentReference,
} from "../features/classroom-tools/documentReference";
import type { ClassroomFilesSession } from "../features/classroom-tools/filesSession";
import { ClassroomToolActionsContext } from "../features/classroom-tools/toolActions";
import {
  ClassroomChatPanel,
  type ClassroomChatCodeBlock,
  type ClassroomChatSendInput,
  type ClassroomChatUploadInput,
} from "../features/media/ClassroomChatPanel";
import {
  createAttachmentObjectURLCache,
  createClassroomChatComposerStore,
  disposeClassroomChatComposerStore,
  type AttachmentObjectURLCache,
  type ClassroomChatComposerStore,
} from "../features/media/classroomChatMedia";

/** ADR-0042 live-sync cadence (paused while the tab is hidden). */
export const ROOM_CHAT_OPEN_POLL_MS = 2_500;
export const ROOM_CHAT_CLOSED_POLL_MS = 5_000;
export const ROOM_CHAT_DETAIL_POLL_MS = 5_000;

function useDocumentVisible() {
  const [visible, setVisible] = useState(
    () =>
      typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

export interface UseMediaSpaceRoomChatInput {
  actorID: string;
  /** Signed room scope ready and the session live (connected/reconnecting). */
  enabled: boolean;
  mediaSpaceID: string;
  /** The chat inspector is open. */
  open: boolean;
  tenantID: string;
}

export interface MediaSpaceRoomChat {
  actorID: string;
  attachmentCache: AttachmentObjectURLCache;
  composerStore: ClassroomChatComposerStore;
  conversation: Conversation | undefined;
  error: unknown;
  hasOlder: boolean;
  loadingOlder: boolean;
  messages: Message[];
  open: boolean;
  status: "disabled" | "loading" | "error" | "ready";
  tenantID: string;
  unreadCapped: boolean;
  unreadCount: number;
  loadAttachment: (attachment: MessageAttachment) => Promise<Blob>;
  loadOlder: () => void;
  onDelete: (message: ActiveMessage) => Promise<void>;
  onEdit: (message: ActiveMessage, content: string) => Promise<void>;
  onSend: (input: ClassroomChatSendInput) => Promise<void>;
  onToggleParticipantChat: (enabled: boolean) => Promise<void>;
  onUpload: (input: ClassroomChatUploadInput) => Promise<MessageAttachment>;
  retry: () => void;
}

/**
 * Room-level chat controller. It lives with the room page (not inside the
 * inspector), so the Dock unread badge keeps updating before the panel is
 * ever opened and the draft survives closing the inspector.
 */
export function useMediaSpaceRoomChat({
  actorID,
  enabled,
  mediaSpaceID,
  open,
  tenantID,
}: UseMediaSpaceRoomChatInput): MediaSpaceRoomChat {
  const ensureConversation = useEnsureMediaSpaceConversation(tenantID);
  const ensure = ensureConversation.mutate;
  const startedScope = useRef<string | null>(null);
  const scope = `${tenantID}\u0000${mediaSpaceID}`;
  const visible = useDocumentVisible();

  useEffect(() => {
    if (
      !enabled ||
      !tenantID ||
      !mediaSpaceID ||
      startedScope.current === scope
    ) {
      return;
    }
    startedScope.current = scope;
    ensure(mediaSpaceID);
  }, [enabled, ensure, mediaSpaceID, scope, tenantID]);

  const ensured =
    ensureConversation.data?.media_space_id === mediaSpaceID ||
    ensureConversation.data?.media_space_id === undefined
      ? ensureConversation.data
      : undefined;
  const conversationID = ensured?.id;
  const live = enabled && visible;
  const detail = useConversation(tenantID, conversationID, {
    refetchInterval: live && open ? ROOM_CHAT_DETAIL_POLL_MS : false,
  });
  const messagesQuery = useConversationMessages(tenantID, conversationID, {
    refetchInterval: live
      ? open
        ? ROOM_CHAT_OPEN_POLL_MS
        : ROOM_CHAT_CLOSED_POLL_MS
      : false,
  });
  const conversation = detail.data ?? ensured;
  const refetchDetail = detail.refetch;

  // Opening the inspector reconciles posting rights at once (the host may
  // have paused or resumed participant chat while it was closed).
  useEffect(() => {
    if (open && conversationID) void refetchDetail();
  }, [conversationID, open, refetchDetail]);
  const pages = messagesQuery.data?.pages;
  const firstPage = pages?.[0];
  const messages = useMemo(() => {
    const byID = new Map<string, Message>();
    for (const page of pages ?? []) {
      for (const item of page.items) byID.set(item.id, item);
    }
    return [...byID.values()].sort(
      (left, right) => left.sequence - right.sequence,
    );
  }, [pages]);

  const sendMessage = useSendConversationMessage(tenantID, conversationID);
  const markRead = useMarkConversationRead(tenantID, conversationID);
  const upload = useUploadConversationAttachment(tenantID, conversationID);
  const edit = useEditConversationMessage(tenantID, conversationID);
  const remove = useDeleteConversationMessage(tenantID, conversationID);
  const settings = useUpdateRoomConversationSettings(tenantID, conversationID);
  const markReadMutate = markRead.mutate;
  const markReadPending = markRead.isPending;

  // Mark read only while the inspector is open on a visible tab.
  const lastReadAttempt = useRef<string | null>(null);
  const newest = messages[messages.length - 1];
  const serverUnread = firstPage?.unread_count ?? 0;
  useEffect(() => {
    if (!open || !visible || !conversationID || !newest || markReadPending) {
      return;
    }
    const readSequence = firstPage?.read_state?.last_read_sequence ?? 0;
    if (serverUnread === 0 || newest.sequence <= readSequence) return;
    if (lastReadAttempt.current === newest.id) return;
    lastReadAttempt.current = newest.id;
    markReadMutate(newest.id);
  }, [
    conversationID,
    firstPage?.read_state?.last_read_sequence,
    markReadMutate,
    markReadPending,
    newest,
    open,
    serverUnread,
    visible,
  ]);

  const resourceScope = `${tenantID}\u0000${conversationID ?? ""}`;
  const resources = useMemo(
    () => ({
      attachmentCache: createAttachmentObjectURLCache(),
      composerStore: createClassroomChatComposerStore(),
      scope: resourceScope,
    }),
    [resourceScope],
  );
  useEffect(
    () => () => {
      resources.attachmentCache.revokeAll();
      disposeClassroomChatComposerStore(resources.composerStore);
    },
    [resources],
  );

  const sendMutate = sendMessage.mutateAsync;
  const uploadMutate = upload.mutateAsync;
  const editMutate = edit.mutateAsync;
  const removeMutate = remove.mutateAsync;
  const settingsMutate = settings.mutateAsync;
  const fetchNextPage = messagesQuery.fetchNextPage;

  const onSend = useCallback(
    async (input: ClassroomChatSendInput) => {
      try {
        await sendMutate({
          client_message_id: input.clientMessageID,
          content: input.content,
          ...(input.attachmentIDs.length > 0
            ? { attachment_ids: input.attachmentIDs }
            : {}),
        });
      } catch (error) {
        if (
          error instanceof APIRequestError &&
          error.problem?.code === "conversation_read_only"
        ) {
          void refetchDetail();
        }
        throw error;
      }
    },
    [refetchDetail, sendMutate],
  );
  const onUpload = useCallback(
    (input: ClassroomChatUploadInput) =>
      uploadMutate({
        clientAttachmentID: input.clientAttachmentID,
        file: input.file,
        fileName: input.fileName,
        heightPx: input.heightPx,
        widthPx: input.widthPx,
      }),
    [uploadMutate],
  );
  const onEdit = useCallback(
    async (message: ActiveMessage, content: string) => {
      await editMutate({
        content,
        expectedVersion: message.version,
        messageID: message.id,
      });
    },
    [editMutate],
  );
  const onDelete = useCallback(
    async (message: ActiveMessage) => {
      await removeMutate({
        expectedVersion: message.version,
        messageID: message.id,
      });
    },
    [removeMutate],
  );
  const onToggleParticipantChat = useCallback(
    async (participantChatEnabled: boolean) => {
      await settingsMutate(participantChatEnabled);
    },
    [settingsMutate],
  );
  const loadAttachment = useCallback(
    (attachment: MessageAttachment) =>
      fetchConversationAttachmentBlob(
        tenantID,
        attachment.conversation_id,
        attachment.id,
      ),
    [tenantID],
  );
  const loadOlder = useCallback(() => {
    void fetchNextPage();
  }, [fetchNextPage]);
  const retry = useCallback(() => {
    if (ensureConversation.isError || !conversationID) {
      startedScope.current = scope;
      ensure(mediaSpaceID);
      return;
    }
    void messagesQuery.refetch();
  }, [
    conversationID,
    ensure,
    ensureConversation.isError,
    mediaSpaceID,
    messagesQuery,
    scope,
  ]);

  let status: MediaSpaceRoomChat["status"];
  let error: unknown = null;
  if (!conversation) {
    if (!enabled && ensureConversation.isIdle) status = "disabled";
    else if (ensureConversation.isError) {
      status = "error";
      error = ensureConversation.error;
    } else status = "loading";
  } else if (!messagesQuery.data) {
    if (messagesQuery.isError) {
      status = "error";
      error = messagesQuery.error;
    } else status = "loading";
  } else status = "ready";

  return {
    actorID,
    attachmentCache: resources.attachmentCache,
    composerStore: resources.composerStore,
    conversation,
    error,
    hasOlder: Boolean(messagesQuery.hasNextPage),
    loadingOlder: messagesQuery.isFetchingNextPage,
    messages,
    open,
    status,
    tenantID,
    unreadCapped: !open && (firstPage?.unread_count_capped ?? false),
    unreadCount: open ? 0 : serverUnread,
    loadAttachment,
    loadOlder,
    onDelete,
    onEdit,
    onSend,
    onToggleParticipantChat,
    onUpload,
    retry,
  };
}

export function MediaSpaceChatPanel({
  chat,
  codeSession,
  filesSession,
  documentActions,
  insideRoomDrawer = false,
}: {
  chat: MediaSpaceRoomChat;
  /** ROOM-TOOLS-CODE-01: where "Open in Code" queues a chat code block. */
  codeSession?: ClassroomCodeSession;
  filesSession?: ClassroomFilesSession;
  insideRoomDrawer?: boolean;
  documentActions?: {
    openReference?: (reference: ChatDocumentReference) => Promise<boolean>;
    saveAttachment?: (attachmentID: string) => Promise<boolean>;
  };
}) {
  const { t } = useI18n();
  const toolActions = useContext(ClassroomToolActionsContext);
  const closeDrawer = useRef<HTMLButtonElement>(null);
  const openFiles = () => {
    // The narrow room uses a full-width inspector over the stage.
    if (window.matchMedia?.("(max-width: 1023px)").matches)
      closeDrawer.current?.click();
    toolActions?.openTool("files");
  };
  const openInCode = useMemo(() => {
    if (!codeSession || !toolActions?.hasTool("code")) return undefined;
    return (block: ClassroomChatCodeBlock) => {
      // Queued first, so a Code tool that mounts now picks it up; never run.
      codeSession.push({ code: block.code, language: block.language });
      toolActions.openTool("code");
    };
  }, [codeSession, toolActions]);

  const filesEnabled = Boolean(
    filesSession &&
    documentActions?.openReference &&
    toolActions?.hasTool("files"),
  );
  const openAttachment = async (attachment: MessageAttachment) => {
    const limit = 10 * 1024 * 1024;
    if (
      !filesSession ||
      !filesEnabled ||
      !supportsChatDocument(attachment.media_type) ||
      attachment.size_bytes <= 0 ||
      attachment.size_bytes > limit
    )
      throw new Error("unsupported_chat_document");
    const current = filesSession.beginChatOpen();
    const blob = await chat.loadAttachment(attachment);
    if (blob.size !== attachment.size_bytes || blob.size > limit)
      throw new Error("invalid_chat_document");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!current()) return;
    const fileID = `chat:${attachment.id}`;
    filesSession.saveBytes(fileID, attachment.id, bytes);
    filesSession.openFromChat(
      {
        document: {
          fileID,
          displayName: attachment.display_name,
          mediaType: attachment.media_type,
          activeContent: false,
          firstPageAspect:
            attachment.width_px && attachment.height_px
              ? attachment.width_px / attachment.height_px
              : 0.7071,
          pageCount: 1,
          versionID: attachment.id,
        },
        fitMode: "width",
        zoom: 1,
        page: 1,
      },
      "private",
    );
    openFiles();
  };

  if (chat.status === "disabled") {
    return (
      <EmptyState
        description={t("media.p408.unavailableDescription")}
        title={t("media.p408.unavailableTitle")}
      />
    );
  }

  if (
    chat.status === "loading" ||
    (chat.status === "ready" && !chat.conversation)
  ) {
    return (
      <SkeletonGroup label={t("media.p408.loading")}>
        <Skeleton height={72} />
        <Skeleton height={72} />
        <Skeleton height={112} />
      </SkeletonGroup>
    );
  }

  if (chat.status === "error" || !chat.conversation) {
    const concealed = shouldConcealTenantScopedData(chat.error);
    const forbidden =
      chat.error instanceof APIRequestError && chat.error.status === 403;
    const State = forbidden
      ? ForbiddenState
      : concealed
        ? EmptyState
        : ErrorState;
    return (
      <State
        actions={
          concealed ? undefined : (
            <Button
              leadingIcon={<RefreshCw />}
              onClick={chat.retry}
              variant="secondary"
            >
              {t("state.retry")}
            </Button>
          )
        }
        description={
          forbidden
            ? t("media.p408.forbiddenDescription")
            : concealed
              ? t("media.p408.unavailableDescription")
              : t("media.p408.errorDescription")
        }
        title={
          forbidden
            ? t("media.p408.forbiddenTitle")
            : concealed
              ? t("media.p408.unavailableTitle")
              : t("media.p408.errorTitle")
        }
      />
    );
  }

  return (
    <>
      {insideRoomDrawer && filesEnabled && (
        <DrawerClose hidden ref={closeDrawer} tabIndex={-1} />
      )}
      <ClassroomChatPanel
        actorID={chat.actorID}
        attachmentCache={chat.attachmentCache}
        composerStore={chat.composerStore}
        conversation={chat.conversation}
        hasOlder={chat.hasOlder}
        loadAttachment={chat.loadAttachment}
        loadingOlder={chat.loadingOlder}
        messages={chat.messages}
        onDelete={chat.onDelete}
        onEdit={chat.onEdit}
        onLoadOlder={chat.loadOlder}
        onOpenInCode={openInCode}
        onOpenDocument={
          filesEnabled
            ? async (reference) => {
                if (await documentActions?.openReference?.(reference))
                  openFiles();
              }
            : undefined
        }
        onOpenAttachment={filesEnabled ? openAttachment : undefined}
        onSaveAttachment={
          filesEnabled && documentActions?.saveAttachment
            ? async (attachment) => {
                if (await documentActions.saveAttachment?.(attachment.id))
                  openFiles();
              }
            : undefined
        }
        onSend={chat.onSend}
        onToggleParticipantChat={chat.onToggleParticipantChat}
        onUpload={chat.onUpload}
        open={chat.open}
        tenantID={chat.tenantID}
      />
    </>
  );
}
