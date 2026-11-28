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
import { defaultCoverTheme } from "../app/classroomPreferences";
import { conversationQueryKeys } from "../app/conversations";
import { I18nProvider } from "../app/i18n";
import {
  ConversationAvatar,
  ConversationMessages,
} from "./ConversationMessages";

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
    // MSG-AVATAR-SEARCH-CLASSIN-01: incoming messages carry the Zalo-style
    // default avatar (no initials), own messages none.
    const incomingAvatar = items[0]?.querySelector(
      ".conversation-message__avatar",
    );
    expect(incomingAvatar).toHaveClass("user-avatar");
    expect(incomingAvatar).toHaveAttribute("aria-hidden", "true");
    expect(incomingAvatar).toHaveAttribute("data-avatar", "default");
    expect(incomingAvatar).toHaveTextContent("");
    expect(items[2]?.querySelector(".conversation-message__avatar")).toBeNull();
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
    // MSG-AVATAR-SEARCH-CLASSIN-01: the avatar is a decorative silhouette,
    // so the item reads as the display name only.
    expect(options.map((option) => option.textContent)).toEqual([
      "TutorHub Student",
    ]);
    expect(
      options[0]?.querySelector(
        '.user-avatar--xs[aria-hidden="true"][data-avatar="default"] svg',
      ),
    ).not.toBeNull();
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
    const fileMenu = screen.getByRole("button", { name: "Send file" });
    act(() => fileMenu.focus());
    fireEvent.keyDown(fileMenu, { key: "Enter" });
    expect(
      await screen.findByRole("menuitem", { name: "Send from this device" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? fileMenu, { key: "Escape" });
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

  describe("MSG-COMPOSER-TOOLS-01 composer tools", () => {
    const roomConversation: Conversation = {
      ...conversation,
      kind: "room",
      media_space_id: "dd060149-e85d-43c2-98d0-110f6e3ead29",
      media_space_status: "open",
      participants: [],
      viewer_access: { can_post_messages: true, can_upload_attachments: true },
    };
    const classConversation: Conversation = {
      ...conversation,
      class_id: "8f6b8a9e-31c7-4b8e-9d6f-0a0e3a1c2b11",
      kind: "class",
      participants: [],
    };

    function uploadingFetch(uploads: string[]) {
      return vi.fn().mockImplementation(async (request: Request) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/api/v1/auth/csrf")) {
          return jsonResponse({ csrf_token: "tools-csrf" });
        }
        if (url.pathname.endsWith("/attachments")) {
          uploads.push(request.method);
          return jsonResponse(
            {
              conversation_id: conversationID,
              created_at: "2026-08-03T09:10:00Z",
              display_name: "notes.txt",
              id: `30000000-0000-4000-8000-00000000000${uploads.length}`,
              kind: "file",
              media_type: "text/plain",
              size_bytes: 5,
            },
            201,
          );
        }
        return jsonResponse(page([]));
      });
    }

    function stubDisplayMedia(getDisplayMedia: () => Promise<MediaStream>) {
      const spy = vi.fn(getDisplayMedia);
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getDisplayMedia: spy },
      });
      return spy;
    }

    afterEach(() => {
      Reflect.deleteProperty(navigator, "mediaDevices");
    });

    it("hides upload tools where the server forbids them but keeps class materials", async () => {
      stubDisplayMedia(() => Promise.reject(new Error("unused")));
      const fetchMock = vi
        .fn()
        .mockImplementation(() => Promise.resolve(jsonResponse(page([]))));

      renderMessages(fetchMock, { conversation: classConversation });
      await screen.findByRole("textbox", { name: "New message" });
      expect(
        screen.queryByRole("button", { name: /^Screenshot/ }),
      ).not.toBeInTheDocument();
      // Without upload access a one-item menu would be a wasted step.
      expect(
        screen.queryByRole("button", { name: "Send file" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: "Open class materials" }),
      ).toHaveAttribute(
        "href",
        `/app/classrooms/${classConversation.class_id}?tab=materials`,
      );
      expect(document.querySelector('input[type="file"]')).toBeNull();
    });

    it("offers no file or screenshot tools in a direct chat without upload access", async () => {
      stubDisplayMedia(() => Promise.reject(new Error("unused")));
      const fetchMock = vi
        .fn()
        .mockImplementation(() => Promise.resolve(jsonResponse(page([]))));

      renderMessages(fetchMock, { conversation });
      await screen.findByRole("textbox", { name: "New message" });
      expect(
        screen.queryByRole("button", { name: "Send file" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /^Screenshot/ }),
      ).not.toBeInTheDocument();
    });

    it("stages pasted and dropped files through the normal upload path", async () => {
      const uploads: string[] = [];
      renderMessages(uploadingFetch(uploads), {
        conversation: roomConversation,
      });
      const composer = await screen.findByRole("textbox", {
        name: "New message",
      });

      fireEvent.paste(composer, {
        clipboardData: {
          files: [new File(["hello"], "pasted.txt", { type: "text/plain" })],
          getData: () => "",
        },
      });
      await waitFor(() => expect(uploads).toHaveLength(1));
      expect(screen.getByText("pasted.txt")).toBeInTheDocument();

      const region = screen.getByRole("region", { name: "Message history" });
      const dataTransfer = {
        dropEffect: "none",
        files: [new File(["hello"], "dropped.txt", { type: "text/plain" })],
        types: ["Files"],
      };
      fireEvent.dragEnter(region, { dataTransfer });
      expect(region).toHaveAttribute("data-dragging", "true");
      fireEvent.drop(region, { dataTransfer });
      expect(region).not.toHaveAttribute("data-dragging");
      await waitFor(() => expect(uploads).toHaveLength(2));
      expect(screen.getByText("dropped.txt")).toBeInTheDocument();
    });

    it("hides the screenshot tool when the browser cannot capture the screen", async () => {
      const fetchMock = vi
        .fn()
        .mockImplementation(() => Promise.resolve(jsonResponse(page([]))));

      renderMessages(fetchMock, { conversation: roomConversation });
      await screen.findByRole("textbox", { name: "New message" });
      expect(
        screen.queryByRole("button", { name: /^Screenshot/ }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Send file" }),
      ).toBeInTheDocument();
    });

    it("announces a dismissed picker and offers retry after a capture failure", async () => {
      const getDisplayMedia = stubDisplayMedia(() =>
        Promise.reject(new DOMException("dismissed", "NotAllowedError")),
      );
      const fetchMock = vi
        .fn()
        .mockImplementation(() => Promise.resolve(jsonResponse(page([]))));

      renderMessages(fetchMock, { conversation: roomConversation });
      await screen.findByRole("textbox", { name: "New message" });
      const trigger = screen.getByRole("button", {
        name: "Screenshot (Ctrl+Alt+X)",
      });
      expect(trigger).toHaveAttribute("aria-keyshortcuts", "Control+Alt+X");
      act(() => trigger.focus());
      fireEvent.keyDown(trigger, { key: "Enter" });
      const items = await screen.findAllByRole("menuitem");
      expect(items.map((item) => item.textContent)).toEqual([
        "Take screenshotPick the screen, window or tab to capture",
        "Capture in 3 secondsLeaves out the TutorHub tab · time to switch to the window you want",
      ]);
      fireEvent.click(items[0] as HTMLElement);
      expect(
        await screen.findByText("Screenshot cancelled."),
      ).toBeInTheDocument();
      expect(getDisplayMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          audio: false,
          selfBrowserSurface: "include",
        }),
      );

      getDisplayMedia.mockImplementation(() =>
        Promise.reject(new Error("capture failed")),
      );
      fireEvent.keyDown(window, {
        altKey: true,
        code: "KeyX",
        ctrlKey: true,
        key: "x",
      });
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Could not take a screenshot.");
      expect(getDisplayMedia).toHaveBeenCalledTimes(2);
      fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(getDisplayMedia).toHaveBeenCalledTimes(3));
    });

    it("ignores AltGr+X so it can still type characters", async () => {
      const getDisplayMedia = stubDisplayMedia(() =>
        Promise.reject(new DOMException("dismissed", "NotAllowedError")),
      );
      const fetchMock = vi
        .fn()
        .mockImplementation(() => Promise.resolve(jsonResponse(page([]))));

      renderMessages(fetchMock, { conversation: roomConversation });
      await screen.findByRole("textbox", { name: "New message" });
      const altGraph = new KeyboardEvent("keydown", {
        altKey: true,
        bubbles: true,
        code: "KeyX",
        ctrlKey: true,
        key: "»",
      });
      Object.defineProperty(altGraph, "getModifierState", {
        value: (key: string) => key === "AltGraph",
      });
      act(() => {
        window.dispatchEvent(altGraph);
      });
      expect(getDisplayMedia).not.toHaveBeenCalled();
    });
  });

  describe("MSG-COMPOSER-TOOLS-01 cards", () => {
    const classConversation: Conversation = {
      ...conversation,
      class_id: "8f6b8a9e-31c7-4b8e-9d6f-0a0e3a1c2b11",
      kind: "class",
      participants: [],
    };
    const spaceID = "d3b3a0b2-6b5e-4f5e-9a51-1c0f0e6d2c11";

    function cardMessage(
      sequence: number,
      embed: unknown,
      own = false,
    ): Message {
      const base = message(sequence, "", { own });
      return { ...base, embed } as Message;
    }

    function capabilities(enabled: boolean) {
      return {
        can_manage_overrides: false,
        features: {
          classroom_media_rooms: { enabled },
          instant_study_rooms: { enabled },
        },
        operations: {},
        quotas: {},
        tenant_id: tenantID,
      };
    }

    function cardFetch(
      items: readonly Message[],
      options: {
        canStartSpace?: boolean;
        capabilitiesEnabled?: boolean;
        conversations?: Conversation[];
        requests?: Request[];
      } = {},
    ) {
      return vi.fn().mockImplementation(async (request: Request) => {
        const url = new URL(request.url);
        options.requests?.push(request.clone());
        if (url.pathname.endsWith("/api/v1/auth/csrf")) {
          return jsonResponse({ csrf_token: "cards-csrf" });
        }
        if (url.pathname.endsWith("/capabilities")) {
          return jsonResponse(
            capabilities(options.capabilitiesEnabled ?? false),
          );
        }
        if (
          url.pathname.endsWith("/api/v1/conversations") &&
          request.method === "GET"
        ) {
          return jsonResponse({
            items: options.conversations ?? [],
          } satisfies ConversationPage);
        }
        if (url.pathname.endsWith("/api/v1/conversations/direct")) {
          return jsonResponse(
            { ...conversation, id: "6f1f2c1e-2a51-4a5c-8f3c-0f6a3c2b1d10" },
            201,
          );
        }
        if (url.pathname.endsWith(`/api/v1/media/spaces/${spaceID}/start`)) {
          return jsonResponse({ id: spaceID, status: "open", version: 2 }, 200);
        }
        if (
          url.pathname.endsWith(`/api/v1/media/spaces/${spaceID}`) &&
          request.method === "GET"
        ) {
          return jsonResponse(
            {
              id: spaceID,
              status: "scheduled",
              version: 1,
              viewer_operations: { can_start: options.canStartSpace ?? true },
            },
            200,
          );
        }
        if (url.pathname.endsWith("/api/v1/media/spaces")) {
          return jsonResponse(
            {
              id: spaceID,
              status: "scheduled",
              version: 1,
              viewer_operations: { can_start: options.canStartSpace ?? true },
            },
            201,
          );
        }
        if (url.pathname.endsWith("/messages") && request.method === "POST") {
          return jsonResponse(
            cardMessage(9, { available: true, kind: "contact_card" }, true),
            201,
          );
        }
        return jsonResponse(page(items));
      });
    }

    it("renders contact cards from the server embed and opens a direct chat from them", async () => {
      const requests: Request[] = [];
      renderMessages(
        cardFetch(
          [
            cardMessage(1, {
              available: true,
              display_name: "Nguyễn Văn An",
              kind: "contact_card",
              user_id: "0d6e7a51-5d3c-4c1b-8a6f-7e8a9b0c1d2e",
            }),
            cardMessage(2, { available: false, kind: "contact_card" }),
            cardMessage(
              3,
              {
                available: true,
                display_name: "TutorHub Teacher",
                kind: "contact_card",
                user_id: teacherID,
              },
              true,
            ),
            message(4, "[Danh thiếp] Giả mạo Nhắn tin"),
          ],
          { requests },
        ),
        { conversation: classConversation },
      );

      const card = await screen.findByRole("region", {
        name: "Contact card for Nguyễn Văn An",
      });
      // The card shows the default avatar, never initials.
      expect(
        card.querySelector('.user-avatar[data-avatar="default"]'),
      ).not.toBeNull();
      expect(card).not.toHaveTextContent("NA");
      expect(
        screen.getByRole("region", {
          name: "This person is no longer available",
        }),
      ).not.toHaveTextContent("Message");
      const own = screen.getByRole("region", {
        name: "Contact card for TutorHub Teacher",
      });
      expect(within(own).queryByRole("button")).not.toBeInTheDocument();
      // Message text never produces an actionable card.
      expect(
        screen.getAllByRole("region", { name: /^Contact card for/ }),
      ).toHaveLength(2);

      fireEvent.click(within(card).getByRole("button", { name: "Message" }));
      await waitFor(() =>
        expect(
          requests.some((request) =>
            request.url.endsWith("/api/v1/conversations/direct"),
          ),
        ).toBe(true),
      );
      const direct = requests.find((request) =>
        request.url.endsWith("/api/v1/conversations/direct"),
      );
      await expect(direct?.json()).resolves.toEqual({
        source_message_id: "10000000-0000-4000-8000-000000000001",
      });
    });

    it("shows the instant class countdown, join link and closed states", async () => {
      renderMessages(
        cardFetch([
          cardMessage(1, {
            ends_at: "2026-08-03T09:16:00Z",
            kind: "instant_class",
            media_space_id: spaceID,
            remaining_seconds: 592,
            status: "scheduled",
            title: "Ôn tập chương 3",
            viewer_can_join: true,
          }),
          cardMessage(2, {
            ends_at: "2026-08-03T09:16:00Z",
            kind: "instant_class",
            media_space_id: spaceID,
            remaining_seconds: 300,
            status: "open",
            title: "Không được mời",
            viewer_can_join: false,
          }),
          cardMessage(3, {
            ends_at: "2026-08-03T09:16:00Z",
            kind: "instant_class",
            media_space_id: spaceID,
            remaining_seconds: 0,
            status: "ended",
            title: "Đã xong",
            viewer_can_join: true,
          }),
        ]),
        { conversation: classConversation },
      );

      const live = await screen.findByRole("region", {
        name: "Instant class Ôn tập chương 3",
      });
      expect(within(live).getByText("09:52")).toBeInTheDocument();
      expect(
        within(live).getByText("Waiting for the host"),
      ).toBeInTheDocument();
      expect(
        within(live).getByRole("link", { name: "Join class" }),
      ).toHaveAttribute("href", `/app/media/spaces/${spaceID}/prejoin`);
      const notInvited = screen.getByRole("region", {
        name: "Instant class Không được mời",
      });
      expect(within(notInvited).queryByRole("link")).not.toBeInTheDocument();
      expect(notInvited).toHaveTextContent("You are not on this class list.");
      const ended = screen.getByRole("region", {
        name: "Instant class Đã xong",
      });
      expect(within(ended).queryByRole("link")).not.toBeInTheDocument();
      expect(ended).toHaveTextContent("Ended");
    });

    it("sends a contact card picked from you and your direct contacts", async () => {
      const requests: Request[] = [];
      const studentConversation: Conversation = {
        ...conversation,
        id: "a1b2c3d4-1111-4222-8333-944455566677",
      };
      renderMessages(
        cardFetch([], { conversations: [studentConversation], requests }),
        { conversation: classConversation },
      );
      await screen.findByRole("textbox", { name: "New message" });
      expect(
        screen.queryByRole("button", { name: "Instant class" }),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Share contact" }));
      const dialog = await screen.findByRole("dialog", {
        name: "Share a contact",
      });
      // You first, then the direct counterpart once the list loads.
      await waitFor(() =>
        expect(within(dialog).getAllByRole("radio")).toHaveLength(2),
      );
      expect(within(dialog).getAllByRole("radio")[0]).toHaveAccessibleName(
        /TutorHub Teacher/,
      );
      const send = within(dialog).getByRole("button", { name: "Send contact" });
      expect(send).toBeDisabled();
      fireEvent.change(
        within(dialog).getByRole("searchbox", { name: "Search contacts" }),
        {
          target: { value: "student" },
        },
      );
      fireEvent.click(
        within(dialog).getByRole("radio", { name: /TutorHub Student/ }),
      );
      fireEvent.click(send);
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      const sent = requests.find(
        (request) =>
          request.method === "POST" && request.url.endsWith("/messages"),
      );
      await expect(sent?.json()).resolves.toEqual({
        client_message_id: expect.any(String),
        content: "",
        embed: { kind: "contact_card", user_id: studentID },
      });
    });

    it("creates an instant class, then shares it as a card", async () => {
      const requests: Request[] = [];
      renderMessages(cardFetch([], { capabilitiesEnabled: true, requests }), {
        conversation: classConversation,
      });
      fireEvent.click(
        await screen.findByRole("button", { name: "Instant class" }),
      );
      const dialog = await screen.findByRole("dialog", {
        name: "15-minute instant class",
      });
      const name = within(dialog).getByRole("textbox", { name: "Class name" });
      expect(name).toHaveValue("15-minute instant class");
      fireEvent.click(within(dialog).getByRole("radio", { name: "30 min" }));
      expect(name).toHaveValue("30-minute instant class");
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Clear class name" }),
      );
      fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "Enter a class name",
      );
      fireEvent.change(name, { target: { value: "Ôn thi cuối kỳ" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
      expect(await screen.findByText("Class created.")).toBeInTheDocument();
      const created = requests.find((request) =>
        request.url.endsWith("/api/v1/media/spaces"),
      );
      await expect(created?.json()).resolves.toMatchObject({
        idempotency_key: expect.stringMatching(/^instant-class-/),
        source: {
          duration_minutes: 30,
          kind: "instant",
          timezone: expect.any(String),
          title: "Ôn thi cuối kỳ",
        },
      });
      const started = requests.find((request) =>
        request.url.endsWith(`/api/v1/media/spaces/${spaceID}/start`),
      );
      await expect(started?.json()).resolves.toMatchObject({
        expected_version: 1,
        idempotency_key: expect.stringMatching(/^instant-class-.*:start$/),
        reason_code: "product_launch",
      });
      const shared = requests.find(
        (request) =>
          request.method === "POST" && request.url.endsWith("/messages"),
      );
      await expect(shared?.json()).resolves.toEqual({
        client_message_id: expect.any(String),
        content: "",
        embed: { kind: "instant_class", media_space_id: spaceID },
      });
    });

    it("starts a still-scheduled instant class when the owner clicks Join class", async () => {
      const requests: Request[] = [];
      renderMessages(
        cardFetch(
          [
            cardMessage(1, {
              ends_at: "2026-08-03T09:16:00Z",
              kind: "instant_class",
              media_space_id: spaceID,
              remaining_seconds: 592,
              status: "scheduled",
              title: "Ôn tập nhanh",
              viewer_can_join: true,
            }),
          ],
          { canStartSpace: true, requests },
        ),
        { conversation: classConversation },
      );

      const card = await screen.findByRole("region", {
        name: "Instant class Ôn tập nhanh",
      });
      fireEvent.click(within(card).getByRole("link", { name: "Join class" }));
      await waitFor(() =>
        expect(
          requests.some((request) =>
            request.url.endsWith(`/api/v1/media/spaces/${spaceID}/start`),
          ),
        ).toBe(true),
      );
    });
  });
});

describe("MSG-AVATAR-SEARCH-CLASSIN-01 ConversationAvatar", () => {
  afterEach(() => cleanup());

  const classID = "8f6b8a9e-31c7-4b8e-9d6f-0a0e3a1c2b11";
  const spaceID = "d3b3a0b2-6b5e-4f5e-9a51-1c0f0e6d2c11";

  function coverOf(container: HTMLElement) {
    return container
      .querySelector(".conversation-avatar--cover > .class-cover-art")
      ?.getAttribute("data-cover");
  }

  it("draws a direct chat as the Zalo-style default avatar", () => {
    const { container } = render(
      <ConversationAvatar conversation={conversation} size="sm" />,
    );
    const avatar = container.firstElementChild;
    expect(avatar).toHaveClass(
      "user-avatar",
      "conversation-avatar",
      "conversation-avatar--sm",
    );
    expect(avatar).toHaveAttribute("aria-hidden", "true");
    expect(avatar).toHaveAttribute("data-avatar", "default");
    expect(avatar).toHaveTextContent("");
    expect(container.querySelector(".class-cover-art")).toBeNull();
  });

  it("uses the class cover for a class and for a room of that class", () => {
    const classView = render(
      <ConversationAvatar
        conversation={{ ...conversation, class_id: classID, kind: "class" }}
        coverTheme="coral-bay"
      />,
    );
    expect(coverOf(classView.container)).toBe("coral-bay");
    expect(
      classView.container.querySelector(".conversation-avatar__badge svg"),
    ).not.toBeNull();
    classView.unmount();

    const roomView = render(
      <ConversationAvatar
        conversation={{
          ...conversation,
          class_id: classID,
          kind: "room",
          media_space_id: spaceID,
        }}
        coverTheme="coral-bay"
        size="lg"
      />,
    );
    expect(coverOf(roomView.container)).toBe("coral-bay");
    expect(roomView.container.firstElementChild).toHaveClass(
      "conversation-avatar--room",
      "conversation-avatar--lg",
    );
    // No pastel video tile any more.
    expect(roomView.container.querySelector("[data-tone]")).toBeNull();
  });

  it("gives a standalone room a stable cover from its media space", () => {
    const standalone = {
      ...conversation,
      kind: "room" as const,
      media_space_id: spaceID,
    };
    const first = render(
      <ConversationAvatar
        conversation={standalone}
        // A class cover never applies to a room without a class.
        coverTheme="minimal-studio"
      />,
    );
    expect(coverOf(first.container)).toBe(defaultCoverTheme(spaceID));
    first.unmount();

    const withoutSpace = render(
      <ConversationAvatar
        conversation={{ ...standalone, media_space_id: undefined }}
      />,
    );
    expect(coverOf(withoutSpace.container)).toBe(
      defaultCoverTheme(conversationID),
    );
  });
});
