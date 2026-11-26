import type {
  CanonicalElementV1,
  CanonicalExcalidrawSceneV1,
  JsonObject,
} from "@tutorhub/collaboration-client";

/**
 * ROOM-TOOLS-FILES-01B / ADR-0045 §1 "Đưa trang / Cắt vùng sang Bảng trắng".
 *
 * The Documents tool renders a page or a crop into a bounded WebP
 * (`<= 40 KiB`) and pushes it here; the room page owns one bridge per room
 * session. The whiteboard takes the snippet only once its own live session
 * is connected (`edit`/`present`), so viewing a PDF never opens a hidden
 * collaboration connection. This module is tiny on purpose: it lives in the
 * room chunk and imports neither Excalidraw nor Yjs (types only).
 */
export const DOCUMENT_SNIPPET_FILE_PREFIX = "doc-snip-";
export const DOCUMENT_SNIPPET_MAX_PER_BOARD = 12;
/** Binary WebP ceiling (base64 ≈ 54.6 KiB, below the 64 KiB update cap). */
export const DOCUMENT_SNIPPET_MAX_BYTES = 40_960;
export const DOCUMENT_SNIPPET_CAPTION_MAX_LENGTH = 160;

export type DocumentSnippetMimeType = "image/jpeg" | "image/png" | "image/webp";

export interface PendingWhiteboardSnippet {
  readonly byteLength: number;
  readonly createdAt: number;
  readonly dataURL: string;
  /** Pixel size of the encoded image. */
  readonly height: number;
  readonly id: string;
  readonly mimeType: DocumentSnippetMimeType;
  /** 1-based page of a PDF; `null` for an image document. */
  readonly pageNumber: number | null;
  readonly sourceName: string;
  readonly width: number;
}

export type WhiteboardSnippetOutcome =
  "failed" | "inserted" | "limit" | "readOnly" | "tooLarge";

export interface WhiteboardSnippetReport {
  readonly outcome: WhiteboardSnippetOutcome;
  readonly snippetID: string;
}

export interface WhiteboardSnippetBridge {
  clear(): void;
  lastReport(): WhiteboardSnippetReport | null;
  peek(): PendingWhiteboardSnippet | null;
  /** Queues a snippet, replacing one that has not been taken yet. */
  push(snippet: PendingWhiteboardSnippet): void;
  report(snippetID: string, outcome: WhiteboardSnippetOutcome): void;
  subscribe(listener: () => void): () => void;
  take(): PendingWhiteboardSnippet | null;
}

export function createWhiteboardSnippetBridge(): WhiteboardSnippetBridge {
  let pending: PendingWhiteboardSnippet | null = null;
  let last: WhiteboardSnippetReport | null = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    clear() {
      pending = null;
      last = null;
      notify();
    },
    lastReport() {
      return last;
    },
    peek() {
      return pending;
    },
    push(snippet) {
      pending = snippet;
      last = null;
      notify();
    },
    report(snippetID, outcome) {
      last = { outcome, snippetID };
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    take() {
      const taken = pending;
      pending = null;
      if (taken) notify();
      return taken;
    },
  };
}

/** Base64 payload size of a `data:` URL, in decoded bytes. */
export function dataURLByteLength(dataURL: string): number {
  const comma = dataURL.indexOf(",");
  if (comma < 0) return Number.POSITIVE_INFINITY;
  const payload = dataURL.slice(comma + 1);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - padding;
}

/** Live (non-deleted) image elements that came from the Documents tool. */
export function countDocumentSnippets(
  scene: Pick<CanonicalExcalidrawSceneV1, "elements">,
): number {
  return scene.elements.filter(
    (element) =>
      element.type === "image" &&
      element.isDeleted !== true &&
      typeof element.fileId === "string" &&
      element.fileId.startsWith(DOCUMENT_SNIPPET_FILE_PREFIX),
  ).length;
}

/** The visible scene rectangle of the board, in scene coordinates. */
export interface WhiteboardSceneViewport {
  readonly centerX: number;
  readonly centerY: number;
  readonly height: number;
  readonly width: number;
}

export type DocumentSnippetPlan =
  | { readonly kind: "limit" }
  | { readonly kind: "tooLarge" }
  | {
      readonly fileID: string;
      readonly kind: "ok";
      readonly scene: CanonicalExcalidrawSceneV1;
    };

export interface DocumentSnippetPlanOptions {
  readonly caption: string;
  readonly now?: number;
  readonly random?: () => number;
}

function randomInteger(random: () => number): number {
  return Math.floor(random() * 2 ** 31);
}

function identifier(prefix: string, snippetID: string): string {
  const safe = snippetID.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return `${prefix}${safe || "x"}`;
}

function baseElement(
  id: string,
  type: "image" | "text",
  box: { height: number; width: number; x: number; y: number },
  groupID: string,
  now: number,
  random: () => number,
): JsonObject {
  return {
    angle: 0,
    backgroundColor: "transparent",
    boundElements: null,
    customData: { tutorhubSource: "document-snippet" },
    fillStyle: "solid",
    frameId: null,
    groupIds: [groupID],
    height: box.height,
    id,
    isDeleted: false,
    link: null,
    locked: true,
    opacity: 100,
    roughness: 0,
    roundness: null,
    seed: randomInteger(random),
    strokeColor: "#1e1e1e",
    strokeStyle: "solid",
    strokeWidth: 1,
    type,
    updated: now,
    version: 1,
    versionNonce: randomInteger(random),
    width: box.width,
    x: box.x,
    y: box.y,
  };
}

/**
 * Builds the next canonical scene with the snippet as a `locked: true` image
 * centred in the visible area plus a locked source caption below it, or
 * explains why it cannot be inserted. Pure: the caller applies the result
 * through `CanonicalExcalidrawAuthority.applySceneDelta`, which writes only
 * the new file and the two new elements.
 */
export function planDocumentSnippetInsertion(
  scene: CanonicalExcalidrawSceneV1,
  snippet: PendingWhiteboardSnippet,
  viewport: WhiteboardSceneViewport,
  options: DocumentSnippetPlanOptions,
): DocumentSnippetPlan {
  if (countDocumentSnippets(scene) >= DOCUMENT_SNIPPET_MAX_PER_BOARD) {
    return { kind: "limit" };
  }
  if (
    snippet.byteLength > DOCUMENT_SNIPPET_MAX_BYTES ||
    dataURLByteLength(snippet.dataURL) > DOCUMENT_SNIPPET_MAX_BYTES ||
    !snippet.dataURL.startsWith(`data:${snippet.mimeType};base64,`)
  ) {
    return { kind: "tooLarge" };
  }
  const now = options.now ?? Date.now();
  const random = options.random ?? Math.random;
  const fileID = identifier(DOCUMENT_SNIPPET_FILE_PREFIX, snippet.id);
  const imageID = identifier("doc-snip-image-", snippet.id);
  const captionID = identifier("doc-snip-caption-", snippet.id);
  const groupID = identifier("doc-snip-group-", snippet.id);

  const pixelWidth = Math.max(1, snippet.width);
  const pixelHeight = Math.max(1, snippet.height);
  const scale = Math.min(
    1,
    (Math.max(120, viewport.width) * 0.7) / pixelWidth,
    (Math.max(120, viewport.height) * 0.6) / pixelHeight,
  );
  const width = Math.round(pixelWidth * scale);
  const height = Math.round(pixelHeight * scale);
  const captionFontSize = 16;
  const captionHeight = Math.round(captionFontSize * 1.25);
  const caption = options.caption
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DOCUMENT_SNIPPET_CAPTION_MAX_LENGTH);
  const x = Math.round(viewport.centerX - width / 2);
  const y = Math.round(viewport.centerY - (height + 12 + captionHeight) / 2);

  const image: CanonicalElementV1 = {
    ...baseElement(
      imageID,
      "image",
      { height, width, x, y },
      groupID,
      now,
      random,
    ),
    crop: null,
    fileId: fileID,
    scale: [1, 1],
    status: "saved",
  } as unknown as CanonicalElementV1;
  const captionWidth = Math.max(
    40,
    Math.round(caption.length * captionFontSize * 0.55),
  );
  const text: CanonicalElementV1 = {
    ...baseElement(
      captionID,
      "text",
      {
        height: captionHeight,
        width: captionWidth,
        x,
        y: y + height + 12,
      },
      groupID,
      now,
      random,
    ),
    autoResize: true,
    containerId: null,
    fontFamily: 2,
    fontSize: captionFontSize,
    lineHeight: 1.25,
    originalText: caption,
    strokeColor: "#495057",
    text: caption,
    textAlign: "left",
    verticalAlign: "top",
  } as unknown as CanonicalElementV1;
  const file: JsonObject = {
    created: now,
    dataURL: snippet.dataURL,
    id: fileID,
    lastRetrieved: now,
    mimeType: snippet.mimeType,
  };
  return {
    fileID,
    kind: "ok",
    scene: {
      ...scene,
      elements: [...scene.elements, image, text],
      files: { ...scene.files, [fileID]: file },
    },
  };
}
