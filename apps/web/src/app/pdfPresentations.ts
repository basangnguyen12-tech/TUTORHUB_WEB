import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  APIRequestError,
  deletePdfPresentationActorGrant,
  exchangePdfPresentationGrant,
  presentPdfDocument,
  putPdfPresentationActorGrant,
  resolvePdfPresentation,
  rotateCSRFToken,
  transitionPdfPresentation,
  type PdfAnnotatorGrant,
  type PdfPresentation,
  type PdfPresentationProjection,
  type WhiteboardCapability,
} from "@tutorhub/api-client";

/**
 * ROOM-TOOLS-FILES-02B (ADR-0045 §4 Slice 2): React Query layer for the
 * classroom PDF presentation control plane (`pdf.annotations.v1`), shaped
 * exactly like `codeWorkspaces.ts`. Every capability is the server
 * projection; the browser never infers who presents, annotates or views.
 */
function getApiBaseUrl() {
  return import.meta.env.VITE_API_BASE_URL ?? "/api";
}

export const pdfPresentationQueryKeys = {
  tool: (tenantID: string, mediaSpaceID: string) =>
    ["pdf-presentation-tool", tenantID, mediaSpaceID] as const,
};

export type PdfPresentationOperation = "suspend" | "resume" | "close";

/** ADR-0045 §4: at most three attendees hold an unexpired annotator grant. */
export const PDF_PRESENTATION_MAX_ANNOTATORS = 3;
/** Server default and the UI's "10 minutes" grant. */
export const PDF_PRESENTATION_DEFAULT_GRANT_TTL_SECONDS = 600;
/** The connected room re-reads the projection on this interval. */
export const PDF_PRESENTATION_POLL_INTERVAL_MS = 4_000;

function shouldRetryPdfPresentationQuery(failureCount: number, error: Error) {
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
 * (session, admission, missing space or a feature switched off).
 */
const terminalPdfPresentationPollStatuses: ReadonlySet<number> = new Set([
  401, 403, 404, 503,
]);

export interface PdfPresentationToolOptions {
  /** Re-read the projection on this interval while the tab is visible. */
  readonly pollIntervalMs?: number;
}

export function pdfPresentationToolPollInterval(
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
    terminalPdfPresentationPollStatuses.has(error.status)
  ) {
    return false;
  }
  return pollIntervalMs;
}

export function usePdfPresentationTool(
  tenantID: string,
  mediaSpaceID: string,
  enabled: boolean,
  { pollIntervalMs }: PdfPresentationToolOptions = {},
) {
  return useQuery({
    queryKey: pdfPresentationQueryKeys.tool(tenantID, mediaSpaceID),
    queryFn: ({ signal }) =>
      resolvePdfPresentation(tenantID, mediaSpaceID, {
        baseUrl: getApiBaseUrl(),
        signal,
      }),
    enabled: enabled && Boolean(tenantID && mediaSpaceID),
    refetchInterval: (query) =>
      pdfPresentationToolPollInterval(pollIntervalMs, query.state.error),
    refetchIntervalInBackground: false,
    retry: shouldRetryPdfPresentationQuery,
    staleTime: 2_000,
  });
}

function withPresentation(
  current: PdfPresentationProjection | undefined,
  presentation: PdfPresentation,
): PdfPresentationProjection {
  const sameRow = current?.presentation?.id === presentation.id;
  return {
    active_annotator_grants:
      presentation.status === "open" && sameRow
        ? (current?.active_annotator_grants ?? [])
        : [],
    can_present: current?.can_present ?? false,
    presentation,
  };
}

/** One tap: opens (or atomically switches the room to) a ready document. */
export function usePresentPdfDocument(tenantID: string, mediaSpaceID: string) {
  const queryClient = useQueryClient();
  const queryKey = pdfPresentationQueryKeys.tool(tenantID, mediaSpaceID);
  return useMutation({
    mutationFn: async ({ fileID }: { fileID: string }) => {
      const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
      return presentPdfDocument(
        tenantID,
        mediaSpaceID,
        { file_id: fileID, idempotency_key: crypto.randomUUID() },
        csrf.csrf_token,
        { baseUrl: getApiBaseUrl() },
      );
    },
    onSuccess: (presentation) => {
      queryClient.setQueryData<PdfPresentationProjection>(queryKey, (current) =>
        withPresentation(current, presentation),
      );
      void queryClient.invalidateQueries({ queryKey });
    },
    retry: false,
  });
}

export function useTransitionPdfPresentation(
  tenantID: string,
  mediaSpaceID: string,
) {
  const queryClient = useQueryClient();
  const queryKey = pdfPresentationQueryKeys.tool(tenantID, mediaSpaceID);
  return useMutation({
    mutationFn: async ({
      operation,
      presentation,
    }: {
      operation: PdfPresentationOperation;
      presentation: PdfPresentation;
    }) => {
      const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
      return transitionPdfPresentation(
        tenantID,
        presentation.id,
        operation,
        {
          expected_version: presentation.version,
          idempotency_key: crypto.randomUUID(),
        },
        csrf.csrf_token,
        { baseUrl: getApiBaseUrl() },
      );
    },
    onSuccess: (presentation) => {
      queryClient.setQueryData<PdfPresentationProjection>(queryKey, (current) =>
        withPresentation(current, presentation),
      );
      void queryClient.invalidateQueries({ queryKey });
    },
    retry: false,
  });
}

export function usePutPdfPresentationAnnotatorGrant(
  tenantID: string,
  mediaSpaceID: string,
) {
  const queryClient = useQueryClient();
  const queryKey = pdfPresentationQueryKeys.tool(tenantID, mediaSpaceID);
  return useMutation({
    mutationFn: async ({
      participantKey,
      presentationID,
      ttlSeconds = PDF_PRESENTATION_DEFAULT_GRANT_TTL_SECONDS,
    }: {
      participantKey: string;
      presentationID: string;
      ttlSeconds?: number;
    }): Promise<PdfAnnotatorGrant> => {
      const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
      return putPdfPresentationActorGrant(
        tenantID,
        presentationID,
        participantKey,
        { ttl_seconds: ttlSeconds },
        csrf.csrf_token,
        { baseUrl: getApiBaseUrl() },
      );
    },
    onSuccess: (grant) => {
      queryClient.setQueryData<PdfPresentationProjection>(
        queryKey,
        (current) =>
          current
            ? {
                ...current,
                active_annotator_grants: [
                  ...current.active_annotator_grants.filter(
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

export function useDeletePdfPresentationAnnotatorGrant(
  tenantID: string,
  mediaSpaceID: string,
) {
  const queryClient = useQueryClient();
  const queryKey = pdfPresentationQueryKeys.tool(tenantID, mediaSpaceID);
  return useMutation({
    mutationFn: async ({
      participantKey,
      presentationID,
    }: {
      participantKey: string;
      presentationID: string;
    }) => {
      const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
      await deletePdfPresentationActorGrant(
        tenantID,
        presentationID,
        participantKey,
        csrf.csrf_token,
        { baseUrl: getApiBaseUrl() },
      );
      return participantKey;
    },
    onSuccess: (participantKey) => {
      queryClient.setQueryData<PdfPresentationProjection>(
        queryKey,
        (current) =>
          current
            ? {
                ...current,
                active_annotator_grants: current.active_annotator_grants.filter(
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

/** One-time `pdf.annotations.v1` credential for the projected capability. */
export async function requestPdfPresentationGrant(
  tenantID: string,
  presentation: PdfPresentation,
  capability: WhiteboardCapability,
  signal?: AbortSignal,
) {
  const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl(), signal });
  return exchangePdfPresentationGrant(
    tenantID,
    presentation.id,
    {
      capability,
      expected_generation: presentation.current_generation,
      expected_revoke_generation: presentation.revoke_generation,
    },
    csrf.csrf_token,
    { baseUrl: getApiBaseUrl(), signal },
  );
}

/** `409 pdf_presentation_annotator_limit`: the three-annotator cap. */
export function isPdfAnnotatorLimitError(error: unknown): boolean {
  return (
    error instanceof APIRequestError &&
    error.status === 409 &&
    error.problem?.code === "pdf_presentation_annotator_limit"
  );
}

/**
 * The room's auto-open key for the Documents tool: an open presentation with
 * a visible document the viewer may join. `revoke_generation` is part of the
 * key so `A → B → A` and `suspend → resume` bring the stage back exactly once,
 * while granting / revoking a student's pen (which does not change the row
 * the student sees) never reopens a stage that person closed.
 */
export function pdfPresentationAutoOpenKey(
  presentation: PdfPresentation | null | undefined,
): string | null {
  return presentation?.status === "open" &&
    presentation.document !== null &&
    presentation.viewer_capabilities.can_exchange_grant
    ? `${presentation.id}:${presentation.current_generation}:${presentation.revoke_generation}`
    : null;
}
