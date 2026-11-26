import type { TranslationKey } from "../../app/i18n";
import type { ClassroomCodeWorkspaceSnapshot } from "./codeSession";

/**
 * ROOM-TOOLS-CODE-03B: "Xuất / Nhập gói dự án (.json)" over the immutable
 * `tutorhub.code.workspace.v1` envelope (ROOM-TOOLS-CODE-03A). The envelope
 * module is loaded on demand so the Code chunk does not carry it; an import
 * is a quarantine (size, shape, unsafe keys, bounds, checksum) and its files
 * are only ever opened in the editor — never run.
 */
export const PORTABLE_FILE_SUFFIX = ".tutorhub-code.json";
/** Same cap as the envelope; refused before the file is read. */
export const PORTABLE_MAX_FILE_BYTES = 512 * 1024;

type PortableModule =
  typeof import("@tutorhub/collaboration-client/portable-code-workspace");

let portableModule: Promise<PortableModule> | null = null;

function loadPortable(): Promise<PortableModule> {
  portableModule ??=
    import("@tutorhub/collaboration-client/portable-code-workspace").catch(
      (error: unknown) => {
        portableModule = null;
        throw error;
      },
    );
  return portableModule;
}

/** ASCII file-name slug (`Bài 1: Vòng lặp` → `bai-1-vong-lap`). */
export function portableSlug(title: string): string {
  const slug = title
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/giu, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48)
    .replace(/-+$/u, "");
  return slug || "tutorhub-code";
}

export interface PortableExport {
  readonly fileName: string;
  readonly json: string;
}

export async function exportCodeProject(
  snapshot: ClassroomCodeWorkspaceSnapshot,
  title: string,
): Promise<PortableExport> {
  const { exportPortableCodeWorkspace } = await loadPortable();
  const safeTitle = [...title.replace(/\p{Cc}/gu, " ").trim()]
    .slice(0, 120)
    .join("");
  const result = await exportPortableCodeWorkspace(snapshot, {
    title: safeTitle,
  });
  return {
    fileName: `${portableSlug(safeTitle)}${PORTABLE_FILE_SUFFIX}`,
    json: result.json,
  };
}

export type PortableImportResult =
  | {
      readonly ok: true;
      readonly snapshot: ClassroomCodeWorkspaceSnapshot;
      readonly title: string;
    }
  | { readonly ok: false; readonly reason: TranslationKey };

async function readBytes(file: Blob): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") {
    return new Uint8Array(await file.arrayBuffer());
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const result = reader.result;
      if (result instanceof ArrayBuffer) resolve(new Uint8Array(result));
      else reject(new Error("read failed"));
    };
    reader.readAsArrayBuffer(file);
  });
}

function importErrorKey(code: string | null): TranslationKey {
  switch (code) {
    case "checksum_mismatch":
      return "classroomTools.portable.errorChecksum";
    case "portable_unsafe_key":
      return "classroomTools.portable.errorUnsafe";
    case "portable_format_unsupported":
      return "classroomTools.portable.errorFormat";
    case "portable_too_large":
    case "workspace_too_large":
    case "file_too_large":
    case "stdin_too_large":
    case "file_limit":
      return "classroomTools.portable.errorTooLarge";
    case "crypto_unavailable":
      return "classroomTools.portable.errorCrypto";
    default:
      return "classroomTools.portable.errorInvalid";
  }
}

/** Reads and verifies a picked file; anything unexpected is refused. */
export async function importCodeProject(
  file: Blob,
): Promise<PortableImportResult> {
  if (file.size > PORTABLE_MAX_FILE_BYTES) {
    return { ok: false, reason: "classroomTools.portable.errorTooLarge" };
  }
  if (file.size === 0) {
    return { ok: false, reason: "classroomTools.portable.errorInvalid" };
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBytes(file);
  } catch {
    return { ok: false, reason: "classroomTools.portable.errorRead" };
  }
  try {
    const { importPortableCodeWorkspace } = await loadPortable();
    const imported = await importPortableCodeWorkspace(bytes);
    return {
      ok: true,
      snapshot: {
        activeIndex: imported.snapshot.activeIndex,
        files: imported.snapshot.files.map((item) => ({
          content: item.content,
          language: item.language,
          name: item.name,
        })),
        stdin: imported.snapshot.stdin,
      },
      title: imported.title,
    };
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code: unknown }).code === "string"
        ? (error as { code: string }).code
        : null;
    return { ok: false, reason: importErrorKey(code) };
  }
}
