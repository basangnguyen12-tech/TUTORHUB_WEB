/**
 * MSG-RICH-COMPOSE-01: formatted chat messages without a schema change.
 *
 * Formatting travels inside the plain `content` string as a small,
 * Markdown-compatible markup (the same approach as reply quotes, see
 * `ConversationQuote.ts`), so notifications and older clients still read
 * ordinary text:
 *
 *     **bold**   *italic*   ~~strike~~
 *     [text]{.underline}        explicit span: .bold .italic .underline
 *     [text]{.red .large}       .strike, one colour and one size
 *     - item                    bulleted list line
 *     1. item                   numbered list line
 *     ::: center                aligned block (left | center | right) …
 *     :::                       … closed by a bare fence line
 *     \*  \~  \[  \]  \\        literal markup characters
 *
 * Delimiters only open after a non-letter and close before one, so "2*3*4"
 * and URLs stay literal. Underline has no bare delimiter, so Python dunders
 * (`__init__`) stay literal too, and ``` code fences are never formatted.
 * Unknown span classes, unclosed fences and unmatched delimiters read as
 * plain text. Nothing here produces HTML: the renderer builds React
 * elements from the parsed document.
 */

export const CHAT_TEXT_COLORS = [
  "red",
  "orange",
  "green",
  "blue",
  "purple",
  "gray",
] as const;
export type ChatTextColor = (typeof CHAT_TEXT_COLORS)[number];

export const CHAT_TEXT_SIZES = ["small", "large", "huge"] as const;
export type ChatTextSize = (typeof CHAT_TEXT_SIZES)[number];

export const CHAT_ALIGNMENTS = ["left", "center", "right"] as const;
export type ChatAlign = (typeof CHAT_ALIGNMENTS)[number];

export type ChatLineKind = "text" | "bullet" | "number";

export interface ChatInlineStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: ChatTextColor;
  size?: ChatTextSize;
}

export interface ChatRun {
  text: string;
  style: ChatInlineStyle;
}

export interface ChatLine {
  kind: ChatLineKind;
  align: ChatAlign;
  /** Item number for `kind: "number"`, otherwise 0. */
  ordinal: number;
  runs: ChatRun[];
}

export interface ChatDocument {
  lines: ChatLine[];
}

type MarkFlag = "bold" | "italic" | "underline" | "strike";

const MAX_INLINE_DEPTH = 6;
const MAX_ORDINAL = 999_999_999;
const ESCAPABLE = new Set(["\\", "*", "~", "[", "]"]);
const DELIMITERS: Readonly<
  Record<string, readonly (readonly [string, MarkFlag])[]>
> = {
  "*": [
    ["**", "bold"],
    ["*", "italic"],
  ],
  "~": [["~~", "strike"]],
};
/** Underline is span-only (`[x]{.underline}`). */
const DELIMITER_OF: Readonly<Partial<Record<MarkFlag, string>>> = {
  bold: "**",
  italic: "*",
  strike: "~~",
};
/** Outer → inner nesting used when the serializer opens marks. */
const MARK_ORDER: readonly MarkFlag[] = [
  "strike",
  "underline",
  "bold",
  "italic",
];

const wordCharacter = /[\p{L}\p{M}\p{N}]/u;
const whitespace = /\s/u;
/** URLs stay literal; a backslash or bracket ends one so escapes and
 * spans right after a link keep working. */
const urlAtPosition = /https?:\/\/[^\s<>"'\\[\]]+/uy;
const fenceOpen = /^:::[ \t]*(left|center|right)[ \t]*$/u;
const fenceClose = /^:::[ \t]*$/u;
const numberLine = /^(\d{1,9})\. /u;
const escapedNumberLine = /^(\d{1,9})\\\. /u;
/** Same fence shape as the room's code cards (`codeFence.ts`). */
const codeFenceOpen = /^(`{3,})[A-Za-z0-9_+#.-]{0,32}[ \t]*$/u;

const colorSet = new Set<string>(CHAT_TEXT_COLORS);
const sizeSet = new Set<string>(CHAT_TEXT_SIZES);

export function isChatTextColor(value: unknown): value is ChatTextColor {
  return typeof value === "string" && colorSet.has(value);
}

export function isChatTextSize(value: unknown): value is ChatTextSize {
  return typeof value === "string" && sizeSet.has(value);
}

/** Drops false flags and empty values so equal styles compare equal. */
export function cleanChatStyle(style: ChatInlineStyle): ChatInlineStyle {
  const clean: ChatInlineStyle = {};
  if (style.bold) clean.bold = true;
  if (style.italic) clean.italic = true;
  if (style.underline) clean.underline = true;
  if (style.strike) clean.strike = true;
  if (isChatTextColor(style.color)) clean.color = style.color;
  if (isChatTextSize(style.size)) clean.size = style.size;
  return clean;
}

function styleKey(style: ChatInlineStyle) {
  return [
    style.bold ? "b" : "",
    style.italic ? "i" : "",
    style.underline ? "u" : "",
    style.strike ? "s" : "",
    style.color ?? "",
    style.size ?? "",
  ].join("|");
}

function isPlainStyle(style: ChatInlineStyle) {
  return styleKey(style) === "|||||";
}

function pushRun(runs: ChatRun[], text: string, style: ChatInlineStyle) {
  if (!text) return;
  const clean = cleanChatStyle(style);
  const last = runs[runs.length - 1];
  if (last && styleKey(last.style) === styleKey(clean)) {
    last.text += text;
    return;
  }
  runs.push({ style: clean, text });
}

function isEscapedAt(text: string, index: number) {
  let count = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && text[cursor] === "\\";
    cursor -= 1
  ) {
    count += 1;
  }
  return count % 2 === 1;
}

function matchDelimited(text: string, index: number) {
  const candidates = DELIMITERS[text.charAt(index)];
  if (!candidates) return null;
  const before = text.charAt(index - 1);
  if (before && wordCharacter.test(before)) return null;
  for (const [delimiter, flag] of candidates) {
    if (!text.startsWith(delimiter, index)) continue;
    const contentStart = index + delimiter.length;
    const first = text.charAt(contentStart);
    if (!first || whitespace.test(first)) continue;
    // "** x **" is not "*" + "* x *": a lone star never opens a star run.
    if (delimiter.length === 1 && first === delimiter) continue;
    let closer = text.indexOf(delimiter, contentStart + 1);
    while (closer !== -1) {
      const last = text.charAt(closer - 1);
      const after = text.charAt(closer + delimiter.length);
      if (
        !isEscapedAt(text, closer) &&
        last &&
        !whitespace.test(last) &&
        (!after || (!wordCharacter.test(after) && after !== delimiter[0]))
      ) {
        return {
          end: closer + delimiter.length,
          flag,
          inner: text.slice(contentStart, closer),
        };
      }
      closer = text.indexOf(delimiter, closer + 1);
    }
  }
  return null;
}

function parseSpanAttributes(source: string): ChatInlineStyle | null {
  const tokens = source.trim().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return null;
  const style: ChatInlineStyle = {};
  for (const token of tokens) {
    if (!token.startsWith(".")) return null;
    const name = token.slice(1);
    if (
      name === "bold" ||
      name === "italic" ||
      name === "underline" ||
      name === "strike"
    ) {
      style[name] = true;
    } else if (isChatTextColor(name) && !style.color) {
      style.color = name;
    } else if (isChatTextSize(name) && !style.size) {
      style.size = name;
    } else {
      return null;
    }
  }
  return style;
}

function matchSpan(text: string, index: number) {
  let depth = 0;
  let cursor = index;
  for (; cursor < text.length; cursor += 1) {
    const character = text.charAt(cursor);
    if (character === "\\") {
      cursor += 1;
      continue;
    }
    if (character === "[") depth += 1;
    if (character === "]") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (cursor >= text.length || cursor === index + 1) return null;
  if (text.charAt(cursor + 1) !== "{") return null;
  const close = text.indexOf("}", cursor + 2);
  if (close === -1) return null;
  const style = parseSpanAttributes(text.slice(cursor + 2, close));
  if (!style) return null;
  return { end: close + 1, inner: text.slice(index + 1, cursor), style };
}

function parseInline(
  text: string,
  style: ChatInlineStyle,
  runs: ChatRun[],
  depth: number,
) {
  let buffer = "";
  const flush = () => {
    pushRun(runs, buffer, style);
    buffer = "";
  };
  let index = 0;
  while (index < text.length) {
    const character = text.charAt(index);
    if (character === "h" || character === "H") {
      const previous = text.charAt(index - 1);
      if (!previous || !wordCharacter.test(previous)) {
        urlAtPosition.lastIndex = index;
        const url = urlAtPosition.exec(text);
        if (url) {
          buffer += url[0];
          index += url[0].length;
          continue;
        }
      }
    }
    if (character === "\\") {
      const next = text.charAt(index + 1);
      if (ESCAPABLE.has(next)) {
        buffer += next;
        index += 2;
        continue;
      }
    }
    if (depth < MAX_INLINE_DEPTH) {
      if (character === "[") {
        const span = matchSpan(text, index);
        if (span) {
          flush();
          parseInline(span.inner, { ...style, ...span.style }, runs, depth + 1);
          index = span.end;
          continue;
        }
      }
      const delimited = matchDelimited(text, index);
      if (delimited) {
        flush();
        parseInline(
          delimited.inner,
          { ...style, [delimited.flag]: true },
          runs,
          depth + 1,
        );
        index = delimited.end;
        continue;
      }
    }
    buffer += character;
    index += 1;
  }
  flush();
}

/** Parses one message line's inline markup into styled runs. */
export function parseChatInline(text: string): ChatRun[] {
  const runs: ChatRun[] = [];
  parseInline(text, {}, runs, 0);
  return runs;
}

function parseLine(raw: string, align: ChatAlign): ChatLine {
  let kind: ChatLineKind = "text";
  let ordinal = 0;
  let content = raw;
  const escapedNumber = escapedNumberLine.exec(raw);
  const number = numberLine.exec(raw);
  if (raw.startsWith("\\- ") || raw.startsWith("\\:::")) {
    content = raw.slice(1);
  } else if (escapedNumber) {
    content = `${escapedNumber[1]}. ${raw.slice(escapedNumber[0].length)}`;
  } else if (raw.startsWith("- ")) {
    kind = "bullet";
    content = raw.slice(2);
  } else if (number) {
    kind = "number";
    ordinal = Math.min(Number.parseInt(number[1] ?? "1", 10), MAX_ORDINAL);
    content = raw.slice(number[0].length);
  }
  const runs: ChatRun[] = [];
  if (kind === "text" && content !== raw) {
    // The escaped prefix is literal; the rest of the line is still markup.
    const prefixLength = escapedNumber
      ? `${escapedNumber[1]}. `.length
      : raw.startsWith("\\- ")
        ? 2
        : 3;
    pushRun(runs, content.slice(0, prefixLength), {});
    parseInline(content.slice(prefixLength), {}, runs, 0);
  } else {
    parseInline(content, {}, runs, 0);
  }
  return { align, kind, ordinal, runs };
}

function findFenceClose(lines: readonly string[], start: number) {
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (fenceClose.test(line)) return index;
    if (fenceOpen.test(line)) return -1;
  }
  return -1;
}

/** Consecutive numbered lines of one alignment count up from the first. */
function numberLines(lines: ChatLine[]): ChatLine[] {
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    const previous = lines[index - 1];
    if (
      line?.kind === "number" &&
      previous?.kind === "number" &&
      previous.align === line.align
    ) {
      line.ordinal = Math.min(previous.ordinal + 1, MAX_ORDINAL);
    }
  }
  return lines;
}

function findCodeFenceClose(
  lines: readonly string[],
  start: number,
  ticks: string,
) {
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith(ticks) && line.slice(ticks.length).trim() === "") {
      return index;
    }
  }
  return -1;
}

export function parseChatMarkup(source: string): ChatDocument {
  const raw = source
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n");
  const lines: ChatLine[] = [];
  let index = 0;
  while (index < raw.length) {
    const line = raw[index] ?? "";
    const code = codeFenceOpen.exec(line);
    if (code) {
      const close = findCodeFenceClose(raw, index + 1, code[1] ?? "```");
      if (close !== -1) {
        // Code is never formatted: every fenced line is literal text.
        for (let inner = index; inner <= close; inner += 1) {
          const literal = raw[inner] ?? "";
          lines.push({
            align: "left",
            kind: "text",
            ordinal: 0,
            runs: literal ? [{ style: {}, text: literal }] : [],
          });
        }
        index = close + 1;
        continue;
      }
    }
    const open = fenceOpen.exec(line);
    if (open) {
      const close = findFenceClose(raw, index + 1);
      if (close > index + 1) {
        const align = (open[1] ?? "left") as ChatAlign;
        for (let inner = index + 1; inner < close; inner += 1) {
          lines.push(parseLine(raw[inner] ?? "", align));
        }
        index = close + 1;
        continue;
      }
    }
    lines.push(parseLine(line, "left"));
    index += 1;
  }
  return { lines: numberLines(lines) };
}

function lineText(line: ChatLine) {
  return line.runs.map((run) => run.text).join("");
}

/** Readable text for previews, search, quotes and copy. */
export function chatDocumentToPlainText(document: ChatDocument): string {
  return document.lines
    .map((line) => {
      const text = lineText(line);
      if (line.kind === "bullet") return `- ${text}`;
      if (line.kind === "number") return `${line.ordinal}. ${text}`;
      return text;
    })
    .join("\n");
}

export function chatMarkupToPlainText(source: string): string {
  if (!mayContainChatMarkup(source)) return source;
  return chatDocumentToPlainText(parseChatMarkup(source));
}

/** Cheap pre-check: text without these characters is never formatted. */
export function mayContainChatMarkup(source: string): boolean {
  return /[*~[\\]|^:::|^- |^\d{1,9}\. /mu.test(source);
}

export function chatDocumentHasFormatting(document: ChatDocument): boolean {
  return document.lines.some(
    (line) =>
      line.kind !== "text" ||
      line.align !== "left" ||
      line.runs.some((run) => !isPlainStyle(run.style)),
  );
}

export function chatMarkupHasFormatting(source: string): boolean {
  return (
    mayContainChatMarkup(source) &&
    chatDocumentHasFormatting(parseChatMarkup(source))
  );
}

/**
 * Moves spaces at the edges of bold/italic/colour/size runs out of the run
 * (they look the same either way), so a selection that grabbed a trailing
 * space still writes `**word** next`. Underline and strike keep their
 * spaces because those are visible.
 */
export function tidyChatRunEdges(runs: readonly ChatRun[]): ChatRun[] {
  const tidy: ChatRun[] = [];
  for (const run of runs) {
    const style = cleanChatStyle(run.style);
    if (style.underline || style.strike || isPlainStyle(style)) {
      pushRun(tidy, run.text, style);
      continue;
    }
    const match = /^(\s*)([\s\S]*?)(\s*)$/u.exec(run.text);
    const [, leading = "", body = "", trailing = ""] = match ?? [];
    pushRun(tidy, leading, {});
    pushRun(tidy, body, style);
    pushRun(tidy, trailing, {});
  }
  return tidy;
}

/**
 * Canonical form: merged runs, no empty runs or line breaks inside runs,
 * renumbered lists and no blank lines at either end.
 */
export function normalizeChatDocument(document: ChatDocument): ChatDocument {
  const lines: ChatLine[] = document.lines.map((line) => {
    const runs: ChatRun[] = [];
    for (const run of line.runs) {
      pushRun(runs, run.text.replace(/[\r\n]+/gu, " "), run.style);
    }
    return {
      align: CHAT_ALIGNMENTS.includes(line.align) ? line.align : "left",
      kind: line.kind,
      ordinal:
        line.kind === "number"
          ? Math.min(Math.max(1, Math.trunc(line.ordinal) || 1), MAX_ORDINAL)
          : 0,
      runs,
    };
  });
  const blank = (line: ChatLine | undefined) =>
    line !== undefined && line.runs.length === 0;
  while (blank(lines[lines.length - 1])) lines.pop();
  while (blank(lines[0])) lines.shift();
  return { lines: numberLines(lines) };
}

export function chatDocumentsEqual(left: ChatDocument, right: ChatDocument) {
  const a = normalizeChatDocument(left).lines;
  const b = normalizeChatDocument(right).lines;
  if (a.length !== b.length) return false;
  return a.every((line, index) => {
    const other = b[index];
    if (
      !other ||
      other.kind !== line.kind ||
      other.align !== line.align ||
      other.ordinal !== line.ordinal ||
      other.runs.length !== line.runs.length
    ) {
      return false;
    }
    return line.runs.every((run, runIndex) => {
      const otherRun = other.runs[runIndex];
      return (
        otherRun !== undefined &&
        otherRun.text === run.text &&
        styleKey(otherRun.style) === styleKey(run.style)
      );
    });
  });
}

type SerializeMode = "pretty" | "escaped" | "spans";

function escapeText(text: string) {
  return text.replace(/[\\*~[\]]/gu, (character) => `\\${character}`);
}

function spanClasses(style: ChatInlineStyle) {
  const classes: string[] = [];
  for (const flag of ["bold", "italic", "underline", "strike"] as const) {
    if (style[flag]) classes.push(`.${flag}`);
  }
  if (style.color) classes.push(`.${style.color}`);
  if (style.size) classes.push(`.${style.size}`);
  return classes.join(" ");
}

interface MarkNode {
  children: (MarkNode | string)[];
  flag?: MarkFlag;
  /** Colour/size span; `flag` is unset. */
  span?: ChatInlineStyle;
}

function markKey(node: MarkNode) {
  return node.flag ?? `span:${styleKey(node.span ?? {})}`;
}

function marksFor(style: ChatInlineStyle): MarkNode[] {
  const marks: MarkNode[] = [];
  if (style.color || style.size) {
    marks.push({
      children: [],
      span: { color: style.color, size: style.size },
    });
  }
  for (const flag of MARK_ORDER) {
    if (style[flag]) marks.push({ children: [], flag });
  }
  return marks;
}

/** Turns flat runs into properly nested mark nodes. */
function buildMarkTree(runs: readonly ChatRun[]): MarkNode {
  const root: MarkNode = { children: [] };
  const stack: MarkNode[] = [root];
  for (const run of runs) {
    const wanted = marksFor(run.style);
    const wantedKeys = new Set(wanted.map(markKey));
    let keep = 1;
    while (
      keep < stack.length &&
      wantedKeys.has(markKey(stack[keep] as MarkNode))
    ) {
      keep += 1;
    }
    stack.length = keep;
    const open = new Set(stack.slice(1).map(markKey));
    for (const mark of wanted) {
      if (open.has(markKey(mark))) continue;
      (stack[stack.length - 1] as MarkNode).children.push(mark);
      stack.push(mark);
    }
    (stack[stack.length - 1] as MarkNode).children.push(run.text);
  }
  return root;
}

function plainLength(node: MarkNode): number {
  return node.children.reduce<number>(
    (total, child) =>
      total + (typeof child === "string" ? child.length : plainLength(child)),
    0,
  );
}

function renderTree(root: MarkNode, plain: string, escape: boolean): string {
  let offset = 0;
  const render = (node: MarkNode): string =>
    node.children
      .map((child) => {
        if (typeof child === "string") {
          offset += child.length;
          return escape ? escapeText(child) : child;
        }
        const start = offset;
        const end = start + plainLength(child);
        const inside = plain.slice(start, end);
        const body = render(child);
        if (child.span) return `[${body}]{${spanClasses(child.span)}}`;
        const flag = child.flag as MarkFlag;
        const delimiter = DELIMITER_OF[flag];
        if (!delimiter) return `[${body}]{.${flag}}`;
        const before = plain.charAt(start - 1);
        const after = plain.charAt(end);
        const flanked =
          inside.length > 0 &&
          !whitespace.test(inside.charAt(0)) &&
          !whitespace.test(inside.charAt(inside.length - 1)) &&
          !(before && wordCharacter.test(before)) &&
          !(after && wordCharacter.test(after));
        if (!flanked) return `[${body}]{.${flag}}`;
        return `${delimiter}${body}${delimiter}`;
      })
      .join("");
  return render(root);
}

function renderRuns(runs: readonly ChatRun[], mode: SerializeMode) {
  if (mode === "spans") {
    return runs
      .map((run) =>
        isPlainStyle(run.style)
          ? escapeText(run.text)
          : `[${escapeText(run.text)}]{${spanClasses(run.style)}}`,
      )
      .join("");
  }
  const plain = runs.map((run) => run.text).join("");
  return renderTree(buildMarkTree(runs), plain, mode === "escaped");
}

function escapeLineStart(body: string) {
  if (body.startsWith("- ") || body.startsWith(":::")) return `\\${body}`;
  const number = numberLine.exec(body);
  if (number) {
    return `${number[1]}\\. ${body.slice(number[0].length)}`;
  }
  return body;
}

function renderLine(line: ChatLine, mode: SerializeMode) {
  const body = renderRuns(line.runs, mode);
  if (line.kind === "bullet") return `- ${body}`;
  if (line.kind === "number") return `${line.ordinal}. ${body}`;
  return mode === "pretty" ? body : escapeLineStart(body);
}

function renderMarkup(document: ChatDocument, mode: SerializeMode) {
  const output: string[] = [];
  const { lines } = document;
  let index = 0;
  while (index < lines.length) {
    const align = lines[index]?.align ?? "left";
    let end = index;
    while (end < lines.length && lines[end]?.align === align) end += 1;
    const block = lines.slice(index, end).map((line) => renderLine(line, mode));
    if (align === "left") {
      output.push(...block);
    } else {
      output.push(`::: ${align}`, ...block, ":::");
    }
    index = end;
  }
  return output.join("\n");
}

/**
 * Writes a document as markup. The most readable form that parses back to
 * the same document wins: bare delimiters, then escaped literals, then
 * explicit spans (which always round-trip).
 */
export function serializeChatDocument(document: ChatDocument): string {
  const canonical = normalizeChatDocument(document);
  if (canonical.lines.length === 0) return "";
  for (const mode of ["pretty", "escaped"] as const) {
    const markup = renderMarkup(canonical, mode);
    if (chatDocumentsEqual(parseChatMarkup(markup), canonical)) return markup;
  }
  return renderMarkup(canonical, "spans");
}
