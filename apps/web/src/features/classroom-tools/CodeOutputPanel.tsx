import { Tabs, TabsContent, TabsList, TabsTrigger } from "@tutorhub/ui";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Eraser,
  RotateCw,
  Square,
} from "lucide-react";
import { useId, useRef } from "react";
import { useI18n, type TranslationKey } from "../../app/i18n";
import { CODE_MAX_STDIN_BYTES, utf8Bytes } from "./codeWorkspaceModel";
import {
  formatRunDuration,
  type CodeOutputTab,
  type CodePreviewState,
  type CodeRunView,
} from "./codeRun";
import type { CodeRunStatus } from "./sandbox/sandboxRunner";

const STATUS_KEYS: Readonly<Record<CodeRunStatus, TranslationKey>> = {
  crashed: "classroomTools.code.statusCrashed",
  error: "classroomTools.code.statusError",
  ok: "classroomTools.code.statusOk",
  stopped: "classroomTools.code.statusStopped",
  timeout: "classroomTools.code.statusTimeout",
  truncated: "classroomTools.code.statusTruncated",
};

/**
 * ROOM-TOOLS-CODE-01 results area: Output (text nodes only, ANSI already
 * stripped, SQL tables as plain cells), Stdin (≤ 16 KB) and the sandboxed
 * HTML preview. The preview frame stops itself if its page navigates away.
 */
export function CodeOutputPanel({
  collapsed,
  locale,
  onClearOutput,
  onCopyOutput,
  onPreviewNavigated,
  onPreviewRefresh,
  onPreviewStop,
  onStdinChange,
  onTabChange,
  onToggleCollapsed,
  preview,
  previewMessage,
  run,
  showPreviewTab,
  stdin,
  tab,
}: {
  collapsed: boolean;
  locale: string;
  onClearOutput: () => void;
  onCopyOutput: () => void;
  onPreviewNavigated: () => void;
  onPreviewRefresh: () => void;
  onPreviewStop: () => void;
  onStdinChange: (value: string) => void;
  onTabChange: (tab: CodeOutputTab) => void;
  onToggleCollapsed: () => void;
  preview: CodePreviewState | null;
  previewMessage: TranslationKey | null;
  run: CodeRunView;
  showPreviewTab: boolean;
  stdin: string;
  tab: CodeOutputTab;
}) {
  const { t } = useI18n();
  const id = useId();
  const loadCount = useRef<{ key: number; count: number }>({
    count: 0,
    key: -1,
  });
  const stdinBytes = utf8Bytes(stdin);
  const busy =
    run.phase === "preparing" ||
    run.phase === "initializing" ||
    run.phase === "running";
  const hasOutput =
    run.output.length > 0 || run.tables.length > 0 || run.notice !== null;
  const languageLabel = run.languageLabel ?? "";

  let statusText = "";
  if (run.phase === "preparing") {
    statusText =
      run.progress !== null && run.progress < 1
        ? t("classroomTools.code.statusDownloading", {
            language: languageLabel,
            size: run.runtimeMegabytes ?? 1,
          })
        : t("classroomTools.code.statusPreparing", { language: languageLabel });
  } else if (run.phase === "initializing") {
    statusText = t("classroomTools.code.statusInitializing", {
      language: languageLabel,
    });
  } else if (run.phase === "running") {
    statusText = t("classroomTools.code.statusRunning");
  } else if (run.phase === "finished" && run.result) {
    statusText = t(STATUS_KEYS[run.result.status]);
  }

  const percent =
    run.progress === null ? null : Math.round(Math.min(1, run.progress) * 100);

  return (
    <Tabs
      activationMode="automatic"
      className="classroom-code-output"
      data-collapsed={collapsed || undefined}
      onValueChange={(value) => {
        if (value === "output" || value === "stdin" || value === "preview") {
          onTabChange(value);
        }
      }}
      value={tab}
    >
      <div className="classroom-code-output__bar">
        <TabsList
          aria-label={t("classroomTools.code.outputTabs")}
          className="classroom-code-output__tabs"
        >
          <TabsTrigger className="classroom-code-output__tab" value="output">
            {t("classroomTools.code.tabOutput")}
          </TabsTrigger>
          <TabsTrigger className="classroom-code-output__tab" value="stdin">
            {t("classroomTools.code.tabStdin")}
          </TabsTrigger>
          {showPreviewTab && (
            <TabsTrigger className="classroom-code-output__tab" value="preview">
              {t("classroomTools.code.tabPreview")}
            </TabsTrigger>
          )}
        </TabsList>
        <p
          aria-atomic="true"
          aria-live="polite"
          className="classroom-code-output__status"
          data-status={run.result?.status ?? run.phase}
          role="status"
        >
          {statusText}
          {run.phase === "finished" && run.result
            ? ` · ${formatRunDuration(run.result.durationMs, locale)}`
            : ""}
        </p>
        {percent !== null && run.phase === "preparing" && (
          <span className="classroom-code-output__progress">
            <progress
              aria-label={t("classroomTools.code.statusDownloading", {
                language: languageLabel,
                size: run.runtimeMegabytes ?? 1,
              })}
              max={100}
              value={percent}
            />
            <span aria-hidden="true">{percent}%</span>
          </span>
        )}
        <button
          aria-expanded={!collapsed}
          aria-label={t(
            collapsed
              ? "classroomTools.code.expandOutput"
              : "classroomTools.code.collapseOutput",
          )}
          className="classroom-code-icon-button"
          data-tooltip={t(
            collapsed
              ? "classroomTools.code.expandOutput"
              : "classroomTools.code.collapseOutput",
          )}
          onClick={onToggleCollapsed}
          type="button"
        >
          {collapsed ? (
            <ChevronUp aria-hidden="true" />
          ) : (
            <ChevronDown aria-hidden="true" />
          )}
        </button>
      </div>

      <TabsContent className="classroom-code-output__panel" value="output">
        <div className="classroom-code-output__actions">
          <button
            className="classroom-code-text-button"
            disabled={!hasOutput}
            onClick={onCopyOutput}
            type="button"
          >
            <Copy aria-hidden="true" />
            {t("classroomTools.code.copyOutput")}
          </button>
          <button
            className="classroom-code-text-button"
            disabled={!hasOutput || busy}
            onClick={onClearOutput}
            type="button"
          >
            <Eraser aria-hidden="true" />
            {t("classroomTools.code.clearOutput")}
          </button>
        </div>
        {run.notice && (
          <p className="classroom-code-output__notice" role="note">
            {t(run.notice, { language: languageLabel })}
          </p>
        )}
        {run.output.length > 0 || !hasOutput ? (
          <pre
            aria-label={t("classroomTools.code.outputRegion")}
            className="classroom-code-output__pre"
            data-empty={!hasOutput || undefined}
            role="region"
            tabIndex={0}
          >
            {hasOutput
              ? run.output.map((chunk, index) => (
                  <span data-stream={chunk.stream} key={index}>
                    {chunk.text}
                  </span>
                ))
              : t("classroomTools.code.outputEmpty")}
          </pre>
        ) : null}
        {run.tables.map((table, index) => (
          <div
            aria-label={t("classroomTools.code.sqlTable", { index: index + 1 })}
            className="classroom-code-sql"
            key={index}
            role="region"
            tabIndex={0}
          >
            <table>
              <caption className="visually-hidden">
                {t("classroomTools.code.sqlTable", { index: index + 1 })}
              </caption>
              <thead>
                <tr>
                  {table.columns.map((column, columnIndex) => (
                    <th key={columnIndex} scope="col">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td
                        data-null={cell === null || undefined}
                        data-number={typeof cell === "number" || undefined}
                        key={cellIndex}
                      >
                        {cell === null ? "NULL" : String(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {table.truncated && (
              <p className="classroom-code-sql__note">
                {t("classroomTools.code.sqlTruncated")}
              </p>
            )}
          </div>
        ))}
        {run.sqlChanges !== null && (
          <p className="classroom-code-output__notice">
            {t("classroomTools.code.sqlChanges", { count: run.sqlChanges })}
          </p>
        )}
      </TabsContent>

      <TabsContent className="classroom-code-output__panel" value="stdin">
        <label className="classroom-code-stdin__label" htmlFor={`${id}-stdin`}>
          {t("classroomTools.code.stdinLabel")}
        </label>
        <textarea
          aria-describedby={`${id}-stdin-hint`}
          className="classroom-code-stdin"
          id={`${id}-stdin`}
          onChange={(event) => {
            const value = event.target.value;
            if (utf8Bytes(value) <= CODE_MAX_STDIN_BYTES) onStdinChange(value);
          }}
          spellCheck={false}
          value={stdin}
        />
        <p className="classroom-code-stdin__hint" id={`${id}-stdin-hint`}>
          {t("classroomTools.code.stdinHint", {
            used: (stdinBytes / 1024).toFixed(1),
          })}
        </p>
      </TabsContent>

      {showPreviewTab && (
        <TabsContent
          className="classroom-code-output__panel classroom-code-preview"
          forceMount
          value="preview"
        >
          <div className="classroom-code-output__actions">
            <button
              className="classroom-code-text-button"
              onClick={onPreviewRefresh}
              type="button"
            >
              <RotateCw aria-hidden="true" />
              {t("classroomTools.code.previewRefresh")}
            </button>
            <button
              className="classroom-code-text-button"
              disabled={!preview}
              onClick={onPreviewStop}
              type="button"
            >
              <Square aria-hidden="true" />
              {t("classroomTools.code.previewStop")}
            </button>
          </div>
          {preview ? (
            <iframe
              allow=""
              className="classroom-code-preview__frame"
              key={preview.key}
              onLoad={() => {
                const counter = loadCount.current;
                if (counter.key !== preview.key) {
                  loadCount.current = { count: 1, key: preview.key };
                  return;
                }
                counter.count += 1;
                // The srcdoc loads once; another load means the page
                // navigated itself somewhere else: stop showing it.
                if (counter.count > 1) onPreviewNavigated();
              }}
              referrerPolicy="no-referrer"
              sandbox="allow-scripts"
              srcDoc={preview.doc}
              title={t("classroomTools.code.previewTitle")}
            />
          ) : (
            <p className="classroom-code-output__notice">
              {t(previewMessage ?? "classroomTools.code.previewIdle")}
            </p>
          )}
        </TabsContent>
      )}
    </Tabs>
  );
}
