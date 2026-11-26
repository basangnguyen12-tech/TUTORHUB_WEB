// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
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
  ActiveMessage,
  Conversation,
  Message,
  MessageAttachment,
} from "@tutorhub/api-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../app/i18n";
import {
  ClassroomChatPanel,
  type ClassroomChatPanelProps,
} from "./ClassroomChatPanel";
import {
  CHAT_EMOJI_RECENT_LIMIT,
  CLASSROOM_EMOJI_TOPICS,
  chatEmojiRecentKey,
  checkChatFile,
  createAttachmentObjectURLCache,
  createClassroomChatComposerStore,
  isJumboEmoji,
  linkifyChatText,
  loadChatEmojiRecents,
  normalizeEmojiSearch,
  parseClassroomEmojiCatalog,
  prefillClassroomChatComposer,
  recordChatEmojiRecent,
  searchClassroomEmoji,
} from "./classroomChatMedia";
import { EMOJI_CATALOG_DATA, EMOJI_CATALOG_SOURCE } from "./emojiCatalog.data";

const actorID = "be85eb92-0f18-4163-85ba-50e4d343d632";
const peerID = "53f0dac5-6c10-46ff-bcb8-da03d07bc142";
const tenantID = "4b18543a-74de-419f-9fe8-d0c3dfc991eb";
const conversationID = "c82ef7ee-0a1b-4e99-b9d5-3ae20858a82e";

function roomConversation(
  overrides: Partial<Conversation> = {},
  access: Partial<Conversation["viewer_access"]> = {},
): Conversation {
  return {
    created_at: "2026-11-24T08:00:00Z",
    id: conversationID,
    kind: "room",
    media_space_id: "3b96de90-4d8b-460f-aafd-a1e814b0a6bf",
    media_space_status: "open",
    participant_chat_enabled: true,
    participants: [],
    title: "Lớp Toán 10",
    unread_count: 0,
    unread_count_capped: false,
    updated_at: "2026-11-24T08:00:00Z",
    ...overrides,
    viewer_access: {
      can_moderate_chat: false,
      can_post_messages: true,
      can_upload_attachments: true,
      ...access,
    },
  };
}

let sequence = 0;
function message(
  content: string,
  overrides: Partial<ActiveMessage> = {},
): ActiveMessage {
  sequence += 1;
  return {
    attachments: [],
    author: { display_name: "Minh Anh", user_id: peerID },
    client_message_id: crypto.randomUUID(),
    content,
    conversation_id: conversationID,
    created_at: new Date(Date.now() - 60_000 + sequence * 1000).toISOString(),
    id: crypto.randomUUID(),
    sequence,
    state: "active",
    updated_at: new Date().toISOString(),
    version: 1,
    ...overrides,
  };
}

function attachment(
  overrides: Partial<MessageAttachment> = {},
): MessageAttachment {
  return {
    conversation_id: conversationID,
    created_at: new Date().toISOString(),
    display_name: "bai-tap.png",
    height_px: 480,
    id: crypto.randomUUID(),
    kind: "image",
    media_type: "image/png",
    size_bytes: 2048,
    width_px: 640,
    ...overrides,
  };
}

function renderPanel(overrides: Partial<ClassroomChatPanelProps> = {}) {
  const props: ClassroomChatPanelProps = {
    actorID,
    conversation: roomConversation(),
    hasOlder: false,
    loadAttachment: vi.fn(async () => new Blob(["x"], { type: "image/png" })),
    loadingOlder: false,
    messages: [],
    onDelete: vi.fn(async () => undefined),
    onEdit: vi.fn(async () => undefined),
    onLoadOlder: vi.fn(),
    onSend: vi.fn(async () => undefined),
    onToggleParticipantChat: vi.fn(async () => undefined),
    onUpload: vi.fn(async (input) =>
      attachment({
        display_name: input.fileName,
        id: input.clientAttachmentID,
      }),
    ),
    open: true,
    prepareImage: vi.fn(async (file: File) => ({
      blob: new Blob(["clean"], { type: "image/png" }),
      fileName: file.name,
      height: 480,
      width: 640,
    })),
    tenantID,
    ...overrides,
  };
  const view = render(
    <I18nProvider initialLanguage="vi">
      <ClassroomChatPanel {...props} />
    </I18nProvider>,
  );
  return { props, view };
}

function composer() {
  return screen.getByRole("textbox", { name: "Nội dung tin nhắn" });
}

describe("ClassroomChatPanel", () => {
  it("opens a URL-free reference and leaves an invalid fence as inert text", async () => {
    const onOpenDocument = vi.fn(async () => undefined);
    const ref = {
      fileId: actorID,
      name: "Đề ôn.pdf",
      page: 3,
      mediaType: "application/pdf",
    };
    const bad = [
      "```tutorhub-doc",
      JSON.stringify({ ...ref, name: "https://private.example" }),
      "```",
    ].join("\n");
    renderPanel({
      messages: [
        message(
          ["```tutorhub-doc", JSON.stringify(ref), "```", "Làm bài", bad].join(
            "\n",
          ),
        ),
      ],
      onOpenDocument,
    });
    expect(screen.getByText("Đề ôn.pdf")).toBeInTheDocument();
    expect(screen.getByText("Trang 3")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mở trong Tài liệu" }));
    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledWith(ref));
  });
  it("offers only supported attachment actions and gates save by staff permission", async () => {
    const pdf = attachment({
      display_name: "Đề ôn.pdf",
      media_type: "application/pdf",
      kind: "file",
    });
    const unsupported = attachment({
      display_name: "ghi.docx",
      media_type: "application/msword",
      kind: "file",
    });
    const onOpenAttachment = vi.fn(async () => undefined);
    const onSaveAttachment = vi.fn(async () => undefined);
    const messages = [message("", { attachments: [pdf, unsupported] })];
    const { view } = renderPanel({ messages, onOpenAttachment });
    expect(
      screen.queryByRole("button", { name: "Lưu vào Kho tài liệu" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mở trong Tài liệu" }));
    await waitFor(() => expect(onOpenAttachment).toHaveBeenCalledWith(pdf));
    view.unmount();
    renderPanel({ messages, onOpenAttachment, onSaveAttachment });
    fireEvent.click(
      screen.getByRole("button", { name: "Lưu vào Kho tài liệu" }),
    );
    await waitFor(() => expect(onSaveAttachment).toHaveBeenCalledWith(pdf));
  });
  beforeEach(() => {
    let counter = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    URL.createObjectURL = vi.fn(() => `blob:chat-${(counter += 1)}`);
    URL.revokeObjectURL = vi.fn();
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("shows a calm empty state and sends with Enter while Shift+Enter adds a line", async () => {
    const { props } = renderPanel();
    expect(screen.getByText("Chưa có tin nhắn nào")).toBeInTheDocument();
    expect(screen.queryByText("Làm mới tin nhắn")).toBeNull();
    expect(screen.queryByText(/0\/4000/u)).toBeNull();
    const send = screen.getByRole("button", { name: "Gửi" });
    expect(send).toBeDisabled();

    fireEvent.change(composer(), { target: { value: "Dòng 1" } });
    fireEvent.keyDown(composer(), { key: "Enter", shiftKey: true });
    expect(props.onSend).not.toHaveBeenCalled();

    // A Vietnamese IME composition must never send early.
    fireEvent.keyDown(composer(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(composer(), { key: "Enter", keyCode: 229 });
    expect(props.onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(composer(), { key: "Enter" });
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1));
    const input = vi.mocked(props.onSend).mock.calls[0]?.[0];
    expect(input?.content).toBe("Dòng 1");
    expect(input?.attachmentIDs).toEqual([]);
    expect(input?.clientMessageID).toMatch(/^[0-9a-f-]{36}$/u);
    await waitFor(() => expect(composer()).toHaveValue(""));
  });

  it("retries a failed send with the same idempotency key", async () => {
    const onSend = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    renderPanel({ onSend });
    fireEvent.change(composer(), { target: { value: "Xin chào" } });
    fireEvent.click(screen.getByRole("button", { name: "Gửi" }));
    expect(
      await screen.findByText("Chưa gửi được tin nhắn. Hãy thử lại."),
    ).toBeInTheDocument();
    expect(composer()).toHaveValue("Xin chào");
    fireEvent.click(screen.getByRole("button", { name: "Gửi" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(onSend.mock.calls[1]?.[0].clientMessageID).toBe(
      onSend.mock.calls[0]?.[0].clientMessageID,
    );
  });

  it("opens a Zalo-style picker and keeps it open for several emoji in a row", async () => {
    renderPanel();
    const textbox = composer() as HTMLTextAreaElement;
    fireEvent.change(textbox, { target: { value: "ab" } });
    textbox.setSelectionRange(1, 1);

    const trigger = screen.getByRole("button", { name: "Biểu tượng cảm xúc" });
    fireEvent.click(trigger);
    const picker = screen.getByRole("dialog", {
      name: "Chọn biểu tượng cảm xúc",
    });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const search = within(picker).getByRole("searchbox", {
      name: "Tìm biểu tượng cảm xúc",
    });
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute("placeholder", "Tìm biểu tượng cảm xúc…");
    // Opening alone never touches localStorage.
    expect(window.localStorage).toHaveLength(0);

    // Three tiers: search on top, one stream, the topic bar at the bottom.
    await within(picker).findByRole("button", { name: "mặt cười toe toét" });
    const tablist = within(picker).getByRole("tablist", {
      name: "Danh mục biểu tượng",
    });
    const stream = picker.querySelector(".classroom-chat-emoji__stream")!;
    expect(picker.lastElementChild).toBe(tablist.parentElement);
    expect(
      search.compareDocumentPosition(stream) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      stream.compareDocumentPosition(tablist) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(tablist)
        .getAllByRole("tab")
        .map((tab) => tab.getAttribute("aria-label")),
    ).toEqual([
      "Gần đây",
      "Cảm xúc",
      "Con người & Cử chỉ",
      "Động vật & Thiên nhiên",
      "Ẩm thực & Đồ uống",
      "Hoạt động & Thể thao",
      "Du lịch & Địa điểm",
      "Đồ vật & Học tập",
      "Biểu tượng & Toán học",
      "Cờ",
    ]);
    // No Recent row yet: the stream starts with Smileys.
    expect(
      within(tablist).getByRole("tab", { name: "Cảm xúc" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(within(picker).queryByRole("group", { name: "Gần đây" })).toBeNull();
    // ~1.9k emoji, but only the rows near the viewport are in the DOM.
    expect(picker.querySelectorAll("[data-cell]").length).toBeLessThan(260);

    // Vietnamese without diacritics: 👏, then ❤️ follows it at the caret.
    fireEvent.change(search, { target: { value: "vo tay" } });
    expect(
      within(picker).getByRole("heading", { name: /kết quả$/u }),
    ).toBeInTheDocument();
    fireEvent.click(within(picker).getByRole("button", { name: "vỗ tay" }));
    expect(textbox).toHaveValue("a👏b");
    expect(
      screen.getByRole("dialog", { name: "Chọn biểu tượng cảm xúc" }),
    ).toBeInTheDocument();
    fireEvent.click(
      within(picker).getByRole("button", { name: "Xóa từ khóa tìm kiếm" }),
    );
    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: "trai tim" } });
    fireEvent.click(
      within(picker).getByRole("button", { name: "trái tim màu đỏ" }),
    );
    expect(textbox).toHaveValue("a👏❤️b");
    expect(textbox.selectionStart).toBe("a👏❤️".length);

    const key = `tutorhub:chat-emoji-recent:v1:${tenantID}:${actorID}`;
    expect(JSON.parse(window.localStorage.getItem(key) ?? "[]")).toEqual([
      "❤️",
      "👏",
    ]);

    // Escape closes only the popover and returns focus to the emoji key.
    fireEvent.keyDown(search, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: "Chọn biểu tượng cảm xúc" }),
    ).toBeNull();
    expect(trigger).toHaveFocus();
    expect(composer()).toBeInTheDocument();

    // Reopening shows them first, most recent first.
    fireEvent.click(trigger);
    const reopened = screen.getByRole("dialog", {
      name: "Chọn biểu tượng cảm xúc",
    });
    const recent = await within(reopened).findByRole("group", {
      name: "Gần đây",
    });
    expect(
      within(recent)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["❤️", "👏"]);
    expect(
      within(reopened).getByRole("tab", { name: "Gần đây" }),
    ).toHaveAttribute("aria-selected", "true");
  });

  it("jumps from the bottom topic bar to the exact section and follows scrolling", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Biểu tượng cảm xúc" }));
    const picker = screen.getByRole("dialog", {
      name: "Chọn biểu tượng cảm xúc",
    });
    await within(picker).findByRole("button", { name: "mặt cười toe toét" });
    const stream = picker.querySelector<HTMLElement>(
      ".classroom-chat-emoji__stream",
    )!;
    const sectionTop = (name: string) =>
      Number(
        within(picker).getByRole("group", { name }).getAttribute("data-top"),
      );
    const tab = (name: string) => within(picker).getByRole("tab", { name });

    fireEvent.click(tab("Ẩm thực & Đồ uống"));
    expect(tab("Ẩm thực & Đồ uống")).toHaveAttribute("aria-selected", "true");
    expect(tab("Cảm xúc")).toHaveAttribute("aria-selected", "false");
    expect(stream.scrollTop).toBe(sectionTop("Ẩm thực & Đồ uống"));
    expect(
      within(picker).getByRole("button", { name: "chùm nho" }),
    ).toBeInTheDocument();

    // The last topic lands on its first row on the very first click.
    fireEvent.click(tab("Cờ"));
    expect(stream.scrollTop).toBe(sectionTop("Cờ"));
    const flags = within(picker).getByRole("group", { name: "Cờ" });
    expect(within(flags).getAllByRole("button")[0]).toHaveAccessibleName(
      "cờ: Việt Nam",
    );

    // Scroll-spy: scrolling into Animals & Nature moves the underline.
    stream.scrollTop = sectionTop("Động vật & Thiên nhiên") + 40;
    fireEvent.scroll(stream);
    expect(tab("Động vật & Thiên nhiên")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(tab("Cờ")).toHaveAttribute("aria-selected", "false");

    // Bottom bar keys: roving focus, Home shows the empty-Recent hint.
    tab("Động vật & Thiên nhiên").focus();
    fireEvent.keyDown(tab("Động vật & Thiên nhiên"), { key: "ArrowRight" });
    expect(tab("Ẩm thực & Đồ uống")).toHaveFocus();
    expect(tab("Ẩm thực & Đồ uống")).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tab("Ẩm thực & Đồ uống"), { key: "Home" });
    expect(tab("Gần đây")).toHaveFocus();
    expect(stream.scrollTop).toBe(0);
    expect(
      within(picker).getByText("Emoji bạn dùng sẽ xuất hiện tại đây"),
    ).toBeInTheDocument();
    fireEvent.keyDown(tab("Gần đây"), { key: "End" });
    expect(tab("Cờ")).toHaveFocus();
    expect(stream.scrollTop).toBe(sectionTop("Cờ"));
  });

  it("moves through the 8-column grid with arrows across topics", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Biểu tượng cảm xúc" }));
    const picker = screen.getByRole("dialog", {
      name: "Chọn biểu tượng cảm xúc",
    });
    const first = await within(picker).findByRole("button", {
      name: "mặt cười toe toét",
    });
    const search = within(picker).getByRole("searchbox");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(first).toHaveFocus();
    expect(first).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(first, { key: "ArrowRight" });
    const second = document.activeElement as HTMLElement;
    expect(second).toHaveAttribute("data-cell", "smileys:1");
    fireEvent.keyDown(second, { key: "ArrowDown" });
    expect(document.activeElement).toHaveAttribute("data-cell", "smileys:9");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toHaveAttribute("data-cell", "smileys:15");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toHaveAttribute("data-cell", "smileys:8");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(search).toHaveFocus();

    // Ctrl+End reaches the last flag even though it was never rendered.
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "End", ctrlKey: true });
    const last = document.activeElement as HTMLElement;
    expect(last.getAttribute("data-cell")).toMatch(/^flags:\d+$/u);
    expect(last).toHaveAccessibleName("cờ: Xứ Wales");
    // Crossing a topic border keeps the column.
    fireEvent.keyDown(document.activeElement!, { key: "Home", ctrlKey: true });
    const peopleStart = within(picker).getByRole("tab", {
      name: "Con người & Cử chỉ",
    });
    fireEvent.click(peopleStart);
    const people = within(picker).getByRole("group", {
      name: "Con người & Cử chỉ",
    });
    const firstPerson = within(people).getAllByRole("button")[2]!;
    firstPerson.focus();
    fireEvent.keyDown(firstPerson, { key: "ArrowUp" });
    const above = document.activeElement as HTMLElement;
    expect(above.getAttribute("data-cell")).toMatch(/^smileys:\d+$/u);
    expect(
      Number(above.getAttribute("data-cell")!.split(":")[1]) % 8,
    ).toBeLessThanOrEqual(2);
  });

  it("closes the picker on send and on outside clicks, but not inside the composer", async () => {
    const { props } = renderPanel();
    const trigger = screen.getByRole("button", { name: "Biểu tượng cảm xúc" });
    fireEvent.click(trigger);
    const picker = screen.getByRole("dialog", {
      name: "Chọn biểu tượng cảm xúc",
    });
    fireEvent.click(
      await within(picker).findByRole("button", { name: "mặt cười toe toét" }),
    );
    fireEvent.pointerDown(composer());
    expect(
      screen.getByRole("dialog", { name: "Chọn biểu tượng cảm xúc" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(composer(), { key: "Enter" });
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1));
    expect(vi.mocked(props.onSend).mock.calls[0]?.[0].content).toBe("😀");
    expect(
      screen.queryByRole("dialog", { name: "Chọn biểu tượng cảm xúc" }),
    ).toBeNull();

    fireEvent.click(trigger);
    expect(
      screen.getByRole("dialog", { name: "Chọn biểu tượng cảm xúc" }),
    ).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(
      screen.queryByRole("dialog", { name: "Chọn biểu tượng cảm xúc" }),
    ).toBeNull();
  });

  it("renders jumbo emoji, safe links, day pills and same-author grouping", () => {
    const first = message("Xem https://example.com/bai-3. nhé");
    const second = message("🎉🎉", {
      created_at: new Date(
        new Date(first.created_at).getTime() + 60_000,
      ).toISOString(),
    });
    const own = message("javascript:alert(1) không phải link", {
      author: { display_name: "Thu Hà", user_id: actorID },
      edited_at: new Date().toISOString(),
    });
    const { view } = renderPanel({ messages: [first, second, own] });

    expect(screen.getByText("Hôm nay")).toBeInTheDocument();
    const link = screen.getByRole("link", {
      name: "https://example.com/bai-3",
    });
    expect(link).toHaveAttribute("href", "https://example.com/bai-3");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByRole("link", { name: /javascript/u })).toBeNull();

    const items = view.container.querySelectorAll(".classroom-chat__message");
    expect(items).toHaveLength(3);
    expect(items[1]).toHaveAttribute("data-grouped", "true");
    expect(items[1]?.querySelector("[data-jumbo]")).toHaveTextContent("🎉🎉");
    expect(items[0]?.querySelector("[data-jumbo]")).toBeNull();
    expect(items[2]).toHaveAttribute("data-own", "true");
    expect(
      within(items[2] as HTMLElement).getByText("(đã sửa)"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("log", { name: "Tin nhắn trong phòng" }),
    ).toBeInTheDocument();
  });

  it("stages images and files, strips images before upload and sends attachment-only", async () => {
    const { props } = renderPanel();
    const image = new File(["\u0089PNG"], "anh bai tap.png", {
      type: "image/png",
    });
    const pdf = new File(["%PDF-1.7"], "de-cuong.pdf", {
      type: "application/pdf",
    });
    fireEvent.change(screen.getByTestId("classroom-chat-image-input"), {
      target: { files: [image] },
    });
    fireEvent.change(screen.getByTestId("classroom-chat-file-input"), {
      target: { files: [pdf] },
    });

    const strip = screen.getByRole("list", { name: "Tệp đang chờ gửi" });
    await waitFor(() =>
      expect(within(strip).getAllByRole("listitem")).toHaveLength(2),
    );
    await waitFor(() => expect(props.onUpload).toHaveBeenCalledTimes(2));
    expect(props.prepareImage).toHaveBeenCalledWith(image, "image/png");
    const uploads = vi.mocked(props.onUpload).mock.calls.map((call) => call[0]);
    const imageUpload = uploads.find((upload) =>
      upload.fileName.endsWith(".png"),
    );
    expect(imageUpload?.widthPx).toBe(640);
    expect(await imageUpload?.file.text()).toBe("clean");
    expect(
      uploads.find((upload) => upload.fileName === "de-cuong.pdf")?.file,
    ).toBe(pdf);

    const send = screen.getByRole("button", { name: "Gửi" });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1));
    const input = vi.mocked(props.onSend).mock.calls[0]?.[0];
    expect(input?.content).toBe("");
    expect(input?.attachmentIDs).toHaveLength(2);
    await waitFor(() =>
      expect(
        screen.queryByRole("list", { name: "Tệp đang chờ gửi" }),
      ).toBeNull(),
    );
  });

  it("pastes clipboard screenshots and rejects unsafe or oversized files with friendly copy", async () => {
    const { props } = renderPanel();
    const screenshot = new File(["img"], "image.png", { type: "image/png" });
    fireEvent.paste(composer(), {
      clipboardData: {
        files: [screenshot],
        getData: () => "",
      },
    });
    await waitFor(() => expect(props.onUpload).toHaveBeenCalledTimes(1));

    const svg = new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" });
    fireEvent.change(screen.getByTestId("classroom-chat-file-input"), {
      target: { files: [svg] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Không hỗ trợ định dạng của “logo.svg”",
    );
    const huge = new File(["x"], "video.zip", { type: "application/zip" });
    Object.defineProperty(huge, "size", { value: 11 * 1024 * 1024 });
    fireEvent.change(screen.getByTestId("classroom-chat-file-input"), {
      target: { files: [huge] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "“video.zip” vượt giới hạn",
    );
    expect(props.onUpload).toHaveBeenCalledTimes(1);
  });

  it("drops files onto the panel with a highlighted drop zone", async () => {
    const { props, view } = renderPanel();
    const panel = view.container.querySelector(".classroom-chat")!;
    const file = new File(["%PDF"], "phieu.pdf", { type: "application/pdf" });
    fireEvent.dragEnter(panel, {
      dataTransfer: { files: [file], types: ["Files"] },
    });
    expect(panel).toHaveAttribute("data-dragging", "true");
    expect(
      screen.getByText("Thả ảnh hoặc tệp vào đây để gửi"),
    ).toBeInTheDocument();
    fireEvent.drop(panel, {
      dataTransfer: { files: [file], types: ["Files"] },
    });
    expect(panel).not.toHaveAttribute("data-dragging");
    await waitFor(() => expect(props.onUpload).toHaveBeenCalledTimes(1));
  });

  it("loads image and file attachments through revocable blob URLs and opens a lightbox", async () => {
    const photo = attachment();
    const pdf = attachment({
      display_name: "de-cuong.pdf",
      height_px: undefined,
      kind: "file",
      media_type: "application/pdf",
      size_bytes: 1_572_864,
      width_px: undefined,
    });
    const loadAttachment = vi.fn(async () => new Blob(["bytes"]));
    const cache = createAttachmentObjectURLCache();
    renderPanel({
      attachmentCache: cache,
      loadAttachment,
      messages: [message("", { attachments: [photo, pdf] })],
    });

    const view = await screen.findByRole("button", {
      name: "Xem ảnh bai-tap.png",
    });
    await waitFor(() => expect(view).toBeEnabled());
    expect(screen.getByText("PDF · 1,5 MB")).toBeInTheDocument();
    fireEvent.click(view);
    const lightbox = await screen.findByRole("dialog", { name: "bai-tap.png" });
    expect(
      within(lightbox).getByRole("img", { name: "bai-tap.png" }),
    ).toHaveAttribute("src", expect.stringMatching(/^blob:chat-/u));
    const download = within(lightbox).getByRole("link", {
      name: "Tải ảnh gốc",
    });
    expect(download).toHaveAttribute("download", "bai-tap.png");
    // The cached object URL is reused (one fetch per attachment).
    expect(loadAttachment).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(lightbox, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "bai-tap.png" })).toBeNull(),
    );

    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    fireEvent.click(
      screen.getByRole("button", { name: "Tải xuống de-cuong.pdf" }),
    );
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(loadAttachment).toHaveBeenCalledTimes(2);
    cache.revokeAll();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("edits inline with Enter, cancels with Escape and deletes own messages", async () => {
    const own = message("Bài 3 làm xong", {
      author: { display_name: "Thu Hà", user_id: actorID },
    });
    const peer = message("Cảm ơn cô");
    const { props } = renderPanel({ messages: [peer, own] });

    expect(screen.getAllByRole("button", { name: "Sửa" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Sửa" }));
    const editor = screen.getByRole("textbox", { name: "Sửa tin nhắn" });
    await waitFor(() => expect(editor).toHaveFocus());
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Sửa tin nhắn" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Sửa" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Sửa tin nhắn" }), {
      target: { value: "Bài 3 và 4 làm xong" },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Sửa tin nhắn" }), {
      key: "Enter",
    });
    await waitFor(() =>
      expect(props.onEdit).toHaveBeenCalledWith(own, "Bài 3 và 4 làm xong"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Xóa" }));
    await waitFor(() => expect(props.onDelete).toHaveBeenCalledWith(own));
    expect(await screen.findByText("Đã thu hồi tin nhắn.")).toBeInTheDocument();
  });

  it("renders recalled messages as a quiet tombstone", () => {
    const recalled: Message = {
      author: { display_name: "Minh Anh", user_id: peerID },
      client_message_id: crypto.randomUUID(),
      conversation_id: conversationID,
      created_at: new Date().toISOString(),
      deleted_at: new Date().toISOString(),
      id: crypto.randomUUID(),
      sequence: 99,
      state: "deleted",
      updated_at: new Date().toISOString(),
      version: 2,
    };
    renderPanel({ messages: [recalled] });
    expect(screen.getByText("Tin nhắn đã được thu hồi")).toBeInTheDocument();
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("lets a teacher switch participant chat and shows read-only reasons to students", async () => {
    const { props, view } = renderPanel({
      conversation: roomConversation({}, { can_moderate_chat: true }),
    });
    const toggle = screen.getByRole("switch", {
      name: "Cho phép người tham gia gửi tin nhắn",
    });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(props.onToggleParticipantChat).toHaveBeenCalledWith(false),
    );
    expect(
      await screen.findByText("Đã tạm tắt gửi tin nhắn cho người tham gia."),
    ).toBeInTheDocument();
    view.unmount();

    renderPanel({
      conversation: roomConversation(
        { participant_chat_enabled: false },
        { can_post_messages: false, can_upload_attachments: false },
      ),
    });
    expect(screen.queryByRole("switch")).toBeNull();
    expect(
      screen.getByText("Giáo viên đã tạm tắt gửi tin nhắn cho người tham gia."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Nội dung tin nhắn" }),
    ).toBeNull();
    cleanup();

    renderPanel({
      conversation: roomConversation(
        { media_space_status: "ended" },
        { can_post_messages: false },
      ),
    });
    expect(
      screen.getByText(
        "Phòng học đã kết thúc — lịch sử trò chuyện ở chế độ chỉ đọc.",
      ),
    ).toBeInTheDocument();
  });

  it("shows the character counter only near the 4000 limit", () => {
    renderPanel();
    fireEvent.change(composer(), { target: { value: "a".repeat(3499) } });
    expect(screen.queryByText("3499/4000")).toBeNull();
    fireEvent.change(composer(), { target: { value: "a".repeat(3600) } });
    expect(screen.getByText("3600/4000")).toBeInTheDocument();
    fireEvent.change(composer(), { target: { value: "a".repeat(4001) } });
    expect(screen.getByRole("button", { name: "Gửi" })).toBeDisabled();
  });

  it("keeps the draft and staged uploads when the inspector remounts", async () => {
    const store = createClassroomChatComposerStore();
    const first = renderPanel({ composerStore: store });
    fireEvent.change(composer(), { target: { value: "Nháp dở" } });
    first.view.unmount();
    expect(store.draft).toBe("Nháp dở");
    renderPanel({ composerStore: store });
    expect(composer()).toHaveValue("Nháp dở");
  });

  it("offers older history and a new-messages pill when reading back", async () => {
    const initial = [message("Một"), message("Hai")];
    const { props, view } = renderPanel({ hasOlder: true, messages: initial });
    fireEvent.click(
      screen.getByRole("button", { name: "Tải tin nhắn cũ hơn" }),
    );
    expect(props.onLoadOlder).toHaveBeenCalledTimes(1);

    const stream = screen.getByRole("log");
    Object.defineProperty(stream, "scrollHeight", {
      configurable: true,
      value: 2000,
    });
    Object.defineProperty(stream, "clientHeight", {
      configurable: true,
      value: 400,
    });
    stream.scrollTop = 100;
    fireEvent.scroll(stream);
    view.rerender(
      <I18nProvider initialLanguage="vi">
        <ClassroomChatPanel {...props} messages={[...initial, message("Ba")]} />
      </I18nProvider>,
    );
    const pill = await screen.findByRole("button", { name: "Tin nhắn mới" });
    await act(async () => {
      fireEvent.click(pill);
    });
    expect(screen.queryByRole("button", { name: "Tin nhắn mới" })).toBeNull();
  });

  describe("ROOM-TOOLS-CODE-01 code cards", () => {
    let writeText: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      writeText = vi.fn(async () => undefined);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
    });

    afterEach(() => {
      Reflect.deleteProperty(navigator, "clipboard");
    });

    it("renders a fenced python block as a read-only card with Copy and Open in Code", async () => {
      const code = "for i in range(3):\n    print('xin chào', i)";
      const onOpenInCode = vi.fn();
      const { props, view } = renderPanel({
        messages: [message(`Thử đoạn này nhé:\n\`\`\`python\n${code}\n\`\`\``)],
        onOpenInCode,
      });

      const card = screen.getByRole("figure", { name: "Đoạn mã Python" });
      const body = card.querySelector("pre code");
      expect(body?.textContent).toBe(code);
      // Read-only: a focusable <pre>, never an editable field.
      expect(card.querySelector("pre")).toHaveAttribute("tabindex", "0");
      expect(within(card).queryByRole("textbox")).toBeNull();
      expect(card.querySelector("[contenteditable]")).toBeNull();
      expect(screen.getByText("Thử đoạn này nhé:")).toBeInTheDocument();
      expect(
        view.container.querySelector(".classroom-chat__bubble"),
      ).toHaveAttribute("data-has-code", "true");

      fireEvent.click(
        within(card).getByRole("button", { name: "Sao chép mã" }),
      );
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(code));
      expect(await screen.findByText("Đã sao chép mã.")).toBeInTheDocument();

      fireEvent.click(
        within(card).getByRole("button", { name: "Mở trong Code" }),
      );
      expect(onOpenInCode).toHaveBeenCalledTimes(1);
      expect(onOpenInCode).toHaveBeenCalledWith({ code, language: "python" });
      // Opening hands the text over only: nothing is sent or posted back.
      expect(props.onSend).not.toHaveBeenCalled();
      view.unmount();

      // Without a Code tool the card still offers Copy, but no Open in Code.
      renderPanel({
        messages: [message(`\`\`\`python\n${code}\n\`\`\``)],
      });
      const plain = screen.getByRole("figure", { name: "Đoạn mã Python" });
      expect(
        within(plain).getByRole("button", { name: "Sao chép mã" }),
      ).toBeInTheDocument();
      expect(
        within(plain).queryByRole("button", { name: "Mở trong Code" }),
      ).toBeNull();
    });

    it("renders HTML payloads inside fences and text as plain text nodes", () => {
      const alertSpy = vi.fn();
      vi.stubGlobal("alert", alertSpy);
      const payload = "<img src=x onerror=alert(1)>";
      const { view } = renderPanel({
        messages: [
          message(
            `<b>đậm</b><script>alert(2)</script>\n\`\`\`html\n${payload}\n\`\`\``,
          ),
        ],
        onOpenInCode: vi.fn(),
      });

      const bubble = view.container.querySelector(
        ".classroom-chat__bubble",
      ) as HTMLElement;
      expect(bubble).not.toBeNull();
      expect(bubble.querySelector("img, script, b, iframe")).toBeNull();
      const card = within(bubble).getByRole("figure", {
        name: "Đoạn mã HTML / CSS / JS",
      });
      const body = card.querySelector("pre code") as HTMLElement;
      expect(body.textContent).toBe(payload);
      expect(
        Array.from(body.childNodes).every(
          (node) => node.nodeType === Node.TEXT_NODE,
        ),
      ).toBe(true);
      expect(
        within(bubble).getByText("<b>đậm</b><script>alert(2)</script>"),
      ).toBeInTheDocument();
      expect(view.container.querySelector("img[onerror]")).toBeNull();
      expect(alertSpy).not.toHaveBeenCalled();
    });

    /** Every child is a text node or a `<span>` holding only text nodes. */
    function onlyTextSpans(body: HTMLElement): boolean {
      return Array.from(body.childNodes).every(
        (node) =>
          node.nodeType === Node.TEXT_NODE ||
          (node instanceof HTMLSpanElement &&
            Array.from(node.childNodes).every(
              (child) => child.nodeType === Node.TEXT_NODE,
            )),
      );
    }

    it("colours a python card lazily with text-node spans and keeps Copy exact (ROOM-TOOLS-CODE-03B)", async () => {
      const code = "# tính tổng\nfor i in range(3):\n    print('xin chào', i)";
      renderPanel({
        messages: [message(`\`\`\`python\n${code}\n\`\`\``)],
        onOpenInCode: vi.fn(),
      });
      const card = screen.getByRole("figure", { name: "Đoạn mã Python" });
      const body = card.querySelector("pre code") as HTMLElement;
      // Plain text first, in the same element (no layout swap).
      expect(body.textContent).toBe(code);
      await waitFor(() =>
        expect(body).toHaveAttribute("data-highlighted", "true"),
      );
      expect(body.textContent).toBe(code);
      expect(onlyTextSpans(body)).toBe(true);
      const keywords = Array.from(
        body.querySelectorAll('span[data-token="keyword"]'),
      ).map((span) => span.textContent);
      expect(keywords).toEqual(expect.arrayContaining(["for", "in"]));
      expect(body.querySelector('span[data-token="string"]')?.textContent).toBe(
        "'xin chào'",
      );
      expect(
        body.querySelector('span[data-token="comment"]')?.textContent,
      ).toBe("# tính tổng");

      fireEvent.click(
        within(card).getByRole("button", { name: "Sao chép mã" }),
      );
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(code));
    });

    it("keeps a highlighted HTML payload inert", async () => {
      const alertSpy = vi.fn();
      vi.stubGlobal("alert", alertSpy);
      const payload =
        '<img src=x onerror=alert(1)><script>alert(2)</script><a href="javascript:alert(3)">x</a>';
      const { view } = renderPanel({
        messages: [message(`\`\`\`html\n${payload}\n\`\`\``)],
      });
      const body = view.container.querySelector(
        ".classroom-chat__code pre code",
      ) as HTMLElement;
      await waitFor(() =>
        expect(body).toHaveAttribute("data-highlighted", "true"),
      );
      expect(body.textContent).toBe(payload);
      expect(onlyTextSpans(body)).toBe(true);
      expect(body.querySelector('span[data-token="tag"]')).not.toBeNull();
      expect(
        view.container.querySelector("img, script, a[href^='javascript']"),
      ).toBeNull();
      expect(alertSpy).not.toHaveBeenCalled();
    });

    it("leaves unknown languages and long blocks as plain text", async () => {
      const long = "x = 1\n".repeat(800);
      const { view } = renderPanel({
        messages: [
          message("```text\nchỉ là chữ\n```"),
          message(`\`\`\`python\n${long}\`\`\``),
        ],
      });
      // Give a lazy load every chance to (wrongly) happen.
      await act(async () => {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
      });
      for (const body of view.container.querySelectorAll(
        ".classroom-chat__code pre code",
      )) {
        expect(body).not.toHaveAttribute("data-highlighted");
        expect(body.querySelector("span")).toBeNull();
      }
    });

    it("prefills the composer from the Code tool without sending or touching the host lock", async () => {
      const fence = "```python\nprint(1)\n```";
      const store = createClassroomChatComposerStore();
      const host = renderPanel({
        composerStore: store,
        conversation: roomConversation(
          { participant_chat_enabled: false },
          { can_moderate_chat: true },
        ),
      });
      const toggle = screen.getByRole("switch", {
        name: "Cho phép người tham gia gửi tin nhắn",
      });
      expect(toggle).toHaveAttribute("aria-checked", "false");

      act(() => prefillClassroomChatComposer(store, fence));
      expect(composer()).toHaveValue(fence);
      await waitFor(() => expect(composer()).toHaveFocus());
      expect(store.focusRequested).toBe(false);
      expect(host.props.onSend).not.toHaveBeenCalled();
      expect(host.props.onToggleParticipantChat).not.toHaveBeenCalled();
      expect(toggle).toHaveAttribute("aria-checked", "false");
      // The teacher still sends deliberately.
      fireEvent.click(screen.getByRole("button", { name: "Gửi" }));
      await waitFor(() => expect(host.props.onSend).toHaveBeenCalledTimes(1));
      expect(vi.mocked(host.props.onSend).mock.calls[0]?.[0].content).toBe(
        fence,
      );
      expect(host.props.onToggleParticipantChat).not.toHaveBeenCalled();
      host.view.unmount();

      // A student whose chat the teacher paused gets no composer at all: the
      // prefilled text waits in the store and is never posted.
      const studentStore = createClassroomChatComposerStore();
      prefillClassroomChatComposer(studentStore, fence);
      const student = renderPanel({
        composerStore: studentStore,
        conversation: roomConversation(
          { participant_chat_enabled: false },
          { can_post_messages: false, can_upload_attachments: false },
        ),
      });
      expect(
        screen.getByText(
          "Giáo viên đã tạm tắt gửi tin nhắn cho người tham gia.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("textbox", { name: "Nội dung tin nhắn" }),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: "Gửi" })).toBeNull();
      expect(screen.queryByRole("switch")).toBeNull();
      act(() => prefillClassroomChatComposer(studentStore, `${fence}\n`));
      expect(student.props.onSend).not.toHaveBeenCalled();
      expect(student.props.onToggleParticipantChat).not.toHaveBeenCalled();
    });
  });
});

describe("classroomChatMedia", () => {
  it("detects jumbo emoji only for 1–3 emoji graphemes", () => {
    expect(isJumboEmoji("🎉")).toBe(true);
    expect(isJumboEmoji("👍🏽 ❤️ 🇻🇳")).toBe(true);
    expect(isJumboEmoji("👨‍👩‍👧‍👦")).toBe(true);
    expect(isJumboEmoji("1️⃣")).toBe(true);
    expect(isJumboEmoji("🎉🎉🎉🎉")).toBe(false);
    expect(isJumboEmoji("ok 🎉")).toBe(false);
    expect(isJumboEmoji("123")).toBe(false);
    expect(isJumboEmoji("")).toBe(false);
  });

  it("links only http(s) URLs and trims trailing punctuation", () => {
    expect(linkifyChatText("Đọc https://a.vn/x, rồi http://b.vn).")).toEqual([
      { kind: "text", text: "Đọc " },
      { href: "https://a.vn/x", kind: "link", text: "https://a.vn/x" },
      { kind: "text", text: ", rồi " },
      { href: "http://b.vn/", kind: "link", text: "http://b.vn" },
      { kind: "text", text: ")." },
    ]);
    expect(linkifyChatText("javascript:alert(1) data:text/html,x")).toEqual([
      { kind: "text", text: "javascript:alert(1) data:text/html,x" },
    ]);
  });

  it("checks MIME, extension and size bounds before upload", () => {
    expect(
      checkChatFile({ name: "a.png", size: 10, type: "image/png" }),
    ).toMatchObject({ kind: "image", ok: true });
    expect(
      checkChatFile({ name: "a.HEIC", size: 10, type: "image/heic" }),
    ).toEqual({ ok: false, problem: "type" });
    expect(
      checkChatFile({ name: "a.svg", size: 10, type: "image/svg+xml" }),
    ).toEqual({ ok: false, problem: "type" });
    expect(checkChatFile({ name: "run.exe", size: 10, type: "" })).toEqual({
      ok: false,
      problem: "type",
    });
    expect(
      checkChatFile({ name: "page.html", size: 10, type: "text/html" }),
    ).toEqual({ ok: false, problem: "type" });
    expect(
      checkChatFile({
        name: "big.png",
        size: 6 * 1024 * 1024,
        type: "image/png",
      }),
    ).toEqual({ ok: false, problem: "size" });
    expect(
      checkChatFile({ name: "deck.pptx", size: 9 * 1024 * 1024, type: "" }),
    ).toMatchObject({ kind: "file", ok: true });
    expect(
      checkChatFile({ name: "deck.pptx", size: 11 * 1024 * 1024, type: "" }),
    ).toEqual({ ok: false, problem: "size" });
  });
});

describe("ROOM-CHAT-EMOJI-02 emoji catalogue", () => {
  const catalog = parseClassroomEmojiCatalog(
    EMOJI_CATALOG_DATA,
    EMOJI_CATALOG_SOURCE,
  );
  const chars = (query: string) =>
    searchClassroomEmoji(catalog, query).map((entry) => entry.char);

  it("ships nine fixed topics of default-tone CLDR emoji with 🇻🇳 leading the flags", () => {
    expect(EMOJI_CATALOG_SOURCE).toBe("emojibase-data@18.0.0");
    expect(catalog.topics.map((topic) => topic.id)).toEqual([
      ...CLASSROOM_EMOJI_TOPICS,
    ]);
    expect(CLASSROOM_EMOJI_TOPICS).toEqual([
      "smileys",
      "people",
      "nature",
      "food",
      "activities",
      "travel",
      "objects",
      "symbols",
      "flags",
    ]);
    expect(catalog.size).toBeGreaterThan(1_200);
    for (const topic of catalog.topics) {
      expect(topic.entries.length).toBeGreaterThan(40);
    }
    const flags = catalog.topics.find((topic) => topic.id === "flags");
    expect(flags?.entries[0]).toMatchObject({
      char: "🇻🇳",
      en: "flag: Vietnam",
      vi: "cờ: Việt Nam",
    });
    const all = catalog.topics.flatMap((topic) => topic.entries);
    expect(new Set(all.map((entry) => entry.char)).size).toBe(all.length);
    // No skin-tone variants or lone components; classroom picks are present.
    expect(all.some((entry) => /\p{Emoji_Modifier}/u.test(entry.char))).toBe(
      false,
    );
    for (const emoji of [
      "👏",
      "❤️",
      "🎓",
      "📚",
      "✏️",
      "💡",
      "✅",
      "➗",
      "⚽",
    ]) {
      expect(catalog.byChar.has(emoji)).toBe(true);
    }
    // The telemetry word gate is enforced by the generator and by
    // scripts/check-calendar-production-gate.mjs over this data file.
  });

  it("searches Vietnamese with or without diacritics and English, names first", () => {
    expect(chars("vo tay")[0]).toBe("👏");
    expect(chars("Vỗ Tay")[0]).toBe("👏");
    expect(chars("trai tim")).toContain("❤️");
    expect(chars("trái tim")).toContain("❤️");
    expect(chars("mu tot nghiep")[0]).toBe("🎓");
    expect(chars("bong da")[0]).toBe("⚽");
    expect(chars("viet nam")[0]).toBe("🇻🇳");
    expect(chars("cuoi").length).toBeGreaterThan(10);
    expect(chars("rocket")[0]).toBe("🚀");
    expect(chars("heart")).toContain("❤️");
    expect(chars("laugh")).toContain("😂");
    expect(chars("divide")).toContain("➗");
    // A name match outranks a tag-only match.
    const laugh = chars("laugh");
    expect(laugh.indexOf("🤣")).toBeGreaterThanOrEqual(0);
    expect(laugh.indexOf("🤣")).toBeLessThan(laugh.indexOf("😀"));
    expect(chars("🎉")).toEqual(["🎉"]);
    expect(chars("zzzz")).toEqual([]);
    expect(normalizeEmojiSearch("Đồng hồ, BÁO thức!")).toBe("dong ho bao thuc");
  });

  it("keeps recent emoji per tenant and user, writing only on a real pick", () => {
    const scope = { actorID, tenantID };
    const storage = window.localStorage;
    storage.clear();
    expect(loadChatEmojiRecents(scope)).toEqual([]);
    expect(storage).toHaveLength(0);

    let recents = recordChatEmojiRecent(scope, [], "👏");
    recents = recordChatEmojiRecent(scope, recents, "❤️");
    recents = recordChatEmojiRecent(scope, recents, "👏");
    expect(recents).toEqual(["👏", "❤️"]);
    expect(chatEmojiRecentKey(scope)).toBe(
      `tutorhub:chat-emoji-recent:v1:${tenantID}:${actorID}`,
    );
    expect(loadChatEmojiRecents(scope)).toEqual(["👏", "❤️"]);
    // Another tenant or user never sees this list.
    expect(loadChatEmojiRecents({ actorID: peerID, tenantID })).toEqual([]);

    for (const emoji of catalog.topics[0]!.entries.slice(0, 40)) {
      recents = recordChatEmojiRecent(scope, recents, emoji.char);
    }
    expect(recents).toHaveLength(CHAT_EMOJI_RECENT_LIMIT);
    expect(recents).toHaveLength(24);

    storage.setItem(chatEmojiRecentKey(scope), '{"bad":true}');
    expect(loadChatEmojiRecents(scope)).toEqual([]);
    storage.setItem(chatEmojiRecentKey(scope), "not json");
    expect(loadChatEmojiRecents(scope)).toEqual([]);
    storage.setItem(
      chatEmojiRecentKey(scope),
      JSON.stringify(["🎉", 7, "x".repeat(64), "🎉"]),
    );
    expect(loadChatEmojiRecents(scope)).toEqual(["🎉"]);
    storage.clear();
  });
});
