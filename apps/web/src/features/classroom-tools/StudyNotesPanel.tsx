import { Button, IconButton } from "@tutorhub/ui";
import { X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { useI18n } from "../../app/i18n";
import type { RoomStudyNotes } from "../../app/roomStudyNotes";
import "./StudyNotesPanel.css";

export function StudyNotesPanel({
  notes,
  page,
  id,
  onPage,
  onClose,
  canGoToPage,
}: {
  readonly notes: RoomStudyNotes;
  readonly page: number;
  readonly id: string;
  readonly onPage: (page: number) => void;
  readonly onClose: () => void;
  readonly canGoToPage?: (page: number) => boolean;
}) {
  const { t } = useI18n();
  const inputID = useId();
  const privacyID = useId();
  const titleID = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const value = notes.entries.find((entry) => entry.page === page)?.text ?? "";
  const count = Array.from(value).length;
  const listed = notes.entries.filter((entry) => entry.text.trim().length > 0);
  const error = ["error", "limit", "conflict", "tooLarge"].includes(
    notes.status,
  );
  const flush = notes.flush;
  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(
    () => () => {
      void flush();
    },
    [flush, page],
  );
  return (
    <aside
      className="classroom-study-notes"
      aria-labelledby={titleID}
      id={id}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else if (event.target === input.current) {
          // Preserve native text editing and keep navigation in the editor.
          event.stopPropagation();
        }
      }}
    >
      <header>
        <h3 id={titleID}>{t("classroomTools.files.notes.title")}</h3>
        <IconButton
          label={t("classroomTools.files.notes.close")}
          onClick={onClose}
          size="sm"
          variant="quiet"
        >
          <X />
        </IconButton>
      </header>
      <p id={privacyID}>{t("classroomTools.files.notes.privacy")}</p>
      <label htmlFor={inputID}>
        {t("classroomTools.files.viewer.page", { page })}
      </label>
      <textarea
        aria-describedby={privacyID}
        id={inputID}
        readOnly={!notes.ready}
        ref={input}
        onChange={(event) => notes.edit(page, event.target.value)}
        value={value}
      />
      {count >= 1800 && (
        <small>{t("classroomTools.files.notes.count", { count })}</small>
      )}
      <p key={error ? "error" : "status"} role={error ? "alert" : "status"}>
        {t(`classroomTools.files.notes.${notes.status}`)}
      </p>
      {error && notes.status !== "tooLarge" && (
        <Button size="sm" variant="secondary" onClick={notes.retry}>
          {t("state.retry")}
        </Button>
      )}
      <h4>{t("classroomTools.files.notes.list")}</h4>
      {listed.length === 0 ? (
        <p>{t("classroomTools.files.notes.empty")}</p>
      ) : (
        <ul>
          {listed.map((entry) => (
            <li key={entry.page}>
              <button
                type="button"
                disabled={canGoToPage?.(entry.page) === false}
                onClick={() => onPage(entry.page)}
              >
                <strong>
                  {t("classroomTools.files.viewer.page", { page: entry.page })}
                </strong>
                <span>{entry.text.trim().slice(0, 120)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
