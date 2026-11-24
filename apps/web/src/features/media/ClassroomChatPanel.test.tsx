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
  checkChatFile,
  createAttachmentObjectURLCache,
  createClassroomChatComposerStore,
  isJumboEmoji,
  linkifyChatText,
  searchClassroomEmoji,
} from "./classroomChatMedia";

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
  beforeEach(() => {
    let counter = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    URL.createObjectURL = vi.fn(() => `blob:chat-${(counter += 1)}`);
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
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

  it("inserts an emoji at the caret from the searchable picker", async () => {
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
    expect(within(picker).getAllByRole("tab")).toHaveLength(4);
    expect(
      within(picker).getByRole("tab", { name: "Lớp học & Hay dùng" }),
    ).toHaveAttribute("aria-selected", "true");

    fireEvent.change(
      within(picker).getByRole("searchbox", { name: "Tìm biểu tượng cảm xúc" }),
      { target: { value: "vo tay" } },
    );
    fireEvent.click(
      within(picker).getByRole("button", { name: "vỗ tay hoan hô" }),
    );
    expect(textbox).toHaveValue("a👏b");
    expect(
      screen.queryByRole("dialog", { name: "Chọn biểu tượng cảm xúc" }),
    ).toBeNull();

    // Keyboard: arrows rove, Escape closes and returns focus.
    fireEvent.click(trigger);
    const reopened = screen.getByRole("dialog", {
      name: "Chọn biểu tượng cảm xúc",
    });
    fireEvent.click(within(reopened).getByRole("tab", { name: "Mặt cười" }));
    const first = within(reopened).getByRole("button", { name: "cười tươi" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(
      within(reopened).getByRole("button", { name: "cười lớn" }),
    ).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: "Chọn biểu tượng cảm xúc" }),
    ).toBeNull();
    expect(trigger).toHaveFocus();
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

  it("searches emoji in Vietnamese without diacritics and in English", () => {
    expect(searchClassroomEmoji("vo tay").map((entry) => entry.char)).toContain(
      "👏",
    );
    expect(searchClassroomEmoji("divide").map((entry) => entry.char)).toContain(
      "➗",
    );
    expect(searchClassroomEmoji("zzzz")).toEqual([]);
  });
});
