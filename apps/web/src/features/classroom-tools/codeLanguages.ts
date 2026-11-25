/**
 * ROOM-TOOLS-CODE-01: language metadata shared by the Code workspace, the
 * chat code cards and "Send to chat". Kept free of CodeMirror imports so the
 * room chunk (chat panel) can use it without pulling the editor.
 */
export const CODE_LANGUAGE_IDS = [
  "python",
  "javascript",
  "typescript",
  "html",
  "sql",
  "c",
  "cpp",
  "java",
] as const;

export type CodeLanguageID = (typeof CODE_LANGUAGE_IDS)[number];

/** A file's own syntax: the eight picker languages plus stylesheets. */
export type CodeFileLanguage = CodeLanguageID | "css";

/** How the sandbox (or a later server slice) runs a language. */
export type CodeRunKind =
  "python" | "javascript" | "sql" | "preview" | "server";

export interface CodeLanguageInfo {
  readonly defaultFileName: string;
  readonly extension: string;
  readonly fence: string;
  readonly id: CodeFileLanguage;
  readonly label: string;
  readonly mimeType: string;
  readonly run: CodeRunKind;
}

export const CODE_LANGUAGES: Readonly<
  Record<CodeFileLanguage, CodeLanguageInfo>
> = {
  python: {
    defaultFileName: "main.py",
    extension: "py",
    fence: "python",
    id: "python",
    label: "Python",
    mimeType: "text/x-python",
    run: "python",
  },
  javascript: {
    defaultFileName: "index.js",
    extension: "js",
    fence: "javascript",
    id: "javascript",
    label: "JavaScript",
    mimeType: "text/javascript",
    run: "javascript",
  },
  typescript: {
    defaultFileName: "solution.ts",
    extension: "ts",
    fence: "typescript",
    id: "typescript",
    label: "TypeScript",
    mimeType: "text/plain",
    run: "javascript",
  },
  html: {
    defaultFileName: "index.html",
    extension: "html",
    fence: "html",
    id: "html",
    label: "HTML / CSS / JS",
    mimeType: "text/html",
    run: "preview",
  },
  css: {
    defaultFileName: "style.css",
    extension: "css",
    fence: "css",
    id: "css",
    label: "CSS",
    mimeType: "text/css",
    run: "preview",
  },
  sql: {
    defaultFileName: "query.sql",
    extension: "sql",
    fence: "sql",
    id: "sql",
    label: "SQL",
    mimeType: "application/sql",
    run: "sql",
  },
  c: {
    defaultFileName: "main.c",
    extension: "c",
    fence: "c",
    id: "c",
    label: "C",
    mimeType: "text/x-c",
    run: "server",
  },
  cpp: {
    defaultFileName: "main.cpp",
    extension: "cpp",
    fence: "cpp",
    id: "cpp",
    label: "C++",
    mimeType: "text/x-c++src",
    run: "server",
  },
  java: {
    defaultFileName: "Main.java",
    extension: "java",
    fence: "java",
    id: "java",
    label: "Java",
    mimeType: "text/x-java",
    run: "server",
  },
};

const EXTENSION_LANGUAGES: Readonly<Record<string, CodeFileLanguage>> = {
  py: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  html: "html",
  htm: "html",
  css: "css",
  sql: "sql",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  java: "java",
};

const FENCE_ALIASES: Readonly<Record<string, CodeFileLanguage>> = {
  python: "python",
  py: "python",
  python3: "python",
  javascript: "javascript",
  js: "javascript",
  node: "javascript",
  jsx: "javascript",
  typescript: "typescript",
  ts: "typescript",
  tsx: "typescript",
  html: "html",
  htm: "html",
  xml: "html",
  css: "css",
  sql: "sql",
  sqlite: "sql",
  c: "c",
  h: "c",
  cpp: "cpp",
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  java: "java",
};

export function isCodeLanguageID(value: unknown): value is CodeLanguageID {
  return (
    typeof value === "string" &&
    (CODE_LANGUAGE_IDS as readonly string[]).includes(value)
  );
}

export function isCodeFileLanguage(value: unknown): value is CodeFileLanguage {
  return value === "css" || isCodeLanguageID(value);
}

/** Language from a file name's extension, or `null` when unknown. */
export function languageForFileName(name: string): CodeFileLanguage | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return EXTENSION_LANGUAGES[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** Language from a Markdown fence tag (```py, ```c++ …), or `null`. */
export function languageForFence(tag: string): CodeFileLanguage | null {
  return FENCE_ALIASES[tag.trim().toLowerCase()] ?? null;
}

/** The picker shows stylesheets under the HTML / CSS / JS family. */
export function pickerLanguage(language: CodeFileLanguage): CodeLanguageID {
  return language === "css" ? "html" : language;
}
