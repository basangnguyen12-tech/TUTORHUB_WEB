import { useQueryClient } from "@tanstack/react-query";
import type { CodeSharedScratchpad } from "@tutorhub/api-client";
import {
  ArrowLeft,
  CopyPlus,
  MessageSquareText,
  RefreshCw,
  Users,
  X,
} from "lucide-react";
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  codeLibraryErrorKind,
  codeLibraryQueryKeys,
  useSharedCodeScratchpad,
  useSharedCodeScratchpads,
} from "../../app/codeLibrary";
import { useI18n } from "../../app/i18n";
import { formatCodeBytes } from "./codeLibraryFormat";
import { CODE_LANGUAGES, isCodeFileLanguage } from "./codeLanguages";
import type { ClassroomCodeWorkspaceFile } from "./codeSession";

/** ADR-0043 Slice 3: a light re-read while the teacher has the list open. */
export const SHARED_WORK_POLL_INTERVAL_MS = 10_000;

export interface SharedWorkCopy {
  readonly activeIndex: number;
  readonly authorName: string;
  readonly files: readonly ClassroomCodeWorkspaceFile[];
  readonly stdin: string;
}

/**
 * ROOM-TOOLS-CODE-03B "Bài học sinh (N)": staff-only. The count comes from
 * the server's shared list; the button is a hint — the server answers 404 to
 * anyone outside the room's teaching staff.
 */
export const CodeSharedWorkButton = forwardRef<
  HTMLButtonElement,
  {
    readonly expanded: boolean;
    readonly mediaSpaceID: string;
    readonly onToggle: () => void;
    readonly tenantID: string;
  }
>(function CodeSharedWorkButton(
  { expanded, mediaSpaceID, onToggle, tenantID },
  ref,
) {
  const { t } = useI18n();
  const list = useSharedCodeScratchpads(tenantID, mediaSpaceID, true);
  const count = list.isSuccess ? list.data.items.length : null;
  return (
    <button
      aria-expanded={expanded}
      aria-label={
        count !== null
          ? t("classroomTools.shared.buttonCount", { count })
          : undefined
      }
      className="classroom-code-text-button classroom-code-files__shared"
      onClick={onToggle}
      ref={ref}
      type="button"
    >
      <Users aria-hidden="true" />
      <span className="classroom-code-files__snippets-label">
        {t("classroomTools.shared.button")}
      </span>
      {count !== null ? (
        <span className="classroom-code-files__count">{` (${count})`}</span>
      ) : null}
    </button>
  );
});

function formatTime(value: string, locale: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(time);
}

export function CodeSharedWorkDrawer({
  canComment,
  mediaSpaceID,
  onClose,
  onComment,
  onOpenCopy,
  tenantID,
}: {
  readonly canComment: boolean;
  readonly mediaSpaceID: string;
  readonly onClose: () => void;
  readonly onComment: (authorName: string) => void;
  readonly onOpenCopy: (copy: SharedWorkCopy) => void;
  readonly tenantID: string;
}) {
  const { language: uiLanguage, t } = useI18n();
  const locale = uiLanguage === "vi" ? "vi-VN" : "en-US";
  const id = useId();
  const queryClient = useQueryClient();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const list = useSharedCodeScratchpads(tenantID, mediaSpaceID, true, {
    pollIntervalMs: SHARED_WORK_POLL_INTERVAL_MS,
  });
  const detail = useSharedCodeScratchpad(tenantID, mediaSpaceID, selected);
  const items = list.isSuccess ? list.data.items : [];
  const listError = list.isError ? codeLibraryErrorKind(list.error) : null;
  const detailGone =
    detail.isError && codeLibraryErrorKind(detail.error) === "not_found";

  // Focus stays inside the drawer: its title on open and while a student's
  // work loads (the detail heading takes it once shown), and after "back".
  useEffect(() => {
    titleRef.current?.focus();
  }, [selected]);

  // A draft its owner stopped sharing: say so once and re-read the list.
  useEffect(() => {
    if (!detailGone) return;
    void queryClient.invalidateQueries({
      queryKey: codeLibraryQueryKeys.sharedScratchpads(tenantID, mediaSpaceID),
    });
  }, [detailGone, mediaSpaceID, queryClient, tenantID]);

  const back = () => {
    setSelected(null);
    setNotice("");
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  return (
    <aside
      aria-labelledby={`${id}-title`}
      className="classroom-code-snippets classroom-code-shared"
      onKeyDown={handleKeyDown}
    >
      <header className="classroom-code-snippets__header">
        <h3
          className="classroom-code-snippets__title"
          id={`${id}-title`}
          ref={titleRef}
          tabIndex={-1}
        >
          {t("classroomTools.shared.title")}
        </h3>
        <span className="classroom-code-snippets__header-actions">
          <button
            className="classroom-code-text-button"
            disabled={list.isFetching}
            onClick={() => void list.refetch()}
            type="button"
          >
            <RefreshCw aria-hidden="true" />
            {t("classroomTools.shared.refresh")}
          </button>
          <button
            aria-label={t("classroomTools.shared.close")}
            className="classroom-code-icon-button"
            data-tooltip={t("classroomTools.shared.close")}
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </span>
      </header>
      <p className="classroom-code-shared__hint">
        {t("classroomTools.shared.hint")}
      </p>
      <p
        aria-live="polite"
        className="classroom-code-snippets__count"
        role="status"
      >
        {notice ||
          (list.isPending
            ? t("classroomTools.shared.loading")
            : list.isSuccess
              ? items.length === 0
                ? t("classroomTools.shared.empty")
                : t("classroomTools.shared.count", { count: items.length })
              : "")}
      </p>
      {listError ? (
        <div className="classroom-code-snippets__error" role="alert">
          <span>
            {t(
              listError === "forbidden" || listError === "not_found"
                ? "classroomTools.shared.forbidden"
                : listError === "feature_off"
                  ? "classroomTools.library.featureOff"
                  : "classroomTools.shared.loadError",
            )}
          </span>
          {listError === "failed" || listError === "invalid" ? (
            <button
              className="classroom-code-text-button"
              onClick={() => void list.refetch()}
              type="button"
            >
              {t("state.retry")}
            </button>
          ) : null}
        </div>
      ) : null}
      {selected === null || detailGone ? (
        <>
          {detailGone ? (
            <p className="classroom-code-snippets__error" role="alert">
              {t("classroomTools.shared.revoked")}
            </p>
          ) : null}
          <ul className="classroom-code-snippets__list">
            {items.map((item) => (
              <li className="classroom-code-snippet" key={item.id}>
                <button
                  className="classroom-code-shared__item"
                  onClick={() => {
                    setNotice("");
                    setSelected(item.id);
                  }}
                  type="button"
                >
                  <span className="classroom-code-snippet__title">
                    {item.author_display_name}
                  </span>
                  <span className="classroom-code-snippet__meta">
                    {t("classroomTools.shared.itemMeta", {
                      files: item.file_count,
                      language: isCodeFileLanguage(item.active_language)
                        ? CODE_LANGUAGES[item.active_language].label
                        : item.active_language,
                      size: formatCodeBytes(item.byte_length),
                      time: formatTime(item.updated_at, locale),
                    })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : detail.isSuccess ? (
        <SharedWorkDetail
          canComment={canComment}
          onBack={back}
          onComment={onComment}
          onOpenCopy={onOpenCopy}
          work={detail.data}
        />
      ) : detail.isError ? (
        <div className="classroom-code-snippets__error" role="alert">
          <span>{t("classroomTools.shared.detailError")}</span>
          <button
            className="classroom-code-text-button"
            onClick={() => void detail.refetch()}
            type="button"
          >
            {t("state.retry")}
          </button>
          <button
            className="classroom-code-text-button"
            onClick={back}
            type="button"
          >
            {t("classroomTools.shared.back")}
          </button>
        </div>
      ) : (
        <p className="classroom-code-snippets__count" role="status">
          {t("classroomTools.shared.loadingDetail")}
        </p>
      )}
    </aside>
  );
}

function SharedWorkDetail({
  canComment,
  onBack,
  onComment,
  onOpenCopy,
  work,
}: {
  readonly canComment: boolean;
  readonly onBack: () => void;
  readonly onComment: (authorName: string) => void;
  readonly onOpenCopy: (copy: SharedWorkCopy) => void;
  readonly work: CodeSharedScratchpad;
}) {
  const { t } = useI18n();
  const id = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  const files = work.files.filter((file) => isCodeFileLanguage(file.language));
  const [fileIndex, setFileIndex] = useState(() =>
    Math.min(Math.max(0, work.active_index), Math.max(0, files.length - 1)),
  );
  const file = files[fileIndex] ?? null;
  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="classroom-code-shared__detail"
    >
      <div className="classroom-code-shared__detail-head">
        <button
          className="classroom-code-text-button"
          onClick={onBack}
          type="button"
        >
          <ArrowLeft aria-hidden="true" />
          {t("classroomTools.shared.back")}
        </button>
        <h4
          className="classroom-code-snippet__title"
          id={`${id}-heading`}
          ref={headingRef}
          tabIndex={-1}
        >
          {t("classroomTools.shared.detailTitle", {
            name: work.author_display_name,
          })}
        </h4>
      </div>
      <p className="classroom-code-shared__readonly">
        {t("classroomTools.shared.readOnly")}
      </p>
      <div
        aria-label={t("classroomTools.shared.files")}
        className="classroom-code-snippets__filters"
        role="group"
      >
        {files.map((item, index) => (
          <button
            aria-pressed={index === fileIndex}
            className="classroom-code-chip"
            key={item.name}
            onClick={() => setFileIndex(index)}
            type="button"
          >
            {item.name}
          </button>
        ))}
      </div>
      {file ? (
        <pre
          aria-label={t("classroomTools.shared.fileLabel", {
            name: file.name,
            student: work.author_display_name,
          })}
          className="classroom-code-shared__code"
          tabIndex={0}
        >
          <code>{file.content}</code>
        </pre>
      ) : null}
      {work.stdin ? (
        <>
          <p className="classroom-code-library-form__label">
            {t("classroomTools.shared.stdin")}
          </p>
          <pre
            aria-label={t("classroomTools.shared.stdin")}
            className="classroom-code-shared__code classroom-code-shared__code--stdin"
            tabIndex={0}
          >
            <code>{work.stdin}</code>
          </pre>
        </>
      ) : null}
      <div className="classroom-code-snippet__actions">
        <button
          className="classroom-code-text-button classroom-code-text-button--primary"
          disabled={files.length === 0}
          onClick={() =>
            onOpenCopy({
              activeIndex: fileIndex,
              authorName: work.author_display_name,
              files: files.map((item) => ({
                content: item.content,
                language: item.language,
                name: item.name,
              })),
              stdin: work.stdin,
            })
          }
          type="button"
        >
          <CopyPlus aria-hidden="true" />
          {t("classroomTools.shared.openCopy")}
        </button>
        {canComment ? (
          <button
            className="classroom-code-text-button"
            onClick={() => onComment(work.author_display_name)}
            type="button"
          >
            <MessageSquareText aria-hidden="true" />
            {t("classroomTools.shared.comment")}
          </button>
        ) : null}
      </div>
    </section>
  );
}
