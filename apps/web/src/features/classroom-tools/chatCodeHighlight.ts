import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import type { CodeFileLanguage } from "./codeLanguages";

/**
 * ROOM-TOOLS-CODE-03B: syntax colours for chat code cards (ADR-0043 §1).
 *
 * This module is only reached through `import()` from the chat panel, and
 * each language parser through its own `import()`, so the client entry and
 * the room chunk gain 0 bytes. The output is plain data — `{ text, token? }`
 * pieces that the card renders as React text nodes inside `<span>`s; no HTML
 * string is ever produced, so a message can never inject markup.
 */
export const CHAT_HIGHLIGHT_MAX_CHARACTERS = 4_000;

export type ChatCodeTokenKind =
  | "comment"
  | "definition"
  | "function"
  | "invalid"
  | "keyword"
  | "meta"
  | "number"
  | "operator"
  | "property"
  | "string"
  | "tag"
  | "type";

export interface ChatCodeToken {
  readonly text: string;
  readonly token?: ChatCodeTokenKind;
}

type HighlightTree = Parameters<typeof highlightTree>[0];

interface ChatCodeParser {
  parse(input: string): HighlightTree;
}

/** Same tag groups as the editor's `HighlightStyle` (codeEditor.ts). */
const highlighter = tagHighlighter([
  {
    tag: [
      tags.keyword,
      tags.controlKeyword,
      tags.moduleKeyword,
      tags.operatorKeyword,
      tags.definitionKeyword,
    ],
    class: "keyword",
  },
  {
    tag: [tags.string, tags.special(tags.string), tags.regexp],
    class: "string",
  },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], class: "number" },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    class: "comment",
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    class: "function",
  },
  {
    tag: [
      tags.definition(tags.variableName),
      tags.definition(tags.function(tags.variableName)),
    ],
    class: "definition",
  },
  { tag: [tags.typeName, tags.className, tags.namespace], class: "type" },
  { tag: [tags.propertyName, tags.attributeName], class: "property" },
  { tag: [tags.tagName, tags.angleBracket], class: "tag" },
  {
    tag: [tags.operator, tags.punctuation, tags.separator],
    class: "operator",
  },
  { tag: [tags.meta, tags.processingInstruction], class: "meta" },
  { tag: tags.invalid, class: "invalid" },
]);

const TOKEN_KINDS: ReadonlySet<string> = new Set<ChatCodeTokenKind>([
  "comment",
  "definition",
  "function",
  "invalid",
  "keyword",
  "meta",
  "number",
  "operator",
  "property",
  "string",
  "tag",
  "type",
]);

const parserLoaders: Readonly<
  Record<CodeFileLanguage, () => Promise<ChatCodeParser>>
> = {
  c: () =>
    import("@codemirror/lang-cpp").then((module) => module.cppLanguage.parser),
  cpp: () =>
    import("@codemirror/lang-cpp").then((module) => module.cppLanguage.parser),
  css: () =>
    import("@codemirror/lang-css").then((module) => module.cssLanguage.parser),
  html: () =>
    import("@codemirror/lang-html").then(
      (module) => module.htmlLanguage.parser,
    ),
  java: () =>
    import("@codemirror/lang-java").then(
      (module) => module.javaLanguage.parser,
    ),
  javascript: () =>
    import("@codemirror/lang-javascript").then(
      (module) => module.javascriptLanguage.parser,
    ),
  python: () =>
    import("@codemirror/lang-python").then(
      (module) => module.pythonLanguage.parser,
    ),
  sql: () =>
    import("@codemirror/lang-sql").then(
      (module) => module.SQLite.language.parser,
    ),
  typescript: () =>
    import("@codemirror/lang-javascript").then(
      (module) => module.typescriptLanguage.parser,
    ),
};

const parsers = new Map<CodeFileLanguage, Promise<ChatCodeParser>>();

function loadParser(language: CodeFileLanguage): Promise<ChatCodeParser> {
  let pending = parsers.get(language);
  if (!pending) {
    pending = parserLoaders[language]().catch((error: unknown) => {
      parsers.delete(language);
      throw error;
    });
    parsers.set(language, pending);
  }
  return pending;
}

function tokenKind(classes: string): ChatCodeTokenKind | undefined {
  const first = classes.split(" ")[0] ?? "";
  return TOKEN_KINDS.has(first) ? (first as ChatCodeTokenKind) : undefined;
}

/** Pure tokenizer: every character of `code` lands in exactly one piece. */
export function tokenizeChatCode(
  parser: ChatCodeParser,
  code: string,
): readonly ChatCodeToken[] {
  const tree = parser.parse(code);
  const pieces: ChatCodeToken[] = [];
  const push = (text: string, token?: ChatCodeTokenKind) => {
    if (!text) return;
    const last = pieces[pieces.length - 1];
    if (last && last.token === token) {
      pieces[pieces.length - 1] = token
        ? { text: last.text + text, token }
        : { text: last.text + text };
      return;
    }
    pieces.push(token ? { text, token } : { text });
  };
  let position = 0;
  highlightTree(tree, highlighter, (from, to, classes) => {
    if (from < position) return;
    push(code.slice(position, from));
    push(code.slice(from, to), tokenKind(classes));
    position = to;
  });
  push(code.slice(position));
  return pieces;
}

/**
 * Highlights one chat code block, or resolves `null` when it is not
 * eligible (unknown language or longer than 4 000 characters).
 */
export async function highlightChatCode(
  code: string,
  language: CodeFileLanguage | null,
): Promise<readonly ChatCodeToken[] | null> {
  if (
    language === null ||
    code.length === 0 ||
    code.length > CHAT_HIGHLIGHT_MAX_CHARACTERS
  ) {
    return null;
  }
  const parser = await loadParser(language);
  return tokenizeChatCode(parser, code);
}
