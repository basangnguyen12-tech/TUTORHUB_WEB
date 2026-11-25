import { FilePlus, TextCursorInput, X } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useI18n } from "../../app/i18n";
import {
  CODE_LANGUAGE_IDS,
  CODE_LANGUAGES,
  type CodeLanguageID,
} from "./codeLanguages";
import type { CodeSnippet } from "./snippetLibrary";

type SnippetModule = typeof import("./snippetLibrary");

let snippetModule: Promise<SnippetModule> | null = null;

function loadSnippets(): Promise<SnippetModule> {
  snippetModule ??= import("./snippetLibrary").catch((error: unknown) => {
    snippetModule = null;
    throw error;
  });
  return snippetModule;
}

/**
 * ROOM-TOOLS-CODE-01 "Kho Snippet": a slide-over inside the Code card (it
 * never covers the camera strip or the chat inspector). Search is
 * accent-insensitive; a snippet becomes a new file or is inserted at the
 * cursor. Escape or Close returns focus to the opener. Nothing runs.
 */
export function CodeSnippetDrawer({
  canInsertIntoCurrent,
  onClose,
  onInsertCurrent,
  onInsertNew,
}: {
  canInsertIntoCurrent: boolean;
  onClose: () => void;
  onInsertCurrent: (snippet: CodeSnippet) => void;
  onInsertNew: (snippet: CodeSnippet) => void;
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
    searchRef.current?.focus();
  }, []);

  const results = useMemo(
    () => (library ? library.searchCodeSnippets(query, filter) : []),
    [filter, library, query],
  );

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    if (event.target instanceof HTMLInputElement && event.target.value) {
      return; // Escape first clears a filled search box (browser default).
    }
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  return (
    <aside
      aria-labelledby={`${id}-title`}
      className="classroom-code-snippets"
      onKeyDown={handleKeyDown}
    >
      <header className="classroom-code-snippets__header">
        <h3 className="classroom-code-snippets__title" id={`${id}-title`}>
          {t("classroomTools.snippets.title")}
        </h3>
        <button
          aria-label={t("classroomTools.snippets.close")}
          className="classroom-code-icon-button"
          data-tooltip={t("classroomTools.snippets.close")}
          onClick={onClose}
          type="button"
        >
          <X aria-hidden="true" />
        </button>
      </header>
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
                    onClick={() => onInsertNew(snippet)}
                    type="button"
                  >
                    <FilePlus aria-hidden="true" />
                    {t("classroomTools.snippets.insertNew")}
                  </button>
                  <button
                    aria-describedby={titleID}
                    className="classroom-code-text-button"
                    disabled={!canInsertIntoCurrent}
                    onClick={() => onInsertCurrent(snippet)}
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
    </aside>
  );
}
