import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from "@tutorhub/ui";
import {
  BookOpen,
  FileDown,
  MessageSquareCode,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Square,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type { LanguageSupport } from "@codemirror/language";
import { useI18n, type TranslationKey } from "../../app/i18n";
import {
  Compartment,
  EditorView,
  createCodeEditorState,
  loadEditorLanguage,
  type EditorState,
} from "./codeEditor";
import type { ClassroomCodeToolProps } from "./ClassroomCodeTool";
import {
  readCodeDraft,
  writeCodeDraft,
  type CodeDraftScope,
} from "./codeDraftStorage";
import { buildCodeFence } from "./codeFence";
import {
  CODE_LANGUAGE_IDS,
  CODE_LANGUAGES,
  pickerLanguage,
  type CodeFileLanguage,
  type CodeLanguageID,
} from "./codeLanguages";
import { CodeOutputPanel } from "./CodeOutputPanel";
import {
  IDLE_RUN,
  formatRunDuration,
  type CodeOutputTab,
  type CodePreviewState,
  type CodeRunView,
} from "./codeRun";
import type {
  ClassroomCodeIncomingFile,
  ClassroomCodeSession,
  ClassroomCodeWorkspaceFile,
  ClassroomCodeWorkspaceSnapshot,
} from "./codeSession";
import { CodeSnippetDrawer } from "./CodeSnippetDrawer";
import {
  CODE_MAX_FILES,
  CODE_MAX_TOTAL_BYTES,
  defaultWorkspace,
  fileNameProblem,
  isStarterContent,
  languageForName,
  renameForLanguage,
  starterContent,
  starterFile,
  uniqueFileName,
  utf8Bytes,
} from "./codeWorkspaceModel";
import { buildPreviewDocument } from "./sandbox/previewDocument";
import {
  CodeSandboxController,
  configuredSandboxURL,
  type CodeRunRequest,
  type CodeRunResult,
} from "./sandbox/sandboxRunner";
import {
  PYTHON_RUNTIME_MEGABYTES,
  pythonRuntime,
  sqlRuntime,
} from "./sandbox/runtimeAssets";
import type { CodeSnippet } from "./snippetLibrary";
import type { ClassroomToolActions } from "./toolActions";

/**
 * ROOM-TOOLS-CODE-01 / ADR-0043 — the classroom Code workspace (lazy chunk).
 *
 * - CodeMirror 6, one EditorState per file (own undo history), ≤ 8 files and
 *   ≤ 64 KB UTF-8 in total, file names `^[A-Za-z0-9_.-]{1,64}$`.
 * - Top Bar controls (language, Run/Stop, ⋯) portal into the classroom
 *   header slot next to Close.
 * - Run goes to the opaque-origin sandbox (`CodeSandboxController`);
 *   HTML / CSS / JS renders in a sandboxed preview; C, C++ and Java edit and
 *   share now, with server compilation in a later slice.
 * - Bounded 8-hour local draft per (tenant, actor, media space), wiped by
 *   `clearPrivateSessionCache()`; received code never runs by itself.
 */
export interface CodeWorkspaceProps extends ClassroomCodeToolProps {
  readonly chatMaxCharacters: number;
  /** Classroom Top Bar slot; `undefined` outside a classroom stage. */
  readonly headerSlot: HTMLElement | null | undefined;
  readonly toolActions: ClassroomToolActions | null;
}

interface WorkspaceFile {
  readonly id: string;
  readonly language: CodeFileLanguage;
  readonly name: string;
}

interface InitialWorkspace {
  readonly activeID: string | null;
  readonly contents: Map<string, string>;
  readonly files: readonly WorkspaceFile[];
  readonly restored: boolean;
  readonly stdin: string;
}

type Announcement = { readonly text: string; readonly tone: "info" | "error" };

interface EditorCommands {
  readonly run: () => void;
  readonly stop: () => void;
  readonly toggleTabFocus: (view: EditorView) => void;
}

const NO_COMMANDS: EditorCommands = {
  run: () => undefined,
  stop: () => undefined,
  toggleTabFocus: () => undefined,
};

const OUTPUT_MIN = 18;
const OUTPUT_MAX = 75;
const OUTPUT_DEFAULT = 34;
const COMPACT_QUERY = "(max-width: 959px)";
const resolvedLanguages = new Map<CodeFileLanguage, LanguageSupport>();

function subscribeCompact(onChange: () => void): () => void {
  if (typeof globalThis.matchMedia !== "function") return () => undefined;
  const query = globalThis.matchMedia(COMPACT_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function compactSnapshot(): boolean {
  return typeof globalThis.matchMedia === "function"
    ? globalThis.matchMedia(COMPACT_QUERY).matches
    : false;
}

function buildInitialWorkspace(
  session: ClassroomCodeSession,
  scope: CodeDraftScope,
  ui: "vi" | "en",
): InitialWorkspace {
  const fromMemory = session.readSnapshot();
  const fromDraft = fromMemory ? null : readCodeDraft(scope);
  const snapshot: ClassroomCodeWorkspaceSnapshot =
    fromMemory ?? fromDraft ?? defaultWorkspace(ui);
  const contents = new Map<string, string>();
  const files = snapshot.files.map((file, index) => {
    const id = `file-${index}`;
    contents.set(id, file.content);
    return { id, language: file.language, name: file.name };
  });
  return {
    activeID: files[snapshot.activeIndex]?.id ?? files[0]?.id ?? null,
    contents,
    files,
    restored: fromDraft !== null,
    stdin: snapshot.stdin,
  };
}

async function transpileTypeScript(code: string): Promise<string> {
  const { transform } = await import("sucrase");
  return transform(code, {
    disableESTransforms: true,
    production: true,
    transforms: ["typescript"],
  }).code;
}

function downloadText(name: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export default function LazyCodeWorkspace({
  actorID,
  chatCanPost,
  chatMaxCharacters,
  headerSlot,
  mediaSpaceID,
  onSendToChat,
  session,
  tenantID,
  toolActions,
}: CodeWorkspaceProps) {
  const { language: uiLanguage, t } = useI18n();
  const locale = uiLanguage === "vi" ? "vi-VN" : "en-US";
  const id = useId();
  const labelID = `${id}-label`;
  const helpID = `${id}-help`;
  const outputPaneID = `${id}-output`;
  const languageSelectID = `${id}-language`;
  const scope = useMemo<CodeDraftScope>(
    () => ({ actorID, mediaSpaceID, tenantID }),
    [actorID, mediaSpaceID, tenantID],
  );

  const [initial] = useState(() =>
    buildInitialWorkspace(session, scope, uiLanguage),
  );
  const [files, setFiles] = useState<readonly WorkspaceFile[]>(initial.files);
  const [activeID, setActiveID] = useState<string | null>(initial.activeID);
  const [stdin, setStdin] = useState(initial.stdin);
  const [revision, setRevision] = useState(0);
  const [run, setRun] = useState<CodeRunView>(IDLE_RUN);
  const [outputTab, setOutputTab] = useState<CodeOutputTab>("output");
  const [preview, setPreview] = useState<CodePreviewState | null>(null);
  const [previewMessage, setPreviewMessage] = useState<TranslationKey | null>(
    null,
  );
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [tabFocusMode, setTabFocusMode] = useState(false);
  const [compactView, setCompactView] = useState<"editor" | "output">("editor");
  const [outputSize, setOutputSize] = useState(OUTPUT_DEFAULT);
  const [outputCollapsed, setOutputCollapsed] = useState(false);
  const [announcement, setAnnouncement] = useState<Announcement | null>(() =>
    initial.restored
      ? { text: t("classroomTools.code.draftRestored"), tone: "info" }
      : null,
  );
  const [draftStatus, setDraftStatus] = useState<"idle" | "saved" | "failed">(
    "idle",
  );
  const [renaming, setRenaming] = useState<{
    readonly error: TranslationKey | null;
    readonly id: string;
    readonly value: string;
  } | null>(null);
  const [closing, setClosing] = useState<WorkspaceFile | null>(null);
  const compact = useSyncExternalStore(
    subscribeCompact,
    compactSnapshot,
    () => false,
  );

  const [compartment] = useState(() => new Compartment());
  const contentsRef = useRef(initial.contents);
  const filesRef = useRef(files);
  const activeIDRef = useRef(activeID);
  const stdinRef = useRef(stdin);
  const viewRef = useRef<EditorView | null>(null);
  const statesRef = useRef(new Map<string, EditorState>());
  const shownFileRef = useRef<string | null>(null);
  const editorHostRef = useRef<HTMLDivElement>(null);
  const sandboxHostRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<CodeSandboxController | null>(null);
  const runTokenRef = useRef(0);
  const runningRef = useRef(false);
  const nextFileNumber = useRef(initial.files.length);
  const revisionTimer = useRef<number | null>(null);
  const skipMenuFocusRestore = useRef(false);
  const snippetsButtonRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(true);
  const commandsRef = useRef<EditorCommands>(NO_COMMANDS);
  const [usedBytes, setUsedBytes] = useState(() => {
    let sum = 0;
    for (const content of initial.contents.values()) sum += utf8Bytes(content);
    return sum;
  });

  useLayoutEffect(() => {
    filesRef.current = files;
    activeIDRef.current = activeID;
    stdinRef.current = stdin;
  });

  const activeFile = files.find((file) => file.id === activeID) ?? null;
  const activeInfo = activeFile ? CODE_LANGUAGES[activeFile.language] : null;
  const running =
    run.phase === "preparing" ||
    run.phase === "initializing" ||
    run.phase === "running";

  const announce = useCallback(
    (text: string, tone: "info" | "error" = "info") => {
      setAnnouncement({ text, tone });
    },
    [],
  );

  // Contents live in a ref (CodeMirror is uncontrolled); a short debounce
  // re-derives the byte usage and drives the draft save.
  const scheduleRevision = useCallback(() => {
    if (revisionTimer.current !== null) {
      globalThis.clearTimeout(revisionTimer.current);
    }
    revisionTimer.current = globalThis.setTimeout(() => {
      revisionTimer.current = null;
      let sum = 0;
      for (const file of filesRef.current) {
        sum += utf8Bytes(contentsRef.current.get(file.id) ?? "");
      }
      setUsedBytes(sum);
      setRevision((value) => value + 1);
    }, 250);
  }, []);

  const otherFilesBytes = useCallback((fileID: string) => {
    let sum = 0;
    for (const file of filesRef.current) {
      if (file.id !== fileID) {
        sum += utf8Bytes(contentsRef.current.get(file.id) ?? "");
      }
    }
    return sum;
  }, []);

  const applyLanguage = useCallback(
    (fileID: string, support: LanguageSupport) => {
      const view = viewRef.current;
      if (view && shownFileRef.current === fileID) {
        view.dispatch({ effects: compartment.reconfigure(support) });
        return;
      }
      const state = statesRef.current.get(fileID);
      if (state) {
        statesRef.current.set(
          fileID,
          state.update({ effects: compartment.reconfigure(support) }).state,
        );
      }
    },
    [compartment],
  );

  const ensureLanguage = useCallback(
    (fileID: string, language: CodeFileLanguage) => {
      const ready = resolvedLanguages.get(language);
      if (ready) {
        applyLanguage(fileID, ready);
        return;
      }
      loadEditorLanguage(language).then(
        (support) => {
          resolvedLanguages.set(language, support);
          const file = filesRef.current.find((item) => item.id === fileID);
          if (file && file.language === language)
            applyLanguage(fileID, support);
        },
        () => undefined,
      );
    },
    [applyLanguage],
  );

  const createState = useCallback(
    (file: WorkspaceFile): EditorState => {
      const state = createCodeEditorState({
        commands: {
          run: () => commandsRef.current.run(),
          stop: () => commandsRef.current.stop(),
          toggleTabFocus: (view) => commandsRef.current.toggleTabFocus(view),
        },
        content: contentsRef.current.get(file.id) ?? "",
        describedBy: helpID,
        labelledBy: labelID,
        language: resolvedLanguages.get(file.language) ?? [],
        languageCompartment: compartment,
        maxBytes: () => CODE_MAX_TOTAL_BYTES - otherFilesBytes(file.id),
        onChange: (content) => {
          contentsRef.current.set(file.id, content);
          scheduleRevision();
        },
        onLimit: () =>
          announce(
            t("classroomTools.code.sizeLimit", { max: "64 KB" }),
            "error",
          ),
      });
      if (!resolvedLanguages.has(file.language)) {
        // Applied once loaded (the state is stored or shown by then).
        globalThis.setTimeout(() => ensureLanguage(file.id, file.language), 0);
      }
      return state;
    },
    [
      announce,
      compartment,
      ensureLanguage,
      helpID,
      labelID,
      otherFilesBytes,
      scheduleRevision,
      t,
    ],
  );

  // One EditorView for the component's lifetime; files swap EditorStates.
  useLayoutEffect(() => {
    const host = editorHostRef.current;
    if (!host) return undefined;
    const view = new EditorView({ parent: host });
    const states = statesRef.current;
    viewRef.current = view;
    return () => {
      const shown = shownFileRef.current;
      if (shown) states.set(shown, view.state);
      view.destroy();
      viewRef.current = null;
      shownFileRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const file = files.find((item) => item.id === activeID);
    if (!file || shownFileRef.current === file.id) return;
    const shown = shownFileRef.current;
    if (shown && files.some((item) => item.id === shown)) {
      statesRef.current.set(shown, view.state);
    }
    view.setState(statesRef.current.get(file.id) ?? createState(file));
    shownFileRef.current = file.id;
  }, [activeID, createState, files]);

  const currentContent = useCallback((fileID: string): string => {
    const view = viewRef.current;
    if (view && shownFileRef.current === fileID)
      return view.state.doc.toString();
    return contentsRef.current.get(fileID) ?? "";
  }, []);

  const snapshotFiles = useCallback(
    (): ClassroomCodeWorkspaceFile[] =>
      filesRef.current.map((file) => ({
        content: currentContent(file.id),
        language: file.language,
        name: file.name,
      })),
    [currentContent],
  );

  const persist = useCallback(() => {
    const workspaceFiles = snapshotFiles();
    const activeIndex = Math.max(
      0,
      filesRef.current.findIndex((file) => file.id === activeIDRef.current),
    );
    const snapshot: ClassroomCodeWorkspaceSnapshot = {
      activeIndex,
      files: workspaceFiles,
      stdin: stdinRef.current,
    };
    session.saveSnapshot(snapshot);
    return writeCodeDraft(scope, snapshot);
  }, [scope, session, snapshotFiles]);

  // Debounced bounded draft (ADR-0029): after edits, file and stdin changes.
  useEffect(() => {
    const timer = globalThis.setTimeout(() => {
      setDraftStatus(persist() ? "saved" : "failed");
    }, 600);
    return () => globalThis.clearTimeout(timer);
  }, [activeID, files, persist, revision, stdin]);

  const flushOnLeave = useEffectEvent(() => {
    persist();
  });
  useEffect(() => {
    mountedRef.current = true;
    const onPageHide = () => flushOnLeave();
    globalThis.addEventListener("pagehide", onPageHide);
    return () => {
      mountedRef.current = false;
      globalThis.removeEventListener("pagehide", onPageHide);
      flushOnLeave();
      controllerRef.current?.dispose();
      controllerRef.current = null;
      if (revisionTimer.current !== null) {
        globalThis.clearTimeout(revisionTimer.current);
      }
    };
  }, []);

  const addFile = useCallback(
    (
      file: { content: string; language: CodeFileLanguage; name: string },
      announceKey: TranslationKey = "classroomTools.code.fileAdded",
    ): boolean => {
      const current = filesRef.current;
      if (current.length >= CODE_MAX_FILES) {
        announce(
          t("classroomTools.code.fileLimit", { max: CODE_MAX_FILES }),
          "error",
        );
        return false;
      }
      let used = 0;
      for (const item of current) used += utf8Bytes(currentContent(item.id));
      if (used + utf8Bytes(file.content) > CODE_MAX_TOTAL_BYTES) {
        announce(t("classroomTools.code.sizeLimit", { max: "64 KB" }), "error");
        return false;
      }
      const name = uniqueFileName(
        fileNameProblem(file.name, []) === null
          ? file.name
          : CODE_LANGUAGES[file.language].defaultFileName,
        current,
      );
      const fileID = `file-${nextFileNumber.current}`;
      nextFileNumber.current += 1;
      contentsRef.current.set(fileID, file.content);
      const next = [...current, { id: fileID, language: file.language, name }];
      filesRef.current = next;
      setFiles(next);
      setActiveID(fileID);
      scheduleRevision();
      announce(t(announceKey, { name }));
      return true;
    },
    [announce, currentContent, scheduleRevision, t],
  );

  const takeIncoming = useEffectEvent((blocks: ClassroomCodeIncomingFile[]) => {
    for (const block of blocks) {
      const language = block.language ?? "python";
      addFile(
        {
          content: block.code,
          language,
          name: `chat-${CODE_LANGUAGES[language].defaultFileName}`,
        },
        "classroomTools.code.openedFromChat",
      );
    }
  });

  // "Open in Code" from chat: queued blocks become new tabs (never run).
  useEffect(() => {
    let timer: number | null = null;
    const drain = () => {
      timer = null;
      const blocks = session.drain();
      if (blocks.length > 0) takeIncoming(blocks);
    };
    timer = globalThis.setTimeout(drain, 0);
    const unsubscribe = session.subscribe(() => {
      if (timer !== null) globalThis.clearTimeout(timer);
      timer = globalThis.setTimeout(drain, 0);
    });
    return () => {
      if (timer !== null) globalThis.clearTimeout(timer);
      unsubscribe();
    };
  }, [session]);

  const ensureController = (): CodeSandboxController | null => {
    if (controllerRef.current) return controllerRef.current;
    const host = sandboxHostRef.current;
    if (!host) return null;
    controllerRef.current = new CodeSandboxController(host, {
      frameTitle: t("classroomTools.code.sandboxFrame"),
      sandboxURL: configuredSandboxURL(import.meta.env.VITE_CODE_SANDBOX_URL),
    });
    return controllerRef.current;
  };

  const showOutput = () => {
    setOutputCollapsed(false);
    setCompactView("output");
  };

  const summaryFor = (result: CodeRunResult): string => {
    const duration = formatRunDuration(result.durationMs, locale);
    switch (result.status) {
      case "ok":
        return t("classroomTools.code.summaryOk", {
          duration,
          lines: result.lineCount,
        });
      case "error":
        return t("classroomTools.code.summaryError", { duration });
      case "timeout":
        return t("classroomTools.code.summaryTimeout");
      case "truncated":
        return t("classroomTools.code.summaryTruncated");
      case "stopped":
        return t("classroomTools.code.summaryStopped");
      case "crashed":
        return t("classroomTools.code.summaryCrashed");
    }
  };

  const startPreview = (fileIndex: number) => {
    const doc = buildPreviewDocument(snapshotFiles(), fileIndex);
    if (!doc) {
      setPreview(null);
      setPreviewMessage("classroomTools.code.previewMissing");
      setOutputTab("preview");
      showOutput();
      return;
    }
    setPreviewMessage(null);
    setPreview((current) => ({ doc, key: (current?.key ?? 0) + 1 }));
    setOutputTab("preview");
    showOutput();
    announce(t("classroomTools.code.previewStarted"));
  };

  const runActive = async () => {
    if (runningRef.current) return;
    const file = filesRef.current.find(
      (item) => item.id === activeIDRef.current,
    );
    if (!file) return;
    const info = CODE_LANGUAGES[file.language];
    const fileIndex = filesRef.current.indexOf(file);
    if (info.run === "preview") {
      startPreview(fileIndex);
      return;
    }
    const languageLabel = info.label;
    if (info.run === "server") {
      setRun({
        ...IDLE_RUN,
        fileName: file.name,
        languageLabel,
        notice: "classroomTools.code.serverNotice",
        phase: "finished",
      });
      setOutputTab("output");
      showOutput();
      announce(
        t("classroomTools.code.serverNotice", { language: languageLabel }),
      );
      return;
    }

    runningRef.current = true;
    const token = ++runTokenRef.current;
    const stillCurrent = () =>
      mountedRef.current && runTokenRef.current === token;
    setRun({
      ...IDLE_RUN,
      fileName: file.name,
      languageLabel,
      phase: "preparing",
      progress: null,
      runtimeMegabytes:
        info.run === "python"
          ? PYTHON_RUNTIME_MEGABYTES
          : info.run === "sql"
            ? 1
            : null,
    });
    setOutputTab("output");
    showOutput();

    const finish = (result: CodeRunResult) => {
      runningRef.current = false;
      if (!stillCurrent()) return;
      setRun((current) => ({
        ...current,
        output: result.output,
        phase: "finished",
        progress: null,
        result: {
          durationMs: result.durationMs,
          lineCount: result.lineCount,
          status: result.status,
          truncated: result.truncated,
        },
      }));
      announce(summaryFor(result), result.status === "ok" ? "info" : "error");
    };

    let runtime: CodeRunRequest["runtime"];
    try {
      const onProgress = (fraction: number) => {
        if (stillCurrent())
          setRun((current) => ({ ...current, progress: fraction }));
      };
      if (info.run === "python") {
        runtime = {
          name: "python",
          payload: await pythonRuntime.load(onProgress),
        };
      } else if (info.run === "sql") {
        runtime = { name: "sql", payload: await sqlRuntime.load(onProgress) };
      }
    } catch {
      runningRef.current = false;
      if (!stillCurrent()) return;
      setRun((current) => ({
        ...current,
        notice: "classroomTools.code.runtimeLoadError",
        phase: "finished",
        progress: null,
        result: {
          durationMs: 0,
          lineCount: 0,
          status: "error",
          truncated: false,
        },
      }));
      announce(t("classroomTools.code.runtimeLoadError"), "error");
      return;
    }
    if (!stillCurrent()) {
      runningRef.current = false;
      return;
    }

    let code = currentContent(file.id);
    if (file.language === "typescript") {
      try {
        code = await transpileTypeScript(code);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finish({
          durationMs: 0,
          lineCount: 1,
          output: [{ stream: "stderr", text: `TypeScript: ${message}\n` }],
          status: "error",
          truncated: false,
        });
        return;
      }
      if (!stillCurrent()) {
        runningRef.current = false;
        return;
      }
    }

    const controller = ensureController();
    if (!controller) {
      runningRef.current = false;
      return;
    }
    const result = await controller.run(
      {
        code,
        language:
          info.run === "python"
            ? "python"
            : info.run === "sql"
              ? "sql"
              : "javascript",
        runtime,
        stdin: stdinRef.current,
      },
      {
        onOutput: (chunks) => {
          if (stillCurrent())
            setRun((current) => ({ ...current, output: chunks }));
        },
        onPhase: (phase) => {
          if (stillCurrent()) setRun((current) => ({ ...current, phase }));
        },
        onSqlSummary: (changes) => {
          if (stillCurrent()) {
            setRun((current) => ({ ...current, sqlChanges: changes }));
          }
        },
        onTable: (table) => {
          if (stillCurrent()) {
            setRun((current) => ({
              ...current,
              tables: [...current.tables, table],
            }));
          }
        },
      },
    );
    finish(result);
  };

  const stopRun = () => {
    if (!runningRef.current) return;
    if (controllerRef.current?.running) {
      controllerRef.current.stop();
      return;
    }
    // Still downloading or transpiling: abandon this run.
    runTokenRef.current += 1;
    runningRef.current = false;
    setRun((current) => ({
      ...current,
      phase: "finished",
      progress: null,
      result: {
        durationMs: 0,
        lineCount: 0,
        status: "stopped",
        truncated: false,
      },
    }));
    announce(t("classroomTools.code.summaryStopped"));
  };

  const toggleTabFocus = (view: EditorView) => {
    const next = !tabFocusMode;
    view.setTabFocusMode(next);
    setTabFocusMode(next);
    announce(
      t(
        next
          ? "classroomTools.code.tabFocusOn"
          : "classroomTools.code.tabFocusOff",
      ),
    );
  };

  useLayoutEffect(() => {
    commandsRef.current = {
      run: () => void runActive(),
      stop: stopRun,
      toggleTabFocus,
    };
  });

  const activate = (fileID: string) => {
    setRenaming(null);
    setActiveID(fileID);
  };

  const changeLanguage = (language: CodeLanguageID) => {
    const file = filesRef.current.find(
      (item) => item.id === activeIDRef.current,
    );
    if (!file || pickerLanguage(file.language) === language) return;
    const content = currentContent(file.id);
    if (isStarterContent(content)) {
      // Unedited starter: convert this file in place.
      const name = uniqueFileName(
        renameForLanguage(file.name, language),
        filesRef.current.filter((item) => item.id !== file.id),
      );
      const starter = starterContent(language, uiLanguage);
      const view = viewRef.current;
      if (view && shownFileRef.current === file.id) {
        view.dispatch({
          changes: { from: 0, insert: starter, to: view.state.doc.length },
        });
      }
      contentsRef.current.set(file.id, starter);
      const next = filesRef.current.map((item) =>
        item.id === file.id ? { ...item, language, name } : item,
      );
      filesRef.current = next;
      setFiles(next);
      ensureLanguage(file.id, language);
      announce(
        t("classroomTools.code.languageChanged", {
          language: CODE_LANGUAGES[language].label,
          name,
        }),
      );
      return;
    }
    // Edited content stays; a starter file for the new language opens.
    const starter = starterFile(language, uiLanguage, filesRef.current);
    addFile(starter, "classroomTools.code.newFileForLanguage");
  };

  const sendToChat = () => {
    const file = filesRef.current.find(
      (item) => item.id === activeIDRef.current,
    );
    if (!file || !onSendToChat || !toolActions) return;
    if (!chatCanPost) {
      announce(t("classroomTools.code.chatLocked"), "error");
      return;
    }
    const view = viewRef.current;
    let code = currentContent(file.id);
    if (view && shownFileRef.current === file.id) {
      const selection = view.state.selection.main;
      if (!selection.empty)
        code = view.state.sliceDoc(selection.from, selection.to);
    }
    const fence = buildCodeFence(file.language, code, chatMaxCharacters);
    onSendToChat(fence.text);
    skipMenuFocusRestore.current = true;
    toolActions.openChat();
    announce(
      t(
        fence.truncated
          ? "classroomTools.code.sentToChatTruncated"
          : "classroomTools.code.sentToChat",
      ),
      fence.truncated ? "error" : "info",
    );
  };

  const download = () => {
    const file = filesRef.current.find(
      (item) => item.id === activeIDRef.current,
    );
    if (!file) return;
    downloadText(
      file.name,
      currentContent(file.id),
      CODE_LANGUAGES[file.language].mimeType,
    );
    announce(t("classroomTools.code.downloaded", { name: file.name }));
  };

  const restoreStarter = () => {
    const file = filesRef.current.find(
      (item) => item.id === activeIDRef.current,
    );
    const view = viewRef.current;
    if (!file || !view || shownFileRef.current !== file.id) return;
    // A normal edit, so Ctrl+Z brings the previous content back.
    view.dispatch({
      changes: {
        from: 0,
        insert: starterContent(file.language, uiLanguage),
        to: view.state.doc.length,
      },
    });
    announce(t("classroomTools.code.restored", { name: file.name }));
  };

  const openSnippets = () => {
    skipMenuFocusRestore.current = true;
    setSnippetsOpen(true);
  };

  const closeSnippets = () => {
    setSnippetsOpen(false);
    globalThis.setTimeout(() => snippetsButtonRef.current?.focus(), 0);
  };

  const insertSnippetAsFile = (snippet: CodeSnippet) => {
    if (
      addFile({
        content: snippet.code,
        language: snippet.language,
        name: snippet.fileName,
      })
    ) {
      setSnippetsOpen(false);
      globalThis.setTimeout(() => viewRef.current?.focus(), 0);
    }
  };

  const insertSnippetHere = (snippet: CodeSnippet) => {
    const view = viewRef.current;
    if (!view || !activeIDRef.current) return;
    const { from, to } = view.state.selection.main;
    const before = view.state.doc.toString();
    view.dispatch({
      changes: { from, insert: snippet.code, to },
      selection: { anchor: from + snippet.code.length },
      scrollIntoView: true,
    });
    if (view.state.doc.toString() === before) return; // refused (64 KB)
    setSnippetsOpen(false);
    announce(
      t("classroomTools.snippets.inserted", {
        title: uiLanguage === "vi" ? snippet.title.vi : snippet.title.en,
      }),
    );
    globalThis.setTimeout(() => view.focus(), 0);
  };

  const startRename = (file: WorkspaceFile) => {
    setRenaming({ error: null, id: file.id, value: file.name });
  };

  const commitRename = () => {
    if (!renaming) return;
    const file = filesRef.current.find((item) => item.id === renaming.id);
    if (!file) {
      setRenaming(null);
      return;
    }
    const value = renaming.value.trim();
    const index = filesRef.current.indexOf(file);
    const problem = fileNameProblem(value, filesRef.current, index);
    if (problem) {
      setRenaming({
        ...renaming,
        error:
          problem === "duplicate"
            ? "classroomTools.code.fileNameDuplicate"
            : "classroomTools.code.fileNameInvalid",
      });
      return;
    }
    const language = languageForName(value, file.language);
    const next = filesRef.current.map((item) =>
      item.id === file.id ? { ...item, language, name: value } : item,
    );
    filesRef.current = next;
    setFiles(next);
    setRenaming(null);
    if (language !== file.language) ensureLanguage(file.id, language);
    globalThis.setTimeout(
      () => document.getElementById(`${id}-file-${file.id}`)?.focus(),
      0,
    );
  };

  const removeFile = (file: WorkspaceFile) => {
    const current = filesRef.current;
    const index = current.findIndex((item) => item.id === file.id);
    if (index < 0) return;
    const next = current.filter((item) => item.id !== file.id);
    contentsRef.current.delete(file.id);
    statesRef.current.delete(file.id);
    scheduleRevision();
    if (shownFileRef.current === file.id) shownFileRef.current = null;
    filesRef.current = next;
    setFiles(next);
    if (activeIDRef.current === file.id) {
      const neighbour = next[Math.min(index, next.length - 1)] ?? null;
      setActiveID(neighbour?.id ?? null);
    }
    setClosing(null);
    announce(t("classroomTools.code.fileClosed", { name: file.name }));
    globalThis.setTimeout(() => {
      const neighbour = next[Math.min(index, next.length - 1)];
      const target = neighbour
        ? document.getElementById(`${id}-file-${neighbour.id}`)
        : document.getElementById(`${id}-create`);
      target?.focus();
    }, 0);
  };

  const requestClose = (file: WorkspaceFile) => {
    if (isStarterContent(currentContent(file.id))) removeFile(file);
    else setClosing(file);
  };

  const resizeBy = (delta: number) => {
    setOutputCollapsed(false);
    setOutputSize((value) =>
      Math.min(OUTPUT_MAX, Math.max(OUTPUT_MIN, value + delta)),
    );
  };

  const onSeparatorKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowUp") resizeBy(5);
    else if (event.key === "ArrowDown") resizeBy(-5);
    else if (event.key === "Home") resizeBy(-100);
    else if (event.key === "End") resizeBy(100);
    else if (event.key === "Enter") setOutputCollapsed((value) => !value);
    else return;
    event.preventDefault();
  };

  const onSeparatorPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const body = bodyRef.current;
    if (!body || event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const rect = body.getBoundingClientRect();
    const move = (moveEvent: PointerEvent) => {
      const fromBottom = rect.bottom - moveEvent.clientY;
      const percent = (fromBottom / Math.max(1, rect.height)) * 100;
      setOutputCollapsed(false);
      setOutputSize(
        Math.round(Math.min(OUTPUT_MAX, Math.max(OUTPUT_MIN, percent))),
      );
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  const copyOutput = async () => {
    const text = [
      ...run.output.map((chunk) => chunk.text),
      ...run.tables.map((table) =>
        [
          table.columns.join("\t"),
          ...table.rows.map((row) =>
            row
              .map((cell) => (cell === null ? "NULL" : String(cell)))
              .join("\t"),
          ),
        ].join("\n"),
      ),
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      announce(t("classroomTools.code.outputCopied"));
    } catch {
      announce(t("classroomTools.code.copyFailed"), "error");
    }
  };

  const showPreviewTab = files.some(
    (file) => file.language === "html" || file.language === "css",
  );
  const effectiveOutputTab =
    outputTab === "preview" && !showPreviewTab ? "output" : outputTab;
  const editorLabel = activeFile
    ? t("classroomTools.code.editorLabel", {
        language: activeInfo?.label ?? "",
        name: activeFile.name,
      })
    : t("classroomTools.code.emptyTitle");
  const runLabel = running
    ? t("classroomTools.code.stopShortcut")
    : t("classroomTools.code.runShortcut");

  const controls = (
    <div className="classroom-code-topbar">
      <label className="visually-hidden" htmlFor={languageSelectID}>
        {t("classroomTools.code.language")}
      </label>
      <select
        className="classroom-code-select"
        disabled={!activeFile || running}
        id={languageSelectID}
        onChange={(event) => {
          const value = event.target.value;
          const language = CODE_LANGUAGE_IDS.find((item) => item === value);
          if (language) changeLanguage(language);
        }}
        value={activeFile ? pickerLanguage(activeFile.language) : "python"}
      >
        {CODE_LANGUAGE_IDS.map((language) => (
          <option key={language} value={language}>
            {CODE_LANGUAGES[language].label}
          </option>
        ))}
      </select>
      <button
        aria-keyshortcuts={
          running ? "Control+Period Meta+Period" : "Control+Enter Meta+Enter"
        }
        aria-label={runLabel}
        className="classroom-code-run"
        data-running={running || undefined}
        data-tooltip={runLabel}
        data-tooltip-side="bottom"
        disabled={!activeFile}
        id={`${id}-run`}
        onClick={() => (running ? stopRun() : void runActive())}
        type="button"
      >
        {running ? <Square aria-hidden="true" /> : <Play aria-hidden="true" />}
        <span aria-hidden="true" className="classroom-code-run__label">
          {running
            ? t("classroomTools.code.stop")
            : t("classroomTools.code.run")}
        </span>
      </button>
      <Menu modal={false}>
        <MenuTrigger asChild>
          <IconButton
            className="whiteboard-topbar-menu-trigger classroom-code-more"
            data-tooltip={t("classroomTools.code.more")}
            data-tooltip-side="bottom"
            label={t("classroomTools.code.more")}
            size="sm"
            variant="quiet"
          >
            <MoreHorizontal />
          </IconButton>
        </MenuTrigger>
        <MenuContent
          align="end"
          aria-label={t("classroomTools.code.more")}
          className="whiteboard-topbar-menu classroom-code-menu"
          data-theme="dark"
          onCloseAutoFocus={(event) => {
            if (skipMenuFocusRestore.current) {
              skipMenuFocusRestore.current = false;
              event.preventDefault();
            }
          }}
          sideOffset={8}
        >
          <MenuItem
            disabled={!activeFile || !onSendToChat}
            onSelect={sendToChat}
          >
            <MessageSquareCode aria-hidden="true" />
            {t("classroomTools.code.sendToChat")}
          </MenuItem>
          <MenuItem onSelect={openSnippets}>
            <BookOpen aria-hidden="true" />
            {t("classroomTools.code.snippets")}
          </MenuItem>
          <MenuItem disabled={!activeFile} onSelect={download}>
            <FileDown aria-hidden="true" />
            {t("classroomTools.code.download")}
          </MenuItem>
          <MenuItem disabled={!activeFile} onSelect={restoreStarter}>
            <RotateCcw aria-hidden="true" />
            {t("classroomTools.code.restoreStarter")}
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );

  const style = {
    "--code-output-size": `${outputSize}%`,
  } as CSSProperties;

  return (
    <div
      className="classroom-code"
      data-compact={compact || undefined}
      data-compact-view={compact ? compactView : undefined}
      data-output-collapsed={outputCollapsed || undefined}
      style={style}
    >
      {headerSlot
        ? createPortal(controls, headerSlot)
        : headerSlot === undefined
          ? controls
          : null}

      <p
        aria-atomic="true"
        aria-live="polite"
        className="visually-hidden"
        role="status"
      >
        {announcement?.tone === "info" ? announcement.text : ""}
      </p>
      {announcement?.tone === "error" && (
        <div className="classroom-code__alert" role="alert">
          <span>{announcement.text}</span>
          <button
            aria-label={t("media.room.dismiss")}
            className="classroom-code-icon-button"
            onClick={() => setAnnouncement(null)}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </div>
      )}

      <div
        aria-label={t("classroomTools.code.files")}
        className="classroom-code-files"
        role="group"
      >
        <ul className="classroom-code-files__list">
          {files.map((file) => {
            const active = file.id === activeID;
            const isRenaming = renaming?.id === file.id;
            return (
              <li
                className="classroom-code-file"
                data-active={active || undefined}
                key={file.id}
              >
                {isRenaming ? (
                  <span className="classroom-code-file__rename">
                    <label className="visually-hidden" htmlFor={`${id}-rename`}>
                      {t("classroomTools.code.renameLabel")}
                    </label>
                    <input
                      aria-describedby={`${id}-rename-hint`}
                      aria-invalid={renaming.error ? true : undefined}
                      autoFocus
                      className="classroom-code-file__input"
                      id={`${id}-rename`}
                      maxLength={64}
                      onBlur={() => commitRename()}
                      onChange={(event) =>
                        setRenaming({
                          ...renaming,
                          error: null,
                          value: event.target.value,
                        })
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          commitRename();
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          setRenaming(null);
                          globalThis.setTimeout(
                            () =>
                              document
                                .getElementById(`${id}-file-${file.id}`)
                                ?.focus(),
                            0,
                          );
                        }
                      }}
                      spellCheck={false}
                      value={renaming.value}
                    />
                    <span
                      className={
                        renaming.error
                          ? "classroom-code-file__error"
                          : "visually-hidden"
                      }
                      id={`${id}-rename-hint`}
                      role={renaming.error ? "alert" : undefined}
                    >
                      {t(renaming.error ?? "classroomTools.code.renameHint")}
                    </span>
                  </span>
                ) : (
                  <button
                    aria-current={active ? "true" : undefined}
                    className="classroom-code-file__name"
                    id={`${id}-file-${file.id}`}
                    onClick={() => activate(file.id)}
                    onDoubleClick={() => startRename(file)}
                    onKeyDown={(event) => {
                      if (event.key === "F2") {
                        event.preventDefault();
                        startRename(file);
                      }
                    }}
                    type="button"
                  >
                    <span
                      aria-hidden="true"
                      className="classroom-code-file__badge"
                      data-language={file.language}
                    >
                      {CODE_LANGUAGES[file.language].extension}
                    </span>
                    {file.name}
                  </button>
                )}
                {active && !isRenaming && (
                  <button
                    aria-label={t("classroomTools.code.renameFile", {
                      name: file.name,
                    })}
                    className="classroom-code-file__action"
                    data-tooltip={t("classroomTools.code.renameFile", {
                      name: file.name,
                    })}
                    onClick={() => startRename(file)}
                    type="button"
                  >
                    <Pencil aria-hidden="true" />
                  </button>
                )}
                {!isRenaming && (
                  <button
                    aria-label={t("classroomTools.code.closeFile", {
                      name: file.name,
                    })}
                    className="classroom-code-file__action"
                    data-tooltip={t("classroomTools.code.closeFile", {
                      name: file.name,
                    })}
                    onClick={() => requestClose(file)}
                    type="button"
                  >
                    <X aria-hidden="true" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <Menu modal={false}>
          <MenuTrigger asChild>
            <button
              aria-label={t("classroomTools.code.addFile")}
              className="classroom-code-file__add"
              data-tooltip={t("classroomTools.code.addFile")}
              disabled={files.length >= CODE_MAX_FILES}
              type="button"
            >
              <Plus aria-hidden="true" />
            </button>
          </MenuTrigger>
          <MenuContent
            aria-label={t("classroomTools.code.addFile")}
            className="whiteboard-topbar-menu classroom-code-menu"
            data-theme="dark"
            sideOffset={6}
          >
            {([...CODE_LANGUAGE_IDS, "css"] as const).map((language) => (
              <MenuItem
                key={language}
                onSelect={() =>
                  addFile(starterFile(language, uiLanguage, filesRef.current))
                }
              >
                {t("classroomTools.code.addFileOf", {
                  language: CODE_LANGUAGES[language].label,
                })}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
        <span aria-hidden="true" className="classroom-code-files__spacer" />
        <button
          aria-expanded={snippetsOpen}
          className="classroom-code-text-button classroom-code-files__snippets"
          onClick={() =>
            snippetsOpen ? closeSnippets() : setSnippetsOpen(true)
          }
          ref={snippetsButtonRef}
          type="button"
        >
          <BookOpen aria-hidden="true" />
          <span className="classroom-code-files__snippets-label">
            {t("classroomTools.code.snippets")}
          </span>
        </button>
      </div>

      {compact && (
        <div
          aria-label={t("classroomTools.code.compactViews")}
          className="classroom-code-views"
          role="group"
        >
          <button
            aria-pressed={compactView === "editor"}
            className="classroom-code-chip"
            onClick={() => setCompactView("editor")}
            type="button"
          >
            {t("classroomTools.code.viewEditor")}
          </button>
          <button
            aria-pressed={compactView === "output"}
            className="classroom-code-chip"
            onClick={() => setCompactView("output")}
            type="button"
          >
            {t("classroomTools.code.tabOutput")}
          </button>
        </div>
      )}

      <div className="classroom-code__body" ref={bodyRef}>
        <div
          className="classroom-code__editor-pane"
          hidden={compact && compactView === "output"}
        >
          <span className="visually-hidden" id={labelID}>
            {editorLabel}
          </span>
          <div
            className="classroom-code__editor"
            hidden={!activeFile}
            ref={editorHostRef}
          />
          {!activeFile && (
            <div className="classroom-code-state classroom-code-state--empty">
              <p className="classroom-code-state__title">
                {t("classroomTools.code.emptyTitle")}
              </p>
              <p>{t("classroomTools.code.emptyDescription")}</p>
              <Button
                id={`${id}-create`}
                leadingIcon={<Plus />}
                onClick={() => addFile(starterFile("python", uiLanguage, []))}
                variant="secondary"
              >
                {t("classroomTools.code.createPython")}
              </Button>
            </div>
          )}
          <p className="classroom-code__help" id={helpID}>
            <span>{t("classroomTools.code.editorHelp")}</span>
            <span
              className="classroom-code__help-state"
              data-on={tabFocusMode || undefined}
            >
              {t(
                tabFocusMode
                  ? "classroomTools.code.tabFocusOn"
                  : "classroomTools.code.tabFocusOff",
              )}
            </span>
            <span className="classroom-code__usage">
              {t("classroomTools.code.usage", {
                bytes: (usedBytes / 1024).toFixed(1),
                files: files.length,
                maxFiles: CODE_MAX_FILES,
              })}
              {draftStatus === "saved"
                ? ` · ${t("classroomTools.code.draftSaved")}`
                : draftStatus === "failed"
                  ? ` · ${t("classroomTools.code.draftFailed")}`
                  : ""}
            </span>
          </p>
        </div>
        {!compact && (
          <div
            aria-controls={outputPaneID}
            aria-label={t("classroomTools.code.resizeOutput")}
            aria-orientation="horizontal"
            aria-valuemax={OUTPUT_MAX}
            aria-valuemin={OUTPUT_MIN}
            aria-valuenow={outputCollapsed ? OUTPUT_MIN : outputSize}
            className="classroom-code__separator"
            onKeyDown={onSeparatorKeyDown}
            onPointerDown={onSeparatorPointerDown}
            role="separator"
            tabIndex={0}
          />
        )}
        <div
          className="classroom-code__output-pane"
          hidden={compact && compactView === "editor"}
          id={outputPaneID}
        >
          <CodeOutputPanel
            collapsed={!compact && outputCollapsed}
            locale={locale}
            onClearOutput={() => setRun(IDLE_RUN)}
            onCopyOutput={() => void copyOutput()}
            onPreviewNavigated={() => {
              setPreview(null);
              setPreviewMessage("classroomTools.code.previewNavigated");
              announce(t("classroomTools.code.previewNavigated"), "error");
            }}
            onPreviewRefresh={() => {
              const index = Math.max(
                0,
                filesRef.current.findIndex(
                  (file) => file.id === activeIDRef.current,
                ),
              );
              startPreview(index);
            }}
            onPreviewStop={() => {
              setPreview(null);
              setPreviewMessage("classroomTools.code.previewStopped");
              announce(t("classroomTools.code.previewStopped"));
            }}
            onStdinChange={setStdin}
            onTabChange={setOutputTab}
            onToggleCollapsed={() => setOutputCollapsed((value) => !value)}
            preview={preview}
            previewMessage={previewMessage}
            run={run}
            showPreviewTab={showPreviewTab}
            stdin={stdin}
            tab={effectiveOutputTab}
          />
        </div>
        {snippetsOpen && (
          <CodeSnippetDrawer
            canInsertIntoCurrent={activeFile !== null}
            onClose={closeSnippets}
            onInsertCurrent={insertSnippetHere}
            onInsertNew={insertSnippetAsFile}
          />
        )}
      </div>

      <div
        aria-hidden="true"
        className="classroom-code__sandbox-host"
        ref={sandboxHostRef}
      />

      <Dialog
        onOpenChange={(open) => {
          if (!open) setClosing(null);
        }}
        open={closing !== null}
      >
        {closing && (
          <DialogContent
            className="classroom-code-dialog"
            closeLabel={t("classroomTools.code.cancel")}
            data-theme="dark"
          >
            <DialogTitle>
              {t("classroomTools.code.closeConfirmTitle", {
                name: closing.name,
              })}
            </DialogTitle>
            <DialogDescription>
              {t("classroomTools.code.closeConfirmDescription")}
            </DialogDescription>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="secondary">
                  {t("classroomTools.code.cancel")}
                </Button>
              </DialogClose>
              <Button onClick={() => removeFile(closing)} variant="danger">
                {t("classroomTools.code.closeConfirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
