import { describe, expect, it, vi } from "vitest";
import { RoomDocumentBytesError } from "../../app/roomDocuments";
import { createByteRangeCache } from "./filesSession";
import {
  ROOM_DOCUMENT_RANGE_CHUNK_BYTES,
  roomDocumentLoadMode,
  RoomDocumentRangeLoader,
  type RangeCapability,
} from "./pdfRangeTransport";

const LENGTH = 35 * 1024 * 1024;
const NOW = Date.parse("2030-08-08T01:00:00Z");

function capability(overrides: Partial<RangeCapability> = {}): RangeCapability {
  return {
    content_length_bytes: LENGTH,
    expires_at: "2030-08-08T01:05:00Z",
    url: "https://storage.example.test/object?X-Amz-Signature=one",
    version_id: "v-initial",
    ...overrides,
  };
}

function partial(
  begin: number,
  end: number,
  total = LENGTH,
  body?: Uint8Array,
) {
  const bytes = body ?? new Uint8Array(end - begin).fill(7);
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    headers: { "Content-Range": `bytes ${begin}-${end - 1}/${total}` },
    status: 206,
  });
}

describe("roomDocumentLoadMode", () => {
  it("fetches ≤ 30 MiB whole, Ranges 30–50 MiB PDFs and refuses the rest", () => {
    expect(
      roomDocumentLoadMode({
        content_length_bytes: 31_457_280,
        media_type: "application/pdf",
      }),
    ).toBe("full");
    expect(
      roomDocumentLoadMode({
        content_length_bytes: 31_457_281,
        media_type: "application/pdf",
      }),
    ).toBe("range");
    expect(
      roomDocumentLoadMode({
        content_length_bytes: 52_428_800,
        media_type: "application/pdf",
      }),
    ).toBe("range");
    expect(
      roomDocumentLoadMode({
        content_length_bytes: 52_428_801,
        media_type: "application/pdf",
      }),
    ).toBe("tooLarge");
    expect(
      roomDocumentLoadMode({
        content_length_bytes: 31_457_281,
        media_type: "image/png",
      }),
    ).toBe("tooLarge");
  });
});

describe("RoomDocumentRangeLoader", () => {
  it("requests exact inclusive ranges without cookies, referrer or HTTP cache", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const range = new Headers(init?.headers).get("Range") ?? "";
      const [, start, stop] = /bytes=(\d+)-(\d+)/u.exec(range) ?? [];
      return partial(Number(start), Number(stop) + 1);
    });
    const loader = new RoomDocumentRangeLoader({
      capability: capability(),
      fetch: fetchMock as unknown as typeof fetch,
      now: () => NOW,
      renew: vi.fn(),
    });
    const bytes = await loader.read(0, ROOM_DOCUMENT_RANGE_CHUNK_BYTES);
    expect(bytes.byteLength).toBe(ROOM_DOCUMENT_RANGE_CHUNK_BYTES);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(capability().url);
    expect(new Headers(init.headers).get("Range")).toBe("bytes=0-262143");
    expect(init).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(loader.transferredBytes).toBe(ROOM_DOCUMENT_RANGE_CHUNK_BYTES);
    expect(loader.length).toBe(LENGTH);
  });

  it("serves repeated ranges from the RAM cache", async () => {
    const fetchMock = vi.fn(async () => partial(10, 20));
    const loader = new RoomDocumentRangeLoader({
      cache: createByteRangeCache(),
      capability: capability(),
      fetch: fetchMock as unknown as typeof fetch,
      now: () => NOW,
      renew: vi.fn(),
    });
    await loader.read(10, 20);
    await loader.read(10, 20);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(loader.transferredBytes).toBe(10);
  });

  it.each([
    [
      "a 200 (whole object)",
      () => new Response(new Uint8Array(10), { status: 200 }),
    ],
    ["a wrong start", () => partial(11, 21)],
    ["a wrong total length", () => partial(10, 20, LENGTH - 1)],
    [
      "a short body",
      () =>
        new Response(new Uint8Array(4), {
          headers: { "Content-Range": `bytes 10-19/${LENGTH}` },
          status: 206,
        }),
    ],
    [
      "no Content-Range",
      () => new Response(new Uint8Array(10), { status: 206 }),
    ],
  ])("fails closed on %s", async (_label, respond) => {
    const loader = new RoomDocumentRangeLoader({
      capability: capability(),
      fetch: vi.fn(async () => respond()) as unknown as typeof fetch,
      now: () => NOW,
      renew: vi.fn(),
    });
    await expect(loader.read(10, 20)).rejects.toMatchObject({
      code: "integrity",
    });
  });

  it("renews before expiry and after a 401, keeping the same version", async () => {
    const renewed = capability({
      expires_at: "2030-08-08T01:10:00Z",
      url: "https://storage.example.test/object?X-Amz-Signature=two",
    });
    const renew = vi.fn(async () => renewed);
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(url);
      return url.endsWith("one")
        ? new Response(null, { status: 401 })
        : partial(0, 10);
    });
    const loader = new RoomDocumentRangeLoader({
      capability: capability(),
      fetch: fetchMock as unknown as typeof fetch,
      now: () => NOW,
      renew,
    });
    await expect(loader.read(0, 10)).resolves.toHaveLength(10);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(urls).toEqual([capability().url, renewed.url]);

    // ≤ 30 s before the renewed URL expires, the next read renews first.
    const soon = new RoomDocumentRangeLoader({
      capability: capability({ expires_at: "2030-08-08T01:00:20Z" }),
      fetch: vi.fn(async () => partial(0, 10)) as unknown as typeof fetch,
      now: () => NOW,
      renew,
    });
    await soon.read(0, 10);
    expect(renew).toHaveBeenCalledTimes(2);
  });

  it("aborts the document when a renewed capability names another version", async () => {
    const loader = new RoomDocumentRangeLoader({
      capability: capability({ expires_at: "2030-08-08T01:00:10Z" }),
      fetch: vi.fn(async () => partial(0, 10)) as unknown as typeof fetch,
      now: () => NOW,
      renew: async () => capability({ version_id: "v-replaced" }),
    });
    const failure = await loader.read(0, 10).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RoomDocumentBytesError);
    expect((failure as RoomDocumentBytesError).code).toBe("integrity");
    // Later reads fail the same way; the viewer was not closed.
    await expect(loader.read(10, 20)).rejects.toMatchObject({
      code: "integrity",
    });
    expect(loader.aborted).toBe(false);
  });

  it("cancels in-flight requests on abort and refuses later reads", async () => {
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const loader = new RoomDocumentRangeLoader({
      capability: capability(),
      fetch: fetchMock as unknown as typeof fetch,
      now: () => NOW,
      renew: vi.fn(),
    });
    const pending = loader.read(0, 10);
    await Promise.resolve();
    loader.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(signal?.aborted).toBe(true);
    expect(loader.aborted).toBe(true);
    await expect(loader.read(0, 10)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("rejects out-of-bounds ranges and oversized documents", async () => {
    const loader = new RoomDocumentRangeLoader({
      capability: capability(),
      fetch: vi.fn() as unknown as typeof fetch,
      now: () => NOW,
      renew: vi.fn(),
    });
    await expect(loader.read(10, 10)).rejects.toMatchObject({
      code: "integrity",
    });
    await expect(loader.read(0, LENGTH + 1)).rejects.toMatchObject({
      code: "integrity",
    });
    expect(
      () =>
        new RoomDocumentRangeLoader({
          capability: capability({ content_length_bytes: 52_428_801 }),
          renew: vi.fn(),
        }),
    ).toThrow(RoomDocumentBytesError);
  });
});
