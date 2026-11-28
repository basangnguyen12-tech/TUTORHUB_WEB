import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../app/i18n";
import {
  CHAT_COLOR_SWATCHES,
  readChatCaretFormat,
  readChatEditor,
  writeChatEditor,
} from "./chatEditorDom";
import { ChatFormattedText } from "./ChatFormattedText";
import { parseChatMarkup, serializeChatDocument } from "./chatMarkup";
import {
  ChatRichComposer,
  type ChatRichEditorHandle,
} from "./ChatRichComposer";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // Drop the per-test stub so jsdom's own (unimplemented) command returns.
  Reflect.deleteProperty(document, "execCommand");
});

function editorFrom(html: string) {
  const root = document.createElement("div");
  // Test fixture only: mirrors DOM the browser's editing commands produce.
  root.innerHTML = html;
  return root;
}

describe("chat editor DOM", () => {
  it("reads browser editing markup as lines, lists, styles and alignment", () => {
    const root = editorFrom(
      [
        "Hạn nộp <b>thứ Sáu</b>",
        "<div><br></div>",
        '<div style="text-align: center;"><font color="#d93025" size="5">Chúc mừng</font></div>',
        "<ul><li><i>một</i></li><li><u>hai</u></li></ul>",
        '<ol start="3"><li><strike>ba</strike></li><li>bốn</li></ol>',
        '<div><b>đậm <span style="font-weight: normal;">thường</span></b></div>',
      ].join(""),
    );
    expect(serializeChatDocument(readChatEditor(root))).toBe(
      [
        "Hạn nộp **thứ Sáu**",
        "",
        "::: center",
        "[Chúc mừng]{.red .large}",
        ":::",
        "- *một*",
        "- [hai]{.underline}",
        "3. ~~ba~~",
        "4. bốn",
        "**đậm** thường",
      ].join("\n"),
    );
  });

  it("keeps inherited styles through Chrome's `inherit` wrapper spans", () => {
    const root = editorFrom(
      '<div style="text-align: center;"><i><span style="font-style: inherit; font-weight: inherit;">nghiêng</span></i> <b style="font-style: inherit;">đậm</b></div>',
    );
    expect(serializeChatDocument(readChatEditor(root))).toBe(
      "::: center\n*nghiêng* **đậm**\n:::",
    );
  });

  it("drops images, scripts and unknown colours and keeps their text", () => {
    const root = editorFrom(
      '<div>xin <img src="x" alt="ảnh"><font color="#123456">chào</font><script>alert(1)</script></div>',
    );
    expect(serializeChatDocument(readChatEditor(root))).toBe("xin chào");
  });

  it("writes a document back as the same editable DOM", () => {
    const markup =
      "::: right\n**Thầy** [Lan]{.blue}\n:::\n1. *bài 1*\n2. bài 2\n\n- ~~nháp~~";
    const root = document.createElement("div");
    writeChatEditor(root, parseChatMarkup(markup));
    expect(serializeChatDocument(readChatEditor(root))).toBe(markup);
    expect(root.querySelector("font")?.getAttribute("color")).toBe(
      CHAT_COLOR_SWATCHES.blue,
    );
  });

  it("reports the caret's style, list and alignment for the toolbar", () => {
    const root = editorFrom(
      '<ul><li style="text-align: right;"><b><i>x</i></b></li></ul>',
    );
    const text = root.querySelector("i")?.firstChild ?? null;
    expect(readChatCaretFormat(text, root)).toEqual({
      align: "right",
      kind: "bullet",
      style: { bold: true, italic: true },
    });
  });
});

describe("ChatFormattedText", () => {
  it("keeps plain text as a single text node", () => {
    render(
      <ChatFormattedText
        className="body"
        mentionClassName="mention"
        mentions={[]}
        text={"2*3*4 = 24\nhết"}
      />,
    );
    const body = document.querySelector("p.body");
    expect(body?.childNodes).toHaveLength(1);
    expect(body?.textContent).toBe("2*3*4 = 24\nhết");
  });

  it("renders formatting as elements, never as HTML", () => {
    render(
      <ChatFormattedText
        className="body"
        mentionClassName="mention"
        mentions={["An"]}
        text={
          "::: center\n**Thông báo** cho @An\n:::\n- [Thứ Sáu]{.red .huge}\n2. <img src=x onerror=alert(1)>"
        }
      />,
    );
    const body = document.querySelector("div.body.chat-fmt") as HTMLElement;
    expect(
      body.querySelector('[data-align="center"] strong'),
    ).toHaveTextContent("Thông báo");
    expect(body.querySelector(".mention")).toHaveTextContent("@An");
    expect(
      body.querySelector("ul li .chat-fmt-color--red.chat-fmt-size--huge"),
    ).toHaveTextContent("Thứ Sáu");
    expect(body.querySelector("ol")).toHaveAttribute("start", "2");
    expect(body.querySelector("img")).toBeNull();
    expect(body.querySelector("ol li")).toHaveTextContent(
      "<img src=x onerror=alert(1)>",
    );
  });
});

function renderComposer(
  overrides: Partial<Parameters<typeof ChatRichComposer>[0]> = {},
) {
  const editorRef = createRef<HTMLDivElement>();
  const handleRef = createRef<ChatRichEditorHandle>();
  const onChange = vi.fn();
  const onSubmit = vi.fn();
  render(
    <I18nProvider initialLanguage="en">
      <ChatRichComposer
        ariaLabel="New message"
        editorRef={editorRef}
        handleRef={handleRef}
        id="composer"
        initialMarkup="**Xin** chào"
        onChange={onChange}
        onSubmit={onSubmit}
        placeholder="Write a message"
        submitOnEnter={false}
        toolbarOpen
        variant="conversation"
        {...overrides}
      />
    </I18nProvider>,
  );
  const editor = screen.getByRole("textbox", { name: "New message" });
  return { editor, handleRef, onChange, onSubmit };
}

function stubExecCommand() {
  const execCommand = vi.fn(() => true);
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: execCommand,
    writable: true,
  });
  return execCommand;
}

describe("ChatRichComposer", () => {
  it("seeds the editor and emits markup as the DOM changes", () => {
    const { editor, onChange } = renderComposer();
    expect(editor).toHaveAttribute("contenteditable", "true");
    expect(editor).toHaveAttribute("aria-multiline", "true");
    expect(editor.querySelector("b")).toHaveTextContent("Xin");

    // Test fixture only: what typing an italic word produces.
    editor.innerHTML = "<div><b>Xin</b> chào <i>cả lớp</i></div>";
    fireEvent.input(editor);
    expect(onChange).toHaveBeenLastCalledWith("**Xin** chào *cả lớp*");
  });

  it("is an APG toolbar with one tab stop, arrow keys and pressed states", () => {
    renderComposer();
    const toolbar = screen.getByRole("toolbar", { name: "Text formatting" });
    const bold = screen.getByRole("button", { name: "Bold" });
    expect(bold).toHaveAttribute("tabindex", "0");
    expect(bold).toHaveAttribute("aria-pressed", "false");
    expect(bold).toHaveAttribute("aria-keyshortcuts", "Control+B");
    expect(
      toolbar.querySelectorAll('[data-toolbar-item][tabindex="0"]'),
    ).toHaveLength(1);

    bold.focus();
    fireEvent.keyDown(toolbar, { key: "ArrowRight" });
    const italic = screen.getByRole("button", { name: "Italic" });
    expect(italic).toHaveFocus();
    expect(italic).toHaveAttribute("tabindex", "0");
    expect(bold).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(toolbar, { key: "Home" });
    expect(screen.getByRole("button", { name: "Undo" })).toHaveFocus();
    fireEvent.keyDown(toolbar, { key: "End" });
    expect(
      screen.getByRole("button", { name: "Remove formatting" }),
    ).toHaveFocus();
    for (const name of ["Text size", "Text color", "Align"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute(
        "aria-haspopup",
        "menu",
      );
    }
  });

  it("runs editing commands from the toolbar and Gmail shortcuts", () => {
    const execCommand = stubExecCommand();
    const { editor } = renderComposer();
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    expect(execCommand).toHaveBeenCalledWith("bold", false, undefined);
    fireEvent.click(screen.getByRole("button", { name: "Numbered list" }));
    expect(execCommand).toHaveBeenCalledWith(
      "insertOrderedList",
      false,
      undefined,
    );
    fireEvent.keyDown(editor, { ctrlKey: true, key: "u" });
    expect(execCommand).toHaveBeenCalledWith("underline", false, undefined);
    fireEvent.keyDown(editor, {
      code: "KeyE",
      ctrlKey: true,
      key: "E",
      shiftKey: true,
    });
    expect(execCommand).toHaveBeenCalledWith("justifyCenter", false, undefined);
    expect(editor).toHaveFocus();
  });

  it("sends on Ctrl+Enter, or on Enter where the composer asks for it", () => {
    const first = renderComposer();
    fireEvent.keyDown(first.editor, { key: "Enter" });
    expect(first.onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(first.editor, { ctrlKey: true, key: "Enter" });
    expect(first.onSubmit).toHaveBeenCalledTimes(1);
    cleanup();

    const room = renderComposer({ submitOnEnter: true, variant: "classroom" });
    fireEvent.keyDown(room.editor, { isComposing: true, key: "Enter" });
    expect(room.onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(room.editor, { key: "Enter" });
    expect(room.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("pastes plain text only and hands pasted files to the composer", () => {
    const onPasteFiles = vi.fn();
    const { editor, onChange } = renderComposer({
      initialMarkup: "",
      onPasteFiles,
    });
    const file = new File(["x"], "a.png", { type: "image/png" });
    fireEvent.paste(editor, {
      clipboardData: {
        files: [file],
        getData: (type: string) =>
          type === "text/plain" ? "**literal**" : "<b>rich</b>",
      },
    });
    expect(onPasteFiles).toHaveBeenCalledWith([file]);
    expect(editor.querySelector("b")).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith("\\*\\*literal\\*\\*");
  });

  it("inserts mentions and emoji, and clears after sending", () => {
    const { editor, handleRef, onChange } = renderComposer({
      initialMarkup: "",
    });
    handleRef.current?.insertText("@An ", { focus: false });
    expect(editor).toHaveTextContent("@An");
    expect(onChange).toHaveBeenLastCalledWith("@An ");
    handleRef.current?.clear();
    expect(editor).toBeEmptyDOMElement();
    expect(editor).toHaveAttribute("data-empty", "true");
  });
});
