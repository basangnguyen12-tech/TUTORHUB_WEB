import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Conversation, Message } from "@tutorhub/api-client";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InfiniteData } from "@tanstack/react-query";
import type { MessagePage } from "@tutorhub/api-client";
import {
  conversationQueryKeys,
  useConversations,
  useCreateDirectConversation,
  useDeleteConversationMessage,
  useEnsureClassConversation,
  useEnsureMediaSpaceConversation,
  useSendConversationMessage,
  useUpdateRoomConversationSettings,
  useUploadConversationAttachment,
} from "./conversations";

const tenantID = "4b18543a-74de-419f-9fe8-d0c3dfc991eb";
const conversationID = "c82ef7ee-0a1b-4e99-b9d5-3ae20858a82e";
const classID = "a912f628-f3d2-4c18-84c6-42a9e858dc8d";
const mediaSpaceID = "3b96de90-4d8b-460f-aafd-a1e814b0a6bf";

const conversation: Conversation = {
  id: conversationID,
  kind: "direct",
  title: "TutorHub Student",
  participants: [
    {
      user_id: "be85eb92-0f18-4163-85ba-50e4d343d632",
      display_name: "TutorHub Teacher",
    },
    {
      user_id: "53f0dac5-6c10-46ff-bcb8-da03d07bc142",
      display_name: "TutorHub Student",
    },
  ],
  viewer_access: { can_post_messages: true },
  unread_count: 0,
  unread_count_capped: false,
  created_at: "2026-08-03T09:00:00Z",
  updated_at: "2026-08-03T09:00:00Z",
};

const sentMessage = {
  id: "bd7375d9-0588-4b14-9567-06b230974975",
  conversation_id: conversationID,
  client_message_id: "78c0f30f-c4f8-4b66-bac3-e31db5062fb8",
  sequence: 1,
  author: conversation.participants[0]!,
  state: "active",
  content: "Retry safely",
  version: 1,
  created_at: "2026-08-08T12:00:00Z",
  updated_at: "2026-08-08T12:00:00Z",
} satisfies Message;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function ListProbe() {
  const query = useConversations(tenantID);
  if (!query.data) {
    return <span>loading</span>;
  }
  return (
    <>
      <span>{query.data.pages.flatMap((page) => page.items).length}</span>
      {query.hasNextPage && (
        <button onClick={() => void query.fetchNextPage()} type="button">
          next
        </button>
      )}
    </>
  );
}

function MutationProbe() {
  const direct = useCreateDirectConversation(tenantID);
  const classConversation = useEnsureClassConversation(tenantID);
  const roomConversation = useEnsureMediaSpaceConversation(tenantID);
  return (
    <>
      <button
        onClick={() =>
          direct.mutate({ target_member_email: "student@example.com" })
        }
        type="button"
      >
        direct
      </button>
      <button onClick={() => classConversation.mutate(classID)} type="button">
        class
      </button>
      <button
        onClick={() => roomConversation.mutate(mediaSpaceID)}
        type="button"
      >
        room
      </button>
      <output>
        {direct.data?.id ??
          classConversation.data?.id ??
          roomConversation.data?.id ??
          "none"}
      </output>
    </>
  );
}

function MessageMutationProbe() {
  const send = useSendConversationMessage(tenantID, conversationID);
  return (
    <>
      <button
        onClick={() =>
          send.mutate({
            client_message_id: sentMessage.client_message_id,
            content: sentMessage.content ?? "",
          })
        }
        type="button"
      >
        send
      </button>
      <output>{send.data?.id ?? "none"}</output>
    </>
  );
}

function renderProbe(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  return queryClient;
}

describe("conversation queries", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("uses tenant-scoped keyset pagination without losing the first page", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((request: Request) => {
        requests.push(request);
        const cursor = new URL(request.url).searchParams.get("cursor");
        return Promise.resolve(
          jsonResponse({
            items: cursor
              ? [{ ...conversation, id: crypto.randomUUID() }]
              : [conversation],
            next_cursor: cursor ? null : "next+/cursor",
          }),
        );
      }),
    );

    renderProbe(<ListProbe />);

    expect(await screen.findByText("1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "next" }));
    expect(await screen.findByText("2")).toBeInTheDocument();

    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(
      tenantID,
    );
    expect(
      new URL(requests[0]?.url ?? "http://localhost").searchParams.get("limit"),
    ).toBe("25");
    expect(
      new URL(requests[1]?.url ?? "http://localhost").searchParams.get(
        "cursor",
      ),
    ).toBe("next+/cursor");
  });

  it("rotates CSRF, sends only the direct target email, and seeds detail cache", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((request: Request) => {
        requests.push(request);
        if (new URL(request.url).pathname.endsWith("/api/v1/auth/csrf")) {
          return Promise.resolve(
            jsonResponse({ csrf_token: "conversation-csrf" }),
          );
        }
        return Promise.resolve(jsonResponse(conversation, 201));
      }),
    );
    const queryClient = renderProbe(<MutationProbe />);

    fireEvent.click(screen.getByRole("button", { name: "direct" }));
    expect(await screen.findByText(conversationID)).toBeInTheDocument();

    const createRequest = requests[1];
    expect(createRequest?.headers.get("X-CSRF-Token")).toBe(
      "conversation-csrf",
    );
    expect(createRequest?.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(
      tenantID,
    );
    await expect(createRequest?.clone().json()).resolves.toEqual({
      target_member_email: "student@example.com",
    });
    expect(
      queryClient.getQueryData(
        conversationQueryKeys.detail(tenantID, conversationID),
      ),
    ).toEqual(conversation);
  });

  it("ensures a class conversation with class scope and no participant body", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((request: Request) => {
        requests.push(request);
        if (new URL(request.url).pathname.endsWith("/api/v1/auth/csrf")) {
          return Promise.resolve(jsonResponse({ csrf_token: "class-csrf" }));
        }
        return Promise.resolve(
          jsonResponse({
            ...conversation,
            kind: "class",
            class_id: classID,
            class_status: "active",
            title: "Cơ sở An toàn thông tin",
          }),
        );
      }),
    );
    renderProbe(<MutationProbe />);

    fireEvent.click(screen.getByRole("button", { name: "class" }));
    await waitFor(() => expect(requests).toHaveLength(2));

    const ensureRequest = requests[1];
    expect(new URL(ensureRequest?.url ?? "http://localhost").pathname).toBe(
      `/api/v1/classes/${classID}/conversation`,
    );
    expect(ensureRequest?.headers.get("X-CSRF-Token")).toBe("class-csrf");
    expect(await ensureRequest?.clone().text()).toBe("");
  });

  it("ensures the canonical room conversation with media-space scope and no message payload", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((request: Request) => {
        requests.push(request);
        if (new URL(request.url).pathname.endsWith("/api/v1/auth/csrf")) {
          return Promise.resolve(jsonResponse({ csrf_token: "room-csrf" }));
        }
        return Promise.resolve(
          jsonResponse({
            ...conversation,
            kind: "room",
            media_space_id: mediaSpaceID,
            media_space_status: "open",
            title: "Weekly tutoring room",
          }),
        );
      }),
    );
    renderProbe(<MutationProbe />);

    fireEvent.click(screen.getByRole("button", { name: "room" }));
    await waitFor(() => expect(requests).toHaveLength(2));

    const ensureRequest = requests[1];
    expect(new URL(ensureRequest?.url ?? "http://localhost").pathname).toBe(
      `/api/v1/media/spaces/${mediaSpaceID}/conversation`,
    );
    expect(ensureRequest?.headers.get("X-CSRF-Token")).toBe("room-csrf");
    expect(ensureRequest?.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(
      tenantID,
    );
    expect(await ensureRequest?.clone().text()).toBe("");
  });

  it("retries one transient message failure with the same idempotency key", async () => {
    const requests: Request[] = [];
    let messageAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((request: Request) => {
        requests.push(request);
        const path = new URL(request.url).pathname;
        if (path.endsWith("/api/v1/auth/csrf")) {
          return Promise.resolve(
            jsonResponse({ csrf_token: `message-csrf-${requests.length}` }),
          );
        }
        messageAttempts += 1;
        return Promise.resolve(
          messageAttempts === 1
            ? jsonResponse(
                {
                  type: "urn:tutorhub:problem:http-503",
                  title: "Temporarily unavailable",
                  status: 503,
                },
                503,
              )
            : jsonResponse(sentMessage, 201),
        );
      }),
    );
    renderProbe(<MessageMutationProbe />);

    fireEvent.click(screen.getByRole("button", { name: "send" }));
    expect(await screen.findByText(sentMessage.id)).toBeInTheDocument();

    const messageRequests = requests.filter((request) =>
      new URL(request.url).pathname.endsWith(
        `/api/v1/conversations/${conversationID}/messages`,
      ),
    );
    expect(messageRequests).toHaveLength(2);
    await expect(messageRequests[0]?.clone().json()).resolves.toEqual({
      client_message_id: sentMessage.client_message_id,
      content: sentMessage.content,
    });
    await expect(messageRequests[1]?.clone().json()).resolves.toEqual({
      client_message_id: sentMessage.client_message_id,
      content: sentMessage.content,
    });
    expect(
      requests.filter((request) =>
        new URL(request.url).pathname.endsWith("/api/v1/auth/csrf"),
      ),
    ).toHaveLength(2);
  });

  it("ROOM-CHAT-01 seeds the sent message into the newest cached page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((request: Request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/api/v1/auth/csrf")) {
          return Promise.resolve(jsonResponse({ csrf_token: "send-csrf" }));
        }
        if (request.method === "GET") {
          return new Promise<Response>(() => undefined);
        }
        return Promise.resolve(jsonResponse(sentMessage, 201));
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    queryClient.setQueryData<InfiniteData<MessagePage>>(
      conversationQueryKeys.messages(tenantID, conversationID),
      {
        pageParams: [undefined],
        pages: [
          {
            items: [],
            read_state: null,
            unread_count: 0,
            unread_count_capped: false,
          },
        ],
      },
    );
    render(
      <QueryClientProvider client={queryClient}>
        <MessageMutationProbe />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "send" }));
    expect(await screen.findByText(sentMessage.id)).toBeInTheDocument();
    const cached = queryClient.getQueryData<InfiniteData<MessagePage>>(
      conversationQueryKeys.messages(tenantID, conversationID),
    );
    expect(cached?.pages[0]?.items.map((item) => item.id)).toEqual([
      sentMessage.id,
    ]);
  });

  it("ROOM-CHAT-01 updates the room posting switch, uploads with CSRF and tombstones messages", async () => {
    const requests: Request[] = [];
    const paused = {
      ...conversation,
      kind: "room" as const,
      participant_chat_enabled: false,
      participants: [],
      viewer_access: {
        can_moderate_chat: true,
        can_post_messages: true,
        can_upload_attachments: true,
      },
    };
    const tombstone = {
      ...sentMessage,
      content: undefined,
      deleted_at: "2026-08-08T12:05:00Z",
      state: "deleted" as const,
      version: 2,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((request: Request) => {
        requests.push(request);
        const path = new URL(request.url).pathname;
        if (path.endsWith("/api/v1/auth/csrf")) {
          return Promise.resolve(
            jsonResponse({ csrf_token: `csrf-${requests.length}` }),
          );
        }
        if (path.endsWith("/room-settings")) {
          return Promise.resolve(jsonResponse(paused));
        }
        if (path.endsWith("/attachments")) {
          return Promise.resolve(
            jsonResponse(
              {
                conversation_id: conversationID,
                created_at: "2026-08-08T12:00:00Z",
                display_name: "de.pdf",
                id: "0c7f6a4e-7f0e-4a3e-9c55-0b5b1c7d0a11",
                kind: "file",
                media_type: "application/pdf",
                size_bytes: 4,
              },
              201,
            ),
          );
        }
        return Promise.resolve(jsonResponse(tombstone));
      }),
    );
    function RoomChatProbe() {
      const settings = useUpdateRoomConversationSettings(
        tenantID,
        conversationID,
      );
      const upload = useUploadConversationAttachment(tenantID, conversationID);
      const remove = useDeleteConversationMessage(tenantID, conversationID);
      return (
        <>
          <button onClick={() => settings.mutate(false)} type="button">
            pause
          </button>
          <button
            onClick={() =>
              upload.mutate({
                clientAttachmentID: "d4c2b0a1-1e2f-4a5b-8c9d-0e1f2a3b4c5d",
                file: new Blob(["%PDF"], { type: "application/pdf" }),
                fileName: "de.pdf",
              })
            }
            type="button"
          >
            upload
          </button>
          <button
            onClick={() =>
              remove.mutate({ expectedVersion: 1, messageID: sentMessage.id })
            }
            type="button"
          >
            delete
          </button>
          <output>
            {[
              settings.data?.participant_chat_enabled === false ? "paused" : "",
              upload.data?.display_name ?? "",
              remove.data?.state ?? "",
            ].join("|")}
          </output>
        </>
      );
    }
    const queryClient = renderProbe(<RoomChatProbe />);
    fireEvent.click(screen.getByRole("button", { name: "pause" }));
    expect(await screen.findByText("paused||")).toBeInTheDocument();
    expect(
      queryClient.getQueryData<Conversation>(
        conversationQueryKeys.detail(tenantID, conversationID),
      )?.participant_chat_enabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "upload" }));
    expect(await screen.findByText("paused|de.pdf|")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "delete" }));
    expect(
      await screen.findByText("paused|de.pdf|deleted"),
    ).toBeInTheDocument();

    const settingsRequest = requests.find((request) =>
      new URL(request.url).pathname.endsWith("/room-settings"),
    );
    expect(settingsRequest?.method).toBe("PATCH");
    expect(settingsRequest?.headers.get("X-CSRF-Token")).toMatch(/^csrf-/u);
    await expect(settingsRequest?.clone().json()).resolves.toEqual({
      participant_chat_enabled: false,
    });
    const uploadRequest = requests.find((request) =>
      new URL(request.url).pathname.endsWith("/attachments"),
    );
    expect(uploadRequest?.headers.get("Content-Type")).toMatch(
      /^multipart\/form-data/u,
    );
    expect(uploadRequest?.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(
      tenantID,
    );
    const deleteRequest = requests.find(
      (request) => request.method === "DELETE",
    );
    await expect(deleteRequest?.clone().json()).resolves.toEqual({
      expected_version: 1,
    });
  });
});
