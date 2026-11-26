import type { RoomDocumentViewCapability } from "@tutorhub/api-client";
import {
  ROOM_DOCUMENT_PDF_MAX_BYTES,
  ROOM_DOCUMENT_VIEWER_MAX_FETCH_BYTES,
  RoomDocumentBytesError,
} from "../../app/roomDocuments";
import type { ByteRangeCache } from "./filesSession";

/**
 * ROOM-TOOLS-FILES-02B (ADR-0045 §3, Slice 2): HTTP Range loading for ready
 * PDFs of 30–50 MiB. pdf.js asks for the byte ranges it needs
 * (`PDFDataRangeTransport.requestDataRange`, 256 KiB chunks, no auto-fetch,
 * no streaming) and this loader fetches exactly those ranges from the
 * version-bound presigned URL — never with cookies, a referrer or the HTTP
 * cache — and accepts only a `206` whose `Content-Range` is the requested
 * range of the original length.
 *
 * The short-lived view capability is renewed 30 s before it expires or after
 * a `401/403`. A renewed capability must name the **same** object version
 * and length; anything else aborts the document (fail-closed integrity),
 * because mixing ranges of two versions would corrupt what is shown.
 * Chunks live in RAM only (≤ 32 MiB LRU in the room files session).
 */
export const ROOM_DOCUMENT_RANGE_CHUNK_BYTES = 262_144;
export const ROOM_DOCUMENT_RANGE_RENEW_BEFORE_MS = 30_000;

export type RoomDocumentLoadMode = "full" | "range" | "tooLarge";

/** Whole-file fetch up to 30 MiB; Range for PDFs of 30–50 MiB. */
export function roomDocumentLoadMode(
  capability: Pick<
    RoomDocumentViewCapability,
    "content_length_bytes" | "media_type"
  >,
): RoomDocumentLoadMode {
  const size = capability.content_length_bytes;
  if (size <= ROOM_DOCUMENT_VIEWER_MAX_FETCH_BYTES) return "full";
  if (
    capability.media_type === "application/pdf" &&
    size <= ROOM_DOCUMENT_PDF_MAX_BYTES
  ) {
    return "range";
  }
  return "tooLarge";
}

export type RangeCapability = Pick<
  RoomDocumentViewCapability,
  "content_length_bytes" | "expires_at" | "url" | "version_id"
>;

export interface RoomDocumentRangeLoaderOptions {
  readonly cache?: ByteRangeCache;
  readonly capability: RangeCapability;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** A fresh view capability for the same file (server re-authorizes). */
  readonly renew: (signal: AbortSignal) => Promise<RangeCapability>;
}

const CONTENT_RANGE = /^bytes\s+(\d+)-(\d+)\/(\d+)$/iu;

export class RoomDocumentRangeLoader {
  readonly length: number;
  readonly versionID: string;
  private capability: RangeCapability;
  private renewal: Promise<RangeCapability> | null = null;
  private readonly controller = new AbortController();
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly renewCapability: RoomDocumentRangeLoaderOptions["renew"];
  private readonly cache: ByteRangeCache | null;
  private transferred = 0;
  private requests = 0;
  private cancelled = false;
  private failure: RoomDocumentBytesError | null = null;

  constructor({
    cache,
    capability,
    fetch: fetcher,
    now = () => Date.now(),
    renew,
  }: RoomDocumentRangeLoaderOptions) {
    if (
      !Number.isSafeInteger(capability.content_length_bytes) ||
      capability.content_length_bytes < 1 ||
      capability.content_length_bytes > ROOM_DOCUMENT_PDF_MAX_BYTES
    ) {
      throw new RoomDocumentBytesError("tooLarge");
    }
    this.capability = capability;
    this.length = capability.content_length_bytes;
    this.versionID = capability.version_id;
    this.fetcher = fetcher ?? ((...args) => globalThis.fetch(...args));
    this.now = now;
    this.renewCapability = renew;
    this.cache = cache ?? null;
  }

  /** Bytes actually received over the network (cache hits excluded). */
  get transferredBytes(): number {
    return this.transferred;
  }

  get requestCount(): number {
    return this.requests;
  }

  /** True after `abort()` (the viewer closed); not after a failure. */
  get aborted(): boolean {
    return this.cancelled;
  }

  /** Cancels every in-flight request; later reads reject. */
  abort(): void {
    this.cancelled = true;
    this.controller.abort();
  }

  /** Bytes `[begin, end)` of the pinned object version. */
  async read(begin: number, end: number): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(begin) ||
      !Number.isSafeInteger(end) ||
      begin < 0 ||
      end <= begin ||
      end > this.length
    ) {
      throw new RoomDocumentBytesError("integrity");
    }
    this.assertActive();
    const cached = this.cache?.get(begin, end);
    if (cached) return cached;
    let capability = await this.freshCapability();
    let response = await this.request(capability, begin, end);
    if (response.status === 401 || response.status === 403) {
      // The URL expired or was revoked: re-authorize once, same version only.
      capability = await this.renew();
      response = await this.request(capability, begin, end);
    }
    const bytes = await this.verify(response, begin, end);
    this.transferred += bytes.byteLength;
    this.cache?.set(begin, end, bytes);
    return bytes;
  }

  private assertActive(): void {
    if (this.failure) throw this.failure;
    if (this.controller.signal.aborted) {
      throw new DOMException("Range loading was cancelled.", "AbortError");
    }
  }

  private async freshCapability(): Promise<RangeCapability> {
    const expiresAt = Date.parse(this.capability.expires_at);
    if (
      !Number.isFinite(expiresAt) ||
      expiresAt - this.now() <= ROOM_DOCUMENT_RANGE_RENEW_BEFORE_MS
    ) {
      return this.renew();
    }
    return this.capability;
  }

  private renew(): Promise<RangeCapability> {
    if (this.renewal) return this.renewal;
    const pending = (async () => {
      try {
        const renewed = await this.renewCapability(this.controller.signal);
        this.assertActive();
        if (
          renewed.version_id !== this.versionID ||
          renewed.content_length_bytes !== this.length
        ) {
          // Never mix ranges of two object versions: stop the document.
          this.failure = new RoomDocumentBytesError("integrity");
          this.controller.abort();
          throw this.failure;
        }
        this.capability = renewed;
        return renewed;
      } finally {
        this.renewal = null;
      }
    })();
    this.renewal = pending;
    return pending;
  }

  private async request(
    capability: RangeCapability,
    begin: number,
    end: number,
  ): Promise<Response> {
    this.assertActive();
    this.requests += 1;
    try {
      return await this.fetcher(capability.url, {
        cache: "no-store",
        credentials: "omit",
        headers: { Range: `bytes=${begin}-${end - 1}` },
        method: "GET",
        mode: "cors",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: this.controller.signal,
      });
    } catch (error) {
      if (this.failure) throw this.failure;
      if (this.controller.signal.aborted) throw error;
      throw new RoomDocumentBytesError("network");
    }
  }

  private async verify(
    response: Response,
    begin: number,
    end: number,
  ): Promise<Uint8Array> {
    if (response.status === 401 || response.status === 403) {
      throw new RoomDocumentBytesError("unavailable");
    }
    if (response.status !== 206) {
      // A 200 would be the whole 30–50 MiB object: refuse it.
      await response.body?.cancel().catch(() => undefined);
      throw new RoomDocumentBytesError(
        response.ok ? "integrity" : "unavailable",
      );
    }
    const match = CONTENT_RANGE.exec(
      (response.headers.get("Content-Range") ?? "").trim(),
    );
    if (
      !match ||
      Number(match[1]) !== begin ||
      Number(match[2]) !== end - 1 ||
      Number(match[3]) !== this.length
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new RoomDocumentBytesError("integrity");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== end - begin) {
      throw new RoomDocumentBytesError("integrity");
    }
    return bytes;
  }
}
