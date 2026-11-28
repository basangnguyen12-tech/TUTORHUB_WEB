import type { MessageAttachment, Sticker } from "@tutorhub/api-client";
import type { TranslationKey } from "../../app/i18n";
import {
  CHAT_EMOJI_RECENT_STORAGE_PREFIX,
  CHAT_STICKER_RECENT_STORAGE_PREFIX,
} from "../../app/session";

/**
 * ROOM-CHAT-01 (ADR-0042) client helpers for classroom chat media.
 *
 * The server is the authority for every bound and allowlist; these checks
 * only give fast, friendly feedback before an upload starts.
 */

export const CHAT_MAX_MESSAGE_CHARACTERS = 4_000;
export const CHAT_COUNTER_THRESHOLD = 3_500;
export const CHAT_MAX_ATTACHMENTS = 4;
export const CHAT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const CHAT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const CHAT_IMAGE_MAX_EDGE = 2_048;

export const CHAT_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

const imageExtensions: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** Lesson-file extensions the server accepts (ADR-0042 allowlist). */
export const CHAT_FILE_EXTENSIONS = [
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "txt",
  "csv",
  "md",
  "zip",
] as const;

export const CHAT_IMAGE_ACCEPT = CHAT_IMAGE_TYPES.join(",");
export const CHAT_FILE_ACCEPT = [
  ...CHAT_FILE_EXTENSIONS.map((extension) => `.${extension}`),
  ...CHAT_IMAGE_TYPES,
].join(",");

export type ChatAttachmentKind = "image" | "file";
export type ChatFileProblem = "type" | "size";

export type ChatFileCheck =
  | { ok: true; kind: ChatAttachmentKind; mediaType: string }
  | { ok: false; problem: ChatFileProblem };

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** Classifies a picked, pasted or dropped file before upload. */
export function checkChatFile(file: Pick<File, "name" | "size" | "type">) {
  const extension = fileExtension(file.name);
  const declared = file.type.toLowerCase();
  const imageType = (CHAT_IMAGE_TYPES as readonly string[]).includes(declared)
    ? declared
    : imageExtensions[extension];
  if (declared === "image/svg+xml" || extension === "svg") {
    return { ok: false, problem: "type" } satisfies ChatFileCheck;
  }
  if (imageType) {
    if (file.size <= 0) return { ok: false, problem: "type" } as const;
    if (file.size > CHAT_MAX_IMAGE_BYTES) {
      return { ok: false, problem: "size" } satisfies ChatFileCheck;
    }
    return {
      ok: true,
      kind: "image",
      mediaType: imageType,
    } satisfies ChatFileCheck;
  }
  if (!(CHAT_FILE_EXTENSIONS as readonly string[]).includes(extension)) {
    return { ok: false, problem: "type" } satisfies ChatFileCheck;
  }
  if (file.size <= 0) return { ok: false, problem: "type" } as const;
  if (file.size > CHAT_MAX_FILE_BYTES) {
    return { ok: false, problem: "size" } satisfies ChatFileCheck;
  }
  return {
    ok: true,
    kind: "file",
    mediaType: declared || "application/octet-stream",
  } satisfies ChatFileCheck;
}

/** Short badge for a file card: PDF, DOCX, XLSX, PPTX, ZIP, TXT … */
export function fileTypeLabel(name: string, mediaType = ""): string {
  const extension = fileExtension(name);
  if (extension) return extension.slice(0, 4).toUpperCase();
  if (mediaType === "application/pdf") return "PDF";
  return "FILE";
}

export function formatAttachmentSize(bytes: number, language: "vi" | "en") {
  const locale = language === "vi" ? "vi-VN" : "en-US";
  if (bytes < 1024) {
    return `${new Intl.NumberFormat(locale).format(bytes)} B`;
  }
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) {
    return `${new Intl.NumberFormat(locale, {
      maximumFractionDigits: kilobytes < 10 ? 1 : 0,
    }).format(kilobytes)} KB`;
  }
  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
  }).format(kilobytes / 1024)} MB`;
}

export interface PreparedChatImage {
  blob: Blob;
  fileName: string;
  height: number;
  width: number;
}

interface DecodedImage {
  height: number;
  source: CanvasImageSource;
  width: number;
  release: () => void;
}

async function decodeImage(file: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
    });
    return {
      height: bitmap.height,
      source: bitmap,
      width: bitmap.width,
      release: () => bitmap.close(),
    };
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    return {
      height: image.naturalHeight,
      source: image,
      width: image.naturalWidth,
      release: () => undefined,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob && blob.size > 0
          ? resolve(blob)
          : reject(new Error("Image re-encoding failed.")),
      type,
      quality,
    );
  });
}

function withExtension(name: string, extension: string) {
  const dot = name.lastIndexOf(".");
  const base = (dot > 0 ? name.slice(0, dot) : name).trim() || "image";
  return `${base}.${extension}`;
}

/**
 * Redraws a still image through a canvas (longest edge at most 2048px) so
 * EXIF, GPS and other metadata never leave the device. Animated GIFs are
 * kept byte-for-byte within the 5 MiB bound.
 */
export async function prepareChatImage(
  file: File,
  mediaType: string,
): Promise<PreparedChatImage> {
  const decoded = await decodeImage(file);
  try {
    if (mediaType === "image/gif") {
      return {
        blob: file,
        fileName: file.name || "image.gif",
        height: decoded.height,
        width: decoded.width,
      };
    }
    const scale = Math.min(
      1,
      CHAT_IMAGE_MAX_EDGE / Math.max(decoded.width, decoded.height, 1),
    );
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable.");
    context.drawImage(decoded.source, 0, 0, width, height);
    const outputType =
      mediaType === "image/png" || mediaType === "image/webp"
        ? mediaType
        : "image/jpeg";
    const blob = await canvasToBlob(canvas, outputType, 0.9);
    const extension =
      outputType === "image/png"
        ? "png"
        : outputType === "image/webp"
          ? "webp"
          : "jpg";
    if (blob.size > CHAT_MAX_IMAGE_BYTES) {
      throw new RangeError("Re-encoded image is too large.");
    }
    return {
      blob,
      fileName: withExtension(file.name || "image", extension),
      height,
      width,
    };
  } finally {
    decoded.release();
  }
}

const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
const REGIONAL_INDICATOR = /^\p{Regional_Indicator}$/u;
const EMOJI_MODIFIER = /^\p{Emoji_Modifier}$/u;
const KEYCAP_BASE = /^[0-9#*]$/u;
const ZERO_WIDTH_JOINER = String.fromCodePoint(0x200d);
const VARIATION_SELECTOR_16 = String.fromCodePoint(0xfe0f);
const KEYCAP_MARK = String.fromCodePoint(0x20e3);

function isTagCharacter(character: string) {
  const code = character.codePointAt(0) ?? 0;
  return code >= 0xe0020 && code <= 0xe007f;
}

/**
 * Counts user-perceived emoji (ZWJ families, skin tones, flags, keycaps,
 * tag flags) without a grapheme splitter; returns null when any other
 * character appears.
 */
function countEmojiClusters(text: string): number | null {
  const characters = Array.from(text);
  let count = 0;
  let index = 0;
  while (index < characters.length) {
    const character = characters[index] ?? "";
    if (REGIONAL_INDICATOR.test(character)) {
      const next = characters[index + 1] ?? "";
      index += REGIONAL_INDICATOR.test(next) ? 2 : 1;
      count += 1;
      continue;
    }
    if (KEYCAP_BASE.test(character)) {
      let cursor = index + 1;
      if (characters[cursor] === VARIATION_SELECTOR_16) cursor += 1;
      if (characters[cursor] !== KEYCAP_MARK) return null;
      index = cursor + 1;
      count += 1;
      continue;
    }
    if (!PICTOGRAPHIC.test(character)) return null;
    index += 1;
    while (index < characters.length) {
      const next = characters[index] ?? "";
      if (
        next === VARIATION_SELECTOR_16 ||
        EMOJI_MODIFIER.test(next) ||
        isTagCharacter(next)
      ) {
        index += 1;
        continue;
      }
      if (
        next === ZERO_WIDTH_JOINER &&
        PICTOGRAPHIC.test(characters[index + 1] ?? "")
      ) {
        index += 2;
        continue;
      }
      break;
    }
    count += 1;
  }
  return count;
}

/** True for a message of only 1–3 emoji (whitespace ignored). */
export function isJumboEmoji(text: string): boolean {
  const compact = text.replace(/\s+/gu, "");
  if (!compact || compact.length > 64) return false;
  const count = countEmojiClusters(compact);
  return count !== null && count >= 1 && count <= 3;
}

export type ChatTextPiece =
  | { kind: "text"; text: string }
  | { kind: "link"; href: string; text: string }
  | { kind: "mention"; text: string };

export type ChatMentionPiece =
  { kind: "text"; text: string } | { kind: "mention"; text: string };

const linkPattern = /https?:\/\/[^\s<>"']+/giu;
const trailingPunctuation = /[.,;:!?)\]}'"»”’]+$/u;
const MENTION_NAME_MAX_LENGTH = 200;
/** A mention never starts inside a word ("user@example.com"). */
const mentionWordCharacter = /[\p{L}\p{M}\p{N}_.+-]/u;
/** A name ends where a word ends ("@An" is not a prefix of "@Anh"). */
const nameContinuation = /[\p{L}\p{M}\p{N}_]/u;

/**
 * MSG-MENTION-BLUE-01: distinct member names, longest first, so "@Nguyễn Văn
 * An" wins over "@Nguyễn Văn". Blank and oversized names are dropped.
 */
export function chatMentionNames(
  names: Iterable<string | null | undefined>,
): string[] {
  const unique = new Set<string>();
  for (const raw of names) {
    const name = raw?.trim();
    if (name && name.length <= MENTION_NAME_MAX_LENGTH) unique.add(name);
  }
  return [...unique].sort(
    (left, right) => right.length - left.length || left.localeCompare(right),
  );
}

/**
 * Splits plain text into text and `@Name` pieces for known member names
 * (sorted longest first by `chatMentionNames`). Only whole names directly
 * after "@" match, and only when "@" does not continue a word.
 */
export function splitChatMentions(
  text: string,
  names: readonly string[],
): ChatMentionPiece[] {
  if (names.length === 0 || !text.includes("@")) {
    return text ? [{ kind: "text", text }] : [];
  }
  const pieces: ChatMentionPiece[] = [];
  let cursor = 0;
  let index = text.indexOf("@");
  while (index >= 0) {
    const before = index > 0 ? text.charAt(index - 1) : "";
    let matched: string | null = null;
    if (!before || !mentionWordCharacter.test(before)) {
      for (const name of names) {
        if (!text.startsWith(name, index + 1)) continue;
        const after = text.charAt(index + 1 + name.length);
        if (after && nameContinuation.test(after)) continue;
        matched = name;
        break;
      }
    }
    if (matched) {
      if (index > cursor) {
        pieces.push({ kind: "text", text: text.slice(cursor, index) });
      }
      const end = index + 1 + matched.length;
      pieces.push({ kind: "mention", text: text.slice(index, end) });
      cursor = end;
      index = text.indexOf("@", end);
    } else {
      index = text.indexOf("@", index + 1);
    }
  }
  if (cursor < text.length) {
    pieces.push({ kind: "text", text: text.slice(cursor) });
  }
  return pieces;
}

/**
 * Splits plain text into text, safe http(s) link and (with member names)
 * `@Name` mention pieces. Mentions are only looked for outside links.
 */
export function linkifyChatText(
  text: string,
  mentionNames: readonly string[] = [],
): ChatTextPiece[] {
  const pieces: ChatTextPiece[] = [];
  const pushText = (value: string) => {
    if (!value) return;
    for (const piece of splitChatMentions(value, mentionNames)) {
      pieces.push(piece);
    }
  };
  let cursor = 0;
  for (const match of text.matchAll(linkPattern)) {
    const start = match.index ?? 0;
    let candidate = match[0];
    const trailing = candidate.match(trailingPunctuation)?.[0] ?? "";
    if (trailing) candidate = candidate.slice(0, -trailing.length);
    let href: string | null = null;
    try {
      const url = new URL(candidate);
      if (url.protocol === "http:" || url.protocol === "https:") {
        href = url.href;
      }
    } catch {
      href = null;
    }
    if (!href) continue;
    if (start > cursor) {
      pushText(text.slice(cursor, start));
    }
    pieces.push({ kind: "link", href, text: candidate });
    cursor = start + candidate.length;
  }
  if (cursor < text.length) {
    pushText(text.slice(cursor));
  }
  return pieces;
}

/** Stable 0–5 medallion tone shared with the room's camera-off avatars. */
export function chatAvatarTone(name: string): number {
  let hash = 0;
  for (const character of name) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  }
  return hash % 6;
}

export function chatInitials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return "?";
  const first = Array.from(words[0] ?? "")[0] ?? "";
  const last =
    words.length > 1
      ? (Array.from(words[words.length - 1] ?? "")[0] ?? "")
      : "";
  return `${first}${last}`.toLocaleUpperCase();
}

export function createClientID(): string {
  return crypto.randomUUID();
}

/**
 * Revocable object-URL cache keyed by (tenant, attachment). Each scope owns
 * one cache and revokes every URL when it unmounts or the scope changes, so
 * attachment bytes never outlive the room view.
 */
export interface AttachmentObjectURLCache {
  get(key: string, load: () => Promise<Blob>): Promise<string>;
  peek(key: string): string | undefined;
  revokeAll(): void;
}

export function attachmentCacheKey(tenantID: string, attachmentID: string) {
  return `${tenantID}\u0000${attachmentID}`;
}

export function createAttachmentObjectURLCache(): AttachmentObjectURLCache {
  const urls = new Map<string, string>();
  const pending = new Map<string, Promise<string>>();
  // revokeAll() bumps the generation: loads that finish afterwards revoke
  // their URL instead of caching it. The cache stays usable (StrictMode
  // replays effect cleanup before the real mount).
  let generation = 0;
  return {
    get(key, load) {
      const cached = urls.get(key);
      if (cached) return Promise.resolve(cached);
      const inFlight = pending.get(key);
      if (inFlight) return inFlight;
      const started = generation;
      const request = load()
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          if (started !== generation) {
            URL.revokeObjectURL(url);
            throw new Error("Attachment cache was released.");
          }
          urls.set(key, url);
          return url;
        })
        .finally(() => {
          if (pending.get(key) === request) pending.delete(key);
        });
      pending.set(key, request);
      return request;
    },
    peek(key) {
      return urls.get(key);
    },
    revokeAll() {
      generation += 1;
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
      pending.clear();
    },
  };
}

/* ---- ROOM-CHAT-EMOJI-02 emoji catalogue (emojibase-data, MIT) -------- */

/**
 * Nine topics in Zalo order. The data itself (~1.9k CLDR emoji, Vietnamese
 * and English) lives in `emojiCatalog.data.ts`, generated by
 * `apps/web/scripts/generate-emoji-catalog.mjs` and loaded through import()
 * so it never weighs on the entry or room chunk.
 */
export const CLASSROOM_EMOJI_TOPICS = [
  "smileys",
  "people",
  "nature",
  "food",
  "activities",
  "travel",
  "objects",
  "symbols",
  "flags",
] as const;

export type ClassroomEmojiTopic = (typeof CLASSROOM_EMOJI_TOPICS)[number];

export interface ClassroomEmojiEntry {
  readonly char: string;
  readonly en: string;
  /** Extra normalized search words (CLDR tags, both languages). */
  readonly tags: string;
  readonly vi: string;
}

export interface ClassroomEmojiTopicData {
  readonly entries: readonly ClassroomEmojiEntry[];
  readonly id: ClassroomEmojiTopic;
}

export interface ClassroomEmojiCatalog {
  readonly byChar: ReadonlyMap<string, ClassroomEmojiEntry>;
  readonly size: number;
  readonly source: string;
  readonly topics: readonly ClassroomEmojiTopicData[];
}

function isEmojiTopic(value: string): value is ClassroomEmojiTopic {
  return (CLASSROOM_EMOJI_TOPICS as readonly string[]).includes(value);
}

/**
 * Parses the generated "@topic" / "emoji|vi|en|words" text. Unknown topics
 * and malformed lines are skipped rather than trusted.
 */
export function parseClassroomEmojiCatalog(
  data: string,
  source = "",
): ClassroomEmojiCatalog {
  const topics = new Map<ClassroomEmojiTopic, ClassroomEmojiEntry[]>();
  const byChar = new Map<string, ClassroomEmojiEntry>();
  let current: ClassroomEmojiEntry[] | null = null;
  for (const line of data.split("\n")) {
    if (!line) continue;
    if (line.startsWith("@")) {
      const id = line.slice(1).trim();
      if (isEmojiTopic(id)) {
        current = [];
        topics.set(id, current);
      } else {
        current = null;
      }
      continue;
    }
    if (!current) continue;
    const [char = "", vi = "", en = "", tags = ""] = line.split("|");
    if (!char || !vi || !en || byChar.has(char)) continue;
    const entry: ClassroomEmojiEntry = { char, en, tags, vi };
    current.push(entry);
    byChar.set(char, entry);
  }
  return {
    byChar,
    size: byChar.size,
    source,
    topics: CLASSROOM_EMOJI_TOPICS.map((id) => ({
      entries: topics.get(id) ?? [],
      id,
    })),
  };
}

let catalogPromise: Promise<ClassroomEmojiCatalog> | null = null;
let loadedCatalog: ClassroomEmojiCatalog | null = null;

/** Loads (once) the lazily split emoji data chunk. Failed loads can retry. */
export function loadClassroomEmojiCatalog(): Promise<ClassroomEmojiCatalog> {
  catalogPromise ??= import("./emojiCatalog.data")
    .then((module) => {
      loadedCatalog = parseClassroomEmojiCatalog(
        module.EMOJI_CATALOG_DATA,
        module.EMOJI_CATALOG_SOURCE,
      );
      return loadedCatalog;
    })
    .catch((error: unknown) => {
      catalogPromise = null;
      throw error;
    });
  return catalogPromise;
}

/** The catalogue when it has already loaded (no flash of loading state). */
export function peekClassroomEmojiCatalog(): ClassroomEmojiCatalog | null {
  return loadedCatalog;
}

/** Warms the data chunk (Chat opened, or the emoji key hovered/focused). */
export function prefetchClassroomEmojiCatalog() {
  if (loadedCatalog) return;
  loadClassroomEmojiCatalog().catch(() => undefined);
}

/**
 * Case- and accent-insensitive search text ("Vỗ tay!" -> "vo tay"). Must stay
 * identical to `normalizeSearch` in apps/web/scripts/generate-emoji-catalog.mjs.
 */
export function normalizeEmojiSearch(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/đ/gu, "d")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

interface EmojiSearchRow {
  en: string;
  entry: ClassroomEmojiEntry;
  everything: string;
  tags: string;
  vi: string;
}

const searchIndexes = new WeakMap<ClassroomEmojiCatalog, EmojiSearchRow[]>();

function searchIndex(catalog: ClassroomEmojiCatalog) {
  let rows = searchIndexes.get(catalog);
  if (!rows) {
    rows = [];
    for (const topic of catalog.topics) {
      for (const entry of topic.entries) {
        const vi = normalizeEmojiSearch(entry.vi);
        const en = normalizeEmojiSearch(entry.en);
        rows.push({
          en,
          entry,
          everything: ` ${vi} ${en} ${entry.tags} `,
          tags: ` ${entry.tags} `,
          vi,
        });
      }
    }
    searchIndexes.set(catalog, rows);
  }
  return rows;
}

function searchRank(row: EmojiSearchRow, needle: string, words: string[]) {
  const { en, vi } = row;
  if (vi === needle || en === needle) return 1;
  if (vi.startsWith(needle) || en.startsWith(needle)) return 2;
  if (` ${vi}`.includes(` ${needle}`) || ` ${en}`.includes(` ${needle}`)) {
    return 3;
  }
  if (vi.includes(needle) || en.includes(needle)) return 4;
  if (row.tags.includes(` ${needle}`)) return 5;
  if (words.every((word) => row.everything.includes(` ${word}`))) return 6;
  return 0;
}

/**
 * Bilingual search: Vietnamese with or without diacritics and English. Name
 * matches rank before tag matches; ties keep catalogue (topic) order. Pasting
 * an emoji finds that emoji.
 */
export function searchClassroomEmoji(
  catalog: ClassroomEmojiCatalog,
  query: string,
): ClassroomEmojiEntry[] {
  const raw = query.trim();
  if (!raw) return [];
  const needle = normalizeEmojiSearch(raw);
  const words = needle.split(" ").filter(Boolean);
  const ranked: { entry: ClassroomEmojiEntry; order: number; rank: number }[] =
    [];
  searchIndex(catalog).forEach((row, order) => {
    if (row.entry.char === raw) {
      ranked.push({ entry: row.entry, order, rank: 0 });
      return;
    }
    const rank = needle ? searchRank(row, needle, words) : 0;
    if (rank > 0) ranked.push({ entry: row.entry, order, rank });
  });
  ranked.sort(
    (left, right) => left.rank - right.rank || left.order - right.order,
  );
  return ranked.map((item) => item.entry);
}

/* ---- ROOM-CHAT-EMOJI-02 recent emoji (device-local, per tenant + user) - */

export const CHAT_EMOJI_RECENT_LIMIT = 24;
const CHAT_EMOJI_MAX_LENGTH = 32;

export interface ChatEmojiRecentScope {
  actorID: string;
  tenantID: string;
}

export function chatEmojiRecentKey(scope: ChatEmojiRecentScope) {
  return `${CHAT_EMOJI_RECENT_STORAGE_PREFIX}v1:${encodeURIComponent(
    scope.tenantID,
  )}:${encodeURIComponent(scope.actorID)}`;
}

function defaultRecentStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function sanitizeRecents(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const recents: string[] = [];
  for (const item of value) {
    if (
      typeof item === "string" &&
      item.length > 0 &&
      item.length <= CHAT_EMOJI_MAX_LENGTH &&
      !recents.includes(item)
    ) {
      recents.push(item);
    }
    if (recents.length >= CHAT_EMOJI_RECENT_LIMIT) break;
  }
  return recents;
}

/** Reads the scoped recent list; never writes (no storage until a pick). */
export function loadChatEmojiRecents(
  scope: ChatEmojiRecentScope | null,
  storage: Storage | null = defaultRecentStorage(),
): string[] {
  if (!scope || !storage) return [];
  try {
    const raw = storage.getItem(chatEmojiRecentKey(scope));
    return raw ? sanitizeRecents(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

/** Most-recent-first, de-duplicated, at most 24 (3 rows x 8 columns). */
export function nextChatEmojiRecents(
  current: readonly string[],
  emoji: string,
): string[] {
  return [emoji, ...current.filter((item) => item !== emoji)].slice(
    0,
    CHAT_EMOJI_RECENT_LIMIT,
  );
}

/** Records a real pick: the only place recent emoji touch localStorage. */
export function recordChatEmojiRecent(
  scope: ChatEmojiRecentScope | null,
  current: readonly string[],
  emoji: string,
  storage: Storage | null = defaultRecentStorage(),
): string[] {
  if (!emoji || emoji.length > CHAT_EMOJI_MAX_LENGTH) return [...current];
  const next = nextChatEmojiRecents(current, emoji);
  if (scope && storage) {
    try {
      storage.setItem(chatEmojiRecentKey(scope), JSON.stringify(next));
    } catch {
      // Quota or privacy mode: the list still updates for this session.
    }
  }
  return next;
}

/* ---- MSG-STICKER-03 stickers (ADR-0047) ------------------------------ */

export const CHAT_STICKER_RECENT_LIMIT = 24;
const stickerIDPattern = /^[a-z0-9_]{1,32}:[a-z0-9_-]{1,64}$/u;

export function isChatStickerID(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 3 &&
    value.length <= 97 &&
    stickerIDPattern.test(value)
  );
}

export function chatStickerRecentKey(scope: ChatEmojiRecentScope) {
  return `${CHAT_STICKER_RECENT_STORAGE_PREFIX}v1:${encodeURIComponent(
    scope.tenantID,
  )}:${encodeURIComponent(scope.actorID)}`;
}

function sanitizeStickerRecents(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const recents: string[] = [];
  for (const item of value) {
    if (isChatStickerID(item) && !recents.includes(item)) recents.push(item);
    if (recents.length >= CHAT_STICKER_RECENT_LIMIT) break;
  }
  return recents;
}

/** Reads the scoped recent sticker IDs; never writes. */
export function loadChatStickerRecents(
  scope: ChatEmojiRecentScope | null,
  storage: Storage | null = defaultRecentStorage(),
): string[] {
  if (!scope || !storage) return [];
  try {
    const raw = storage.getItem(chatStickerRecentKey(scope));
    return raw ? sanitizeStickerRecents(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

/** Most-recent-first, de-duplicated, at most 24 catalog IDs (no PII). */
export function recordChatStickerRecent(
  scope: ChatEmojiRecentScope | null,
  current: readonly string[],
  stickerID: string,
  storage: Storage | null = defaultRecentStorage(),
): string[] {
  if (!isChatStickerID(stickerID)) return [...current];
  const next = [
    stickerID,
    ...current.filter((item) => item !== stickerID),
  ].slice(0, CHAT_STICKER_RECENT_LIMIT);
  if (scope && storage) {
    try {
      storage.setItem(chatStickerRecentKey(scope), JSON.stringify(next));
    } catch {
      // Quota or privacy mode: the row still updates for this session.
    }
  }
  return next;
}

export function chatStickerLabel(
  labels: { en: string; vi: string },
  language: "vi" | "en",
): string {
  return language === "vi" ? labels.vi : labels.en;
}

interface StickerSearchRow {
  everything: string;
  labels: string[];
  sticker: Sticker;
}

const stickerSearchIndexes = new WeakMap<
  readonly Sticker[],
  StickerSearchRow[]
>();

function stickerSearchIndex(stickers: readonly Sticker[]) {
  let rows = stickerSearchIndexes.get(stickers);
  if (!rows) {
    rows = stickers.map((sticker) => {
      const labels = [sticker.labels.vi, sticker.labels.en].map(
        normalizeEmojiSearch,
      );
      const keywords = [...sticker.keywords.vi, ...sticker.keywords.en].map(
        normalizeEmojiSearch,
      );
      return {
        everything: ` ${[...labels, ...keywords].join(" ")} `,
        labels,
        sticker,
      };
    });
    stickerSearchIndexes.set(stickers, rows);
  }
  return rows;
}

/**
 * Accent- and case-insensitive vi/en search over labels and keywords
 * ("cuoi" finds "Cười"). Label matches rank before keyword matches; ties
 * keep catalog order.
 */
export function searchChatStickers(
  stickers: readonly Sticker[],
  query: string,
): Sticker[] {
  const needle = normalizeEmojiSearch(query);
  if (!needle) return [];
  const words = needle.split(" ").filter(Boolean);
  const ranked: { order: number; rank: number; sticker: Sticker }[] = [];
  stickerSearchIndex(stickers).forEach((row, order) => {
    let rank = 0;
    if (row.labels.includes(needle)) rank = 1;
    else if (row.labels.some((label) => label.startsWith(needle))) rank = 2;
    else if (row.labels.some((label) => ` ${label}`.includes(` ${needle}`)))
      rank = 3;
    else if (row.everything.includes(` ${needle}`)) rank = 4;
    else if (words.every((word) => row.everything.includes(` ${word}`)))
      rank = 5;
    else if (row.everything.includes(needle)) rank = 6;
    if (rank > 0) ranked.push({ order, rank, sticker: row.sticker });
  });
  ranked.sort(
    (left, right) => left.rank - right.rank || left.order - right.order,
  );
  return ranked.map((item) => item.sticker);
}

/* ---- ROOM-CHAT-01 composer memory ------------------------------------ */

export interface ClassroomChatStagedAttachment {
  attachment?: MessageAttachment;
  clientAttachmentID: string;
  file: File;
  kind: ChatAttachmentKind;
  localID: string;
  mediaType: string;
  name: string;
  previewURL?: string;
  problem?: TranslationKey;
  size: number;
  status: "uploading" | "ready" | "error";
}

/**
 * Optional composer memory owned by the room. The inspector unmounts while
 * closed; the draft and staged uploads survive reopening through this store.
 */
export interface ClassroomChatComposerStore {
  draft: string;
  staged: ClassroomChatStagedAttachment[];
  /**
   * ROOM-TOOLS-CODE-01: set by `prefillClassroomChatComposer` so the panel
   * focuses its composer when it next mounts (the inspector was closed) or
   * as soon as it is notified (already open).
   */
  focusRequested?: boolean;
  listeners?: Set<() => void>;
}

export function createClassroomChatComposerStore(): ClassroomChatComposerStore {
  return { draft: "", listeners: new Set(), staged: [] };
}

export function disposeClassroomChatComposerStore(
  store: ClassroomChatComposerStore,
) {
  for (const item of store.staged) {
    if (item.previewURL) URL.revokeObjectURL(item.previewURL);
  }
  store.staged = [];
  store.draft = "";
  store.focusRequested = false;
  store.listeners?.clear();
}

/**
 * ROOM-TOOLS-CODE-01 "Send to chat": replaces the composer draft with text
 * (for example a fenced code block) and asks the panel to focus it. Nothing
 * is sent: the person still presses Send, and a host who paused participant
 * chat still blocks posting.
 */
export function prefillClassroomChatComposer(
  store: ClassroomChatComposerStore,
  text: string,
) {
  store.draft = text;
  store.focusRequested = true;
  for (const listener of store.listeners ?? []) listener();
}

export function subscribeClassroomChatComposer(
  store: ClassroomChatComposerStore,
  listener: () => void,
): () => void {
  store.listeners ??= new Set();
  const listeners = store.listeners;
  listeners.add(listener);
  return () => listeners.delete(listener);
}
