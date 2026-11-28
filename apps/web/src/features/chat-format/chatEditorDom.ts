/**
 * MSG-RICH-COMPOSE-01: reads and writes the rich composer's contenteditable
 * DOM as a `ChatDocument`. The browser's own editing commands produce the
 * DOM (`<b>`, `<i>`, `<u>`, `<strike>`, `<font color|size>`, lists and
 * `text-align`); only what the markup can carry is read back, so anything
 * else (images, tables, scripts, foreign styles) is dropped as plain text.
 */
import {
  CHAT_TEXT_COLORS,
  type ChatAlign,
  type ChatDocument,
  type ChatInlineStyle,
  type ChatLine,
  type ChatLineKind,
  type ChatTextColor,
  type ChatTextSize,
  cleanChatStyle,
  normalizeChatDocument,
  tidyChatRunEdges,
} from "./chatMarkup";

/** Colours the editor applies with `foreColor` (Gmail-like swatches). */
export const CHAT_COLOR_SWATCHES: Readonly<Record<ChatTextColor, string>> = {
  blue: "#1a73e8",
  gray: "#5f6368",
  green: "#188038",
  orange: "#e8710a",
  purple: "#9334e6",
  red: "#d93025",
};

/** Applied to clear a colour; read back as "no colour". */
export const CHAT_DEFAULT_COLOR_SWATCH = "#010203";

/** `fontSize` command values (1–7 scale) for each size step. */
export const CHAT_FONT_SIZE_VALUES: Readonly<
  Record<ChatTextSize | "normal", string>
> = {
  huge: "6",
  large: "5",
  normal: "3",
  small: "2",
};

export interface ChatCaretFormat {
  align: ChatAlign;
  kind: ChatLineKind;
  style: ChatInlineStyle;
}

const BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DD",
  "DIV",
  "DL",
  "DT",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);
const SKIPPED_TAGS = new Set([
  "AUDIO",
  "CANVAS",
  "EMBED",
  "IFRAME",
  "IMG",
  "NOSCRIPT",
  "OBJECT",
  "SCRIPT",
  "STYLE",
  "SVG",
  "TEMPLATE",
  "VIDEO",
]);
/** Caret placeholders only; ZWJ/ZWNJ stay (emoji sequences, scripts). */
const INVISIBLE = /[\u200b\ufeff]/gu;
/** CSS-wide keywords that keep the parent's value. */
const INHERITED_KEYWORDS = new Set([
  "inherit",
  "unset",
  "revert",
  "revert-layer",
  "inherit inherit",
  "unset unset",
]);

function toHex(channel: number) {
  return Math.max(0, Math.min(255, Math.round(channel)))
    .toString(16)
    .padStart(2, "0");
}

/** `#rgb`, `#rrggbb` or `rgb()/rgba()` → `#rrggbb`, else null. */
export function normalizeCssColor(value: string | null | undefined) {
  const source = value?.trim().toLowerCase() ?? "";
  if (!source) return null;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/u.exec(source);
  if (short) {
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  }
  if (/^#[0-9a-f]{6}$/u.test(source)) return source;
  const rgb =
    /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+[\d.]+%?)?\s*\)$/u.exec(
      source,
    );
  if (rgb) {
    return `#${toHex(Number(rgb[1]))}${toHex(Number(rgb[2]))}${toHex(Number(rgb[3]))}`;
  }
  return null;
}

const colorByHex = new Map<string, ChatTextColor>(
  CHAT_TEXT_COLORS.map((color) => [CHAT_COLOR_SWATCHES[color], color]),
);

function colorFromCss(value: string | null | undefined) {
  const hex = normalizeCssColor(value);
  return hex ? colorByHex.get(hex) : undefined;
}

function sizeFromFontAttribute(value: string | null) {
  const level = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(level)) return null;
  if (level <= 2) return "small" as const;
  if (level === 3) return "normal" as const;
  if (level <= 5) return "large" as const;
  return "huge" as const;
}

function sizeFromCss(value: string) {
  const size = value.trim().toLowerCase();
  if (!size) return null;
  if (["xx-small", "x-small", "small", "smaller"].includes(size))
    return "small";
  if (size === "medium") return "normal";
  if (["large", "x-large", "larger"].includes(size)) return "large";
  if (["xx-large", "xxx-large"].includes(size)) return "huge";
  return null;
}

function alignFromElement(element: HTMLElement): ChatAlign | null {
  const value = (
    element.style.textAlign ||
    element.getAttribute("align") ||
    ""
  ).toLowerCase();
  if (!value) return null;
  if (value === "center") return "center";
  if (value === "right" || value === "end") return "right";
  return "left";
}

/** The element's own contribution on top of an inherited style. */
function applyElementStyle(
  element: HTMLElement,
  inherited: ChatInlineStyle,
): ChatInlineStyle {
  const style: ChatInlineStyle = { ...inherited };
  const tag = element.tagName;
  if (tag === "B" || tag === "STRONG") style.bold = true;
  if (tag === "I" || tag === "EM") style.italic = true;
  if (tag === "U" || tag === "INS") style.underline = true;
  if (tag === "S" || tag === "STRIKE" || tag === "DEL") style.strike = true;
  if (tag === "FONT") {
    if (element.hasAttribute("color")) {
      style.color = colorFromCss(element.getAttribute("color"));
    }
    const size = sizeFromFontAttribute(element.getAttribute("size"));
    if (size) style.size = size === "normal" ? undefined : size;
  }
  const css = element.style;
  // Chrome's justify/list commands wrap runs in `font-weight: inherit` etc.;
  // only concrete values change the style.
  const own = (value: string) => {
    const normalized = value.trim().toLowerCase();
    return INHERITED_KEYWORDS.has(normalized) ? "" : normalized;
  };
  const weight = own(css.fontWeight);
  if (weight) {
    const numeric = Number.parseInt(weight, 10);
    style.bold =
      weight === "bold" ||
      weight === "bolder" ||
      (Number.isFinite(numeric) && numeric >= 600);
  }
  const fontStyle = own(css.fontStyle);
  if (fontStyle)
    style.italic = fontStyle === "italic" || fontStyle === "oblique";
  const decoration = own(
    `${css.textDecorationLine} ${css.textDecoration}`.trim(),
  );
  if (decoration) {
    if (decoration.includes("none")) {
      style.underline = false;
      style.strike = false;
    }
    if (decoration.includes("underline")) style.underline = true;
    if (decoration.includes("line-through")) style.strike = true;
  }
  const color = own(css.color);
  if (color && color !== "currentcolor") {
    style.color = colorFromCss(color);
  }
  const size = sizeFromCss(own(css.fontSize));
  if (size) style.size = size === "normal" ? undefined : size;
  return style;
}

interface ReadContext {
  align: ChatAlign;
  kind: ChatLineKind;
  list: { kind: "bullet" | "number"; counter: number } | null;
  style: ChatInlineStyle;
}

interface LineDraft extends ChatLine {
  hasContent: boolean;
}

/** Reads the editor's DOM as a canonical chat document. */
export function readChatEditor(root: HTMLElement): ChatDocument {
  const lines: ChatLine[] = [];
  let current: LineDraft | null = null;

  const startLine = (context: ReadContext, ordinal = 0): LineDraft => ({
    align: context.align,
    hasContent: false,
    kind: context.kind,
    ordinal,
    runs: [],
  });
  const commit = () => {
    const line: LineDraft | null = current;
    if (line) {
      lines.push({
        align: line.align,
        kind: line.kind,
        ordinal: line.ordinal,
        runs: tidyChatRunEdges(line.runs),
      });
    }
    current = null;
  };

  const walk = (node: Node, context: ReadContext) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.nodeValue ?? "")
        .replace(INVISIBLE, "")
        .replace(/\u00a0/gu, " ")
        .replace(/[\r\n\t]+/gu, " ");
      if (!text) return;
      current ??= startLine(context);
      current.hasContent = true;
      current.runs.push({ style: cleanChatStyle(context.style), text });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as HTMLElement;
    const tag = element.tagName.toUpperCase();
    if (SKIPPED_TAGS.has(tag)) return;
    if (tag === "BR") {
      // A break ends the line (an empty one when nothing preceded it).
      current ??= startLine(context);
      commit();
      return;
    }
    const next: ReadContext = {
      ...context,
      align: alignFromElement(element) ?? context.align,
      style: applyElementStyle(element, context.style),
    };
    if (tag === "UL" || tag === "OL") {
      const start = Number.parseInt(element.getAttribute("start") ?? "1", 10);
      next.list =
        tag === "UL"
          ? { counter: 0, kind: "bullet" }
          : { counter: Number.isFinite(start) ? start : 1, kind: "number" };
      next.kind = next.list.kind;
    }
    if (!BLOCK_TAGS.has(tag)) {
      for (const child of Array.from(element.childNodes)) walk(child, next);
      return;
    }
    let ordinal = 0;
    if (tag === "LI") {
      const list = context.list ?? { counter: 0, kind: "bullet" as const };
      next.kind = list.kind;
      if (list.kind === "number") {
        ordinal = list.counter;
        list.counter += 1;
      }
    }
    // A block starts a fresh line; an empty pending line is replaced.
    if (current?.hasContent) commit();
    current = startLine(next, ordinal);
    for (const child of Array.from(element.childNodes)) walk(child, next);
    commit();
  };

  const rootContext: ReadContext = {
    align: "left",
    kind: "text",
    list: null,
    style: {},
  };
  for (const child of Array.from(root.childNodes)) walk(child, rootContext);
  commit();
  return normalizeChatDocument({ lines });
}

/** Style, line kind and alignment at a DOM position inside the editor. */
export function readChatCaretFormat(
  node: Node | null,
  root: HTMLElement,
): ChatCaretFormat {
  const chain: HTMLElement[] = [];
  let cursor: Node | null = node;
  while (cursor && cursor !== root) {
    if (cursor.nodeType === Node.ELEMENT_NODE)
      chain.unshift(cursor as HTMLElement);
    cursor = cursor.parentNode;
  }
  let style: ChatInlineStyle = {};
  let align: ChatAlign = "left";
  let kind: ChatLineKind = "text";
  for (const element of chain) {
    style = applyElementStyle(element, style);
    align = alignFromElement(element) ?? align;
    const tag = element.tagName.toUpperCase();
    if (tag === "UL") kind = "bullet";
    if (tag === "OL") kind = "number";
  }
  return { align, kind, style: cleanChatStyle(style) };
}

function runNode(
  ownerDocument: Document,
  text: string,
  style: ChatInlineStyle,
): Node {
  let node: Node = ownerDocument.createTextNode(text);
  const wrap = (tag: string) => {
    const element = ownerDocument.createElement(tag);
    element.append(node);
    node = element;
    return element;
  };
  if (style.italic) wrap("i");
  if (style.bold) wrap("b");
  if (style.underline) wrap("u");
  if (style.strike) wrap("strike");
  if (style.color || style.size) {
    const font = wrap("font");
    if (style.color)
      font.setAttribute("color", CHAT_COLOR_SWATCHES[style.color]);
    if (style.size)
      font.setAttribute("size", CHAT_FONT_SIZE_VALUES[style.size]);
  }
  return node;
}

function lineElement(ownerDocument: Document, tag: string, line: ChatLine) {
  const element = ownerDocument.createElement(tag);
  if (line.align !== "left") element.style.textAlign = line.align;
  if (line.runs.length === 0) {
    element.append(ownerDocument.createElement("br"));
  }
  for (const run of line.runs) {
    element.append(runNode(ownerDocument, run.text, run.style));
  }
  return element;
}

/** Replaces the editor's content with the document (no HTML parsing). */
export function writeChatEditor(root: HTMLElement, document: ChatDocument) {
  const ownerDocument = root.ownerDocument;
  const { lines } = normalizeChatDocument(document);
  const nodes: Node[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as ChatLine;
    if (line.kind === "text") {
      nodes.push(lineElement(ownerDocument, "div", line));
      index += 1;
      continue;
    }
    const list = ownerDocument.createElement(
      line.kind === "bullet" ? "ul" : "ol",
    );
    if (line.kind === "number" && line.ordinal !== 1) {
      list.setAttribute("start", String(line.ordinal));
    }
    while (
      index < lines.length &&
      lines[index]?.kind === line.kind &&
      lines[index]?.align === line.align
    ) {
      list.append(lineElement(ownerDocument, "li", lines[index] as ChatLine));
      index += 1;
    }
    nodes.push(list);
  }
  root.replaceChildren(...nodes);
}

/** True when the editor shows nothing (no text and no list items). */
export function isChatEditorEmpty(root: HTMLElement) {
  return (
    (root.textContent ?? "").replace(INVISIBLE, "").length === 0 &&
    root.querySelector("li") === null
  );
}
