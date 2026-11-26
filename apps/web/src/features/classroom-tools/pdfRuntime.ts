import {
  AnnotationMode,
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
  version as pdfjsVersion,
} from "pdfjs-dist";

/**
 * ROOM-TOOLS-FILES-01B / ADR-0045 §3: the one place `pdfjs-dist@6.5.438` is
 * configured. Every option is fixed here (never user-controlled):
 *
 * - the worker, WASM decoders, CMaps, standard fonts and ICC profile come
 *   from this origin (`/pdf-runtime/`, see `vite.config.ts`), never a CDN;
 * - no scripting manager is ever created and `pdf.sandbox` / QuickJS are not
 *   shipped, so `/OpenAction`, `/AA` and `/JS` never run; XFA is off;
 * - bytes are handed over in memory (`data`), so pdf.js makes no network
 *   request for the document and never sends credentials;
 * - images above 50 MP are not decoded and recoverable errors stay local to
 *   a page (`stopAtErrors: false`);
 * - pages render on the main thread (`disableWorkerRendering`), so a canvas
 *   is never transferred offscreen and can always be released by zeroing it.
 */
export const PDF_RUNTIME_BASE_URL = "/pdf-runtime/";

export const PDF_DOCUMENT_OPTIONS = Object.freeze({
  cMapPacked: true,
  cMapUrl: `${PDF_RUNTIME_BASE_URL}cmaps/`,
  disableAutoFetch: true,
  disableFontFace: false,
  disableRange: true,
  disableStream: true,
  disableWorkerRendering: true,
  enableHWA: false,
  enableXfa: false,
  iccUrl: `${PDF_RUNTIME_BASE_URL}iccs/`,
  maxImageSize: 50_000_000,
  standardFontDataUrl: `${PDF_RUNTIME_BASE_URL}standard_fonts/`,
  stopAtErrors: false,
  useSystemFonts: true,
  verbosity: 0,
  wasmUrl: `${PDF_RUNTIME_BASE_URL}wasm/`,
  withCredentials: false,
});

let workerConfigured = false;

export function configurePdfRuntime(): void {
  if (workerConfigured) return;
  // The version query keeps a cached worker from an older pdfjs-dist from
  // ever pairing with a newer API (static hosts ignore the query string).
  GlobalWorkerOptions.workerSrc = `${PDF_RUNTIME_BASE_URL}pdf.worker.min.mjs?v=${encodeURIComponent(pdfjsVersion)}`;
  workerConfigured = true;
}

/** Opens verified bytes; pdf.js takes ownership of a private copy. */
export function openPdfDocument(bytes: Uint8Array): PDFDocumentLoadingTask {
  configurePdfRuntime();
  return getDocument({ ...PDF_DOCUMENT_OPTIONS, data: bytes.slice() });
}

export { AnnotationMode, TextLayer };
export type { PDFDocumentProxy, PDFPageProxy };

/** A Link annotation as returned by `page.getAnnotations()` (subset). */
export interface PdfLinkAnnotation {
  readonly dest?: unknown;
  readonly id?: string;
  readonly rect?: readonly number[];
  readonly subtype?: string;
  readonly unsafeUrl?: string;
  readonly url?: string;
}

/** Resolves an internal destination to a 1-based page number, or null. */
export async function resolvePdfDestination(
  pdf: PDFDocumentProxy,
  destination: unknown,
): Promise<number | null> {
  try {
    const explicit =
      typeof destination === "string"
        ? await pdf.getDestination(destination)
        : destination;
    if (!Array.isArray(explicit) || explicit.length === 0) return null;
    const target: unknown = explicit[0];
    if (typeof target === "number" && Number.isInteger(target)) {
      return target + 1;
    }
    if (
      typeof target === "object" &&
      target !== null &&
      "num" in target &&
      "gen" in target
    ) {
      const index = await pdf.getPageIndex(
        target as { num: number; gen: number },
      );
      return index + 1;
    }
  } catch {
    return null;
  }
  return null;
}

/** Plain page text for search (items joined, line ends kept as spaces). */
export async function readPdfPageText(page: PDFPageProxy): Promise<string> {
  const content = await page.getTextContent();
  let text = "";
  for (const item of content.items) {
    if ("str" in item) {
      text += item.str;
      if (item.hasEOL) text += " ";
    }
  }
  return text;
}
