import {
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@tutorhub/ui";
import {
  ALargeSmall,
  AlignCenter,
  AlignLeft,
  AlignRight,
  Baseline,
  Bold,
  ChevronDown,
  Italic,
  List,
  ListOrdered,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  Underline,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { useI18n, type TranslationKey } from "../../app/i18n";
import {
  CHAT_COLOR_SWATCHES,
  CHAT_DEFAULT_COLOR_SWATCH,
  CHAT_FONT_SIZE_VALUES,
  type ChatCaretFormat,
  isChatEditorEmpty,
  readChatCaretFormat,
  readChatEditor,
  writeChatEditor,
} from "./chatEditorDom";
import {
  CHAT_TEXT_COLORS,
  type ChatAlign,
  type ChatTextColor,
  type ChatTextSize,
  isChatTextColor,
  isChatTextSize,
  parseChatMarkup,
  serializeChatDocument,
} from "./chatMarkup";
import "./chatFormat.css";

/** Imperative API the composers use for focus, mentions and emoji. */
export interface ChatRichEditorHandle {
  clear(): void;
  focus(options?: { atEnd?: boolean }): void;
  /** Inserts at the caret; `focus: false` keeps focus where it is. */
  insertText(text: string, options?: { focus?: boolean }): void;
}

export interface ChatRichComposerProps {
  ariaDescribedBy?: string;
  ariaInvalid?: boolean;
  ariaLabel: string;
  disabled?: boolean;
  /** The contenteditable element (for focus return and the emoji picker). */
  editorRef: RefObject<HTMLDivElement | null>;
  handleRef?: Ref<ChatRichEditorHandle>;
  id: string;
  /** Markup shown when the editor mounts; later changes are ignored. */
  initialMarkup: string;
  /** Extra class for the portalled menus (theme tokens). */
  menuClassName?: string;
  onChange: (markup: string) => void;
  /** Escape in the editor; return true when handled. */
  onEscape?: () => boolean;
  onPasteFiles?: (files: File[]) => void;
  onSubmit: () => void;
  placeholder: string;
  /** Classroom chat sends on Enter; Messages sends on Ctrl/⌘+Enter. */
  submitOnEnter: boolean;
  toolbarOpen: boolean;
  variant: "conversation" | "classroom";
}

type FormatCommand =
  | "bold"
  | "italic"
  | "underline"
  | "strikeThrough"
  | "insertOrderedList"
  | "insertUnorderedList"
  | "justifyLeft"
  | "justifyCenter"
  | "justifyRight"
  | "insertParagraph"
  | "removeFormat"
  | "undo"
  | "redo";

const DEFAULT_CARET: ChatCaretFormat = {
  align: "left",
  kind: "text",
  style: {},
};

const COLOR_LABEL: Readonly<Record<ChatTextColor, TranslationKey>> = {
  blue: "chatFormat.colorBlue",
  gray: "chatFormat.colorGray",
  green: "chatFormat.colorGreen",
  orange: "chatFormat.colorOrange",
  purple: "chatFormat.colorPurple",
  red: "chatFormat.colorRed",
};

const SIZE_OPTIONS: readonly {
  label: TranslationKey;
  value: ChatTextSize | "normal";
}[] = [
  { label: "chatFormat.sizeSmall", value: "small" },
  { label: "chatFormat.sizeNormal", value: "normal" },
  { label: "chatFormat.sizeLarge", value: "large" },
  { label: "chatFormat.sizeHuge", value: "huge" },
];

const ALIGN_OPTIONS: readonly {
  command: FormatCommand;
  icon: LucideIcon;
  key: string;
  label: TranslationKey;
  value: ChatAlign;
}[] = [
  {
    command: "justifyLeft",
    icon: AlignLeft,
    key: "L",
    label: "chatFormat.alignLeft",
    value: "left",
  },
  {
    command: "justifyCenter",
    icon: AlignCenter,
    key: "E",
    label: "chatFormat.alignCenter",
    value: "center",
  },
  {
    command: "justifyRight",
    icon: AlignRight,
    key: "R",
    label: "chatFormat.alignRight",
    value: "right",
  },
];

function isApplePlatform() {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ?? navigator.platform;
  return /mac|iphone|ipad/i.test(platform);
}

/** Visible and ARIA shortcut text for a modifier chord ("Ctrl+Shift+7"). */
function shortcut(keys: string, shift = false) {
  const apple = isApplePlatform();
  return {
    aria: `${apple ? "Meta" : "Control"}+${shift ? "Shift+" : ""}${keys}`,
    label: `${apple ? "⌘" : "Ctrl"}+${shift ? "Shift+" : ""}${keys}`,
  };
}

/**
 * `document.execCommand` is deprecated but remains the only editing API
 * that keeps the browser's own undo stack; every browser still ships it.
 */
function execute(command: string, value?: string) {
  try {
    return document.execCommand(command, false, value);
  } catch {
    return false;
  }
}

function sameCaret(left: ChatCaretFormat, right: ChatCaretFormat) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function rangeInside(element: HTMLElement, range: Range | null | undefined) {
  return Boolean(range && element.contains(range.commonAncestorContainer));
}

/**
 * MSG-RICH-COMPOSE-01: the "Format text" composer (Gmail compose + Zoom
 * chat). A contenteditable field edited with the browser's own commands,
 * read back into chat markup on every change; an APG toolbar on top. Paste
 * and drop only ever insert plain text.
 */
export function ChatRichComposer({
  ariaDescribedBy,
  ariaInvalid,
  ariaLabel,
  disabled = false,
  editorRef,
  handleRef,
  id,
  initialMarkup,
  menuClassName,
  onChange,
  onEscape,
  onPasteFiles,
  onSubmit,
  placeholder,
  submitOnEnter,
  toolbarOpen,
  variant,
}: ChatRichComposerProps) {
  const { t } = useI18n();
  const savedRange = useRef<Range | null>(null);
  const [initial] = useState(initialMarkup);
  const [empty, setEmpty] = useState(() => initialMarkup.trim().length === 0);
  const [caret, setCaret] = useState<ChatCaretFormat>(DEFAULT_CARET);
  const toolbarID = useId();

  useLayoutEffect(() => {
    const element = editorRef.current;
    if (element) writeChatEditor(element, parseChatMarkup(initial));
  }, [editorRef, initial]);

  useEffect(() => {
    const onSelectionChange = () => {
      const element = editorRef.current;
      const selection = document.getSelection();
      if (!element || !selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (!rangeInside(element, range)) return;
      savedRange.current = range.cloneRange();
      const next = readChatCaretFormat(selection.focusNode, element);
      setCaret((current) => (sameCaret(current, next) ? current : next));
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () =>
      document.removeEventListener("selectionchange", onSelectionChange);
  }, [editorRef]);

  const refreshCaret = () => {
    const element = editorRef.current;
    const selection = document.getSelection();
    if (!element || !selection || selection.rangeCount === 0) return;
    if (!rangeInside(element, selection.getRangeAt(0))) return;
    const next = readChatCaretFormat(selection.focusNode, element);
    setCaret((current) => (sameCaret(current, next) ? current : next));
  };

  const emitChange = () => {
    const element = editorRef.current;
    if (!element) return;
    onChange(serializeChatDocument(readChatEditor(element)));
    setEmpty(isChatEditorEmpty(element));
  };

  const placeCaretAtEnd = (element: HTMLElement) => {
    const selection = document.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    savedRange.current = range.cloneRange();
  };

  /** Focuses the field and puts back the selection the toolbar borrowed. */
  const restoreSelection = () => {
    const element = editorRef.current;
    if (!element) return false;
    const selection = document.getSelection();
    if (!selection) return false;
    // Already editing: the live caret wins over the saved one (selectionchange
    // fires late, so the saved range can trail fast typing).
    if (
      document.activeElement === element &&
      selection.rangeCount > 0 &&
      rangeInside(element, selection.getRangeAt(0))
    ) {
      return true;
    }
    element.focus({ preventScroll: true });
    if (rangeInside(element, savedRange.current)) {
      selection.removeAllRanges();
      selection.addRange(savedRange.current as Range);
    } else if (
      selection.rangeCount === 0 ||
      !rangeInside(element, selection.getRangeAt(0))
    ) {
      placeCaretAtEnd(element);
    }
    return true;
  };

  const runCommand = (
    command: FormatCommand | "fontSize" | "foreColor",
    value?: string,
  ) => {
    if (disabled || !restoreSelection()) return;
    execute("styleWithCSS", "false");
    execute(command, value);
    emitChange();
    refreshCaret();
  };

  /** Inserts text without `execCommand` (focus stays where it is). */
  const insertAtRange = (text: string) => {
    const element = editorRef.current;
    if (!element) return;
    let range = rangeInside(element, savedRange.current)
      ? (savedRange.current as Range)
      : null;
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
    }
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    savedRange.current = range.cloneRange();
    if (document.activeElement === element) {
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  };

  const insertPlainText = (text: string) => {
    const lines = text.replace(/\r\n?/gu, "\n").split("\n");
    lines.forEach((line, index) => {
      if (index > 0 && !execute("insertParagraph")) insertAtRange("\n");
      if (line && !execute("insertText", line)) insertAtRange(line);
    });
  };

  useImperativeHandle(handleRef, () => ({
    clear() {
      const element = editorRef.current;
      if (!element) return;
      element.replaceChildren();
      savedRange.current = null;
      setEmpty(true);
      setCaret(DEFAULT_CARET);
    },
    focus(options) {
      const element = editorRef.current;
      if (!element) return;
      element.focus({ preventScroll: true });
      if (options?.atEnd) placeCaretAtEnd(element);
    },
    insertText(text, options) {
      const element = editorRef.current;
      if (!element || disabled || !text) return;
      if (options?.focus !== false || document.activeElement === element) {
        restoreSelection();
        if (!execute("insertText", text)) insertAtRange(text);
      } else {
        insertAtRange(text);
      }
      emitChange();
    },
  }));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // IME composition (Vietnamese Telex/VNI): never act mid-word.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (event.key === "Enter") {
      if (modifier || (submitOnEnter && !event.shiftKey && !event.altKey)) {
        event.preventDefault();
        onSubmit();
        return;
      }
      if (event.shiftKey) {
        // A new paragraph (or list item) rather than a soft break, so the
        // markup keeps one line per visible line.
        event.preventDefault();
        runCommand("insertParagraph");
      }
      return;
    }
    if (event.key === "Escape") {
      if (onEscape?.()) event.preventDefault();
      return;
    }
    if (event.key === "F10" && event.altKey) {
      event.preventDefault();
      document
        .getElementById(toolbarID)
        ?.querySelector<HTMLElement>('[tabindex="0"]')
        ?.focus();
      return;
    }
    if (!modifier || event.altKey) return;
    let command: FormatCommand | null = null;
    if (!event.shiftKey) {
      const key = event.key.toLowerCase();
      if (key === "b") command = "bold";
      else if (key === "i") command = "italic";
      else if (key === "u") command = "underline";
      else if (key === "\\") command = "removeFormat";
    } else {
      const byCode: Readonly<Record<string, FormatCommand>> = {
        Digit7: "insertOrderedList",
        Digit8: "insertUnorderedList",
        KeyE: "justifyCenter",
        KeyL: "justifyLeft",
        KeyR: "justifyRight",
        KeyX: "strikeThrough",
      };
      command = byCode[event.code] ?? null;
    }
    if (command) {
      event.preventDefault();
      runCommand(command);
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData.files);
    const text = event.clipboardData.getData("text/plain");
    event.preventDefault();
    if (files.length > 0) onPasteFiles?.(files);
    if (text) {
      insertPlainText(text);
      emitChange();
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (Array.from(event.dataTransfer.types).includes("Files")) {
      // Files bubble to the composer's own drop handler (when it has one).
      if (!onPasteFiles) event.preventDefault();
      return;
    }
    event.preventDefault();
    const text = event.dataTransfer.getData("text/plain");
    if (!text) return;
    const caretAt = (
      document as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      }
    ).caretRangeFromPoint?.(event.clientX, event.clientY);
    const element = editorRef.current;
    if (element && caretAt && rangeInside(element, caretAt)) {
      savedRange.current = caretAt;
    }
    restoreSelection();
    insertPlainText(text);
    emitChange();
  };

  return (
    <div
      className="chat-rich"
      data-toolbar={toolbarOpen ? "open" : undefined}
      data-variant={variant}
    >
      {toolbarOpen && (
        <ChatFormatToolbar
          caret={caret}
          disabled={disabled}
          id={toolbarID}
          menuClassName={menuClassName}
          onCommand={runCommand}
          onReturnFocus={() => restoreSelection()}
          t={t}
          variant={variant}
        />
      )}
      <div
        aria-describedby={ariaDescribedBy}
        aria-disabled={disabled || undefined}
        aria-invalid={ariaInvalid || undefined}
        aria-label={ariaLabel}
        aria-multiline="true"
        aria-placeholder={placeholder}
        className="chat-rich__editor"
        contentEditable={!disabled}
        data-empty={empty ? "true" : undefined}
        data-placeholder={placeholder}
        id={id}
        onBlur={() => {
          const selection = document.getSelection();
          const element = editorRef.current;
          if (element && selection && selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            if (rangeInside(element, range))
              savedRange.current = range.cloneRange();
          }
        }}
        onDrop={onDrop}
        onFocus={() => execute("defaultParagraphSeparator", "div")}
        onInput={emitChange}
        onKeyDown={onKeyDown}
        onKeyUp={refreshCaret}
        onMouseUp={refreshCaret}
        onPaste={onPaste}
        ref={editorRef}
        role="textbox"
        suppressContentEditableWarning
        tabIndex={disabled ? -1 : 0}
      />
    </div>
  );
}

type Translate = ReturnType<typeof useI18n>["t"];

function ToolbarButton({
  ariaKeyShortcuts,
  children,
  disabled,
  itemID,
  label,
  onActivate,
  pressed,
  tabIndex,
  tooltip,
}: {
  ariaKeyShortcuts?: string;
  children: ReactNode;
  disabled: boolean;
  itemID: string;
  label: string;
  onActivate: () => void;
  pressed?: boolean;
  tabIndex: number;
  tooltip: string;
}) {
  return (
    <button
      aria-keyshortcuts={ariaKeyShortcuts}
      aria-label={label}
      aria-pressed={pressed}
      className="chat-rich-toolbar__button"
      data-toolbar-item={itemID}
      data-tooltip={tooltip}
      disabled={disabled}
      onClick={onActivate}
      // Keep the editor's focus and selection while clicking.
      onMouseDown={(event) => event.preventDefault()}
      tabIndex={tabIndex}
      type="button"
    >
      {children}
    </button>
  );
}

function ChatFormatToolbar({
  caret,
  disabled,
  id,
  menuClassName,
  onCommand,
  onReturnFocus,
  t,
  variant,
}: {
  caret: ChatCaretFormat;
  disabled: boolean;
  id: string;
  menuClassName?: string;
  onCommand: (
    command: FormatCommand | "fontSize" | "foreColor",
    value?: string,
  ) => void;
  onReturnFocus: () => void;
  t: Translate;
  variant: "conversation" | "classroom";
}) {
  const toolbar = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState("bold");

  // Roving tabindex (APG toolbar): one tab stop, arrows move between items.
  const tabFor = (itemID: string) => (itemID === current ? 0 : -1);

  const visibleItems = () =>
    Array.from(
      toolbar.current?.querySelectorAll<HTMLElement>("[data-toolbar-item]") ??
        [],
    ).filter(
      (item) =>
        !(item as HTMLButtonElement).disabled &&
        window.getComputedStyle(item).display !== "none",
    );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = visibleItems();
    const index = items.findIndex((item) => item === document.activeElement);
    let next: HTMLElement | undefined;
    if (event.key === "ArrowRight") next = items[(index + 1) % items.length];
    else if (event.key === "ArrowLeft")
      next = items[(index - 1 + items.length) % items.length];
    else if (event.key === "Home") next = items[0];
    else if (event.key === "End") next = items[items.length - 1];
    else if (event.key === "Escape") {
      event.preventDefault();
      onReturnFocus();
      return;
    }
    if (!next) return;
    event.preventDefault();
    setCurrent(next.dataset.toolbarItem ?? "bold");
    next.focus();
  };

  const tip = (label: string, keys?: { label: string }) =>
    keys
      ? t("chatFormat.withShortcut", { label, shortcut: keys.label })
      : label;

  const undo = shortcut("Z");
  const redo = isApplePlatform() ? shortcut("Z", true) : shortcut("Y");
  const bold = shortcut("B");
  const italic = shortcut("I");
  const underline = shortcut("U");
  const strike = shortcut("X", true);
  const numbered = shortcut("7", true);
  const bulleted = shortcut("8", true);
  const clear = shortcut("\\");
  const alignOption =
    ALIGN_OPTIONS.find((option) => option.value === caret.align) ??
    ALIGN_OPTIONS[0];
  const AlignIcon = alignOption?.icon ?? AlignLeft;
  const color = caret.style.color;
  const size = caret.style.size ?? "normal";
  const menuClasses = ["chat-format-menu", menuClassName]
    .filter(Boolean)
    .join(" ");
  const menuProps = {
    align: "start" as const,
    className: menuClasses,
    // The room panel is always dark; its portalled menus follow.
    "data-theme": variant === "classroom" ? "dark" : undefined,
    "data-variant": variant,
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault();
      onReturnFocus();
    },
    side: "top" as const,
  };

  return (
    <div
      aria-label={t("chatFormat.toolbar")}
      className="chat-rich-toolbar"
      id={id}
      onFocus={(event) => {
        const itemID = (event.target as HTMLElement).dataset.toolbarItem;
        if (itemID) setCurrent(itemID);
      }}
      onKeyDown={onKeyDown}
      ref={toolbar}
      role="toolbar"
    >
      <span className="chat-rich-toolbar__group chat-rich-toolbar__group--history">
        <ToolbarButton
          ariaKeyShortcuts={undo.aria}
          disabled={disabled}
          itemID="undo"
          tabIndex={tabFor("undo")}
          label={t("chatFormat.undo")}
          onActivate={() => onCommand("undo")}
          tooltip={tip(t("chatFormat.undo"), undo)}
        >
          <Undo2 aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          ariaKeyShortcuts={redo.aria}
          disabled={disabled}
          itemID="redo"
          tabIndex={tabFor("redo")}
          label={t("chatFormat.redo")}
          onActivate={() => onCommand("redo")}
          tooltip={tip(t("chatFormat.redo"), redo)}
        >
          <Redo2 aria-hidden="true" />
        </ToolbarButton>
      </span>
      <span className="chat-rich-toolbar__group">
        <Menu>
          <MenuTrigger asChild disabled={disabled}>
            <button
              aria-label={t("chatFormat.size")}
              className="chat-rich-toolbar__button chat-rich-toolbar__button--menu"
              data-toolbar-item="size"
              data-tooltip={t("chatFormat.size")}
              tabIndex={tabFor("size")}
              type="button"
            >
              <ALargeSmall aria-hidden="true" />
              <ChevronDown
                aria-hidden="true"
                className="chat-rich-toolbar__chevron"
              />
            </button>
          </MenuTrigger>
          <MenuContent {...menuProps}>
            <MenuRadioGroup
              onValueChange={(value) => {
                if (value === "normal" || isChatTextSize(value)) {
                  onCommand("fontSize", CHAT_FONT_SIZE_VALUES[value]);
                }
              }}
              value={size}
            >
              {SIZE_OPTIONS.map((option) => (
                <MenuRadioItem key={option.value} value={option.value}>
                  <span
                    className={`chat-format-menu__size chat-fmt-size--${option.value}`}
                  >
                    {t(option.label)}
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
      </span>
      <span className="chat-rich-toolbar__group">
        <ToolbarButton
          ariaKeyShortcuts={bold.aria}
          disabled={disabled}
          itemID="bold"
          tabIndex={tabFor("bold")}
          label={t("chatFormat.bold")}
          onActivate={() => onCommand("bold")}
          pressed={caret.style.bold === true}
          tooltip={tip(t("chatFormat.bold"), bold)}
        >
          <Bold aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          ariaKeyShortcuts={italic.aria}
          disabled={disabled}
          itemID="italic"
          tabIndex={tabFor("italic")}
          label={t("chatFormat.italic")}
          onActivate={() => onCommand("italic")}
          pressed={caret.style.italic === true}
          tooltip={tip(t("chatFormat.italic"), italic)}
        >
          <Italic aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          ariaKeyShortcuts={underline.aria}
          disabled={disabled}
          itemID="underline"
          tabIndex={tabFor("underline")}
          label={t("chatFormat.underline")}
          onActivate={() => onCommand("underline")}
          pressed={caret.style.underline === true}
          tooltip={tip(t("chatFormat.underline"), underline)}
        >
          <Underline aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          ariaKeyShortcuts={strike.aria}
          disabled={disabled}
          itemID="strike"
          tabIndex={tabFor("strike")}
          label={t("chatFormat.strike")}
          onActivate={() => onCommand("strikeThrough")}
          pressed={caret.style.strike === true}
          tooltip={tip(t("chatFormat.strike"), strike)}
        >
          <Strikethrough aria-hidden="true" />
        </ToolbarButton>
        <Menu>
          <MenuTrigger asChild disabled={disabled}>
            <button
              aria-label={t("chatFormat.color")}
              className="chat-rich-toolbar__button chat-rich-toolbar__button--menu"
              data-toolbar-item="color"
              data-tooltip={t("chatFormat.color")}
              tabIndex={tabFor("color")}
              type="button"
            >
              <span className="chat-rich-toolbar__color" data-color={color}>
                <Baseline aria-hidden="true" />
              </span>
              <ChevronDown
                aria-hidden="true"
                className="chat-rich-toolbar__chevron"
              />
            </button>
          </MenuTrigger>
          <MenuContent {...menuProps}>
            <MenuRadioGroup
              onValueChange={(value) =>
                onCommand(
                  "foreColor",
                  isChatTextColor(value)
                    ? CHAT_COLOR_SWATCHES[value]
                    : CHAT_DEFAULT_COLOR_SWATCH,
                )
              }
              value={color ?? "default"}
            >
              <MenuRadioItem value="default">
                <span aria-hidden="true" className="chat-format-menu__swatch" />
                {t("chatFormat.colorDefault")}
              </MenuRadioItem>
              {CHAT_TEXT_COLORS.map((name) => (
                <MenuRadioItem key={name} value={name}>
                  <span
                    aria-hidden="true"
                    className="chat-format-menu__swatch"
                    data-color={name}
                  />
                  {t(COLOR_LABEL[name])}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
      </span>
      <span className="chat-rich-toolbar__group">
        <Menu>
          <MenuTrigger asChild disabled={disabled}>
            <button
              aria-label={t("chatFormat.align")}
              className="chat-rich-toolbar__button chat-rich-toolbar__button--menu"
              data-toolbar-item="align"
              data-tooltip={t("chatFormat.align")}
              tabIndex={tabFor("align")}
              type="button"
            >
              <AlignIcon aria-hidden="true" />
              <ChevronDown
                aria-hidden="true"
                className="chat-rich-toolbar__chevron"
              />
            </button>
          </MenuTrigger>
          <MenuContent {...menuProps}>
            <MenuRadioGroup
              onValueChange={(value) => {
                const option = ALIGN_OPTIONS.find(
                  (item) => item.value === value,
                );
                if (option) onCommand(option.command);
              }}
              value={caret.align}
            >
              {ALIGN_OPTIONS.map((option) => {
                const Icon = option.icon;
                return (
                  <MenuRadioItem key={option.value} value={option.value}>
                    <Icon
                      aria-hidden="true"
                      className="chat-format-menu__icon"
                    />
                    <span className="chat-format-menu__label">
                      {t(option.label)}
                    </span>
                    <span className="chat-format-menu__shortcut">
                      {shortcut(option.key, true).label}
                    </span>
                  </MenuRadioItem>
                );
              })}
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
        <ToolbarButton
          ariaKeyShortcuts={numbered.aria}
          disabled={disabled}
          itemID="numbered"
          tabIndex={tabFor("numbered")}
          label={t("chatFormat.numbered")}
          onActivate={() => onCommand("insertOrderedList")}
          pressed={caret.kind === "number"}
          tooltip={tip(t("chatFormat.numbered"), numbered)}
        >
          <ListOrdered aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          ariaKeyShortcuts={bulleted.aria}
          disabled={disabled}
          itemID="bulleted"
          tabIndex={tabFor("bulleted")}
          label={t("chatFormat.bulleted")}
          onActivate={() => onCommand("insertUnorderedList")}
          pressed={caret.kind === "bullet"}
          tooltip={tip(t("chatFormat.bulleted"), bulleted)}
        >
          <List aria-hidden="true" />
        </ToolbarButton>
      </span>
      <span className="chat-rich-toolbar__group">
        <ToolbarButton
          ariaKeyShortcuts={clear.aria}
          disabled={disabled}
          itemID="clear"
          tabIndex={tabFor("clear")}
          label={t("chatFormat.clear")}
          onActivate={() => onCommand("removeFormat")}
          tooltip={tip(t("chatFormat.clear"), clear)}
        >
          <RemoveFormatting aria-hidden="true" />
        </ToolbarButton>
      </span>
    </div>
  );
}
