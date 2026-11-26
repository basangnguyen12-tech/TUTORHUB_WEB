import {
  DOCUMENT_SNIPPET_MAX_BYTES,
  type DocumentSnippetMimeType,
} from "../collaboration/whiteboardSnippetBridge";

/**
 * ROOM-TOOLS-FILES-01B / ADR-0045 §1: compresses a rendered page or crop for
 * the whiteboard. WebP quality steps 0.82 → 0.40, then the long edge shrinks
 * 15 % per round, for at most 8 rounds, until the binary is ≤ 40 KiB. A
 * browser without a WebP encoder (its `toBlob` falls back to PNG) uses JPEG
 * with the same ladder; nothing over the ceiling is ever returned.
 */
export const SNIPPET_ENCODE_ATTEMPTS: readonly {
  readonly quality: number;
  readonly scale: number;
}[] = Object.freeze([
  { quality: 0.82, scale: 1 },
  { quality: 0.68, scale: 1 },
  { quality: 0.54, scale: 1 },
  { quality: 0.4, scale: 1 },
  { quality: 0.4, scale: 0.85 },
  { quality: 0.4, scale: 0.85 ** 2 },
  { quality: 0.4, scale: 0.85 ** 3 },
  { quality: 0.4, scale: 0.85 ** 4 },
]);

export interface SnippetCanvasLike {
  height: number;
  width: number;
}

export interface SnippetEncoderHost<Canvas extends SnippetCanvasLike> {
  /** A canvas of the given size with `source` drawn scaled into it. */
  readonly draw: (source: Canvas, width: number, height: number) => Canvas;
  readonly encode: (
    canvas: Canvas,
    type: DocumentSnippetMimeType,
    quality: number,
  ) => Promise<Blob | null>;
  /** Releases a scratch canvas created by `draw`. */
  readonly release?: (canvas: Canvas) => void;
}

export type SnippetEncodeResult =
  | {
      readonly attempts: number;
      readonly blob: Blob;
      readonly height: number;
      readonly mimeType: DocumentSnippetMimeType;
      readonly ok: true;
      readonly width: number;
    }
  | {
      readonly attempts: number;
      readonly ok: false;
      readonly reason: "encode" | "tooLarge";
    };

export async function encodeDocumentSnippet<Canvas extends SnippetCanvasLike>(
  source: Canvas,
  host: SnippetEncoderHost<Canvas>,
  maxBytes: number = DOCUMENT_SNIPPET_MAX_BYTES,
): Promise<SnippetEncodeResult> {
  let mimeType: DocumentSnippetMimeType = "image/webp";
  let attempts = 0;
  for (const attempt of SNIPPET_ENCODE_ATTEMPTS) {
    attempts += 1;
    const width = Math.max(1, Math.round(source.width * attempt.scale));
    const height = Math.max(1, Math.round(source.height * attempt.scale));
    const canvas =
      attempt.scale === 1 ? source : host.draw(source, width, height);
    let blob: Blob | null;
    try {
      blob = await host.encode(canvas, mimeType, attempt.quality);
      if (blob && blob.type !== mimeType && mimeType === "image/webp") {
        // No WebP encoder: the browser returned PNG. Retry this round as JPEG.
        mimeType = "image/jpeg";
        blob = await host.encode(canvas, mimeType, attempt.quality);
      }
    } finally {
      if (canvas !== source) host.release?.(canvas);
    }
    if (!blob || blob.type !== mimeType) {
      return { attempts, ok: false, reason: "encode" };
    }
    if (blob.size <= maxBytes) {
      return { attempts, blob, height, mimeType, ok: true, width };
    }
  }
  return { attempts, ok: false, reason: "tooLarge" };
}

export function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("snippet_read_failed"));
    });
    reader.addEventListener("error", () =>
      reject(new Error("snippet_read_failed")),
    );
    reader.readAsDataURL(blob);
  });
}

/** Browser host for `encodeDocumentSnippet` over DOM canvases. */
export const domSnippetEncoderHost: SnippetEncoderHost<HTMLCanvasElement> = {
  draw(source, width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context) {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.imageSmoothingQuality = "high";
      context.drawImage(source, 0, 0, width, height);
    }
    return canvas;
  },
  encode(canvas, type, quality) {
    return new Promise((resolve) => {
      try {
        canvas.toBlob((blob) => resolve(blob), type, quality);
      } catch {
        resolve(null);
      }
    });
  },
  release(canvas) {
    canvas.width = 0;
    canvas.height = 0;
  },
};
