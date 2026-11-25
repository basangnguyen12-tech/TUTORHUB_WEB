import react from "@vitejs/plugin-react";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Connect, Plugin } from "vite";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    stripExcalidrawUpstreamFirebaseKey(),
    classroomSandboxRuntime(),
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
