import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  APIRequestError,
  completeFileMultipartUpload,
  createFileMultipartUpload,
  createRoomDocumentUploadIntent,
  finalizeFileUpload,
  issueFileDownloadCapability,
  issueFileMultipartPartCapability,
  issueFileUploadCapability,
  issueRoomDocumentViewCapability,
  listRoomDocuments,
  rotateCSRFToken,
  updateRoomDocument,
  type ContentFileRejectionReason,
  type RoomDocument,
  type RoomDocumentMediaType,
  type RoomDocumentPage,
  type RoomDocumentViewCapability,
} from "@tutorhub/api-client";
import { useState } from "react";
import {
  getApiBaseUrl,
  multipartPartBytes,
  multipartThresholdBytes,
  putFileWithProgress,
  putMultipartPartWithProgress,
  sha256Hex,
  type ClassFileTransferProgress,
} from "./classFiles";
import type { TranslationKey } from "./i18n";

/**
 * ROOM-TOOLS-FILES-01B (ADR-0045 §2–§3): the classroom Documents tool's room
 * library. Everything here is tenant-asserted and fail-closed: the server
 * decides who may list, upload, view, manage or download; view capabilities
 * are short-lived bearer URLs that are never logged, cached, persisted or
 * shared, and document bytes are fetched without cookies or a referrer.
 */
export const ROOM_DOCUMENT_PDF_MAX_BYTES = 52_428_800;
export const ROOM_DOCUMENT_IMAGE_MAX_BYTES = 10_485_760;
/** ADR-0045 §3: Slice 1 fetches whole files up to 30 MiB (Range is Slice 2). */
export const ROOM_DOCUMENT_VIEWER_MAX_FETCH_BYTES = 31_457_280;
/** Rows still being checked by the P3-10-PDF/Image verifier poll this fast. */
export const ROOM_DOCUMENT_PROCESSING_POLL_MS = 2_500;
const roomDocumentPageSize = 50;

export const ROOM_DOCUMENT_ACCEPT =
  ".pdf,application/pdf,image/png,image/jpeg,image/webp";

export const roomDocumentQueryKeys = {
  all: ["room-documents"] as const,
  list: (tenantID: string, mediaSpaceID: string) =>
    ["room-documents", tenantID, mediaSpaceID] as const,
};

export type RoomDocumentFileProblem =
  "empty" | "imageTooLarge" | "pdfTooLarge" | "type";

/** The viewer-supported media type of a picked file (extension fallback). */
export function roomDocumentMediaType(file: {
  readonly name: string;
  readonly type: string;
}): RoomDocumentMediaType | null {
  const type = file.type.toLowerCase();
  if (
    type === "application/pdf" ||
    type === "image/png" ||
    type === "image/jpeg" ||
    type === "image/webp"
  ) {
    return type;
  }
  if (type !== "" && type !== "application/octet-stream") return null;
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  if (extension === "pdf") return "application/pdf";
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  return null;
}

/** Early client check (the server re-validates and verifies every byte). */
export function validateRoomDocumentFile(file: {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}):
  | { readonly mediaType: RoomDocumentMediaType; readonly problem: null }
  | { readonly mediaType: null; readonly problem: RoomDocumentFileProblem } {
  const mediaType = roomDocumentMediaType(file);
  if (mediaType === null) return { mediaType: null, problem: "type" };
  if (file.size <= 0) return { mediaType: null, problem: "empty" };
  if (mediaType === "application/pdf") {
    return file.size > ROOM_DOCUMENT_PDF_MAX_BYTES
      ? { mediaType: null, problem: "pdfTooLarge" }
      : { mediaType, problem: null };
  }
  return file.size > ROOM_DOCUMENT_IMAGE_MAX_BYTES
    ? { mediaType: null, problem: "imageTooLarge" }
    : { mediaType, problem: null };
}

export function isRoomDocumentInFlight(document: RoomDocument): boolean {
  return (
    document.status === "pending" ||
    document.status === "uploaded" ||
    document.status === "processing"
  );
}

export function roomDocumentsInFlight(
  data: InfiniteData<RoomDocumentPage> | undefined,
): boolean {
  return Boolean(
    data?.pages.some((page) => page.items.some(isRoomDocumentInFlight)),
  );
}

const REJECTION_KEYS: Readonly<
  Record<ContentFileRejectionReason, TranslationKey>
> = {
  checksum_mismatch: "classroomTools.files.rejected.checksum_mismatch",
  file_too_large_for_viewer:
    "classroomTools.files.rejected.file_too_large_for_viewer",
  image_dimensions_exceeded:
    "classroomTools.files.rejected.image_dimensions_exceeded",
  image_invalid: "classroomTools.files.rejected.image_invalid",
  media_type_mismatch: "classroomTools.files.rejected.media_type_mismatch",
  pdf_encrypted: "classroomTools.files.rejected.pdf_encrypted",
  pdf_invalid: "classroomTools.files.rejected.pdf_invalid",
  pdf_too_many_pages: "classroomTools.files.rejected.pdf_too_many_pages",
};

/** A friendly bilingual reason for a rejected row (unknown → generic). */
export function roomDocumentRejectionKey(
  reason: string | null | undefined,
): TranslationKey {
  return reason && Object.hasOwn(REJECTION_KEYS, reason)
    ? REJECTION_KEYS[reason as ContentFileRejectionReason]
    : "classroomTools.files.rejected.unknown";
}

export type RoomDocumentErrorKind =
  "conflict" | "error" | "featureOff" | "forbidden" | "rateLimited";

/** Uniform 404/403/401 → forbidden (concealment), 503 → feature off. */
export function classifyRoomDocumentError(
  error: unknown,
): RoomDocumentErrorKind {
  if (error instanceof APIRequestError) {
    if (error.status === 503) return "featureOff";
    if ([401, 403, 404].includes(error.status)) return "forbidden";
    if (error.status === 409 || error.status === 412) return "conflict";
    if (error.status === 429) return "rateLimited";
  }
  return "error";
}

function shouldRetryRoomDocumentQuery(failureCount: number, error: Error) {
  return (
    failureCount < 1 &&
    !(
      error instanceof APIRequestError &&
      error.status >= 400 &&
      error.status < 500
    )
  );
}

export function useRoomDocuments(
  tenantID: string,
  mediaSpaceID: string,
  enabled: boolean,
) {
  return useInfiniteQuery({
    enabled: enabled && Boolean(tenantID && mediaSpaceID),
    getNextPageParam: (lastPage: RoomDocumentPage) =>
      lastPage.next_cursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      listRoomDocuments(
        tenantID,
        mediaSpaceID,
        { cursor: pageParam, limit: roomDocumentPageSize },
        { baseUrl: getApiBaseUrl(), signal },
      ),
    queryKey: roomDocumentQueryKeys.list(tenantID, mediaSpaceID),
    refetchInterval: (query) =>
      roomDocumentsInFlight(query.state.data)
        ? ROOM_DOCUMENT_PROCESSING_POLL_MS
        : false,
    retry: shouldRetryRoomDocumentQuery,
    staleTime: 10_000,
  });
}

export type RoomDocumentUploadScope = "class" | "media_space";

export interface RoomDocumentUploadInput {
  readonly allowStudentDownload: boolean;
  readonly clientRequestID: string;
  readonly file: File;
  readonly scope: RoomDocumentUploadScope;
}

/**
 * Upload pipeline shared with Class Files (`classFiles.ts`): SHA-256 in a
 * worker → room upload intent → single PUT (< 10 MB) or 8 MB multipart parts
 * (≥ 10 MB) to version-bound presigned URLs → finalize (the server then runs
 * the P3-10-PDF/Image verifier; the row turns `ready` or `rejected`).
 */
export function useRoomDocumentUpload(tenantID: string, mediaSpaceID: string) {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<ClassFileTransferProgress>({
    percent: 0,
    phase: "idle",
  });
  const mutation = useMutation({
    mutationFn: async (input: RoomDocumentUploadInput) => {
      const checked = validateRoomDocumentFile(input.file);
      if (checked.problem !== null) {
        throw new Error(`room_document_${checked.problem}`);
      }
      const options = { baseUrl: getApiBaseUrl() };
      const { file } = input;
      setProgress({ percent: 0, phase: "checksum" });
      const checksum = await sha256Hex(file);
      setProgress({ percent: 0, phase: "reserving" });
      let csrf = await rotateCSRFToken(options);
      const intent = await createRoomDocumentUploadIntent(
        tenantID,
        mediaSpaceID,
        {
          allow_student_download: input.allowStudentDownload,
          checksum_sha256: checksum,
          client_request_id: input.clientRequestID,
          declared_media_type: checked.mediaType,
          display_name: file.name,
          expected_size_bytes: file.size,
          scope: input.scope,
        },
        csrf.csrf_token,
        options,
      );
      let storageVersionID: string;
      if (file.size < multipartThresholdBytes) {
        csrf = await rotateCSRFToken(options);
        const capability = await issueFileUploadCapability(
          tenantID,
          intent.id,
          { expected_version: intent.version },
          csrf.csrf_token,
          options,
        );
        setProgress({ percent: 0, phase: "uploading" });
        storageVersionID = await putFileWithProgress(
          capability,
          file,
          (percent) => setProgress({ percent, phase: "uploading" }),
        );
      } else {
        csrf = await rotateCSRFToken(options);
        const multipart = await createFileMultipartUpload(
          tenantID,
          intent.id,
          { expected_version: intent.version },
          csrf.csrf_token,
          options,
        );
        setProgress({ percent: 0, phase: "uploading" });
        const parts: { etag: string; part_number: number }[] = [];
        const partCount = Math.ceil(file.size / multipartPartBytes);
        let completedBytes = 0;
        for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
          const start = (partNumber - 1) * multipartPartBytes;
          const part = file.slice(
            start,
            Math.min(start + multipartPartBytes, file.size),
          );
          csrf = await rotateCSRFToken(options);
          const capability = await issueFileMultipartPartCapability(
            tenantID,
            intent.id,
            multipart.id,
            partNumber,
            {
              content_length_bytes: part.size,
              expected_version: intent.version,
            },
            csrf.csrf_token,
            options,
          );
          const before = completedBytes;
          const etag = await putMultipartPartWithProgress(
            capability,
            part,
            (loaded) =>
              setProgress({
                percent: Math.min(
                  100,
                  Math.round(((before + loaded) / file.size) * 100),
                ),
                phase: "uploading",
              }),
          );
          parts.push({ etag, part_number: partNumber });
          completedBytes += part.size;
        }
        csrf = await rotateCSRFToken(options);
        const completed = await completeFileMultipartUpload(
          tenantID,
          intent.id,
          multipart.id,
          { expected_version: intent.version, parts },
          csrf.csrf_token,
          options,
        );
        storageVersionID = completed.storage_version_id;
      }
      setProgress({ percent: 100, phase: "finalizing" });
      csrf = await rotateCSRFToken(options);
      return finalizeFileUpload(
        tenantID,
        intent.id,
        {
          expected_version: intent.version,
          storage_version_id: storageVersionID,
        },
        csrf.csrf_token,
        options,
      );
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: roomDocumentQueryKeys.list(tenantID, mediaSpaceID),
      });
    },
    onSuccess: () => setProgress({ percent: 100, phase: "complete" }),
    retry: false,
  });
  return {
    ...mutation,
    progress,
    resetTransfer: () => {
      mutation.reset();
      setProgress({ percent: 0, phase: "idle" });
    },
  };
}

export interface RoomDocumentPatch {
  readonly allowStudentDownload?: boolean;
  readonly deleted?: true;
}

export function useUpdateRoomDocument(tenantID: string, mediaSpaceID: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      document,
      patch,
    }: {
      document: RoomDocument;
      patch: RoomDocumentPatch;
    }) => {
      const options = { baseUrl: getApiBaseUrl() };
      const csrf = await rotateCSRFToken(options);
      return updateRoomDocument(
        tenantID,
        mediaSpaceID,
        document.id,
        {
          expected_version: document.version,
          ...(patch.allowStudentDownload === undefined
            ? {}
            : { allow_student_download: patch.allowStudentDownload }),
          ...(patch.deleted ? { deleted: true as const } : {}),
        },
        csrf.csrf_token,
        options,
      );
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: roomDocumentQueryKeys.list(tenantID, mediaSpaceID),
      });
    },
    retry: false,
  });
}

/** "Tải bản gốc": a raw download capability, only when the server allows it. */
export function useRoomDocumentDownload(tenantID: string) {
  return useMutation({
    mutationFn: async (document: RoomDocument) => {
      if (!document.viewer_access.can_download_original) {
        throw new Error("room_document_download_forbidden");
      }
      const options = { baseUrl: getApiBaseUrl() };
      const csrf = await rotateCSRFToken(options);
      const capability = await issueFileDownloadCapability(
        tenantID,
        document.id,
        csrf.csrf_token,
        options,
      );
      const anchor = globalThis.document.createElement("a");
      anchor.href = capability.url;
      anchor.download = document.display_name;
      anchor.rel = "noreferrer noopener";
      anchor.referrerPolicy = "no-referrer";
      globalThis.document.body.append(anchor);
      anchor.click();
      anchor.remove();
      return document.id;
    },
    retry: false,
  });
}

/** A fresh, version-bound view capability (TTL ≤ 5 minutes). */
export async function requestRoomDocumentView(
  tenantID: string,
  mediaSpaceID: string,
  fileID: string,
  signal?: AbortSignal,
): Promise<RoomDocumentViewCapability> {
  const options = { baseUrl: getApiBaseUrl(), signal };
  const csrf = await rotateCSRFToken(options);
  return issueRoomDocumentViewCapability(
    tenantID,
    mediaSpaceID,
    fileID,
    csrf.csrf_token,
    options,
  );
}

/** Check the current server-side download policy even when the viewer has cached bytes. */
export async function authorizeRoomStudyExport(
  tenantID: string,
  fileID: string,
  signal: AbortSignal,
) {
  const options = { baseUrl: getApiBaseUrl(), signal };
  const csrf = await rotateCSRFToken(options);
  await issueFileDownloadCapability(tenantID, fileID, csrf.csrf_token, options);
}

export class RoomDocumentBytesError extends Error {
  constructor(
    readonly code: "integrity" | "network" | "tooLarge" | "unavailable",
  ) {
    super(`room_document_bytes_${code}`);
    this.name = "RoomDocumentBytesError";
  }
}

async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Fetches the exact object version into memory only: no cookies, no
 * referrer, no HTTP cache. The byte count and SHA-256 must match the
 * capability before anything is handed to the PDF engine.
 */
export async function fetchRoomDocumentBytes(
  capability: Pick<
    RoomDocumentViewCapability,
    "content_length_bytes" | "sha256" | "url"
  >,
  options: {
    readonly forStudyExport?: boolean;
    readonly fetch?: typeof fetch;
    readonly onProgress?: (percent: number) => void;
    readonly signal?: AbortSignal;
  } = {},
): Promise<Uint8Array> {
  const expected = capability.content_length_bytes;
  const limit = options.forStudyExport
    ? ROOM_DOCUMENT_PDF_MAX_BYTES
    : ROOM_DOCUMENT_VIEWER_MAX_FETCH_BYTES;
  if (!Number.isSafeInteger(expected) || expected < 1 || expected > limit) {
    throw new RoomDocumentBytesError("tooLarge");
  }
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(capability.url, {
      cache: "no-store",
      credentials: "omit",
      method: "GET",
      mode: "cors",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new RoomDocumentBytesError("network");
  }
  if (!response.ok) throw new RoomDocumentBytesError("unavailable");
  const bytes = new Uint8Array(expected);
  let received = 0;
  const reader = response.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.byteLength > expected) {
        await reader.cancel();
        throw new RoomDocumentBytesError("integrity");
      }
      bytes.set(value, received);
      received += value.byteLength;
      options.onProgress?.(
        expected > 0
          ? Math.min(100, Math.round((received / expected) * 100))
          : 100,
      );
    }
  } else {
    const whole = new Uint8Array(await response.arrayBuffer());
    if (whole.byteLength > expected) {
      throw new RoomDocumentBytesError("integrity");
    }
    bytes.set(whole, 0);
    received = whole.byteLength;
    options.onProgress?.(100);
  }
  if (received !== expected) throw new RoomDocumentBytesError("integrity");
  const digest = await sha256OfBytes(bytes);
  if (digest !== capability.sha256.toLowerCase()) {
    throw new RoomDocumentBytesError("integrity");
  }
  return bytes;
}
