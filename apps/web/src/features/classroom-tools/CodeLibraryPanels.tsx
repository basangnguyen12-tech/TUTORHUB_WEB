import type {
  CodeSnippetSummary,
  CodeSnippetVisibility,
} from "@tutorhub/api-client";
import {
  FilePlus,
  Loader2,
  Pencil,
  TextCursorInput,
  Trash2,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  CODE_SNIPPET_MAX_CONTENT_BYTES,
  CODE_SNIPPET_MAX_DESCRIPTION,
  CODE_SNIPPET_MAX_QUERY,
  CODE_SNIPPET_MAX_TITLE,
  codeLibraryErrorKind,
  useCodeSnippets,
  useCreateCodeSnippet,
  useDeleteCodeSnippet,
  useLoadCodeSnippet,
  useUpdateCodeSnippet,
} from "../../app/codeLibrary";
import { useI18n, type TranslationKey } from "../../app/i18n";
import { formatCodeBytes, libraryErrorKey } from "./codeLibraryFormat";
import type { InsertableCode } from "./CodeSnippetDrawer";
import {
  CODE_LANGUAGE_IDS,
  CODE_LANGUAGES,
  type CodeFileLanguage,
  type CodeLanguageID,
} from "./codeLanguages";
import { utf8Bytes } from "./codeWorkspaceModel";

/**
 * ROOM-TOOLS-CODE-03B: the durable halves of "Kho Snippet" — the personal and
 * class lists (keyset pages of summaries; content is read only when a snippet
 * is opened or inserted) and the save / edit form. Every right shown here is
 * the server's `viewer_capabilities`; nothing is ever run.
 */
export interface CodeSnippetSaveSource {
  readonly content: string;
  readonly fileName: string;
  readonly fromSelection: boolean;
  readonly language: CodeFileLanguage;
}

export interface ServerSnippetEditTarget {
  readonly description: string;
  readonly id: string;
  readonly title: string;
  readonly version: number;
  readonly visibility: CodeSnippetVisibility;
}

type PendingAction = {
  readonly action: "new" | "current";
  readonly id: string;
};

export function ServerSnippetList({
  canInsertIntoCurrent,
  canInsertNew,
  classID,
  onEdit,
  onInsertCurrent,
  onInsertNew,
  scope,
  tenantID,
}: {
  readonly canInsertIntoCurrent: boolean;
  readonly canInsertNew: boolean;
  readonly classID: string | null;
  readonly onEdit: (target: ServerSnippetEditTarget) => void;
  readonly onInsertCurrent: (code: InsertableCode) => void;
  readonly onInsertNew: (code: InsertableCode) => void;
  readonly scope: CodeSnippetVisibility;
  readonly tenantID: string;
}) {
  const { t } = useI18n();
  const id = useId();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [filter, setFilter] = useState<CodeLanguageID | "all">("all");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [itemError, setItemError] = useState<{
    readonly id: string;
    readonly key: TranslationKey;
  } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const timer = globalThis.setTimeout(() => setDebounced(query), 250);
    return () => globalThis.clearTimeout(timer);
  }, [query]);

  const list = useCodeSnippets(
    tenantID,
    {
      classID: scope === "class" ? classID : null,
      language: filter === "all" ? null : filter,
      query: debounced,
      scope,
    },
    true,
  );
  const load = useLoadCodeSnippet(tenantID);
  const remove = useDeleteCodeSnippet(tenantID);
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered = debounced.trim() !== "" || filter !== "all";
  const errorKind = list.isError ? codeLibraryErrorKind(list.error) : null;

  const take = async (
    snippet: CodeSnippetSummary,
    action: "new" | "current",
  ) => {
    setPending({ action, id: snippet.id });
    setItemError(null);
    try {
      const detail = await load(snippet.id);
      const code: InsertableCode = {
        content: detail.content,
        language: detail.language,
        name: detail.file_name,
        title: detail.title,
      };
      if (action === "new") onInsertNew(code);
      else onInsertCurrent(code);
    } catch (error) {
      const kind = codeLibraryErrorKind(error);
      setItemError({
        id: snippet.id,
        key:
          kind === "not_found"
            ? "classroomTools.library.errorNotFound"
            : "classroomTools.library.detailError",
      });
      if (kind === "not_found") void list.refetch();
    } finally {
      setPending(null);
    }
  };

  const confirmDelete = (snippet: CodeSnippetSummary) => {
    remove.mutate(snippet.id, {
      onError: (error) => {
        setConfirming(null);
        setItemError({
          id: snippet.id,
          key: libraryErrorKey(codeLibraryErrorKind(error)),
        });
      },
      onSuccess: () => {
        setConfirming(null);
        setNotice(
          t("classroomTools.library.deleted", { title: snippet.title }),
        );
      },
    });
  };

  return (
    <div className="classroom-code-library">
      <label className="visually-hidden" htmlFor={`${id}-search`}>
        {t("classroomTools.snippets.search")}
      </label>
      <input
        className="classroom-code-snippets__search"
        id={`${id}-search`}
        maxLength={CODE_SNIPPET_MAX_QUERY}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("classroomTools.snippets.search")}
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
        {notice ||
          (list.isPending
            ? t("classroomTools.snippets.loading")
            : list.isError
              ? ""
              : items.length === 0
                ? filtered
                  ? t("classroomTools.snippets.empty")
                  : scope === "class"
                    ? t("classroomTools.library.emptyClass")
                    : t("classroomTools.library.emptyPersonal")
                : t("classroomTools.snippets.count", { count: items.length }))}
      </p>
      {errorKind ? (
        <div className="classroom-code-snippets__error" role="alert">
          <span>
            {t(
              errorKind === "forbidden" || errorKind === "not_found"
                ? "classroomTools.library.forbidden"
                : errorKind === "feature_off"
                  ? "classroomTools.library.featureOff"
                  : "classroomTools.library.loadError",
            )}
          </span>
          {errorKind === "forbidden" ||
          errorKind === "not_found" ||
          errorKind === "feature_off" ? null : (
            <button
              className="classroom-code-text-button"
              onClick={() => void list.refetch()}
              type="button"
            >
              {t("state.retry")}
            </button>
          )}
        </div>
      ) : null}
      <ul className="classroom-code-snippets__list">
        {items.map((snippet) => {
          const titleID = `${id}-${snippet.id}`;
          const busy = pending?.id === snippet.id;
          const info = CODE_LANGUAGES[snippet.language];
          return (
            <li className="classroom-code-snippet" key={snippet.id}>
              <article aria-busy={busy || undefined} aria-labelledby={titleID}>
                <div className="classroom-code-snippet__head">
                  <h4 className="classroom-code-snippet__title" id={titleID}>
                    {snippet.title}
                  </h4>
                  <span className="classroom-code-snippet__badge">
                    {info.label}
                  </span>
                </div>
                {snippet.description ? (
                  <p className="classroom-code-snippet__description">
                    {snippet.description}
                  </p>
                ) : null}
                <p className="classroom-code-snippet__meta">
                  {t("classroomTools.library.meta", {
                    author: snippet.author_display_name,
                    file: snippet.file_name,
                    size: formatCodeBytes(snippet.byte_length),
                  })}
                </p>
                {itemError?.id === snippet.id ? (
                  <p className="classroom-code-snippet__error" role="alert">
                    {t(itemError.key)}
                  </p>
                ) : null}
                {confirming === snippet.id ? (
                  <div
                    className="classroom-code-snippet__confirm"
                    role="group"
                    aria-label={t("classroomTools.library.deleteConfirm", {
                      title: snippet.title,
                    })}
                  >
                    <span>
                      {t("classroomTools.library.deleteConfirm", {
                        title: snippet.title,
                      })}
                    </span>
                    <button
                      className="classroom-code-text-button classroom-code-text-button--danger"
                      disabled={remove.isPending}
                      onClick={() => confirmDelete(snippet)}
                      type="button"
                    >
                      {t("classroomTools.library.delete")}
                    </button>
                    <button
                      className="classroom-code-text-button"
                      disabled={remove.isPending}
                      onClick={() => setConfirming(null)}
                      type="button"
                    >
                      {t("classroomTools.code.cancel")}
                    </button>
                  </div>
                ) : (
                  <div className="classroom-code-snippet__actions">
                    <button
                      aria-describedby={titleID}
                      className="classroom-code-text-button"
                      disabled={!canInsertNew || busy}
                      onClick={() => void take(snippet, "new")}
                      type="button"
                    >
                      {busy && pending?.action === "new" ? (
                        <Loader2
                          aria-hidden="true"
                          className="classroom-code-spin"
                        />
                      ) : (
                        <FilePlus aria-hidden="true" />
                      )}
                      {busy && pending?.action === "new"
                        ? t("classroomTools.library.loadingDetail")
                        : t("classroomTools.library.openNew")}
                    </button>
                    <button
                      aria-describedby={titleID}
                      className="classroom-code-text-button"
                      disabled={!canInsertIntoCurrent || busy}
                      onClick={() => void take(snippet, "current")}
                      type="button"
                    >
                      {busy && pending?.action === "current" ? (
                        <Loader2
                          aria-hidden="true"
                          className="classroom-code-spin"
                        />
                      ) : (
                        <TextCursorInput aria-hidden="true" />
                      )}
                      {busy && pending?.action === "current"
                        ? t("classroomTools.library.loadingDetail")
                        : t("classroomTools.library.insertCurrent")}
                    </button>
                    {snippet.viewer_capabilities.can_edit ? (
                      <button
                        aria-label={t("classroomTools.library.editLabel", {
                          title: snippet.title,
                        })}
                        className="classroom-code-text-button"
                        onClick={() =>
                          onEdit({
                            description: snippet.description,
                            id: snippet.id,
                            title: snippet.title,
                            version: snippet.version,
                            visibility: snippet.visibility,
                          })
                        }
                        type="button"
                      >
                        <Pencil aria-hidden="true" />
                        {t("classroomTools.library.edit")}
                      </button>
                    ) : null}
                    {snippet.viewer_capabilities.can_delete ? (
                      <button
                        aria-label={t("classroomTools.library.deleteLabel", {
                          title: snippet.title,
                        })}
                        className="classroom-code-text-button"
                        onClick={() => {
                          setItemError(null);
                          setConfirming(snippet.id);
                        }}
                        type="button"
                      >
                        <Trash2 aria-hidden="true" />
                        {t("classroomTools.library.delete")}
                      </button>
                    ) : null}
                  </div>
                )}
              </article>
            </li>
          );
        })}
      </ul>
      {list.hasNextPage ? (
        <button
          className="classroom-code-text-button classroom-code-library__more"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
          type="button"
        >
          {list.isFetchingNextPage
            ? t("classroomTools.snippets.loading")
            : t("classroomTools.library.loadMore")}
        </button>
      ) : null}
    </div>
  );
}

export function CodeSnippetForm({
  classID,
  isStaff,
  mode,
  onCancel,
  onDone,
  readSource,
  tenantID,
}: {
  readonly classID: string | null;
  readonly isStaff: boolean;
  readonly mode:
    | { readonly kind: "create" }
    | { readonly kind: "edit"; readonly target: ServerSnippetEditTarget };
  readonly onCancel: () => void;
  readonly onDone: (saved: {
    readonly title: string;
    readonly visibility: CodeSnippetVisibility;
  }) => void;
  readonly readSource: () => CodeSnippetSaveSource | null;
  readonly tenantID: string;
}) {
  const { t } = useI18n();
  const id = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const editing = mode.kind === "edit" ? mode.target : null;
  const [source] = useState(readSource);
  const [title, setTitle] = useState(
    () => editing?.title ?? source?.fileName ?? "",
  );
  const [description, setDescription] = useState(
    () => editing?.description ?? "",
  );
  const [visibility, setVisibility] =
    useState<CodeSnippetVisibility>("personal");
  const [replaceContent, setReplaceContent] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);
  const create = useCreateCodeSnippet(tenantID);
  const update = useUpdateCodeSnippet(tenantID);
  const busy = create.isPending || update.isPending;
  const canShareClass = classID !== null && isStaff && editing === null;
  const bytes = source ? utf8Bytes(source.content) : 0;
  const tooLarge = bytes > CODE_SNIPPET_MAX_CONTENT_BYTES;

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (
      [...trimmed].length < 1 ||
      [...trimmed].length > CODE_SNIPPET_MAX_TITLE
    ) {
      setError("classroomTools.library.titleRequired");
      titleRef.current?.focus();
      return;
    }
    if ([...description].length > CODE_SNIPPET_MAX_DESCRIPTION) {
      setError("classroomTools.library.errorInvalid");
      return;
    }
    const needsContent = editing === null || replaceContent;
    if (needsContent && (!source || source.content.length === 0)) {
      setError("classroomTools.library.sourceEmpty");
      return;
    }
    if (needsContent && tooLarge) {
      setError("classroomTools.library.errorTooLarge");
      return;
    }
    setError(null);
    const onError = (failure: unknown) =>
      setError(libraryErrorKey(codeLibraryErrorKind(failure)));
    if (editing === null && source) {
      const shareClass = visibility === "class" && canShareClass;
      create.mutate(
        {
          class_id: shareClass ? classID : null,
          content: source.content,
          description,
          file_name: source.fileName,
          language: source.language,
          title: trimmed,
          visibility: shareClass ? "class" : "personal",
        },
        {
          onError,
          onSuccess: (saved) =>
            onDone({ title: saved.title, visibility: saved.visibility }),
        },
      );
      return;
    }
    if (editing) {
      update.mutate(
        {
          input: {
            description,
            expected_version: editing.version,
            title: trimmed,
            ...(replaceContent && source
              ? {
                  content: source.content,
                  file_name: source.fileName,
                  language: source.language,
                }
              : {}),
          },
          snippetID: editing.id,
        },
        {
          onError,
          onSuccess: (saved) =>
            onDone({ title: saved.title, visibility: saved.visibility }),
        },
      );
    }
  };

  const sourceText = source
    ? t(
        source.fromSelection
          ? "classroomTools.library.sourceSelection"
          : "classroomTools.library.sourceFile",
        { name: source.fileName, size: formatCodeBytes(bytes) },
      )
    : t("classroomTools.library.sourceNone");

  return (
    <form
      aria-labelledby={`${id}-heading`}
      className="classroom-code-library-form"
      noValidate
      onSubmit={submit}
    >
      <h4 className="classroom-code-library-form__title" id={`${id}-heading`}>
        {t(
          editing
            ? "classroomTools.library.editTitle"
            : "classroomTools.library.saveTitle",
        )}
      </h4>
      <label
        className="classroom-code-library-form__label"
        htmlFor={`${id}-title`}
      >
        {t("classroomTools.library.fieldTitle")}
      </label>
      <input
        aria-describedby={error ? `${id}-error` : undefined}
        aria-invalid={
          error === "classroomTools.library.titleRequired" || undefined
        }
        className="classroom-code-snippets__search"
        id={`${id}-title`}
        maxLength={CODE_SNIPPET_MAX_TITLE}
        onChange={(event) => setTitle(event.target.value)}
        ref={titleRef}
        required
        type="text"
        value={title}
      />
      <label
        className="classroom-code-library-form__label"
        htmlFor={`${id}-description`}
      >
        {t("classroomTools.library.fieldDescription")}
      </label>
      <textarea
        className="classroom-code-library-form__textarea"
        id={`${id}-description`}
        maxLength={CODE_SNIPPET_MAX_DESCRIPTION}
        onChange={(event) => setDescription(event.target.value)}
        rows={2}
        value={description}
      />
      {editing === null ? (
        <fieldset className="classroom-code-library-form__scope">
          <legend className="classroom-code-library-form__label">
            {t("classroomTools.library.fieldScope")}
          </legend>
          <label className="classroom-code-library-form__radio">
            <input
              checked={visibility === "personal"}
              name={`${id}-scope`}
              onChange={() => setVisibility("personal")}
              type="radio"
              value="personal"
            />
            {t("classroomTools.library.scopePersonal")}
          </label>
          {canShareClass ? (
            <label className="classroom-code-library-form__radio">
              <input
                checked={visibility === "class"}
                name={`${id}-scope`}
                onChange={() => setVisibility("class")}
                type="radio"
                value="class"
              />
              {t("classroomTools.library.scopeClass")}
            </label>
          ) : null}
        </fieldset>
      ) : (
        <label className="classroom-code-library-form__radio">
          <input
            checked={replaceContent}
            disabled={!source}
            onChange={(event) => setReplaceContent(event.target.checked)}
            type="checkbox"
          />
          {t("classroomTools.library.replaceContent")}
        </label>
      )}
      <p className="classroom-code-library-form__source">{sourceText}</p>
      {error ? (
        <p
          className="classroom-code-library-form__error"
          id={`${id}-error`}
          role="alert"
        >
          {t(error)}
        </p>
      ) : null}
      <div className="classroom-code-library-form__actions">
        <button
          className="classroom-code-text-button classroom-code-text-button--primary"
          disabled={busy}
          type="submit"
        >
          {busy ? (
            <Loader2 aria-hidden="true" className="classroom-code-spin" />
          ) : null}
          {busy
            ? t("classroomTools.library.saving")
            : t(
                editing
                  ? "classroomTools.library.saveChanges"
                  : "classroomTools.library.saveSubmit",
              )}
        </button>
        <button
          className="classroom-code-text-button"
          disabled={busy}
          onClick={onCancel}
          type="button"
        >
          {t("classroomTools.code.cancel")}
        </button>
      </div>
    </form>
  );
}
