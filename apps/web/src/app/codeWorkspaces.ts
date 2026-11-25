import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  APIRequestError,
  createCodeWorkspace,
  deleteCodeWorkspaceActorGrant,
  exchangeCodeWorkspaceGrant,
  putCodeWorkspaceActorGrant,
  resolveCodeWorkspace,
  rotateCSRFToken,
  transitionCodeWorkspace,
  type CodeWorkspace,
  type CodeWorkspaceEditorGrant,
  type CodeWorkspaceProjection,
  type WhiteboardCapability,
} from "@tutorhub/api-client";

/**
 * ROOM-TOOLS-CODE-02B (ADR-0043 Slice 2): React Query layer for the shared
 * `code.workspace.v1` control plane, shaped exactly like `whiteboards.ts`.
 * Every capability is the server projection; the browser never infers one.
 */
function getApiBaseUrl() {
  return import.meta.env.VITE_API_BASE_URL ?? "/api";
}

export const codeWorkspaceQueryKeys = {
  tool: (tenantID: string, mediaSpaceID: string) =>
    ["code-workspace-tool", tenantID, mediaSpaceID] as const,
};

export type CodeWorkspaceOperation = "open" | "suspend" | "resume" | "close";

/** ADR-0043 §4: at most three attendees hold an unexpired edit grant. */
export const CODE_WORKSPACE_MAX_EDITORS = 3;
/** Server default and the UI's "10 minutes" grant. */
export const CODE_WORKSPACE_DEFAULT_GRANT_TTL_SECONDS = 600;

function shouldRetryCodeWorkspaceQuery(failureCount: number, error: Error) {
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
 * (session, membership, missing space or the feature switched off).
 */
const terminalCodeWorkspacePollStatuses: ReadonlySet<number> = new Set([
  401, 403, 404, 503,
]);

export interface CodeWorkspaceToolOptions {
  /** Re-read the projection on this interval while the tab is visible. */
  readonly pollIntervalMs?: number;
}

export function codeWorkspaceToolPollInterval(
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
    terminalCodeWorkspacePollStatuses.has(error.status)
  ) {
    return false;
  }
  return pollIntervalMs;
}

export function useCodeWorkspaceTool(
  tenantID: string,
  mediaSpaceID: string,
  enabled: boolean,
  { pollIntervalMs }: CodeWorkspaceToolOptions = {},
) {
  return useQuery({
    queryKey: codeWorkspaceQueryKeys.tool(tenantID, mediaSpaceID),
    queryFn: ({ signal }) =>
      resolveCodeWorkspace(tenantID, mediaSpaceID, {
        baseUrl: getApiBaseUrl(),
        signal,
      }),
    enabled,
    refetchInterval: (query) =>
      codeWorkspaceToolPollInterval(pollIntervalMs, query.state.error),
    refetchIntervalInBackground: false,
    retry: shouldRetryCodeWorkspaceQuery,
    staleTime: 2_000,
  });
}

function withWorkspace(
  current: CodeWorkspaceProjection | undefined,
  workspace: CodeWorkspace,
): CodeWorkspaceProjection {
  return {
    active_editor_grants:
      workspace.status === "open" ? (current?.active_editor_grants ?? []) : [],
    can_create: false,
    workspace,
  };
}

export function useCreateCodeWorkspace(tenantID: string, mediaSpaceID: string) {
  const queryClient = useQueryClient();
  const queryKey = codeWorkspaceQueryKeys.tool(tenantID, mediaSpaceID);
  return useMutation({
    mutationFn: async () => {
      const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
      return createCodeWorkspace(
        tenantID,
        mediaSpaceID,
        { idempotency_key: crypto.randomUUID() },
        csrf.csrf_token,
        { baseUrl: getApiBaseUrl() },
      );
    },
    onSuccess: (workspace) => {
      queryClient.setQueryData<CodeWorkspaceProjection>(queryKey, (current) =>
        withWorkspace(current, workspace),
      );
    },
    retry: false,
  });
}

export function useTransitionCodeWorkspace(
  tenantID: string,
  mediaSpaceID: string,
) {
  const queryClient = useQueryClient();
  const queryKey = codeWorkspaceQueryKeys.tool(tenantID, mediaSpaceID);
  return useMutation({
    mutationFn: async ({
      operation,
      workspace,
    }: {
      operation: CodeWorkspaceOperation;
      workspace: CodeWorkspace;
    }) => {
      const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
      return transitionCodeWorkspace(
        tenantID,
        workspace.id,
        operation,
        {
          expected_version: workspace.version,
          idempotency_key: crypto.randomUUID(),
        },
        csrf.csrf_token,
        { baseUrl: getApiBaseUrl() },
      );
    },
    onSuccess: (workspace) => {
      queryClient.setQueryData<CodeWorkspaceProjection>(queryKey, (current) =>
        withWorkspace(current, workspace),
      );
      void queryClient.invalidateQueries({ queryKey });
    },
    retry: false,
  });
}

export function usePutCodeWorkspaceEditorGrant(
  tenantID: string,
  mediaSpaceID: string,
) {
  const queryClient = useQueryClient();
  const queryKey = codeWorkspaceQueryKeys.tool(tenantID, mediaSpaceID);
  return useMutation({
    mutationFn: async ({
      participantKey,
      ttlSeconds = CODE_WORKSPACE_DEFAULT_GRANT_TTL_SECONDS,
      workspaceID,
    }: {
      participantKey: string;
      ttlSeconds?: number;
      workspaceID: string;
    }): Promise<CodeWorkspaceEditorGrant> => {
      const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
      return putCodeWorkspaceActorGrant(
        tenantID,
        workspaceID,
        participantKey,
        { ttl_seconds: ttlSeconds },
        csrf.csrf_token,
        { baseUrl: getApiBaseUrl() },
      );
    },
    onSuccess: (grant) => {
      queryClient.setQueryData<CodeWorkspaceProjection>(queryKey, (current) =>
        current
          ? {
              ...current,
              active_editor_grants: [
                ...current.active_editor_grants.filter(
                  (item) => item.participant_key !== grant.participant_key,
                ),
                grant,
              ],
            }
          : current,
      );
      void queryClient.invalidateQueries({ queryKey });
    },
    retry: false,
  });
}

export function useDeleteCodeWorkspaceEditorGrant(
  tenantID: string,
  mediaSpaceID: string,
) {
  const queryClient = useQueryClient();
  const queryKey = codeWorkspaceQueryKeys.tool(tenantID, mediaSpaceID);
  return useMutation({
    mutationFn: async ({
      participantKey,
      workspaceID,
    }: {
      participantKey: string;
      workspaceID: string;
    }) => {
      const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
      await deleteCodeWorkspaceActorGrant(
        tenantID,
        workspaceID,
        participantKey,
        csrf.csrf_token,
        { baseUrl: getApiBaseUrl() },
      );
      return participantKey;
    },
    onSuccess: (participantKey) => {
      queryClient.setQueryData<CodeWorkspaceProjection>(queryKey, (current) =>
        current
          ? {
              ...current,
              active_editor_grants: current.active_editor_grants.filter(
                (item) => item.participant_key !== participantKey,
              ),
            }
          : current,
      );
      void queryClient.invalidateQueries({ queryKey });
    },
    retry: false,
  });
}

/** One-time provider credential for the viewer's projected capability. */
export async function requestCodeWorkspaceGrant(
  tenantID: string,
  workspace: CodeWorkspace,
  capability: WhiteboardCapability,
  signal?: AbortSignal,
) {
  const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl(), signal });
  return exchangeCodeWorkspaceGrant(
    tenantID,
    workspace.id,
    {
      capability,
      expected_generation: workspace.current_generation,
      expected_revoke_generation: workspace.revoke_generation,
    },
    csrf.csrf_token,
    { baseUrl: getApiBaseUrl(), signal },
  );
}

/** `409 code_workspace_editor_limit`: the three-editor cap is reached. */
export function isCodeWorkspaceEditorLimitError(error: unknown): boolean {
  return (
    error instanceof APIRequestError &&
    error.status === 409 &&
    error.problem?.code === "code_workspace_editor_limit"
  );
}
