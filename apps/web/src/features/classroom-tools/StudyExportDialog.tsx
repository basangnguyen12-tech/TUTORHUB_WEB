import type { StudyNoteEntry } from "@tutorhub/api-client";
import type { PdfStroke } from "@tutorhub/collaboration-client";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@tutorhub/ui";
import { useEffect, useRef, useState } from "react";
import { useI18n, type TranslationKey } from "../../app/i18n";
import {
  classifyRoomDocumentError,
  RoomDocumentBytesError,
} from "../../app/roomDocuments";
import type { DocumentSource } from "./DocumentViewer";
import type { ClassroomFilesOpenDocument } from "./filesSession";
import type { PdfInkStore } from "./livePdfCollaboration";
import {
  readClassInk,
  getStudyExportBytes,
  type DocumentStudyScope,
} from "./studyExportSource";

function downloadPdf(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = (name.replace(/\.[^.]+$/u, "") || name) + "-hoc-bai.pdf";
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function StudyExportDialog({
  canDownloadOriginal,
  doc,
  ink,
  notes,
  notesLoading,
  retryNotes,
  onClose,
  onReturnFocus,
  scope,
  source,
}: {
  readonly canDownloadOriginal: boolean;
  readonly doc: ClassroomFilesOpenDocument;
  readonly ink?: PdfInkStore;
  readonly notes: readonly StudyNoteEntry[];
  readonly notesLoading: boolean;
  readonly retryNotes?: () => void;
  readonly onClose: () => void;
  readonly onReturnFocus: () => void;
  readonly scope: DocumentStudyScope;
  readonly source: DocumentSource;
}) {
  const { t } = useI18n();
  const [inkInput] = useState(() => ({ scope, doc, ink }));
  const [strokes, setStrokes] = useState<readonly PdfStroke[]>([]);
  const [inkStatus, setInkStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [attempt, setAttempt] = useState(0);
  const [includeInk, setIncludeInk] = useState(true);
  const [includeNotes, setIncludeNotes] = useState(true);
  const [working, setWorking] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState<TranslationKey | null>(null);
  const operation = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    readClassInk(
      inkInput.scope,
      inkInput.doc,
      inkInput.ink,
      controller.signal,
    ).then(
      (value) => {
        if (!controller.signal.aborted) {
          setStrokes(value);
          setInkStatus("ready");
        }
      },
      () => {
        if (!controller.signal.aborted) setInkStatus("error");
      },
    );
    return () => controller.abort();
  }, [attempt, inkInput]);
  useEffect(() => () => operation.current?.abort(), []);

  const close = () => {
    operation.current?.abort();
    onClose();
  };
  const run = async () => {
    if (!canDownloadOriginal || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setError(null);
    setWorking(true);
    try {
      if (source.kind === "range") setPercent(0);
      const bytes = await getStudyExportBytes(
        scope,
        doc,
        source,
        controller.signal,
        setPercent,
      );
      controller.signal.throwIfAborted();
      setPercent(null);
      const { exportStudyPdf } = await import("./pdfStudyExport");
      const blob = await exportStudyPdf({
        bytes,
        mediaType: doc.mediaType,
        canDownloadOriginal,
        labels: {
          notesTitle: t("classroomTools.files.export.appendix"),
          page: (page) => t("classroomTools.files.viewer.page", { page }),
        },
        notes: includeNotes ? notes : [],
        strokes: includeInk ? strokes : [],
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      downloadPdf(blob, doc.displayName);
      onClose();
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof RoomDocumentBytesError && cause.code === "integrity"
            ? "classroomTools.files.viewer.integrity"
            : classifyRoomDocumentError(cause) === "forbidden"
              ? "classroomTools.files.library.downloadForbidden"
              : "classroomTools.files.export.error",
        );
    } finally {
      operation.current = null;
      if (!controller.signal.aborted) {
        setWorking(false);
        setPercent(null);
      }
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        hideClose
        data-theme="dark"
        className="classroom-study-export"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onReturnFocus();
        }}
      >
        <DialogTitle>{t("classroomTools.files.export.title")}</DialogTitle>
        <DialogDescription>{doc.displayName}</DialogDescription>
        {doc.activeContent ? (
          <p>
            {t("classroomTools.files.activeContent.body", {
              name: doc.displayName,
            })}
          </p>
        ) : null}
        <label>
          <input
            type="checkbox"
            disabled={working || !strokes.length}
            checked={includeInk && strokes.length > 0}
            onChange={(event) => setIncludeInk(event.target.checked)}
          />{" "}
          {t("classroomTools.files.export.ink")}
        </label>
        <label>
          <input
            type="checkbox"
            disabled={working || !notes.length}
            checked={includeNotes && notes.length > 0}
            onChange={(event) => setIncludeNotes(event.target.checked)}
          />{" "}
          {t("classroomTools.files.export.notes")}
        </label>
        {inkStatus === "loading" || notesLoading ? (
          <p role="status">{t("classroomTools.files.export.loading")}</p>
        ) : null}
        {inkStatus === "error" ? (
          <div role="alert">
            <p>{t("classroomTools.files.export.inkError")}</p>
            <Button
              size="sm"
              variant="quiet"
              disabled={working}
              onClick={() => {
                setInkStatus("loading");
                setAttempt((n) => n + 1);
              }}
            >
              {t("state.retry")}
            </Button>
          </div>
        ) : null}
        {retryNotes ? (
          <div role="alert">
            <p>{t("classroomTools.files.export.notesError")}</p>
            <Button
              size="sm"
              variant="quiet"
              disabled={working}
              onClick={retryNotes}
            >
              {t("state.retry")}
            </Button>
          </div>
        ) : null}
        {working ? (
          <div role="status">
            {percent !== null ? (
              <>
                <p>
                  {t("classroomTools.files.viewer.downloading", { percent })}
                </p>
                <progress
                  aria-label={t("classroomTools.files.viewer.downloadProgress")}
                  value={percent}
                  max={100}
                />
              </>
            ) : (
              t("classroomTools.files.export.working")
            )}
          </div>
        ) : null}
        {error ? <p role="alert">{t(error)}</p> : null}
        <DialogFooter>
          <Button onClick={close} variant="secondary">
            {t("classroomTools.files.cancel")}
          </Button>
          <Button
            disabled={
              working ||
              inkStatus === "loading" ||
              notesLoading ||
              !canDownloadOriginal
            }
            onClick={() => void run()}
          >
            {t("classroomTools.files.export.download")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
