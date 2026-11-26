import { describe, expect, it, vi } from "vitest";
import {
  APIRequestError,
  createRoomDocumentUploadIntent,
  getRoomStudyNote,
  issueRoomDocumentViewCapability,
  listRoomDocuments,
  putRoomStudyNote,
  saveRoomChatAttachment,
  updateRoomDocument,
} from "./index";
import type {
  ContentFile,
  RoomDocument,
  RoomDocumentPage,
  RoomDocumentViewCapability,
  RoomStudyNote,
} from "./index";

const tenantID = "7f44c093-1cb2-46ae-8285-779b78728524";
const spaceID = "0ce0994b-1d0c-4125-9ad0-dfba33f70322";
const fileID = "527a9874-df73-4bf7-97f0-10f0e6bd9a8d";
const actorID = "5391c8b2-1224-4105-a44e-452eb69d9884";
const options = (fetchMock: (request: Request) => Promise<Response>) => ({
  baseUrl: "https://web.example.test/api",
  fetch: fetchMock,
});

const readyDocument: RoomDocument = {
  id: fileID,
  owner_kind: "media_space",
  media_space_id: spaceID,
  class_id: null,
  display_name: "worksheet.pdf",
  declared_media_type: "application/pdf",
  expected_size_bytes: 4096,
  status: "ready",
  version: 4,
  page_count: 3,
  first_page_aspect: 0.7071,
  active_content: false,
  allow_student_download: false,
  rejection_reason: null,
  expires_at: "2030-09-06T10:00:00Z",
  uploaded_by_viewer: false,
  created_at: "2030-08-07T10:00:00Z",
  updated_at: "2030-08-07T10:01:00Z",
  viewer_access: {
    can_view: true,
    can_download_original: false,
    can_manage: false,
    can_retry_upload: false,
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("room document API", () => {
  it("reads only the signed-in user's note for the selected document", async () => {
    const empty: RoomStudyNote = {
      file_id: fileID,
      version: 0,
      entries: [],
      byte_length: 0,
      updated_at: null,
      expires_at: null,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(empty));
    const result = await getRoomStudyNote(
      tenantID,
      spaceID,
      fileID,
      options(fetchMock),
    );
    expect(result).toEqual(empty);
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    const url = new URL(request.url);
    expect(url.pathname).toBe(
      `/api/v1/media/spaces/${spaceID}/documents/${fileID}/study-note`,
    );
    expect(url.search).toBe("");
    expect(request.method).toBe("GET");
    expect(request.headers.get("X-TutorHub-Tenant-ID")).toBe(tenantID);
    expect(request.headers.get("X-CSRF-Token")).toBeNull();
  });

  it("saves a versioned note and surfaces a stale write", async () => {
    const body = {
      expected_version: 0,
      entries: [{ page: 1, text: "Page one" }],
    };
    const saved: RoomStudyNote = {
      file_id: fileID,
      version: 1,
      entries: body.entries,
      byte_length: 8,
      updated_at: "2030-08-07T10:01:00Z",
      expires_at: "2030-09-06T10:01:00Z",
    };
    const code = "room_document_version_conflict";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(saved))
      .mockResolvedValueOnce(
        jsonResponse(
          { type: "about:blank", title: "Stale note", status: 409, code },
          409,
        ),
      );
    const put = () =>
      putRoomStudyNote(
        tenantID,
        spaceID,
        fileID,
        body,
        "csrf-note",
        options(fetchMock),
      );
    await expect(put()).resolves.toEqual(saved);
    await expect(put()).rejects.toMatchObject({
      status: 409,
      problem: { code },
    });
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.method).toBe("PUT");
    expect(new URL(request.url).pathname).toBe(
      `/api/v1/media/spaces/${spaceID}/documents/${fileID}/study-note`,
    );
    expect(request.headers.get("X-TutorHub-Tenant-ID")).toBe(tenantID);
    expect(request.headers.get("X-CSRF-Token")).toBe("csrf-note");
    expect(await request.json()).toEqual(body);
  });

  it("returns the ready chat document for creation and replay, and preserves idempotency conflicts", async () => {
    const body = {
      conversation_id: "caed2e11-bae1-4b8b-a149-dd1abed76fd8",
      attachment_id: "66bb28b9-c284-4825-931c-33931cd10691",
      client_request_id: "c378f028-c458-47e9-ac33-075a312643fa",
    };
    const code = "file_idempotency_conflict";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(readyDocument, 201))
      .mockResolvedValueOnce(jsonResponse(readyDocument, 200))
      .mockResolvedValueOnce(
        jsonResponse(
          { type: "about:blank", title: "Request changed", status: 409, code },
          409,
        ),
      );
    for (let i = 0; i < 2; i++) {
      await expect(
        saveRoomChatAttachment(
          tenantID,
          spaceID,
          body,
          "csrf-chat",
          options(fetchMock),
        ),
      ).resolves.toEqual(readyDocument);
      const request = fetchMock.mock.calls[i]?.[0] as Request;
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe(
        `/api/v1/media/spaces/${spaceID}/documents/from-chat-attachment`,
      );
      expect(request.headers.get("X-TutorHub-Tenant-ID")).toBe(tenantID);
      expect(request.headers.get("X-CSRF-Token")).toBe("csrf-chat");
      expect(await request.json()).toEqual(body);
    }
    await expect(
      saveRoomChatAttachment(
        tenantID,
        spaceID,
        { ...body, scope: "class" },
        "csrf-chat",
        options(fetchMock),
      ),
    ).rejects.toMatchObject({ status: 409, problem: { code } });
  });

  it("binds the library page to the expected tenant and room", async () => {
    const page: RoomDocumentPage = {
      items: [readyDocument],
      next_cursor: "thrd1_next",
      viewer_access: {
        can_upload: false,
        can_upload_to_class: false,
        can_present: false,
        can_manage: false,
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(page));

    const result = await listRoomDocuments(
      tenantID,
      spaceID,
      { cursor: "thrd1_current", limit: 10 },
      options(fetchMock),
    );

    expect(result.items[0]?.page_count).toBe(3);
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.method).toBe("GET");
    expect(request.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(tenantID);
    expect(new URL(request.url).pathname).toBe(
      `/api/v1/media/spaces/${spaceID}/documents`,
    );
    expect(new URL(request.url).searchParams.get("cursor")).toBe(
      "thrd1_current",
    );
    expect(result.items[0]).not.toHaveProperty("creator_user_id");
    expect(result.items[0]).not.toHaveProperty("expected_checksum_sha256");
  });

  it("creates room upload intents with CSRF and an exact body", async () => {
    const pending: ContentFile = {
      id: fileID,
      class_id: null,
      owner_kind: "media_space",
      media_space_id: spaceID,
      creator_user_id: actorID,
      display_name: "worksheet.pdf",
      declared_media_type: "application/pdf",
      expected_size_bytes: 4096,
      expected_checksum_sha256: "ab".repeat(32),
      status: "pending",
      version: 1,
      upload_expires_at: "2030-08-07T10:15:00Z",
      created_at: "2030-08-07T10:00:00Z",
      updated_at: "2030-08-07T10:00:00Z",
      allow_student_download: false,
      active_content: false,
      viewer_access: { can_download: false, can_retry_upload: true },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(pending, 201));
    const body = {
      scope: "media_space" as const,
      display_name: "worksheet.pdf",
      declared_media_type: "application/pdf" as const,
      expected_size_bytes: 4096,
      checksum_sha256: "ab".repeat(32),
      client_request_id: "a5f25a16-60f6-44c1-a5f5-1d1c16a0c3e5",
    };

    const created = await createRoomDocumentUploadIntent(
      tenantID,
      spaceID,
      body,
      "csrf-token-value-01",
      options(fetchMock),
    );

    expect(created.owner_kind).toBe("media_space");
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.method).toBe("POST");
    expect(request.headers.get("X-CSRF-Token")).toBe("csrf-token-value-01");
    expect(new URL(request.url).pathname).toBe(
      `/api/v1/media/spaces/${spaceID}/documents/upload-intents`,
    );
    expect(await request.json()).toEqual(body);
  });

  it("issues view capabilities for one document without a request body", async () => {
    const capability: RoomDocumentViewCapability = {
      method: "GET",
      url: "https://storage.example.test/object?X-Amz-Signature=redacted",
      expires_at: "2030-08-07T10:05:00Z",
      version_id: "version-1",
      content_length_bytes: 4096,
      sha256: "ab".repeat(32),
      media_type: "application/pdf",
      page_count: 3,
      first_page_aspect: 0.7071,
      active_content: true,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(capability));

    const result = await issueRoomDocumentViewCapability(
      tenantID,
      spaceID,
      fileID,
      "csrf-token-value-01",
      options(fetchMock),
    );

    expect(result.version_id).toBe("version-1");
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe(
      `/api/v1/media/spaces/${spaceID}/documents/${fileID}/view-capabilities`,
    );
    expect(await request.text()).toBe("");
  });

  it("maps PATCH 200 to the document and 204 soft-delete to null", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ ...readyDocument, allow_student_download: true }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const updated = await updateRoomDocument(
      tenantID,
      spaceID,
      fileID,
      { expected_version: 4, allow_student_download: true },
      "csrf-token-value-01",
      options(fetchMock),
    );
    const deleted = await updateRoomDocument(
      tenantID,
      spaceID,
      fileID,
      { expected_version: 5, deleted: true },
      "csrf-token-value-01",
      options(fetchMock),
    );

    expect(updated?.allow_student_download).toBe(true);
    expect(deleted).toBeNull();
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.method).toBe("PATCH");
    expect(new URL(request.url).pathname).toBe(
      `/api/v1/media/spaces/${spaceID}/documents/${fileID}`,
    );
  });

  it("surfaces concealed 404 and disabled 503 problems", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            type: "about:blank",
            title: "Document unavailable",
            status: 404,
            code: "room_document_not_found",
          },
          404,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            type: "about:blank",
            title: "Documents tool disabled",
            status: 503,
            code: "feature_disabled",
          },
          503,
        ),
      );

    await expect(
      listRoomDocuments(tenantID, spaceID, {}, options(fetchMock)),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      issueRoomDocumentViewCapability(
        tenantID,
        spaceID,
        fileID,
        "csrf-token-value-01",
        options(fetchMock),
      ),
    ).rejects.toBeInstanceOf(APIRequestError);
  });

  it("rejects an empty expected tenant before sending", async () => {
    const fetchMock = vi.fn();
    await expect(
      listRoomDocuments(" ", spaceID, {}, options(fetchMock)),
    ).rejects.toThrow(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
