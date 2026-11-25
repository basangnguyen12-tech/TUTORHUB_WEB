import type { TranslationKey } from "../../app/i18n";
import type { CodeOutputChunk } from "./sandbox/outputBuffer";
import type { SqlResultTable } from "./sandbox/protocol";
import type { CodeRunStatus } from "./sandbox/sandboxRunner";

/** ROOM-TOOLS-CODE-01: what the results area shows for the latest run. */
export type CodeOutputTab = "output" | "stdin" | "preview";

export type CodeRunPhase =
  "idle" | "preparing" | "initializing" | "running" | "finished";

export interface CodeRunView {
  readonly fileName: string | null;
  readonly languageLabel: string | null;
  readonly notice: TranslationKey | null;
  readonly output: readonly CodeOutputChunk[];
  readonly phase: CodeRunPhase;
  /** Runtime download progress 0–1 while preparing Python / SQL. */
  readonly progress: number | null;
  /** First-run download size label, e.g. "13" (MB). */
  readonly runtimeMegabytes: number | null;
  readonly result: {
    readonly durationMs: number;
    readonly lineCount: number;
    readonly status: CodeRunStatus;
    readonly truncated: boolean;
  } | null;
  readonly sqlChanges: number | null;
  readonly tables: readonly SqlResultTable[];
}

export const IDLE_RUN: CodeRunView = {
  fileName: null,
  languageLabel: null,
  notice: null,
  output: [],
  phase: "idle",
  progress: null,
  result: null,
  runtimeMegabytes: null,
  sqlChanges: null,
  tables: [],
};

export interface CodePreviewState {
  readonly doc: string;
  readonly key: number;
}

export function formatRunDuration(ms: number, locale: string): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))} ms`;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(
    ms / 1_000,
  )} s`;
}
