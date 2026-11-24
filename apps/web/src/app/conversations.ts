import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import {
  APIRequestError,
  createDirectConversation,
  deleteConversationMessage,
  downloadConversationAttachmentBlob,
  editConversationMessage,
  ensureClassConversation,
  ensureMediaSpaceConversation,
  getConversation,
  listConversationMessages,
  listConversations,
  markConversationRead,
  rotateCSRFToken,
  sendConversationMessage,
  updateRoomConversationSettings,
  uploadConversationAttachment,
  type Conversation,
  type ConversationPage,
  type CreateDirectConversationRequest,
  type Message,
  type MessagePage,
  type SendMessageRequest,
  type TenantCapabilities,
  type UploadConversationAttachmentInput,
} from "@tutorhub/api-client";
import { invalidateTenantAudit } from "./audit";
import {
  idempotentMutationRetryDelay,
  shouldRetryIdempotentMutation,
} from "./idempotentMutation";
import {
  invalidateTenantCapabilities,
  tenantOperationAvailability,
  type TenantOperationAvailability,
} from "./tenantCapabilities";

export const conversationPageSize = 25;
export const conversationMessagePageSize = 50;
const conversationCSRFMutationScope = { id: "conversation-csrf-mutation" };

function getApiBaseUrl() {
  return import.meta.env.VITE_API_BASE_URL ?? "/api";
}

export const conversationQueryKeys = {
  all: ["conversations"] as const,
  tenant: (tenantID: string) => ["conversations", tenantID] as const,
  lists: (tenantID: string) => ["conversations", tenantID, "list"] as const,
  list: (tenantID: string) =>
    ["conversations", tenantID, "list", "all"] as const,
  detail: (tenantID: string, conversationID: string) =>
    ["conversations", tenantID, "detail", conversationID] as const,
  messages: (tenantID: string, conversationID: string) =>
    ["conversations", tenantID, "messages", conversationID] as const,
};

export function conversationCreationAvailability(query: {
  data: TenantCapabilities | undefined;
  isError: boolean;
  isPending: boolean;
}): TenantOperationAvailability {
  const operation = tenantOperationAvailability(query, "create_conversation");
  if (!operation.available) {
    return operation;
  }
  if (query.data?.features.conversations?.enabled !== true) {
    return { available: false, reason: "feature_disabled" };
  }
  return operation;
}

function shouldRetryConversationQuery(failureCount: number, error: Error) {
  return (
    failureCount < 1 &&
    !(
      error instanceof APIRequestError &&
      error.status >= 400 &&
      error.status < 500
    )
  );
}

export function useConversations(tenantID: string | undefined, enabled = true) {
  return useInfiniteQuery({
    queryKey: conversationQueryKeys.list(tenantID ?? "inactive"),
    queryFn: ({ pageParam, signal }) =>
      listConversations(
        tenantID ?? "",
        {
          cursor: pageParam ?? undefined,
          limit: conversationPageSize,
        },
        { baseUrl: getApiBaseUrl(), signal },
      ),
    enabled: enabled && Boolean(tenantID),
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    retry: shouldRetryConversationQuery,
    staleTime: 15_000,
  });
}

/** ROOM-CHAT-01 live-sync options for room chat queries. */
export interface ConversationLiveOptions {
  enabled?: boolean;
  /** Poll interval in milliseconds; paused automatically while hidden. */
  refetchInterval?: number | false;
}

export function useConversation(
  tenantID: string | undefined,
  conversationID: string | undefined,
  options: ConversationLiveOptions = {},
) {
  return useQuery({
    queryKey: conversationQueryKeys.detail(
      tenantID ?? "inactive",
      conversationID ?? "invalid",
    ),
    queryFn: ({ signal }) =>
      getConversation(tenantID ?? "", conversationID ?? "", {
        baseUrl: getApiBaseUrl(),
        signal,
      }),
    enabled: (options.enabled ?? true) && Boolean(tenantID && conversationID),
    refetchInterval: options.refetchInterval ?? false,
    refetchIntervalInBackground: false,
    retry: shouldRetryConversationQuery,
    staleTime: 15_000,
  });
}

export function useConversationMessages(
  tenantID: string | undefined,
  conversationID: string | undefined,
  options: ConversationLiveOptions = {},
) {
  return useInfiniteQuery({
    queryKey: conversationQueryKeys.messages(
      tenantID ?? "inactive",
      conversationID ?? "invalid",
    ),
    queryFn: ({ pageParam, signal }) =>
      listConversationMessages(
        tenantID ?? "",
        conversationID ?? "",
        {
          cursor: pageParam ?? undefined,
          limit: conversationMessagePageSize,
        },
        { baseUrl: getApiBaseUrl(), signal },
      ),
    enabled: (options.enabled ?? true) && Boolean(tenantID && conversationID),
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    refetchInterval: options.refetchInterval ?? false,
    refetchIntervalInBackground: false,
    retry: shouldRetryConversationQuery,
    staleTime: 10_000,
  });
}

/**
 * Writes a committed message into the cached newest page so the sender sees
 * it immediately; the following invalidation reconciles with the server.
 */
export function upsertCachedConversationMessage(
  queryClient: QueryClient,
  tenantID: string,
  conversationID: string,
  message: Message,
) {
  queryClient.setQueryData<InfiniteData<MessagePage>>(
    conversationQueryKeys.messages(tenantID, conversationID),
    (data) => {
      if (!data) return data;
      let found = false;
      const pages = data.pages.map((page) => ({
        ...page,
        items: page.items.map((item) => {
          if (item.id !== message.id) return item;
          found = true;
          return message;
        }),
      }));
      if (!found && pages[0]) {
        pages[0] = { ...pages[0], items: [message, ...pages[0].items] };
      }
      return { ...data, pages };
    },
  );
}

export function useSendConversationMessage(
  tenantID: string | undefined,
  conversationID: string | undefined,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SendMessageRequest) => {
      const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
      return sendConversationMessage(
        tenantID ?? "",
        conversationID ?? "",
        input,
        csrf.csrf_token,
        { baseUrl: getApiBaseUrl() },
      );
    },
    onSuccess: (message) => {
      if (!tenantID || !conversationID) {
        return;
      }
      upsertCachedConversationMessage(
        queryClient,
        tenantID,
        conversationID,
        message,
      );
      void Promise.all([
        queryClient.invalidateQueries({
          queryKey: conversationQueryKeys.messages(tenantID, conversationID),
        }),
        queryClient.invalidateQueries({
          exact: true,
          queryKey: conversationQueryKeys.detail(tenantID, conversationID),
        }),
        queryClient.invalidateQueries({
          queryKey: conversationQueryKeys.lists(tenantID),
        }),
        invalidateTenantCapabilities(queryClient, tenantID),
      ]);
    },
    retry: shouldRetryIdempotentMutation,
    retryDelay: idempotentMutationRetryDelay,
    scope: conversationCSRFMutationScope,
  });
}

export function useMarkConversationRead(
  tenantID: string | undefined,
  conversationID: string | undefined,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (messageID: string) => {
      const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
      return markConversationRead(
        tenantID ?? "",
        conversationID ?? "",
        { message_id: messageID },
        csrf.csrf_token,
        { baseUrl: getApiBaseUrl() },
      );
    },
    onSuccess: (readState) => {
      if (!tenantID || !conversationID) {
        return;
      }
      const current = queryClient.getQueryData<InfiniteData<MessagePage>>(
        conversationQueryKeys.messages(tenantID, conversationID),
      );
      const newestSequence =
        current?.pages.reduce(
          (newest, page) =>
            page.items.reduce(
              (pageNewest, message) => Math.max(pageNewest, message.sequence),
              newest,
            ),
          0,
        ) ?? 0;
      const reachedNewest = readState.last_read_sequence >= newestSequence;
      queryClient.setQueryData<InfiniteData<MessagePage>>(
        conversationQueryKeys.messages(tenantID, conversationID),
        (messageData) => {
          if (!messageData) {
            return messageData;
          }
          return {
            ...messageData,
            pages: messageData.pages.map((page) => ({
              ...page,
              read_state: readState,
              unread_count: reachedNewest ? 0 : page.unread_count,
              unread_count_capped: reachedNewest
                ? false
                : page.unread_count_capped,
            })),
          };
        },
      );
      if (reachedNewest) {
        queryClient.setQueryData<Conversation>(
          conversationQueryKeys.detail(tenantID, conversationID),
          (conversation) =>
            conversation
              ? {
                  ...conversation,
                  unread_count: 0,
                  unread_count_capped: false,
                }
              : conversation,
        );
        queryClient.setQueriesData<InfiniteData<ConversationPage>>(
          { queryKey: conversationQueryKeys.lists(tenantID) },
          (conversationData) =>
            conversationData
              ? {
                  ...conversationData,
                  pages: conversationData.pages.map((page) => ({
                    ...page,
                    items: page.items.map((conversation) =>
                      conversation.id === conversationID
                        ? {
                            ...conversation,
                            unread_count: 0,
                            unread_count_capped: false,
                          }
                        : conversation,
                    ),
                  })),
                }
              : conversationData,
        );
      }
      // Always reconcile with the server. Another message can commit after the
      // loaded page but before this marker transaction reaches the client.
      void Promise.all([
        queryClient.invalidateQueries({
          exact: true,
          queryKey: conversationQueryKeys.messages(tenantID, conversationID),
        }),
        queryClient.invalidateQueries({
          exact: true,
          queryKey: conversationQueryKeys.detail(tenantID, conversationID),
        }),
        queryClient.invalidateQueries({
          queryKey: conversationQueryKeys.lists(tenantID),
        }),
      ]);
    },
    retry: false,
    scope: conversationCSRFMutationScope,
  });
}

/** ADR-0042 host posting switch; the response is the new projection. */
export function useUpdateRoomConversationSettings(
  tenantID: string | undefined,
  conversationID: string | undefined,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (participantChatEnabled: boolean) => {
      const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
      return updateRoomConversationSettings(
        tenantID ?? "",
        conversationID ?? "",
        { participant_chat_enabled: participantChatEnabled },
        csrf.csrf_token,
        { baseUrl: getApiBaseUrl() },
      );
    },
    onSuccess: (conversation) => {
      if (!tenantID) return;
      queryClient.setQueryData(
        conversationQueryKeys.detail(tenantID, conversation.id),
        conversation,
      );
    },
    retry: false,
    scope: conversationCSRFMutationScope,
  });
}

/** Stages one attachment; uploads queue behind other CSRF mutations. */
export function useUploadConversationAttachment(
  tenantID: string | undefined,
  conversationID: string | undefined,
) {
  return useMutation({
    mutationFn: async (input: UploadConversationAttachmentInput) => {
      const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
      return uploadConversationAttachment(
        tenantID ?? "",
        conversationID ?? "",
        input,
        csrf.csrf_token,
        { baseUrl: getApiBaseUrl() },
      );
    },
    retry: false,
    scope: conversationCSRFMutationScope,
  });
}

export function useEditConversationMessage(
  tenantID: string | undefined,
  conversationID: string | undefined,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      content: string;
      expectedVersion: number;
      messageID: string;
    }) => {
      const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
      return editConversationMessage(
        tenantID ?? "",
        conversationID ?? "",
        input.messageID,
        { content: input.content, expected_version: input.expectedVersion },
        csrf.csrf_token,
        { baseUrl: getApiBaseUrl() },
      );
    },
    onSuccess: (message) => {
      if (!tenantID || !conversationID) return;
      upsertCachedConversationMessage(
        queryClient,
        tenantID,
        conversationID,
        message,
      );
      void queryClient.invalidateQueries({
        exact: true,
        queryKey: conversationQueryKeys.messages(tenantID, conversationID),
      });
    },
    retry: false,
    scope: conversationCSRFMutationScope,
  });
}

export function useDeleteConversationMessage(
  tenantID: string | undefined,
  conversationID: string | undefined,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      expectedVersion: number;
      messageID: string;
    }) => {
      const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
      return deleteConversationMessage(
        tenantID ?? "",
        conversationID ?? "",
        input.messageID,
        { expected_version: input.expectedVersion },
        csrf.csrf_token,
        { baseUrl: getApiBaseUrl() },
      );
    },
    onSuccess: (message) => {
      if (!tenantID || !conversationID) return;
      upsertCachedConversationMessage(
        queryClient,
        tenantID,
        conversationID,
        message,
      );
      void queryClient.invalidateQueries({
        exact: true,
        queryKey: conversationQueryKeys.messages(tenantID, conversationID),
      });
    },
    retry: false,
    scope: conversationCSRFMutationScope,
  });
}

/** Reauthorized attachment bytes for a revocable object URL. */
export function fetchConversationAttachmentBlob(
  tenantID: string,
  conversationID: string,
  attachmentID: string,
  signal?: AbortSignal,
) {
  return downloadConversationAttachmentBlob(
    tenantID,
    conversationID,
    attachmentID,
    { baseUrl: getApiBaseUrl(), signal },
  );
}

async function synchronizeConversation(
  queryClient: QueryClient,
  tenantID: string,
  conversation: Conversation,
) {
  await queryClient.cancelQueries({
    exact: true,
    queryKey: conversationQueryKeys.detail(tenantID, conversation.id),
  });
  queryClient.setQueryData(
    conversationQueryKeys.detail(tenantID, conversation.id),
    conversation,
  );
  await queryClient.invalidateQueries({
    queryKey: conversationQueryKeys.lists(tenantID),
  });
}

export function invalidateTenantConversations(
  queryClient: QueryClient,
  tenantID: string | undefined,
) {
  if (!tenantID) {
    return Promise.resolve();
  }
  return queryClient.invalidateQueries({
    queryKey: conversationQueryKeys.tenant(tenantID),
  });
}

export function useCreateDirectConversation(tenantID: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateDirectConversationRequest) => {
      const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
      return createDirectConversation(tenantID ?? "", input, csrf.csrf_token, {
        baseUrl: getApiBaseUrl(),
      });
    },
    onSuccess: (conversation) =>
      tenantID
        ? synchronizeConversation(queryClient, tenantID, conversation)
        : Promise.resolve(),
    onSettled: () =>
      Promise.all([
        invalidateTenantAudit(queryClient, tenantID),
        invalidateTenantCapabilities(queryClient, tenantID),
      ]),
    retry: false,
    scope: conversationCSRFMutationScope,
  });
}

export function useEnsureClassConversation(tenantID: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (classID: string) => {
      const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
      return ensureClassConversation(tenantID ?? "", classID, csrf.csrf_token, {
        baseUrl: getApiBaseUrl(),
      });
    },
    onSuccess: (conversation) =>
      tenantID
        ? synchronizeConversation(queryClient, tenantID, conversation)
        : Promise.resolve(),
    onSettled: () =>
      Promise.all([
        invalidateTenantAudit(queryClient, tenantID),
        invalidateTenantCapabilities(queryClient, tenantID),
      ]),
    retry: false,
    scope: conversationCSRFMutationScope,
  });
}

export function useEnsureMediaSpaceConversation(tenantID: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (mediaSpaceID: string) => {
      const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
      return ensureMediaSpaceConversation(
        tenantID ?? "",
        mediaSpaceID,
        csrf.csrf_token,
        { baseUrl: getApiBaseUrl() },
      );
    },
    onSuccess: (conversation) =>
      tenantID
        ? synchronizeConversation(queryClient, tenantID, conversation)
        : Promise.resolve(),
    onSettled: () =>
      Promise.all([
        invalidateTenantConversations(queryClient, tenantID),
        invalidateTenantAudit(queryClient, tenantID),
        invalidateTenantCapabilities(queryClient, tenantID),
      ]),
    retry: false,
    scope: conversationCSRFMutationScope,
  });
}
