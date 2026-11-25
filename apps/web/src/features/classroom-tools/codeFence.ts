import {
  CODE_LANGUAGES,
  languageForFence,
  type CodeFileLanguage,
} from "./codeLanguages";

/**
 * ROOM-TOOLS-CODE-01 / ADR-0043 §2: fenced Markdown code blocks travel through
 * the ordinary room chat (ADR-0042, 4,000 characters). Parsing returns plain
 * strings only; the chat panel renders them as React text nodes, never HTML.
 */
export type ChatContentPiece =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "code";
      readonly code: string;
      /** The raw fence tag (may be empty or unknown). */
      readonly tag: string;
      readonly language: CodeFileLanguage | null;
    };

// An opening fence of 3+ backticks with an optional tag on its own line, the
// body, and a closing fence of the same length on its own line.
const fencePattern =
  /(^|\n)(`{3,})([A-Za-z0-9_+#.-]{0,32})[ \t]*\r?\n([\s\S]*?)\r?\n\2[ \t]*(?=\r?\n|$)/g;

/** Splits message content into text and fenced code pieces. */
export function splitChatCodeBlocks(content: string): ChatContentPiece[] {
  const pieces: ChatContentPiece[] = [];
  let cursor = 0;
  let afterFence = false;
  // A fence owns the line break before its opening marker and the one after
  // its closing marker, so text pieces never start or end with them.
  const pushText = (raw: string) => {
    const text = (afterFence ? raw.replace(/^\r?\n/, "") : raw).replace(
      /\r?\n$/,
      "",
    );
    if (text.trim() !== "") pieces.push({ kind: "text", text });
  };
  for (const match of content.matchAll(fencePattern)) {
    const index = match.index ?? 0;
    const start = index + (match[1] ?? "").length;
    const tag = match[3] ?? "";
    pushText(content.slice(cursor, start));
    pieces.push({
      code: match[4] ?? "",
      kind: "code",
      language: languageForFence(tag),
      tag,
    });
    cursor = index + match[0].length;
    afterFence = true;
  }
  if (!afterFence) return [{ kind: "text", text: content }];
  pushText(content.slice(cursor));
  return pieces;
}

export function hasChatCodeBlock(content: string): boolean {
  return splitChatCodeBlocks(content).some((piece) => piece.kind === "code");
}

function characterLength(value: string): number {
  return Array.from(value).length;
}

export interface CodeFenceResult {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Wraps code in a fence that the chat parser reads back. The fence grows past
 * any backtick run inside the code; code over the budget is cut at a line
 * boundary so the whole message stays within `maxCharacters`.
 */
export function buildCodeFence(
  language: CodeFileLanguage | null,
  code: string,
  maxCharacters: number,
): CodeFenceResult {
  const normalized = code.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const longestRun = Math.max(
    0,
    ...Array.from(normalized.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const tag = language ? CODE_LANGUAGES[language].fence : "";
  const open = `${fence}${tag}\n`;
  const close = `\n${fence}`;
  const budget = maxCharacters - characterLength(open) - characterLength(close);
  if (budget <= 0) return { text: "", truncated: normalized.length > 0 };
  if (characterLength(normalized) <= budget) {
    return { text: `${open}${normalized}${close}`, truncated: false };
  }
  const lines = normalized.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = characterLength(line) + (kept.length > 0 ? 1 : 0);
    if (used + cost > budget) break;
    kept.push(line);
    used += cost;
  }
  if (kept.length === 0) {
    kept.push(
      Array.from(lines[0] ?? "")
        .slice(0, budget)
        .join(""),
    );
  }
  return { text: `${open}${kept.join("\n")}${close}`, truncated: true };
}
