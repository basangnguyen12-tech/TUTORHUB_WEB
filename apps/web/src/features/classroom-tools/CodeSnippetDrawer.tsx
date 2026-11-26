import { Tabs, TabsContent, TabsList, TabsTrigger } from "@tutorhub/ui";
import { BookmarkPlus, FilePlus, TextCursorInput, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useI18n } from "../../app/i18n";
import {
  CodeSnippetForm,
  ServerSnippetList,
  type CodeSnippetSaveSource,
  type ServerSnippetEditTarget,
} from "./CodeLibraryPanels";
import {
  CODE_LANGUAGE_IDS,
  CODE_LANGUAGES,
  type CodeFileLanguage,
  type CodeLanguageID,
} from "./codeLanguages";

type SnippetModule = typeof import("./snippetLibrary");

let snippetModule: Promise<SnippetModule> | null = null;

function loadSnippets(): Promise<SnippetModule> {
  snippetModule ??= import("./snippetLibrary").catch((error: unknown) => {
    snippetModule = null;
    throw error;
  });
  return snippetModule;
}

/** A snippet ready to become a file or to be inserted (never run). */
export interface InsertableCode {
  readonly content: string;
  readonly language: CodeFileLanguage;
  readonly name: string;
  readonly title: string;
}

export type { CodeSnippetSaveSource };

/**
 * ROOM-TOOLS-CODE-03B: the durable library (`code_snippet_library`). Without
 * it the drawer is the Slice 1 built-in library exactly.
 */
export interface CodeSnippetLibraryOptions {
  readonly classID: string | null;
  /** Display only: the server still decides who may manage class snippets. */
  readonly isStaff: boolean;
  /** Open straight on the "Save to library" form. */
  readonly initialView?: "browse" | "save";
  readonly onSaved: (title: string) => void;
  /** The open file, or its selection, at the moment the form opens. */
  readonly readSource: () => CodeSnippetSaveSource | null;
  readonly tenantID: string;
}

type DrawerSource = "builtin" | "personal" | "class";

type DrawerView =
  | { readonly kind: "browse" }
  | { readonly kind: "save" }
  | { readonly kind: "edit"; readonly target: ServerSnippetEditTarget };

/**
 * ROOM-TOOLS-CODE-01 "Kho Snippet": a slide-over inside the Code card (it
 * never covers the camera strip or the chat inspector). Search is
 * accent-insensitive; a snippet becomes a new file or is inserted at the
 * cursor. Escape or Close returns focus to the opener. Nothing runs.
 */
export function CodeSnippetDrawer({
  canInsertIntoCurrent,
  canInsertNew = true,
  library,
  onClose,
  onInsertCurrent,
  onInsertNew,
}: {
  canInsertIntoCurrent: boolean;
  /** `false` in a read-only shared workspace (ROOM-TOOLS-CODE-02B). */
  canInsertNew?: boolean;
  library?: CodeSnippetLibraryOptions;
  onClose: () => void;
  onInsertCurrent: (code: InsertableCode) => void;
  onInsertNew: (code: InsertableCode) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [source, setSource] = useState<DrawerSource>("builtin");
  const [view, setView] = useState<DrawerView>(() =>
    library?.initialView === "save" ? { kind: "save" } : { kind: "browse" },
  );
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const focusClaimed = useRef(false);
  const classID = library?.classID ?? null;
  const claimFocus = useCallback(() => {
    if (focusClaimed.current) return false;
    focusClaimed.current = true;
    return true;
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    if (
      event.target instanceof HTMLInputElement &&
      event.target.type === "search" &&
      event.target.value
    ) {
      return; // Escape first clears a filled search box (browser default).
    }
    event.preventDefault();
    event.stopPropagation();
    if (view.kind !== "browse" && library?.initialView !== "save") {
      backToBrowse();
      return;
    }
    onClose();
  };

  const backToBrowse = (next?: DrawerSource) => {
    setView({ kind: "browse" });
    if (next) setSource(next);
    globalThis.setTimeout(() => saveButtonRef.current?.focus(), 0);
  };

  const builtin = (
    <BuiltinSnippetBrowser
      claimFocus={claimFocus}
      canInsertIntoCurrent={canInsertIntoCurrent}
      canInsertNew={canInsertNew}
      onInsertCurrent={onInsertCurrent}
      onInsertNew={onInsertNew}
    />
  );

  return (
    <aside
      aria-labelledby={`${id}-title`}
      className="classroom-code-snippets"
      data-library={library ? "true" : undefined}
      onKeyDown={handleKeyDown}
    >
      <header className="classroom-code-snippets__header">
        <h3 className="classroom-code-snippets__title" id={`${id}-title`}>
          {t("classroomTools.snippets.title")}
        </h3>
        <span className="classroom-code-snippets__header-actions">
          {library && view.kind === "browse" ? (
            <button
              className="classroom-code-text-button"
              onClick={() => setView({ kind: "save" })}
              ref={saveButtonRef}
              type="button"
            >
              <BookmarkPlus aria-hidden="true" />
              {t("classroomTools.library.saveOpen")}
            </button>
          ) : null}
          <button
            aria-label={t("classroomTools.snippets.close")}
            className="classroom-code-icon-button"
            data-tooltip={t("classroomTools.snippets.close")}
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </span>
      </header>
      {!library ? (
        builtin
      ) : view.kind === "save" ? (
        <CodeSnippetForm
          classID={classID}
          isStaff={library.isStaff}
          mode={{ kind: "create" }}
          onCancel={() =>
            library.initialView === "save" ? onClose() : backToBrowse()
          }
          onDone={(saved) => {
            library.onSaved(saved.title);
            backToBrowse(saved.visibility === "class" ? "class" : "personal");
          }}
          readSource={library.readSource}
          tenantID={library.tenantID}
        />
      ) : view.kind === "edit" ? (
        <CodeSnippetForm
          classID={classID}
          isStaff={library.isStaff}
          mode={{ kind: "edit", target: view.target }}
          onCancel={() => backToBrowse()}
          onDone={(saved) => {
            library.onSaved(saved.title);
            backToBrowse();
          }}
          readSource={library.readSource}
          tenantID={library.tenantID}
        />
      ) : (
        <Tabs
          className="classroom-code-snippets__tabs"
          onValueChange={(value) => {
            if (value === "builtin" || value === "personal") setSource(value);
            else if (value === "class" && classID !== null) setSource(value);
          }}
          value={source === "class" && classID === null ? "builtin" : source}
        >
          <TabsList
            aria-label={t("classroomTools.library.sources")}
            className="classroom-code-snippets__tablist"
          >
            <TabsTrigger
              className="classroom-code-snippets__tab"
              value="builtin"
            >
              {t("classroomTools.library.sourceBuiltin")}
            </TabsTrigger>
            <TabsTrigger
              className="classroom-code-snippets__tab"
              value="personal"
            >
              {t("classroomTools.library.sourcePersonal")}
            </TabsTrigger>
            {classID !== null ? (
              <TabsTrigger
                className="classroom-code-snippets__tab"
                value="class"
              >
                {t("classroomTools.library.sourceClass")}
              </TabsTrigger>
            ) : null}
          </TabsList>
          <TabsContent
            className="classroom-code-snippets__panel"
            value="builtin"
          >
            {builtin}
          </TabsContent>
          <TabsContent
            className="classroom-code-snippets__panel"
            value="personal"
          >
            <ServerSnippetList
              canInsertIntoCurrent={canInsertIntoCurrent}
              canInsertNew={canInsertNew}
              classID={null}
              onEdit={(target) => setView({ kind: "edit", target })}
              onInsertCurrent={onInsertCurrent}
              onInsertNew={onInsertNew}
              scope="personal"
              tenantID={library.tenantID}
            />
          </TabsContent>
          {classID !== null ? (
            <TabsContent
              className="classroom-code-snippets__panel"
              value="class"
            >
              <ServerSnippetList
                canInsertIntoCurrent={canInsertIntoCurrent}
                canInsertNew={canInsertNew}
                classID={classID}
                onEdit={(target) => setView({ kind: "edit", target })}
                onInsertCurrent={onInsertCurrent}
                onInsertNew={onInsertNew}
                scope="class"
                tenantID={library.tenantID}
              />
            </TabsContent>
          ) : null}
        </Tabs>
      )}
    </aside>
  );
}

/** The Slice 1 pedagogy library, bundled as its own lazy chunk. */
function BuiltinSnippetBrowser({
  claimFocus,
  canInsertIntoCurrent,
  canInsertNew,
  onInsertCurrent,
  onInsertNew,
}: {
  /** True once: the first mount takes focus, later tab switches do not. */
  claimFocus: () => boolean;
  canInsertIntoCurrent: boolean;
  canInsertNew: boolean;
  onInsertCurrent: (code: InsertableCode) => void;
  onInsertNew: (code: InsertableCode) => void;
}) {
  const { language: uiLanguage, t } = useI18n();
  const id = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const [library, setLibrary] = useState<SnippetModule | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CodeLanguageID | "all">("all");

  useEffect(() => {
    let active = true;
    loadSnippets().then(
      (loaded) => {
        if (active) setLibrary(loaded);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);

  useEffect(() => {
    if (claimFocus()) searchRef.current?.focus();
  }, [claimFocus]);

  const results = useMemo(
    () => (library ? library.searchCodeSnippets(query, filter) : []),
    [filter, library, query],
  );

  return (
    <>
      <label className="visually-hidden" htmlFor={`${id}-search`}>
        {t("classroomTools.snippets.search")}
      </label>
      <input
        className="classroom-code-snippets__search"
        id={`${id}-search`}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("classroomTools.snippets.search")}
        ref={searchRef}
        type="search"
        value={query}
      />
      <div
        aria-label={t("classroomTools.snippets.filter")}
        className="classroom-code-snippets__filters"
        role="group"
      >
        {(["all", ...CODE_LANGUAGE_IDS] as const).map((value) => (
          <button
            aria-pressed={filter === value}
            className="classroom-code-chip"
            key={value}
            onClick={() => setFilter(value)}
            type="button"
          >
            {value === "all"
              ? t("classroomTools.snippets.all")
              : CODE_LANGUAGES[value].label}
          </button>
        ))}
      </div>
      <p
        aria-live="polite"
        className="classroom-code-snippets__count"
        role="status"
      >
        {library
          ? results.length === 0
            ? t("classroomTools.snippets.empty")
            : t("classroomTools.snippets.count", { count: results.length })
          : failed
            ? ""
            : t("classroomTools.snippets.loading")}
      </p>
      {failed && !library && (
        <div className="classroom-code-snippets__error" role="alert">
          <span>{t("classroomTools.snippets.loadError")}</span>
          <button
            className="classroom-code-text-button"
            onClick={() => {
              setFailed(false);
              setAttempt((value) => value + 1);
            }}
            type="button"
          >
            {t("state.retry")}
          </button>
        </div>
      )}
      <ul className="classroom-code-snippets__list">
        {results.map((snippet) => {
          const title =
            uiLanguage === "vi" ? snippet.title.vi : snippet.title.en;
          const description =
            uiLanguage === "vi"
              ? snippet.description.vi
              : snippet.description.en;
          const titleID = `${id}-${snippet.id}`;
          const code: InsertableCode = {
            content: snippet.code,
            language: snippet.language,
            name: snippet.fileName,
            title,
          };
          return (
            <li className="classroom-code-snippet" key={snippet.id}>
              <article aria-labelledby={titleID}>
                <div className="classroom-code-snippet__head">
                  <h4 className="classroom-code-snippet__title" id={titleID}>
                    {title}
                  </h4>
                  <span className="classroom-code-snippet__badge">
                    {CODE_LANGUAGES[snippet.language].label}
                  </span>
                </div>
                <p className="classroom-code-snippet__description">
                  {description}
                </p>
                <pre
                  aria-hidden="true"
                  className="classroom-code-snippet__preview"
                >
                  {snippet.code.split("\n").slice(0, 6).join("\n")}
                </pre>
                <div className="classroom-code-snippet__actions">
                  <button
                    aria-describedby={titleID}
                    className="classroom-code-text-button"
                    disabled={!canInsertNew}
                    onClick={() => onInsertNew(code)}
                    type="button"
                  >
                    <FilePlus aria-hidden="true" />
                    {t("classroomTools.snippets.insertNew")}
                  </button>
                  <button
                    aria-describedby={titleID}
                    className="classroom-code-text-button"
                    disabled={!canInsertIntoCurrent}
                    onClick={() => onInsertCurrent(code)}
                    type="button"
                  >
                    <TextCursorInput aria-hidden="true" />
                    {t("classroomTools.snippets.insertCurrent")}
                  </button>
                </div>
              </article>
            </li>
          );
        })}
      </ul>
    </>
  );
}
