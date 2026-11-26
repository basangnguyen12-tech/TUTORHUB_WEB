import react from "@vitejs/plugin-react";
import { createReadStream } from "node:fs";
import { appendFile, readdir, readFile, stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { Connect, Plugin } from "vite";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    stripExcalidrawUpstreamFirebaseKey(),
    classroomSandboxRuntime(),
    classroomPdfRuntime(),
    react(),
  ],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              // ADR-0041: the visual effects pipeline (track processors and
              // the MediaPipe tasks runtime) stays in its own chunk, loaded
              // only through import() once an effect is enabled on a live
              // camera, so neither the LiveKit chunk nor the Pre-Join chunk
              // grows.
              name: "media-effects",
              test: /node_modules[\\/](?:@livekit[\\/]track-processors|@mediapipe[\\/]tasks-vision)[\\/]/,
              priority: 110,
              includeDependenciesRecursively: false,
            },
            {
              name: "livekit",
              test: /node_modules[\\/](?:@livekit|livekit-client)[\\/]/,
              priority: 100,
              includeDependenciesRecursively: false,
            },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
        rewrite: (path) =>
          path.replace(/^\/api\/(health|ready)(?=\/|\?|$)/, "/$1"),
      },
    },
  },
  test: {
    environment: "jsdom",
    exclude: [...configDefaults.exclude, "e2e/**"],
    maxWorkers: 4,
    setupFiles: ["./src/test/setup.ts"],
  },
});

/**
 * ROOM-TOOLS-CODE-01 / ADR-0043 §3: the classroom Code tool runs Python
 * (Pyodide, MPL-2.0, unmodified) and SQL (sql.js, MIT) inside an opaque-origin
 * sandbox. The parent page fetches these runtime files from its own origin
 * under `/sandbox-runtime/` and hands the bytes to the sandbox, so nothing is
 * loaded from a third-party CDN and no binary is committed to Git:
 * `vite dev` / `vite preview` stream an allowlisted file straight from
 * `node_modules`, and `vite build` copies exactly that set into
 * `dist/sandbox-runtime/` (each file stays under 10 MiB for static hosting).
 */
const SANDBOX_RUNTIME_PREFIX = "/sandbox-runtime/";
const SANDBOX_RUNTIME_MAX_FILE_BYTES = 10 * 1024 * 1024;
const SANDBOX_RUNTIME_FILES: Readonly<
  Record<string, { readonly source: string; readonly type: string }>
> = {
  "pyodide.mjs": {
    source: "pyodide/pyodide.mjs",
    type: "text/javascript; charset=utf-8",
  },
  "pyodide.asm.mjs": {
    source: "pyodide/pyodide.asm.mjs",
    type: "text/javascript; charset=utf-8",
  },
  "pyodide.asm.wasm": {
    source: "pyodide/pyodide.asm.wasm",
    type: "application/wasm",
  },
  "python_stdlib.zip": {
    source: "pyodide/python_stdlib.zip",
    type: "application/zip",
  },
  "pyodide-lock.json": {
    source: "pyodide/pyodide-lock.json",
    type: "application/json; charset=utf-8",
  },
  "sql-wasm.js": {
    source: "sql.js/dist/sql-wasm-browser.js",
    type: "text/javascript; charset=utf-8",
  },
  "sql-wasm.wasm": {
    source: "sql.js/dist/sql-wasm-browser.wasm",
    type: "application/wasm",
  },
};

const SANDBOX_RUNTIME_NOTICE = [
  "TutorHub classroom Code tool - client sandbox runtime files",
  "",
  "pyodide.mjs, pyodide.asm.mjs, pyodide.asm.wasm, python_stdlib.zip,",
  "pyodide-lock.json: Pyodide 314.0.8, Mozilla Public License 2.0 (MPL-2.0).",
  "Distributed unmodified from the npm package `pyodide`; the corresponding",
  "source is published by the Pyodide project (github.com/pyodide/pyodide).",
  "",
  "sql-wasm.js, sql-wasm.wasm: sql.js 1.17.0, MIT License; SQLite is in the",
  "public domain. The sql.js license text follows.",
  "",
].join("\n");

function sandboxRuntimePath(source: string): string {
  return fileURLToPath(new URL(`./node_modules/${source}`, import.meta.url));
}

function classroomSandboxRuntime(): Plugin {
  const middleware: Connect.NextHandleFunction = (request, response, next) => {
    const url = request.url ?? "";
    const name = url.split("?")[0]?.replace(/^\/+/, "") ?? "";
    const file = Object.hasOwn(SANDBOX_RUNTIME_FILES, name)
      ? SANDBOX_RUNTIME_FILES[name]
      : undefined;
    if (!file || (request.method !== "GET" && request.method !== "HEAD")) {
      next();
      return;
    }
    const path = sandboxRuntimePath(file.source);
    stat(path)
      .then((info) => {
        response.statusCode = 200;
        response.setHeader("Content-Type", file.type);
        response.setHeader("Content-Length", String(info.size));
        response.setHeader("Cache-Control", "no-cache");
        response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        response.setHeader("X-Content-Type-Options", "nosniff");
        if (request.method === "HEAD") {
          response.end();
          return;
        }
        createReadStream(path).pipe(response);
      })
      .catch(() => next());
  };
  return {
    name: "tutorhub-classroom-sandbox-runtime",
    configureServer(server) {
      server.middlewares.use(SANDBOX_RUNTIME_PREFIX, middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(SANDBOX_RUNTIME_PREFIX, middleware);
    },
    async generateBundle() {
      for (const [name, file] of Object.entries(SANDBOX_RUNTIME_FILES)) {
        const source = await readFile(sandboxRuntimePath(file.source));
        if (source.byteLength >= SANDBOX_RUNTIME_MAX_FILE_BYTES) {
          this.error(
            `sandbox runtime file ${name} is ${source.byteLength} bytes (limit ${SANDBOX_RUNTIME_MAX_FILE_BYTES})`,
          );
        }
        this.emitFile({
          fileName: `sandbox-runtime/${name}`,
          source,
          type: "asset",
        });
      }
      const sqlLicense = await readFile(
        sandboxRuntimePath("sql.js/LICENSE"),
        "utf8",
      );
      this.emitFile({
        fileName: "sandbox-runtime/NOTICE.txt",
        source: `${SANDBOX_RUNTIME_NOTICE}\n${sqlLicense}`,
        type: "asset",
      });
    },
  };
}

/**
 * ROOM-TOOLS-FILES-01B / ADR-0045 §3: the classroom Documents tool renders
 * PDFs with `pdfjs-dist@6.5.438` (Apache-2.0). Its worker, WASM image
 * decoders, CMaps, standard fonts and ICC profile are served from this origin
 * under `/pdf-runtime/` (never a CDN): `vite dev` / `vite preview` stream an
 * allowlisted file from `node_modules/pdfjs-dist`, and `vite build` copies
 * exactly that set into `dist/pdf-runtime/` (each file < 10 MiB) with a
 * `NOTICE.txt`. PDF scripting is never shipped: `pdf.sandbox*` and the
 * QuickJS engine (`quickjs-eval*`) are refused by name, and neither is in the
 * allowlist (the bundle guard fails the build if one appears in `dist/`).
 */
const PDF_RUNTIME_PREFIX = "/pdf-runtime/";
const PDF_RUNTIME_MAX_FILE_BYTES = 10 * 1024 * 1024;
const PDF_RUNTIME_FORBIDDEN = /pdf\.sandbox|quickjs/i;
const PDF_RUNTIME_FILES: Readonly<Record<string, string>> = {
  "pdf.worker.min.mjs": "build/pdf.worker.min.mjs",
  "wasm/openjpeg.wasm": "wasm/openjpeg.wasm",
  "wasm/openjpeg_nowasm_fallback.js": "wasm/openjpeg_nowasm_fallback.js",
  "wasm/jbig2.wasm": "wasm/jbig2.wasm",
  "wasm/jbig2_nowasm_fallback.js": "wasm/jbig2_nowasm_fallback.js",
  "wasm/qcms_bg.wasm": "wasm/qcms_bg.wasm",
};
const PDF_RUNTIME_DIRECTORIES: Readonly<Record<string, RegExp>> = {
  cmaps: /^[A-Za-z0-9][A-Za-z0-9._-]*\.bcmap$/,
  iccs: /^[A-Za-z0-9][A-Za-z0-9._-]*\.icc$/,
  standard_fonts: /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:pfb|ttf)$/,
};
const PDF_RUNTIME_LICENSES = [
  "LICENSE",
  "wasm/LICENSE_PDFJS_OPENJPEG",
  "wasm/LICENSE_OPENJPEG",
  "wasm/LICENSE_PDFJS_JBIG2",
  "wasm/LICENSE_JBIG2",
  "wasm/LICENSE_PDFJS_QCMS",
  "wasm/LICENSE_QCMS",
  "cmaps/LICENSE",
  "standard_fonts/LICENSE_FOXIT",
  "standard_fonts/LICENSE_LIBERATION",
  "iccs/LICENSE",
] as const;
const PDF_RUNTIME_HEADERS = [
  "/pdf-runtime/*",
  "  Cache-Control: public, max-age=86400",
  "  Cross-Origin-Resource-Policy: same-origin",
  "  X-Content-Type-Options: nosniff",
].join("\n");

function pdfRuntimePath(source: string): string {
  return fileURLToPath(
    new URL(`./node_modules/pdfjs-dist/${source}`, import.meta.url),
  );
}

/** Maps a `/pdf-runtime/` path to its allowlisted package source, or null. */
function resolvePdfRuntimeSource(name: string): string | null {
  if (PDF_RUNTIME_FORBIDDEN.test(name)) return null;
  if (Object.hasOwn(PDF_RUNTIME_FILES, name)) {
    return PDF_RUNTIME_FILES[name] ?? null;
  }
  const parts = name.split("/");
  if (parts.length !== 2) return null;
  const [directory = "", file = ""] = parts;
  const pattern = Object.hasOwn(PDF_RUNTIME_DIRECTORIES, directory)
    ? PDF_RUNTIME_DIRECTORIES[directory]
    : undefined;
  return pattern?.test(file) ? `${directory}/${file}` : null;
}

function pdfRuntimeContentType(name: string): string {
  if (/\.m?js$/.test(name)) return "text/javascript; charset=utf-8";
  if (name.endsWith(".wasm")) return "application/wasm";
  if (name.endsWith(".ttf")) return "font/ttf";
  if (name.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

async function pdfRuntimeNotice(): Promise<string> {
  const packageJSON = JSON.parse(
    await readFile(pdfRuntimePath("package.json"), "utf8"),
  ) as { version?: string };
  const sections = await Promise.all(
    PDF_RUNTIME_LICENSES.map(
      async (license) =>
        `----- pdfjs-dist/${license} -----\n${(
          await readFile(pdfRuntimePath(license), "utf8")
        ).trim()}\n`,
    ),
  );
  return [
    "TutorHub classroom Documents tool - PDF runtime files",
    "",
    `pdf.worker.min.mjs, wasm/, cmaps/, standard_fonts/, iccs/: pdfjs-dist ${packageJSON.version ?? "unknown"}`,
    "(Mozilla PDF.js), Apache License 2.0, distributed unmodified from the npm",
    "package `pdfjs-dist`. The bundled decoders keep their own licenses",
    "(OpenJPEG BSD-2-Clause, JBIG2 / QCMS as below), the Adobe CMaps and the",
    "Foxit / Liberation standard fonts keep theirs, and the ICC profile is CC0.",
    "PDF scripting (pdf.sandbox, QuickJS) is intentionally not distributed.",
    "",
    ...sections,
  ].join("\n");
}

/** Every allowlisted runtime file, as `/pdf-runtime/` names. */
async function pdfRuntimeFileNames(): Promise<string[]> {
  const names = Object.keys(PDF_RUNTIME_FILES);
  for (const directory of Object.keys(PDF_RUNTIME_DIRECTORIES)) {
    for (const entry of await readdir(pdfRuntimePath(directory))) {
      const name = `${directory}/${entry}`;
      if (resolvePdfRuntimeSource(name) !== null) names.push(name);
    }
  }
  return names.sort();
}

function classroomPdfRuntime(): Plugin {
  let headersFile: string | null = null;
  const middleware: Connect.NextHandleFunction = (request, response, next) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      next();
      return;
    }
    const name = (request.url ?? "").split("?")[0]?.replace(/^\/+/, "") ?? "";
    const source = name === "NOTICE.txt" ? null : resolvePdfRuntimeSource(name);
    if (name !== "NOTICE.txt" && source === null) {
      next();
      return;
    }
    const send = (body: Buffer | null, size: number, path?: string) => {
      response.statusCode = 200;
      response.setHeader("Content-Type", pdfRuntimeContentType(name));
      response.setHeader("Content-Length", String(size));
      response.setHeader("Cache-Control", "no-cache");
      response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      if (body) response.end(body);
      else if (path) createReadStream(path).pipe(response);
    };
    if (source === null) {
      pdfRuntimeNotice()
        .then((notice) => {
          const body = Buffer.from(notice, "utf8");
          send(body, body.byteLength);
        })
        .catch(() => next());
      return;
    }
    const path = pdfRuntimePath(source);
    stat(path)
      .then((info) => send(null, info.size, path))
      .catch(() => next());
  };
  return {
    name: "tutorhub-classroom-pdf-runtime",
    configResolved(config) {
      headersFile =
        config.command === "build"
          ? resolvePath(config.root, config.build.outDir, "_headers")
          : null;
    },
    configureServer(server) {
      server.middlewares.use(PDF_RUNTIME_PREFIX, middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(PDF_RUNTIME_PREFIX, middleware);
    },
    async generateBundle() {
      for (const name of await pdfRuntimeFileNames()) {
        const source = resolvePdfRuntimeSource(name);
        if (source === null) continue;
        const bytes = await readFile(pdfRuntimePath(source));
        if (bytes.byteLength >= PDF_RUNTIME_MAX_FILE_BYTES) {
          this.error(
            `pdf runtime file ${name} is ${bytes.byteLength} bytes (limit ${PDF_RUNTIME_MAX_FILE_BYTES})`,
          );
        }
        this.emitFile({
          fileName: `pdf-runtime/${name}`,
          source: bytes,
          type: "asset",
        });
      }
      this.emitFile({
        fileName: "pdf-runtime/NOTICE.txt",
        source: await pdfRuntimeNotice(),
        type: "asset",
      });
    },
    // Static hosting serves `dist/_headers`; give the runtime files the same
    // isolation headers as `vite dev` / `vite preview` (idempotent).
    async closeBundle() {
      if (headersFile === null) return;
      let current: string;
      try {
        current = await readFile(headersFile, "utf8");
      } catch {
        return;
      }
      if (current.includes("/pdf-runtime/*")) return;
      await appendFile(
        headersFile,
        `${current.endsWith("\n") ? "" : "\n"}\n${PDF_RUNTIME_HEADERS}\n`,
      );
    },
  };
}

function stripExcalidrawUpstreamFirebaseKey(): Plugin {
  const googleAPIKey = /\bAIza[0-9A-Za-z_-]{30,}\b/g;
  return {
    name: "tutorhub-strip-excalidraw-upstream-firebase-key",
    enforce: "pre",
    transform(source, id) {
      const normalizedID = id.replaceAll("\\", "/");
      if (
        !normalizedID.includes("/@excalidraw/excalidraw/dist/") ||
        !source.includes("VITE_APP_FIREBASE_CONFIG")
      ) {
        return null;
      }
      const redacted = source.replace(
        googleAPIKey,
        "TutorHubDisabledUpstreamFirebaseKey",
      );
      return redacted === source ? null : { code: redacted, map: null };
    },
  };
}
