import { describe, expect, it, vi } from "vitest";
import {
  APIRequestError,
  deletePdfPresentationActorGrant,
  exchangePdfPresentationGrant,
  presentPdfDocument,
  putPdfPresentationActorGrant,
  resolvePdfPresentation,
  transitionPdfPresentation,
} from "./index";
import type { PdfPresentation, PdfPresentationProjection } from "./index";

const tenantID = "7f44c093-1cb2-46ae-8285-779b78728524";
const spaceID = "19f169c1-ed6c-4a33-aa93-e410d555747d";
const presentationID = "5b0c6f0e-3d7a-4c38-9f15-2a7f9a3d1c11";
const fileID = "3e8b8a4e-8f2f-4b55-a9b8-6b4f1d0a7c21";
const participantKey = "0d6c4d64-8d4c-4f3c-b0f5-7b6e1b9b2a44";
const baseUrl = "https://web.example.test/api";

const presentation: PdfPresentation = {
  created_at: "2030-08-03T00:00:00Z",
  current_generation: 1,
  document: {
    active_content: false,
    allow_student_download: false,
    display_name: "Đề kiểm tra.pdf",
    file_id: fileID,
    first_page_aspect: 0.7071,
    media_type: "application/pdf",
    page_count: 12,
    version_id: "version-7",
  },
  file_id: fileID,
  id: presentationID,
  media_space_id: spaceID,
  page_count: 12,
  revoke_generation: 1,
  status: "open",
  updated_at: "2030-08-03T00:00:00Z",
  version: 1,
  version_id: "version-7",
  viewer_capabilities: {
    can_close: true,
    can_exchange_grant: true,
    can_manage: true,
    can_manage_annotator_grants: true,
    can_resume: false,
    can_suspend: true,
    capability: "present",
  },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

describe("ROOM-TOOLS-FILES-02A PDF presentation client", () => {
  it("resolves the room projection with a tenant assertion and no CSRF", async () => {
    const projection: PdfPresentationProjection = {
      active_annotator_grants: [
        { expires_at: "2030-08-03T00:10:00Z", participant_key: participantKey },
      ],
      can_present: true,
      presentation,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(projection));
    await expect(
      resolvePdfPresentation(tenantID, spaceID, { baseUrl, fetch: fetchMock }),
    ).resolves.toEqual(projection);
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.method).toBe("GET");
    expect(new URL(request.url).pathname).toBe(
      `/api/v1/media/spaces/${spaceID}/pdf-presentation`,
    );
    expect(request.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(tenantID);
    expect(request.headers.get("X-CSRF-Token")).toBeNull();
  });

  it("presents a document and transitions with CSRF and tenant scope", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(presentation, 201))
      .mockResolvedValueOnce(
        jsonResponse({ ...presentation, status: "suspended" }),
      );
    await expect(
      presentPdfDocument(
        tenantID,
        spaceID,
        { file_id: fileID, idempotency_key: "pdf-present-request-0001" },
        "present-csrf",
        { baseUrl, fetch: fetchMock },
      ),
    ).resolves.toEqual(presentation);
    const present = fetchMock.mock.calls[0]?.[0] as Request;
    expect(present.method).toBe("POST");
    expect(present.headers.get("X-CSRF-Token")).toBe("present-csrf");
    await expect(present.json()).resolves.toEqual({
      file_id: fileID,
      idempotency_key: "pdf-present-request-0001",
    });

    await transitionPdfPresentation(
      tenantID,
      presentationID,
      "suspend",
      { expected_version: 1, idempotency_key: "pdf-suspend-request-01" },
      "transition-csrf",
      { baseUrl, fetch: fetchMock },
    );
    const transition = fetchMock.mock.calls[1]?.[0] as Request;
    expect(new URL(transition.url).pathname).toBe(
      `/api/v1/pdf-presentations/${presentationID}/suspend`,
    );
    expect(transition.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(
      tenantID,
    );
  });

  it("exchanges a pd_ grant and manages annotator grants by participant key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          capability: "view",
          credential: "c".repeat(43),
          document_id: presentationID,
          expires_at: "2030-08-03T00:00:30Z",
          generation: 1,
          provider_url: "wss://collab.example.test",
          revoke_generation: 1,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          expires_at: "2030-08-03T00:10:00Z",
          participant_key: participantKey,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: "pdf_presentation_annotator_limit",
            status: 409,
            title: "Annotator limit reached",
          },
          409,
        ),
      );
    await exchangePdfPresentationGrant(
      tenantID,
      presentationID,
      {
        capability: "view",
        expected_generation: 1,
        expected_revoke_generation: 1,
      },
      "grant-csrf",
      { baseUrl, fetch: fetchMock },
    );
    const exchange = fetchMock.mock.calls[0]?.[0] as Request;
    expect(new URL(exchange.url).pathname).toBe(
      `/api/v1/pdf-presentations/${presentationID}/grant-exchanges`,
    );
    expect(exchange.headers.get("Origin")).toBe("https://web.example.test");

    await expect(
      putPdfPresentationActorGrant(
        tenantID,
        presentationID,
        participantKey,
        { ttl_seconds: 600 },
        "put-csrf",
        { baseUrl, fetch: fetchMock },
      ),
    ).resolves.toEqual({
      expires_at: "2030-08-03T00:10:00Z",
      participant_key: participantKey,
    });
    const put = fetchMock.mock.calls[1]?.[0] as Request;
    expect(put.method).toBe("PUT");
    expect(new URL(put.url).pathname).toBe(
      `/api/v1/pdf-presentations/${presentationID}/actor-grants/${participantKey}`,
    );

    await expect(
      deletePdfPresentationActorGrant(
        tenantID,
        presentationID,
        participantKey,
        "delete-csrf",
        { baseUrl, fetch: fetchMock },
      ),
    ).resolves.toBeUndefined();
    expect((fetchMock.mock.calls[2]?.[0] as Request).method).toBe("DELETE");

    await expect(
      putPdfPresentationActorGrant(
        tenantID,
        presentationID,
        participantKey,
        {},
        "put-csrf",
        { baseUrl, fetch: fetchMock },
      ),
    ).rejects.toBeInstanceOf(APIRequestError);
  });
});
