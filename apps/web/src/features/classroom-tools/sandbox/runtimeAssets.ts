/**
 * ROOM-TOOLS-CODE-01 / ADR-0043 §3: Python (Pyodide) and SQL (sql.js) runtime
 * files are served by the app itself under `/sandbox-runtime/` (Vite plugin
 * in `vite.config.ts`, never a third-party CDN). The parent page downloads
 * them once per page load with progress, keeps the bytes in memory and hands
 * copies to each fresh sandbox; the browser HTTP cache serves later visits.
 */
export interface PythonRuntimePayload {
  readonly asm: string;
  readonly loader: string;
  readonly lock: string;
  readonly stdlib: ArrayBuffer;
  readonly wasm: ArrayBuffer;
}

export interface SqlRuntimePayload {
  readonly loader: string;
  readonly wasm: ArrayBuffer;
}

export type RuntimeProgress = (fraction: number) => void;

interface RuntimeFile {
  readonly expectedBytes: number;
  readonly kind: "text" | "binary";
  readonly name: string;
  /** First bytes a binary file must start with. */
  readonly magic?: readonly number[];
}

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];
const ZIP_MAGIC = [0x50, 0x4b];

const PYTHON_FILES: readonly RuntimeFile[] = [
  { expectedBytes: 17_758, kind: "text", name: "pyodide.mjs" },
  { expectedBytes: 1_250_259, kind: "text", name: "pyodide.asm.mjs" },
  {
    expectedBytes: 9_597_892,
    kind: "binary",
    magic: WASM_MAGIC,
    name: "pyodide.asm.wasm",
  },
  {
    expectedBytes: 2_545_550,
    kind: "binary",
    magic: ZIP_MAGIC,
    name: "python_stdlib.zip",
  },
  { expectedBytes: 119_077, kind: "text", name: "pyodide-lock.json" },
];

const SQL_FILES: readonly RuntimeFile[] = [
  { expectedBytes: 62_144, kind: "text", name: "sql-wasm.js" },
  {
    expectedBytes: 688_280,
    kind: "binary",
    magic: WASM_MAGIC,
    name: "sql-wasm.wasm",
  },
];

/** Approximate first-run download, for the progress copy (MB, rounded). */
export const PYTHON_RUNTIME_MEGABYTES = Math.round(
  PYTHON_FILES.reduce((sum, file) => sum + file.expectedBytes, 0) / 1_000_000,
);

function runtimeBase(): string {
  const base = import.meta.env.BASE_URL || "/";
  return `${base.endsWith("/") ? base : `${base}/`}sandbox-runtime/`;
}

async function fetchRuntimeFile(
  file: RuntimeFile,
  onBytes: (delta: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetch(`${runtimeBase()}${file.name}`, {
    credentials: "same-origin",
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`runtime file ${file.name} failed (${response.status})`);
  }
  const declared = Number(response.headers.get("Content-Length"));
  const total =
    Number.isFinite(declared) && declared > 0 ? declared : file.expectedBytes;
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.byteLength;
    onBytes(value.byteLength, total);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  if (file.magic && !file.magic.every((byte, index) => bytes[index] === byte)) {
    throw new Error(`runtime file ${file.name} is not the expected format`);
  }
  return bytes.buffer;
}

async function fetchRuntime(
  files: readonly RuntimeFile[],
  onProgress: RuntimeProgress,
): Promise<Map<string, ArrayBuffer>> {
  const totals = new Map(files.map((file) => [file.name, file.expectedBytes]));
  const received = new Map(files.map((file) => [file.name, 0]));
  const report = () => {
    let sumTotal = 0;
    let sumReceived = 0;
    for (const file of files) {
      const total = totals.get(file.name) ?? 0;
      sumTotal += total;
      sumReceived += Math.min(total, received.get(file.name) ?? 0);
    }
    onProgress(sumTotal > 0 ? Math.min(1, sumReceived / sumTotal) : 0);
  };
  const results = await Promise.all(
    files.map((file) =>
      fetchRuntimeFile(file, (delta, total) => {
        totals.set(file.name, total);
        received.set(file.name, (received.get(file.name) ?? 0) + delta);
        report();
      }),
    ),
  );
  onProgress(1);
  return new Map(files.map((file, index) => [file.name, results[index]!]));
}

const decoder = new TextDecoder();

function text(files: Map<string, ArrayBuffer>, name: string): string {
  return decoder.decode(files.get(name));
}

function binary(files: Map<string, ArrayBuffer>, name: string): ArrayBuffer {
  const value = files.get(name);
  if (!value) throw new Error(`runtime file ${name} is missing`);
  return value;
}

/** One shared download per page; progress fans out to every waiter. */
function createRuntimeLoader<Payload>(
  files: readonly RuntimeFile[],
  build: (files: Map<string, ArrayBuffer>) => Payload,
) {
  let pending: Promise<Payload> | null = null;
  let loaded: Payload | null = null;
  let lastProgress = 0;
  const listeners = new Set<RuntimeProgress>();
  return {
    peek(): Payload | null {
      return loaded;
    },
    load(onProgress?: RuntimeProgress): Promise<Payload> {
      if (loaded) return Promise.resolve(loaded);
      if (onProgress) {
        listeners.add(onProgress);
        onProgress(lastProgress);
      }
      if (!pending) {
        pending = fetchRuntime(files, (fraction) => {
          lastProgress = fraction;
          for (const listener of listeners) listener(fraction);
        })
          .then((result) => {
            loaded = build(result);
            return loaded;
          })
          .catch((error: unknown) => {
            pending = null;
            lastProgress = 0;
            throw error;
          });
      }
      const release = () => {
        if (onProgress) listeners.delete(onProgress);
      };
      return pending.then(
        (value) => {
          release();
          return value;
        },
        (error: unknown) => {
          release();
          throw error;
        },
      );
    },
  };
}

export const pythonRuntime = createRuntimeLoader<PythonRuntimePayload>(
  PYTHON_FILES,
  (files) => ({
    asm: text(files, "pyodide.asm.mjs"),
    loader: text(files, "pyodide.mjs"),
    lock: text(files, "pyodide-lock.json"),
    stdlib: binary(files, "python_stdlib.zip"),
    wasm: binary(files, "pyodide.asm.wasm"),
  }),
);

export const sqlRuntime = createRuntimeLoader<SqlRuntimePayload>(
  SQL_FILES,
  (files) => ({
    loader: text(files, "sql-wasm.js"),
    wasm: binary(files, "sql-wasm.wasm"),
  }),
);
