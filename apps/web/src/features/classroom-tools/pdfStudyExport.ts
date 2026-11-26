import type { StudyNoteEntry } from "@tutorhub/api-client";
import type { PdfStroke } from "@tutorhub/collaboration-client";
import {
  PDF_INK_VIEWBOX_WIDTH,
  strokeColor,
  strokeWidthUnits,
} from "./pdfAnnotationModel";
import {
  noteSheets,
  readWorksheetImage,
  type PdfRaster,
  type StudyLabels,
} from "./pdfStudyImages";
import {
  array,
  binary,
  dict,
  invalid,
  PdfRef,
  ref,
  serialize,
  StudyPdfReader,
  type PdfDict,
  type PdfValue,
} from "./pdfStudyReader";

interface StudyPdfOptions {
  bytes: Uint8Array;
  mediaType: string;
  canDownloadOriginal: boolean;
  strokes: readonly PdfStroke[];
  notes: readonly StudyNoteEntry[];
  labels: StudyLabels;
  signal?: AbortSignal;
}

class PdfWriter {
  private parts: BlobPart[];
  private offsets = new Map<number, { offset: number; generation: number }>();
  private position: number;
  constructor(
    original: Blob,
    private size: number,
  ) {
    this.parts = [original];
    this.position = original.size;
    this.append("\n");
  }
  private append(part: string | Blob) {
    const data = typeof part === "string" ? binary(part) : part;
    this.parts.push(data);
    this.position += data instanceof Blob ? data.size : data.length;
  }
  reserve() {
    return new PdfRef(this.size++);
  }
  private begin(id: PdfRef) {
    this.offsets.set(id.id, {
      offset: this.position,
      generation: id.generation,
    });
    this.append(`${id.id} ${id.generation} obj\n`);
  }
  put(id: PdfRef, value: PdfValue) {
    this.begin(id);
    this.append(serialize(value) + "\nendobj\n");
  }
  stream(data: string | Blob, attributes: PdfDict = new Map()) {
    const id = this.reserve();
    this.begin(id);
    attributes.set(
      "Length",
      typeof data === "string" ? data.length : data.size,
    );
    this.append(serialize(attributes) + "\nstream\n");
    this.append(data);
    this.append("\nendstream\nendobj\n");
    return id;
  }
  finish(trailer: PdfDict, prev?: number, xrefStream = false) {
    if (xrefStream) {
      // ISO 32000-1 §7.5.8.1: files using cross-reference streams must keep
      // using cross-reference streams in incremental updates.
      const xrefId = this.reserve();
      const start = this.position;
      this.offsets.set(xrefId.id, { offset: start, generation: 0 });
      const entries = [
        [0, { type: 0, offset: 0, generation: 65535 }] as const,
        ...[...this.offsets]
          .sort(([a], [b]) => a - b)
          .map(
            ([id, item]) =>
              [
                id,
                { type: 1, offset: item.offset, generation: item.generation },
              ] as const,
          ),
      ];
      const index: number[] = [];
      const table = new Uint8Array(entries.length * 7);
      let pos = 0;
      for (let i = 0; i < entries.length;) {
        const first = entries[i]![0];
        let end = i + 1;
        while (end < entries.length && entries[end]![0] === first + end - i)
          end++;
        index.push(first, end - i);
        for (; i < end; i++) {
          const { type, offset, generation } = entries[i]![1];
          table[pos++] = type;
          table[pos++] = (offset >>> 24) & 0xff;
          table[pos++] = (offset >>> 16) & 0xff;
          table[pos++] = (offset >>> 8) & 0xff;
          table[pos++] = offset & 0xff;
          table[pos++] = (generation >>> 8) & 0xff;
          table[pos++] = generation & 0xff;
        }
      }
      const next: PdfDict = new Map<string, PdfValue>([
        ["Type", "/XRef"],
        ["Size", this.size],
        ["W", [1, 4, 2]],
        ["Index", index],
        ["Length", table.byteLength],
      ]);
      for (const key of ["Root", "Info", "ID"]) {
        const value = trailer.get(key);
        if (value !== undefined) next.set(key, value);
      }
      if (prev !== undefined) next.set("Prev", prev);
      this.append(`${xrefId.id} 0 obj\n${serialize(next)}\nstream\n`);
      this.append(new Blob([table]));
      this.append(`\nendstream\nendobj\nstartxref\n${start}\n%%EOF\n`);
      return new Blob(this.parts, { type: "application/pdf" });
    }
    const start = this.position;
    this.append("xref\n0 1\n0000000000 65535 f \n");
    const items = [...this.offsets].sort(([a], [b]) => a - b);
    for (let i = 0; i < items.length;) {
      const first = items[i]![0];
      let end = i + 1;
      while (end < items.length && items[end]![0] === first + end - i) end++;
      this.append(`${first} ${end - i}\n`);
      for (; i < end; i++) {
        const { offset, generation } = items[i]![1];
        this.append(
          `${String(offset).padStart(10, "0")} ${String(generation).padStart(5, "0")} n \n`,
        );
      }
    }
    const next: PdfDict = new Map([["Size", this.size]]);
    for (const key of ["Root", "Info", "ID"]) {
      const value = trailer.get(key);
      if (value !== undefined) next.set(key, value);
    }
    if (prev !== undefined) next.set("Prev", prev);
    this.append(`trailer\n${serialize(next)}\nstartxref\n${start}\n%%EOF\n`);
    return new Blob(this.parts, { type: "application/pdf" });
  }
}

type Box = readonly [number, number, number, number];
interface PaperSpace {
  box: Box;
  rotate: number;
}
async function pageBox(
  reader: StudyPdfReader,
  value: PdfValue | undefined,
): Promise<Box | null> {
  const coordinates = await reader.resolve(value);
  if (!Array.isArray(coordinates) || coordinates.length !== 4) return null;
  const values = await Promise.all(
    coordinates.map((item) => reader.resolve(item)),
  );
  if (
    !values.every(
      (n): n is number => typeof n === "number" && Number.isFinite(n),
    )
  )
    return null;
  const [a, b, c, d] = values as [number, number, number, number];
  if (a === c || b === d) return null;
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}
async function paperSpace(
  reader: StudyPdfReader,
  attrs: PdfDict,
): Promise<PaperSpace> {
  const media = (await pageBox(reader, attrs.get("MediaBox"))) ?? [
    0, 0, 612, 792,
  ];
  const crop = await pageBox(reader, attrs.get("CropBox"));
  let box = media;
  if (crop) {
    const overlap: Box = [
      Math.max(media[0], crop[0]),
      Math.max(media[1], crop[1]),
      Math.min(media[2], crop[2]),
      Math.min(media[3], crop[3]),
    ];
    if (overlap[0] < overlap[2] && overlap[1] < overlap[3]) box = overlap;
  }
  const angle = await reader.resolve(attrs.get("Rotate"));
  return {
    box,
    rotate:
      typeof angle === "number" && angle % 90 === 0
        ? ((angle % 360) + 360) % 360
        : 0,
  };
}
function decimal(n: number) {
  return String(Number(n.toFixed(5)));
}
function inkContent(
  strokes: readonly PdfStroke[],
  { box, rotate }: PaperSpace,
  blendName: string,
) {
  const [left, bottom, right, top] = box;
  const width = right - left,
    height = top - bottom;
  const lineScale =
    (rotate === 90 || rotate === 270 ? height : width) / PDF_INK_VIEWBOX_WIDTH;
  const coords = (u: number, v: number) => {
    switch (rotate) {
      case 90:
        return [left + v * width, bottom + u * height];
      case 180:
        return [right - u * width, bottom + v * height];
      case 270:
        return [right - v * width, top - u * height];
      default:
        return [left + u * width, top - v * height];
    }
  };
  const lines: string[] = [];
  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    const color = strokeColor(stroke.tool, stroke.tone);
    const rgb = [1, 3, 5].map((i) =>
      decimal(parseInt(color.slice(i, i + 2), 16) / 255),
    );
    lines.push(
      "q",
      "1 J 1 j",
      rgb.join(" ") + " RG",
      decimal(strokeWidthUnits(stroke.tool, stroke.width) * lineScale) + " w",
    );
    if (stroke.tool === "highlighter") lines.push("/" + blendName + " gs");
    stroke.points.forEach(({ x, y }, i) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) invalid();
      const point = coords(
        Math.min(1, Math.max(0, x)),
        Math.min(1, Math.max(0, y)),
      )
        .map(decimal)
        .join(" ");
      lines.push(point + (i === 0 ? " m" : " l"));
      if (stroke.points.length === 1) lines.push(point + " l");
    });
    lines.push("S", "Q");
  }
  return lines.join("\n") + "\n";
}
function addBlend(resources: PdfDict, existing: PdfDict) {
  const states = new Map(existing);
  let name = "THStudyInk";
  while (states.has(name)) name += "_";
  states.set(
    name,
    new Map<string, PdfValue>([
      ["Type", "/ExtGState"],
      ["BM", "/Multiply"],
      ["CA", 0.35],
      ["ca", 0.35],
    ]),
  );
  resources.set("ExtGState", states);
  return name;
}
function imagePage(
  writer: PdfWriter,
  parent: PdfRef,
  raster: PdfRaster,
  width: number,
  height: number,
  strokes: readonly PdfStroke[] = [],
) {
  const image = writer.stream(
    raster.pixels,
    new Map<string, PdfValue>([
      ["Type", "/XObject"],
      ["Subtype", "/Image"],
      ["Width", raster.width],
      ["Height", raster.height],
      ["ColorSpace", "/DeviceRGB"],
      ["BitsPerComponent", 8],
      ["Filter", "/FlateDecode"],
    ]),
  );
  const resources: PdfDict = new Map([
    ["XObject", new Map([["Worksheet", image]])],
  ]);
  const name = strokes.some((s) => s.tool === "highlighter")
    ? addBlend(resources, new Map())
    : "";
  const box: Box = [0, 0, width, height];
  const content = writer.stream(
    `q ${decimal(width)} 0 0 ${decimal(height)} 0 0 cm /Worksheet Do Q\n` +
      inkContent(strokes, { box, rotate: 0 }, name),
  );
  const page = writer.reserve();
  writer.put(
    page,
    new Map<string, PdfValue>([
      ["Type", "/Page"],
      ["Parent", parent],
      ["MediaBox", [...box]],
      ["CropBox", [...box]],
      ["Rotate", 0],
      ["Resources", resources],
      ["Contents", content],
    ]),
  );
  return page;
}
async function appendNotes(
  writer: PdfWriter,
  parent: PdfRef,
  options: StudyPdfOptions,
) {
  const result: PdfRef[] = [];
  for await (const raster of noteSheets(
    options.notes,
    options.labels,
    options.signal,
  )) {
    result.push(imagePage(writer, parent, raster, 595, 842));
  }
  return result;
}
async function exportOriginal(options: StudyPdfOptions) {
  const original = new Blob([options.bytes.slice()], {
    type: "application/pdf",
  });
  if (!options.strokes.length && !options.notes.length) return original;
  const reader = new StudyPdfReader(options.bytes, options.signal);
  await reader.load();
  const size = reader.trailer.get("Size");
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1)
    invalid();
  const writer = new PdfWriter(original, size);
  const catalogRef = ref(reader.trailer.get("Root")),
    catalog = dict(await reader.resolve(catalogRef));
  const rootRef = ref(catalog.get("Pages")),
    root = dict(await reader.resolve(rootRef));
  const byPage = new Map<number, PdfStroke[]>();
  for (const stroke of options.strokes) {
    const group = byPage.get(stroke.page);
    if (group) group.push(stroke);
    else byPage.set(stroke.page, [stroke]);
  }
  const seen = new Set<number>();
  let pageCount = 0;
  async function visit(nodeRef: PdfRef, inherited: PdfDict, depth: number) {
    if (depth > 64 || seen.has(nodeRef.id) || seen.size > 20_000) invalid();
    seen.add(nodeRef.id);
    options.signal?.throwIfAborted();
    const node = dict(await reader.resolve(nodeRef));
    const attrs = new Map(inherited);
    for (const key of ["MediaBox", "CropBox", "Rotate", "Resources"]) {
      const value = node.get(key);
      if (value !== undefined && value !== "null") attrs.set(key, value);
    }
    if (node.get("Type") !== "/Page") {
      for (const kid of array(await reader.resolve(node.get("Kids"))))
        await visit(ref(kid), attrs, depth + 1);
      return;
    }
    if (++pageCount > 300) invalid();
    const strokes = byPage.get(pageCount);
    if (!strokes) return;
    const updated = new Map(node);
    let name = "";
    if (strokes.some((stroke) => stroke.tool === "highlighter")) {
      const resources = new Map(
        dict((await reader.resolve(attrs.get("Resources"))) ?? new Map()),
      );
      name = addBlend(
        resources,
        dict((await reader.resolve(resources.get("ExtGState"))) ?? new Map()),
      );
      updated.set("Resources", resources);
    }
    const existing = node.get("Contents");
    const resolved = await reader.resolve(existing);
    const contents = Array.isArray(resolved)
      ? resolved.map(ref)
      : existing && resolved !== "null"
        ? [ref(existing)]
        : [];
    const paint = inkContent(strokes, await paperSpace(reader, attrs), name);
    updated.set("Contents", [
      writer.stream("q\n"),
      ...contents,
      writer.stream("\nQ\n" + paint),
    ]);
    writer.put(nodeRef, updated);
  }
  await visit(rootRef, new Map(), 0);
  const appendix = await appendNotes(writer, rootRef, options);
  if (appendix.length) {
    const updated = new Map(root);
    updated.set("Kids", [
      ...array(await reader.resolve(root.get("Kids"))),
      ...appendix,
    ]);
    updated.set("Count", pageCount + appendix.length);
    writer.put(rootRef, updated);
  }
  // Transparency requires PDF 1.4. A catalog version can override an older
  // header without editing the original prefix.
  if (
    options.strokes.some((stroke) => stroke.tool === "highlighter") &&
    /%PDF-1\.[0-3]\b/.test(
      String.fromCharCode(...options.bytes.subarray(0, 1024)),
    ) &&
    String(catalog.get("Version") ?? "/1.0") < "/1.4"
  ) {
    writer.put(catalogRef, new Map(catalog).set("Version", "/1.4"));
  }
  return writer.finish(reader.trailer, reader.previous, reader.usesXRefStream);
}

/** The caller supplies the current server capability and version-verified bytes. */
export async function exportStudyPdf(options: StudyPdfOptions): Promise<Blob> {
  if (!options.canDownloadOriginal) throw new Error("Download forbidden");
  options.signal?.throwIfAborted();
  if (options.mediaType === "application/pdf") return exportOriginal(options);
  if (!["image/png", "image/jpeg", "image/webp"].includes(options.mediaType))
    throw new Error("Unsupported media type");
  const raster = await readWorksheetImage(
    options.bytes,
    options.mediaType,
    options.signal,
  );
  const writer = new PdfWriter(
    new Blob(["%PDF-1.7\n", binary("%\xE2\xE3\xCF\xD3\n")]),
    1,
  );
  const catalog = writer.reserve(),
    root = writer.reserve();
  const scale = Math.min(1, 14400 / Math.max(raster.width, raster.height));
  const page = imagePage(
    writer,
    root,
    raster,
    raster.width * scale,
    raster.height * scale,
    options.strokes.filter((stroke) => stroke.page === 1),
  );
  const kids = [page, ...(await appendNotes(writer, root, options))];
  writer.put(
    root,
    new Map<string, PdfValue>([
      ["Type", "/Pages"],
      ["Kids", kids],
      ["Count", kids.length],
    ]),
  );
  writer.put(
    catalog,
    new Map<string, PdfValue>([
      ["Type", "/Catalog"],
      ["Pages", root],
    ]),
  );
  return writer.finish(new Map([["Root", catalog]]));
}
