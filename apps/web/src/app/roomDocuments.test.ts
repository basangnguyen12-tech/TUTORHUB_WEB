import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { APIRequestError } from "@tutorhub/api-client";
import { createElement, type PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  completeMultipart: vi.fn(),
  createIntent: vi.fn(),
  createMultipart: vi.fn(),
  finalize: vi.fn(),
  issuePart: vi.fn(),
  issueSingle: vi.fn(),
  rotateCSRF: vi.fn(),
  update: vi.fn(),
  view: vi.fn(),
}));

vi.mock("@tutorhub/api-client", async () => {
  const actual = await vi.importActual<typeof import("@tutorhub/api-client")>(
    "@tutorhub/api-client",
  );
  return {
    ...actual,
    completeFileMultipartUpload: api.completeMultipart,
    createFileMultipartUpload: api.createMultipart,
    createRoomDocumentUploadIntent: api.createIntent,
    finalizeFileUpload: api.finalize,
    issueFileMultipartPartCapability: api.issuePart,
    issueFileUploadCapability: api.issueSingle,
    issueRoomDocumentViewCapability: api.view,
    rotateCSRFToken: api.rotateCSRF,
    updateRoomDocument: api.update,
  };
});

import {
  classifyRoomDocumentError,
  fetchRoomDocumentBytes,
  isRoomDocumentInFlight,
  requestRoomDocumentView,
  RoomDocumentBytesError,
  roomDocumentMediaType,
  roomDocumentRejectionKey,
  roomDocumentsInFlight,
  useRoomDocumentUpload,
  useUpdateRoomDocument,
  validateRoomDocumentFile,
} from "./roomDocuments";

const tenantID = "b43d5964-b602-4dd5-befe-cbbfe6fc9f0b";
const spaceID = "0e0f92c4-347c-4022-b4d1-c81208a972e3";
const fileID = "ebdb21f8-209f-4afb-9ee1-298a01782943";

class ChecksumWorker {
  private message?: (event: MessageEvent<unknown>) => void;
  addEventListener(
    name: string,
    listener: (event: MessageEvent<unknown>) => void,
  ) {
    if (name === "message") this.message = listener;
  }
  postMessage() {
    this.message?.({ data: { checksum: "ab".repeat(32) } } as MessageEvent);
  }
  terminate() {}
}

class UploadRequest {
  static urls: string[] = [];
  status = 200;
  private url = "";
  private listeners: Record<string, (() => void) | undefined> = {};
  upload = { addEventListener: vi.fn() };
  open(_method: string, url: string) {
    this.url = url;
    UploadRequest.urls.push(url);
  }
  setRequestHeader() {}
  addEventListener(name: string, listener: () => void) {
    this.listeners[name] = listener;
  }
  getResponseHeader(name: string) {
    if (name === "x-amz-version-id") return "version-1";
    if (name === "etag") return `etag-${this.url.at(-1)}`;
    return null;
  }
  send() {
    this.listeners.load?.();
  }
}

function wrapper({ children }: PropsWithChildren) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

describe("ROOM-TOOLS-FILES-01B room document checks", () => {
  it("accepts only viewer media types with the right size ceilings", () => {
    expect(roomDocumentMediaType({ name: "a.PDF", type: "" })).toBe(
      "application/pdf",
    );
    expect(roomDocumentMediaType({ name: "a.jpg", type: "" })).toBe(
      "image/jpeg",
    );
    expect(roomDocumentMediaType({ name: "a.docx", type: "" })).toBeNull();
    expect(
      roomDocumentMediaType({ name: "a.pdf", type: "text/html" }),
    ).toBeNull();
    expect(
      validateRoomDocumentFile({ name: "a.pdf", size: 52_428_800, type: "" }),
    ).toEqual({ mediaType: "application/pdf", problem: null });
    expect(
      validateRoomDocumentFile({ name: "a.pdf", size: 52_428_801, type: "" }),
    ).toEqual({ mediaType: null, problem: "pdfTooLarge" });
    expect(
      validateRoomDocumentFile({
        name: "a.webp",
        size: 10_485_761,
        type: "image/webp",
      }),
    ).toEqual({ mediaType: null, problem: "imageTooLarge" });
    expect(
      validateRoomDocumentFile({ name: "a.png", size: 0, type: "image/png" }),
    ).toEqual({ mediaType: null, problem: "empty" });
    expect(
      validateRoomDocumentFile({ name: "a.zip", size: 10, type: "" }),
    ).toEqual({ mediaType: null, problem: "type" });
  });

  it("maps verifier reasons and API errors to friendly states", () => {
    expect(roomDocumentRejectionKey("pdf_encrypted")).toBe(
      "classroomTools.files.rejected.pdf_encrypted",
    );
    expect(roomDocumentRejectionKey("something_new")).toBe(
      "classroomTools.files.rejected.unknown",
    );
    expect(roomDocumentRejectionKey(null)).toBe(
      "classroomTools.files.rejected.unknown",
    );
    expect(classifyRoomDocumentError(new APIRequestError(404))).toBe(
      "forbidden",
    );
    expect(classifyRoomDocumentError(new APIRequestError(503))).toBe(
      "featureOff",
    );
    expect(classifyRoomDocumentError(new APIRequestError(409))).toBe(
      "conflict",
    );
    expect(classifyRoomDocumentError(new APIRequestError(429))).toBe(
      "rateLimited",
    );
    expect(classifyRoomDocumentError(new Error("x"))).toBe("error");
  });

  it("detects rows the verifier is still checking", () => {
    const row = (status: string) =>
      ({ status }) as Parameters<typeof isRoomDocumentInFlight>[0];
    expect(isRoomDocumentInFlight(row("processing"))).toBe(true);
    expect(isRoomDocumentInFlight(row("ready"))).toBe(false);
    expect(
      roomDocumentsInFlight({
        pageParams: [undefined],
        pages: [
          {
            items: [row("ready"), row("uploaded")],
            next_cursor: null,
            viewer_access: {
              can_manage: false,
              can_present: false,
              can_upload: false,
              can_upload_to_class: false,
            },
          },
        ],
      }),
    ).toBe(true);
    expect(roomDocumentsInFlight(undefined)).toBe(false);
  });
});

describe("ROOM-TOOLS-FILES-01B document bytes", () => {
  it("fetches without cookies, referrer or HTTP cache and verifies SHA-256", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7 fixture");
    const fakeFetch = vi.fn(
      async () => new Response(bytes.slice(), { status: 200 }),
    );
    const progress: number[] = [];
    const result = await fetchRoomDocumentBytes(
      {
        content_length_bytes: bytes.byteLength,
        sha256: await sha256(bytes),
        url: "https://storage.example.test/object?X-Amz-Signature=x",
      },
      {
        fetch: fakeFetch as unknown as typeof fetch,
        onProgress: (percent) => progress.push(percent),
      },
    );
    expect(Array.from(result)).toEqual(Array.from(bytes));
    expect(progress.at(-1)).toBe(100);
    expect(fakeFetch).toHaveBeenCalledWith(
      "https://storage.example.test/object?X-Amz-Signature=x",
      expect.objectContaining({
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      }),
    );
  });

  it("rejects mismatched length or digest, oversized files and failures", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7 fixture");
    const respond = () =>
      vi.fn(async () => new Response(bytes.slice(), { status: 200 }));
    await expect(
      fetchRoomDocumentBytes(
        {
          content_length_bytes: bytes.byteLength,
          sha256: "00".repeat(32),
          url: "https://storage.example.test/o",
        },
        { fetch: respond() as unknown as typeof fetch },
      ),
    ).rejects.toEqual(new RoomDocumentBytesError("integrity"));
    await expect(
      fetchRoomDocumentBytes(
        {
          content_length_bytes: bytes.byteLength - 2,
          sha256: await sha256(bytes),
          url: "https://storage.example.test/o",
        },
        { fetch: respond() as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "integrity" });
    const never = vi.fn();
    await expect(
      fetchRoomDocumentBytes(
        {
          content_length_bytes: 31_457_281,
          sha256: "00",
          url: "https://storage.example.test/o",
        },
        { fetch: never as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: "tooLarge" });
    expect(never).not.toHaveBeenCalled();
    await expect(
      fetchRoomDocumentBytes(
        {
          content_length_bytes: 1,
          sha256: "00",
          url: "https://storage.example.test/o",
        },
        {
          fetch: (async () =>
            new Response(null, { status: 403 })) as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("asks for a fresh view capability with a rotated CSRF token", async () => {
    api.rotateCSRF.mockResolvedValue({ csrf_token: "csrf-view" });
    api.view.mockResolvedValue({ url: "https://storage.example.test/v" });
    await requestRoomDocumentView(tenantID, spaceID, fileID);
    expect(api.view).toHaveBeenCalledWith(
      tenantID,
      spaceID,
      fileID,
      "csrf-view",
      expect.objectContaining({ baseUrl: expect.any(String) }),
    );
  });
});

describe("ROOM-TOOLS-FILES-01B room document upload", () => {
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    vi.clearAllMocks();
    UploadRequest.urls = [];
    vi.stubGlobal("Worker", ChecksumWorker);
    vi.stubGlobal("XMLHttpRequest", UploadRequest);
    api.rotateCSRF.mockResolvedValue({ csrf_token: "csrf" });
    api.createIntent.mockResolvedValue({ id: fileID, version: 1 });
    api.issueSingle.mockResolvedValue({
      method: "PUT",
      required_headers: {},
      url: "https://storage.example.test/single",
    });
    api.createMultipart.mockResolvedValue({ id: "multipart-1" });
    api.issuePart.mockImplementation(
      (_t: string, _f: string, _m: string, part: number) =>
        Promise.resolve({
          required_headers: {},
          url: `https://storage.example.test/part-${part}`,
        }),
    );
    api.completeMultipart.mockResolvedValue({ storage_version_id: "v-multi" });
    api.finalize.mockResolvedValue({ id: fileID, status: "processing" });
  });

  it("uploads a small PDF with one PUT into the room scope", async () => {
    const { result } = renderHook(
      () => useRoomDocumentUpload(tenantID, spaceID),
      { wrapper },
    );
    await act(async () =>
      result.current.mutateAsync({
        allowStudentDownload: false,
        clientRequestID: "c5b01234-9257-4f03-b356-1e71f124c4b0",
        file: new File([new Uint8Array(2048)], "De.pdf", {
          type: "application/pdf",
        }),
        scope: "media_space",
      }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.createIntent).toHaveBeenCalledWith(
      tenantID,
      spaceID,
      expect.objectContaining({
        allow_student_download: false,
        checksum_sha256: "ab".repeat(32),
        declared_media_type: "application/pdf",
        display_name: "De.pdf",
        expected_size_bytes: 2048,
        scope: "media_space",
      }),
      "csrf",
      expect.any(Object),
    );
    expect(UploadRequest.urls).toEqual(["https://storage.example.test/single"]);
    expect(api.finalize).toHaveBeenCalledWith(
      tenantID,
      fileID,
      { expected_version: 1, storage_version_id: "version-1" },
      "csrf",
      expect.any(Object),
    );
    expect(result.current.progress).toEqual({
      percent: 100,
      phase: "complete",
    });
  });

  it("uploads ≥ 10 MB in 8 MB multipart parts and refuses bad files early", async () => {
    const { result } = renderHook(
      () => useRoomDocumentUpload(tenantID, spaceID),
      { wrapper },
    );
    await act(async () =>
      result.current.mutateAsync({
        allowStudentDownload: true,
        clientRequestID: "f9b01234-9257-4f03-b356-1e71f124c4b0",
        file: new File([new Uint8Array(17_000_000)], "Big.pdf", {
          type: "application/pdf",
        }),
        scope: "class",
      }),
    );
    expect(api.issuePart.mock.calls.map((call) => call[3])).toEqual([1, 2, 3]);
    expect(api.completeMultipart).toHaveBeenCalledWith(
      tenantID,
      fileID,
      "multipart-1",
      {
        expected_version: 1,
        parts: [
          { etag: "etag-1", part_number: 1 },
          { etag: "etag-2", part_number: 2 },
          { etag: "etag-3", part_number: 3 },
        ],
      },
      "csrf",
      expect.any(Object),
    );
    expect(api.issueSingle).not.toHaveBeenCalled();

    vi.clearAllMocks();
    await expect(
      act(async () =>
        result.current.mutateAsync({
          allowStudentDownload: false,
          clientRequestID: "aa001234-9257-4f03-b356-1e71f124c4b0",
          file: new File(["x"], "notes.docx"),
          scope: "media_space",
        }),
      ),
    ).rejects.toThrow("room_document_type");
    expect(api.createIntent).not.toHaveBeenCalled();
  });

  it("patches download permission and soft delete with the row version", async () => {
    api.update.mockResolvedValue(null);
    const { result } = renderHook(
      () => useUpdateRoomDocument(tenantID, spaceID),
      { wrapper },
    );
    const document = { id: fileID, version: 7 } as Parameters<
      typeof result.current.mutateAsync
    >[0]["document"];
    await act(async () =>
      result.current.mutateAsync({
        document,
        patch: { allowStudentDownload: true },
      }),
    );
    await act(async () =>
      result.current.mutateAsync({ document, patch: { deleted: true } }),
    );
    expect(api.update.mock.calls.map((call) => call[3])).toEqual([
      { allow_student_download: true, expected_version: 7 },
      { deleted: true, expected_version: 7 },
    ]);
  });
});
