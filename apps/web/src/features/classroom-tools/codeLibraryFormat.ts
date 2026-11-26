import type { CodeLibraryErrorKind } from "../../app/codeLibrary";
import type { TranslationKey } from "../../app/i18n";

/** ROOM-TOOLS-CODE-03B: shared wording helpers for the library panels. */
export function formatCodeBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export function libraryErrorKey(kind: CodeLibraryErrorKind): TranslationKey {
  switch (kind) {
    case "snippet_quota":
      return "classroomTools.library.errorSnippetQuota";
    case "storage_quota":
      return "classroomTools.library.errorStorageQuota";
    case "version_conflict":
      return "classroomTools.library.errorConflict";
    case "forbidden":
      return "classroomTools.library.errorForbidden";
    case "not_found":
      return "classroomTools.library.errorNotFound";
    case "invalid":
      return "classroomTools.library.errorInvalid";
    case "too_large":
      return "classroomTools.library.errorTooLarge";
    case "feature_off":
      return "classroomTools.library.featureOff";
    default:
      return "classroomTools.library.errorFailed";
  }
}
