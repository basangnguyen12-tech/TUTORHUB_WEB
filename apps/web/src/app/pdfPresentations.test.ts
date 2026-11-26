// @vitest-environment jsdom

import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
  PdfPresentation,
  PdfPresentationProjection,
} from "@tutorhub/api-client";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isPdfAnnotatorLimitError,
  pdfPresentationAutoOpenKey,
  pdfPresentationQueryKeys,
  pdfPresentationToolPollInterval,
  requestPdfPresentationGrant,
  useDeletePdfPresentationAnnotatorGrant,
  usePdfPresentationTool,
  usePresentPdfDocument,
  usePutPdfPresentationAnnotatorGrant,
  useTransitionPdfPresentation,
} from "./pdfPresentations";

const tenantID = "4b18543a-74de-419f-9fe8-d0c3dfc991eb";
const mediaSpaceID = "c2dc1048-1d90-4c90-ae50-5fb436bfb607";
const presentationID = "7c0c6f0e-3d7a-4c38-9f15-2a7f9a3d1c22";
const fileID = "8d1c6f0e-3d7a-4c38-9f15-2a7f9a3d1c33";
const participantKey = "0d6c4d64-8d4c-4f3c-b0f5-7b6e1b9b2a44";

function presentation(
  overrides: Partial<PdfPresentation> = {},
): PdfPresentation {
  return {
    created_at: "2030-08-03T00:00:00Z",
    current_generation: 1,
    document: {
      active_content: false,
      allow_student_download: false,
      display_name: "De-kiem-tra.pdf",
      file_id: fileID,
      first_page_aspect: 0.7071,
      media_type: "application/pdf",
      page_count: 5,
      version_id: "v1",
    },
    file_id: fileID,
    id: presentationID,
    media_space_id: mediaSpaceID,
    page_count: 5,
    revoke_generation: 1,
    status: "open",
    updated_at: "2030-08-03T00:00:00Z",
    version: 2,
    version_id: "v1",
    viewer_capabilities: {
      can_close: true,
      can_exchange_grant: true,
      can_manage: true,
      can_manage_annotator_grants: true,
      can_resume: false,
      can_suspend: true,
      capability: "present",
    },
    ...overrides,
  };
}

function projection(
  overrides: Partial<PdfPresentationProjection> = {},
): PdfPresentationProjection {
  return {
    active_annotator_grants: [],
    can_present: true,
    presentation: presentation(),
    ...overrides,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function problem(status: number, code?: string) {
  return json(
    {
      ...(code ? { code } : {}),
      status,
      title: "PDF presentation problem",
      type: `urn:tutorhub:problem:http-${status}`,
    },
    status,
  );
}

type Route = (request: Request) => Response | Promise<Response>;

function installFetch(routes: Record<string, Route | Route[]>) {
  const requests: Request[] = [];
  let csrf = 0;
  const fetchMock = vi.fn(
    async (input: Request | string, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/api/v1/auth/csrf")) {
        csrf += 1;
        return json({ csrf_token: `csrf-token-${csrf}` });
      }
      const key = `${request.method} ${url.pathname.replace(/^.*\/api\/v1/, "/api/v1")}`;
      const route = routes[key];
      if (Array.isArray(route)) {
        const next = route.length > 1 ? route.shift() : route[0];
        if (next) return next(request);
      } else if (route) {
        return route(request);
      }
      return problem(404);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, requests };
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retryDelay: 0 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, wrapper };
}

async function settle(ms: number) {
  await new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

const projectionPath = `/api/v1/media/spaces/${mediaSpaceID}/pdf-presentation`;
const grantPath = `/api/v1/pdf-presentations/${presentationID}/actor-grants/${participantKey}`;

describe("pdfPresentationToolPollInterval", () => {
  it("polls only for a positive requested interval", () => {
    expect(pdfPresentationToolPollInterval(undefined, null)).toBe(false);
    expect(pdfPresentationToolPollInterval(0, null)).toBe(false);
    expect(pdfPresentationToolPollInterval(Number.NaN, null)).toBe(false);
    expect(pdfPresentationToolPollInterval(4_000, null)).toBe(4_000);
  });
});

describe("pdfPresentationAutoOpenKey", () => {
  it("keys an open, visible, joinable presentation by id, generation and revoke fence", () => {
    expect(pdfPresentationAutoOpenKey(presentation())).toBe(
      `${presentationID}:1:1`,
    );
    expect(
      pdfPresentationAutoOpenKey(
        presentation({ current_generation: 2, revoke_generation: 3 }),
      ),
    ).toBe(`${presentationID}:2:3`);
  });

  it("is null when suspended, closed, document-less or not joinable", () => {
    expect(pdfPresentationAutoOpenKey(null)).toBeNull();
    expect(pdfPresentationAutoOpenKey(undefined)).toBeNull();
    expect(
      pdfPresentationAutoOpenKey(presentation({ status: "suspended" })),
    ).toBeNull();
    expect(
      pdfPresentationAutoOpenKey(presentation({ document: null })),
    ).toBeNull();
    expect(
      pdfPresentationAutoOpenKey(
        presentation({
          viewer_capabilities: {
            ...presentation().viewer_capabilities,
            can_exchange_grant: false,
          },
        }),
      ),
    ).toBeNull();
  });
});

describe("usePdfPresentationTool", () => {
  beforeEach(() => focusManager.setFocused(true));
  afterEach(() => {
    cleanup();
    focusManager.setFocused(undefined);
    vi.unstubAllGlobals();
  });

  it("reads the MediaSpace projection with the tenant assertion and no CSRF", async () => {
    const { requests } = installFetch({
      [`GET ${projectionPath}`]: () => json(projection()),
    });
    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () => usePdfPresentationTool(tenantID, mediaSpaceID, true),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.presentation?.id).toBe(presentationID);
    const read = requests.find((request) => request.method === "GET");
    expect(read?.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(tenantID);
    expect(read?.headers.get("X-CSRF-Token")).toBeNull();
  });

  it("never reads while disabled (feature off) and re-reads on the interval", async () => {
    const { fetchMock } = installFetch({
      [`GET ${projectionPath}`]: () => json(projection()),
    });
    const { wrapper } = createWrapper();
    renderHook(() => usePdfPresentationTool(tenantID, mediaSpaceID, false), {
      wrapper,
    });
    await settle(40);
    expect(fetchMock).not.toHaveBeenCalled();

    renderHook(
      () =>
        usePdfPresentationTool(tenantID, mediaSpaceID, true, {
          pollIntervalMs: 10,
        }),
      { wrapper },
    );
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(2));
  });

  it.each([401, 403, 404, 503])(
    "stops the background poll after a terminal %i",
    async (status) => {
      const { fetchMock } = installFetch({
        [`GET ${projectionPath}`]: [
          () => json(projection()),
          () => problem(status),
        ],
      });
      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () =>
          usePdfPresentationTool(tenantID, mediaSpaceID, true, {
            pollIntervalMs: 10,
          }),
        { wrapper },
      );
      await waitFor(() => expect(result.current.isError).toBe(true));
      const callsAtError = fetchMock.mock.calls.length;
      await settle(80);
      expect(fetchMock).toHaveBeenCalledTimes(callsAtError);
      expect(pdfPresentationToolPollInterval(10, result.current.error)).toBe(
        false,
      );
    },
  );

  it("keeps polling after a transient 500", async () => {
    const { fetchMock } = installFetch({
      [`GET ${projectionPath}`]: [() => json(projection()), () => problem(500)],
    });
    const { wrapper } = createWrapper();
    renderHook(
      () =>
        usePdfPresentationTool(tenantID, mediaSpaceID, true, {
          pollIntervalMs: 10,
        }),
      { wrapper },
    );
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(4));
  });
});

describe("pdf presentation mutations", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("presents a document in one tap with a rotated CSRF token and an idempotency key", async () => {
    const presented = presentation();
    const { requests } = installFetch({
      [`GET ${projectionPath}`]: () => json(projection()),
      [`POST ${projectionPath}`]: () => json(presented, 201),
    });
    const { queryClient, wrapper } = createWrapper();
    queryClient.setQueryData(
      pdfPresentationQueryKeys.tool(tenantID, mediaSpaceID),
      projection({ presentation: null }),
    );
    const { result } = renderHook(
      () => usePresentPdfDocument(tenantID, mediaSpaceID),
      { wrapper },
    );
    await act(async () => {
      await result.current.mutateAsync({ fileID });
    });
    const post = requests.find((request) => request.method === "POST");
    expect(post?.headers.get("X-CSRF-Token")).toBe("csrf-token-1");
    expect(post?.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(tenantID);
    const body = (await post?.clone().json()) as {
      file_id: string;
      idempotency_key: string;
    };
    expect(body.file_id).toBe(fileID);
    expect(body.idempotency_key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,}$/u);
    const cached = queryClient.getQueryData<PdfPresentationProjection>(
      pdfPresentationQueryKeys.tool(tenantID, mediaSpaceID),
    );
    expect(cached?.presentation?.id).toBe(presentationID);
    expect(cached?.can_present).toBe(true);
  });

  it.each(["suspend", "resume", "close"] as const)(
    "%s carries expected_version and a fresh idempotency key",
    async (operation) => {
      const next = presentation({
        status:
          operation === "resume"
            ? "open"
            : operation === "suspend"
              ? "suspended"
              : "closed",
        version: 3,
      });
      const { requests } = installFetch({
        [`GET ${projectionPath}`]: () =>
          json(projection({ presentation: next })),
        [`POST /api/v1/pdf-presentations/${presentationID}/${operation}`]: () =>
          json(next),
      });
      const { queryClient, wrapper } = createWrapper();
      queryClient.setQueryData(
        pdfPresentationQueryKeys.tool(tenantID, mediaSpaceID),
        projection({
          active_annotator_grants: [
            {
              expires_at: "2030-08-03T00:10:00Z",
              participant_key: participantKey,
            },
          ],
        }),
      );
      const { result } = renderHook(
        () => useTransitionPdfPresentation(tenantID, mediaSpaceID),
        { wrapper },
      );
      await act(async () => {
        await result.current.mutateAsync({
          operation,
          presentation: presentation(),
        });
      });
      const call = requests.find((request) =>
        new URL(request.url).pathname.endsWith(`/${operation}`),
      );
      expect(call?.headers.get("X-CSRF-Token")).toMatch(/^csrf-token-/);
      const body = (await call?.clone().json()) as {
        expected_version: number;
        idempotency_key: string;
      };
      expect(body.expected_version).toBe(2);
      expect(body.idempotency_key.length).toBeGreaterThanOrEqual(16);
      const cached = queryClient.getQueryData<PdfPresentationProjection>(
        pdfPresentationQueryKeys.tool(tenantID, mediaSpaceID),
      );
      expect(cached?.presentation?.status).toBe(next.status);
      // A presentation that is no longer open has no live annotators.
      expect(cached?.active_annotator_grants.length).toBe(
        next.status === "open" ? 1 : 0,
      );
    },
  );

  it("grants (10 minutes by default) and revokes an annotator by participant key", async () => {
    const grant = {
      expires_at: "2030-08-03T00:10:00Z",
      participant_key: participantKey,
    };
    let refetchProjection = projection();
    const { requests } = installFetch({
      [`GET ${projectionPath}`]: () => json(refetchProjection),
      [`PUT ${grantPath}`]: () => json(grant),
      [`DELETE ${grantPath}`]: () => new Response(null, { status: 204 }),
    });
    const { queryClient, wrapper } = createWrapper();
    const key = pdfPresentationQueryKeys.tool(tenantID, mediaSpaceID);
    queryClient.setQueryData(key, projection());
    const { result } = renderHook(
      () => ({
        put: usePutPdfPresentationAnnotatorGrant(tenantID, mediaSpaceID),
        remove: useDeletePdfPresentationAnnotatorGrant(tenantID, mediaSpaceID),
      }),
      { wrapper },
    );
    refetchProjection = projection({ active_annotator_grants: [grant] });
    await act(async () => {
      await result.current.put.mutateAsync({ participantKey, presentationID });
    });
    const put = requests.find((request) => request.method === "PUT");
    expect(put?.headers.get("X-CSRF-Token")).toMatch(/^csrf-token-/);
    expect(put?.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(tenantID);
    await expect(put?.clone().json()).resolves.toEqual({ ttl_seconds: 600 });
    expect(
      queryClient.getQueryData<PdfPresentationProjection>(key)
        ?.active_annotator_grants,
    ).toEqual([grant]);

    refetchProjection = projection();
    await act(async () => {
      await result.current.remove.mutateAsync({
        participantKey,
        presentationID,
      });
    });
    const remove = requests.find((request) => request.method === "DELETE");
    expect(remove?.headers.get("X-CSRF-Token")).toMatch(/^csrf-token-/);
    expect(remove?.headers.get("X-CSRF-Token")).not.toBe(
      put?.headers.get("X-CSRF-Token"),
    );
    expect(
      queryClient.getQueryData<PdfPresentationProjection>(key)
        ?.active_annotator_grants,
    ).toEqual([]);
  });

  it("classifies the 409 annotator limit", async () => {
    installFetch({
      [`PUT ${grantPath}`]: () =>
        problem(409, "pdf_presentation_annotator_limit"),
    });
    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () => usePutPdfPresentationAnnotatorGrant(tenantID, mediaSpaceID),
      { wrapper },
    );
    let failure: unknown;
    await act(async () => {
      failure = await result.current
        .mutateAsync({ participantKey, presentationID })
        .catch((error: unknown) => error);
    });
    expect(isPdfAnnotatorLimitError(failure)).toBe(true);
    expect(isPdfAnnotatorLimitError(new Error("x"))).toBe(false);
  });

  it("exchanges a one-time credential fenced by generation and revoke generation", async () => {
    const credential = {
      capability: "view",
      credential: "opaque-credential",
      document_id: presentationID,
      expires_at: "2030-08-03T00:01:00Z",
      generation: 2,
      provider_url: "wss://collab.example.test",
      revoke_generation: 4,
    };
    const { requests } = installFetch({
      [`POST /api/v1/pdf-presentations/${presentationID}/grant-exchanges`]:
        () => json(credential),
    });
    await expect(
      requestPdfPresentationGrant(
        tenantID,
        presentation({ current_generation: 2, revoke_generation: 4 }),
        "view",
      ),
    ).resolves.toMatchObject({
      capability: "view",
      document_id: presentationID,
    });
    const exchange = requests.find((request) =>
      new URL(request.url).pathname.endsWith("/grant-exchanges"),
    );
    expect(exchange?.headers.get("X-CSRF-Token")).toBe("csrf-token-1");
    await expect(exchange?.clone().json()).resolves.toEqual({
      capability: "view",
      expected_generation: 2,
      expected_revoke_generation: 4,
    });
  });
});
