import { afterEach, describe, expect, it, vi } from "vitest";
import { APIRequestError } from "@tutorhub/api-client";
import { createClassroomFilesSession } from "./filesSession";
import { getStudyExportBytes } from "./studyExportSource";
import type { DocumentSource } from "./DocumentViewer";

const api = vi.hoisted(() => ({
  download: vi.fn(),
  view: vi.fn(),
  csrf: vi.fn(),
}));
vi.mock("@tutorhub/api-client", async (original) => ({
  ...(await original<typeof import("@tutorhub/api-client")>()),
  issueFileDownloadCapability: api.download,
  issueRoomDocumentViewCapability: api.view,
  rotateCSRFToken: api.csrf,
}));

const doc = {
  fileID: "70000000-0000-4000-8000-00000000000a",
  versionID: "version-A",
  displayName: "Notes.pdf",
  mediaType: "application/pdf",
  pageCount: 1,
  firstPageAspect: 1,
  activeContent: false,
};
const scope = {
  tenantID: "50000000-0000-4000-8000-000000000001",
  mediaSpaceID: "40000000-0000-4000-8000-000000000001",
  actorID: "50000000-0000-4000-8000-000000000002",
  session: createClassroomFilesSession(),
};

function prepareRange(length: number, sha256: string): DocumentSource {
  api.csrf.mockResolvedValue({ csrf_token: "test-csrf" });
  api.download.mockResolvedValue({ method: "GET" });
  api.view.mockResolvedValue({
    content_length_bytes: length,
    version_id: doc.versionID,
    sha256,
    url: "/fixture-bytes",
  });
  return {
    kind: "range",
    reader: { length, aborted: false, abort: vi.fn(), read: vi.fn() },
    versionID: doc.versionID,
    sha256,
  };
}

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("study export of a version-pinned document", () => {
  it("rechecks server authorization before using cached bytes", async () => {
    const stop = new AbortController();
    api.csrf.mockResolvedValue({ csrf_token: "test-csrf" });
    api.download.mockRejectedValue(new APIRequestError(403));
    await expect(
      getStudyExportBytes(
        scope,
        doc,
        { kind: "bytes", bytes: new Uint8Array(1) },
        stop.signal,
        vi.fn(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(api.view).not.toHaveBeenCalled();
  });

  it.each(["version_id", "sha256", "content_length_bytes"])(
    "rejects a different %s before requesting storage",
    async (field) => {
      const source = prepareRange(36_000_000, "11".repeat(32));
      api.view.mockResolvedValue({
        content_length_bytes: 36_000_000,
        version_id: doc.versionID,
        sha256: "11".repeat(32),
        [field]: field === "content_length_bytes" ? 99 : "different",
      });
      const fetchBytes = vi.fn();
      vi.stubGlobal("fetch", fetchBytes);
      await expect(
        getStudyExportBytes(
          scope,
          doc,
          source,
          new AbortController().signal,
          vi.fn(),
        ),
      ).rejects.toMatchObject({ code: "integrity" });
      expect(fetchBytes).not.toHaveBeenCalled();
    },
  );

  it("downloads a Range-size file with progress, exact byte count and SHA-256", async () => {
    const bytes = new Uint8Array(30 * 1024 * 1024 + 1);
    const sha = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (value) => value.toString(16).padStart(2, "0"),
    ).join("");
    const source = prepareRange(bytes.length, sha);
    vi.stubGlobal(
      "fetch",
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.subarray(0, 4 * 1024 * 1024));
              controller.enqueue(bytes.subarray(4 * 1024 * 1024));
              controller.close();
            },
          }),
        ),
    );
    const progress = vi.fn();
    const result = await getStudyExportBytes(
      scope,
      doc,
      source,
      new AbortController().signal,
      progress,
    );
    expect(result.length).toBe(bytes.length);
    expect(progress.mock.calls.map(([value]) => value)).toEqual([13, 100]);
  });

  it("passes cancellation to the storage request and stops before encoding", async () => {
    const source = prepareRange(35 * 1024 * 1024, "11".repeat(32));
    const stop = new AbortController();
    vi.stubGlobal("fetch", (_url: string, options: RequestInit) => {
      expect(options.signal).toBe(stop.signal);
      stop.abort();
      return Promise.reject(stop.signal.reason);
    });
    await expect(
      getStudyExportBytes(scope, doc, source, stop.signal, vi.fn()),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
