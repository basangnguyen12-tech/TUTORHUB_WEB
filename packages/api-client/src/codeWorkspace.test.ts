import { describe, expect, it, vi } from "vitest";
import {
  APIRequestError,
  createCodeWorkspace,
  deleteCodeWorkspaceActorGrant,
  exchangeCodeWorkspaceGrant,
  putCodeWorkspaceActorGrant,
  resolveCodeWorkspace,
  transitionCodeWorkspace,
} from "./index";
import type { CodeWorkspace, CodeWorkspaceProjection } from "./index";

const tenantID = "7f44c093-1cb2-46ae-8285-779b78728524";
const spaceID = "19f169c1-ed6c-4a33-aa93-e410d555747d";
const workspaceID = "5b0c6f0e-3d7a-4c38-9f15-2a7f9a3d1c11";
const participantKey = "0d6c4d64-8d4c-4f3c-b0f5-7b6e1b9b2a44";
const baseUrl = "https://web.example.test/api";

const workspace: CodeWorkspace = {
  created_at: "2030-08-03T00:00:00Z",
  current_generation: 1,
  id: workspaceID,
  media_space_id: spaceID,
  revoke_generation: 1,
  status: "open",
  updated_at: "2030-08-03T00:00:00Z",
  version: 2,
  viewer_capabilities: {
    can_close: true,
    can_exchange_grant: true,
    can_manage_editor_grants: true,
    can_open: false,
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

describe("ROOM-TOOLS-CODE-02A code workspace client", () => {
  it("resolves the MediaSpace projection with a tenant assertion only", async () => {
    const projection: CodeWorkspaceProjection = {
      active_editor_grants: [
        { expires_at: "2030-08-03T00:10:00Z", participant_key: participantKey },
      ],
      can_create: false,
      workspace,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(projection));
    await expect(
      resolveCodeWorkspace(tenantID, spaceID, { baseUrl, fetch: fetchMock }),
    ).resolves.toEqual(projection);
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.method).toBe("GET");
    expect(new URL(request.url).pathname).toBe(
      `/api/v1/media/spaces/${spaceID}/code-workspace`,
    );
    expect(request.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(tenantID);
    expect(request.headers.get("X-CSRF-Token")).toBeNull();
  });

  it("creates and transitions with CSRF, tenant scope and a bounded body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(workspace, 201))
      .mockResolvedValueOnce(jsonResponse(workspace));
    await createCodeWorkspace(
      tenantID,
      spaceID,
      { idempotency_key: "code-workspace-create-0001" },
      "create-csrf",
      { baseUrl, fetch: fetchMock },
    );
    const create = fetchMock.mock.calls[0]?.[0] as Request;
    expect(create.method).toBe("POST");
    expect(create.headers.get("X-CSRF-Token")).toBe("create-csrf");
    await expect(create.json()).resolves.toEqual({
      idempotency_key: "code-workspace-create-0001",
    });

    await transitionCodeWorkspace(
      tenantID,
      workspaceID,
      "suspend",
      { expected_version: 2, idempotency_key: "code-workspace-suspend-01" },
      "transition-csrf",
      { baseUrl, fetch: fetchMock },
    );
    const transition = fetchMock.mock.calls[1]?.[0] as Request;
    expect(new URL(transition.url).pathname).toBe(
      `/api/v1/code-workspaces/${workspaceID}/suspend`,
    );
    expect(transition.headers.get("X-TutorHub-Expected-Tenant-ID")).toBe(
      tenantID,
    );
  });

  it("exchanges a grant and manages temporary editor grants by participant key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          capability: "view",
          credential: "c".repeat(43),
          document_id: workspaceID,
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
            code: "code_workspace_editor_limit",
            status: 409,
            title: "Editor limit reached",
          },
          409,
        ),
      );
    await exchangeCodeWorkspaceGrant(
      tenantID,
      workspaceID,
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
      `/api/v1/code-workspaces/${workspaceID}/grant-exchanges`,
    );

    await expect(
      putCodeWorkspaceActorGrant(
        tenantID,
        workspaceID,
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
      `/api/v1/code-workspaces/${workspaceID}/actor-grants/${participantKey}`,
    );

    await expect(
      deleteCodeWorkspaceActorGrant(
        tenantID,
        workspaceID,
        participantKey,
        "delete-csrf",
        { baseUrl, fetch: fetchMock },
      ),
    ).resolves.toBeUndefined();
    expect((fetchMock.mock.calls[2]?.[0] as Request).method).toBe("DELETE");

    await expect(
      putCodeWorkspaceActorGrant(
        tenantID,
        workspaceID,
        participantKey,
        {},
        "put-csrf",
        { baseUrl, fetch: fetchMock },
      ),
    ).rejects.toBeInstanceOf(APIRequestError);
  });
});
