import { describe, expect, it, vi } from "vitest";
import {
  encodeDocumentSnippet,
  SNIPPET_ENCODE_ATTEMPTS,
  type SnippetCanvasLike,
  type SnippetEncoderHost,
} from "./documentSnippet";

type FakeCanvas = SnippetCanvasLike;

/** A host whose encoded size is (pixels × quality) / divisor bytes. */
function host(options: {
  divisor: number;
  supportsWebP?: boolean;
  fail?: boolean;
}): SnippetEncoderHost<FakeCanvas> & { calls: string[]; released: number } {
  const calls: string[] = [];
  const result = {
    calls,
    draw: (_source: FakeCanvas, width: number, height: number) => ({
      height,
      width,
    }),
    encode: vi.fn(async (canvas: FakeCanvas, type: string, quality: number) => {
      if (options.fail) return null;
      const actualType =
        type === "image/webp" && options.supportsWebP === false
          ? "image/png"
          : type;
      calls.push(`${actualType}@${quality}:${canvas.width}x${canvas.height}`);
      const size = Math.round(
        (canvas.width * canvas.height * quality) / options.divisor,
      );
      return new Blob([new Uint8Array(size)], { type: actualType });
    }),
    release: () => {
      result.released += 1;
    },
    released: 0,
  };
  return result;
}

describe("ROOM-TOOLS-FILES-01B whiteboard snippet compression", () => {
  it("has 8 rounds from quality 0.82 down to 0.40 then -15% edges", () => {
    expect(SNIPPET_ENCODE_ATTEMPTS).toHaveLength(8);
    expect(SNIPPET_ENCODE_ATTEMPTS[0]).toEqual({ quality: 0.82, scale: 1 });
    expect(SNIPPET_ENCODE_ATTEMPTS[3]).toEqual({ quality: 0.4, scale: 1 });
    expect(SNIPPET_ENCODE_ATTEMPTS[7]?.scale).toBeCloseTo(0.85 ** 4);
  });

  it("returns a WebP of at most 40 KiB as soon as a round fits", async () => {
    // 1440×1000 at q0.82 / 20 ≈ 59 KB; q0.54 ≈ 38.9 KB fits.
    const fake = host({ divisor: 20 });
    const result = await encodeDocumentSnippet(
      { height: 1000, width: 1440 },
      fake,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mimeType).toBe("image/webp");
    expect(result.blob.size).toBeLessThanOrEqual(40_960);
    expect(result.attempts).toBe(3);
    expect(result.width).toBe(1440);
  });

  it("shrinks the long edge once quality reaches 0.40", async () => {
    const fake = host({ divisor: 8 });
    const result = await encodeDocumentSnippet(
      { height: 1000, width: 1440 },
      fake,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempts).toBeGreaterThan(4);
    expect(result.width).toBeLessThan(1440);
    expect(result.blob.size).toBeLessThanOrEqual(40_960);
    expect(fake.released).toBeGreaterThan(0);
  });

  it("refuses after 8 rounds instead of returning an oversized image", async () => {
    const fake = host({ divisor: 0.5 });
    const result = await encodeDocumentSnippet(
      { height: 1000, width: 1440 },
      fake,
    );
    expect(result).toEqual({ attempts: 8, ok: false, reason: "tooLarge" });
  });

  it("falls back to JPEG without a WebP encoder and reports encode failures", async () => {
    const noWebP = host({ divisor: 40, supportsWebP: false });
    const result = await encodeDocumentSnippet(
      { height: 800, width: 1200 },
      noWebP,
    );
    expect(result.ok && result.mimeType).toBe("image/jpeg");
    expect(noWebP.calls[0]).toMatch(/^image\/png@/);
    const broken = await encodeDocumentSnippet(
      { height: 10, width: 10 },
      host({ divisor: 1, fail: true }),
    );
    expect(broken).toEqual({ attempts: 1, ok: false, reason: "encode" });
  });
});
