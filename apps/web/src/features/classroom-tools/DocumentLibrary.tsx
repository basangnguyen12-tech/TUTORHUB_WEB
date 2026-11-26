import type {
  RoomDocument,
  RoomDocumentLibraryViewerAccess,
} from "@tutorhub/api-client";
import { Button, IconButton } from "@tutorhub/ui";
import {
  AlertTriangle,
  Download,
  FileText,
  Image as ImageIcon,
  MonitorPlay,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { ClassFileTransferPhase } from "../../app/classFiles";
import { useI18n, type TranslationKey } from "../../app/i18n";
import {
  classifyRoomDocumentError,
  isRoomDocumentInFlight,
  ROOM_DOCUMENT_ACCEPT,
  roomDocumentRejectionKey,
  useRoomDocumentUpload,
  useUpdateRoomDocument,
  validateRoomDocumentFile,
  type RoomDocumentFileProblem,
  type RoomDocumentUploadScope,
} from "../../app/roomDocuments";
import { formatDocumentSize } from "./documentViewerModel";

const NO_ACCESS: RoomDocumentLibraryViewerAccess = {
  can_manage: false,
  can_present: false,
  can_upload: false,
  can_upload_to_class: false,
};

const PROBLEM_KEYS: Readonly<Record<RoomDocumentFileProblem, TranslationKey>> =
  {
    empty: "classroomTools.files.upload.problemEmpty",
    imageTooLarge: "classroomTools.files.upload.problemImageTooLarge",
    pdfTooLarge: "classroomTools.files.upload.problemPdfTooLarge",
    type: "classroomTools.files.upload.problemType",
  };

const PHASE_KEYS: Readonly<Record<ClassFileTransferPhase, TranslationKey>> = {
  checksum: "classroomTools.files.upload.phaseChecksum",
  complete: "classroomTools.files.upload.phaseComplete",
  finalizing: "classroomTools.files.upload.phaseFinalizing",
  idle: "classroomTools.files.upload.phaseIdle",
  reserving: "classroomTools.files.upload.phaseReserving",
  uploading: "classroomTools.files.upload.phaseUploading",
};

export interface DocumentLibraryQuery {
  readonly documents: readonly RoomDocument[];
  readonly error: unknown;
  readonly fetchNextPage: () => void;
  readonly hasNextPage: boolean;
  readonly isError: boolean;
  readonly isFetchingNextPage: boolean;
  readonly isPending: boolean;
  readonly refetch: () => void;
  readonly viewerAccess: RoomDocumentLibraryViewerAccess | null;
}

/**
 * ROOM-TOOLS-FILES-01B: the room / class document library. On an empty stage
 * it fills the stage; with a document open it is a slide-over (`drawer`)
 * opened from the Top Bar file key. Every action shown is a server
 * projection (`viewer_access`); the server still answers 404/403 otherwise.
 */
export function DocumentLibrary({
  activeFileID,
  mediaSpaceID,
  mode,
  onClose,
  onDownload,
  onOpen,
  onPresent,
  presentingFileID = null,
  presentPending = false,
  query,
  tenantID,
}: {
  readonly activeFileID: string | null;
  readonly mediaSpaceID: string;
  readonly mode: "drawer" | "stage";
  readonly onClose?: () => void;
  readonly onDownload: (document: RoomDocument) => void;
  readonly onOpen: (document: RoomDocument) => void;
  /** ROOM-TOOLS-FILES-02B: "Trình chiếu cho lớp" (presenters only). */
  readonly onPresent?: (document: RoomDocument) => void;
  readonly presentingFileID?: string | null;
  readonly presentPending?: boolean;
  readonly query: DocumentLibraryQuery;
  readonly tenantID: string;
}) {
  const { language, t } = useI18n();
  const titleID = useId();
  const rootRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const access = query.viewerAccess ?? NO_ACCESS;
  const [uploadOpen, setUploadOpen] = useState(false);
  const locale = language === "vi" ? "vi-VN" : "en-US";

  // A drawer takes focus on open (its heading) and gives it back on close.
  useEffect(() => {
    if (mode !== "drawer") return undefined;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    headingRef.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [mode]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || mode !== "drawer") return;
    event.preventDefault();
    event.stopPropagation();
    onClose?.();
  };

  let body;
  if (query.isPending) {
    body = (
      <div className="classroom-files-state" role="status">
        <span aria-hidden="true" className="classroom-code-state__spinner" />
        <p>{t("classroomTools.files.library.loading")}</p>
      </div>
    );
  } else if (query.isError) {
    const kind = classifyRoomDocumentError(query.error);
    body = (
      <div className="classroom-files-state" role="alert">
        <p className="classroom-files-state__title">
          {kind === "featureOff"
            ? t("classroomTools.files.featureOff")
            : kind === "forbidden"
              ? t("classroomTools.files.library.forbidden")
              : t("classroomTools.files.library.error")}
        </p>
        {kind === "forbidden" || kind === "featureOff" ? null : (
          <Button
            leadingIcon={<RefreshCw />}
            onClick={() => query.refetch()}
            size="sm"
            variant="secondary"
          >
            {t("state.retry")}
          </Button>
        )}
      </div>
    );
  } else if (query.documents.length === 0) {
    body = (
      <div className="classroom-files-state" role="status">
        <FileText aria-hidden="true" className="classroom-files-state__icon" />
        <p className="classroom-files-state__title">
          {t("classroomTools.files.library.emptyTitle")}
        </p>
        <p>
          {access.can_upload
            ? t("classroomTools.files.library.emptyUploader")
            : t("classroomTools.files.library.emptyViewer")}
        </p>
      </div>
    );
  } else {
    body = (
      <>
        <ul
          aria-label={t("classroomTools.files.library.listLabel")}
          className="classroom-files-library__list"
        >
          {query.documents.map((document) => (
            <DocumentRow
              active={document.id === activeFileID}
              document={document}
              key={document.id}
              locale={locale}
              mediaSpaceID={mediaSpaceID}
              onDownload={onDownload}
              onOpen={onOpen}
              onPresent={onPresent}
              presenting={document.id === presentingFileID}
              presentPending={presentPending}
              tenantID={tenantID}
            />
          ))}
        </ul>
        {query.hasNextPage ? (
          <Button
            disabled={query.isFetchingNextPage}
            onClick={() => query.fetchNextPage()}
            size="sm"
            variant="secondary"
          >
            {t("classroomTools.files.library.loadMore")}
          </Button>
        ) : null}
      </>
    );
  }

  const showUpload =
    access.can_upload &&
    (uploadOpen || (!query.isPending && query.documents.length === 0));

  return (
    <section
      aria-labelledby={titleID}
      className={`classroom-files-library classroom-files-library--${mode}`}
      onKeyDown={handleKeyDown}
      ref={rootRef}
    >
      <header className="classroom-files-library__header">
        <div>
          <h3
            className="classroom-files-library__title"
            id={titleID}
            ref={headingRef}
            tabIndex={-1}
          >
            {t("classroomTools.files.library.title")}
          </h3>
          <p className="classroom-files-library__subtitle">
            {t("classroomTools.files.library.subtitle")}
          </p>
        </div>
        <div className="classroom-files-library__header-actions">
          {access.can_upload ? (
            <Button
              aria-expanded={showUpload}
              leadingIcon={<Upload />}
              onClick={() => setUploadOpen((value) => !value)}
              size="sm"
            >
              {t("classroomTools.files.upload.open")}
            </Button>
          ) : null}
          {mode === "drawer" ? (
            <IconButton
              className="classroom-files-library__close"
              label={t("classroomTools.files.library.close")}
              onClick={onClose}
              size="sm"
              variant="quiet"
            >
              <X />
            </IconButton>
          ) : null}
        </div>
      </header>
      {showUpload ? (
        <DocumentUploadPanel
          canUploadToClass={access.can_upload_to_class}
          mediaSpaceID={mediaSpaceID}
          tenantID={tenantID}
        />
      ) : null}
      <div className="classroom-files-library__body">{body}</div>
    </section>
  );
}

function DocumentRow({
  active,
  document,
  locale,
  mediaSpaceID,
  onDownload,
  onOpen,
  onPresent,
  presenting,
  presentPending,
  tenantID,
}: {
  readonly active: boolean;
  readonly document: RoomDocument;
  readonly locale: string;
  readonly mediaSpaceID: string;
  readonly onDownload: (document: RoomDocument) => void;
  readonly onOpen: (document: RoomDocument) => void;
  readonly onPresent?: (document: RoomDocument) => void;
  readonly presenting: boolean;
  readonly presentPending: boolean;
  readonly tenantID: string;
}) {
  const { t } = useI18n();
  const update = useUpdateRoomDocument(tenantID, mediaSpaceID);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const switchID = useId();
  const ready = document.status === "ready";
  const openable = ready && document.viewer_access.can_view;
  const isPDF = document.declared_media_type === "application/pdf";
  const kind = isPDF
    ? document.page_count
      ? t("classroomTools.files.library.kindPdfPages", {
          count: document.page_count,
        })
      : t("classroomTools.files.library.kindPdf")
    : t("classroomTools.files.library.kindImage");
  const source =
    document.owner_kind === "class"
      ? t("classroomTools.files.library.sourceClass")
      : t("classroomTools.files.library.sourceRoom");

  useEffect(() => {
    if (confirmingDelete) confirmRef.current?.focus();
  }, [confirmingDelete]);

  let status = null;
  if (isRoomDocumentInFlight(document)) {
    status = (
      <p className="classroom-files-row__status" role="status">
        <span aria-hidden="true" className="classroom-files-row__spinner" />
        {document.status === "pending"
          ? t("classroomTools.files.status.pending")
          : t("classroomTools.files.status.processing")}
      </p>
    );
  } else if (document.status === "rejected") {
    status = (
      <p className="classroom-files-row__status classroom-files-row__status--rejected">
        <AlertTriangle aria-hidden="true" />
        {t("classroomTools.files.status.rejected")}{" "}
        {t(roomDocumentRejectionKey(document.rejection_reason))}
      </p>
    );
  }

  return (
    <li
      className={`classroom-files-row${active ? " classroom-files-row--active" : ""}`}
      data-status={document.status}
    >
      <span aria-hidden="true" className="classroom-files-row__icon">
        {isPDF ? <FileText /> : <ImageIcon />}
      </span>
      <div className="classroom-files-row__main">
        {openable ? (
          <button
            aria-current={active ? "true" : undefined}
            className="classroom-files-row__title classroom-files-row__title--button"
            onClick={() => onOpen(document)}
            type="button"
          >
            {document.display_name}
          </button>
        ) : (
          <span className="classroom-files-row__title">
            {document.display_name}
          </span>
        )}
        <p className="classroom-files-row__meta">
          <span
            className={`classroom-files-badge classroom-files-badge--${document.owner_kind}`}
          >
            {source}
          </span>
          <span>{kind}</span>
          <span>
            {formatDocumentSize(document.expected_size_bytes, locale)}
          </span>
          {presenting ? (
            <span className="classroom-files-badge classroom-files-badge--live">
              <MonitorPlay aria-hidden="true" />
              {t("classroomTools.files.present.presentingBadge")}
            </span>
          ) : null}
          {document.active_content ? (
            <span className="classroom-files-badge classroom-files-badge--warning">
              <AlertTriangle aria-hidden="true" />
              {t("classroomTools.files.library.activeContent")}
            </span>
          ) : null}
        </p>
        {status}
        {document.viewer_access.can_manage && ready ? (
          <label className="classroom-files-row__switch" htmlFor={switchID}>
            <input
              checked={document.allow_student_download}
              disabled={update.isPending}
              id={switchID}
              onChange={(event) =>
                update.mutate({
                  document,
                  patch: { allowStudentDownload: event.target.checked },
                })
              }
              role="switch"
              type="checkbox"
            />
            {t("classroomTools.files.library.allowStudentDownload")}
          </label>
        ) : null}
        {update.isError ? (
          <p className="classroom-files-row__error" role="alert">
            {classifyRoomDocumentError(update.error) === "conflict"
              ? t("classroomTools.files.library.conflict")
              : t("classroomTools.files.library.updateFailed")}
          </p>
        ) : null}
        {confirmingDelete ? (
          <div
            aria-label={t("classroomTools.files.library.deleteConfirmLabel", {
              name: document.display_name,
            })}
            className="classroom-files-row__confirm"
            role="group"
          >
            <p>{t("classroomTools.files.library.deleteConfirm")}</p>
            <Button
              disabled={update.isPending}
              onClick={() =>
                update.mutate(
                  { document, patch: { deleted: true } },
                  { onSettled: () => setConfirmingDelete(false) },
                )
              }
              ref={confirmRef}
              size="sm"
              variant="danger"
            >
              {t("classroomTools.files.library.deleteAction")}
            </Button>
            <Button
              onClick={() => {
                setConfirmingDelete(false);
                deleteButtonRef.current?.focus();
              }}
              size="sm"
              variant="secondary"
            >
              {t("classroomTools.files.cancel")}
            </Button>
          </div>
        ) : null}
      </div>
      <div className="classroom-files-row__actions">
        {openable && onPresent && !presenting ? (
          <Button
            aria-label={t("classroomTools.files.present.presentNamed", {
              name: document.display_name,
            })}
            className="classroom-files-row__present"
            disabled={presentPending}
            leadingIcon={<MonitorPlay />}
            onClick={() => onPresent(document)}
            size="sm"
            variant="secondary"
          >
            {t("classroomTools.files.present.present")}
          </Button>
        ) : null}
        {openable ? (
          <Button
            aria-label={t("classroomTools.files.library.openNamed", {
              name: document.display_name,
            })}
            onClick={() => onOpen(document)}
            size="sm"
            variant={active ? "secondary" : "primary"}
          >
            {t("classroomTools.files.library.open")}
          </Button>
        ) : null}
        {ready && document.viewer_access.can_download_original ? (
          <IconButton
            label={t("classroomTools.files.library.downloadNamed", {
              name: document.display_name,
            })}
            onClick={() => onDownload(document)}
            size="sm"
            variant="quiet"
          >
            <Download />
          </IconButton>
        ) : null}
        {document.viewer_access.can_manage ? (
          <IconButton
            label={t("classroomTools.files.library.deleteNamed", {
              name: document.display_name,
            })}
            onClick={() => setConfirmingDelete(true)}
            ref={deleteButtonRef}
            size="sm"
            variant="quiet"
          >
            <Trash2 />
          </IconButton>
        ) : null}
      </div>
    </li>
  );
}

function DocumentUploadPanel({
  canUploadToClass,
  mediaSpaceID,
  tenantID,
}: {
  readonly canUploadToClass: boolean;
  readonly mediaSpaceID: string;
  readonly tenantID: string;
}) {
  const { t } = useI18n();
  const upload = useRoomDocumentUpload(tenantID, mediaSpaceID);
  const inputID = useId();
  const hintID = useId();
  const [scope, setScope] = useState<RoomDocumentUploadScope>("media_space");
  const [allowDownload, setAllowDownload] = useState<boolean | null>(null);
  const [problem, setProblem] = useState<RoomDocumentFileProblem | null>(null);
  const [dragging, setDragging] = useState(false);
  const [lastFile, setLastFile] = useState<{
    file: File;
    requestID: string;
  } | null>(null);
  // Server defaults: room-only files stay view-only for students, class
  // files are downloadable, until the uploader chooses otherwise.
  const allowStudentDownload = allowDownload ?? scope === "class";

  const start = (file: File, requestID: string) => {
    const checked = validateRoomDocumentFile(file);
    if (checked.problem !== null) {
      setProblem(checked.problem);
      return;
    }
    setProblem(null);
    setLastFile({ file, requestID });
    upload.mutate({
      allowStudentDownload,
      clientRequestID: requestID,
      file,
      scope: canUploadToClass ? scope : "media_space",
    });
  };

  const pick = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    start(file, crypto.randomUUID());
  };

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (upload.isPending) return;
    pick(event.dataTransfer.files);
  };

  const phase = upload.progress.phase;
  const busy = upload.isPending;
  return (
    <div className="classroom-files-upload">
      <div
        className={`classroom-files-dropzone${dragging ? " classroom-files-dropzone--active" : ""}`}
        data-testid="classroom-files-dropzone"
        onDragLeave={() => setDragging(false)}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDrop={handleDrop}
      >
        <Upload aria-hidden="true" className="classroom-files-dropzone__icon" />
        <p id={hintID}>{t("classroomTools.files.upload.hint")}</p>
        <input
          accept={ROOM_DOCUMENT_ACCEPT}
          aria-describedby={hintID}
          className="classroom-files-upload__input"
          disabled={busy}
          id={inputID}
          onChange={(event) => {
            pick(event.target.files);
            event.target.value = "";
          }}
          type="file"
        />
        <label
          aria-disabled={busy || undefined}
          className="classroom-files-upload__choose"
          htmlFor={inputID}
        >
          {t("classroomTools.files.upload.choose")}
        </label>
      </div>
      {canUploadToClass ? (
        <fieldset className="classroom-files-upload__scope" disabled={busy}>
          <legend>{t("classroomTools.files.upload.scopeLegend")}</legend>
          <label>
            <input
              checked={scope === "media_space"}
              name={`${inputID}-scope`}
              onChange={() => setScope("media_space")}
              type="radio"
            />
            {t("classroomTools.files.upload.scopeRoom")}
          </label>
          <label>
            <input
              checked={scope === "class"}
              name={`${inputID}-scope`}
              onChange={() => setScope("class")}
              type="radio"
            />
            {t("classroomTools.files.upload.scopeClass")}
          </label>
        </fieldset>
      ) : null}
      <label className="classroom-files-row__switch">
        <input
          checked={allowStudentDownload}
          disabled={busy}
          onChange={(event) => setAllowDownload(event.target.checked)}
          role="switch"
          type="checkbox"
        />
        {t("classroomTools.files.upload.allowStudentDownload")}
      </label>
      {problem ? (
        <p className="classroom-files-upload__error" role="alert">
          {t(PROBLEM_KEYS[problem])}
        </p>
      ) : null}
      {phase !== "idle" ? (
        <div className="classroom-files-upload__progress">
          <p aria-live="polite" role="status">
            {t(PHASE_KEYS[phase])}
            {phase === "uploading" ? ` ${upload.progress.percent}%` : ""}
          </p>
          <progress
            aria-label={t("classroomTools.files.upload.progressLabel")}
            max={100}
            value={phase === "checksum" ? undefined : upload.progress.percent}
          />
        </div>
      ) : null}
      {upload.isError ? (
        <div className="classroom-files-upload__error" role="alert">
          <p>
            {classifyRoomDocumentError(upload.error) === "forbidden"
              ? t("classroomTools.files.upload.forbidden")
              : classifyRoomDocumentError(upload.error) === "rateLimited"
                ? t("classroomTools.files.upload.rateLimited")
                : t("classroomTools.files.upload.failed")}
          </p>
          {lastFile ? (
            <Button
              leadingIcon={<RefreshCw />}
              onClick={() => start(lastFile.file, lastFile.requestID)}
              size="sm"
              variant="secondary"
            >
              {t("state.retry")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
