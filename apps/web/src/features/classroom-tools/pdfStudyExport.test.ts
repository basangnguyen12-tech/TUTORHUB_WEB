import { afterEach, describe, expect, it, vi } from "vitest";
import type { PdfStroke } from "@tutorhub/collaboration-client";
import { exportStudyPdf } from "./pdfStudyExport";

// Two independently built inputs, including a PDF whose Page and Catalog
// exist exclusively inside a compressed object stream.
const ascii = (s: string) => new TextEncoder().encode(s);
function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
async function deflate(bytes: Uint8Array<ArrayBuffer>) {
  const stream = new Response(bytes).body!.pipeThrough(
    new CompressionStream("deflate"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function fixture(packed: boolean, rotation: number, hybrid = false) {
  const chunks: Uint8Array[] = [];
  const locations = new Map<number, number>();
  let length = 0;
  const write = (data: string | Uint8Array) => {
    const chunk = typeof data === "string" ? ascii(data) : data;
    chunks.push(chunk);
    length += chunk.length;
  };
  const object = (id: number, body: string | Uint8Array, generation = 0) => {
    locations.set(id, length);
    write(`${id} ${generation} obj\n`);
    write(body);
    write("\nendobj\n");
  };
  const stream = (data: Uint8Array, attrs = "") =>
    concat([
      ascii(`<< /Length ${data.length} ${attrs} >>\nstream\n`),
      data,
      ascii("\nendstream"),
    ]);
  write(packed ? "%PDF-1.5\n" : "%PDF-1.3\n");
  const cat = "<< /Type /Catalog /Pages 2 0 R >>";
  const page = "<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>";
  object(
    2,
    `<< /Type /Pages /Count 1 /Kids [3 ${packed ? 0 : 7} R] /MediaBox [0 0 250 400] /CropBox [10 20 210 320] /Rotate ${rotation} /Resources << /Font << /F0 5 0 R >> /ExtGState << /THStudyInk << /CA 1 >> >> >> >>`,
  );
  object(
    4,
    stream(
      ascii(
        "1 0 0 1 10 20 cm\nBT /F0 14 Tf 30 40 Td (Exact original vector text) Tj ET\n",
      ),
    ),
  );
  object(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  object(6, "[4 0 R]");
  if (!packed) {
    object(1, cat);
    object(3, page, 7);
    const xref = length;
    write("xref\n0 7\n0000000000 65535 f \n");
    for (let id = 1; id <= 6; id++)
      write(
        `${String(locations.get(id)).padStart(10, "0")} ${id === 3 ? "00007" : "00000"} n \n`,
      );
    write(`trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  } else {
    const header = `1 0 3 ${cat.length + 1} `;
    object(
      7,
      stream(
        await deflate(ascii(header + cat + " " + page)),
        `/Type /ObjStm /Filter /FlateDecode /N 2 /First ${header.length}`,
      ),
    );
    const xref = length;
    const rows: Uint8Array[] = [];
    let previous = new Uint8Array(5);
    for (let id = 0; id <= 8; id++) {
      const row = new Uint8Array(5);
      const inGroup = id === 1 || id === 3;
      row[0] = id === 0 ? 0 : inGroup ? 2 : 1;
      const location = inGroup ? 7 : id === 8 ? xref : (locations.get(id) ?? 0);
      row[1] = location >>> 16;
      row[2] = location >>> 8;
      row[3] = location;
      row[4] = id === 3 ? 1 : 0;
      const delta = row.slice();
      for (let i = 0; i < 5; i++) delta[i] = row[i]! - previous[i]!;
      rows.push(new Uint8Array([2]), delta);
      previous = row;
    }
    object(
      8,
      stream(
        await deflate(concat(rows)),
        "/Type /XRef /Filter /FlateDecode /W [1 3 1] /Index [0 9] /Size 9 /Root 1 0 R /DecodeParms << /Predictor 12 /Columns 5 >>",
      ),
    );
    if (hybrid) {
      const table = length;
      write("xref\n0 9\n0000000000 65535 f \n");
      for (let id = 1; id <= 8; id++) {
        const at = locations.get(id);
        write(
          at === undefined
            ? "0000000000 00000 f \n"
            : `${String(at).padStart(10, "0")} 00000 n \n`,
        );
      }
      write(
        `trailer\n<< /Root 1 0 R /Size 9 /XRefStm ${xref} >>\nstartxref\n${table}\n%%EOF\n`,
      );
    } else write(`startxref\n${xref}\n%%EOF\n`);
  }
  return new Uint8Array(concat(chunks));
}
const stroke: PdfStroke = {
  actorId: "actor",
  id: "ink",
  page: 1,
  points: [
    { x: 0.25, y: 0.1 },
    { x: 0.75, y: 0.9 },
  ],
  tone: 1,
  tool: "pen",
  width: "m",
};
const options = {
  canDownloadOriginal: true,
  labels: {
    notesTitle: "Ghi chú học tập cá nhân",
    page: (n: number) => `Trang ${n}`,
  },
  mediaType: "application/pdf",
  notes: [{ page: 1, text: "Định lý và phương trình" }],
  strokes: [
    stroke,
    { ...stroke, id: "highlight", tool: "highlighter" as const },
  ],
};

async function reopen(bytes: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjs.getDocument({
    data: bytes.slice(),
    verbosity: 0,
    useSystemFonts: true,
    disableWorkerRendering: true,
  }).promise;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function canvasHost() {
  const paint = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () =>
      ({
        fillRect: vi.fn(),
        fillText: paint,
        drawImage: vi.fn(),
        scale: vi.fn(),
        measureText: (text: string) => ({ width: text.length * 7 }),
        getImageData: (_x: number, _y: number, w: number, h: number) => ({
          data: new Uint8ClampedArray(w * h * 4).fill(255),
        }),
      }) as unknown as CanvasRenderingContext2D,
  );
  return paint;
}
describe("study PDF incremental export", () => {
  it("uses the supplemental XRefStm over free entries in a hybrid table", async () => {
    const bytes = await fixture(true, 0, true);
    const result = await exportStudyPdf({ ...options, bytes, notes: [] });
    const pdf = await reopen(new Uint8Array(await result.arrayBuffer()));
    try {
      const page = await pdf.getPage(1);
      const content = await page.getTextContent();
      expect(
        content.items.flatMap((item) => ("str" in item ? [item.str] : [])),
      ).toContain("Exact original vector text");
    } finally {
      await pdf.loadingTask.destroy();
    }
  });
  it.each([false, true])(
    "keeps original bytes, searchable text, real ink paths and private appendix (packed %s)",
    async (packed) => {
      const paint = canvasHost();
      const bytes = await fixture(packed, 0);
      const result = await exportStudyPdf({ ...options, bytes });
      const output = new Uint8Array(await result.arrayBuffer());
      expect(output.subarray(0, bytes.length)).toEqual(bytes);
      const suffix = new TextDecoder("latin1").decode(
        output.subarray(bytes.length),
      );
      expect(suffix).toContain(packed ? "/Type /XRef" : "\nxref\n");
      expect(suffix).toContain("/BM /Multiply");
      expect(suffix).toContain("/ca 0.35");
      expect(suffix).toContain("/THStudyInk_ gs");
      expect(suffix).toContain("stream\nq\n");
      expect(suffix).toContain("stream\n\nQ\nq\n1 J 1 j");
      expect(suffix.match(/60 290 m\n160 50 l\nS/g)).toHaveLength(2);
      expect(paint).toHaveBeenCalledWith(
        options.labels.notesTitle,
        expect.any(Number),
        expect.any(Number),
      );
      expect(paint).toHaveBeenCalledWith(
        "Định lý và phương trình",
        expect.any(Number),
        expect.any(Number),
      );
      const pdf = await reopen(output);
      try {
        expect(pdf.numPages).toBe(2);
        const first = await pdf.getPage(1);
        const content = await first.getTextContent();
        expect(
          content.items.flatMap((item) => ("str" in item ? [item.str] : [])),
        ).toContain("Exact original vector text");
        const operators = await first.getOperatorList();
        const { OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
        expect(operators.fnArray).toContain(OPS.setGState);
        const appendix = await pdf.getPage(2);
        expect(appendix.rotate).toBe(0);
        expect((await appendix.getOperatorList()).fnArray).toContain(
          OPS.paintImageXObject,
        );
      } finally {
        await pdf.loadingTask.destroy();
      }
    },
  );
  it.each([
    [0, "60 290 m\n160 50 l", "0.8 w"],
    [90, "30 95 m\n190 245 l", "1.2 w"],
    [180, "160 50 m\n60 290 l", "0.8 w"],
    [270, "190 245 m\n30 95 l", "1.2 w"],
  ] as const)(
    "maps inherited crop and rotation %d to PDF coordinates",
    async (rotation, path, width) => {
      const bytes = await fixture(true, rotation);
      const output = new Uint8Array(
        await (
          await exportStudyPdf({ ...options, bytes, notes: [] })
        ).arrayBuffer(),
      );
      const suffix = new TextDecoder("latin1").decode(
        output.subarray(bytes.length),
      );
      expect(suffix).toContain(path + "\nS");
      expect(suffix).toContain(width);
      const pdf = await reopen(output);
      try {
        expect((await pdf.getPage(1)).rotate).toBe(rotation);
        expect(pdf.numPages).toBe(1);
      } finally {
        await pdf.loadingTask.destroy();
      }
    },
  );
  it("reads a prior incremental update through Prev without losing its contents", async () => {
    const original = await fixture(true, 0);
    const first = new Uint8Array(
      await (
        await exportStudyPdf({ ...options, bytes: original, notes: [] })
      ).arrayBuffer(),
    );
    const next = await exportStudyPdf({ ...options, bytes: first, notes: [] });
    const pdf = await reopen(new Uint8Array(await next.arrayBuffer()));
    try {
      const page = await pdf.getPage(1);
      const { OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
      expect(
        (await page.getOperatorList()).fnArray.filter(
          (n) => n === OPS.setGState,
        ),
      ).toHaveLength(2);
    } finally {
      await pdf.loadingTask.destroy();
    }
  });
  it.each(["image/png", "image/jpeg", "image/webp"])(
    "embeds %s and page ink into a standalone PDF",
    async (mediaType) => {
      canvasHost();
      const close = vi.fn();
      vi.stubGlobal(
        "createImageBitmap",
        vi.fn(async () => ({ width: 20, height: 30, close })),
      );
      const blob = await exportStudyPdf({
        ...options,
        mediaType,
        bytes: new Uint8Array([1]),
        notes: [],
      });
      const pdf = await reopen(new Uint8Array(await blob.arrayBuffer()));
      try {
        const page = await pdf.getPage(1);
        const { OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const ops = await page.getOperatorList();
        expect(pdf.numPages).toBe(1);
        expect(page.view).toEqual([0, 0, 20, 30]);
        expect(ops.fnArray).toContain(OPS.paintImageXObject);
        expect(ops.fnArray).toContain(OPS.setGState);
        expect(close).toHaveBeenCalledOnce();
      } finally {
        await pdf.loadingTask.destroy();
      }
    },
  );
  it("checks the download capability before accessing any source data", async () => {
    await expect(
      exportStudyPdf({
        ...options,
        canDownloadOriginal: false,
        bytes: new Uint8Array(),
      }),
    ).rejects.toThrow("forbidden");
  });
});
