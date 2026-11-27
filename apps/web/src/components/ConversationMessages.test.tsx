import {
  QueryClient,
  QueryClientProvider,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  Conversation,
  ConversationPage,
  Message,
  MessagePage,
} from "@tutorhub/api-client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationQueryKeys } from "../app/conversations";
import { I18nProvider } from "../app/i18n";
import { ConversationMessages } from "./ConversationMessages";

const tenantID = "4b18543a-74de-419f-9fe8-d0c3dfc991eb";
const conversationID = "c82ef7ee-0a1b-4e99-b9d5-3ae20858a82e";
const teacherID = "be85eb92-0f18-4163-85ba-50e4d343d632";
const studentID = "53f0dac5-6c10-46ff-bcb8-da03d07bc142";

const conversation: Conversation = {
  id: conversationID,
  kind: "direct",
  title: "TutorHub Student",
  participants: [
    { user_id: teacherID, display_name: "TutorHub Teacher" },
    { user_id: studentID, display_name: "TutorHub Student" },
  ],
  viewer_access: { can_post_messages: true },
  unread_count: 2,
  unread_count_capped: false,
  created_at: "2026-08-03T09:00:00Z",
  updated_at: "2026-08-03T09:03:00Z",
};

function message(
  sequence: number,
  content: string | null,
  options: { deleted?: boolean; edited?: boolean; own?: boolean } = {},
): Message {
  const timestamp = `2026-08-03T09:0${sequence}:00Z`;
  const common = {
    id: `10000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    conversation_id: conversationID,
    client_message_id: `20000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sequence,
    author: {
      user_id: options.own ? teacherID : studentID,
      display_name: options.own ? "TutorHub Teacher" : "TutorHub Student",
    },
    version: options.edited || options.deleted ? 2 : 1,
    created_at: timestamp,
    updated_at: timestamp,
    ...(options.edited ? { edited_at: timestamp } : {}),
  };
  if (options.deleted) {
    return { ...common, state: "deleted", deleted_at: timestamp };
  }
  if (content === null) {
    throw new Error("active message fixtures require content");
  }
  return { ...common, state: "active", content };
}

function page(
  items: readonly Message[],
  options: {
    nextCursor?: string;
    unreadCount?: number;
    unreadCountCapped?: boolean;
  } = {},
): MessagePage {
  return {
    items,
    next_cursor: options.nextCursor,
    read_state: null,
    unread_count: options.unreadCount ?? 0,
    unread_count_capped: options.unreadCountCapped ?? false,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type":
        status >= 400 ? "application/problem+json" : "application/json",
    },
  });
}

function renderMessages(
  fetchMock: ReturnType<typeof vi.fn>,
  options: { conversation?: Conversation } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLanguage="en">
        <MemoryRouter>
          <ConversationMessages
            actorID={teacherID}
            canPostMessages
            conversation={options.conversation}
            conversationID={conversationID}
            formatter={
              new Intl.DateTimeFormat("en-US", {
                timeZone: "UTC",
                dateStyle: "medium",
                timeStyle: "short",
              })
            }
            tenantID={tenantID}
          />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("ConversationMessages", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("orders newest-first pages chronologically, loads older history, and marks the visible newest message read", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    const newest = message(3, "Newest edited message", {
      edited: true,
      own: true,
    });
    const deleted = message(2, null, { deleted: true });
    const oldest = message(1, "Oldest message");
    const requests: Request[] = [];
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/api/v1/auth/csrf")) {
        return Promise.resolve(jsonResponse({ csrf_token: "read-csrf" }));
      }
      if (
        url.pathname.endsWith(`/api/v1/conversations/${conversationID}/read`)
      ) {
        return Promise.resolve(
          jsonResponse({
            last_read_message_id: newest.id,
            last_read_sequence: newest.sequence,
            updated_at: "2026-08-03T09:04:00Z",
          }),
        );
      }
      if (
        request.method === "GET" &&
        url.pathname.endsWith(
          `/api/v1/conversations/${conversationID}/messages`,
        )
      ) {
        return Promise.resolve(
          jsonResponse(
            url.searchParams.get("cursor")
              ? page([oldest])
              : page([newest, deleted], {
                  nextCursor: "older+/cursor",
                  unreadCount: 2,
                }),
          ),
        );
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });

    const queryClient = renderMessages(fetchMock);
    queryClient.setQueryData(
      conversationQueryKeys.detail(tenantID, conversationID),
      conversation,
    );
    queryClient.setQueryData<InfiniteData<ConversationPage>>(
      conversationQueryKeys.list(tenantID),
      {
        pages: [{ items: [conversation], next_cursor: undefined }],
        pageParams: [undefined],
      },
    );

    expect(
      await screen.findByText("Newest edited message"),
    ).toBeInTheDocument();
    expect(screen.getByText("This message was deleted.")).toBeInTheDocument();
    expect(screen.getByText("Edited")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        requests.some((request) =>
          request.url.endsWith(`/api/v1/conversations/${conversationID}/read`),
        ),
      ).toBe(true),
    );

    const loadOlderButton = screen.getByRole("button", {
      name: "Load older messages",
    });
    loadOlderButton.focus();
    fireEvent.click(loadOlderButton);
    expect(await screen.findByText("Oldest message")).toBeInTheDocument();

    const history = screen.getByRole("list", {
      name: "Persistent message history",
    });
    expect(
      within(history)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining("Oldest message"),
      expect.stringContaining("This message was deleted."),
      expect.stringContaining("Newest edited message"),
    ]);
    await waitFor(() =>
      expect(within(history).getAllByRole("listitem")[0]).toHaveFocus(),
    );

    const messageRequests = requests.filter((request) =>
      request.url.includes(`/api/v1/conversations/${conversationID}/messages`),
    );
    expect(
      new URL(messageRequests[0]?.url ?? "http://localhost").searchParams.get(
        "limit",
      ),
    ).toBe("50");
    const olderRequest = messageRequests.find(
      (request) =>
        new URL(request.url).searchParams.get("cursor") === "older+/cursor",
    );
    expect(olderRequest).toBeDefined();
    expect(
      messageRequests.filter(
        (request) => !new URL(request.url).searchParams.has("cursor"),
      ).length,
    ).toBeGreaterThanOrEqual(2);
    const readRequest = requests.find((request) =>
      request.url.endsWith(`/api/v1/conversations/${conversationID}/read`),
    );
    expect(readRequest?.headers.get("X-CSRF-Token")).toBe("read-csrf");
    expect(readRequest?.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(
      tenantID,
    );
    await expect(readRequest?.clone().json()).resolves.toEqual({
      message_id: newest.id,
    });
    expect(
      queryClient.getQueryData<Conversation>(
        conversationQueryKeys.detail(tenantID, conversationID),
      )?.unread_count,
    ).toBe(0);
    expect(
      queryClient.getQueryData<InfiniteData<ConversationPage>>(
        conversationQueryKeys.list(tenantID),
      )?.pages[0]?.items[0]?.unread_count,
    ).toBe(0);
  });

  it("automatically retries Ctrl+Enter delivery with the same memory-only client message id", async () => {
    const sendRequests: Request[] = [];
    let sendAttempts = 0;
    let sent = false;
    let refreshAfterSendStarted = false;
    const sentMessage = message(1, "Retry me", { own: true });
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/api/v1/auth/csrf")) {
        return Promise.resolve(jsonResponse({ csrf_token: "message-csrf" }));
      }
      if (
        url.pathname.endsWith(
          `/api/v1/conversations/${conversationID}/messages`,
        )
      ) {
        if (request.method === "GET") {
          if (sent) {
            refreshAfterSendStarted = true;
            return new Promise<Response>(() => undefined);
          }
          return Promise.resolve(jsonResponse(page(sent ? [sentMessage] : [])));
        }
        sendRequests.push(request);
        sendAttempts += 1;
        if (sendAttempts === 1) {
          return Promise.resolve(
            jsonResponse(
              {
                type: "urn:tutorhub:problem:http-503",
                title: "Temporarily unavailable",
                status: 503,
              },
              503,
            ),
          );
        }
        sent = true;
        return Promise.resolve(jsonResponse(sentMessage, 201));
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });

    renderMessages(fetchMock);

    const composer = await screen.findByRole("textbox", {
      name: "New message",
    });
    fireEvent.change(composer, { target: { value: "  Retry me\r\n" } });
    fireEvent.keyDown(composer, { ctrlKey: true, key: "Enter" });

    expect(await screen.findByText("Message saved.")).toBeInTheDocument();
    await waitFor(() => expect(refreshAfterSendStarted).toBe(true));
    await waitFor(() => expect(composer).toHaveFocus());
    expect(sendRequests).toHaveLength(2);
    const firstBody = await sendRequests[0]?.clone().json();
    const secondBody = await sendRequests[1]?.clone().json();
    expect(firstBody).toEqual({
      client_message_id: expect.any(String),
      content: "Retry me",
    });
    expect(secondBody).toEqual(firstBody);
    expect(composer).toHaveValue("");
  });

  it("reconciles queries when the read marker trails the loaded newest message", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    const newest = message(2, "A newer message committed");
    const older = message(1, "Read marker target");
    let messageReads = 0;
    let readRequests = 0;
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/api/v1/auth/csrf")) {
        return Promise.resolve(jsonResponse({ csrf_token: "read-csrf" }));
      }
      if (
        url.pathname.endsWith(`/api/v1/conversations/${conversationID}/read`)
      ) {
        readRequests += 1;
        return Promise.resolve(
          jsonResponse({
            last_read_message_id: older.id,
            last_read_sequence: older.sequence,
            updated_at: "2026-08-03T09:04:00Z",
          }),
        );
      }
      if (
        request.method === "GET" &&
        url.pathname.endsWith(
          `/api/v1/conversations/${conversationID}/messages`,
        )
      ) {
        messageReads += 1;
        return Promise.resolve(
          jsonResponse(page([newest], { unreadCount: 1 })),
        );
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });

    const queryClient = renderMessages(fetchMock);
    queryClient.setQueryData(
      conversationQueryKeys.detail(tenantID, conversationID),
      conversation,
    );
    queryClient.setQueryData<InfiniteData<ConversationPage>>(
      conversationQueryKeys.list(tenantID),
      {
        pages: [{ items: [conversation], next_cursor: undefined }],
        pageParams: [undefined],
      },
    );

    expect(
      await screen.findByText("A newer message committed"),
    ).toBeInTheDocument();
    await waitFor(() => expect(readRequests).toBe(1));
    await waitFor(() => expect(messageReads).toBeGreaterThanOrEqual(2));
    await waitFor(() =>
      expect(
        queryClient.getQueryState(
          conversationQueryKeys.detail(tenantID, conversationID),
        )?.isInvalidated,
      ).toBe(true),
    );
    expect(
      queryClient.getQueryState(conversationQueryKeys.list(tenantID))
        ?.isInvalidated,
    ).toBe(true);
  });

  it("accepts 4,000 Unicode code points within the 16 KiB UTF-8 limit", async () => {
    const content = "🙂".repeat(4000);
    let sent = false;
    const sentMessage = message(1, content, { own: true });
    const sendRequests: Request[] = [];
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/api/v1/auth/csrf")) {
        return Promise.resolve(jsonResponse({ csrf_token: "message-csrf" }));
      }
      if (
        url.pathname.endsWith(
          `/api/v1/conversations/${conversationID}/messages`,
        )
      ) {
        if (request.method === "GET") {
          return Promise.resolve(jsonResponse(page(sent ? [sentMessage] : [])));
        }
        sendRequests.push(request);
        sent = true;
        return Promise.resolve(jsonResponse(sentMessage, 201));
      }
      return Promise.reject(new Error(`Unexpected request: ${request.url}`));
    });

    renderMessages(fetchMock);

    const composer = await screen.findByRole("textbox", {
      name: "New message",
    });
    expect(composer).not.toHaveAttribute("maxlength");
    fireEvent.change(composer, { target: { value: content } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("Message saved.")).toBeInTheDocument();
    const body = await sendRequests[0]?.clone().json();
    expect([...body.content]).toHaveLength(4000);
    expect(new TextEncoder().encode(body.content)).toHaveLength(16000);
  });

  it("waits for an explicit retry after a read-marker failure", async () => {
    const newest = message(1, "Unread message");
    let readAttempts = 0;
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/api/v1/auth/csrf")) {
        return Promise.resolve(jsonResponse({ csrf_token: "read-csrf" }));
      }
      if (
        url.pathname.endsWith(`/api/v1/conversations/${conversationID}/read`)
      ) {
        readAttempts += 1;
        return Promise.resolve(
          jsonResponse(
            {
              type: "urn:tutorhub:problem:http-503",
              title: "Temporarily unavailable",
              status: 503,
            },
            503,
          ),
        );
      }
      return Promise.resolve(jsonResponse(page([newest], { unreadCount: 1 })));
    });

    renderMessages(fetchMock);

    expect(
      await screen.findByText(/read marker could not be updated/i),
    ).toBeInTheDocument();
    expect(readAttempts).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(readAttempts).toBe(2));
  });

  it("serializes automatic read and send CSRF mutation chains", async () => {
    const incoming = message(1, "Unread before reply");
    const sent = message(2, "Queued reply", { own: true });
    let csrfRequests = 0;
    let readRequests = 0;
    let sendRequests = 0;
    let resolveRead: ((response: Response) => void) | undefined;
    const pendingRead = new Promise<Response>((resolve) => {
      resolveRead = resolve;
    });
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/api/v1/auth/csrf")) {
        csrfRequests += 1;
        return Promise.resolve(
          jsonResponse({ csrf_token: `conversation-csrf-${csrfRequests}` }),
        );
      }
      if (
        url.pathname.endsWith(`/api/v1/conversations/${conversationID}/read`)
      ) {
        readRequests += 1;
        return pendingRead;
      }
      if (
        request.method === "POST" &&
        url.pathname.endsWith(
          `/api/v1/conversations/${conversationID}/messages`,
        )
      ) {
        sendRequests += 1;
        return Promise.resolve(jsonResponse(sent, 201));
      }
      return Promise.resolve(
        jsonResponse(page([incoming], { unreadCount: 1 })),
      );
    });

    renderMessages(fetchMock);

    expect(await screen.findByText("Unread before reply")).toBeInTheDocument();
    await waitFor(() => expect(readRequests).toBe(1));
    fireEvent.change(screen.getByRole("textbox", { name: "New message" }), {
      target: { value: "Queued reply" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByRole("button", { name: "Sending..." });
    expect(csrfRequests).toBe(1);
    expect(sendRequests).toBe(0);

    act(() => {
      resolveRead?.(
        jsonResponse({
          last_read_message_id: incoming.id,
          last_read_sequence: incoming.sequence,
          updated_at: "2026-08-03T09:05:00Z",
        }),
      );
    });

    await waitFor(() => expect(csrfRequests).toBe(2));
    await waitFor(() => expect(sendRequests).toBe(1));
    expect(await screen.findByText("Message saved.")).toBeInTheDocument();
  });

  it("shows one stable retry control when loading older history fails", async () => {
    const newest = message(2, "Newest page");
    const oldest = message(1, "Recovered older page");
    let olderAttempts = 0;
    const fetchMock = vi.fn().mockImplementation((request: Request) => {
      const url = new URL(request.url);
      if (url.searchParams.has("cursor")) {
        olderAttempts += 1;
        if (olderAttempts <= 2) {
          return Promise.resolve(
            jsonResponse(
              {
                type: "urn:tutorhub:problem:http-503",
                title: "Temporarily unavailable",
                status: 503,
              },
              503,
            ),
          );
        }
        return Promise.resolve(jsonResponse(page([oldest])));
      }
      return Promise.resolve(
        jsonResponse(page([newest], { nextCursor: "older-cursor" })),
      );
    });

    renderMessages(fetchMock);

    expect(await screen.findByText("Newest page")).toBeInTheDocument();
    const loadOlderButton = screen.getByRole("button", {
      name: "Load older messages",
    });
    loadOlderButton.focus();
    fireEvent.click(loadOlderButton);

    expect(
      await screen.findByText(
        "Older history could not be loaded. Try again.",
        undefined,
        { timeout: 3_000 },
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Messages could not be refreshed. Loaded history is still available.",
      ),
    ).not.toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Try again" });
    expect(retry).toHaveFocus();
    expect(screen.getAllByRole("alert")).toHaveLength(1);

    fireEvent.click(retry);
    expect(await screen.findByText("Recovered older page")).toBeInTheDocument();
  });

  it("shows a forbidden state and can retry into an empty history", async () => {
    let attempts = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.resolve(
          jsonResponse(
            {
              type: "urn:tutorhub:problem:http-403",
              title: "Forbidden",
              status: 403,
            },
            403,
          ),
        );
      }
      return Promise.resolve(jsonResponse(page([])));
    });

    renderMessages(fetchMock);

    expect(
      await screen.findByText("This session can no longer read this history."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No messages yet")).toBeInTheDocument();
  });

  it("hides cached private history and the composer after access is revoked", async () => {
    const privateMessage = message(1, "Private cached message");
    let attempts = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.resolve(jsonResponse(page([privateMessage])));
      }
      return Promise.resolve(
        jsonResponse(
          {
            type: "urn:tutorhub:problem:http-403",
            title: "Forbidden",
            status: 403,
          },
          403,
        ),
      );
    });

    renderMessages(fetchMock);

    expect(
      await screen.findByText("Private cached message"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "New message" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh messages" }));

    expect(
      await screen.findByText("This session can no longer read this history."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Private cached message"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "New message" }),
    ).not.toBeInTheDocument();
  });

  it("groups consecutive messages by author and keeps one list item per message", async () => {
    const first = message(1, "First line");
    const second = message(2, "Second line");
    const reply = message(3, "Teacher reply", { own: true });
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse(page([reply, second, first]))),
      );

    renderMessages(fetchMock);

    const history = await screen.findByRole("list", {
      name: "Persistent message history",
    });
    const items = within(history).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(history.querySelectorAll(".conversation-day-divider")).toHaveLength(
      1,
    );
    expect(items[0]?.querySelector(".conversation-day-divider")).not.toBeNull();
    expect(items[0]).toHaveClass("conversation-message--continued");
    expect(items[1]).toHaveClass("conversation-message--grouped");
    expect(items[2]).toHaveClass("conversation-message--own");
    expect(items[2]).not.toHaveClass("conversation-message--grouped");
    // The grouped item still names its author for assistive technology.
    expect(
      within(items[1] as HTMLElement).getByText("TutorHub Student"),
    ).toBeInTheDocument();
    expect(screen.getByText("Second line", { exact: true })).toHaveClass(
      "conversation-message__content",
    );
  });

  it("sends a quoted reply and renders the quote block above the body", async () => {
    const question = message(1, "Original question about vectors");
    let current: Message[] = [question];
    const sendRequests: Request[] = [];
    const fetchMock = vi.fn().mockImplementation(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/api/v1/auth/csrf")) {
        return jsonResponse({ csrf_token: "reply-csrf" });
      }
      if (request.method === "POST") {
        sendRequests.push(request);
        const body = (await request.clone().json()) as { content: string };
        const sent = message(2, body.content, { own: true });
        current = [question, sent];
        return jsonResponse(sent, 201);
      }
      return jsonResponse(page([...current].reverse()));
    });

    renderMessages(fetchMock);

    const original = await screen.findByText("Original question about vectors");
    const item = original.closest("li") as HTMLElement;
    fireEvent.click(within(item).getByRole("button", { name: "Reply" }));
    expect(
      screen.getByText("Replying to TutorHub Student"),
    ).toBeInTheDocument();
    const composer = screen.getByRole("textbox", { name: "New message" });
    await waitFor(() => expect(composer).toHaveFocus());
    fireEvent.change(composer, { target: { value: "Use the dot product" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("Message saved.")).toBeInTheDocument();
    await expect(sendRequests[0]?.clone().json()).resolves.toEqual({
      client_message_id: expect.any(String),
      content:
        "> TutorHub Student: Original question about vectors\n\nUse the dot product",
    });
    expect(
      await screen.findByText("Use the dot product", { exact: true }),
    ).toHaveClass("conversation-message__content");
    const quote = document.querySelector(".conversation-message__quote");
    expect(quote).toHaveTextContent("TutorHub Student");
    expect(quote).toHaveTextContent("Original question about vectors");
    expect(
      screen.queryByText("Replying to TutorHub Student"),
    ).not.toBeInTheDocument();
  });

  it("edits an own message with PATCH and unsends it with DELETE", async () => {
    const original = message(1, "Draft answer", { own: true });
    let current: Message = original;
    const requests: Request[] = [];
    const fetchMock = vi.fn().mockImplementation(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/api/v1/auth/csrf")) {
        return jsonResponse({ csrf_token: "edit-csrf" });
      }
      if (url.pathname.endsWith(`/messages/${original.id}`)) {
        requests.push(request);
        if (request.method === "PATCH") {
          const body = (await request.clone().json()) as { content: string };
          current = {
            id: original.id,
            conversation_id: original.conversation_id,
            client_message_id: original.client_message_id,
            sequence: original.sequence,
            author: original.author,
            created_at: original.created_at,
            state: "active",
            content: body.content,
            edited_at: "2026-08-03T09:05:00Z",
            updated_at: "2026-08-03T09:05:00Z",
            version: 2,
          };
        } else {
          current = {
            id: original.id,
            conversation_id: original.conversation_id,
            client_message_id: original.client_message_id,
            sequence: original.sequence,
            author: original.author,
            created_at: original.created_at,
            updated_at: "2026-08-03T09:06:00Z",
            deleted_at: "2026-08-03T09:06:00Z",
            state: "deleted",
            version: 3,
          };
        }
        return jsonResponse(current);
      }
      return jsonResponse(page([current]));
    });

    renderMessages(fetchMock);

    const draft = await screen.findByText("Draft answer");
    fireEvent.click(
      within(draft.closest("li") as HTMLElement).getByRole("button", {
        name: "Edit",
      }),
    );
    const editor = await screen.findByRole("textbox", { name: "Edit message" });
    expect(editor).toHaveValue("Draft answer");
    await waitFor(() => expect(editor).toHaveFocus());
    fireEvent.change(editor, { target: { value: "Final answer" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // React mirrors a controlled textarea's value into its text, so match the
    // saved message paragraph rather than the closing editor.
    expect(
      await screen.findByText("Final answer", { exact: true, selector: "p" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Edit message" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Edited")).toBeInTheDocument();
    const patch = requests.find((request) => request.method === "PATCH");
    expect(patch?.headers.get("X-CSRF-Token")).toBe("edit-csrf");
    await expect(patch?.clone().json()).resolves.toEqual({
      content: "Final answer",
      expected_version: 1,
    });

    const updated = screen
      .getByText("Final answer", { selector: "p" })
      .closest("li") as HTMLElement;
    fireEvent.click(within(updated).getByRole("button", { name: "Unsend" }));
    const confirm = screen.getByRole("group", {
      name: "Unsend this message for everyone?",
    });
    fireEvent.click(within(confirm).getByRole("button", { name: "Unsend" }));

    expect(
      await screen.findByText("This message was deleted."),
    ).toBeInTheDocument();
    const removal = requests.find((request) => request.method === "DELETE");
    await expect(removal?.clone().json()).resolves.toEqual({
      expected_version: 2,
    });
  });

  it("never offers Edit on others' messages and Unsend only to moderators", async () => {
    const incoming = message(1, "Student note");
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse(page([incoming]))),
      );

    renderMessages(fetchMock);
    let item = (await screen.findByText("Student note")).closest(
      "li",
    ) as HTMLElement;
    expect(within(item).getByRole("button", { name: "Reply" })).toBeVisible();
    expect(within(item).getByRole("button", { name: "Copy" })).toBeVisible();
    expect(
      within(item).queryByRole("button", { name: "Edit" }),
    ).not.toBeInTheDocument();
    expect(
      within(item).queryByRole("button", { name: "Unsend" }),
    ).not.toBeInTheDocument();
    cleanup();

    renderMessages(fetchMock, {
      conversation: {
        ...conversation,
        viewer_access: { can_post_messages: true, can_moderate_chat: true },
      },
    });
    item = (await screen.findByText("Student note")).closest(
      "li",
    ) as HTMLElement;
    expect(within(item).getByRole("button", { name: "Unsend" })).toBeVisible();
    expect(
      within(item).queryByRole("button", { name: "Edit" }),
    ).not.toBeInTheDocument();
  });

  it("inserts a picked emoji at the composer caret", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse(page([]))));

    renderMessages(fetchMock);

    const composer = (await screen.findByRole("textbox", {
      name: "New message",
    })) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "ab" } });
    composer.setSelectionRange(1, 1);
    fireEvent.select(composer);
    fireEvent.click(screen.getByRole("button", { name: "Emoji" }));
    const picker = screen.getByRole("dialog", { name: "Pick an emoji" });
    fireEvent.click(
      await within(picker).findByRole("button", { name: "grinning face" }),
    );
    expect(composer).toHaveValue("a😀b");
  });

  it("mentions known members by display name only", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse(page([message(1, "Hello teacher")]))),
      );

    renderMessages(fetchMock, { conversation });

    const composer = await screen.findByRole("textbox", {
      name: "New message",
    });
    await screen.findByText("Hello teacher");
    const trigger = screen.getByRole("button", { name: "Mention a member" });
    act(() => trigger.focus());
    fireEvent.keyDown(trigger, { key: "Enter" });
    const options = await screen.findAllByRole("menuitem");
    expect(options.map((option) => option.textContent)).toEqual([
      "TSTutorHub Student",
    ]);
    expect(document.body.textContent).not.toContain("@example.com");
    fireEvent.click(options[0] as HTMLElement);
    await waitFor(() => expect(composer).toHaveValue("@TutorHub Student "));
  });

  it("stages uploads only where the server allows them and sends their ids", async () => {
    const attachment = {
      id: "30000000-0000-4000-8000-000000000001",
      conversation_id: conversationID,
      created_at: "2026-08-03T09:10:00Z",
      display_name: "notes.pdf",
      kind: "file" as const,
      media_type: "application/pdf",
      size_bytes: 8,
    };
    const sendRequests: Request[] = [];
    let uploads = 0;
    const fetchMock = vi.fn().mockImplementation(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/api/v1/auth/csrf")) {
        return jsonResponse({ csrf_token: "upload-csrf" });
      }
      if (url.pathname.endsWith("/attachments")) {
        uploads += 1;
        return jsonResponse(attachment, 201);
      }
      if (request.method === "POST") {
        sendRequests.push(request);
        return jsonResponse(
          {
            ...message(1, "", { own: true }),
            attachments: [attachment],
          },
          201,
        );
      }
      return jsonResponse(page([]));
    });

    renderMessages(fetchMock, {
      conversation: {
        ...conversation,
        kind: "room",
        media_space_id: "dd060149-e85d-43c2-98d0-110f6e3ead29",
        media_space_status: "open",
        participants: [],
        viewer_access: {
          can_post_messages: true,
          can_upload_attachments: true,
        },
      },
    });

    await screen.findByRole("textbox", { name: "New message" });
    expect(
      screen.getByRole("button", { name: "Attach a file or image" }),
    ).toBeInTheDocument();
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [
          new File(["%PDF-1.4"], "notes.pdf", { type: "application/pdf" }),
        ],
      },
    });
    expect(await screen.findByText("8 B")).toBeInTheDocument();
    expect(uploads).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("Message saved.")).toBeInTheDocument();
    await expect(sendRequests[0]?.clone().json()).resolves.toEqual({
      attachment_ids: [attachment.id],
      client_message_id: expect.any(String),
      content: "",
    });
  });
});
