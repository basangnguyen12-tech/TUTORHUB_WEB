// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  APIRequestError,
  type CodeScratchpad,
  type CodeScratchpadProjection,
  type CodeSharedScratchpad,
  type CodeSnippet,
  type CodeSnippetSummary,
} from "@tutorhub/api-client";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codeLibraryErrorKind,
  codeLibraryPollInterval,
  codeLibraryQueryKeys,
  useCodeScratchpad,
  useCodeSnippets,
  useCreateCodeSnippet,
  useDeleteCodeSnippet,
  useLoadCodeSnippet,
  usePutCodeScratchpad,
  useShareCodeScratchpad,
  useSharedCodeScratchpad,
  useSharedCodeScratchpads,
  useUpdateCodeSnippet,
  type CodeSnippetFilters,
} from "./codeLibrary";

const tenantID = "4b18543a-74de-419f-9fe8-d0c3dfc991eb";
const mediaSpaceID = "c2dc1048-1d90-4c90-ae50-5fb436bfb607";
const classID = "2a6f4d0b-0f27-4c3e-9a40-6c7d3c1d5e21";
const snippetID = "5b0c6f0e-3d7a-4c38-9f15-2a7f9a3d1c11";
const scratchpadID = "0d6c4d64-8d4c-4f3c-b0f5-7b6e1b9b2a44";

const summary: CodeSnippetSummary = {
  author_display_name: "Thu Hà",
  byte_length: 8,
  class_id: null,
  created_at: "2030-08-03T00:00:00Z",
  description: "",
  file_name: "main.py",
  id: snippetID,
  language: "python",
  title: "Vòng lặp",
  updated_at: "2030-08-03T00:00:00Z",
  version: 1,
  viewer_capabilities: { can_delete: true, can_edit: true },
  visibility: "personal",
};
const snippet: CodeSnippet = {
  ...summary,
  content: "print(1)",
  content_sha256: `sha256:${"0".repeat(64)}`,
};
const scratchpad: CodeScratchpad = {
  active_index: 0,
  byte_length: 3,
  created_at: "2030-08-03T00:00:00Z",
  expires_at: "2030-09-02T00:00:00Z",
  files: [{ content: "x=1", language: "python", name: "main.py" }],
  id: scratchpadID,
  media_space_id: mediaSpaceID,
  shared_at: null,
  shared_with_staff: false,
  stdin: "",
  updated_at: "2030-08-03T00:00:00Z",
  version: 4,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function problem(status: number, code?: string) {
  return new Response(
    JSON.stringify({
      ...(code ? { code } : {}),
      status,
      title: "Code library problem",
      type: "about:blank",
    }),
    { headers: { "Content-Type": "application/problem+json" }, status },
  );
}

type Route = (request: Request) => Response | Promise<Response>;

/** Routes by `METHOD path`; each CSRF rotation returns a fresh token. */
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

function nonCSRF(requests: Request[]) {
  return requests.filter(
    (request) => !new URL(request.url).pathname.endsWith("/auth/csrf"),
  );
}

const personal: CodeSnippetFilters = {
  classID: null,
  language: null,
  query: "",
  scope: "personal",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useCodeSnippets", () => {
  it("lists one scope with the tenant assertion, no CSRF and keyset paging", async () => {
    const { requests } = installFetch({
      "GET /api/v1/code-snippets": [
        () => json({ items: [summary], next_cursor: "thcsv1_next" }),
        () =>
          json({
            items: [{ ...summary, id: scratchpadID, title: "Hàm" }],
            next_cursor: null,
          }),
      ],
    });
    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () =>
        useCodeSnippets(
          tenantID,
          { ...personal, language: "python", query: "  vòng " },
          true,
        ),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);
    const first = new URL(requests[0]!.url);
    expect(Object.fromEntries(first.searchParams)).toEqual({
      language: "python",
      limit: "20",
      q: "vòng",
      scope: "personal",
    });
    expect(requests[0]!.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(
      tenantID,
    );
    expect(requests[0]!.headers.get("X-CSRF-Token")).toBeNull();

    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(new URL(requests[1]!.url).searchParams.get("cursor")).toBe(
      "thcsv1_next",
    );
    await waitFor(() =>
      expect(
        result.current.data?.pages.flatMap((page) => page.items),
      ).toHaveLength(2),
    );
    expect(result.current.hasNextPage).toBe(false);
  });

  it("asks for class snippets only with a class and never without one", async () => {
    const { fetchMock, requests } = installFetch({
      "GET /api/v1/code-snippets": () => json({ items: [], next_cursor: null }),
    });
    const { wrapper } = createWrapper();
    renderHook(
      () =>
        useCodeSnippets(
          tenantID,
          { ...personal, classID: null, scope: "class" },
          true,
        ),
      { wrapper },
    );
    await new Promise((resolve) => globalThis.setTimeout(resolve, 30));
    expect(fetchMock).not.toHaveBeenCalled();

    const { result } = renderHook(
      () =>
        useCodeSnippets(
          tenantID,
          { ...personal, classID, scope: "class" },
          true,
        ),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = new URL(requests[0]!.url);
    expect(url.searchParams.get("scope")).toBe("class");
    expect(url.searchParams.get("class_id")).toBe(classID);
  });
});

describe("snippet mutations", () => {
  it("reads a detail once and reuses the cache for the same snippet", async () => {
    const { fetchMock } = installFetch({
      [`GET /api/v1/code-snippets/${snippetID}`]: () => json(snippet),
    });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useLoadCodeSnippet(tenantID), {
      wrapper,
    });
    await expect(result.current(snippetID)).resolves.toEqual(snippet);
    await expect(result.current(snippetID)).resolves.toEqual(snippet);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("creates, updates and deletes with a rotated CSRF token and the tenant assertion", async () => {
    const { requests } = installFetch({
      "POST /api/v1/code-snippets": () => json(snippet, 201),
      [`PATCH /api/v1/code-snippets/${snippetID}`]: () =>
        json({ ...snippet, title: "Mới", version: 2 }),
      [`DELETE /api/v1/code-snippets/${snippetID}`]: () =>
        new Response(null, { status: 204 }),
    });
    const { queryClient, wrapper } = createWrapper();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(
      () => ({
        create: useCreateCodeSnippet(tenantID),
        remove: useDeleteCodeSnippet(tenantID),
        update: useUpdateCodeSnippet(tenantID),
      }),
      { wrapper },
    );

    await act(async () => {
      await result.current.create.mutateAsync({
        class_id: null,
        content: "print(1)",
        description: "",
        file_name: "main.py",
        language: "python",
        title: "Vòng lặp",
        visibility: "personal",
      });
    });
    const create = nonCSRF(requests)[0]!;
    expect(create.headers.get("X-CSRF-Token")).toBe("csrf-token-1");
    expect(create.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(tenantID);
    const body = (await create.clone().json()) as { idempotency_key: string };
    expect(body.idempotency_key).toMatch(
      /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u,
    );
    expect(
      queryClient.getQueryData(
        codeLibraryQueryKeys.snippet(tenantID, snippetID),
      ),
    ).toEqual(snippet);

    await act(async () => {
      await result.current.update.mutateAsync({
        input: { expected_version: 1, title: "Mới" },
        snippetID,
      });
    });
    const update = nonCSRF(requests)[1]!;
    expect(update.method).toBe("PATCH");
    expect(update.headers.get("X-CSRF-Token")).toBe("csrf-token-2");
    await expect(update.clone().json()).resolves.toEqual({
      expected_version: 1,
      title: "Mới",
    });

    await act(async () => {
      await result.current.remove.mutateAsync(snippetID);
    });
    const remove = nonCSRF(requests)[2]!;
    expect(remove.method).toBe("DELETE");
    expect(remove.headers.get("X-CSRF-Token")).toBe("csrf-token-3");
    expect(
      queryClient.getQueryData(
        codeLibraryQueryKeys.snippet(tenantID, snippetID),
      ),
    ).toBeUndefined();
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: codeLibraryQueryKeys.snippetLists(tenantID),
    });
  });

  it("surfaces a snippet version conflict and drops the stale detail", async () => {
    installFetch({
      [`PATCH /api/v1/code-snippets/${snippetID}`]: () =>
        problem(409, "code_snippet_version_conflict"),
    });
    const { queryClient, wrapper } = createWrapper();
    queryClient.setQueryData(
      codeLibraryQueryKeys.snippet(tenantID, snippetID),
      snippet,
    );
    const { result } = renderHook(() => useUpdateCodeSnippet(tenantID), {
      wrapper,
    });
    const failure = await result.current
      .mutateAsync({ input: { expected_version: 1, title: "x" }, snippetID })
      .catch((error: unknown) => error);
    expect(codeLibraryErrorKind(failure)).toBe("version_conflict");
    expect(
      queryClient.getQueryData(
        codeLibraryQueryKeys.snippet(tenantID, snippetID),
      ),
    ).toBeUndefined();
  });
});

describe("scratchpad hooks", () => {
  const path = `/api/v1/media/spaces/${mediaSpaceID}/code-scratchpad`;

  it("reads the draft, saves with CAS and toggles consent without a version bump", async () => {
    const { requests } = installFetch({
      [`GET ${path}`]: () => json({ scratchpad: null }),
      [`PUT ${path}`]: () => json(scratchpad),
      [`PUT ${path}/share`]: () =>
        json({
          scratchpad: {
            ...scratchpad,
            shared_at: "2030-08-03T00:01:00Z",
            shared_with_staff: true,
          },
        }),
    });
    const { queryClient, wrapper } = createWrapper();
    const { result } = renderHook(
      () => ({
        put: usePutCodeScratchpad(tenantID, mediaSpaceID),
        read: useCodeScratchpad(tenantID, mediaSpaceID, true),
        share: useShareCodeScratchpad(tenantID, mediaSpaceID),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.read.isSuccess).toBe(true));
    expect(result.current.read.data).toEqual({ scratchpad: null });
    expect(requests[0]!.headers.get("X-CSRF-Token")).toBeNull();

    await act(async () => {
      await result.current.put.mutateAsync({
        active_index: 0,
        expected_version: 0,
        files: scratchpad.files,
        stdin: "",
      });
    });
    const put = nonCSRF(requests)[1]!;
    expect(put.method).toBe("PUT");
    expect(put.headers.get("X-CSRF-Token")).toBe("csrf-token-1");
    expect(put.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(tenantID);
    await expect(put.clone().json()).resolves.toMatchObject({
      expected_version: 0,
    });
    expect(
      queryClient.getQueryData<CodeScratchpadProjection>(
        codeLibraryQueryKeys.scratchpad(tenantID, mediaSpaceID),
      )?.scratchpad?.version,
    ).toBe(4);

    await act(async () => {
      await result.current.share.mutateAsync(true);
    });
    const share = nonCSRF(requests)[2]!;
    expect(new URL(share.url).pathname).toBe(`${path}/share`);
    expect(share.headers.get("X-CSRF-Token")).toBe("csrf-token-2");
    await expect(share.clone().json()).resolves.toEqual({ shared: true });
    const cached = queryClient.getQueryData<CodeScratchpadProjection>(
      codeLibraryQueryKeys.scratchpad(tenantID, mediaSpaceID),
    )?.scratchpad;
    expect(cached?.shared_with_staff).toBe(true);
    expect(cached?.version).toBe(4);
  });

  it("classifies the CAS conflict and size/quota refusals", async () => {
    installFetch({
      [`PUT ${path}`]: [
        () => problem(409, "code_scratchpad_version_conflict"),
        () => problem(413, "code_scratchpad_too_large"),
        () => problem(409, "code_storage_quota_exceeded"),
      ],
    });
    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () => usePutCodeScratchpad(tenantID, mediaSpaceID),
      { wrapper },
    );
    const input = {
      active_index: 0,
      expected_version: 3,
      files: scratchpad.files,
      stdin: "",
    };
    const kinds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      kinds.push(
        codeLibraryErrorKind(
          await result.current
            .mutateAsync(input)
            .catch((error: unknown) => error),
        ),
      );
    }
    expect(kinds).toEqual(["version_conflict", "too_large", "storage_quota"]);
  });
});

describe("shared scratchpads (staff)", () => {
  const listPath = `/api/v1/media/spaces/${mediaSpaceID}/shared-scratchpads`;
  const detail: CodeSharedScratchpad = {
    active_file_name: "main.py",
    active_index: 0,
    active_language: "python",
    author_display_name: "Minh Anh",
    byte_length: 3,
    file_count: 1,
    files: scratchpad.files,
    id: scratchpadID,
    participant_key: null,
    shared_at: "2030-08-03T00:01:00Z",
    stdin: "",
    updated_at: "2030-08-03T00:00:00Z",
  };

  it("reads the list and an opaque detail without CSRF", async () => {
    const { requests } = installFetch({
      [`GET ${listPath}`]: () => json({ items: [detail] }),
      [`GET ${listPath}/${scratchpadID}`]: () => json(detail),
    });
    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () => ({
        detail: useSharedCodeScratchpad(tenantID, mediaSpaceID, scratchpadID),
        list: useSharedCodeScratchpads(tenantID, mediaSpaceID, true),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.detail.isSuccess).toBe(true));
    expect(result.current.detail.data?.author_display_name).toBe("Minh Anh");
    for (const request of requests) {
      expect(request.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(
        tenantID,
      );
      expect(request.headers.get("X-CSRF-Token")).toBeNull();
    }
  });

  it("does not read a detail without an id and stops polling after a 404", async () => {
    const { fetchMock } = installFetch({
      [`GET ${listPath}`]: [() => json({ items: [] }), () => problem(404)],
    });
    const { wrapper } = createWrapper();
    renderHook(() => useSharedCodeScratchpad(tenantID, mediaSpaceID, null), {
      wrapper,
    });
    const { result } = renderHook(
      () =>
        useSharedCodeScratchpads(tenantID, mediaSpaceID, true, {
          pollIntervalMs: 10,
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    const calls = fetchMock.mock.calls.length;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 60));
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    expect(codeLibraryPollInterval(10, result.current.error)).toBe(false);
    expect(codeLibraryPollInterval(10, null)).toBe(10);
    expect(codeLibraryPollInterval(undefined, null)).toBe(false);
  });
});

describe("codeLibraryErrorKind", () => {
  it.each([
    [new APIRequestError(403), "forbidden"],
    [new APIRequestError(404), "not_found"],
    [new APIRequestError(400), "invalid"],
    [
      new APIRequestError(409, {
        code: "code_snippet_quota_exceeded",
        status: 409,
        title: "x",
        type: "about:blank",
      }),
      "snippet_quota",
    ],
    [
      new APIRequestError(409, {
        code: "code_scratchpad_empty",
        status: 409,
        title: "x",
        type: "about:blank",
      }),
      "empty",
    ],
    [
      new APIRequestError(503, {
        code: "feature_disabled",
        status: 503,
        title: "x",
        type: "about:blank",
      }),
      "feature_off",
    ],
    [new Error("network"), "failed"],
  ])("maps %o to %s", (error, kind) => {
    expect(codeLibraryErrorKind(error)).toBe(kind);
  });
});
