import { describe, expect, it } from "vitest";
import {
  CODE_MAX_FILES,
  CODE_MAX_TOTAL_BYTES,
  defaultWorkspace,
  fileNameProblem,
  isStarterContent,
  renameForLanguage,
  sanitizeWorkspaceSnapshot,
  starterContent,
  starterFile,
  uniqueFileName,
  utf8Bytes,
  workspaceBytes,
} from "./codeWorkspaceModel";

describe("ROOM-TOOLS-CODE-01 workspace model", () => {
  it("validates file names against the allowlist and duplicates", () => {
    expect(fileNameProblem("main.py", [])).toBeNull();
    expect(fileNameProblem("a".repeat(64), [])).toBeNull();
    expect(fileNameProblem("a".repeat(65), [])).toBe("invalid");
    expect(fileNameProblem("bài-1.py", [])).toBe("invalid");
    expect(fileNameProblem("../x.py", [])).toBe("invalid");
    expect(fileNameProblem("..", [])).toBe("invalid");
    expect(fileNameProblem("", [])).toBe("invalid");
    expect(fileNameProblem("MAIN.PY", [{ name: "main.py" }])).toBe("duplicate");
    expect(fileNameProblem("main.py", [{ name: "main.py" }], 0)).toBeNull();
  });

  it("finds a free name and renames extensions by language", () => {
    const files = [{ name: "main.py" }, { name: "main-2.py" }];
    expect(uniqueFileName("main.py", files)).toBe("main-3.py");
    expect(uniqueFileName("query.sql", files)).toBe("query.sql");
    expect(renameForLanguage("main.py", "cpp")).toBe("main.cpp");
    expect(renameForLanguage("Makefile", "java")).toBe("Makefile.java");
  });

  it("creates bilingual starters and recognises unedited ones", () => {
    const vi = starterContent("python", "vi");
    expect(vi).toContain("Chào mừng");
    expect(starterContent("python", "en")).toContain("Welcome");
    expect(isStarterContent(vi)).toBe(true);
    expect(isStarterContent("  \n")).toBe(true);
    expect(isStarterContent("print(1)")).toBe(false);
    expect(starterFile("java", "en", [{ name: "Main.java" }]).name).toBe(
      "Main-2.java",
    );
    expect(defaultWorkspace("vi").files.map((file) => file.name)).toEqual([
      "main.py",
    ]);
  });

  it("counts UTF-8 bytes, not UTF-16 units", () => {
    expect(utf8Bytes("Tiếng Việt")).toBe(14);
    expect(workspaceBytes([{ content: "ab" }, { content: "đ" }])).toBe(4);
  });

  it("accepts only bounded, well-formed snapshots", () => {
    const valid = {
      activeIndex: 1,
      files: [
        { content: "print(1)", language: "python", name: "main.py" },
        { content: "SELECT 1;", language: "sql", name: "q.sql" },
      ],
      stdin: "3\n",
    };
    expect(sanitizeWorkspaceSnapshot(valid)).toEqual(valid);
    expect(
      sanitizeWorkspaceSnapshot({ ...valid, activeIndex: 9 })?.activeIndex,
    ).toBe(0);
    expect(sanitizeWorkspaceSnapshot(null)).toBeNull();
    expect(
      sanitizeWorkspaceSnapshot({
        files: [{ content: "", language: "ruby", name: "a.rb" }],
      }),
    ).toBeNull();
    expect(
      sanitizeWorkspaceSnapshot({
        files: [
          { content: "", language: "python", name: "a.py" },
          { content: "", language: "python", name: "A.py" },
        ],
      }),
    ).toBeNull();
    expect(
      sanitizeWorkspaceSnapshot({
        files: Array.from({ length: CODE_MAX_FILES + 1 }, (_, index) => ({
          content: "",
          language: "python",
          name: `f${index}.py`,
        })),
      }),
    ).toBeNull();
    expect(
      sanitizeWorkspaceSnapshot({
        files: [
          {
            content: "x".repeat(CODE_MAX_TOTAL_BYTES + 1),
            language: "python",
            name: "big.py",
          },
        ],
      }),
    ).toBeNull();
    expect(
      sanitizeWorkspaceSnapshot({ ...valid, stdin: "x".repeat(16 * 1024 + 1) }),
    ).toBeNull();
  });
});
