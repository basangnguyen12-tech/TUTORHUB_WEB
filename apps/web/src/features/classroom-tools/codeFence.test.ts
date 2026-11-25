import { describe, expect, it } from "vitest";
import {
  buildCodeFence,
  hasChatCodeBlock,
  splitChatCodeBlocks,
} from "./codeFence";
import { languageForFence, languageForFileName } from "./codeLanguages";

describe("ROOM-TOOLS-CODE-01 chat code fences", () => {
  it("splits text and fenced blocks without interpreting HTML", () => {
    const content = [
      "Try this:",
      "```py",
      "print('<img src=x onerror=alert(1)>')",
      "```",
      "and then this",
      "```",
      "no tag",
      "```",
    ].join("\n");
    expect(splitChatCodeBlocks(content)).toEqual([
      { kind: "text", text: "Try this:" },
      {
        code: "print('<img src=x onerror=alert(1)>')",
        kind: "code",
        language: "python",
        tag: "py",
      },
      { kind: "text", text: "and then this" },
      { code: "no tag", kind: "code", language: null, tag: "" },
    ]);
    expect(hasChatCodeBlock(content)).toBe(true);
  });

  it("keeps plain messages and unclosed fences as text", () => {
    expect(splitChatCodeBlocks("hello")).toEqual([
      { kind: "text", text: "hello" },
    ]);
    const unclosed = "```js\nconsole.log(1)";
    expect(splitChatCodeBlocks(unclosed)).toEqual([
      { kind: "text", text: unclosed },
    ]);
    expect(hasChatCodeBlock("inline `code` only")).toBe(false);
  });

  it("reads a longer fence that wraps triple backticks", () => {
    const code = "const md = '```';\nconsole.log(md);";
    const fence = buildCodeFence("javascript", code, 4_000);
    expect(fence).toEqual({
      text: `\`\`\`\`javascript\n${code}\n\`\`\`\``,
      truncated: false,
    });
    expect(splitChatCodeBlocks(fence.text)).toEqual([
      { code, kind: "code", language: "javascript", tag: "javascript" },
    ]);
  });

  it("cuts long code at a line boundary within the message budget", () => {
    const code = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const fence = buildCodeFence("python", `${code}\r\n\n`, 120);
    expect(fence.truncated).toBe(true);
    expect(Array.from(fence.text).length).toBeLessThanOrEqual(120);
    expect(fence.text.startsWith("```python\nline 0\nline 1")).toBe(true);
    expect(fence.text.endsWith("\n```")).toBe(true);
    expect(buildCodeFence("sql", "SELECT 1;\n", 4_000)).toEqual({
      text: "```sql\nSELECT 1;\n```",
      truncated: false,
    });
  });

  it("maps fence tags and file names to languages", () => {
    expect(languageForFence("C++")).toBe("cpp");
    expect(languageForFence("ts")).toBe("typescript");
    expect(languageForFence("brainfuck")).toBeNull();
    expect(languageForFileName("Main.java")).toBe("java");
    expect(languageForFileName("style.CSS")).toBe("css");
    expect(languageForFileName("README")).toBeNull();
  });
});
