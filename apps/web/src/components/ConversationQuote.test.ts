import { describe, expect, it } from "vitest";
import {
  QUOTE_EXCERPT_MAX_CHARACTERS,
  buildQuotedReply,
  parseQuotedMessage,
  quoteExcerpt,
  rebuildQuotedContent,
  sanitizeQuoteAuthor,
} from "./ConversationQuote";

describe("ConversationQuote (MSG-CLASSIN-TEAMS-01)", () => {
  it("builds the plain-text reply header and parses it back", () => {
    const content = buildQuotedReply(
      { authorName: "Tuấn Kiệt", excerpt: "Dạ mình\nhọc sinh  " },
      "dạ em cảm ơn anh",
    );
    expect(content).toBe("> Tuấn Kiệt: Dạ mình học sinh\n\ndạ em cảm ơn anh");
    expect(parseQuotedMessage(content)).toEqual({
      quote: {
        author: "Tuấn Kiệt",
        text: "Dạ mình học sinh",
        raw: "> Tuấn Kiệt: Dạ mình học sinh",
      },
      body: "dạ em cảm ơn anh",
    });
  });

  it("leaves ordinary messages and look-alikes untouched", () => {
    for (const content of [
      "Persistent teacher message",
      ">_< oops",
      "> only a quote, no body",
      "",
    ]) {
      expect(parseQuotedMessage(content)).toEqual({
        quote: null,
        body: content,
      });
    }
  });

  it("keeps multi-line quotes and quotes without an author", () => {
    const parsed = parseQuotedMessage("> line one\n> line two\nreply");
    expect(parsed.quote).toEqual({
      author: null,
      text: "line one\nline two",
      raw: "> line one\n> line two",
    });
    expect(parsed.body).toBe("reply");
  });

  it("never nests a previous quote in a new excerpt and truncates long text", () => {
    expect(quoteExcerpt("> A: older\n\nnew   answer\nline")).toBe(
      "new answer line",
    );
    const excerpt = quoteExcerpt("x".repeat(200));
    expect([...excerpt]).toHaveLength(QUOTE_EXCERPT_MAX_CHARACTERS);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("sanitizes author names so the header always parses", () => {
    expect(sanitizeQuoteAuthor(">> Admin: GVCN\nx")).toBe("Admin:GVCN x");
    const content = buildQuotedReply(
      { authorName: "Admin: GVCN", excerpt: "Chào cả lớp" },
      "Dạ",
    );
    expect(parseQuotedMessage(content).quote?.author).toBe("Admin:GVCN");
  });

  it("re-attaches the verbatim quote block after editing the body", () => {
    const parsed = parseQuotedMessage("> Lan: Hỏi bài\n\nTrả lời cũ");
    expect(rebuildQuotedContent(parsed.quote, "Trả lời mới")).toBe(
      "> Lan: Hỏi bài\n\nTrả lời mới",
    );
    expect(rebuildQuotedContent(null, "Chỉ thân")).toBe("Chỉ thân");
  });
});
