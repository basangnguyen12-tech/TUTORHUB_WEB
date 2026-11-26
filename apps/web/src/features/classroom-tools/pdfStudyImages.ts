import type { StudyNoteEntry } from "@tutorhub/api-client";

export interface StudyLabels {
  notesTitle: string;
  page: (page: number) => string;
}
export interface PdfRaster {
  width: number;
  height: number;
  pixels: Blob;
}
// PDF supports RGB Flate image streams natively. Sampling in strips keeps
// the temporary RGBA buffer small and preserves worksheet text losslessly.
async function encodeRows(
  width: number,
  height: number,
  read: (row: number, rows: number) => Uint8ClampedArray,
  signal?: AbortSignal,
): Promise<PdfRaster> {
  let row = 0;
  const rgb = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      signal?.throwIfAborted();
      if (row === height) {
        controller.close();
        return;
      }
      const rows = Math.min(height - row, 64);
      const rgba = read(row, rows);
      const out = new Uint8Array(width * rows * 3);
      for (let i = 0, j = 0; i < rgba.length; i += 4) {
        out[j++] = rgba[i]!;
        out[j++] = rgba[i + 1]!;
        out[j++] = rgba[i + 2]!;
      }
      row += rows;
      controller.enqueue(out);
    },
  });
  const pixels = await new Response(
    rgb.pipeThrough(new CompressionStream("deflate")),
  ).blob();
  return { width, height, pixels };
}
function paper(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", {
    alpha: false,
    willReadFrequently: true,
  });
  if (!context) throw new Error("Canvas unavailable");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  return { canvas, context };
}
export async function readWorksheetImage(
  bytes: Uint8Array,
  type: string,
  signal?: AbortSignal,
) {
  const bitmap = await createImageBitmap(new Blob([bytes.slice()], { type }));
  try {
    signal?.throwIfAborted();
    if (
      !bitmap.width ||
      !bitmap.height ||
      bitmap.width * bitmap.height > 50_000_000
    )
      throw new Error("Unsupported image size");
    // Decode only one strip into the work canvas at a time, including for
    // 50 MP inputs. The PDF receives the complete natural-resolution image.
    const { canvas, context } = paper(
      bitmap.width,
      Math.min(bitmap.height, 64),
    );
    try {
      return await encodeRows(
        bitmap.width,
        bitmap.height,
        (row, rows) => {
          context.fillRect(0, 0, bitmap.width, rows);
          context.drawImage(
            bitmap,
            0,
            row,
            bitmap.width,
            rows,
            0,
            0,
            bitmap.width,
            rows,
          );
          return context.getImageData(0, 0, bitmap.width, rows).data;
        },
        signal,
      );
    } finally {
      canvas.width = canvas.height = 0;
    }
  } finally {
    bitmap.close();
  }
}
function* linesOf(text: string, context: CanvasRenderingContext2D) {
  const maxWidth = 595 - 88;
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/u)) {
      if (!word) continue;
      const candidate = line ? line + " " + word : word;
      if (context.measureText(candidate).width <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) yield line;
      line = "";
      for (const char of word) {
        if (line && context.measureText(line + char).width > maxWidth) {
          yield line;
          line = "";
        }
        line += char;
      }
    }
    yield line;
  }
}
export async function* noteSheets(
  notes: readonly StudyNoteEntry[],
  labels: StudyLabels,
  signal?: AbortSignal,
) {
  if (!notes.length) return;
  const { canvas, context } = paper(1190, 1684);
  try {
    context.scale(2, 2);
    const encodePage = () =>
      encodeRows(
        canvas.width,
        canvas.height,
        (row, rows) => context.getImageData(0, row, canvas.width, rows).data,
        signal,
      );
    const newPage = () => {
      context.fillStyle = "#fff";
      context.fillRect(0, 0, 595, 842);
      context.fillStyle = "#172536";
      context.font = "bold 22px sans-serif";
      context.fillText(labels.notesTitle, 44, 54);
      return 90;
    };
    const heading = (page: number, y: number) => {
      context.fillStyle = "#273b53";
      context.font = "bold 15px sans-serif";
      context.fillText(labels.page(page), 44, y);
      context.font = "12px sans-serif";
      context.fillStyle = "#172536";
      return y + 22;
    };
    let y = newPage();
    for (const note of [...notes].sort((a, b) => a.page - b.page)) {
      if (y > 760) {
        yield await encodePage();
        y = newPage();
      }
      y = heading(note.page, y);
      for (const line of linesOf(note.text, context)) {
        if (y > 798) {
          yield await encodePage();
          y = heading(note.page, newPage());
        }
        context.fillText(line, 44, y);
        y += 18;
      }
      y += 16;
    }
    yield await encodePage();
  } finally {
    canvas.width = canvas.height = 0;
  }
}
