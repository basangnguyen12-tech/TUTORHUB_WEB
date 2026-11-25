import { SANDBOX_PROTOCOL, SANDBOX_PROTOCOL_VERSION } from "./protocol";

/**
 * ROOM-TOOLS-CODE-01 / ADR-0043 §3 — the isolated runner document.
 *
 * It is loaded into `<iframe sandbox="allow-scripts">` (never
 * `allow-same-origin`), so it runs in an opaque `null` origin with no access
 * to the app's cookies, storage or DOM. The meta CSP below is in force before
 * any script runs: `connect-src 'none'` blocks fetch / XHR / WebSocket /
 * beacons from the runner and from every worker it creates (blob workers
 * inherit the creator's policy). User code never runs on the runner's main
 * thread: each language runs in a classic `blob:` worker (Chromium refuses
 * module workers from `blob:` in an opaque origin), so an infinite loop can
 * be cut by tearing the frame down while the classroom stays responsive.
 *
 * Python (Pyodide) and SQL (sql.js) runtime bytes are fetched once by the
 * parent page from its own origin and handed over through the MessagePort;
 * inside the worker a `fetch` shim only answers with those in-memory bytes.
 *
 * The two sources are plain JavaScript strings (`String.raw`, no `${}`), so
 * nothing from the user or the app is ever interpolated into them.
 */
export const SANDBOX_RUNNER_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; worker-src blob:; connect-src 'none'; img-src data: blob:; media-src 'none'; font-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none';";

/** Runs inside the sandbox worker (classic `blob:` worker, opaque origin). */
const WORKER_SOURCE = String.raw`(function () {
  "use strict";
  var post = self.postMessage.bind(self);
  var BASE = "https://runtime.tutorhub.invalid/";
  var engine = null;
  var engineKind = null;
  var enginePromise = null;
  try { self.importScripts = undefined; } catch (error) { /* ignore */ }

  function out(stream, text) {
    if (text) post({ kind: "out", stream: stream, text: String(text) });
  }

  function describe(value, depth, seen) {
    var type = typeof value;
    if (type === "string") return depth === 0 ? value : JSON.stringify(value);
    if (value === null || value === undefined || type === "number" || type === "boolean") return String(value);
    if (type === "bigint") return String(value) + "n";
    if (type === "symbol") return value.toString();
    if (type === "function") return "[Function " + (value.name || "anonymous") + "]";
    if (value instanceof Error) return value.name + ": " + value.message;
    if (seen.indexOf(value) >= 0) return "[Circular]";
    if (depth > 3) return Array.isArray(value) ? "[Array]" : "[Object]";
    seen.push(value);
    try {
      if (Array.isArray(value)) {
        var items = value.slice(0, 100).map(function (item) { return describe(item, depth + 1, seen); });
        return "[ " + items.join(", ") + (value.length > 100 ? ", …" : "") + " ]";
      }
      if (value instanceof Map) {
        var entries = [];
        value.forEach(function (v, k) { if (entries.length < 100) entries.push(describe(k, depth + 1, seen) + " => " + describe(v, depth + 1, seen)); });
        return "Map(" + value.size + ") { " + entries.join(", ") + " }";
      }
      if (value instanceof Set) {
        var members = [];
        value.forEach(function (v) { if (members.length < 100) members.push(describe(v, depth + 1, seen)); });
        return "Set(" + value.size + ") { " + members.join(", ") + " }";
      }
      var keys = Object.keys(value).slice(0, 100);
      var ctor = value.constructor && value.constructor.name;
      var prefix = ctor && ctor !== "Object" ? ctor + " " : "";
      return prefix + "{ " + keys.map(function (key) { return key + ": " + describe(value[key], depth + 1, seen); }).join(", ") + " }";
    } catch (error) {
      return "[Object]";
    } finally {
      seen.pop();
    }
  }

  function format(args) {
    var parts = [];
    for (var index = 0; index < args.length; index += 1) parts.push(describe(args[index], 0, []));
    return parts.join(" ") + "\n";
  }

  function errorText(error) {
    if (!(error instanceof Error)) return "Uncaught " + describe(error, 1, []) + "\n";
    var text = error.name + ": " + error.message;
    var match = /<anonymous>:(\d+):(\d+)/.exec(String(error.stack || ""));
    if (match) text += "\n    at line " + Math.max(1, Number(match[1]) - 2) + ", column " + match[2];
    return text + "\n";
  }

  function stdinLines(stdin) {
    var lines = stdin ? stdin.replace(/\r\n?/g, "\n").split("\n") : [];
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }

  function runJavaScript(message) {
    var lines = stdinLines(message.stdin);
    var cursor = 0;
    var finished = false;
    var mainDone = false;
    var failed = false;
    var live = new Set();
    var counters = new Map();
    var timersStarted = new Map();
    function input() { return cursor < lines.length ? lines[cursor++] : null; }
    function readStdin() { return message.stdin; }
    function settle() {
      if (finished || !mainDone || live.size > 0) return;
      finished = true;
      post({ kind: "done", ok: !failed });
    }
    function report(error) { failed = true; out("stderr", errorText(error)); }
    var sandboxConsole = {
      log: function () { out("stdout", format(arguments)); },
      info: function () { out("stdout", format(arguments)); },
      debug: function () { out("stdout", format(arguments)); },
      dir: function (value) { out("stdout", format([value])); },
      table: function (value) { out("stdout", format([value])); },
      warn: function () { out("stderr", format(arguments)); },
      error: function () { out("stderr", format(arguments)); },
      trace: function () { out("stderr", format(arguments)); },
      assert: function (condition) {
        if (!condition) out("stderr", "Assertion failed" + (arguments.length > 1 ? ": " + format(Array.prototype.slice.call(arguments, 1)) : "\n"));
      },
      count: function (label) {
        var key = label === undefined ? "default" : String(label);
        var next = (counters.get(key) || 0) + 1;
        counters.set(key, next);
        out("stdout", key + ": " + next + "\n");
      },
      time: function (label) { timersStarted.set(label === undefined ? "default" : String(label), performance.now()); },
      timeEnd: function (label) {
        var key = label === undefined ? "default" : String(label);
        var start = timersStarted.get(key);
        if (start !== undefined) out("stdout", key + ": " + (performance.now() - start).toFixed(3) + " ms\n");
        timersStarted.delete(key);
      },
      group: function () { if (arguments.length) out("stdout", format(arguments)); },
      groupEnd: function () {},
      clear: function () {}
    };
    var realSetTimeout = self.setTimeout.bind(self);
    var realClearTimeout = self.clearTimeout.bind(self);
    var realSetInterval = self.setInterval.bind(self);
    var realClearInterval = self.clearInterval.bind(self);
    self.setTimeout = function (callback, delay) {
      var extra = Array.prototype.slice.call(arguments, 2);
      var id = realSetTimeout(function () {
        live.delete(id);
        try { if (typeof callback === "function") callback.apply(null, extra); } catch (error) { report(error); }
        settle();
      }, delay);
      live.add(id);
      return id;
    };
    self.clearTimeout = function (id) { live.delete(id); realClearTimeout(id); settle(); };
    self.setInterval = function (callback, delay) {
      var extra = Array.prototype.slice.call(arguments, 2);
      var id = realSetInterval(function () {
        try { if (typeof callback === "function") callback.apply(null, extra); } catch (error) { report(error); }
      }, delay);
      live.add(id);
      return id;
    };
    self.clearInterval = function (id) { live.delete(id); realClearInterval(id); settle(); };
    self.console = sandboxConsole;
    self.addEventListener("unhandledrejection", function (event) {
      event.preventDefault();
      report(event.reason);
    });
    var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    var program;
    try {
      program = new AsyncFunction("console", "input", "prompt", "readStdin", message.code);
    } catch (error) {
      out("stderr", errorText(error));
      post({ kind: "done", ok: false });
      return;
    }
    post({ kind: "phase", phase: "running" });
    Promise.resolve()
      .then(function () { return program(sandboxConsole, input, input, readStdin); })
      .catch(report)
      .then(function () { mainDone = true; settle(); });
  }

  function makeShim(files) {
    return function (resource) {
      var url = String(resource && resource.url ? resource.url : resource);
      var hit = files[url];
      if (hit) return Promise.resolve(new Response(hit[0], { headers: { "Content-Type": hit[1] } }));
      return Promise.reject(new TypeError("Network access is disabled in the TutorHub sandbox."));
    };
  }

  var PYTHON_HARNESS = [
    "import sys, traceback",
    "def __tutorhub_run(source):",
    "    namespace = {'__name__': '__main__'}",
    "    try:",
    "        code = compile(source, 'main.py', 'exec')",
    "    except SyntaxError:",
    "        traceback.print_exc(limit=0)",
    "        return False",
    "    try:",
    "        exec(code, namespace)",
    "        return True",
    "    except SystemExit as stop:",
    "        return stop.code in (None, 0)",
    "    except BaseException as error:",
    "        tb = error.__traceback__",
    "        traceback.print_exception(type(error), error, tb.tb_next if tb is not None else None)",
    "        return False",
    "    finally:",
    "        sys.stdout.flush()",
    "        sys.stderr.flush()"
  ].join("\n");

  function initPython(runtime) {
    var files = {};
    files[BASE + "pyodide.asm.wasm"] = [runtime.wasm, "application/wasm"];
    files[BASE + "python_stdlib.zip"] = [runtime.stdlib, "application/zip"];
    self.fetch = makeShim(files);
    var loaderURL = URL.createObjectURL(new Blob([runtime.loader], { type: "text/javascript" }));
    var asmURL = URL.createObjectURL(new Blob([runtime.asm], { type: "text/javascript" }));
    var decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    return Promise.all([import(loaderURL), import(asmURL)]).then(function (modules) {
      URL.revokeObjectURL(loaderURL);
      URL.revokeObjectURL(asmURL);
      return modules[0].loadPyodide({
        indexURL: BASE,
        lockFileContents: runtime.lock,
        createPyodideModule: modules[1].default,
        checkAPIVersion: true,
        stdout: function (line) { out("stdout", line + "\n"); },
        stderr: function (line) { out("stderr", line + "\n"); }
      });
    }).then(function (pyodide) {
      pyodide.setStdout({ write: function (buffer) { out("stdout", decoders.stdout.decode(buffer, { stream: true })); return buffer.length; } });
      pyodide.setStderr({ write: function (buffer) { out("stderr", decoders.stderr.decode(buffer, { stream: true })); return buffer.length; } });
      pyodide.runPython(PYTHON_HARNESS);
      return { pyodide: pyodide, run: pyodide.globals.get("__tutorhub_run"), decoders: decoders };
    });
  }

  function runPython(state, message) {
    var given = false;
    state.pyodide.setStdin({
      stdin: function () {
        if (given || !message.stdin) return null;
        given = true;
        return message.stdin;
      },
      autoEOF: true
    });
    post({ kind: "phase", phase: "running" });
    var ok = false;
    try {
      ok = state.run(message.code) === true;
    } catch (error) {
      out("stderr", String(error && error.message ? error.message : error) + "\n");
    }
    out("stdout", state.decoders.stdout.decode());
    out("stderr", state.decoders.stderr.decode());
    post({ kind: "done", ok: ok });
  }

  function initSql(runtime) {
    var module = { exports: {} };
    var factory = new Function("module", "exports", runtime.loader + "\n;return typeof initSqlJs === 'function' ? initSqlJs : module.exports;");
    var initSqlJs = factory(module, module.exports);
    return initSqlJs({ wasmBinary: new Uint8Array(runtime.wasm) }).then(function (SQL) {
      return { SQL: SQL };
    });
  }

  function cell(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "bigint") return String(value);
    if (value instanceof Uint8Array) return "[BLOB " + value.length + " bytes]";
    return String(value).slice(0, 4096);
  }

  function runSql(state, message) {
    var db = new state.SQL.Database();
    post({ kind: "phase", phase: "running" });
    var ok = false;
    try {
      var results = db.exec(message.code);
      for (var index = 0; index < results.length && index < 20; index += 1) {
        var result = results[index];
        var columns = result.columns.slice(0, 50).map(function (name) { return String(name).slice(0, 256); });
        var rows = result.values.slice(0, 500).map(function (row) { return row.slice(0, 50).map(cell); });
        post({ kind: "table", table: { columns: columns, rows: rows, truncated: result.values.length > 500 || result.columns.length > 50 } });
      }
      if (results.length > 20) out("stderr", "Only the first 20 result sets are shown.\n");
      post({ kind: "sql-summary", changes: db.getRowsModified() });
      ok = true;
    } catch (error) {
      out("stderr", String(error && error.message ? error.message : error) + "\n");
    } finally {
      db.close();
    }
    post({ kind: "done", ok: ok });
  }

  function ensureEngine(kind) {
    if (engine && engineKind === kind) return Promise.resolve(engine);
    if (!enginePromise || engineKind !== kind) return Promise.reject(new Error("Runtime was not delivered."));
    post({ kind: "phase", phase: "initializing" });
    return enginePromise;
  }

  self.onmessage = function (event) {
    var message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.kind === "init" && !enginePromise) {
      engineKind = message.engine;
      enginePromise = (message.engine === "python" ? initPython(message.runtime) : initSql(message.runtime))
        .then(function (state) { engine = state; return state; });
      enginePromise.catch(function () {});
      return;
    }
    if (message.kind !== "run") return;
    if (message.engine === "javascript") {
      runJavaScript(message);
      return;
    }
    ensureEngine(message.engine).then(function (state) {
      if (message.engine === "python") runPython(state, message);
      else runSql(state, message);
    }, function (error) {
      out("stderr", "The " + message.engine + " runtime could not start: " + String(error && error.message ? error.message : error) + "\n");
      post({ kind: "done", ok: false, discard: true });
    });
  };
})();`;

/** Runs on the runner frame's main thread: port, limits, worker lifecycle. */
const RUNNER_SOURCE = String.raw`(function () {
  "use strict";
  var MAX_BYTES = 65536;
  var MAX_LINES = 5000;
  var FLUSH_MS = 50;
  var MAX_CHUNKS = 128;
  var MAX_TABLES = 20;
  var encoder = new TextEncoder();
  var workerURL = URL.createObjectURL(new Blob([__WORKER_SOURCE__], { type: "text/javascript" }));
  var port = null;
  var runtimes = { python: null, sql: null };
  var engines = { python: null, sql: null };
  var active = null;

  function send(message) {
    try { if (port) port.postMessage(message); } catch (error) { /* ignore */ }
  }
  function isText(value, max) { return typeof value === "string" && value.length <= max; }
  function isBuffer(value) { return value instanceof ArrayBuffer; }

  window.addEventListener("message", function (event) {
    if (port !== null || event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.protocol !== __PROTOCOL__ || data.version !== __VERSION__ || data.type !== "connect") return;
    var candidate = event.ports && event.ports[0];
    if (!candidate) return;
    port = candidate;
    port.onmessage = function (portEvent) { handle(portEvent.data); };
    send({ type: "ready" });
  });

  function handle(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "runtime") {
      var payload = message.payload;
      if (!payload || typeof payload !== "object") return;
      if (message.runtime === "python" && isText(payload.loader, 4000000) && isText(payload.asm, 8000000) &&
          isText(payload.lock, 4000000) && isBuffer(payload.wasm) && isBuffer(payload.stdlib)) {
        runtimes.python = payload;
      } else if (message.runtime === "sql" && isText(payload.loader, 4000000) && isBuffer(payload.wasm)) {
        runtimes.sql = payload;
      }
      return;
    }
    if (message.type === "run") start(message);
  }

  function start(message) {
    if (active) return;
    if (!isText(message.id, 64) || !/^[A-Za-z0-9_-]+$/.test(message.id)) return;
    if (!isText(message.code, 300000) || !isText(message.stdin, 70000)) return;
    var language = message.language;
    if (language !== "javascript" && language !== "python" && language !== "sql") return;
    active = { id: message.id, worker: null, language: language, bytes: 0, lines: 0, chunks: [], timer: 0, truncated: false, tables: 0 };
    var worker;
    try {
      if (language === "javascript") {
        worker = new Worker(workerURL);
      } else {
        if (!runtimes[language]) {
          emit("stderr", "The " + language + " runtime is not available.\n");
          finish("error", false);
          return;
        }
        worker = engines[language];
        if (!worker) {
          worker = new Worker(workerURL);
          worker.postMessage({ kind: "init", engine: language, runtime: runtimes[language] });
          engines[language] = worker;
        }
      }
    } catch (error) {
      emit("stderr", "The sandbox could not start a worker.\n");
      finish("error", false);
      return;
    }
    active.worker = worker;
    worker.onmessage = function (event) {
      if (active && active.worker === worker) fromWorker(event.data);
    };
    worker.onerror = function (event) {
      event.preventDefault();
      if (active && active.worker === worker) {
        emit("stderr", String(event.message || "Worker error") + "\n");
        finish("error", true);
      }
    };
    worker.postMessage({ kind: "run", engine: language, code: message.code, stdin: message.stdin });
  }

  function forwardTable(table) {
    if (!table || typeof table !== "object" || active.tables >= MAX_TABLES) return;
    if (!Array.isArray(table.columns) || !Array.isArray(table.rows)) return;
    var columns = table.columns.slice(0, 50).map(function (name) { return String(name).slice(0, 256); });
    var rows = table.rows.slice(0, 500).map(function (row) {
      return Array.isArray(row) ? row.slice(0, 50).map(function (value) {
        if (value === null || typeof value === "string") return value === null ? null : value.slice(0, 4096);
        return typeof value === "number" && isFinite(value) ? value : null;
      }) : [];
    });
    active.tables += 1;
    flush();
    send({ type: "table", id: active.id, table: { columns: columns, rows: rows, truncated: table.truncated === true } });
  }

  function fromWorker(message) {
    if (!message || typeof message !== "object") return;
    if (message.kind === "phase" && (message.phase === "initializing" || message.phase === "running")) {
      send({ type: "phase", id: active.id, phase: message.phase });
    } else if (message.kind === "out" && (message.stream === "stdout" || message.stream === "stderr") && typeof message.text === "string") {
      emit(message.stream, message.text);
    } else if (message.kind === "table" && active.language === "sql") {
      forwardTable(message.table);
    } else if (message.kind === "sql-summary" && active.language === "sql" && Number.isSafeInteger(message.changes)) {
      flush();
      send({ type: "sql-summary", id: active.id, changes: Math.max(0, message.changes) });
    } else if (message.kind === "done") {
      finish(message.ok === true ? "ok" : "error", message.discard === true);
    }
  }

  function emit(stream, text) {
    if (!active || active.truncated || !text) return;
    var piece = text.length > MAX_BYTES ? text.slice(0, MAX_BYTES + 1) : text;
    for (var index = 0, seen = 0; index < piece.length; index += 1) {
      if (piece.charCodeAt(index) === 10) {
        seen += 1;
        if (active.lines + seen >= MAX_LINES) {
          piece = piece.slice(0, index + 1);
          active.truncated = true;
          break;
        }
      }
    }
    var room = MAX_BYTES - active.bytes;
    var size = encoder.encode(piece).length;
    if (size > room) {
      piece = piece.slice(0, Math.max(0, room));
      while (piece && encoder.encode(piece).length > room) piece = piece.slice(0, -1);
      size = encoder.encode(piece).length;
      active.truncated = true;
    }
    active.bytes += size;
    for (var position = 0; position < piece.length; position += 1) {
      if (piece.charCodeAt(position) === 10) active.lines += 1;
    }
    var last = active.chunks[active.chunks.length - 1];
    if (piece) {
      if (last && last.stream === stream) last.text += piece;
      else active.chunks.push({ stream: stream, text: piece });
    }
    if (active.truncated) {
      finish("truncated", true);
      return;
    }
    if (active.chunks.length >= MAX_CHUNKS) flush();
    else if (!active.timer) active.timer = setTimeout(flush, FLUSH_MS);
  }

  function flush() {
    if (!active) return;
    if (active.timer) {
      clearTimeout(active.timer);
      active.timer = 0;
    }
    if (active.chunks.length > 0) {
      send({ type: "output", id: active.id, chunks: active.chunks });
      active.chunks = [];
    }
  }

  function finish(status, discard) {
    if (!active) return;
    var run = active;
    flush();
    active = null;
    if (run.worker && (run.language === "javascript" || discard)) {
      try { run.worker.terminate(); } catch (error) { /* ignore */ }
      if (engines[run.language] === run.worker) engines[run.language] = null;
    }
    send({ type: "done", id: run.id, status: status });
  }
})();`;

function scriptLiteral(value: string): string {
  // JSON string, then neutralise "<" so nothing can close the inline script.
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** The complete `srcdoc` of the runner frame (constant for a given build). */
export function buildRunnerDocument(): string {
  const script = RUNNER_SOURCE.replace("__WORKER_SOURCE__", () =>
    scriptLiteral(WORKER_SOURCE),
  )
    .replace("__PROTOCOL__", () => JSON.stringify(SANDBOX_PROTOCOL))
    .replace("__VERSION__", () => String(SANDBOX_PROTOCOL_VERSION));
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_RUNNER_CSP}">`,
    '<meta charset="utf-8">',
    "<title>TutorHub code sandbox</title>",
    "</head>",
    "<body>",
    `<script>${script}</script>`,
    "</body>",
    "</html>",
  ].join("");
}
