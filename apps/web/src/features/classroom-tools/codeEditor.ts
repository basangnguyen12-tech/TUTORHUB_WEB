import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
  type LanguageSupport,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import {
  Compartment,
  EditorState,
  Prec,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { CodeFileLanguage } from "./codeLanguages";

/**
 * ROOM-TOOLS-CODE-01 CodeMirror 6 setup (ADR-0043 §2). Language packs load
 * through `import()` on first use, so the Code tool chunk only carries the
 * editor core. WCAG 2.2 SC 2.1.2: Tab indents, but Escape then Tab (built
 * into CodeMirror: Escape arms tab-focus mode for two seconds) or Ctrl+M
 * (Shift+Alt+M on macOS, a persistent toggle) always moves focus out.
 */
const languageLoaders: Readonly<
  Record<CodeFileLanguage, () => Promise<LanguageSupport>>
> = {
  c: () => import("@codemirror/lang-cpp").then((module) => module.cpp()),
  cpp: () => import("@codemirror/lang-cpp").then((module) => module.cpp()),
  css: () => import("@codemirror/lang-css").then((module) => module.css()),
  html: () => import("@codemirror/lang-html").then((module) => module.html()),
  java: () => import("@codemirror/lang-java").then((module) => module.java()),
  javascript: () =>
    import("@codemirror/lang-javascript").then((module) => module.javascript()),
  python: () =>
    import("@codemirror/lang-python").then((module) => module.python()),
  sql: () =>
    import("@codemirror/lang-sql").then((module) =>
      module.sql({ dialect: module.SQLite }),
    ),
  typescript: () =>
    import("@codemirror/lang-javascript").then((module) =>
      module.javascript({ typescript: true }),
    ),
};

const loadedLanguages = new Map<CodeFileLanguage, Promise<LanguageSupport>>();

export function loadEditorLanguage(
  language: CodeFileLanguage,
): Promise<LanguageSupport> {
  let pending = loadedLanguages.get(language);
  if (!pending) {
    pending = languageLoaders[language]().catch((error: unknown) => {
      loadedLanguages.delete(language);
      throw error;
    });
    loadedLanguages.set(language, pending);
  }
  return pending;
}

/** Liquid Glass dark palette; forced colors are handled in the room CSS. */
const editorTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "#0f131b",
      color: "#e5e7eb",
      fontSize: "13.5px",
      height: "100%",
    },
    ".cm-scroller": {
      fontFamily:
        'ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      lineHeight: "1.6",
    },
    ".cm-content": { caretColor: "#93c5fd", padding: "10px 0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#93c5fd" },
    "&.cm-focused": { outline: "none" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
      { backgroundColor: "rgb(59 130 246 / 38%)" },
    ".cm-gutters": {
      backgroundColor: "#0f131b",
      borderRight: "1px solid rgb(255 255 255 / 7%)",
      color: "#6b7280",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "rgb(255 255 255 / 4%)",
      color: "#cbd5e1",
    },
    ".cm-activeLine": { backgroundColor: "rgb(255 255 255 / 3.5%)" },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "rgb(250 204 21 / 18%)",
      outline: "1px solid rgb(250 204 21 / 45%)",
    },
    ".cm-selectionMatch": { backgroundColor: "rgb(147 197 253 / 16%)" },
    ".cm-searchMatch": {
      backgroundColor: "rgb(250 204 21 / 22%)",
      outline: "1px solid rgb(250 204 21 / 55%)",
    },
    ".cm-panels": {
      backgroundColor: "#151a24",
      color: "#e5e7eb",
      borderColor: "rgb(255 255 255 / 10%)",
    },
    ".cm-panel input, .cm-panel button, .cm-textfield": {
      color: "#e5e7eb",
      backgroundColor: "rgb(255 255 255 / 6%)",
      border: "1px solid rgb(255 255 255 / 16%)",
      borderRadius: "6px",
    },
    ".cm-panel.cm-search label": { color: "#cbd5e1" },
  },
  { dark: true },
);

const editorHighlight = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword],
    color: "#c4b5fd",
  },
  { tag: [tags.operatorKeyword, tags.definitionKeyword], color: "#c4b5fd" },
  {
    tag: [tags.string, tags.special(tags.string), tags.regexp],
    color: "#86efac",
  },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "#fdba74" },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: "#8b95a7",
    fontStyle: "italic",
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: "#93c5fd",
  },
  {
    tag: [
      tags.definition(tags.variableName),
      tags.definition(tags.function(tags.variableName)),
    ],
    color: "#bfdbfe",
  },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "#67e8f9" },
  { tag: [tags.propertyName, tags.attributeName], color: "#fde68a" },
  { tag: [tags.tagName, tags.angleBracket], color: "#f9a8d4" },
  { tag: [tags.operator, tags.punctuation, tags.separator], color: "#cbd5e1" },
  { tag: [tags.meta, tags.processingInstruction], color: "#a5b4fc" },
  { tag: tags.invalid, color: "#fca5a5" },
]);

export interface CodeEditorCommands {
  readonly run: () => void;
  readonly stop: () => void;
  readonly toggleTabFocus: (view: EditorView) => void;
}

export interface CodeEditorStateOptions {
  readonly commands: CodeEditorCommands;
  readonly content: string;
  readonly labelledBy: string;
  readonly describedBy: string;
  readonly languageCompartment: Compartment;
  readonly language: Extension;
  /** UTF-8 bytes this file may hold (the workspace's 64 KB minus others). */
  readonly maxBytes: () => number;
  readonly onChange: (content: string) => void;
  /** An edit was refused because it would pass `maxBytes`. */
  readonly onLimit: () => void;
}

const encoder = new TextEncoder();

/** One EditorState per file keeps its own undo history and selection. */
export function createCodeEditorState(
  options: CodeEditorStateOptions,
): EditorState {
  const shortcuts = Prec.highest(
    keymap.of([
      {
        key: "Mod-Enter",
        preventDefault: true,
        run: () => {
          options.commands.run();
          return true;
        },
      },
      {
        key: "Mod-.",
        preventDefault: true,
        run: () => {
          options.commands.stop();
          return true;
        },
      },
      {
        key: "Ctrl-m",
        mac: "Shift-Alt-m",
        preventDefault: true,
        run: (view) => {
          options.commands.toggleTabFocus(view);
          return true;
        },
      },
    ]),
  );
  return EditorState.create({
    doc: options.content,
    extensions: [
      shortcuts,
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      indentUnit.of("    "),
      syntaxHighlighting(editorHighlight),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      editorTheme,
      options.languageCompartment.of(options.language),
      EditorView.contentAttributes.of({
        "aria-describedby": options.describedBy,
        "aria-labelledby": options.labelledBy,
        "aria-multiline": "true",
        role: "textbox",
        spellcheck: "false",
        autocapitalize: "off",
        autocorrect: "off",
        translate: "no",
      }),
      // ADR-0043 §2: the whole workspace stays within 64 KB of UTF-8.
      EditorState.transactionFilter.of((transaction) => {
        if (!transaction.docChanged) return transaction;
        const allowed = options.maxBytes();
        const size = transaction.newDoc.length;
        // UTF-16 length × 3 bounds the UTF-8 size: skip encoding when clear.
        if (size * 3 <= allowed) return transaction;
        if (
          size > transaction.startState.doc.length &&
          encoder.encode(transaction.newDoc.toString()).byteLength > allowed
        ) {
          options.onLimit();
          return [];
        }
        return transaction;
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) options.onChange(update.state.doc.toString());
      }),
    ],
  });
}

export { Compartment, EditorState, EditorView };
