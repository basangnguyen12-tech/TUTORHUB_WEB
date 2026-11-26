/* eslint-disable react-refresh/only-export-components -- The pure file-type classifiers are intentionally colocated with the icon they drive (one shared contract for the class page, the library and the Top Bar). */
import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
  type LucideIcon,
} from "lucide-react";
import "./FileTypeIcon.css";

/**
 * ROOM-UI-POLISH-01: one colour-coded file glyph shared by the class files
 * page (light), the classroom document library and the Top Bar file key
 * (dark Liquid Glass). The icon is decorative: the file name next to it is
 * the accessible text.
 */
export type FileVisualKind =
  | "archive"
  | "audio"
  | "code"
  | "excel"
  | "generic"
  | "image"
  | "pdf"
  | "powerpoint"
  | "video"
  | "word";

const EXTENSION_KINDS: Readonly<Record<string, FileVisualKind>> = {
  "7z": "archive",
  aac: "audio",
  avi: "video",
  bmp: "image",
  c: "code",
  cpp: "code",
  css: "code",
  csv: "excel",
  doc: "word",
  docx: "word",
  flac: "audio",
  gif: "image",
  gz: "archive",
  h: "code",
  heic: "image",
  html: "code",
  java: "code",
  jpeg: "image",
  jpg: "image",
  js: "code",
  json: "code",
  jsx: "code",
  m4a: "audio",
  md: "code",
  mkv: "video",
  mov: "video",
  mp3: "audio",
  mp4: "video",
  odp: "powerpoint",
  ods: "excel",
  odt: "word",
  ogg: "audio",
  pdf: "pdf",
  png: "image",
  ppt: "powerpoint",
  pptx: "powerpoint",
  py: "code",
  rar: "archive",
  rtf: "word",
  sh: "code",
  sql: "code",
  svg: "image",
  tar: "archive",
  ts: "code",
  tsx: "code",
  txt: "code",
  wav: "audio",
  webm: "video",
  webp: "image",
  xls: "excel",
  xlsx: "excel",
  zip: "archive",
};

const BADGES: Partial<Record<FileVisualKind, string>> = {
  excel: "XLS",
  pdf: "PDF",
  powerpoint: "PPT",
  word: "DOC",
};

const GLYPHS: Readonly<Record<FileVisualKind, LucideIcon>> = {
  archive: FileArchive,
  audio: FileAudio,
  code: FileCode,
  excel: FileSpreadsheet,
  generic: File,
  image: FileImage,
  pdf: FileText,
  powerpoint: Presentation,
  video: FileVideo,
  word: FileText,
};

/** The lower-case extension of a file name (`""` when there is none). */
export function fileExtension(fileName: string): string {
  const base = fileName.trim().split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  const extension = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(extension) ? extension : "";
}

function kindFromMediaType(mediaType: string): FileVisualKind | null {
  const type = mediaType.trim().toLowerCase().split(";")[0] ?? "";
  if (type === "" || type === "application/octet-stream") return null;
  if (type === "application/pdf") return "pdf";
  if (
    type.includes("wordprocessingml") ||
    type === "application/msword" ||
    type === "application/rtf" ||
    type === "text/rtf" ||
    type === "application/vnd.oasis.opendocument.text"
  ) {
    return "word";
  }
  if (
    type.includes("spreadsheetml") ||
    type.includes("ms-excel") ||
    type === "text/csv" ||
    type === "application/vnd.oasis.opendocument.spreadsheet"
  ) {
    return "excel";
  }
  if (
    type.includes("presentationml") ||
    type.includes("ms-powerpoint") ||
    type === "application/vnd.oasis.opendocument.presentation"
  ) {
    return "powerpoint";
  }
  if (
    type === "application/zip" ||
    type === "application/x-zip-compressed" ||
    type === "application/gzip" ||
    type === "application/x-tar" ||
    type === "application/x-7z-compressed" ||
    type === "application/vnd.rar" ||
    type === "application/x-rar-compressed"
  ) {
    return "archive";
  }
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/javascript" ||
    type === "application/sql"
  ) {
    return "code";
  }
  return null;
}

/**
 * Pure classifier: the declared media type wins when it is specific, the
 * file name extension decides otherwise. Both are matched case-insensitively.
 */
export function resolveFileVisualKind(
  fileName: string,
  mediaType?: string | null,
): FileVisualKind {
  const fromType = mediaType ? kindFromMediaType(mediaType) : null;
  const fromName = EXTENSION_KINDS[fileExtension(fileName)] ?? null;
  // A generic text/* type for a known office or archive name keeps the name.
  if (fromType === "code" && fromName && fromName !== "code") return fromName;
  return fromType ?? fromName ?? "generic";
}

/** The short badge printed on the tile (`PDF`, `DOC`, `XLS`/`CSV`, `PPT`). */
export function fileBadgeLabel(
  fileName: string,
  mediaType?: string | null,
): string | null {
  const kind = resolveFileVisualKind(fileName, mediaType);
  if (
    kind === "excel" &&
    (fileExtension(fileName) === "csv" ||
      mediaType?.trim().toLowerCase().startsWith("text/csv"))
  ) {
    return "CSV";
  }
  return BADGES[kind] ?? null;
}

/**
 * A friendly format name for metadata lines (`PDF`, `DOCX`, `PNG`), never a
 * raw MIME string. `null` when nothing short and meaningful is known.
 */
export function fileFormatLabel(
  fileName: string,
  mediaType?: string | null,
): string | null {
  const extension = fileExtension(fileName);
  if (extension) return extension.toUpperCase();
  const type = mediaType?.trim().toLowerCase().split(";")[0] ?? "";
  if (type === "application/pdf") return "PDF";
  const subtype = /^(?:image|audio|video)\/([a-z0-9]{1,5})$/.exec(type)?.[1];
  if (subtype) return subtype === "jpeg" ? "JPG" : subtype.toUpperCase();
  return fileBadgeLabel(fileName, mediaType);
}

export function FileTypeIcon({
  className,
  fileName,
  mediaType,
  size = "md",
}: {
  readonly className?: string;
  readonly fileName: string;
  readonly mediaType?: string | null;
  readonly size?: "md" | "sm";
}) {
  const kind = resolveFileVisualKind(fileName, mediaType);
  const Glyph = GLYPHS[kind];
  const badge = size === "md" ? fileBadgeLabel(fileName, mediaType) : null;
  return (
    <span
      aria-hidden="true"
      className={`file-type-icon file-type-icon--${size}${
        className ? ` ${className}` : ""
      }`}
      data-file-kind={kind}
    >
      <Glyph className="file-type-icon__glyph" focusable="false" />
      {badge ? <span className="file-type-icon__badge">{badge}</span> : null}
    </span>
  );
}
