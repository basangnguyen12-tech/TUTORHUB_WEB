import {
  CODE_LANGUAGES,
  isCodeFileLanguage,
  languageForFileName,
  type CodeFileLanguage,
} from "./codeLanguages";
import type {
  ClassroomCodeWorkspaceFile,
  ClassroomCodeWorkspaceSnapshot,
} from "./codeSession";

/** ADR-0043 §2 / §3 bounds for the Slice 1 personal workspace. */
export const CODE_MAX_FILES = 8;
export const CODE_MAX_TOTAL_BYTES = 64 * 1024;
export const CODE_MAX_STDIN_BYTES = 16 * 1024;
export const CODE_FILE_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

const encoder = new TextEncoder();

export function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

export function workspaceBytes(
  files: readonly Pick<ClassroomCodeWorkspaceFile, "content">[],
): number {
  return files.reduce((sum, file) => sum + utf8Bytes(file.content), 0);
}

export type CodeFileNameProblem = "invalid" | "duplicate";

/** `null` when `name` is a valid, unique file name for the workspace. */
export function fileNameProblem(
  name: string,
  files: readonly Pick<ClassroomCodeWorkspaceFile, "name">[],
  ignoreIndex = -1,
): CodeFileNameProblem | null {
  if (!CODE_FILE_NAME_PATTERN.test(name) || /^\.+$/.test(name)) {
    return "invalid";
  }
  const folded = name.toLowerCase();
  return files.some(
    (file, index) =>
      index !== ignoreIndex && file.name.toLowerCase() === folded,
  )
    ? "duplicate"
    : null;
}

/** `main.py` → `main-2.py`, `main-3.py`, … until it is free. */
export function uniqueFileName(
  name: string,
  files: readonly Pick<ClassroomCodeWorkspaceFile, "name">[],
): string {
  if (fileNameProblem(name, files) === null) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${stem.slice(0, 50)}-${suffix}${extension}`;
    if (fileNameProblem(candidate, files) === null) return candidate;
  }
  return `file-${Date.now().toString(36)}${extension}`;
}

/** Swaps (or adds) the extension so the name matches the language. */
export function renameForLanguage(
  name: string,
  language: CodeFileLanguage,
): string {
  const extension = CODE_LANGUAGES[language].extension;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem}.${extension}`;
}

/** A file's language follows its extension when it has a known one. */
export function languageForName(
  name: string,
  fallback: CodeFileLanguage,
): CodeFileLanguage {
  return languageForFileName(name) ?? fallback;
}

type UILanguage = "vi" | "en";

const STARTERS: Readonly<Record<CodeFileLanguage, (ui: UILanguage) => string>> =
  {
    python: (ui) =>
      [
        ui === "vi"
          ? "# Chào mừng đến công cụ Code! Nhấn ▶ Chạy (Ctrl+Enter)."
          : "# Welcome to the Code tool! Press ▶ Run (Ctrl+Enter).",
        "",
        "def square(n: int) -> int:",
        "    return n * n",
        "",
        "for i in range(1, 6):",
        '    print(f"{i}² = {square(i)}")',
        "",
      ].join("\n"),
    javascript: (ui) =>
      [
        ui === "vi"
          ? "// Chào mừng! Nhấn ▶ Chạy (Ctrl+Enter) để chạy trong sandbox."
          : "// Welcome! Press ▶ Run (Ctrl+Enter) to run it in the sandbox.",
        "const scores = [8, 9.5, 7, 10];",
        "const average = scores.reduce((sum, x) => sum + x, 0) / scores.length;",
        `console.log("${ui === "vi" ? "Điểm trung bình:" : "Average score:"}", average.toFixed(2));`,
        "",
      ].join("\n"),
    typescript: (ui) =>
      [
        "interface Student {",
        "  name: string;",
        "  score: number;",
        "}",
        "",
        "const students: Student[] = [",
        '  { name: "An", score: 9 },',
        '  { name: "Binh", score: 7.5 },',
        "];",
        "const best = students.reduce((a, b) => (b.score > a.score ? b : a));",
        `console.log(\`${ui === "vi" ? "Cao nhất" : "Top score"}: \${best.name} (\${best.score})\`);`,
        "",
      ].join("\n"),
    html: (ui) =>
      [
        "<!doctype html>",
        `<html lang="${ui}">`,
        "  <head>",
        '    <meta charset="utf-8" />',
        "    <style>",
        "      body { font-family: system-ui, sans-serif; padding: 24px; }",
        "      button { padding: 8px 16px; border-radius: 8px; }",
        "    </style>",
        "  </head>",
        "  <body>",
        `    <h1>${ui === "vi" ? "Xin chào!" : "Hello!"}</h1>`,
        `    <button id="count">${ui === "vi" ? "Bấm tôi" : "Click me"}</button>`,
        '    <p id="result">0</p>',
        "    <script>",
        "      let clicks = 0;",
        '      document.getElementById("count").addEventListener("click", () => {',
        "        clicks += 1;",
        '        document.getElementById("result").textContent = String(clicks);',
        "      });",
        "    </script>",
        "  </body>",
        "</html>",
        "",
      ].join("\n"),
    css: () =>
      [
        "body {",
        "  font-family: system-ui, sans-serif;",
        "  margin: 24px;",
        "}",
        "",
      ].join("\n"),
    sql: () =>
      [
        "CREATE TABLE students (id INTEGER PRIMARY KEY, name TEXT, score REAL);",
        "INSERT INTO students (name, score) VALUES",
        "  ('An', 9.0), ('Binh', 7.5), ('Chi', 8.25);",
        "",
        "SELECT name, score FROM students ORDER BY score DESC;",
        "",
      ].join("\n"),
    c: () =>
      [
        "#include <stdio.h>",
        "",
        "int main(void) {",
        '    printf("Hello, TutorHub!\\n");',
        "    return 0;",
        "}",
        "",
      ].join("\n"),
    cpp: () =>
      [
        "#include <iostream>",
        "",
        "int main() {",
        '    std::cout << "Hello, TutorHub!" << std::endl;',
        "    return 0;",
        "}",
        "",
      ].join("\n"),
    java: () =>
      [
        "public class Main {",
        "    public static void main(String[] args) {",
        '        System.out.println("Hello, TutorHub!");',
        "    }",
        "}",
        "",
      ].join("\n"),
  };

export function starterContent(
  language: CodeFileLanguage,
  ui: UILanguage,
): string {
  return STARTERS[language](ui);
}

/** True when the content is empty or an unedited starter of any language. */
export function isStarterContent(content: string): boolean {
  if (content.trim() === "") return true;
  return (Object.keys(STARTERS) as CodeFileLanguage[]).some((language) =>
    (["vi", "en"] as const).some(
      (ui) => STARTERS[language](ui).trim() === content.trim(),
    ),
  );
}

export function starterFile(
  language: CodeFileLanguage,
  ui: UILanguage,
  files: readonly Pick<ClassroomCodeWorkspaceFile, "name">[] = [],
): ClassroomCodeWorkspaceFile {
  return {
    content: starterContent(language, ui),
    language,
    name: uniqueFileName(CODE_LANGUAGES[language].defaultFileName, files),
  };
}

export function defaultWorkspace(
  ui: UILanguage,
): ClassroomCodeWorkspaceSnapshot {
  return { activeIndex: 0, files: [starterFile("python", ui)], stdin: "" };
}

/** Validates an untrusted snapshot (draft storage) against every bound. */
export function sanitizeWorkspaceSnapshot(
  value: unknown,
): ClassroomCodeWorkspaceSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const files = candidate.files;
  if (!Array.isArray(files) || files.length > CODE_MAX_FILES) return null;
  const parsed: ClassroomCodeWorkspaceFile[] = [];
  for (const file of files) {
    if (typeof file !== "object" || file === null) return null;
    const { content, language, name } = file as Record<string, unknown>;
    if (
      typeof content !== "string" ||
      typeof name !== "string" ||
      !isCodeFileLanguage(language) ||
      fileNameProblem(name, parsed) !== null
    ) {
      return null;
    }
    parsed.push({ content, language, name });
  }
  if (workspaceBytes(parsed) > CODE_MAX_TOTAL_BYTES) return null;
  const stdin = typeof candidate.stdin === "string" ? candidate.stdin : "";
  if (utf8Bytes(stdin) > CODE_MAX_STDIN_BYTES) return null;
  const activeIndex =
    typeof candidate.activeIndex === "number" &&
    Number.isSafeInteger(candidate.activeIndex) &&
    candidate.activeIndex >= 0 &&
    candidate.activeIndex < parsed.length
      ? candidate.activeIndex
      : 0;
  return { activeIndex, files: parsed, stdin };
}

/** ADR-0043 Slice 2 `code.workspace.v1` caps (mirrors the shared authority). */
export const LIVE_CODE_MAX_FILE_BYTES = 64 * 1024;
export const LIVE_CODE_MAX_TOTAL_BYTES = 256 * 1024;

export interface CodeForkResult {
  /** Files copied into the personal draft. */
  readonly copied: number;
  /** True when the shared workspace did not fit in the 64 KB draft. */
  readonly partial: boolean;
  readonly snapshot: ClassroomCodeWorkspaceSnapshot;
  /** Files in the shared workspace. */
  readonly total: number;
}

/**
 * ROOM-TOOLS-CODE-02B "Tạo bản nháp từ mẫu": a shared workspace may hold
 * 256 KB while the personal draft holds 64 KB. Everything is copied when it
 * fits; otherwise the open file (always ≤ 64 KB) comes first, then every
 * other file that still fits, in workspace order — so a fork never fails.
 */
export function forkWorkspaceSnapshot(
  files: readonly ClassroomCodeWorkspaceFile[],
  activeIndex: number,
  stdin: string,
  /** ROOM-TOOLS-CODE-03B: 256 KB for the durable server draft. */
  maxTotalBytes = CODE_MAX_TOTAL_BYTES,
): CodeForkResult {
  const safeStdin = utf8Bytes(stdin) <= CODE_MAX_STDIN_BYTES ? stdin : "";
  const active = Math.min(Math.max(0, activeIndex), files.length - 1);
  if (
    files.length <= CODE_MAX_FILES &&
    workspaceBytes(files) <= maxTotalBytes
  ) {
    return {
      copied: files.length,
      partial: false,
      snapshot: {
        activeIndex: Math.max(0, active),
        files: files.map((file) => ({ ...file })),
        stdin: safeStdin,
      },
      total: files.length,
    };
  }
  const included = new Set<number>();
  let used = 0;
  const activeFile = files[active];
  if (activeFile && utf8Bytes(activeFile.content) <= maxTotalBytes) {
    included.add(active);
    used = utf8Bytes(activeFile.content);
  }
  files.forEach((file, index) => {
    if (included.has(index) || included.size >= CODE_MAX_FILES) return;
    const bytes = utf8Bytes(file.content);
    if (used + bytes > maxTotalBytes) return;
    included.add(index);
    used += bytes;
  });
  const order = [...included].sort((left, right) => left - right);
  return {
    copied: order.length,
    partial: true,
    snapshot: {
      activeIndex: Math.max(0, order.indexOf(active)),
      files: order.map((index) => ({
        ...(files[index] as ClassroomCodeWorkspaceFile),
      })),
      stdin: safeStdin,
    },
    total: files.length,
  };
}
