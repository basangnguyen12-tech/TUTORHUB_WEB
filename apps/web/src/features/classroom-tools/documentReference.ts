import type { RoomDocumentMediaType } from "@tutorhub/api-client";

export interface ChatDocumentReference {
  readonly fileId: string;
  readonly name: string;
  readonly page: number;
  readonly mediaType: RoomDocumentMediaType;
}

export function isRoomDocumentID(value: string): boolean {
  return (
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) &&
    value !== "00000000-0000-0000-0000-000000000000"
  );
}

export function supportsChatDocument(
  type: string,
): type is RoomDocumentMediaType {
  return (
    type === "application/pdf" ||
    type === "image/jpeg" ||
    type === "image/png" ||
    type === "image/webp"
  );
}

// Names are labels, never paths, links, query strings or Markdown syntax.
function safeName(raw: string): string {
  const name = raw.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (/[\p{Cc}\p{Cf}\\/:`?&#%]/u.test(name) || /\bwww\./iu.test(name))
    return "";
  return Array.from(name).slice(0, 160).join("").trimEnd();
}

export function parseDocumentReference(
  body: string,
): ChatDocumentReference | null {
  // JSON.parse silently overwrites duplicate keys. Reject their original payload too.
  if (
    body.length > 2000 ||
    Array.from(body.matchAll(/"(?:\\.|[^"\\])*"\s*:/g)).length !== 4
  )
    return null;
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const fields = value as Record<string, unknown>;
    const { fileId, name, page, mediaType } = fields;
    if (
      Object.keys(fields).length !== 4 ||
      typeof fileId !== "string" ||
      !isRoomDocumentID(fileId) ||
      typeof name !== "string" ||
      !name ||
      safeName(name) !== name ||
      typeof page !== "number" ||
      !Number.isInteger(page) ||
      page < 1 ||
      page > 300 ||
      typeof mediaType !== "string" ||
      !supportsChatDocument(mediaType)
    )
      return null;
    return { fileId: fileId.toLowerCase(), name, page, mediaType };
  } catch {
    return null;
  }
}

export function formatDocumentReference(
  fileId: string,
  name: string,
  page: number,
  mediaType: string,
): string | null {
  const body = JSON.stringify({
    fileId,
    name: safeName(name) || (mediaType === "application/pdf" ? "PDF" : "Image"),
    page,
    mediaType,
  });
  return parseDocumentReference(body)
    ? ["```tutorhub-doc", body, "```"].join("\n")
    : null;
}
