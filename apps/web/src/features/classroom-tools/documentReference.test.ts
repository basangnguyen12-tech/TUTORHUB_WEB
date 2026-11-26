import { describe, expect, it } from "vitest";
import { splitChatCodeBlocks } from "./codeFence";
import {
  formatDocumentReference,
  parseDocumentReference,
} from "./documentReference";

const fileId = "67dbe834-9de8-4a86-9fe8-364a2cda48a3";
const reference = {
  fileId,
  name: "Bài tập.pdf",
  page: 3,
  mediaType: "application/pdf",
};

describe("Chat document references", () => {
  it("round trips Unicode and supports a teacher's surrounding instructions", () => {
    const block = formatDocumentReference(
      fileId,
      "Bài\ntập.pdf",
      3,
      "application/pdf",
    );
    expect(splitChatCodeBlocks(`Xem đề\n${block}\nCâu 2`)).toEqual([
      { kind: "text", text: "Xem đề" },
      { kind: "document", reference },
      { kind: "text", text: "Câu 2" },
    ]);
    const long = formatDocumentReference(
      fileId,
      "📝".repeat(170),
      300,
      "image/webp",
    );
    expect(long).toContain("📝".repeat(160));
    expect(long).not.toContain("📝".repeat(161));
  });
  it("never formats a filename containing a URL as part of the card", () => {
    expect(
      formatDocumentReference(
        fileId,
        "https://private.example/file?signature=secret",
        1,
        "application/pdf",
      ),
    ).not.toMatch(/https|private|signature|secret/iu);
  });
  it.each([
    { ...reference, fileId: "chat:123" },
    { ...reference, page: 0 },
    { ...reference, page: 301 },
    { ...reference, page: 1.5 },
    { ...reference, mediaType: "image/svg+xml" },
    { ...reference, name: "https://invalid.example" },
    { ...reference, name: "a\nb" },
    { ...reference, name: "x".repeat(161) },
    { ...reference, url: "https://example.com" },
  ])("keeps invalid reference content inert", (input) => {
    const body = JSON.stringify(input);
    const text = ["```tutorhub-doc", body, "```"].join("\n");
    expect(parseDocumentReference(body)).toBeNull();
    expect(splitChatCodeBlocks(text)).toEqual([{ kind: "literal", text }]);
  });
  it("rejects duplicate JSON fields and malformed JSON", () => {
    const incomplete = "```tutorhub-doc\nhttps://private.example/?x";
    expect(splitChatCodeBlocks(incomplete)).toEqual([
      { kind: "literal", text: incomplete },
    ]);
    expect(
      parseDocumentReference(
        JSON.stringify(reference).replace(
          '{"fileId"',
          '{"name":"https://private.example","fileId"',
        ),
      ),
    ).toBeNull();
    expect(parseDocumentReference("{")).toBeNull();
  });
});
