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
  MenuSeparator,
  MenuTrigger,
} from "@tutorhub/ui";
import {
  BookmarkPlus,
  BookOpen,
  CopyPlus,
  FileDown,
  FileJson,
  FileUp,
  MessageSquareCode,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Send,
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
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type { LanguageSupport } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { useQueryClient } from "@tanstack/react-query";
import { useCodeWorkspaceTool } from "../../app/codeWorkspaces";
import { useI18n, type TranslationKey } from "../../app/i18n";
import {
  Compartment,
  EditorState,
  EditorView,
  createCodeEditorState,
  loadEditorLanguage,
} from "./codeEditor";
import type { ClassroomCodeToolProps } from "./ClassroomCodeTool";
import {
  readCodeDraft,
  writeCodeDraft,
  type CodeDraftScope,
} from "./codeDraftStorage";
import {
  localPresenceIdentity,
  peersOnFile,
  publishLocalPresence,
  readCodePresencePeers,
  type CodePresencePeer,
} from "./codePresence";
import {
  LiveCodeWorkspace,
  type LiveWorkspaceBinding,
} from "./LiveCodeWorkspace";
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
import {
  CodeSharedWorkButton,
  CodeSharedWorkDrawer,
  type SharedWorkCopy,
} from "./CodeSharedWorkDrawer";
import {
  CodeSnippetDrawer,
  type CodeSnippetSaveSource,
  type InsertableCode,
} from "./CodeSnippetDrawer";
import { exportCodeProject, importCodeProject } from "./codePortable";
import {
  scratchpadSyncFor,
  useCodeScratchpadSync,
  type ScratchpadShareError,
  type ScratchpadSyncError,
  type ScratchpadSyncState,
} from "./codeScratchpadSync";
import {
  CODE_MAX_FILES,
  CODE_MAX_TOTAL_BYTES,
  LIVE_CODE_MAX_TOTAL_BYTES,
  defaultWorkspace,
  fileNameProblem,
  forkWorkspaceSnapshot,
  isStarterContent,
  languageForName,
  renameForLanguage,
  starterContent,
  starterFile,
  uniqueFileName,
  utf8Bytes,
  type CodeForkResult,
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

/**
 * ROOM-TOOLS-CODE-02B: one workspace component renders both modes, so the
 * Top Bar, sandbox, output and snippets stay identical. `live` switches the
 * file model to the shared `code.workspace.v1` authority (Yjs binding,
 * actor-local undo, no local draft); without it this is the Slice 1 personal
 * workspace, unchanged.
 */
interface CodeWorkspaceViewProps extends CodeWorkspaceProps {
  /** Focus the editor once mounted (after "Tạo bản nháp từ mẫu"). */
  readonly focusOnMount?: boolean;
  readonly live?: LiveWorkspaceBinding;
  /**
   * ROOM-TOOLS-CODE-03B: from "Chung lớp", an imported project or a copy of a
   * student's shared work opens in "Nháp của tôi" (the mode switches).
   */
  readonly onLoadIntoMine?: (
    snapshot: ClassroomCodeWorkspaceSnapshot,
    notice: string,
  ) => void;
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

function liveFiles(live: LiveWorkspaceBinding): WorkspaceFile[] {
  try {
    return live.authority.listFiles().map((file) => ({
      id: file.id,
      language: file.language,
      name: file.name,
    }));
  } catch {
    return [];
  }
}

function buildLiveWorkspace(live: LiveWorkspaceBinding): InitialWorkspace {
  const files = liveFiles(live);
  const preferred = live.initialFileId() ?? live.authority.activeFileId();
  return {
    activeID:
      files.find((file) => file.id === preferred)?.id ?? files[0]?.id ?? null,
    contents: new Map(),
    files,
    restored: false,
    stdin: "",
  };
}

function sharedText(live: LiveWorkspaceBinding, fileID: string): string {
  try {
    return live.authority.text(fileID).toString();
  } catch {
    return "";
  }
}

/** Read-only keeps focus, selection, copy, search and Tab escape. */
function readOnlyExtension(readOnly: boolean): Extension {
  return readOnly
    ? [
        EditorState.readOnly.of(true),
        EditorView.contentAttributes.of({ "aria-readonly": "true" }),
      ]
    : [];
}

function liveUsage(live: LiveWorkspaceBinding): number {
  try {
    return live.authority.usage().totalBytes;
  } catch {
    return 0;
  }
}

function sameFiles(
  left: readonly WorkspaceFile[],
  right: readonly WorkspaceFile[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (file, index) =>
        file.id === right[index]?.id &&
        file.name === right[index]?.name &&
        file.language === right[index]?.language,
    )
  );
}

/** Message for a refused shared-workspace mutation (authority error code). */
function liveErrorKey(error: unknown): TranslationKey {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code: unknown }).code
      : null;
  switch (code) {
    case "file_limit":
      return "classroomTools.code.fileLimit";
    case "file_too_large":
    case "workspace_too_large":
      return "classroomTools.live.sizeLimit";
    case "file_duplicate_name":
      return "classroomTools.code.fileNameDuplicate";
    case "file_name_invalid":
      return "classroomTools.code.fileNameInvalid";
    case "file_last":
      return "classroomTools.live.fileLast";
    default:
      return "classroomTools.live.fileError";
  }
}

const NO_PEERS: readonly CodePresencePeer[] = [];

const FOLLOW_NAVIGATION_KEYS: ReadonlySet<string> = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
]);

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

/* ROOM-TOOLS-CODE-03B: server draft status line, error bar and share errors. */
function syncErrorKey(error: ScratchpadSyncError): TranslationKey {
  switch (error) {
    case "too_large":
      return "classroomTools.scratchpad.errorTooLarge";
    case "storage_quota":
      return "classroomTools.scratchpad.errorQuota";
    case "unavailable":
      return "classroomTools.scratchpad.errorUnavailable";
    default:
      return "classroomTools.scratchpad.errorFailed";
  }
}

function syncStatusKey(state: ScratchpadSyncState): TranslationKey | null {
  switch (state.status) {
    case "loading":
      return "classroomTools.scratchpad.loading";
    case "saving":
      return "classroomTools.scratchpad.saving";
    case "saved":
      return state.dirty
        ? "classroomTools.scratchpad.unsaved"
        : "classroomTools.scratchpad.saved";
    case "conflict":
      return "classroomTools.scratchpad.conflictShort";
    case "error":
      return "classroomTools.scratchpad.notSaved";
    default:
      return state.dirty ? "classroomTools.scratchpad.unsaved" : null;
  }
}

function shareErrorKey(error: ScratchpadShareError | null): TranslationKey {
  switch (error) {
    case "conflict":
      return "classroomTools.scratchpad.shareConflict";
    case "empty":
    case "unsaved":
      return "classroomTools.scratchpad.shareUnsaved";
    default:
      return "classroomTools.scratchpad.shareFailed";
  }
}

/** The project title for an export: the open file's name without extension. */
function projectTitle(name: string | undefined): string {
  if (!name) return "TutorHub Code";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function CodeWorkspace({
  actorID,
  chatCanPost,
  chatMaxCharacters,
  classID = null,
  focusOnMount = false,
  headerSlot,
  isStaff = false,
  libraryEnabled = false,
  live,
  mediaSpaceID,
  onLoadIntoMine,
  onSendToChat,
  session,
  tenantID,
  toolActions,
}: CodeWorkspaceViewProps) {
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
  // ROOM-TOOLS-CODE-02B: in the shared workspace a `view` grant (or a grant
  // being swapped) is read-only: focus, selection, copy, search and Run stay.
  const readOnly = live ? live.readOnly : false;
  const liveRef = useRef(live);
  // ROOM-TOOLS-CODE-03B (`code_snippet_library`): the durable library and the
  // server-synced "Nháp của tôi" (256 KB like the server). Off, this is the
  // Slice 1/2 workspace exactly: 64 KB, local 8-hour draft, no library calls.
  const library = libraryEnabled === true;
  const personalMaxBytes = library
    ? LIVE_CODE_MAX_TOTAL_BYTES
    : CODE_MAX_TOTAL_BYTES;
  const personalMaxLabel = `${personalMaxBytes / 1024} KB`;
  const { state: syncState, sync } = useCodeScratchpadSync(
    session,
    tenantID,
    mediaSpaceID,
    library && live === undefined,
  );

  const [initial] = useState(() =>
    live
      ? buildLiveWorkspace(live)
      : buildInitialWorkspace(session, scope, uiLanguage),
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
  const [snippetsView, setSnippetsView] = useState<"browse" | "save">("browse");
  const [sharedOpen, setSharedOpen] = useState(false);
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
  const [readOnlyCompartment] = useState(() => new Compartment());
  const readOnlyRef = useRef(readOnly);
  // Shared workspace: "⇆ Theo dõi GV" (on by default for a `view` grant),
  // peers' presence and the presenter's file from the shared meta.
  const [following, setFollowing] = useState(
    () => live !== undefined && live.capability === "view",
  );
  const [awarenessPeers, setPeers] = useState<readonly CodePresencePeer[]>([]);
  const [sharedPresenterFile, setSharedPresenterFile] = useState<string | null>(
    () => {
      try {
        return live?.authority.presenterFileId() ?? null;
      } catch {
        return null;
      }
    },
  );
  const [topLine, setTopLine] = useState(1);
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
  const sharedButtonRef = useRef<HTMLButtonElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const commandsRef = useRef<EditorCommands>(NO_COMMANDS);
  const [usedBytes, setUsedBytes] = useState(() => {
    if (live) return liveUsage(live);
    let sum = 0;
    for (const content of initial.contents.values()) sum += utf8Bytes(content);
    return sum;
  });

  useLayoutEffect(() => {
    filesRef.current = files;
    activeIDRef.current = activeID;
    stdinRef.current = stdin;
    liveRef.current = live;
    readOnlyRef.current = readOnly;
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
      const shared = liveRef.current;
      let sum = 0;
      if (shared) {
        sum = liveUsage(shared);
      } else {
        for (const file of filesRef.current) {
          sum += utf8Bytes(contentsRef.current.get(file.id) ?? "");
        }
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
      const commands = {
        run: () => commandsRef.current.run(),
        stop: () => commandsRef.current.stop(),
        toggleTabFocus: (view: EditorView) =>
          commandsRef.current.toggleTabFocus(view),
      };
      const shared = liveRef.current;
      const state = shared
        ? createCodeEditorState({
            commands,
            content: sharedText(shared, file.id),
            describedBy: helpID,
            // The Yjs binding owns undo: one actor-local stack per file.
            extensions: [
              shared.createExtensions(file.id, () =>
                announce(t("classroomTools.live.sizeLimit"), "error"),
              ),
              readOnlyCompartment.of(readOnlyExtension(readOnlyRef.current)),
            ],
            history: false,
            labelledBy: labelID,
            language: resolvedLanguages.get(file.language) ?? [],
            languageCompartment: compartment,
            onChange: () => scheduleRevision(),
            onLimit: () =>
              announce(t("classroomTools.live.sizeLimit"), "error"),
          })
        : createCodeEditorState({
            commands,
            content: contentsRef.current.get(file.id) ?? "",
            describedBy: helpID,
            labelledBy: labelID,
            language: resolvedLanguages.get(file.language) ?? [],
            languageCompartment: compartment,
            maxBytes: () => personalMaxBytes - otherFilesBytes(file.id),
            onChange: (content) => {
              contentsRef.current.set(file.id, content);
              scheduleRevision();
              sync?.markDirty();
            },
            onLimit: () =>
              announce(
                t("classroomTools.code.sizeLimit", { max: personalMaxLabel }),
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
      personalMaxBytes,
      personalMaxLabel,
      readOnlyCompartment,
      scheduleRevision,
      sync,
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
      if (shown && !liveRef.current) states.set(shown, view.state);
      view.destroy();
      viewRef.current = null;
      shownFileRef.current = null;
    };
  }, []);

  // A shared file's state is rebuilt whenever it is shown or the session is
  // swapped (a detached state would miss remote updates); undo history lives
  // in the authority's Y.UndoManager, so nothing is lost.
  const liveKey = live?.key;
  const shownKeyRef = useRef<string | undefined>(liveKey);
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const file = files.find((item) => item.id === activeID);
    if (
      !file ||
      (shownFileRef.current === file.id && shownKeyRef.current === liveKey)
    ) {
      return;
    }
    const shown = shownFileRef.current;
    if (liveKey === undefined) {
      if (shown && files.some((item) => item.id === shown)) {
        statesRef.current.set(shown, view.state);
      }
      view.setState(statesRef.current.get(file.id) ?? createState(file));
    } else {
      // Same file, new session (grant upgrade/downgrade): keep the caret and
      // scroll position so the code on screen does not jump.
      const keep =
        shown === file.id
          ? {
              head: view.state.selection.main.head,
              scrollTop: view.scrollDOM.scrollTop,
            }
          : null;
      view.setState(createState(file));
      if (keep) {
        view.dispatch({
          selection: {
            anchor: Math.min(keep.head, view.state.doc.length),
          },
        });
        view.scrollDOM.scrollTop = keep.scrollTop;
      }
    }
    shownFileRef.current = file.id;
    shownKeyRef.current = liveKey;
  }, [activeID, createState, files, liveKey]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || liveKey === undefined) return;
    view.dispatch({
      effects: readOnlyCompartment.reconfigure(readOnlyExtension(readOnly)),
    });
  }, [liveKey, readOnly, readOnlyCompartment]);

  const currentContent = useCallback((fileID: string): string => {
    const view = viewRef.current;
    if (view && shownFileRef.current === fileID)
      return view.state.doc.toString();
    const shared = liveRef.current;
    if (shared) return sharedText(shared, fileID);
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

  const readSnapshot = useCallback(
    (): ClassroomCodeWorkspaceSnapshot => ({
      activeIndex: Math.max(
        0,
        filesRef.current.findIndex((file) => file.id === activeIDRef.current),
      ),
      files: snapshotFiles(),
      stdin: stdinRef.current,
    }),
    [snapshotFiles],
  );

  const persist = useCallback(() => {
    // The shared workspace keeps no local draft; "Tạo bản nháp từ mẫu" forks.
    if (liveRef.current) return false;
    const snapshot = readSnapshot();
    session.saveSnapshot(snapshot);
    return writeCodeDraft(scope, snapshot);
  }, [readSnapshot, scope, session]);

  /**
   * ROOM-TOOLS-CODE-03B: swaps every file at once (server copy, conflict
   * reload, import, a student's work). Fresh file ids force new EditorStates,
   * so no undo history crosses from one project to another.
   */
  const replaceWorkspace = useCallback(
    (snapshot: ClassroomCodeWorkspaceSnapshot) => {
      if (liveRef.current || snapshot.files.length === 0) return;
      const contents = new Map<string, string>();
      const next = snapshot.files.map((file) => {
        const fileID = `file-${nextFileNumber.current}`;
        nextFileNumber.current += 1;
        contents.set(fileID, file.content);
        return { id: fileID, language: file.language, name: file.name };
      });
      contentsRef.current = contents;
      statesRef.current.clear();
      shownFileRef.current = null;
      filesRef.current = next;
      const active = next[snapshot.activeIndex]?.id ?? next[0]?.id ?? null;
      activeIDRef.current = active;
      stdinRef.current = snapshot.stdin;
      setRenaming(null);
      setClosing(null);
      setFiles(next);
      setActiveID(active);
      setStdin(snapshot.stdin);
      session.saveSnapshot(snapshot);
      scheduleRevision();
    },
    [scheduleRevision, session],
  );

  // The server draft controller reads and replaces this workspace through a
  // ref, so it always sees the latest callbacks.
  const syncBindingRef = useRef<{
    readonly apply: (snapshot: ClassroomCodeWorkspaceSnapshot) => void;
    readonly read: () => ClassroomCodeWorkspaceSnapshot;
  } | null>(null);
  useLayoutEffect(() => {
    syncBindingRef.current = {
      apply: (snapshot) => {
        replaceWorkspace(snapshot);
        announce(t("classroomTools.scratchpad.loadedFromServer"));
      },
      read: readSnapshot,
    };
  });
  useEffect(() => {
    if (!sync) return undefined;
    return sync.attach({
      apply: (snapshot) => syncBindingRef.current?.apply(snapshot),
      read: () => syncBindingRef.current?.read() ?? null,
    });
  }, [sync]);

  // Debounced bounded draft (ADR-0029): after edits, file and stdin changes.
  useEffect(() => {
    if (liveKey !== undefined) return undefined;
    const timer = globalThis.setTimeout(() => {
      setDraftStatus(persist() ? "saved" : "failed");
    }, 600);
    return () => globalThis.clearTimeout(timer);
  }, [activeID, files, liveKey, persist, revision, stdin]);

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

  // ROOM-TOOLS-CODE-02B: the shared file list follows the authority (remote
  // adds, renames, language changes and deletes), and the presenter's file
  // from the shared meta.
  const liveAuthority = live?.authority;
  useEffect(() => {
    const shared = liveRef.current;
    if (!liveAuthority || !shared) return undefined;
    const authority = liveAuthority;
    const sync = () => {
      const next = liveFiles(shared);
      try {
        setSharedPresenterFile(authority.presenterFileId());
      } catch {
        setSharedPresenterFile(null);
      }
      scheduleRevision();
      if (sameFiles(filesRef.current, next)) return;
      filesRef.current = next;
      setFiles(next);
      if (!next.some((file) => file.id === activeIDRef.current)) {
        setActiveID(next[0]?.id ?? null);
      }
    };
    sync();
    return authority.subscribe(sync);
  }, [liveAuthority, scheduleRevision]);

  // A remote language change re-highlights the open file.
  const activeLanguage = activeFile?.language;
  useEffect(() => {
    if (liveKey === undefined || !activeID || !activeLanguage) return;
    ensureLanguage(activeID, activeLanguage);
  }, [activeID, activeLanguage, ensureLanguage, liveKey]);

  // Peers' presence, re-derived at most four times a second and only stored
  // when something the UI shows changed (never on every remote caret move).
  const awareness = live?.awareness ?? null;
  const peers = awareness ? awarenessPeers : NO_PEERS;
  const roster = live?.roster ?? null;
  const fallbackName = live ? live.fallbackName : "";
  useEffect(() => {
    if (!awareness) return undefined;
    let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
    let lastKey = "";
    const refresh = () => {
      timer = null;
      const next = readCodePresencePeers(awareness, roster, fallbackName);
      const key = next
        .map(
          (peer) =>
            `${peer.clientID}:${peer.fileId ?? ""}:${peer.tone}:${peer.name}:${
              peer.presenter ? `p${peer.line ?? ""}` : ""
            }`,
        )
        .join("|");
      if (key === lastKey) return;
      lastKey = key;
      setPeers(next);
    };
    const onChange = () => {
      if (timer === null) timer = globalThis.setTimeout(refresh, 250);
    };
    refresh();
    awareness.on("change", onChange);
    return () => {
      awareness.off("change", onChange);
      if (timer !== null) globalThis.clearTimeout(timer);
    };
  }, [awareness, fallbackName, roster]);

  // Publish this viewer's presence (file, top line) for the 8-tone dots and
  // for followers of the presenter.
  useEffect(() => {
    if (!awareness) return;
    const identity = localPresenceIdentity(roster, fallbackName);
    publishLocalPresence(awareness, {
      fileId: activeID,
      line: topLine,
      name: identity.name,
      participantKey: identity.participantKey,
      tone: identity.tone,
    });
  }, [activeID, awareness, fallbackName, roster, topLine]);

  // The presenter's open file is shared through the workspace meta so a
  // follower that joins later lands on it.
  const presenting = live?.capability === "present" && !readOnly;
  useEffect(() => {
    if (!presenting || !liveAuthority || !activeID) return;
    try {
      if (liveAuthority.presenterFileId() !== activeID) {
        liveAuthority.setPresenterFile(activeID);
      }
    } catch {
      // A workspace in violation refuses writes; presence still works.
    }
  }, [activeID, liveAuthority, presenting]);

  // The top visible line, throttled (it rides on the awareness budget).
  useEffect(() => {
    const view = viewRef.current;
    if (liveKey === undefined || !view) return undefined;
    let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
    const measure = () => {
      timer = null;
      const current = viewRef.current;
      if (!current) return;
      try {
        const block = current.lineBlockAtHeight(current.scrollDOM.scrollTop);
        setTopLine(current.state.doc.lineAt(block.from).number);
      } catch {
        // Layout is not measurable (hidden editor).
      }
    };
    const onScroll = () => {
      if (timer === null) timer = globalThis.setTimeout(measure, 250);
    };
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      view.scrollDOM.removeEventListener("scroll", onScroll);
      if (timer !== null) globalThis.clearTimeout(timer);
    };
  }, [liveKey]);

  // "⇆ Theo dõi GV": follow the server-stamped presenter's file and line.
  const presenterPeer = peers.find((peer) => peer.presenter) ?? null;
  const followFileId =
    presenterPeer?.fileId &&
    files.some((file) => file.id === presenterPeer.fileId)
      ? presenterPeer.fileId
      : sharedPresenterFile &&
          files.some((file) => file.id === sharedPresenterFile)
        ? sharedPresenterFile
        : null;
  const followLine = presenterPeer?.line ?? null;
  const canFollow = live !== undefined && live.capability !== "present";
  const followActive = canFollow && following;
  useEffect(() => {
    if (!followActive || !followFileId) return;
    if (activeIDRef.current !== followFileId) setActiveID(followFileId);
  }, [followActive, followFileId]);
  useEffect(() => {
    const view = viewRef.current;
    if (
      !followActive ||
      !view ||
      followLine === null ||
      shownFileRef.current !== followFileId
    ) {
      return;
    }
    try {
      const line = view.state.doc.line(
        Math.min(Math.max(1, followLine), view.state.doc.lines),
      );
      const top = view.lineBlockAt(line.from).top;
      const reduce =
        typeof globalThis.matchMedia === "function" &&
        globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (typeof view.scrollDOM.scrollTo === "function") {
        view.scrollDOM.scrollTo({
          behavior: reduce ? "auto" : "smooth",
          top,
        });
      } else {
        view.scrollDOM.scrollTop = top;
      }
    } catch {
      // Nothing to scroll yet.
    }
  }, [activeID, followActive, followFileId, followLine, liveKey]);

  const stopFollowing = useCallback(() => {
    setFollowing((current) => {
      if (current) {
        announce(t("classroomTools.live.followOff"));
      }
      return false;
    });
  }, [announce, t]);

  // Scrolling the code yourself (wheel, touch, navigation keys) hands
  // control back: following never fights the student.
  useEffect(() => {
    const host = editorHostRef.current;
    if (!followActive || !host) return undefined;
    const onWheel = () => stopFollowing();
    const onKeyDown = (event: KeyboardEvent) => {
      if (FOLLOW_NAVIGATION_KEYS.has(event.key)) stopFollowing();
    };
    host.addEventListener("wheel", onWheel, { passive: true });
    host.addEventListener("touchmove", onWheel, { passive: true });
    host.addEventListener("keydown", onKeyDown);
    return () => {
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("touchmove", onWheel);
      host.removeEventListener("keydown", onKeyDown);
    };
  }, [followActive, stopFollowing]);

  const toggleFollowing = () => {
    const next = !following;
    setFollowing(next);
    announce(
      t(
        next ? "classroomTools.live.followOn" : "classroomTools.live.followOff",
      ),
    );
    if (next && followFileId && activeIDRef.current !== followFileId) {
      setActiveID(followFileId);
    }
  };

  // An upgrade to `edit` never keeps following (no caret jumps while typing).
  const liveCapability = live?.capability;
  const previousCapabilityRef = useRef(liveCapability);
  useEffect(() => {
    const previous = previousCapabilityRef.current;
    previousCapabilityRef.current = liveCapability;
    if (previous === "view" && liveCapability === "edit") setFollowing(false);
  }, [liveCapability]);

  useEffect(() => {
    if (!focusOnMount) return undefined;
    const timer = globalThis.setTimeout(() => viewRef.current?.focus(), 0);
    return () => globalThis.clearTimeout(timer);
  }, [focusOnMount]);

  const forkToDraft = () => {
    const shared = liveRef.current;
    if (!shared) return;
    let snapshot;
    try {
      snapshot = shared.authority.snapshot();
    } catch {
      announce(t("classroomTools.live.forkFailed"), "error");
      return;
    }
    const activeIndex = Math.max(
      0,
      filesRef.current.findIndex((file) => file.id === activeIDRef.current),
    );
    // The open file's live text (the view may be ahead of a remote echo).
    const forkFiles = snapshot.files.map((file, index) =>
      index === activeIndex && activeIDRef.current
        ? { ...file, content: currentContent(activeIDRef.current) }
        : file,
    );
    shared.onFork(
      forkWorkspaceSnapshot(forkFiles, activeIndex, stdinRef.current),
    );
  };

  const addFile = useCallback(
    (
      file: { content: string; language: CodeFileLanguage; name: string },
      announceKey: TranslationKey = "classroomTools.code.fileAdded",
    ): boolean => {
      const current = filesRef.current;
      const shared = liveRef.current;
      if (shared) {
        if (readOnlyRef.current) return false;
        if (current.length >= CODE_MAX_FILES) {
          announce(
            t("classroomTools.code.fileLimit", { max: CODE_MAX_FILES }),
            "error",
          );
          return false;
        }
        const name = uniqueFileName(
          fileNameProblem(file.name, []) === null
            ? file.name
            : CODE_LANGUAGES[file.language].defaultFileName,
          current,
        );
        try {
          const fileID = shared.authority.addFile({
            content: file.content,
            language: file.language,
            name,
          });
          const next = liveFiles(shared);
          filesRef.current = next;
          setFiles(next);
          setActiveID(fileID);
          scheduleRevision();
          announce(t(announceKey, { name }));
          return true;
        } catch (error) {
          announce(t(liveErrorKey(error), { max: CODE_MAX_FILES }), "error");
          return false;
        }
      }
      if (current.length >= CODE_MAX_FILES) {
        announce(
          t("classroomTools.code.fileLimit", { max: CODE_MAX_FILES }),
          "error",
        );
        return false;
      }
      let used = 0;
      for (const item of current) used += utf8Bytes(currentContent(item.id));
      if (used + utf8Bytes(file.content) > personalMaxBytes) {
        announce(
          t("classroomTools.code.sizeLimit", { max: personalMaxLabel }),
          "error",
        );
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
      sync?.markDirty();
      announce(t(announceKey, { name }));
      return true;
    },
    [
      announce,
      currentContent,
      personalMaxBytes,
      personalMaxLabel,
      scheduleRevision,
      sync,
      t,
    ],
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

  // "Open in Code" from chat: queued blocks become new tabs (never run). The
  // shared workspace leaves them queued: the mode switch opens "Nháp của tôi".
  useEffect(() => {
    if (liveKey !== undefined) return undefined;
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
  }, [liveKey, session]);

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
    // Choosing another file yourself hands control back (no tug of war).
    if (followActive && fileID !== followFileId) stopFollowing();
    setActiveID(fileID);
  };

  const changeLanguage = (language: CodeLanguageID) => {
    const file = filesRef.current.find(
      (item) => item.id === activeIDRef.current,
    );
    if (!file || pickerLanguage(file.language) === language) return;
    if (readOnlyRef.current) return;
    const content = currentContent(file.id);
    const shared = liveRef.current;
    if (shared && isStarterContent(content)) {
      const name = uniqueFileName(
        renameForLanguage(file.name, language),
        filesRef.current.filter((item) => item.id !== file.id),
      );
      try {
        shared.authority.replaceFileText(
          file.id,
          starterContent(language, uiLanguage),
        );
        shared.authority.setFileLanguage(file.id, language);
        if (name !== file.name) shared.authority.renameFile(file.id, name);
      } catch (error) {
        announce(t(liveErrorKey(error), { max: CODE_MAX_FILES }), "error");
        return;
      }
      ensureLanguage(file.id, language);
      announce(
        t("classroomTools.code.languageChanged", {
          language: CODE_LANGUAGES[language].label,
          name,
        }),
      );
      return;
    }
    if (!shared && isStarterContent(content)) {
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
    if (readOnlyRef.current) return;
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

  const openSnippets = (view: "browse" | "save" = "browse") => {
    skipMenuFocusRestore.current = true;
    setSharedOpen(false);
    setSnippetsView(view);
    setSnippetsOpen(true);
  };

  const closeSnippets = () => {
    setSnippetsOpen(false);
    globalThis.setTimeout(() => snippetsButtonRef.current?.focus(), 0);
  };

  const insertSnippetAsFile = (snippet: InsertableCode) => {
    if (
      addFile({
        content: snippet.content,
        language: snippet.language,
        name: snippet.name,
      })
    ) {
      setSnippetsOpen(false);
      globalThis.setTimeout(() => viewRef.current?.focus(), 0);
    }
  };

  const insertSnippetHere = (snippet: InsertableCode) => {
    const view = viewRef.current;
    if (!view || !activeIDRef.current || readOnlyRef.current) return;
    const { from, to } = view.state.selection.main;
    const before = view.state.doc.toString();
    view.dispatch({
      changes: { from, insert: snippet.content, to },
      selection: { anchor: from + snippet.content.length },
      scrollIntoView: true,
    });
    if (view.state.doc.toString() === before) return; // refused (size cap)
    setSnippetsOpen(false);
    announce(t("classroomTools.snippets.inserted", { title: snippet.title }));
    globalThis.setTimeout(() => view.focus(), 0);
  };

  /** "Lưu vào Kho": the open file, or just its selection. */
  const readSaveSource = (): CodeSnippetSaveSource | null => {
    const file = filesRef.current.find(
      (item) => item.id === activeIDRef.current,
    );
    if (!file) return null;
    const view = viewRef.current;
    if (view && shownFileRef.current === file.id) {
      const selection = view.state.selection.main;
      if (!selection.empty) {
        return {
          content: view.state.sliceDoc(selection.from, selection.to),
          fileName: file.name,
          fromSelection: true,
          language: file.language,
        };
      }
    }
    return {
      content: currentContent(file.id),
      fileName: file.name,
      fromSelection: false,
      language: file.language,
    };
  };

  /**
   * ROOM-TOOLS-CODE-03B: an imported project or a teacher's copy of shared
   * work becomes "Nháp của tôi" — in place here, or through a mode switch
   * from "Chung lớp". It is an edit: the server draft saves it. Never run.
   */
  const loadIntoMine = (
    snapshot: ClassroomCodeWorkspaceSnapshot,
    notice: string,
  ) => {
    if (liveRef.current) {
      onLoadIntoMine?.(snapshot, notice);
      return;
    }
    replaceWorkspace(snapshot);
    writeCodeDraft(scope, snapshot);
    sync?.markDirty(snapshot);
    announce(notice);
    globalThis.setTimeout(() => viewRef.current?.focus(), 0);
  };

  const toggleSharedWork = () => {
    if (sharedOpen) {
      closeSharedWork();
      return;
    }
    setSnippetsOpen(false);
    setSharedOpen(true);
  };

  const closeSharedWork = () => {
    setSharedOpen(false);
    globalThis.setTimeout(() => sharedButtonRef.current?.focus(), 0);
  };

  const openSharedCopy = (copy: SharedWorkCopy) => {
    const result = forkWorkspaceSnapshot(
      copy.files,
      copy.activeIndex,
      copy.stdin,
      personalMaxBytes,
    );
    setSharedOpen(false);
    loadIntoMine(
      result.snapshot,
      result.partial
        ? t("classroomTools.shared.copiedPartial", {
            copied: result.copied,
            name: copy.authorName,
            total: result.total,
          })
        : t("classroomTools.shared.copied", { name: copy.authorName }),
    );
  };

  const canComment = Boolean(onSendToChat && toolActions && chatCanPost);
  const commentOnWork = (authorName: string) => {
    if (!onSendToChat || !toolActions) return;
    onSendToChat(`@${authorName} `);
    toolActions.openChat();
    announce(t("classroomTools.shared.commentOpened", { name: authorName }));
  };

  const toggleShare = async () => {
    if (!sync || !syncState) return;
    const next = !syncState.shared;
    const done = await sync.setShared(next);
    if (done) {
      announce(
        t(
          next
            ? "classroomTools.scratchpad.sharedOn"
            : "classroomTools.scratchpad.sharedOff",
        ),
      );
    } else {
      announce(t(shareErrorKey(sync.getState().shareError)), "error");
    }
  };

  const exportProject = async () => {
    const snapshot = readSnapshot();
    if (snapshot.files.length === 0) return;
    try {
      const exported = await exportCodeProject(
        snapshot,
        projectTitle(snapshot.files[snapshot.activeIndex]?.name),
      );
      downloadText(exported.fileName, exported.json, "application/json");
      announce(
        t("classroomTools.portable.exported", { name: exported.fileName }),
      );
    } catch {
      announce(t("classroomTools.portable.exportFailed"), "error");
    }
  };

  const importProject = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0] ?? null;
    input.value = "";
    if (!file || readOnlyRef.current) return;
    const result = await importCodeProject(file);
    if (!result.ok) {
      announce(t(result.reason), "error");
      return;
    }
    const fork = forkWorkspaceSnapshot(
      result.snapshot.files,
      result.snapshot.activeIndex,
      result.snapshot.stdin,
      personalMaxBytes,
    );
    loadIntoMine(
      fork.snapshot,
      fork.partial
        ? t("classroomTools.portable.importedPartial", {
            copied: fork.copied,
            total: fork.total,
          })
        : t("classroomTools.portable.imported", { count: fork.copied }),
    );
  };

  const startRename = (file: WorkspaceFile) => {
    if (readOnlyRef.current) return;
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
    const shared = liveRef.current;
    if (shared) {
      try {
        if (value !== file.name) shared.authority.renameFile(file.id, value);
        if (language !== file.language) {
          shared.authority.setFileLanguage(file.id, language);
        }
      } catch (error) {
        setRenaming({ ...renaming, error: liveErrorKey(error) });
        return;
      }
    }
    const next = filesRef.current.map((item) =>
      item.id === file.id ? { ...item, language, name: value } : item,
    );
    filesRef.current = next;
    setFiles(next);
    setRenaming(null);
    sync?.markDirty();
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
    const shared = liveRef.current;
    if (shared) {
      try {
        shared.authority.deleteFile(file.id);
      } catch (error) {
        setClosing(null);
        announce(t(liveErrorKey(error), { max: CODE_MAX_FILES }), "error");
        return;
      }
    }
    const next = current.filter((item) => item.id !== file.id);
    contentsRef.current.delete(file.id);
    statesRef.current.delete(file.id);
    scheduleRevision();
    if (shownFileRef.current === file.id) shownFileRef.current = null;
    filesRef.current = next;
    setFiles(next);
    sync?.markDirty();
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
    if (readOnlyRef.current) return;
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
  const syncStatus = syncState ? syncStatusKey(syncState) : null;

  const controls = (
    <div className="classroom-code-topbar">
      <label className="visually-hidden" htmlFor={languageSelectID}>
        {t("classroomTools.code.language")}
      </label>
      <select
        className="classroom-code-select"
        disabled={!activeFile || running || readOnly}
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
          {live && live.lifecycle.canSuspend ? (
            <MenuItem
              disabled={live.lifecycle.pending}
              onSelect={() => live.lifecycle.onTransition("suspend")}
            >
              <Pause aria-hidden="true" />
              {t("classroomTools.live.suspend")}
            </MenuItem>
          ) : null}
          {live && live.lifecycle.canResume ? (
            <MenuItem
              disabled={live.lifecycle.pending}
              onSelect={() => live.lifecycle.onTransition("resume")}
            >
              <Play aria-hidden="true" />
              {t("classroomTools.live.resume")}
            </MenuItem>
          ) : null}
          {live && live.lifecycle.canClose ? (
            <MenuItem
              disabled={live.lifecycle.pending}
              onSelect={() => live.lifecycle.onTransition("close")}
              tone="danger"
            >
              <Square aria-hidden="true" />
              {t("classroomTools.live.close")}
            </MenuItem>
          ) : null}
          {live &&
          (live.lifecycle.canSuspend ||
            live.lifecycle.canResume ||
            live.lifecycle.canClose) ? (
            <MenuSeparator />
          ) : null}
          <MenuItem
            disabled={!activeFile || !onSendToChat}
            onSelect={sendToChat}
          >
            <MessageSquareCode aria-hidden="true" />
            {t("classroomTools.code.sendToChat")}
          </MenuItem>
          <MenuItem onSelect={() => openSnippets()}>
            <BookOpen aria-hidden="true" />
            {t("classroomTools.code.snippets")}
          </MenuItem>
          {library ? (
            <MenuItem
              disabled={!activeFile}
              onSelect={() => openSnippets("save")}
            >
              <BookmarkPlus aria-hidden="true" />
              {t("classroomTools.library.saveMenu")}
            </MenuItem>
          ) : null}
          <MenuItem disabled={!activeFile} onSelect={download}>
            <FileDown aria-hidden="true" />
            {t("classroomTools.code.download")}
          </MenuItem>
          <MenuItem
            disabled={files.length === 0}
            onSelect={() => void exportProject()}
          >
            <FileJson aria-hidden="true" />
            {t("classroomTools.portable.export")}
          </MenuItem>
          <MenuItem
            disabled={readOnly}
            onSelect={() => importInputRef.current?.click()}
          >
            <FileUp aria-hidden="true" />
            {t("classroomTools.portable.import")}
          </MenuItem>
          <MenuItem
            disabled={!activeFile || readOnly}
            onSelect={restoreStarter}
          >
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

      {live ? (
        <LiveCodeStatusBar
          canFollow={canFollow}
          following={following}
          live={live}
          onFork={forkToDraft}
          onToggleFollowing={toggleFollowing}
        />
      ) : null}

      {sync && syncState?.status === "conflict" ? (
        <div
          aria-labelledby={`${id}-sync-message`}
          className="classroom-code-sync-bar"
          data-tone="conflict"
          role="group"
        >
          <p
            className="classroom-code-sync-bar__message"
            id={`${id}-sync-message`}
            role="alert"
          >
            {t("classroomTools.scratchpad.conflict")}
          </p>
          <span className="classroom-code-sync-bar__actions">
            <button
              className="classroom-code-text-button"
              onClick={() => void sync.reloadFromServer()}
              type="button"
            >
              {t("classroomTools.scratchpad.loadServer")}
            </button>
            <button
              className="classroom-code-text-button classroom-code-text-button--primary"
              onClick={() => void sync.overwriteServer()}
              type="button"
            >
              {t("classroomTools.scratchpad.overwrite")}
            </button>
          </span>
        </div>
      ) : sync && syncState?.status === "error" && syncState.error ? (
        <div
          aria-labelledby={`${id}-sync-message`}
          className="classroom-code-sync-bar"
          data-tone="error"
          role="group"
        >
          <p
            className="classroom-code-sync-bar__message"
            id={`${id}-sync-message`}
            role="alert"
          >
            {t(syncErrorKey(syncState.error))}
          </p>
          {syncState.error === "failed" ? (
            <span className="classroom-code-sync-bar__actions">
              <button
                className="classroom-code-text-button"
                onClick={() => void sync.retry()}
                type="button"
              >
                {t("state.retry")}
              </button>
            </span>
          ) : null}
        </div>
      ) : null}

      <div
        aria-label={t("classroomTools.code.files")}
        className="classroom-code-files"
        role="group"
      >
        <ul className="classroom-code-files__list">
          {files.map((file) => {
            const active = file.id === activeID;
            const isRenaming = renaming?.id === file.id;
            const presence = live ? peersOnFile(peers, file.id) : null;
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
                      if (event.key === "F2" && !readOnly) {
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
                    {presence && presence.shown.length > 0 ? (
                      <span
                        aria-hidden="true"
                        className="classroom-code-file__presence"
                      >
                        {presence.shown.map((peer) => (
                          <span
                            className="classroom-code-presence-dot"
                            data-presenter={peer.presenter || undefined}
                            data-tone={peer.tone}
                            key={peer.clientID}
                            title={t("classroomTools.live.presenceTitle", {
                              name: peer.name,
                            })}
                          >
                            {peer.initial}
                          </span>
                        ))}
                        {presence.extra > 0 ? (
                          <span className="classroom-code-presence-more">
                            +{presence.extra}
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </button>
                )}
                {active && !isRenaming && !readOnly && (
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
                {!isRenaming && !readOnly && (
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
        {readOnly ? null : (
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
        )}
        <span aria-hidden="true" className="classroom-code-files__spacer" />
        {sync && syncState && !isStaff ? (
          <button
            aria-pressed={syncState.shared}
            className="classroom-code-share-toggle"
            data-shared={syncState.shared || undefined}
            disabled={
              syncState.sharing ||
              (!syncState.loaded && syncState.status === "loading")
            }
            onClick={() => void toggleShare()}
            type="button"
          >
            {syncState.shared ? (
              <>
                <span
                  aria-hidden="true"
                  className="classroom-code-share-toggle__dot"
                />
                {t("classroomTools.scratchpad.shared")}
              </>
            ) : (
              <>
                <Send aria-hidden="true" />
                {t("classroomTools.scratchpad.share")}
              </>
            )}
          </button>
        ) : null}
        {library && isStaff ? (
          <CodeSharedWorkButton
            expanded={sharedOpen}
            mediaSpaceID={mediaSpaceID}
            onToggle={toggleSharedWork}
            ref={sharedButtonRef}
            tenantID={tenantID}
          />
        ) : null}
        <button
          aria-expanded={snippetsOpen}
          className="classroom-code-text-button classroom-code-files__snippets"
          onClick={() => {
            if (snippetsOpen) {
              closeSnippets();
              return;
            }
            setSharedOpen(false);
            setSnippetsView("browse");
            setSnippetsOpen(true);
          }}
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
          {!activeFile && !live && (
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
              {t(
                live || library
                  ? "classroomTools.live.usage"
                  : "classroomTools.code.usage",
                {
                  bytes: (usedBytes / 1024).toFixed(1),
                  files: files.length,
                  max: `${LIVE_CODE_MAX_TOTAL_BYTES / 1024} KB`,
                  maxFiles: CODE_MAX_FILES,
                },
              )}
              {sync && syncState
                ? syncStatus
                  ? ` · ${t(syncStatus)}`
                  : ""
                : draftStatus === "saved"
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
            onStdinChange={(value) => {
              setStdin(value);
              sync?.markDirty();
            }}
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
            canInsertIntoCurrent={activeFile !== null && !readOnly}
            canInsertNew={!readOnly}
            key={snippetsView}
            library={
              library
                ? {
                    classID,
                    initialView: snippetsView,
                    isStaff,
                    onSaved: (title) =>
                      announce(t("classroomTools.library.saved", { title })),
                    readSource: readSaveSource,
                    tenantID,
                  }
                : undefined
            }
            onClose={closeSnippets}
            onInsertCurrent={insertSnippetHere}
            onInsertNew={insertSnippetAsFile}
          />
        )}
        {library && isStaff && sharedOpen ? (
          <CodeSharedWorkDrawer
            canComment={canComment}
            mediaSpaceID={mediaSpaceID}
            onClose={closeSharedWork}
            onComment={commentOnWork}
            onOpenCopy={openSharedCopy}
            tenantID={tenantID}
          />
        ) : null}
      </div>

      {/* Opened from the ⋯ menu; `hidden` keeps it out of tab order and AT. */}
      <input
        accept=".json,application/json"
        className="classroom-code__import"
        data-testid="code-project-import"
        hidden
        onChange={(event) => void importProject(event)}
        ref={importInputRef}
        type="file"
      />

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
              {t(
                live
                  ? "classroomTools.live.closeConfirmDescription"
                  : "classroomTools.code.closeConfirmDescription",
              )}
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

/**
 * ROOM-TOOLS-CODE-02B: the thin "Chung lớp" status line above the files —
 * who may edit, the temporary grant countdown, the connection state, and the
 * pedagogy keys "⇆ Theo dõi GV" and "Tạo bản nháp từ mẫu" for everyone but
 * the presenter. Not a live region: changes are announced by the workspace.
 */
function LiveCodeStatusBar({
  canFollow,
  following,
  live,
  onFork,
  onToggleFollowing,
}: {
  readonly canFollow: boolean;
  readonly following: boolean;
  readonly live: LiveWorkspaceBinding;
  readonly onFork: () => void;
  readonly onToggleFollowing: () => void;
}) {
  const { t } = useI18n();
  const status =
    live.capability === "present"
      ? t("classroomTools.live.statusPresent")
      : live.capability === "edit"
        ? live.grantExpiresAt
          ? t("classroomTools.live.statusEditGrant")
          : t("classroomTools.live.statusEdit")
        : t("classroomTools.live.statusView");
  return (
    <div
      aria-label={t("classroomTools.live.barLabel")}
      className="classroom-code-live-bar"
      data-capability={live.capability}
      role="group"
    >
      <span className="classroom-code-live-bar__status">
        <span
          aria-hidden="true"
          className="classroom-code-live-bar__dot"
          data-connection={live.connection}
        />
        <span className="classroom-code-live-bar__label">{status}</span>
        {live.capability === "edit" && live.grantExpiresAt ? (
          <CodeGrantCountdown expiresAt={live.grantExpiresAt} />
        ) : null}
      </span>
      {live.connection !== "connected" ? (
        <span className="classroom-code-live-bar__connection">
          {t(`classroomTools.live.connection.${live.connection}`)}
        </span>
      ) : null}
      {live.notice ?? null}
      <span aria-hidden="true" className="classroom-code-live-bar__spacer" />
      {canFollow ? (
        <button
          aria-pressed={following}
          className="classroom-code-live-toggle"
          onClick={onToggleFollowing}
          type="button"
        >
          <span aria-hidden="true">⇆</span>
          {t("classroomTools.live.follow")}
        </button>
      ) : null}
      {canFollow ? (
        <button
          className="classroom-code-live-fork"
          onClick={onFork}
          type="button"
        >
          <CopyPlus aria-hidden="true" />
          {t("classroomTools.live.fork")}
        </button>
      ) : null}
    </div>
  );
}

/** mm:ss left on the viewer's temporary edit grant (ticks on its own). */
function CodeGrantCountdown({ expiresAt }: { readonly expiresAt: string }) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = globalThis.setInterval(() => setNow(Date.now()), 1_000);
    return () => globalThis.clearInterval(timer);
  }, []);
  const deadline = Date.parse(expiresAt);
  if (!Number.isFinite(deadline)) return null;
  const remaining = Math.max(0, Math.round((deadline - now) / 1_000));
  const minutes = String(Math.floor(remaining / 60)).padStart(2, "0");
  const seconds = String(remaining % 60).padStart(2, "0");
  return (
    <span className="classroom-code-live-bar__countdown">
      {t("classroomTools.live.remaining", { time: `${minutes}:${seconds}` })}
    </span>
  );
}

type CodeMode = "class" | "mine";

/**
 * ROOM-TOOLS-CODE-02B: with `classroom_code_collaboration` on, the Code tool
 * has two modes in one Top Bar pill — "Chung lớp" (the shared workspace) and
 * "Nháp của tôi" (the Slice 1 personal draft). The first mode is chosen from
 * the server projection: an open session, or a viewer who may start one,
 * lands in "Chung lớp"; everyone else starts in their own draft and is moved
 * to "Chung lớp" once per `workspace:generation` when the teacher opens it.
 */
function CollaborativeCodeWorkspace(props: CodeWorkspaceProps) {
  const { actorID, headerSlot, mediaSpaceID, session, tenantID } = props;
  const { language: uiLanguage, t } = useI18n();
  const tool = useCodeWorkspaceTool(tenantID, mediaSpaceID, true);
  const projection = tool.isSuccess ? tool.data : undefined;
  const workspace = projection?.workspace ?? null;
  const capabilities = workspace?.viewer_capabilities;
  const coordinator = Boolean(
    projection?.can_create ||
    capabilities?.can_open ||
    capabilities?.can_resume,
  );
  const openKey =
    workspace?.status === "open" && capabilities?.can_exchange_grant
      ? `${workspace.id}:${workspace.current_generation}`
      : null;
  const resolved = tool.isSuccess || tool.isError;
  const [mode, setMode] = useState<CodeMode | null>(null);
  const [handledOpenKey, setHandledOpenKey] = useState<string | null>(null);
  const [focusMine, setFocusMine] = useState(false);
  const [notice, setNotice] = useState("");
  const [innerSlot, setInnerSlot] = useState<HTMLSpanElement | null>(null);
  const scope = useMemo<CodeDraftScope>(
    () => ({ actorID, mediaSpaceID, tenantID }),
    [actorID, mediaSpaceID, tenantID],
  );

  // Adjust state while rendering (store information from previous renders):
  // the first mode, then one automatic switch per open workspace key.
  if (mode === null && resolved) {
    setMode(openKey || (tool.isSuccess && coordinator) ? "class" : "mine");
    setHandledOpenKey(openKey);
  } else if (mode !== null && openKey !== null && openKey !== handledOpenKey) {
    setHandledOpenKey(openKey);
    if (mode === "mine") {
      setMode("class");
      setFocusMine(false);
      setNotice(t("classroomTools.live.autoSwitched"));
    }
  }

  // "Open in Code" from chat lands in the personal draft.
  useEffect(
    () =>
      session.subscribe(() => {
        setMode((current) => (current === "class" ? "mine" : current));
      }),
    [session],
  );

  const switchMode = (next: CodeMode) => {
    if (next === mode) return;
    setFocusMine(false);
    setNotice("");
    setMode(next);
  };

  const queryClient = useQueryClient();
  const libraryEnabled = props.libraryEnabled === true;
  // A fork, an import or a copy of a student's work lands in "Nháp của tôi" as
  // an unsaved edit, so the server draft keeps it rather than replacing it.
  const loadIntoMine = useCallback(
    (snapshot: ClassroomCodeWorkspaceSnapshot, text: string) => {
      session.saveSnapshot(snapshot);
      writeCodeDraft(scope, snapshot);
      if (libraryEnabled) {
        scratchpadSyncFor(session, tenantID, mediaSpaceID, {
          queryClient,
        }).markDirty(snapshot);
      }
      setFocusMine(true);
      setMode("mine");
      setNotice(text);
    },
    [libraryEnabled, mediaSpaceID, queryClient, scope, session, tenantID],
  );

  const handleFork = useCallback(
    (result: CodeForkResult) =>
      loadIntoMine(
        result.snapshot,
        result.partial
          ? t("classroomTools.live.forkedPartial", {
              copied: result.copied,
              total: result.total,
            })
          : t("classroomTools.live.forked"),
      ),
    [loadIntoMine, t],
  );

  const seedSnapshot = useCallback(
    () => session.readSnapshot() ?? readCodeDraft(scope),
    [scope, session],
  );
  const fallbackFiles = useMemo(
    () => defaultWorkspace(uiLanguage).files,
    [uiLanguage],
  );

  const group = (
    <div className="classroom-code-header-group">
      <div
        aria-label={t("classroomTools.live.modeGroup")}
        className="classroom-code-mode"
        role="group"
      >
        <button
          aria-pressed={mode === "class"}
          className="classroom-code-mode__option"
          data-mode="class"
          disabled={mode === null}
          onClick={() => switchMode("class")}
          type="button"
        >
          {workspace?.status === "open" ? (
            <span aria-hidden="true" className="classroom-code-mode__dot" />
          ) : null}
          {t("classroomTools.live.modeClass")}
          {workspace?.status === "open" ? (
            <span className="visually-hidden">
              {` (${t("classroomTools.live.modeLive")})`}
            </span>
          ) : null}
        </button>
        <button
          aria-pressed={mode === "mine"}
          className="classroom-code-mode__option"
          data-mode="mine"
          disabled={mode === null}
          onClick={() => switchMode("mine")}
          type="button"
        >
          {t("classroomTools.live.modeMine")}
        </button>
      </div>
      <span className="classroom-code-header-group__slot" ref={setInnerSlot} />
    </div>
  );

  return (
    <>
      {headerSlot
        ? createPortal(group, headerSlot)
        : headerSlot === undefined
          ? group
          : null}
      <p
        aria-atomic="true"
        aria-live="polite"
        className="visually-hidden"
        role="status"
      >
        {notice}
      </p>
      {mode === null ? (
        <div className="classroom-code-state" role="status">
          <span aria-hidden="true" className="classroom-code-state__spinner" />
          <p>{t("classroomTools.live.loading")}</p>
        </div>
      ) : mode === "mine" ? (
        <CodeWorkspace
          {...props}
          focusOnMount={focusMine}
          headerSlot={innerSlot}
          key="mine"
        />
      ) : (
        <LiveCodeWorkspace
          actorID={actorID}
          fallbackFiles={fallbackFiles}
          fallbackName={props.displayName ?? ""}
          mediaSpaceID={mediaSpaceID}
          onAnnounce={setNotice}
          onFork={handleFork}
          onOpenMine={() => switchMode("mine")}
          renderWorkspace={(live) => (
            <CodeWorkspace
              {...props}
              headerSlot={innerSlot}
              key="class"
              live={live}
              onLoadIntoMine={loadIntoMine}
            />
          )}
          roster={props.codeRoster ?? null}
          seedSnapshot={seedSnapshot}
          tenantID={tenantID}
          tool={tool}
        />
      )}
    </>
  );
}

/**
 * The lazy chunk entry. Without `classroom_code_collaboration` this is the
 * Slice 1 personal workspace exactly; with it, the two-mode wrapper.
 */
export default function LazyCodeWorkspace(props: CodeWorkspaceProps) {
  if (props.collaborationEnabled !== true) return <CodeWorkspace {...props} />;
  return <CollaborativeCodeWorkspace {...props} />;
}
