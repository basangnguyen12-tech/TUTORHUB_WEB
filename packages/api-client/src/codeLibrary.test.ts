import { describe, expect, it, vi } from "vitest";
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
  shareCodeScratchpad,
  updateCodeSnippet,
} from "./index";
import type {
  CodeScratchpad,
  CodeSharedScratchpad,
  CodeSnippet,
  CodeSnippetList,
} from "./index";

const tenantID = "7f44c093-1cb2-46ae-8285-779b78728524";
const spaceID = "19f169c1-ed6c-4a33-aa93-e410d555747d";
const classID = "2a6f4d0b-0f27-4c3e-9a40-6c7d3c1d5e21";
const snippetID = "5b0c6f0e-3d7a-4c38-9f15-2a7f9a3d1c11";
const scratchpadID = "0d6c4d64-8d4c-4f3c-b0f5-7b6e1b9b2a44";
const baseUrl = "https://web.example.test/api";

const snippet: CodeSnippet = {
  author_display_name: "Giáo viên",
  byte_length: 8,
  class_id: classID,
  content: "print(1)",
  content_sha256: `sha256:${"0".repeat(64)}`,
  created_at: "2030-08-03T00:00:00Z",
  description: "",
  file_name: "main.py",
  id: snippetID,
  language: "python",
  title: "Loop",
  updated_at: "2030-08-03T00:00:00Z",
  version: 1,
  viewer_capabilities: { can_delete: false, can_edit: false },
  visibility: "class",
};

const scratchpad: CodeScratchpad = {
  active_index: 0,
  byte_length: 3,
  created_at: "2030-08-03T00:00:00Z",
  expires_at: "2030-09-02T00:00:00Z",
  files: [{ content: "x=1", language: "python", name: "main.py" }],
  id: scratchpadID,
  media_space_id: spaceID,
  shared_at: null,
  shared_with_staff: false,
  stdin: "",
  updated_at: "2030-08-03T00:00:00Z",
  version: 1,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function problemResponse(code: string, status: number) {
  return new Response(
    JSON.stringify({ code, status, title: code, type: "about:blank" }),
    {
      headers: { "Content-Type": "application/problem+json" },
      status,
    },
  );
}

function requestAt(mock: ReturnType<typeof vi.fn>, index: number): Request {
  return mock.mock.calls[index]?.[0] as Request;
}

describe("ROOM-TOOLS-CODE-03A snippet library client", () => {
  it("lists with a bounded query, tenant assertion and no CSRF", async () => {
    const page: CodeSnippetList = {
      items: [
        {
          author_display_name: snippet.author_display_name,
          byte_length: snippet.byte_length,
          class_id: snippet.class_id,
          created_at: snippet.created_at,
          description: snippet.description,
          file_name: snippet.file_name,
          id: snippet.id,
          language: snippet.language,
          title: snippet.title,
          updated_at: snippet.updated_at,
          version: snippet.version,
          viewer_capabilities: snippet.viewer_capabilities,
          visibility: snippet.visibility,
        },
      ],
      next_cursor: "thcsv1_next",
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(page));
    await expect(
      listCodeSnippets(
        tenantID,
        {
          classID,
          cursor: "thcsv1_prev",
          language: "python",
          limit: 10,
          query: "50%_off",
          scope: "class",
        },
        { baseUrl, fetch: fetchMock },
      ),
    ).resolves.toEqual(page);
    const request = requestAt(fetchMock, 0);
    const url = new URL(request.url);
    expect(request.method).toBe("GET");
    expect(url.pathname).toBe("/api/v1/code-snippets");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      class_id: classID,
      cursor: "thcsv1_prev",
      language: "python",
      limit: "10",
      q: "50%_off",
      scope: "class",
    });
    expect(request.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(tenantID);
    expect(request.headers.get("X-CSRF-Token")).toBeNull();
  });

  it("rejects an inconsistent scope before any request", async () => {
    const fetchMock = vi.fn();
    await expect(
      listCodeSnippets(
        tenantID,
        { scope: "class" },
        { baseUrl, fetch: fetchMock },
      ),
    ).rejects.toBeInstanceOf(APIRequestError);
    await expect(
      listCodeSnippets(
        tenantID,
        { classID, scope: "personal" },
        { baseUrl, fetch: fetchMock },
      ),
    ).rejects.toBeInstanceOf(APIRequestError);
    await expect(
      listCodeSnippets(
        " ",
        { scope: "personal" },
        { baseUrl, fetch: fetchMock },
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates, reads, updates and soft-deletes with CSRF on every mutation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(snippet, 201))
      .mockResolvedValueOnce(jsonResponse(snippet))
      .mockResolvedValueOnce(jsonResponse({ ...snippet, version: 2 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(problemResponse("code_library_not_found", 404));
    await createCodeSnippet(
      tenantID,
      {
        class_id: classID,
        content: "print(1)",
        file_name: "main.py",
        idempotency_key: "code-snippet-create-0001",
        language: "python",
        title: "Loop",
        visibility: "class",
      },
      "create-csrf",
      { baseUrl, fetch: fetchMock },
    );
    const create = requestAt(fetchMock, 0);
    expect(create.method).toBe("POST");
    expect(create.headers.get("X-CSRF-Token")).toBe("create-csrf");
    expect(create.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(tenantID);
    await expect(create.json()).resolves.toMatchObject({
      class_id: classID,
      visibility: "class",
    });

    await expect(
      getCodeSnippet(tenantID, snippetID, { baseUrl, fetch: fetchMock }),
    ).resolves.toEqual(snippet);
    expect(new URL(requestAt(fetchMock, 1).url).pathname).toBe(
      `/api/v1/code-snippets/${snippetID}`,
    );

    await updateCodeSnippet(
      tenantID,
      snippetID,
      { content: "print(2)", expected_version: 1 },
      "update-csrf",
      { baseUrl, fetch: fetchMock },
    );
    const update = requestAt(fetchMock, 2);
    expect(update.method).toBe("PATCH");
    expect(update.headers.get("X-CSRF-Token")).toBe("update-csrf");
    await expect(update.json()).resolves.toEqual({
      content: "print(2)",
      expected_version: 1,
    });

    await expect(
      deleteCodeSnippet(tenantID, snippetID, "delete-csrf", {
        baseUrl,
        fetch: fetchMock,
      }),
    ).resolves.toBeUndefined();
    const remove = requestAt(fetchMock, 3);
    expect(remove.method).toBe("DELETE");
    expect(remove.headers.get("X-CSRF-Token")).toBe("delete-csrf");

    const failure = await deleteCodeSnippet(
      tenantID,
      snippetID,
      "delete-csrf",
      {
        baseUrl,
        fetch: fetchMock,
      },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(APIRequestError);
    expect((failure as APIRequestError).status).toBe(404);
    expect((failure as APIRequestError).problem?.code).toBe(
      "code_library_not_found",
    );
  });
});

describe("ROOM-TOOLS-CODE-03A scratchpad client", () => {
  it("reads, saves with CAS and toggles consent", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ scratchpad: null }))
      .mockResolvedValueOnce(jsonResponse(scratchpad))
      .mockResolvedValueOnce(
        problemResponse("code_scratchpad_version_conflict", 409),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          scratchpad: {
            ...scratchpad,
            shared_at: "2030-08-03T00:01:00Z",
            shared_with_staff: true,
          },
        }),
      );
    await expect(
      getCodeScratchpad(tenantID, spaceID, { baseUrl, fetch: fetchMock }),
    ).resolves.toEqual({ scratchpad: null });
    expect(new URL(requestAt(fetchMock, 0).url).pathname).toBe(
      `/api/v1/media/spaces/${spaceID}/code-scratchpad`,
    );

    const draft = {
      active_index: 0,
      expected_version: 0,
      files: [{ content: "x=1", language: "python" as const, name: "main.py" }],
      stdin: "",
    };
    await expect(
      putCodeScratchpad(tenantID, spaceID, draft, "put-csrf", {
        baseUrl,
        fetch: fetchMock,
      }),
    ).resolves.toEqual(scratchpad);
    const put = requestAt(fetchMock, 1);
    expect(put.method).toBe("PUT");
    expect(put.headers.get("X-CSRF-Token")).toBe("put-csrf");
    await expect(put.json()).resolves.toEqual(draft);

    const conflict = await putCodeScratchpad(
      tenantID,
      spaceID,
      draft,
      "put-csrf",
      { baseUrl, fetch: fetchMock },
    ).catch((error: unknown) => error);
    expect((conflict as APIRequestError).status).toBe(409);
    expect((conflict as APIRequestError).problem?.code).toBe(
      "code_scratchpad_version_conflict",
    );

    const shared = await shareCodeScratchpad(
      tenantID,
      spaceID,
      true,
      "share-csrf",
      { baseUrl, fetch: fetchMock },
    );
    expect(shared.scratchpad?.shared_with_staff).toBe(true);
    const share = requestAt(fetchMock, 3);
    expect(new URL(share.url).pathname).toBe(
      `/api/v1/media/spaces/${spaceID}/code-scratchpad/share`,
    );
    expect(share.headers.get("X-CSRF-Token")).toBe("share-csrf");
    await expect(share.json()).resolves.toEqual({ shared: true });
  });

  it("reads staff-only shared scratchpads by opaque identifiers", async () => {
    const detail: CodeSharedScratchpad = {
      active_file_name: "main.py",
      active_index: 0,
      active_language: "python",
      author_display_name: "Học sinh A",
      byte_length: 3,
      file_count: 1,
      files: scratchpad.files,
      id: scratchpadID,
      participant_key: null,
      shared_at: "2030-08-03T00:01:00Z",
      stdin: "",
      updated_at: "2030-08-03T00:00:00Z",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ items: [] }))
      .mockResolvedValueOnce(jsonResponse(detail))
      .mockResolvedValueOnce(problemResponse("code_library_not_found", 404));
    await expect(
      listSharedCodeScratchpads(tenantID, spaceID, {
        baseUrl,
        fetch: fetchMock,
      }),
    ).resolves.toEqual({ items: [] });
    expect(new URL(requestAt(fetchMock, 0).url).pathname).toBe(
      `/api/v1/media/spaces/${spaceID}/shared-scratchpads`,
    );
    await expect(
      getSharedCodeScratchpad(tenantID, spaceID, scratchpadID, {
        baseUrl,
        fetch: fetchMock,
      }),
    ).resolves.toEqual(detail);
    const read = requestAt(fetchMock, 1);
    expect(new URL(read.url).pathname).toBe(
      `/api/v1/media/spaces/${spaceID}/shared-scratchpads/${scratchpadID}`,
    );
    expect(read.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(tenantID);
    expect(read.headers.get("X-CSRF-Token")).toBeNull();
    await expect(
      getSharedCodeScratchpad(tenantID, spaceID, scratchpadID, {
        baseUrl,
        fetch: fetchMock,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
