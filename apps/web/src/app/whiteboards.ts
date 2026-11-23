import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  APIRequestError,
  createWhiteboard,
  exchangeWhiteboardGrant,
  resolveWhiteboard,
  rotateCSRFToken,
  transitionWhiteboard,
  type WhiteboardCapability,
  type WhiteboardDocument,
} from "@tutorhub/api-client";

function getApiBaseUrl() {
  return import.meta.env.VITE_API_BASE_URL ?? "/api";
}

export const whiteboardQueryKeys = {
  tool: (tenantID: string, mediaSpaceID: string) =>
    ["whiteboard-tool", tenantID, mediaSpaceID] as const,
};

function shouldRetryWhiteboardQuery(failureCount: number, error: Error) {
  return (
    failureCount < 1 &&
    !(
      error instanceof APIRequestError &&
      error.status >= 400 &&
      error.status < 500
    )
  );
}

/**
 * Responses after which re-polling cannot succeed without a new decision
 * (session, membership, missing space or the feature being switched off), so
 * a background poll stops instead of hammering the Core API.
 */
const terminalWhiteboardPollStatuses: ReadonlySet<number> = new Set([
  401, 403, 404, 503,
]);

export interface WhiteboardToolOptions {
  /**
   * Re-read the server projection on this interval while the tab is visible.
   * Omitted (the default) keeps the one-shot behaviour of the tool itself.
   */
  readonly pollIntervalMs?: number;
}

/**
 * Polling interval for the whiteboard projection: only when a positive
 * interval is requested and the last fetch did not end in a terminal error.
 */
export function whiteboardToolPollInterval(
  pollIntervalMs: number | undefined,
  error: Error | null,
): number | false {
  if (
    pollIntervalMs === undefined ||
    !Number.isFinite(pollIntervalMs) ||
    pollIntervalMs <= 0
  ) {
    return false;
  }
  if (
    error instanceof APIRequestError &&
    terminalWhiteboardPollStatuses.has(error.status)
  ) {
    return false;
  }
  return pollIntervalMs;
}

export function useWhiteboardTool(
  tenantID: string,
  mediaSpaceID: string,
  enabled: boolean,
  { pollIntervalMs }: WhiteboardToolOptions = {},
) {
  return useQuery({
    queryKey: whiteboardQueryKeys.tool(tenantID, mediaSpaceID),
    queryFn: ({ signal }) =>
      resolveWhiteboard(tenantID, mediaSpaceID, {
        baseUrl: getApiBaseUrl(),
        signal,
      }),
    enabled,
    refetchInterval: (query) =>
      whiteboardToolPollInterval(pollIntervalMs, query.state.error),
    refetchIntervalInBackground: false,
    retry: shouldRetryWhiteboardQuery,
    staleTime: 5_000,
  });
}

export function usePrepareWhiteboard(tenantID: string, mediaSpaceID: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
      return createWhiteboard(
        tenantID,
        {
          idempotency_key: crypto.randomUUID(),
          media_space_id: mediaSpaceID,
        },
        csrf.csrf_token,
        { baseUrl: getApiBaseUrl() },
      );
    },
    onSuccess: (document) => {
      queryClient.setQueryData(
        whiteboardQueryKeys.tool(tenantID, mediaSpaceID),
        { can_create: false, document },
      );
    },
    retry: false,
  });
}

export function useTransitionWhiteboard(
  tenantID: string,
  mediaSpaceID: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      document,
      operation,
    }: {
      document: WhiteboardDocument;
      operation: "open" | "suspend" | "resume" | "close";
    }) => {
      const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
      return transitionWhiteboard(
        tenantID,
        document.id,
        operation,
        {
          expected_version: document.version,
          idempotency_key: crypto.randomUUID(),
        },
        csrf.csrf_token,
        { baseUrl: getApiBaseUrl() },
      );
    },
    onSuccess: (document) => {
      queryClient.setQueryData(
        whiteboardQueryKeys.tool(tenantID, mediaSpaceID),
        { can_create: false, document },
      );
    },
    retry: false,
  });
}

export async function requestWhiteboardGrant(
  tenantID: string,
  document: WhiteboardDocument,
  capability: WhiteboardCapability,
  signal?: AbortSignal,
) {
  const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl(), signal });
  return exchangeWhiteboardGrant(
    tenantID,
    document.id,
    {
      capability,
      expected_generation: document.current_generation,
      expected_revoke_generation: document.revoke_generation,
    },
    csrf.csrf_token,
    { baseUrl: getApiBaseUrl(), signal },
  );
}
