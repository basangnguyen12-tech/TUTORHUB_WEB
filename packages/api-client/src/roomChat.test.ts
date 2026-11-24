import { describe, expect, it, vi } from "vitest";
import {
  APIRequestError,
  downloadConversationAttachmentBlob,
  sendConversationMessage,
  updateRoomConversationSettings,
  uploadConversationAttachment,
} from "./index";
import type {
  ActiveMessage,
  Conversation,
  MessageAttachment,
  SendMessageRequest,
} from "./index";

const tenantID = "7f44c093-1cb2-46ae-8285-779b78728524";
const conversationID = "c2dc1048-1d90-4c90-ae50-5fb436bfb607";
const attachmentID = "3c9b6a8e-7c43-4bd0-8e4e-6bd1a8c9a0f1";
const clientAttachmentID = "f1e2d3c4-b5a6-4978-8899-aabbccddeeff";
const baseUrl = "https://web.example.test/api";

const roomConversation: Conversation = {
  created_at: "2030-08-03T00:00:00Z",
  id: conversationID,
  kind: "room",
  media_space_id: "19f169c1-ed6c-4a33-aa93-e410d555747d",
  media_space_status: "open",
  participant_chat_enabled: false,
  participants: [],
  title: "Lớp Toán 10",
  unread_count: 0,
  unread_count_capped: false,
  updated_at: "2030-08-03T00:00:00Z",
  viewer_access: {
    can_moderate_chat: true,
    can_post_messages: true,
    can_upload_attachments: true,
  },
};

const attachment: MessageAttachment = {
  conversation_id: conversationID,
  created_at: "2030-08-03T00:00:00Z",
  display_name: "bai-tap.png",
  height_px: 480,
  id: attachmentID,
  kind: "image",
  media_type: "image/png",
  size_bytes: 9,
  width_px: 640,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

describe("ROOM-CHAT-01 room chat client", () => {
  it("patches the host posting switch with CSRF and tenant scope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(roomConversation));
    await expect(
      updateRoomConversationSettings(
        tenantID,
        conversationID,
        { participant_chat_enabled: false },
        "settings-csrf",
        { baseUrl, fetch: fetchMock },
      ),
    ).resolves.toEqual(roomConversation);
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.method).toBe("PATCH");
    expect(new URL(request.url).pathname).toBe(
      `/api/v1/conversations/${conversationID}/room-settings`,
    );
    expect(request.credentials).toBe("include");
    expect(request.headers.get("X-CSRF-Token")).toBe("settings-csrf");
    expect(request.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(tenantID);
    await expect(request.json()).resolves.toEqual({
      participant_chat_enabled: false,
    });
  });

  it("uploads multipart bytes without putting secrets in the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(attachment, 201));
    const file = new Blob([new Uint8Array([137, 80, 78, 71])], {
      type: "image/png",
    });
    await expect(
      uploadConversationAttachment(
        tenantID,
        conversationID,
        {
          clientAttachmentID,
          file,
          fileName: "bai-tap.png",
          heightPx: 480.4,
          widthPx: 639.6,
        },
        "upload-csrf",
        { baseUrl, fetch: fetchMock },
      ),
    ).resolves.toEqual(attachment);
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    const url = new URL(request.url);
    expect(request.method).toBe("POST");
    expect(url.pathname).toBe(
      `/api/v1/conversations/${conversationID}/attachments`,
    );
    expect(url.search).toBe("");
    expect(request.headers.get("Content-Type")).toMatch(
      /^multipart\/form-data; boundary=/,
    );
    expect(request.headers.get("X-CSRF-Token")).toBe("upload-csrf");
    const form = await request.formData();
    expect(form.get("client_attachment_id")).toBe(clientAttachmentID);
    expect(form.get("width_px")).toBe("640");
    expect(form.get("height_px")).toBe("480");
    const uploaded = form.get("file");
    expect(uploaded).toBeInstanceOf(Blob);
    expect((uploaded as File).name).toBe("bai-tap.png");
  });

  it("surfaces typed upload problems", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "conversation_attachment_unsupported",
          status: 415,
          title: "Attachment type not allowed",
        }),
        {
          headers: { "Content-Type": "application/problem+json" },
          status: 415,
        },
      ),
    );
    const failure = uploadConversationAttachment(
      tenantID,
      conversationID,
      {
        clientAttachmentID,
        file: new Blob(["<svg/>"]),
        fileName: "x.svg",
      },
      "upload-csrf",
      { baseUrl, fetch: fetchMock },
    );
    await expect(failure).rejects.toBeInstanceOf(APIRequestError);
    await expect(failure).rejects.toMatchObject({ status: 415 });
  });

  it("downloads attachment bytes as a Blob with credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([37, 80, 68, 70]), {
        headers: { "Content-Type": "application/pdf" },
        status: 200,
      }),
    );
    const blob = await downloadConversationAttachmentBlob(
      tenantID,
      conversationID,
      attachmentID,
      { baseUrl, fetch: fetchMock },
    );
    expect(blob).toBeInstanceOf(Blob);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array([37, 80, 68, 70]),
    );
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.method).toBe("GET");
    expect(request.credentials).toBe("include");
    expect(new URL(request.url).pathname).toBe(
      `/api/v1/conversations/${conversationID}/attachments/${attachmentID}/content`,
    );
    expect(new URL(request.url).search).toBe("");
    expect(request.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(tenantID);

    const missing = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: 404 }), { status: 404 }),
      );
    await expect(
      downloadConversationAttachmentBlob(
        tenantID,
        conversationID,
        attachmentID,
        { baseUrl, fetch: missing },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("sends attachment-only messages with bounded attachment IDs", async () => {
    const sent: ActiveMessage = {
      attachments: [attachment],
      author: {
        display_name: "Minh Anh",
        user_id: "5391c8b2-1224-4105-a44e-452eb69d9884",
      },
      client_message_id: "8e0131b2-9b49-487c-92ca-a240eeef0a66",
      content: "",
      conversation_id: conversationID,
      created_at: "2030-08-03T00:00:00Z",
      id: "b9170d5e-c354-44a8-9241-4571a5e26e57",
      sequence: 4,
      state: "active",
      updated_at: "2030-08-03T00:00:00Z",
      version: 1,
    };
    const input = {
      attachment_ids: [attachmentID],
      client_message_id: sent.client_message_id,
      content: "",
    } satisfies SendMessageRequest;
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sent, 201));
    await expect(
      sendConversationMessage(tenantID, conversationID, input, "send-csrf", {
        baseUrl,
        fetch: fetchMock,
      }),
    ).resolves.toEqual(sent);
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    await expect(request.json()).resolves.toEqual(input);
  });
});
