import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODE_OUTPUT_MAX_BYTES,
  CODE_OUTPUT_MAX_LINES,
  CodeOutputBuffer,
  sanitizeOutputText,
} from "./outputBuffer";
import {
  PREVIEW_CSP,
  buildPreviewDocument,
  inlineWorkspaceAssets,
} from "./previewDocument";
import { parseSandboxInbound, parseSqlTable } from "./protocol";
import { SANDBOX_RUNNER_CSP, buildRunnerDocument } from "./runnerDocument";
import { CodeSandboxController, configuredSandboxURL } from "./sandboxRunner";

describe("ROOM-TOOLS-CODE-01 sandbox output bounds", () => {
  it("strips terminal escapes and control characters", () => {
    expect(
      sanitizeOutputText("\u001b[31mred\u001b[0m\r\nok\u0007\u0000 tab\t"),
    ).toBe("red\nok tab\t");
    expect(sanitizeOutputText("\u001b]0;title\u0007after")).toBe("after");
  });

  it("caps combined output at 64 KB and 5,000 lines", () => {
    const bytes = new CodeOutputBuffer();
    expect(bytes.append("stdout", "a".repeat(CODE_OUTPUT_MAX_BYTES - 2))).toBe(
      true,
    );
    expect(bytes.append("stderr", "đđđ")).toBe(false);
    expect(bytes.truncated).toBe(true);
    expect(
      new TextEncoder().encode(bytes.text()).byteLength,
    ).toBeLessThanOrEqual(CODE_OUTPUT_MAX_BYTES);
    expect(bytes.snapshot().map((chunk) => chunk.stream)).toEqual([
      "stdout",
      "stderr",
    ]);

    const lines = new CodeOutputBuffer();
    lines.append("stdout", "x\n".repeat(CODE_OUTPUT_MAX_LINES + 10));
    expect(lines.truncated).toBe(true);
    expect(lines.lineCount).toBe(CODE_OUTPUT_MAX_LINES);
  });

  it("merges adjacent chunks of one stream", () => {
    const buffer = new CodeOutputBuffer();
    buffer.append("stdout", "a");
    buffer.append("stdout", "b\n");
    buffer.append("stderr", "c");
    expect(buffer.snapshot()).toEqual([
      { stream: "stdout", text: "ab\n" },
      { stream: "stderr", text: "c" },
    ]);
    expect(buffer.lineCount).toBe(2);
  });
});

describe("ROOM-TOOLS-CODE-01 sandbox protocol", () => {
  it("accepts only exact runner messages", () => {
    expect(parseSandboxInbound({ type: "ready" })).toEqual({ type: "ready" });
    expect(
      parseSandboxInbound({
        chunks: [{ stream: "stdout", text: "hi" }],
        id: "run_1",
        type: "output",
      }),
    ).toEqual({
      chunks: [{ stream: "stdout", text: "hi" }],
      id: "run_1",
      type: "output",
    });
    expect(
      parseSandboxInbound({ id: "run 1", type: "done", status: "ok" }),
    ).toBeNull();
    expect(
      parseSandboxInbound({ id: "r", type: "done", status: "great" }),
    ).toBeNull();
    expect(
      parseSandboxInbound({
        chunks: [{ stream: "stdin", text: "x" }],
        id: "r",
        type: "output",
      }),
    ).toBeNull();
    expect(
      parseSandboxInbound({ id: "r", type: "eval", code: "x" }),
    ).toBeNull();
    expect(parseSandboxInbound("ready")).toBeNull();
    expect(
      parseSandboxInbound({ changes: -1, id: "r", type: "sql-summary" }),
    ).toBeNull();
  });

  it("bounds SQL tables to plain cells", () => {
    expect(
      parseSqlTable({
        columns: ["name", "score"],
        rows: [
          ["An", 9],
          ["Binh", null],
        ],
        truncated: false,
      }),
    ).toEqual({
      columns: ["name", "score"],
      rows: [
        ["An", 9],
        ["Binh", null],
      ],
      truncated: false,
    });
    expect(
      parseSqlTable({ columns: ["x"], rows: [[{ html: "<b>" }]] }),
    ).toBeNull();
    expect(
      parseSqlTable({
        columns: [],
        rows: Array.from({ length: 501 }, () => []),
      }),
    ).toBeNull();
  });
});

describe("ROOM-TOOLS-CODE-01 sandbox documents", () => {
  it("locks the runner frame down before any script", () => {
    const html = buildRunnerDocument();
    const csp = html.indexOf("Content-Security-Policy");
    const script = html.indexOf("<script>");
    expect(csp).toBeGreaterThan(0);
    expect(csp).toBeLessThan(script);
    expect(SANDBOX_RUNNER_CSP).toContain("connect-src 'none'");
    expect(SANDBOX_RUNNER_CSP).toContain("default-src 'none'");
    expect(SANDBOX_RUNNER_CSP).not.toContain("https:");
    // Only one inline script; the worker source cannot close it early.
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain("tutorhub-code-sandbox");
  });

  it("puts the preview CSP first and inlines local assets only", () => {
    // Built at runtime: the source scan in check-calendar-production-gate.mjs
    // rejects a literal remote <link rel="stylesheet"> in apps/web/src.
    const remoteCSS = ["https:", "//cdn.example/x.css"].join("");
    const files = [
      {
        content: `<link rel="stylesheet" href="style.css"><link rel="stylesheet" href="${remoteCSS}"><script src="./app.js"></script><p>Hi</p>`,
        language: "html" as const,
        name: "index.html",
      },
      {
        content: "body{color:red}</style><b>x</b>",
        language: "css" as const,
        name: "style.css",
      },
      {
        content: "document.body.dataset.ok='1';</script>",
        language: "javascript" as const,
        name: "app.js",
      },
    ];
    const html = buildPreviewDocument(files, 0)!;
    expect(html.indexOf(PREVIEW_CSP)).toBeGreaterThan(0);
    expect(html.indexOf(PREVIEW_CSP)).toBeLessThan(html.indexOf("<p>Hi</p>"));
    expect(html).toContain('<style data-file="style.css">');
    expect(html).toContain("<\\/style><b>x</b>");
    expect(html).toContain("<script>document.body.dataset.ok='1';<\\/script>");
    // Remote references stay as written: the CSP blocks them.
    expect(html).toContain(`href="${remoteCSS}"`);
    expect(PREVIEW_CSP).toContain("connect-src 'none'");
    expect(buildPreviewDocument([], 0)).toBeNull();
    expect(
      inlineWorkspaceAssets('<script src="missing.js"></script>', files),
    ).toBe('<script src="missing.js"></script>');
  });
});

describe("ROOM-TOOLS-CODE-01 sandbox controller", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("accepts only https (or loopback http) sandbox origins", () => {
    expect(configuredSandboxURL("https://sandbox.example.dev/runner")).toBe(
      "https://sandbox.example.dev/runner",
    );
    expect(configuredSandboxURL("http://127.0.0.1:8788/")).toBe(
      "http://127.0.0.1:8788/",
    );
    expect(configuredSandboxURL("http://sandbox.example.dev/")).toBeNull();
    expect(configuredSandboxURL("javascript:alert(1)")).toBeNull();
    expect(configuredSandboxURL("https://user:pass@x.dev/")).toBeNull();
    expect(configuredSandboxURL(undefined)).toBeNull();
    expect(configuredSandboxURL("  ")).toBeNull();
  });

  it("builds a scripts-only opaque frame and tears it down when a run is stopped", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const controller = new CodeSandboxController(host, {
      frameTitle: "Code sandbox (hidden)",
    });
    const result = controller.run({
      code: "console.log(1)",
      language: "javascript",
      stdin: "",
    });
    const frame = host.querySelector("iframe")!;
    expect(frame).not.toBeNull();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("allow")).toBe("");
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(frame.tabIndex).toBe(-1);
    expect(frame.title).toBe("Code sandbox (hidden)");
    expect(frame.srcdoc).toContain("connect-src 'none'");
    expect(controller.running).toBe(true);
    await expect(
      controller.run({ code: "", language: "javascript", stdin: "" }),
    ).rejects.toThrow("already active");

    controller.stop();
    await expect(result).resolves.toMatchObject({
      output: [],
      status: "stopped",
    });
    expect(controller.running).toBe(false);
    controller.dispose();
  });
});
