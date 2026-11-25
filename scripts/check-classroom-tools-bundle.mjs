import { gzipSync } from "node:zlib";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * ROOM-TOOLS-CODE-01 / ADR-0043 §1 bundle guard for the classroom tools.
 *
 * - The client entry chunk must not statically import either lazy tool
 *   engine (`LazyWhiteboardEngine-*`, `LazyCodeWorkspace-*`) and stays within
 *   the P5-14 entry budget.
 * - Opening the Code tool may only add a compact amount of JavaScript: the
 *   gzip size of the `LazyCodeWorkspace-*` static closure minus everything
 *   already loaded by then (the entry closure and the classroom room page
 *   closure). Runtime assets under `/sandbox-runtime/` (Pyodide, sql.js) and
 *   dynamically imported language packs / snippets are reported separately.
 * - Every sandbox runtime file stays below the static hosting file limit.
 */
export const CLASSROOM_TOOLS_BUNDLE_BUDGETS = Object.freeze({
  codeWorkspaceIncrementalGzipBytes: 260 * 1024,
  entryRawBytes: 768 * 1024,
  sandboxRuntimeFileBytes: 10 * 1024 * 1024,
});

const SANDBOX_RUNTIME_FILES = Object.freeze([
  "pyodide.mjs",
  "pyodide.asm.mjs",
  "pyodide.asm.wasm",
  "python_stdlib.zip",
  "pyodide-lock.json",
  "sql-wasm.js",
  "sql-wasm.wasm",
]);

export async function scanClassroomToolsBundle(directory) {
  const assetsDirectory = resolve(directory, "assets");
  const assetNames = await readdir(assetsDirectory);
  const indexHtml = await readFile(resolve(directory, "index.html"), "utf8");
  const entryMatch = indexHtml.match(
    /<script[^>]+src=["']([^"']*\/assets\/index-[^"']+\.js)["']/i,
  );
  const entryName = entryMatch ? basename(entryMatch[1]) : null;
  const single = (prefix) => {
    const matches = assetNames.filter(
      (name) => name.startsWith(prefix) && name.endsWith(".js"),
    );
    return matches.length === 1 ? matches[0] : null;
  };
  const codeName = single("LazyCodeWorkspace-");
  const whiteboardName = single("LazyWhiteboardEngine-");
  const roomName = single("MediaSpaceRoomPage-");
  const issues = [];

  if (!entryName || !assetNames.includes(entryName)) {
    issues.push("client entry chunk is missing");
  }
  if (!codeName)
    issues.push("exactly one lazy Code workspace chunk is required");
  if (!whiteboardName) {
    issues.push("exactly one lazy whiteboard engine chunk is required");
  }
  if (!roomName)
    issues.push("exactly one classroom room page chunk is required");
  if (issues.length > 0) return { issues };

  const entryClosure = await staticClosure(assetsDirectory, entryName);
  for (const name of [codeName, whiteboardName]) {
    if (entryClosure.has(name)) {
      issues.push(`initial entry statically imports ${name}`);
    }
  }
  const roomClosure = await staticClosure(assetsDirectory, roomName);
  if (roomClosure.has(codeName)) {
    issues.push("classroom room page statically imports the Code workspace");
  }

  const codeClosure = await staticClosure(assetsDirectory, codeName);
  const alreadyLoaded = new Set([...entryClosure, ...roomClosure]);
  const incremental = [...codeClosure].filter(
    (name) => !alreadyLoaded.has(name),
  );
  let codeClosureGzipBytes = 0;
  let codeClosureRawBytes = 0;
  let codeIncrementalGzipBytes = 0;
  let codeIncrementalRawBytes = 0;
  for (const name of codeClosure) {
    const bytes = await readFile(resolve(assetsDirectory, name));
    const gzip = gzipSync(bytes).byteLength;
    codeClosureRawBytes += bytes.byteLength;
    codeClosureGzipBytes += gzip;
    if (!alreadyLoaded.has(name)) {
      codeIncrementalRawBytes += bytes.byteLength;
      codeIncrementalGzipBytes += gzip;
    }
  }

  const codeSource = await readFile(resolve(assetsDirectory, codeName), "utf8");
  const dynamicChunks = [
    ...new Set(
      [
        ...codeSource.matchAll(/\bimport\(\s*[`"']([^`"']+\.js)[`"']\s*\)/g),
      ].map((match) => basename(match[1])),
    ),
  ].filter((name) => assetNames.includes(name));
  let dynamicGzipBytes = 0;
  for (const name of dynamicChunks) {
    dynamicGzipBytes += gzipSync(
      await readFile(resolve(assetsDirectory, name)),
    ).byteLength;
  }

  const entryRawBytes = (await stat(resolve(assetsDirectory, entryName))).size;
  enforceBudget(
    issues,
    "entry raw",
    entryRawBytes,
    CLASSROOM_TOOLS_BUNDLE_BUDGETS.entryRawBytes,
  );
  enforceBudget(
    issues,
    "Code workspace incremental closure gzip",
    codeIncrementalGzipBytes,
    CLASSROOM_TOOLS_BUNDLE_BUDGETS.codeWorkspaceIncrementalGzipBytes,
  );

  const sandboxRuntime = {};
  for (const name of SANDBOX_RUNTIME_FILES) {
    const path = resolve(directory, "sandbox-runtime", name);
    let size;
    try {
      size = (await stat(path)).size;
    } catch {
      issues.push(`sandbox runtime file is missing: ${name}`);
      continue;
    }
    sandboxRuntime[name] = size;
    enforceBudget(
      issues,
      `sandbox runtime ${name}`,
      size,
      CLASSROOM_TOOLS_BUNDLE_BUDGETS.sandboxRuntimeFileBytes - 1,
    );
  }

  return {
    codeChunk: codeName,
    codeClosureChunks: codeClosure.size,
    codeClosureGzipBytes,
    codeClosureRawBytes,
    codeDynamicChunks: dynamicChunks.length,
    codeDynamicGzipBytes: dynamicGzipBytes,
    codeIncrementalChunks: incremental.length,
    codeIncrementalGzipBytes,
    codeIncrementalRawBytes,
    entryChunk: entryName,
    entryRawBytes,
    issues,
    sandboxRuntime,
    whiteboardChunk: whiteboardName,
  };
}

async function staticClosure(assetsDirectory, rootName) {
  const visited = new Set();
  const pending = [rootName];
  while (pending.length > 0) {
    const name = pending.pop();
    if (!name || visited.has(name)) continue;
    visited.add(name);
    const source = await readFile(resolve(assetsDirectory, name), "utf8");
    for (const specifier of staticImportSpecifiers(source)) {
      const dependency = basename(specifier.split("?")[0]);
      if (dependency.endsWith(".js") && !visited.has(dependency)) {
        pending.push(dependency);
      }
    }
  }
  return visited;
}

function staticImportSpecifiers(source) {
  return [
    ...[...source.matchAll(/\bimport\s*["']([^"']+)["']/g)].map(
      (match) => match[1],
    ),
    ...[
      ...source.matchAll(
        /\b(?:import|export)\s*[^"'()]*?\bfrom\s*["']([^"']+)["']/g,
      ),
    ].map((match) => match[1]),
  ];
}

function enforceBudget(issues, label, actual, budget) {
  if (actual > budget) {
    issues.push(`${label} exceeds ${budget} bytes (${actual})`);
  }
}

const isMain =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const directory = resolve(process.cwd(), "apps", "web", "dist");
  const result = await scanClassroomToolsBundle(directory);
  if (result.issues.length > 0) {
    console.error(result.issues.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("ROOM_TOOLS_CODE_01_BUNDLE", JSON.stringify(result));
  }
}
