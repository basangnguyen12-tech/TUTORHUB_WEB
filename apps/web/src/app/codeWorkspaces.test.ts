// @vitest-environment jsdom

import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
  CodeWorkspace,
  CodeWorkspaceProjection,
} from "@tutorhub/api-client";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  codeWorkspaceQueryKeys,
  codeWorkspaceToolPollInterval,
  isCodeWorkspaceEditorLimitError,
  requestCodeWorkspaceGrant,
  useCodeWorkspaceTool,
  useCreateCodeWorkspace,
  useDeleteCodeWorkspaceEditorGrant,
  usePutCodeWorkspaceEditorGrant,
  useTransitionCodeWorkspace,
} from "./codeWorkspaces";

const tenantID = "4b18543a-74de-419f-9fe8-d0c3dfc991eb";
const mediaSpaceID = "c2dc1048-1d90-4c90-ae50-5fb436bfb607";
const workspaceID = "5b0c6f0e-3d7a-4c38-9f15-2a7f9a3d1c11";
const participantKey = "0d6c4d64-8d4c-4f3c-b0f5-7b6e1b9b2a44";

function workspace(overrides: Partial<CodeWorkspace> = {}): CodeWorkspace {
  return {
    created_at: "2030-08-03T00:00:00Z",
    current_generation: 1,
    id: workspaceID,
    media_space_id: mediaSpaceID,
    revoke_generation: 1,
    status: "open",
    updated_at: "2030-08-03T00:00:00Z",
    version: 2,
    viewer_capabilities: {
      can_close: true,
      can_exchange_grant: true,
      can_manage_editor_grants: true,
      can_open: false,
      can_resume: false,
      can_suspend: true,
      capability: "present",
    },
    ...overrides,
  };
}

function projection(
  overrides: Partial<CodeWorkspaceProjection> = {},
): CodeWorkspaceProjection {
  return {
    active_editor_grants: [],
    can_create: false,
    workspace: workspace(),
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
      title: "Code workspace problem",
      type: `urn:tutorhub:problem:http-${status}`,
    },
    status,
  );
}

type Route = (request: Request) => Response | Promise<Response>;

/** Routes by `METHOD path`; every CSRF rotation returns a fresh token. */
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

const projectionPath = `/api/v1/media/spaces/${mediaSpaceID}/code-workspace`;

describe("codeWorkspaceToolPollInterval", () => {
  it("polls only for a positive requested interval", () => {
    expect(codeWorkspaceToolPollInterval(undefined, null)).toBe(false);
    expect(codeWorkspaceToolPollInterval(0, null)).toBe(false);
    expect(codeWorkspaceToolPollInterval(Number.NaN, null)).toBe(false);
    expect(codeWorkspaceToolPollInterval(4_000, null)).toBe(4_000);
  });
});

describe("useCodeWorkspaceTool", () => {
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
      () => useCodeWorkspaceTool(tenantID, mediaSpaceID, true),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.workspace?.id).toBe(workspaceID);
    const read = requests.find((request) => request.method === "GET");
    expect(read?.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(tenantID);
    expect(read?.headers.get("X-CSRF-Token")).toBeNull();
  });

  it("does not read while disabled and re-reads on the requested interval", async () => {
    const { fetchMock } = installFetch({
      [`GET ${projectionPath}`]: () => json(projection()),
    });
    const { wrapper } = createWrapper();
    renderHook(() => useCodeWorkspaceTool(tenantID, mediaSpaceID, false), {
      wrapper,
    });
    await settle(40);
    expect(fetchMock).not.toHaveBeenCalled();

    renderHook(
      () =>
        useCodeWorkspaceTool(tenantID, mediaSpaceID, true, {
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
          useCodeWorkspaceTool(tenantID, mediaSpaceID, true, {
            pollIntervalMs: 10,
          }),
        { wrapper },
      );

      await waitFor(() => expect(result.current.isError).toBe(true));
      const callsAtError = fetchMock.mock.calls.length;
      await settle(80);
      expect(fetchMock).toHaveBeenCalledTimes(callsAtError);
      expect(codeWorkspaceToolPollInterval(10, result.current.error)).toBe(
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
        useCodeWorkspaceTool(tenantID, mediaSpaceID, true, {
          pollIntervalMs: 10,
        }),
      { wrapper },
    );
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(4));
  });
});

describe("code workspace mutations", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("creates then opens with a rotated CSRF token and the tenant assertion", async () => {
    const created = workspace({
      status: "created",
      version: 1,
      viewer_capabilities: {
        ...workspace().viewer_capabilities,
        can_open: true,
        can_suspend: false,
      },
    });
    const opened = workspace({ version: 2 });
    const { requests } = installFetch({
      [`GET ${projectionPath}`]: () => json(projection({ workspace: opened })),
      [`POST ${projectionPath}`]: () => json(created, 201),
      [`POST /api/v1/code-workspaces/${workspaceID}/open`]: () => json(opened),
    });
    const { queryClient, wrapper } = createWrapper();
    const { result } = renderHook(
      () => ({
        create: useCreateCodeWorkspace(tenantID, mediaSpaceID),
        transition: useTransitionCodeWorkspace(tenantID, mediaSpaceID),
      }),
      { wrapper },
    );

    let createdWorkspace: CodeWorkspace | undefined;
    await act(async () => {
      createdWorkspace = await result.current.create.mutateAsync();
    });
    expect(
      queryClient.getQueryData<CodeWorkspaceProjection>(
        codeWorkspaceQueryKeys.tool(tenantID, mediaSpaceID),
      )?.workspace?.status,
    ).toBe("created");

    await act(async () => {
      await result.current.transition.mutateAsync({
        operation: "open",
        workspace: createdWorkspace as CodeWorkspace,
      });
    });

    const create = requests.find(
      (request) =>
        request.method === "POST" &&
        new URL(request.url).pathname.endsWith("/code-workspace"),
    );
    expect(create?.headers.get("X-CSRF-Token")).toBe("csrf-token-1");
    expect(create?.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(tenantID);
    const open = requests.find((request) =>
      new URL(request.url).pathname.endsWith("/open"),
    );
    expect(open?.headers.get("X-CSRF-Token")).toBe("csrf-token-2");
    expect(open?.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(tenantID);
    await expect(open?.clone().json()).resolves.toMatchObject({
      expected_version: 1,
    });
    expect(
      queryClient.getQueryData<CodeWorkspaceProjection>(
        codeWorkspaceQueryKeys.tool(tenantID, mediaSpaceID),
      )?.workspace?.status,
    ).toBe("open");
  });

  it("grants and revokes a temporary editor by participant key", async () => {
    const grant = {
      expires_at: "2030-08-03T00:10:00Z",
      participant_key: participantKey,
    };
    const { requests } = installFetch({
      [`GET ${projectionPath}`]: () => json(projection()),
      [`PUT /api/v1/code-workspaces/${workspaceID}/actor-grants/${participantKey}`]:
        () => json(grant),
      [`DELETE /api/v1/code-workspaces/${workspaceID}/actor-grants/${participantKey}`]:
        () => new Response(null, { status: 204 }),
    });
    const { queryClient, wrapper } = createWrapper();
    queryClient.setQueryData(
      codeWorkspaceQueryKeys.tool(tenantID, mediaSpaceID),
      projection(),
    );
    const { result } = renderHook(
      () => ({
        put: usePutCodeWorkspaceEditorGrant(tenantID, mediaSpaceID),
        remove: useDeleteCodeWorkspaceEditorGrant(tenantID, mediaSpaceID),
      }),
      { wrapper },
    );

    await act(async () => {
      await result.current.put.mutateAsync({
        participantKey,
        workspaceID,
      });
    });
    const put = requests.find((request) => request.method === "PUT");
    expect(put?.headers.get("X-CSRF-Token")).toMatch(/^csrf-token-/);
    expect(put?.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(tenantID);
    await expect(put?.clone().json()).resolves.toEqual({ ttl_seconds: 600 });

    await act(async () => {
      await result.current.remove.mutateAsync({ participantKey, workspaceID });
    });
    const remove = requests.find((request) => request.method === "DELETE");
    expect(remove?.headers.get("X-CSRF-Token")).toMatch(/^csrf-token-/);
    expect(remove?.headers.get("X-CSRF-Token")).not.toBe(
      put?.headers.get("X-CSRF-Token"),
    );
    expect(remove?.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(tenantID);
  });

  it("updates the cached projection immediately after a grant", async () => {
    const grant = {
      expires_at: "2030-08-03T00:10:00Z",
      participant_key: participantKey,
    };
    let resolveRefetch: (() => void) | undefined;
    installFetch({
      [`GET ${projectionPath}`]: () =>
        new Promise<Response>((resolve) => {
          resolveRefetch = () =>
            resolve(json(projection({ active_editor_grants: [grant] })));
        }),
      [`PUT /api/v1/code-workspaces/${workspaceID}/actor-grants/${participantKey}`]:
        () => json(grant),
    });
    const { queryClient, wrapper } = createWrapper();
    queryClient.setQueryData(
      codeWorkspaceQueryKeys.tool(tenantID, mediaSpaceID),
      projection(),
    );
    const { result } = renderHook(
      () => usePutCodeWorkspaceEditorGrant(tenantID, mediaSpaceID),
      { wrapper },
    );
    await act(async () => {
      await result.current.mutateAsync({ participantKey, workspaceID });
    });
    expect(
      queryClient.getQueryData<CodeWorkspaceProjection>(
        codeWorkspaceQueryKeys.tool(tenantID, mediaSpaceID),
      )?.active_editor_grants,
    ).toEqual([grant]);
    resolveRefetch?.();
  });

  it("classifies the 409 editor limit", async () => {
    installFetch({
      [`PUT /api/v1/code-workspaces/${workspaceID}/actor-grants/${participantKey}`]:
        () => problem(409, "code_workspace_editor_limit"),
    });
    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () => usePutCodeWorkspaceEditorGrant(tenantID, mediaSpaceID),
      { wrapper },
    );
    let failure: unknown;
    await act(async () => {
      failure = await result.current
        .mutateAsync({ participantKey, workspaceID })
        .catch((error: unknown) => error);
    });
    expect(isCodeWorkspaceEditorLimitError(failure)).toBe(true);
    expect(isCodeWorkspaceEditorLimitError(new Error("x"))).toBe(false);
  });

  it("exchanges a grant fenced by generation and revoke generation", async () => {
    const { requests } = installFetch({
      [`POST /api/v1/code-workspaces/${workspaceID}/grant-exchanges`]: () =>
        json({
          capability: "view",
          credential: "c".repeat(43),
          document_id: workspaceID,
          expires_at: "2030-08-03T00:00:30Z",
          generation: 4,
          provider_url: "wss://collab.example.test",
          revoke_generation: 2,
        }),
    });
    await requestCodeWorkspaceGrant(
      tenantID,
      workspace({ current_generation: 4, revoke_generation: 2 }),
      "view",
    );
    const exchange = requests.find((request) =>
      new URL(request.url).pathname.endsWith("/grant-exchanges"),
    );
    expect(exchange?.headers.get("X-CSRF-Token")).toBe("csrf-token-1");
    await expect(exchange?.clone().json()).resolves.toEqual({
      capability: "view",
      expected_generation: 4,
      expected_revoke_generation: 2,
    });
  });
});
