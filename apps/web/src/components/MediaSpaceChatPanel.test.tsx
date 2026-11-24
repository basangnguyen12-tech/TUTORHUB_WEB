// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../app/i18n";
import {
  MediaSpaceChatPanel,
  ROOM_CHAT_CLOSED_POLL_MS,
  ROOM_CHAT_OPEN_POLL_MS,
  useMediaSpaceRoomChat,
} from "./MediaSpaceChatPanel";

const tenantID = "4b18543a-74de-419f-9fe8-d0c3dfc991eb";
const mediaSpaceID = "3b96de90-4d8b-460f-aafd-a1e814b0a6bf";
const conversationID = "c82ef7ee-0a1b-4e99-b9d5-3ae20858a82e";
const actorID = "be85eb92-0f18-4163-85ba-50e4d343d632";
const peerID = "53f0dac5-6c10-46ff-bcb8-da03d07bc142";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type":
        status >= 400 ? "application/problem+json" : "application/json",
    },
  });
}

function roomConversation(canPostMessages: boolean) {
  return {
    id: conversationID,
    kind: "room",
    media_space_id: mediaSpaceID,
    media_space_status: canPostMessages ? "open" : "ended",
    participant_chat_enabled: true,
    title: "Weekly tutoring room",
    participants: [],
    viewer_access: {
      can_moderate_chat: false,
      can_post_messages: canPostMessages,
      can_upload_attachments: canPostMessages,
    },
    unread_count: 0,
    unread_count_capped: false,
    created_at: "2026-11-24T08:00:00Z",
    updated_at: "2026-11-24T08:00:00Z",
  };
}

const peerMessage = {
  attachments: [],
  author: { display_name: "Minh Anh", user_id: peerID },
  client_message_id: "78c0f30f-c4f8-4b66-bac3-e31db5062fb8",
  content: "Em chào cô",
  conversation_id: conversationID,
  created_at: "2026-11-24T08:01:00Z",
  id: "bd7375d9-0588-4b14-9567-06b230974975",
  sequence: 3,
  state: "active",
  updated_at: "2026-11-24T08:01:00Z",
  version: 1,
};

function messagePage(unread: number) {
  return {
    items: unread > 0 ? [peerMessage] : [],
    read_state: null,
    unread_count: unread,
    unread_count_capped: false,
  };
}

function Harness({ enabled, open }: { enabled: boolean; open: boolean }) {
  const chat = useMediaSpaceRoomChat({
    actorID,
    enabled,
    mediaSpaceID,
    open,
    tenantID,
  });
  return (
    <>
      <output data-testid="unread">{chat.unreadCount}</output>
      <MediaSpaceChatPanel chat={chat} />
    </>
  );
}

function renderHarness({ enabled = true, open = false } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLanguage="en">
        <Harness enabled={enabled} open={open} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return {
    rerender: (next: { enabled?: boolean; open?: boolean }) =>
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <I18nProvider initialLanguage="en">
            <Harness
              enabled={next.enabled ?? enabled}
              open={next.open ?? open}
            />
          </I18nProvider>
        </QueryClientProvider>,
      ),
  };
}

function installFetch({
  canPost = true,
  unread = 0,
}: { canPost?: boolean; unread?: number } = {}) {
  const requests: Request[] = [];
  const fetchMock = vi.fn().mockImplementation((request: Request) => {
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (path.endsWith("/api/v1/auth/csrf")) {
      return Promise.resolve(jsonResponse({ csrf_token: "room-csrf" }));
    }
    if (path.endsWith("/conversation")) {
      return Promise.resolve(jsonResponse(roomConversation(canPost), 201));
    }
    if (path.endsWith("/messages") && request.method === "GET") {
      return Promise.resolve(jsonResponse(messagePage(unread)));
    }
    if (path.endsWith("/read")) {
      return Promise.resolve(
        jsonResponse({
          last_read_message_id: peerMessage.id,
          last_read_sequence: peerMessage.sequence,
          updated_at: "2026-11-24T08:02:00Z",
        }),
      );
    }
    return Promise.resolve(jsonResponse(roomConversation(canPost)));
  });
  vi.stubGlobal("fetch", fetchMock);
  return requests;
}

describe("MediaSpaceChatPanel / useMediaSpaceRoomChat", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("ensures one canonical room conversation and renders the classroom messenger", async () => {
    const requests = installFetch();
    renderHarness({ open: true });

    expect(await screen.findByText("No messages yet")).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Message text" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Refresh messages" }),
    ).toBeNull();
    const ensure = requests.find((request) =>
      new URL(request.url).pathname.endsWith(
        `/api/v1/media/spaces/${mediaSpaceID}/conversation`,
      ),
    );
    expect(ensure?.method).toBe("POST");
    expect(ensure?.headers.get("X-CSRF-Token")).toBe("room-csrf");
    expect(
      requests.some(
        (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname.endsWith(
            `/conversations/${conversationID}/messages`,
          ),
      ),
    ).toBe(true);
  });

  it("keeps committed room history visible but read-only after the room ends", async () => {
    installFetch({ canPost: false });
    renderHarness({ open: true });

    expect(
      await screen.findByText(
        "This class has ended — chat history is read-only.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Message text" })).toBeNull();
  });

  it("does not create a chat aggregate before the live room scope is ready", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    renderHarness({ enabled: false });

    expect(screen.getByText("Chat is unavailable")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports unread messages while closed and marks them read only once opened on a visible tab", async () => {
    const requests = installFetch({ unread: 2 });
    const view = renderHarness({ open: false });

    await waitFor(() =>
      expect(screen.getByTestId("unread")).toHaveTextContent("2"),
    );
    expect(
      requests.some((request) =>
        new URL(request.url).pathname.endsWith("/read"),
      ),
    ).toBe(false);

    view.rerender({ open: true });
    expect(screen.getByTestId("unread")).toHaveTextContent("0");
    await waitFor(() =>
      expect(
        requests.some((request) =>
          new URL(request.url).pathname.endsWith(
            `/conversations/${conversationID}/read`,
          ),
        ),
      ).toBe(true),
    );
    const read = requests.find((request) =>
      new URL(request.url).pathname.endsWith("/read"),
    );
    await expect(read?.clone().json()).resolves.toEqual({
      message_id: peerMessage.id,
    });
  });

  it("polls messages faster while open and keeps polling for the Dock badge while closed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const requests = installFetch({ unread: 1 });
    const view = renderHarness({ open: false });
    const listCount = () =>
      requests.filter(
        (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname.endsWith("/messages"),
      ).length;
    await waitFor(() => expect(listCount()).toBe(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ROOM_CHAT_CLOSED_POLL_MS + 50);
    });
    await waitFor(() => expect(listCount()).toBeGreaterThanOrEqual(2));

    view.rerender({ open: true });
    const before = listCount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ROOM_CHAT_OPEN_POLL_MS + 50);
    });
    await waitFor(() => expect(listCount()).toBeGreaterThan(before));
  });
});
