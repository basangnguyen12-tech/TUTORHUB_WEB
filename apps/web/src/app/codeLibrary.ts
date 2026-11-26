import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  APIRequestError,
  createCodeSnippet,
  deleteCodeSnippet,
  getCodeScratchpad,
  getCodeSnippet,
  getSharedCodeScratchpad,
  listCodeSnippets,
  listSharedCodeScratchpads,
  putCodeScratchpad,
  rotateCSRFToken,
  shareCodeScratchpad,
  updateCodeSnippet,
  type CodeLanguage,
  type CodeScratchpad,
  type CodeScratchpadProjection,
  type CodeSnippet,
  type CodeSnippetListQuery,
  type CodeSnippetVisibility,
  type CreateCodeSnippetRequest,
  type PutCodeScratchpadRequest,
  type UpdateCodeSnippetRequest,
} from "@tutorhub/api-client";

/**
 * ROOM-TOOLS-CODE-03B (ADR-0043 Slice 3): React Query layer for the durable
 * snippet library and the per-room scratchpad. Reads carry only the expected
 * tenant; every mutation rotates the BFF CSRF token first. Who may read,
 * share, edit or delete is decided by the server alone (404 concealment).
 */
function getApiBaseUrl() {
  return import.meta.env.VITE_API_BASE_URL ?? "/api";
}

/** Server page size for the drawer (server default 20, maximum 50). */
export const CODE_SNIPPET_PAGE_SIZE = 20;
/** Bounds mirrored from the server so the form refuses early. */
export const CODE_SNIPPET_MAX_TITLE = 120;
export const CODE_SNIPPET_MAX_DESCRIPTION = 280;
export const CODE_SNIPPET_MAX_QUERY = 100;
export const CODE_SNIPPET_MAX_CONTENT_BYTES = 64 * 1024;

export interface CodeSnippetFilters {
  readonly classID: string | null;
  readonly language: CodeLanguage | null;
  readonly query: string;
  readonly scope: CodeSnippetVisibility;
}

export const codeLibraryQueryKeys = {
  all: (tenantID: string) => ["code-library", tenantID] as const,
  snippetLists: (tenantID: string) =>
    ["code-library", tenantID, "snippets"] as const,
  snippetList: (tenantID: string, filters: CodeSnippetFilters) =>
    [
      "code-library",
      tenantID,
      "snippets",
      filters.scope,
      filters.classID ?? "",
      filters.language ?? "",
      filters.query.trim(),
    ] as const,
  snippet: (tenantID: string, snippetID: string) =>
    ["code-library", tenantID, "snippet", snippetID] as const,
  scratchpad: (tenantID: string, mediaSpaceID: string) =>
    ["code-library", tenantID, "scratchpad", mediaSpaceID] as const,
  sharedScratchpads: (tenantID: string, mediaSpaceID: string) =>
    ["code-library", tenantID, "shared-scratchpads", mediaSpaceID] as const,
  sharedScratchpad: (
    tenantID: string,
    mediaSpaceID: string,
    scratchpadID: string,
  ) =>
    [
      "code-library",
      tenantID,
      "shared-scratchpads",
      mediaSpaceID,
      scratchpadID,
    ] as const,
};

/** UI-level classification of a code library failure. */
export type CodeLibraryErrorKind =
  | "empty"
  | "failed"
  | "feature_off"
  | "forbidden"
  | "invalid"
  | "not_found"
  | "scope_changed"
  | "snippet_quota"
  | "storage_quota"
  | "too_large"
  | "version_conflict";

export function codeLibraryErrorKind(error: unknown): CodeLibraryErrorKind {
  if (!(error instanceof APIRequestError)) return "failed";
  switch (error.problem?.code) {
    case "code_scratchpad_version_conflict":
    case "code_snippet_version_conflict":
      return "version_conflict";
    case "code_snippet_quota_exceeded":
      return "snippet_quota";
    case "code_storage_quota_exceeded":
    case "code_library_quota_exceeded":
      return "storage_quota";
    case "code_scratchpad_too_large":
      return "too_large";
    case "code_scratchpad_empty":
      return "empty";
    case "code_library_scope_changed":
      return "scope_changed";
    case "feature_disabled":
      return "feature_off";
    default:
      break;
  }
  switch (error.status) {
    case 400:
      return "invalid";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 413:
      return "too_large";
    case 503:
      return "feature_off";
    default:
      return "failed";
  }
}

function shouldRetryCodeLibraryQuery(failureCount: number, error: Error) {
  return (
    failureCount < 1 &&
    !(
      error instanceof APIRequestError &&
      error.status >= 400 &&
      error.status < 500
    )
  );
}

/** Polling stops once only a new decision could change the answer. */
const terminalPollStatuses: ReadonlySet<number> = new Set([401, 403, 404, 503]);

export function codeLibraryPollInterval(
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
    terminalPollStatuses.has(error.status)
  ) {
    return false;
  }
  return pollIntervalMs;
}

function listQuery(
  filters: CodeSnippetFilters,
  cursor: string | null,
): CodeSnippetListQuery {
  const query = filters.query.trim();
  return {
    scope: filters.scope,
    ...(filters.scope === "class" && filters.classID
      ? { classID: filters.classID }
      : {}),
    ...(filters.language ? { language: filters.language } : {}),
    ...(query ? { query } : {}),
    ...(cursor ? { cursor } : {}),
    limit: CODE_SNIPPET_PAGE_SIZE,
  };
}

/** Keyset-paginated snippet summaries (no content) for one scope. */
export function useCodeSnippets(
  tenantID: string,
  filters: CodeSnippetFilters,
  enabled: boolean,
) {
  return useInfiniteQuery({
    queryKey: codeLibraryQueryKeys.snippetList(tenantID, filters),
    queryFn: ({ pageParam, signal }) =>
      listCodeSnippets(tenantID, listQuery(filters, pageParam), {
        baseUrl: getApiBaseUrl(),
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor ?? null,
    enabled:
      enabled &&
      Boolean(tenantID) &&
      (filters.scope === "personal" || Boolean(filters.classID)),
    retry: shouldRetryCodeLibraryQuery,
    staleTime: 15_000,
  });
}

/**
 * Lists carry no content: opening or inserting a server snippet reads its
 * detail once, cached per (tenant, snippet).
 */
export function useLoadCodeSnippet(tenantID: string) {
  const queryClient = useQueryClient();
  return (snippetID: string): Promise<CodeSnippet> =>
    queryClient.fetchQuery({
      queryKey: codeLibraryQueryKeys.snippet(tenantID, snippetID),
      queryFn: ({ signal }) =>
        getCodeSnippet(tenantID, snippetID, {
          baseUrl: getApiBaseUrl(),
          signal,
        }),
      staleTime: 60_000,
    });
}

export type CreateCodeSnippetInput = Omit<
  CreateCodeSnippetRequest,
  "idempotency_key"
>;

export function useCreateCodeSnippet(tenantID: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateCodeSnippetInput) => {
      const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
      return createCodeSnippet(
        tenantID,
        { ...input, idempotency_key: crypto.randomUUID() },
        csrf.csrf_token,
        { baseUrl: getApiBaseUrl() },
      );
    },
    onSuccess: (snippet) => {
      queryClient.setQueryData(
        codeLibraryQueryKeys.snippet(tenantID, snippet.id),
        snippet,
      );
      void queryClient.invalidateQueries({
        queryKey: codeLibraryQueryKeys.snippetLists(tenantID),
      });
    },
    retry: false,
  });
}

export function useUpdateCodeSnippet(tenantID: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      input,
      snippetID,
    }: {
      input: UpdateCodeSnippetRequest;
      snippetID: string;
    }) => {
      const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
      return updateCodeSnippet(tenantID, snippetID, input, csrf.csrf_token, {
        baseUrl: getApiBaseUrl(),
      });
    },
    onSuccess: (snippet) => {
      queryClient.setQueryData(
        codeLibraryQueryKeys.snippet(tenantID, snippet.id),
        snippet,
      );
      void queryClient.invalidateQueries({
        queryKey: codeLibraryQueryKeys.snippetLists(tenantID),
      });
    },
    onError: (_error, { snippetID }) => {
      // A conflict or a vanished snippet: drop the stale copy and re-list.
      queryClient.removeQueries({
        queryKey: codeLibraryQueryKeys.snippet(tenantID, snippetID),
      });
      void queryClient.invalidateQueries({
        queryKey: codeLibraryQueryKeys.snippetLists(tenantID),
      });
    },
    retry: false,
  });
}

export function useDeleteCodeSnippet(tenantID: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (snippetID: string) => {
      const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
      await deleteCodeSnippet(tenantID, snippetID, csrf.csrf_token, {
        baseUrl: getApiBaseUrl(),
      });
      return snippetID;
    },
    onSettled: (_result, _error, snippetID) => {
      queryClient.removeQueries({
        queryKey: codeLibraryQueryKeys.snippet(tenantID, snippetID),
      });
      void queryClient.invalidateQueries({
        queryKey: codeLibraryQueryKeys.snippetLists(tenantID),
      });
    },
    retry: false,
  });
}

/* ---- Scratchpad ------------------------------------------------------- */

/** Plain calls shared by the hooks and the autosave controller. */
export function fetchCodeScratchpad(
  tenantID: string,
  mediaSpaceID: string,
  signal?: AbortSignal,
): Promise<CodeScratchpadProjection> {
  return getCodeScratchpad(tenantID, mediaSpaceID, {
    baseUrl: getApiBaseUrl(),
    signal,
  });
}

export async function saveCodeScratchpad(
  tenantID: string,
  mediaSpaceID: string,
  input: PutCodeScratchpadRequest,
): Promise<CodeScratchpad> {
  const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
  return putCodeScratchpad(tenantID, mediaSpaceID, input, csrf.csrf_token, {
    baseUrl: getApiBaseUrl(),
  });
}

export async function setCodeScratchpadShared(
  tenantID: string,
  mediaSpaceID: string,
  shared: boolean,
): Promise<CodeScratchpadProjection> {
  const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
  return shareCodeScratchpad(tenantID, mediaSpaceID, shared, csrf.csrf_token, {
    baseUrl: getApiBaseUrl(),
  });
}

export function useCodeScratchpad(
  tenantID: string,
  mediaSpaceID: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: codeLibraryQueryKeys.scratchpad(tenantID, mediaSpaceID),
    queryFn: ({ signal }) =>
      fetchCodeScratchpad(tenantID, mediaSpaceID, signal),
    enabled: enabled && Boolean(tenantID && mediaSpaceID),
    refetchOnWindowFocus: false,
    retry: shouldRetryCodeLibraryQuery,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function usePutCodeScratchpad(tenantID: string, mediaSpaceID: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PutCodeScratchpadRequest) =>
      saveCodeScratchpad(tenantID, mediaSpaceID, input),
    onSuccess: (scratchpad) => {
      queryClient.setQueryData<CodeScratchpadProjection>(
        codeLibraryQueryKeys.scratchpad(tenantID, mediaSpaceID),
        { scratchpad },
      );
    },
    retry: false,
  });
}

/** Consent toggle; it never bumps the draft `version`. */
export function useShareCodeScratchpad(tenantID: string, mediaSpaceID: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (shared: boolean) =>
      setCodeScratchpadShared(tenantID, mediaSpaceID, shared),
    onSuccess: (projection) => {
      queryClient.setQueryData<CodeScratchpadProjection>(
        codeLibraryQueryKeys.scratchpad(tenantID, mediaSpaceID),
        projection,
      );
    },
    retry: false,
  });
}

export interface SharedCodeScratchpadsOptions {
  /** Re-read on this interval while the tab is visible (drawer open). */
  readonly pollIntervalMs?: number;
}

/** Staff-only list of drafts their owners explicitly shared. */
export function useSharedCodeScratchpads(
  tenantID: string,
  mediaSpaceID: string,
  enabled: boolean,
  { pollIntervalMs }: SharedCodeScratchpadsOptions = {},
) {
  return useQuery({
    queryKey: codeLibraryQueryKeys.sharedScratchpads(tenantID, mediaSpaceID),
    queryFn: ({ signal }) =>
      listSharedCodeScratchpads(tenantID, mediaSpaceID, {
        baseUrl: getApiBaseUrl(),
        signal,
      }),
    enabled: enabled && Boolean(tenantID && mediaSpaceID),
    refetchInterval: (query) =>
      codeLibraryPollInterval(pollIntervalMs, query.state.error),
    refetchIntervalInBackground: false,
    retry: shouldRetryCodeLibraryQuery,
    staleTime: 2_000,
  });
}

export function useSharedCodeScratchpad(
  tenantID: string,
  mediaSpaceID: string,
  scratchpadID: string | null,
) {
  return useQuery({
    queryKey: codeLibraryQueryKeys.sharedScratchpad(
      tenantID,
      mediaSpaceID,
      scratchpadID ?? "",
    ),
    queryFn: ({ signal }) =>
      getSharedCodeScratchpad(tenantID, mediaSpaceID, scratchpadID ?? "", {
        baseUrl: getApiBaseUrl(),
        signal,
      }),
    enabled: Boolean(tenantID && mediaSpaceID && scratchpadID),
    refetchOnWindowFocus: false,
    retry: shouldRetryCodeLibraryQuery,
    staleTime: 2_000,
  });
}
