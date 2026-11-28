import { describe, expect, it } from "vitest";
import {
  CHAT_TEXT_COLORS,
  CHAT_TEXT_SIZES,
  type ChatDocument,
  type ChatInlineStyle,
  type ChatLine,
  chatDocumentsEqual,
  chatMarkupHasFormatting,
  chatMarkupToPlainText,
  normalizeChatDocument,
  parseChatInline,
  parseChatMarkup,
  serializeChatDocument,
} from "./chatMarkup";

const text = (value: string, style: ChatInlineStyle = {}) => ({
  style,
  text: value,
});
const line = (
  runs: ChatLine["runs"],
  overrides: Partial<ChatLine> = {},
): ChatLine => ({
  align: "left",
  kind: "text",
  ordinal: 0,
  runs,
  ...overrides,
});

describe("parseChatInline", () => {
  it("reads bold, italic, underline and strike delimiters", () => {
    expect(
      parseChatInline("**đậm** *nghiêng* [gạch]{.underline} ~~xoá~~"),
    ).toEqual([
      text("đậm", { bold: true }),
      text(" "),
      text("nghiêng", { italic: true }),
      text(" "),
      text("gạch", { underline: true }),
      text(" "),
      text("xoá", { strike: true }),
    ]);
  });

  it("nests bold and italic", () => {
    expect(parseChatInline("***cả hai***")).toEqual([
      text("cả hai", { bold: true, italic: true }),
    ]);
  });

  it("keeps arithmetic, snake_case and loose delimiters literal", () => {
    for (const value of [
      "2*3*4 = 24",
      "a**b**c",
      "file__name__v2",
      "def __init__(self):",
      "f(*args, **kwargs)",
      "int *p = *q;",
      "x * y * z",
      "** not bold **",
      "~~",
      "*",
    ]) {
      expect(parseChatInline(value)).toEqual([text(value)]);
    }
  });

  it("never formats inside URLs", () => {
    for (const value of [
      "https://example.com/a__b__/c",
      "xem https://example.com/~~a~~/ nhé",
      "https://example.com/*x*",
    ]) {
      expect(parseChatInline(value)).toEqual([text(value)]);
    }
  });

  it("reads colour and size spans with known classes only", () => {
    expect(parseChatInline("[Hạn nộp]{.red .large} hôm nay")).toEqual([
      text("Hạn nộp", { color: "red", size: "large" }),
      text(" hôm nay"),
    ]);
    expect(parseChatInline("[x]{.evil}")).toEqual([text("[x]{.evil}")]);
    expect(parseChatInline("[x]{.red .blue}")).toEqual([
      text("[x]{.red .blue}"),
    ]);
    expect(parseChatInline("[Toán] bài 1")).toEqual([text("[Toán] bài 1")]);
    expect(parseChatInline("[a]{.bold}b")).toEqual([
      text("a", { bold: true }),
      text("b"),
    ]);
  });

  it("treats backslash escapes as literal characters", () => {
    expect(parseChatInline("\\*\\*không đậm\\*\\*")).toEqual([
      text("**không đậm**"),
    ]);
    expect(parseChatInline("C:\\Users")).toEqual([text("C:\\Users")]);
  });
});

describe("parseChatMarkup", () => {
  it("keeps ordinary messages as one plain line each", () => {
    const document = parseChatMarkup("Xin chào\nlớp 10A");
    expect(document.lines).toEqual([
      line([text("Xin chào")]),
      line([text("lớp 10A")]),
    ]);
    expect(chatMarkupHasFormatting("Xin chào\nlớp 10A")).toBe(false);
  });

  it("reads bulleted and numbered lines and renumbers a run", () => {
    const document = parseChatMarkup("- táo\n- cam\n3. một\n3. hai\nhết");
    expect(document.lines.map((item) => [item.kind, item.ordinal])).toEqual([
      ["bullet", 0],
      ["bullet", 0],
      ["number", 3],
      ["number", 4],
      ["text", 0],
    ]);
  });

  it("aligns fenced blocks and leaves unclosed fences literal", () => {
    const document = parseChatMarkup("::: center\nChúc mừng\n- quà\n:::\nhết");
    expect(document.lines.map((item) => [item.align, item.kind])).toEqual([
      ["center", "text"],
      ["center", "bullet"],
      ["left", "text"],
    ]);
    expect(parseChatMarkup("::: right\nkhông đóng").lines).toEqual([
      line([text("::: right")]),
      line([text("không đóng")]),
    ]);
  });

  it("reads escaped line prefixes as text", () => {
    expect(parseChatMarkup("\\- không phải danh sách").lines).toEqual([
      line([text("- không phải danh sách")]),
    ]);
    expect(parseChatMarkup("2\\. không đánh số").lines).toEqual([
      line([text("2. không đánh số")]),
    ]);
  });

  it("never formats fenced code", () => {
    const document = parseChatMarkup("```py\n- **x** = 2*y\n```\n**sau**");
    expect(document.lines.slice(0, 3)).toEqual([
      line([text("```py")]),
      line([text("- **x** = 2*y")]),
      line([text("```")]),
    ]);
    expect(document.lines[3]?.runs).toEqual([text("sau", { bold: true })]);
  });
});

describe("chatMarkupToPlainText", () => {
  it("strips markup for previews and quotes", () => {
    expect(
      chatMarkupToPlainText(
        "::: center\n**Thông báo**\n:::\n- [Thứ Sáu]{.red}\n1. nộp bài",
      ),
    ).toBe("Thông báo\n- Thứ Sáu\n1. nộp bài");
    expect(chatMarkupToPlainText("chỉ là chữ")).toBe("chỉ là chữ");
  });
});

describe("serializeChatDocument", () => {
  it("prefers readable delimiters", () => {
    expect(
      serializeChatDocument({
        lines: [line([text("Hạn nộp "), text("thứ Sáu", { bold: true })])],
      }),
    ).toBe("Hạn nộp **thứ Sáu**");
  });

  it("falls back to spans inside a word", () => {
    expect(
      serializeChatDocument({
        lines: [line([text("Xin", { bold: true }), text("chào")])],
      }),
    ).toBe("[Xin]{.bold}chào");
  });

  it("keeps literal text literal", () => {
    expect(serializeChatDocument({ lines: [line([text("2*3*4")])] })).toBe(
      "2*3*4",
    );
    const literal = serializeChatDocument({
      lines: [line([text("**không đậm**")])],
    });
    expect(literal).toBe("\\*\\*không đậm\\*\\*");
    expect(parseChatMarkup(literal).lines[0]?.runs).toEqual([
      text("**không đậm**"),
    ]);
  });

  it("writes lists, fences and trims blank edges", () => {
    expect(
      serializeChatDocument({
        lines: [
          line([]),
          line([text("Tiêu đề", { bold: true })], { align: "center" }),
          line([text("một")], { kind: "number", ordinal: 1 }),
          line([text("hai")], { kind: "number", ordinal: 1 }),
          line([text("- không phải danh sách")]),
          line([]),
        ],
      }),
    ).toBe(
      "::: center\n**Tiêu đề**\n:::\n1. một\n2. hai\n\\- không phải danh sách",
    );
  });

  it("round-trips arbitrary documents", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const pick = <T>(items: readonly T[]) =>
      items[Math.floor(random() * items.length)] as T;
    const fragments = [
      "a",
      "bé",
      " ",
      "*",
      "**",
      "_",
      "__",
      "~",
      "~~",
      "[",
      "]",
      "{.red}",
      "\\",
      "- ",
      "1. ",
      ":::",
      "https://x.vn/a_b",
      "2*3",
      "Ừ",
      "😀",
    ];
    for (let attempt = 0; attempt < 3000; attempt += 1) {
      const lines: ChatLine[] = [];
      const lineCount = 1 + Math.floor(random() * 4);
      for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
        const runs = [];
        const runCount = Math.floor(random() * 4);
        for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
          let value = "";
          const pieces = 1 + Math.floor(random() * 3);
          for (let piece = 0; piece < pieces; piece += 1) {
            value += pick(fragments);
          }
          runs.push(
            text(value, {
              bold: random() < 0.3,
              color: random() < 0.2 ? pick(CHAT_TEXT_COLORS) : undefined,
              italic: random() < 0.3,
              size: random() < 0.15 ? pick(CHAT_TEXT_SIZES) : undefined,
              strike: random() < 0.15,
              underline: random() < 0.2,
            }),
          );
        }
        const kind = pick(["text", "text", "bullet", "number"] as const);
        lines.push(
          line(runs, {
            align: pick(["left", "left", "center", "right"] as const),
            kind,
            ordinal: kind === "number" ? 1 + Math.floor(random() * 3) : 0,
          }),
        );
      }
      const document: ChatDocument = { lines };
      const markup = serializeChatDocument(document);
      const parsed = parseChatMarkup(markup);
      if (!chatDocumentsEqual(parsed, document)) {
        throw new Error(
          `Round-trip failed for ${JSON.stringify(markup)}:\n${JSON.stringify(
            normalizeChatDocument(document),
          )}\n${JSON.stringify(normalizeChatDocument(parsed))}`,
        );
      }
    }
  });
});
