// Only PDF structure is interpreted here. Content, fonts and image streams
// remain opaque and are referenced in their original file.
export class PdfRef {
  constructor(
    readonly id: number,
    readonly generation = 0,
  ) {}
  toString() {
    return `${this.id} ${this.generation} R`;
  }
}
export type PdfValue = string | number | PdfRef | PdfValue[] | PdfDict;
export type PdfDict = Map<string, PdfValue>;

export function invalid(): never {
  throw new Error("Invalid or unsupported PDF structure");
}
export function dict(value: PdfValue | undefined): PdfDict {
  return value instanceof Map ? value : invalid();
}
export function array(value: PdfValue | undefined): PdfValue[] {
  return Array.isArray(value) ? value : invalid();
}
export function ref(value: PdfValue | undefined): PdfRef {
  return value instanceof PdfRef ? value : invalid();
}
function integer(
  value: PdfValue | undefined,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
    ? value
    : invalid();
}
// PDF literal strings may contain arbitrary octets. Neither UTF-8 nor
// Windows-1252 is an invertible encoding for serializing those bytes.
function latin(bytes: Uint8Array, begin: number, end: number): string {
  let result = "";
  for (let i = begin; i < end; i += 8192) {
    result += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + 8192, end)),
    );
  }
  return result;
}
export function binary(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}
function normalizedName(name: string): string {
  return name.replace(/#([a-f\d]{2})/gi, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}
function encodeName(name: string): string {
  return (
    "/" +
    name.replace(
      /[^!-~]|[#%/()[\]<>{}]/g,
      (char) => "#" + char.charCodeAt(0).toString(16).padStart(2, "0"),
    )
  );
}
export function serialize(value: PdfValue): string {
  if (Array.isArray(value)) return "[" + value.map(serialize).join(" ") + "]";
  if (value instanceof Map)
    return (
      "<<" +
      [...value]
        .map(([key, item]) => encodeName(key) + " " + serialize(item))
        .join(" ") +
      ">>"
    );
  if (typeof value === "number" && String(value).includes("e")) {
    // PDF numbers use decimal notation, including small page coordinates.
    const [mantissa, power] = String(Math.abs(value)).split("e");
    const digits = mantissa!.replace(".", "");
    const beforePoint = 1 + Number(power);
    const sign = value < 0 ? "-" : "";
    if (beforePoint <= 0)
      return sign + "0." + "0".repeat(-beforePoint) + digits;
    if (beforePoint < digits.length)
      return (
        sign + digits.slice(0, beforePoint) + "." + digits.slice(beforePoint)
      );
    return sign + digits.padEnd(beforePoint, "0");
  }
  return String(value);
}
const special = new Set([37, 40, 41, 47, 60, 62, 91, 93, 123, 125]);
function space(c: number) {
  return c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
}

class Cursor {
  constructor(
    readonly bytes: Uint8Array,
    public pos = 0,
  ) {}
  skip() {
    while (this.pos < this.bytes.length) {
      const c = this.bytes[this.pos]!;
      if (space(c)) this.pos++;
      else if (c === 37) {
        while (
          this.pos < this.bytes.length &&
          this.bytes[this.pos] !== 10 &&
          this.bytes[this.pos] !== 13
        )
          this.pos++;
      } else break;
    }
  }
  token(): string {
    this.skip();
    const start = this.pos;
    if (start >= this.bytes.length) return "";
    const first = this.bytes[this.pos++]!;
    if ((first === 60 || first === 62) && this.bytes[this.pos] === first)
      this.pos++;
    else if (first === 40) {
      let nesting = 1;
      while (nesting && this.pos < this.bytes.length) {
        const c = this.bytes[this.pos++];
        if (c === 92) this.pos++;
        else if (c === 40) nesting++;
        else if (c === 41) nesting--;
      }
      if (nesting || this.pos > this.bytes.length) invalid();
    } else if (first === 60) {
      const end = this.bytes.indexOf(62, this.pos);
      if (end < 0) invalid();
      this.pos = end + 1;
    } else if (first === 47 || !special.has(first)) {
      while (
        this.pos < this.bytes.length &&
        !space(this.bytes[this.pos]!) &&
        !special.has(this.bytes[this.pos]!)
      )
        this.pos++;
    }
    return latin(this.bytes, start, this.pos);
  }
  uint(): number {
    const token = this.token();
    return /^\d{1,12}$/.test(token) ? integer(Number(token)) : invalid();
  }
  value(depth = 0): PdfValue {
    if (depth > 64) invalid();
    const token = this.token();
    if (token === "<<") {
      const result: PdfDict = new Map();
      for (let i = 0; i < 200_000; i++) {
        const key = this.token();
        if (key === ">>") return result;
        if (!key.startsWith("/")) invalid();
        result.set(normalizedName(key.slice(1)), this.value(depth + 1));
      }
      invalid();
    }
    if (token === "[") {
      const result: PdfValue[] = [];
      while (result.length < 200_000) {
        this.skip();
        if (this.bytes[this.pos] === 93) {
          this.pos++;
          return result;
        }
        result.push(this.value(depth + 1));
      }
      invalid();
    }
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token)) {
      const number = Number(token);
      if (!Number.isFinite(number)) invalid();
      if (/^\d{1,10}$/.test(token)) {
        const saved = this.pos;
        this.skip();
        if (this.bytes[this.pos]! >= 48 && this.bytes[this.pos]! <= 57) {
          const generation = this.token();
          if (/^\d{1,5}$/.test(generation) && this.token() === "R")
            return new PdfRef(number, Number(generation));
        }
        this.pos = saved;
      }
      return number;
    }
    if (token.startsWith("/"))
      return encodeName(normalizedName(token.slice(1)));
    if (
      token.startsWith("(") ||
      token.startsWith("<") ||
      ["null", "true", "false"].includes(token)
    )
      return token;
    return invalid();
  }
}

interface ObjectAt {
  id: PdfRef;
  value: PdfValue;
  dataStart: number;
}
function objectAt(bytes: Uint8Array, offset: number): ObjectAt {
  const c = new Cursor(bytes, offset);
  const id = new PdfRef(c.uint(), c.uint());
  if (c.token() !== "obj") invalid();
  const value = c.value();
  let dataStart = -1;
  if (value instanceof Map && c.token() === "stream") {
    if (bytes[c.pos] === 13) c.pos++;
    if (bytes[c.pos] === 10) c.pos++;
    dataStart = c.pos;
  }
  return { id, value, dataStart };
}
function paeth(a: number, b: number, c: number) {
  const p = a + b - c,
    da = Math.abs(p - a),
    db = Math.abs(p - b),
    dc = Math.abs(p - c);
  return da <= db && da <= dc ? a : db <= dc ? b : c;
}
function undoPredictor(
  data: Uint8Array,
  params: PdfValue | undefined,
): Uint8Array {
  if (!(params instanceof Map)) return data;
  const predictor = integer(params.get("Predictor") ?? 1);
  if (predictor === 1) return data;
  const colors = integer(params.get("Colors") ?? 1);
  const bits = integer(params.get("BitsPerComponent") ?? 8);
  const columns = integer(params.get("Columns") ?? 1);
  const stride = Math.ceil((colors * columns * bits) / 8);
  const step = Math.ceil((colors * bits) / 8);
  if (!stride || !step) invalid();
  if (predictor === 2 && bits === 8) {
    if (data.length % stride) invalid();
    for (let row = 0; row < data.length; row += stride)
      for (let x = step; x < stride; x++)
        data[row + x] = data[row + x]! + data[row + x - step]!;
    return data;
  }
  if (predictor < 10 || predictor > 15 || data.length % (stride + 1)) invalid();
  const out = new Uint8Array((data.length / (stride + 1)) * stride);
  let source = 0;
  for (let row = 0; row < out.length; row += stride) {
    const kind = data[source++]!;
    if (kind > 4) invalid();
    for (let x = 0; x < stride; x++) {
      const i = row + x,
        left = x >= step ? out[i - step]! : 0,
        above = row ? out[i - stride]! : 0,
        diagonal = row && x >= step ? out[i - stride - step]! : 0;
      let base = 0;
      switch (kind) {
        case 1:
          base = left;
          break;
        case 2:
          base = above;
          break;
        case 3:
          base = Math.floor((left + above) / 2);
          break;
        case 4:
          base = paeth(left, above, diagonal);
          break;
      }
      out[i] = data[source++]! + base;
    }
  }
  return out;
}

type XEntry = readonly [
  type: number,
  location: number,
  generationOrIndex: number,
];
type Packed = { data: Uint8Array; objects: { id: number; start: number }[] };
export class StudyPdfReader {
  readonly trailer: PdfDict = new Map();
  readonly previous: number;
  usesXRefStream = false;
  private entries = new Map<number, XEntry>();
  private packed = new Map<number, Packed>();
  private values = new Map<number, PdfValue>();
  private budget = 64 * 1024 * 1024;
  constructor(
    private bytes: Uint8Array,
    private signal?: AbortSignal,
  ) {
    const tail = latin(bytes, Math.max(0, bytes.length - 2048), bytes.length);
    const offsets = [...tail.matchAll(/startxref\s+(\d+)\s+%%EOF/g)];
    this.previous = integer(Number(offsets.at(-1)?.[1]));
  }
  async load() {
    const seen = new Set<number>();
    const visit = async (offset: number, hybrid = false): Promise<void> => {
      if (seen.has(offset)) return;
      if (offset >= this.bytes.length || seen.size >= 1024) invalid();
      seen.add(offset);
      this.signal?.throwIfAborted();
      const c = new Cursor(this.bytes, offset);
      let trailer: PdfDict;
      const local = new Map<number, XEntry>();
      if (c.token() === "xref") {
        for (;;) {
          const start = c.token();
          if (start === "trailer") break;
          if (!/^\d{1,10}$/.test(start)) invalid();
          const count = c.uint();
          if (local.size + count > 500_000) invalid();
          for (let i = 0; i < count; i++) {
            if (i && i % 8192 === 0) {
              await new Promise((resolve) => setTimeout(resolve, 0));
              this.signal?.throwIfAborted();
            }
            const location = c.uint(),
              gen = c.uint(),
              flag = c.token();
            if (flag !== "n" && flag !== "f") invalid();
            local.set(Number(start) + i, [flag === "n" ? 1 : 0, location, gen]);
          }
        }
        trailer = dict(c.value());
      } else {
        const object = objectAt(this.bytes, offset);
        trailer = dict(object.value);
        if (trailer.get("Type") !== "/XRef") invalid();
        if (!hybrid && seen.size === 1) this.usesXRefStream = true;
        const widths = array(trailer.get("W")).map((n) => integer(n, 8));
        const ranges = array(
          trailer.get("Index") ?? [0, integer(trailer.get("Size"))],
        );
        if (widths.length !== 3 || !widths.some(Boolean) || ranges.length % 2)
          invalid();
        const bytes = await this.decode(object, integer(trailer.get("Length")));
        let pos = 0;
        const field = (width: number) => {
          let n = 0;
          for (let i = 0; i < width; i++) n = n * 256 + bytes[pos++]!;
          return integer(n);
        };
        for (let r = 0; r < ranges.length; r += 2) {
          const first = integer(ranges[r]),
            count = integer(ranges[r + 1], 500_000 - local.size);
          for (let i = 0; i < count; i++) {
            if (i && i % 8192 === 0) {
              await new Promise((resolve) => setTimeout(resolve, 0));
              this.signal?.throwIfAborted();
            }
            local.set(first + i, [
              widths[0] ? field(widths[0]) : 1,
              field(widths[1]!),
              field(widths[2]!),
            ]);
          }
        }
      }
      for (const [key, value] of trailer)
        if (!this.trailer.has(key)) this.trailer.set(key, value);
      // A hybrid's supplemental stream takes precedence over the table's
      // placeholders, but neither may replace entries in a newer revision.
      if (!hybrid && trailer.has("XRefStm"))
        await visit(integer(trailer.get("XRefStm")), true);
      for (const [id, entry] of local)
        if (!this.entries.has(id)) this.entries.set(id, entry);
      if (this.entries.size > 500_000) invalid();
      if (!hybrid && trailer.has("Prev"))
        await visit(integer(trailer.get("Prev")));
    };
    await visit(this.previous);
    if (this.trailer.has("Encrypt")) invalid();
  }
  private async decode(
    object: ObjectAt,
    length: number,
    resolveDepth?: number,
  ) {
    const d = dict(object.value);
    if (object.dataStart < 0 || object.dataStart + length > this.bytes.length)
      invalid();
    const raw = this.bytes.subarray(
      object.dataStart,
      object.dataStart + length,
    );
    // XRef stream attributes must be direct; ObjStm may refer to another
    // indexed object for the filter, parameters or length.
    const attribute = (value: PdfValue | undefined) =>
      resolveDepth === undefined ? value : this.resolve(value, resolveDepth);
    const filters = await attribute(d.get("Filter"));
    const filter = await attribute(
      Array.isArray(filters) && filters.length === 1 ? filters[0] : filters,
    );
    const max = Math.min(16 * 1024 * 1024, this.budget);
    if (!filter) {
      if (length > max) invalid();
      this.budget -= length;
      return raw;
    }
    if (filter !== "/FlateDecode" && filter !== "/Fl") invalid();
    const reader = new Response(raw.slice())
      .body!.pipeThrough(new DecompressionStream("deflate"))
      .getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        this.signal?.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > max) invalid();
        parts.push(value);
      }
    } finally {
      await reader.cancel();
    }
    this.budget -= total;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    const params = await attribute(d.get("DecodeParms"));
    return undoPredictor(
      out,
      await attribute(Array.isArray(params) ? params[0] : params),
    );
  }
  async resolve(
    value: PdfValue | undefined,
    depth = 0,
  ): Promise<PdfValue | undefined> {
    if (!(value instanceof PdfRef)) return value;
    if (depth > 16) invalid();
    const entry = this.entries.get(value.id);
    if (
      !entry ||
      (entry[0] === 2 ? value.generation !== 0 : entry[2] !== value.generation)
    )
      invalid();
    let result = this.values.get(value.id);
    if (result === undefined) {
      if (entry[0] === 1) {
        const obj = objectAt(this.bytes, entry[1]);
        if (obj.id.id !== value.id || obj.id.generation !== value.generation)
          invalid();
        result = obj.value;
      } else if (entry[0] === 2) {
        let group = this.packed.get(entry[1]);
        if (!group) {
          const parent = this.entries.get(entry[1]);
          if (parent?.[0] !== 1) invalid();
          const object = objectAt(this.bytes, parent[1]),
            d = dict(object.value);
          if (object.id.id !== entry[1] || d.get("Type") !== "/ObjStm")
            invalid();
          const data = await this.decode(
            object,
            integer(await this.resolve(d.get("Length"), depth + 1)),
            depth + 1,
          );
          const start = integer(
              await this.resolve(d.get("First"), depth + 1),
              data.length,
            ),
            count = integer(await this.resolve(d.get("N"), depth + 1), 100_000);
          const c = new Cursor(data.subarray(0, start));
          const objects = [];
          for (let i = 0; i < count; i++) {
            const id = c.uint(),
              at = start + c.uint();
            if (
              at >= data.length ||
              (objects.length && at <= objects[objects.length - 1]!.start)
            )
              invalid();
            objects.push({ id, start: at });
          }
          group = { data, objects };
          this.packed.set(entry[1], group);
        }
        const slot = group.objects[entry[2]];
        if (slot?.id !== value.id) invalid();
        result = new Cursor(
          group.data.subarray(slot.start, group.objects[entry[2] + 1]?.start),
        ).value();
      } else invalid();
      this.values.set(value.id, result);
    }
    return this.resolve(result, depth + 1);
  }
}
