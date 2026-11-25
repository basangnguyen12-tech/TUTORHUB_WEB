import { describe, expect, it } from "vitest";
import {
  CODE_MAX_FILES,
  CODE_MAX_TOTAL_BYTES,
  defaultWorkspace,
  fileNameProblem,
  forkWorkspaceSnapshot,
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

describe("ROOM-TOOLS-CODE-02B forkWorkspaceSnapshot", () => {
  const kb = (size: number, fill = "x") => fill.repeat(size * 1024);
  const file = (name: string, content: string) => ({
    content,
    language: "python" as const,
    name,
  });

  it("copies every file of a workspace that fits in 64 KB", () => {
    const files = [
      file("main.py", "print(1)\n"),
      file("bai2.py", kb(20)),
      file("bai3.py", "Tiếng Việt\n"),
    ];
    const result = forkWorkspaceSnapshot(files, 1, "5\n");
    expect(result).toEqual({
      copied: 3,
      partial: false,
      snapshot: { activeIndex: 1, files, stdin: "5\n" },
      total: 3,
    });
    // The draft owns its own copies: later shared edits never leak in.
    expect(result.snapshot.files[0]).not.toBe(files[0]);
    expect(sanitizeWorkspaceSnapshot(result.snapshot)).toEqual(result.snapshot);
  });

  it("keeps a valid stdin and drops one larger than 16 KB", () => {
    const files = [file("main.py", "input()\n")];
    expect(
      forkWorkspaceSnapshot(files, 0, "x".repeat(16 * 1024)).snapshot.stdin,
    ).toBe("x".repeat(16 * 1024));
    expect(
      forkWorkspaceSnapshot(files, 0, "x".repeat(16 * 1024 + 1)).snapshot.stdin,
    ).toBe("");
  });

  it("forks a 120 KB workspace partially: open file first, then files that still fit, in order", () => {
    const files = [
      file("a.py", kb(30, "a")),
      file("b.py", kb(40, "b")),
      file("c.py", kb(20, "c")),
      file("d.py", kb(30, "d")),
    ];
    expect(workspaceBytes(files)).toBe(120 * 1024);
    const result = forkWorkspaceSnapshot(files, 1, "");
    expect(result.partial).toBe(true);
    expect(result.copied).toBe(2);
    expect(result.total).toBe(4);
    // b.py (open, 40 KB) is kept first; a.py (30 KB) would pass 64 KB,
    // c.py (20 KB) still fits, d.py does not. Workspace order is kept.
    expect(result.snapshot.files.map((item) => item.name)).toEqual([
      "b.py",
      "c.py",
    ]);
    expect(result.snapshot.activeIndex).toBe(0);
    expect(workspaceBytes(result.snapshot.files)).toBeLessThanOrEqual(
      CODE_MAX_TOTAL_BYTES,
    );
    expect(sanitizeWorkspaceSnapshot(result.snapshot)).toEqual(result.snapshot);
  });

  it("recomputes the active index when earlier files are kept around the open one", () => {
    const files = [
      file("a.py", kb(40, "a")),
      file("b.py", kb(30, "b")),
      file("c.py", kb(20, "c")),
    ];
    const result = forkWorkspaceSnapshot(files, 2, "1\n");
    expect(result.snapshot.files.map((item) => item.name)).toEqual([
      "a.py",
      "c.py",
    ]);
    expect(result.snapshot.activeIndex).toBe(1);
    expect(result.snapshot.files[1]?.content).toBe(kb(20, "c"));
    expect(result.snapshot.stdin).toBe("1\n");
    expect(result).toMatchObject({ copied: 2, partial: true, total: 3 });
  });

  it("keeps a 64 KB open file alone and never throws on odd input", () => {
    const files = [
      file("small.py", "print(1)\n"),
      file("full.py", kb(64, "f")),
      file("tail.py", "print(2)\n"),
    ];
    const result = forkWorkspaceSnapshot(files, 1, "");
    expect(result.snapshot.files.map((item) => item.name)).toEqual(["full.py"]);
    expect(result).toMatchObject({ copied: 1, partial: true, total: 3 });
    expect(result.snapshot.activeIndex).toBe(0);

    // An out-of-range index is clamped to the last file.
    const clamped = forkWorkspaceSnapshot(
      [file("a.py", kb(50, "a")), file("b.py", kb(50, "b"))],
      9,
      "",
    );
    expect(clamped.snapshot.files.map((item) => item.name)).toEqual(["b.py"]);
    expect(clamped.snapshot.activeIndex).toBe(0);

    // More than 8 small files: the draft keeps 8, open file included.
    const many = Array.from({ length: CODE_MAX_FILES + 2 }, (_, index) =>
      file(`f${index}.py`, `print(${index})\n`),
    );
    const capped = forkWorkspaceSnapshot(many, 9, "");
    expect(capped.snapshot.files).toHaveLength(CODE_MAX_FILES);
    expect(capped.snapshot.files[capped.snapshot.activeIndex]?.name).toBe(
      "f9.py",
    );
    expect(capped).toMatchObject({ partial: true, total: CODE_MAX_FILES + 2 });

    expect(forkWorkspaceSnapshot([], 0, "")).toEqual({
      copied: 0,
      partial: false,
      snapshot: { activeIndex: 0, files: [], stdin: "" },
      total: 0,
    });
  });
});
