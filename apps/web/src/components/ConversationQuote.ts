/**
 * MSG-CLASSIN-TEAMS-01: ClassIn-style reply quotes without a schema change.
 *
 * A reply is sent as plain text whose leading block quotes the original:
 *
 *     > <Display name>: <one-line excerpt>
 *
 *     <reply body>
 *
 * The thread renders that leading block as a quote card and keeps the body in
 * the message paragraph. Messages that do not start with `> ` are untouched,
 * so ordinary messages are sent and shown verbatim.
 */

export const QUOTE_EXCERPT_MAX_CHARACTERS = 90;
const QUOTE_AUTHOR_MAX_CHARACTERS = 80;
const quoteLinePattern = /^>(?: |$)/;

export interface ReplyTarget {
  readonly authorName: string;
  readonly excerpt: string;
  readonly messageID: string;
}

export interface ParsedQuote {
  /** Display name of the quoted author, when the block names one. */
  readonly author: string | null;
  /** Quoted text without the `> ` markers or the author prefix. */
  readonly text: string;
  /** The original quote lines (kept verbatim when the body is edited). */
  readonly raw: string;
}

export interface ParsedQuotedMessage {
  readonly quote: ParsedQuote | null;
  readonly body: string;
}

/** Splits a leading `> …` block from the body of a message. */
export function parseQuotedMessage(content: string): ParsedQuotedMessage {
  if (!content.startsWith(">")) {
    return { quote: null, body: content };
  }
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const quoted: string[] = [];
  let index = 0;
  while (index < lines.length && quoteLinePattern.test(lines[index] ?? "")) {
    quoted.push(lines[index] ?? "");
    index += 1;
  }
  const body = lines.slice(index).join("\n").replace(/^\n+/, "");
  if (quoted.length === 0 || !body.trim()) {
    return { quote: null, body: content };
  }
  const text = quoted
    .map((line) => line.replace(/^> ?/, ""))
    .join("\n")
    .trim();
  const separator = text.indexOf(": ");
  const candidate = separator > 0 ? text.slice(0, separator).trim() : "";
  const author =
    candidate &&
    !candidate.includes("\n") &&
    [...candidate].length <= QUOTE_AUTHOR_MAX_CHARACTERS
      ? candidate
      : null;
  return {
    quote: {
      author,
      text: author ? text.slice(separator + 2).trim() : text,
      raw: quoted.join("\n"),
    },
    body,
  };
}

function singleLine(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maximum: number) {
  const characters = [...value];
  return characters.length > maximum
    ? `${characters
        .slice(0, maximum - 1)
        .join("")
        .trimEnd()}…`
    : value;
}

/** A one-line excerpt of a message body (a quoted reply is not nested). */
export function quoteExcerpt(
  content: string,
  maximum = QUOTE_EXCERPT_MAX_CHARACTERS,
): string {
  return truncate(singleLine(parseQuotedMessage(content).body), maximum);
}

/** Display names never break the `Name: excerpt` header. */
export function sanitizeQuoteAuthor(name: string): string {
  return truncate(
    singleLine(name)
      .replace(/^>+\s*/, "")
      .replace(/:\s/g, ":"),
    QUOTE_AUTHOR_MAX_CHARACTERS,
  );
}

export function buildQuotedReply(
  target: Pick<ReplyTarget, "authorName" | "excerpt">,
  body: string,
): string {
  const author = sanitizeQuoteAuthor(target.authorName);
  const excerpt = truncate(
    singleLine(target.excerpt),
    QUOTE_EXCERPT_MAX_CHARACTERS,
  );
  return `> ${author}: ${excerpt}\n\n${body}`;
}

/** Re-attaches the verbatim quote block after the body was edited. */
export function rebuildQuotedContent(quote: ParsedQuote | null, body: string) {
  return quote ? `${quote.raw}\n\n${body}` : body;
}
