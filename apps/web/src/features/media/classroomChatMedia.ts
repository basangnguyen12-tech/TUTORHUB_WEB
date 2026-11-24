import type { MessageAttachment } from "@tutorhub/api-client";
import type { TranslationKey } from "../../app/i18n";

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
  { kind: "text"; text: string } | { kind: "link"; href: string; text: string };

const linkPattern = /https?:\/\/[^\s<>"']+/giu;
const trailingPunctuation = /[.,;:!?)\]}'"»”’]+$/u;

/** Splits plain text into text and safe http(s) link pieces. */
export function linkifyChatText(text: string): ChatTextPiece[] {
  const pieces: ChatTextPiece[] = [];
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
      pieces.push({ kind: "text", text: text.slice(cursor, start) });
    }
    pieces.push({ kind: "link", href, text: candidate });
    cursor = start + candidate.length;
  }
  if (cursor < text.length) {
    pieces.push({ kind: "text", text: text.slice(cursor) });
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

/* ---- ROOM-CHAT-01 emoji catalogue (dependency-free) ---------------- */

export type ClassroomEmojiCategory =
  "class" | "smileys" | "gestures" | "symbols";

export interface ClassroomEmojiEntry {
  readonly char: string;
  readonly vi: string;
  readonly en: string;
}

const e = (char: string, vi: string, en: string): ClassroomEmojiEntry => ({
  char,
  en,
  vi,
});

export const CLASSROOM_EMOJI: Readonly<
  Record<ClassroomEmojiCategory, readonly ClassroomEmojiEntry[]>
> = {
  class: [
    e("👍", "thích đồng ý", "thumbs up like"),
    e("✅", "xong đúng hoàn thành", "done check correct"),
    e("❤️", "tim yêu thích", "heart love"),
    e("😂", "cười ra nước mắt", "laugh tears joy"),
    e("🎉", "chúc mừng ăn mừng", "celebrate party"),
    e("👏", "vỗ tay hoan hô", "clap applause"),
    e("🙋", "giơ tay phát biểu hỏi", "raise hand question"),
    e("💡", "ý tưởng bóng đèn", "idea light bulb"),
    e("📚", "sách vở học bài", "books study"),
    e("✏️", "bút chì viết", "pencil write"),
    e("📝", "ghi chú bài tập", "notes homework memo"),
    e("📖", "sách mở đọc", "open book read"),
    e("🎓", "tốt nghiệp học vị", "graduation cap"),
    e("🏆", "cúp chiến thắng", "trophy win"),
    e("⭐", "ngôi sao điểm cao", "star"),
    e("🔥", "lửa tuyệt vời", "fire lit"),
    e("💯", "một trăm điểm tuyệt đối", "hundred perfect score"),
    e("🤔", "suy nghĩ thắc mắc", "thinking hmm"),
    e("👀", "nhìn xem", "eyes look"),
    e("⏰", "đồng hồ báo thức giờ", "alarm clock time"),
    e("📌", "ghim quan trọng", "pin important"),
    e("🙏", "cảm ơn làm ơn", "thanks please pray"),
    e("🧠", "não thông minh", "brain smart"),
    e("🚀", "tên lửa tiến bộ", "rocket progress"),
  ],
  smileys: [
    e("😀", "cười tươi", "grinning face"),
    e("😃", "cười lớn", "smiley big eyes"),
    e("😄", "cười híp mắt", "smile happy"),
    e("😁", "cười nhe răng", "beaming grin"),
    e("😊", "mỉm cười vui", "blush smile"),
    e("🙂", "cười nhẹ", "slight smile"),
    e("😉", "nháy mắt", "wink"),
    e("😍", "mắt trái tim", "heart eyes"),
    e("🥰", "thương yêu", "smiling hearts"),
    e("😎", "ngầu kính râm", "cool sunglasses"),
    e("🤩", "thích thú ngôi sao", "star struck"),
    e("🥳", "tiệc vui", "party face"),
    e("😅", "cười toát mồ hôi", "sweat smile"),
    e("😆", "cười sảng khoái", "laughing squint"),
    e("🤗", "ôm", "hug"),
    e("😮", "ngạc nhiên", "surprised open mouth"),
    e("😲", "kinh ngạc", "astonished"),
    e("😢", "buồn khóc", "sad crying"),
    e("😭", "khóc to", "loudly crying"),
    e("😤", "quyết tâm", "determined huff"),
    e("😴", "buồn ngủ", "sleeping tired"),
    e("🤯", "bùng nổ đầu óc", "mind blown"),
    e("😇", "ngoan thiên thần", "innocent angel"),
    e("🙃", "lộn ngược", "upside down"),
  ],
  gestures: [
    e("👋", "vẫy tay chào", "wave hello"),
    e("👌", "ổn ok", "ok hand"),
    e("✌️", "chiến thắng hai", "victory peace"),
    e("🤞", "cầu may", "fingers crossed luck"),
    e("🤝", "bắt tay hợp tác", "handshake deal"),
    e("👎", "không thích", "thumbs down"),
    e("👊", "đấm tay cố lên", "fist bump"),
    e("✊", "nắm tay đoàn kết", "raised fist"),
    e("🤙", "gọi cho tôi", "call me"),
    e("💪", "cơ bắp cố gắng", "muscle strong"),
    e("🙌", "giơ hai tay", "raising hands"),
    e("☝️", "một ngón chỉ lên", "index up one"),
    e("👆", "chỉ lên", "point up"),
    e("👇", "chỉ xuống", "point down"),
    e("👈", "chỉ trái", "point left"),
    e("👉", "chỉ phải", "point right"),
    e("🖐️", "xòe tay năm", "hand splayed five"),
    e("✋", "giơ tay dừng", "raised hand stop"),
    e("🤚", "mu bàn tay", "raised back hand"),
    e("🫶", "tay trái tim", "heart hands"),
    e("🤟", "yêu bạn", "love you gesture"),
    e("✍️", "viết tay", "writing hand"),
    e("🤲", "hai lòng bàn tay", "palms up"),
    e("🫡", "chào nghiêm", "salute"),
  ],
  symbols: [
    e("➕", "cộng toán", "plus add math"),
    e("➖", "trừ toán", "minus subtract math"),
    e("✖️", "nhân toán", "multiply times math"),
    e("➗", "chia toán", "divide math"),
    e("🟰", "bằng dấu bằng", "equals math"),
    e("♾️", "vô cực", "infinity"),
    e("💲", "đô la tiền", "dollar money"),
    e("📐", "thước ê ke hình học", "triangle ruler geometry"),
    e("📏", "thước kẻ đo", "straight ruler measure"),
    e("🧮", "bàn tính", "abacus count"),
    e("🔢", "số đếm", "numbers 1234"),
    e("📊", "biểu đồ thống kê", "bar chart statistics"),
    e("📈", "tăng trưởng đồ thị", "chart increasing graph"),
    e("❓", "câu hỏi chấm hỏi", "question mark"),
    e("❗", "chấm than lưu ý", "exclamation"),
    e("✔️", "đánh dấu đúng", "check mark"),
    e("❌", "sai dấu nhân", "cross wrong"),
    e("⭕", "vòng tròn đúng", "circle"),
    e("🔺", "tam giác", "triangle"),
    e("🧪", "ống nghiệm hóa học", "test tube chemistry"),
    e("🔬", "kính hiển vi sinh học", "microscope biology"),
    e("🌍", "trái đất địa lý", "globe earth geography"),
    e("💻", "máy tính tin học", "laptop computer"),
    e("📎", "kẹp giấy tệp", "paperclip attach"),
  ],
};

export const CLASSROOM_EMOJI_CATEGORIES = Object.keys(
  CLASSROOM_EMOJI,
) as ClassroomEmojiCategory[];

function normalizeEmojiQuery(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/gu, "d")
    .toLowerCase()
    .trim();
}

export function searchClassroomEmoji(query: string): ClassroomEmojiEntry[] {
  const needle = normalizeEmojiQuery(query);
  if (!needle) return [];
  const seen = new Set<string>();
  const results: ClassroomEmojiEntry[] = [];
  for (const category of CLASSROOM_EMOJI_CATEGORIES) {
    for (const entry of CLASSROOM_EMOJI[category]) {
      if (seen.has(entry.char)) continue;
      const haystack = normalizeEmojiQuery(`${entry.vi} ${entry.en}`);
      if (haystack.includes(needle) || entry.char === query.trim()) {
        seen.add(entry.char);
        results.push(entry);
      }
    }
  }
  return results;
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
}

export function createClassroomChatComposerStore(): ClassroomChatComposerStore {
  return { draft: "", staged: [] };
}

export function disposeClassroomChatComposerStore(
  store: ClassroomChatComposerStore,
) {
  for (const item of store.staged) {
    if (item.previewURL) URL.revokeObjectURL(item.previewURL);
  }
  store.staged = [];
  store.draft = "";
}
