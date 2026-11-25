import { CodeOutputBuffer, type CodeOutputChunk } from "./outputBuffer";
import {
  SANDBOX_PROTOCOL,
  SANDBOX_PROTOCOL_VERSION,
  parseSandboxInbound,
  type SandboxLanguage,
  type SandboxRuntimeName,
  type SqlResultTable,
} from "./protocol";
import { buildRunnerDocument } from "./runnerDocument";
import type { PythonRuntimePayload, SqlRuntimePayload } from "./runtimeAssets";

/** ADR-0043 §3 wall-clock limit for user code. */
export const CODE_RUN_TIMEOUT_MS = 5_000;
/** Generous bound for starting a runtime (Pyodide ≈ 1–3 s) before user code. */
export const CODE_RUNTIME_START_TIMEOUT_MS = 45_000;
const READY_TIMEOUT_MS = 10_000;

export type CodeRunStatus =
  "ok" | "error" | "truncated" | "timeout" | "stopped" | "crashed";

export interface CodeRunRequest {
  readonly code: string;
  readonly language: SandboxLanguage;
  readonly runtime?:
    | { readonly name: "python"; readonly payload: PythonRuntimePayload }
    | { readonly name: "sql"; readonly payload: SqlRuntimePayload };
  readonly stdin: string;
}

export interface CodeRunCallbacks {
  readonly onOutput?: (chunks: readonly CodeOutputChunk[]) => void;
  readonly onPhase?: (phase: "initializing" | "running") => void;
  readonly onSqlSummary?: (changes: number) => void;
  readonly onTable?: (table: SqlResultTable) => void;
}

export interface CodeRunResult {
  readonly durationMs: number;
  readonly lineCount: number;
  readonly output: readonly CodeOutputChunk[];
  readonly status: CodeRunStatus;
  readonly truncated: boolean;
}

/**
 * Optional dedicated cross-site sandbox origin (`VITE_CODE_SANDBOX_URL`, e.g.
 * a separate static project). It must serve `buildRunnerDocument()` with its
 * own strict response CSP and `frame-ancestors`. Only `https:` (or loopback
 * `http:` for local testing) is accepted; anything else falls back to the
 * opaque-origin `srcdoc` runner.
 */
export function configuredSandboxURL(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const url = new URL(raw.trim());
    const loopback =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      return null;
    }
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function runID(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

interface SandboxFrame {
  readonly delivered: Set<SandboxRuntimeName>;
  readonly element: HTMLIFrameElement;
  readonly port: MessagePort;
}

interface ActiveRun {
  readonly buffer: CodeOutputBuffer;
  readonly callbacks: CodeRunCallbacks;
  readonly id: string;
  readonly resolve: (result: CodeRunResult) => void;
  readonly startedAt: number;
  timer: number | null;
}

/**
 * Parent-side controller for the isolated runner frame. One run at a time;
 * a timeout, Stop or crash tears the whole frame down (terminating every
 * worker inside it) and the next run builds a clean one.
 */
export class CodeSandboxController {
  private frame: SandboxFrame | null = null;
  private framePromise: Promise<SandboxFrame> | null = null;
  private cancelPendingFrame: (() => void) | null = null;
  private active: ActiveRun | null = null;
  private disposed = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly options: {
      readonly frameTitle: string;
      readonly sandboxURL?: string | null;
      readonly timeoutMs?: number;
    },
  ) {}

  get running(): boolean {
    return this.active !== null;
  }

  run(
    request: CodeRunRequest,
    callbacks: CodeRunCallbacks = {},
  ): Promise<CodeRunResult> {
    if (this.disposed) return Promise.reject(new Error("sandbox disposed"));
    if (this.active) {
      return Promise.reject(new Error("a run is already active"));
    }
    const startedAt = performance.now();
    const buffer = new CodeOutputBuffer();
    const id = runID();
    let resolveRun!: (result: CodeRunResult) => void;
    const result = new Promise<CodeRunResult>((resolve) => {
      resolveRun = resolve;
    });
    const active: ActiveRun = {
      buffer,
      callbacks,
      id,
      resolve: resolveRun,
      startedAt,
      timer: null,
    };
    this.active = active;
    // Until user code starts, only a generous runtime-start bound applies.
    this.arm(active, CODE_RUNTIME_START_TIMEOUT_MS);

    // Detached: Stop / timeout settle `result` at once, even while the frame
    // is still starting.
    void this.ensureFrame().then(
      (frame) => {
        if (this.active !== active) return;
        if (request.runtime && !frame.delivered.has(request.runtime.name)) {
          // Structured clone (not transfer): the parent keeps its bytes.
          frame.port.postMessage({
            payload: request.runtime.payload,
            runtime: request.runtime.name,
            type: "runtime",
          });
          frame.delivered.add(request.runtime.name);
        }
        frame.port.postMessage({
          code: request.code,
          id,
          language: request.language,
          stdin: request.stdin,
          type: "run",
        });
      },
      () => this.settle(active, "crashed"),
    );
    return result;
  }

  /** Stops the active run (if any) by tearing the frame down. */
  stop(): void {
    if (this.active) this.settle(this.active, "stopped");
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.destroyFrame();
  }

  private arm(active: ActiveRun, ms: number) {
    if (active.timer !== null) globalThis.clearTimeout(active.timer);
    active.timer = globalThis.setTimeout(() => {
      if (this.active === active) this.settle(active, "timeout");
    }, ms);
  }

  private settle(active: ActiveRun, status: CodeRunStatus) {
    if (this.active !== active) return;
    this.active = null;
    if (active.timer !== null) globalThis.clearTimeout(active.timer);
    if (status === "timeout" || status === "stopped" || status === "crashed") {
      // Kill every worker (an infinite loop included) and start clean later.
      this.destroyFrame();
    }
    active.resolve({
      durationMs: Math.max(0, performance.now() - active.startedAt),
      lineCount: active.buffer.lineCount,
      output: [...active.buffer.snapshot()],
      status,
      truncated: active.buffer.truncated || status === "truncated",
    });
  }

  private onMessage(frame: SandboxFrame, data: unknown) {
    if (this.frame !== frame) return;
    const message = parseSandboxInbound(data);
    const active = this.active;
    if (!message || message.type === "ready" || !active) return;
    if (message.id !== active.id) return;
    switch (message.type) {
      case "phase":
        if (message.phase === "running") {
          this.arm(active, this.options.timeoutMs ?? CODE_RUN_TIMEOUT_MS);
        }
        active.callbacks.onPhase?.(message.phase);
        return;
      case "output": {
        for (const chunk of message.chunks) {
          active.buffer.append(chunk.stream, chunk.text);
        }
        active.callbacks.onOutput?.([...active.buffer.snapshot()]);
        if (active.buffer.truncated) this.settle(active, "truncated");
        return;
      }
      case "table":
        active.callbacks.onTable?.(message.table);
        return;
      case "sql-summary":
        active.callbacks.onSqlSummary?.(message.changes);
        return;
      case "done":
        this.settle(active, message.status);
        return;
    }
  }

  private ensureFrame(): Promise<SandboxFrame> {
    if (this.frame) return Promise.resolve(this.frame);
    if (this.framePromise) return this.framePromise;
    const promise = new Promise<SandboxFrame>((resolve, reject) => {
      const element = document.createElement("iframe");
      element.className = "classroom-code-sandbox-frame";
      element.title = this.options.frameTitle;
      element.tabIndex = -1;
      element.setAttribute("aria-hidden", "true");
      // ADR-0043 §3: scripts only — never allow-same-origin, popups, forms,
      // modals, downloads or top navigation; no device permissions.
      element.setAttribute("sandbox", "allow-scripts");
      element.setAttribute("referrerpolicy", "no-referrer");
      element.setAttribute("allow", "");
      element.setAttribute("loading", "eager");
      const channel = new MessageChannel();
      let settled = false;
      const fail = (reason: string) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        element.remove();
        channel.port1.close();
        reject(new Error(reason));
      };
      const timer = globalThis.setTimeout(
        () => fail("sandbox did not become ready"),
        READY_TIMEOUT_MS,
      );
      this.cancelPendingFrame = () => fail("sandbox start cancelled");
      const frame: SandboxFrame = {
        delivered: new Set(),
        element,
        port: channel.port1,
      };
      channel.port1.onmessage = (event: MessageEvent<unknown>) => {
        if (!settled) {
          if (parseSandboxInbound(event.data)?.type !== "ready") return;
          settled = true;
          globalThis.clearTimeout(timer);
          this.cancelPendingFrame = null;
          this.frame = frame;
          resolve(frame);
          return;
        }
        this.onMessage(frame, event.data);
      };
      element.addEventListener(
        "load",
        () => {
          // The opaque frame has no origin to target, hence "*"; only the
          // transferred port is used afterwards.
          element.contentWindow?.postMessage(
            {
              protocol: SANDBOX_PROTOCOL,
              type: "connect",
              version: SANDBOX_PROTOCOL_VERSION,
            },
            "*",
            [channel.port2],
          );
        },
        { once: true },
      );
      if (this.options.sandboxURL) element.src = this.options.sandboxURL;
      else element.srcdoc = buildRunnerDocument();
      this.host.append(element);
    });
    this.framePromise = promise;
    const clear = () => {
      if (this.framePromise === promise) this.framePromise = null;
    };
    promise.then(clear, clear);
    return promise;
  }

  private destroyFrame() {
    // A frame still starting is cancelled too (its iframe is removed).
    this.cancelPendingFrame?.();
    this.cancelPendingFrame = null;
    const frame = this.frame;
    this.frame = null;
    if (!frame) return;
    frame.port.onmessage = null;
    frame.port.close();
    frame.element.remove();
  }
}
