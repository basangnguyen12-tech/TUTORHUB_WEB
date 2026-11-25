import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import * as Y from "yjs";
import type { RuntimeConfig } from "./config.js";
import type {
  CheckpointStore,
  CollaborationScope,
  ControlPlane,
  RuntimeAuthorityState,
  StoredCheckpoint,
} from "./contracts.js";
import { checkpointTargetFor } from "./checkpointStore.js";
import { HttpControlPlane } from "./controlPlane.js";
import {
  CODE_WORKSPACE_DOCUMENT_KIND,
  CODE_WORKSPACE_MAX_UPDATE_BYTES,
  documentKindForName,
  parseDocumentKind,
  WHITEBOARD_DOCUMENT_KIND,
} from "./documentKind.js";
import type { ProviderAuthorityGuard } from "./providerAuthorityGuard.js";
import {
  createCollaborationRuntime,
  type CollaborationRuntime,
} from "./runtimeServer.js";

const ORIGIN = "http://127.0.0.1:4181";
const CODE_NAME = `cw_${"c".repeat(32)}`;
const WHITEBOARD_NAME = `wb_${"w".repeat(32)}`;

function scopeFor(
  providerDocumentName: string,
  overrides: Partial<CollaborationScope> = {},
): CollaborationScope {
  return {
    actorId: "teacher-code",
    authorityLease: `${providerDocumentName.slice(0, 2)}${"l".repeat(41)}`,
    capability: "edit",
    documentId: `document-${providerDocumentName.slice(0, 2)}`,
    documentKind:
      documentKindForName(providerDocumentName) ?? WHITEBOARD_DOCUMENT_KIND,
    generation: 1,
    maxConnectionsPerTenant: 10,
    maxOperationsPerMinute: 6_000,
    maxStorageBytesPerTenant: 1_073_741_824,
    origin: ORIGIN,
    providerDocumentName,
    sessionId: `session-${providerDocumentName.slice(0, 2)}`,
    tenantId: "tenant-code",
    writerFence: 1,
    ...overrides,
  };
}

describe("ROOM-TOOLS-CODE-02A document kinds", () => {
  it("binds provider name prefixes to exactly one document kind", () => {
    expect(documentKindForName(CODE_NAME)).toBe(CODE_WORKSPACE_DOCUMENT_KIND);
    expect(documentKindForName(WHITEBOARD_NAME)).toBe(WHITEBOARD_DOCUMENT_KIND);
    expect(documentKindForName("cw_short")).toBeNull();
    expect(documentKindForName("provider-document")).toBeNull();
    expect(parseDocumentKind(undefined)).toBe(WHITEBOARD_DOCUMENT_KIND);
    expect(parseDocumentKind("code.workspace.v2")).toBeNull();
  });

  it("routes code checkpoints to the bounded code table and rejects cross-kind scopes", () => {
    expect(checkpointTargetFor(scopeFor(CODE_NAME))).toMatchObject({
      documentColumn: "workspace_id",
      maxBytes: 512 * 1024,
      table: "code_workspace_checkpoints",
    });
    expect(checkpointTargetFor(scopeFor(WHITEBOARD_NAME))).toMatchObject({
      table: "whiteboard_document_checkpoints",
    });
    const legacy = scopeFor(WHITEBOARD_NAME);
    delete legacy.documentKind;
    expect(checkpointTargetFor(legacy).table).toBe(
      "whiteboard_document_checkpoints",
    );
    expect(() =>
      checkpointTargetFor(
        scopeFor(CODE_NAME, { documentKind: WHITEBOARD_DOCUMENT_KIND }),
      ),
    ).toThrow("checkpoint_corrupt");
  });

  it("sends and verifies document_kind through the HTTP control plane", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let respondedKind: unknown = CODE_WORKSPACE_DOCUMENT_KIND;
    const fetcher: typeof fetch = async (_input, init) => {
      bodies.push(
        JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      );
      return new Response(
        JSON.stringify({
          actor_id: "11111111-1111-4111-8111-111111111111",
          authority_lease: "a".repeat(43),
          capability: "edit",
          document_id: "22222222-2222-4222-8222-222222222222",
          document_kind: respondedKind,
          generation: 1,
          max_connections_per_tenant: 50,
          max_operations_per_minute: 6_000,
          max_storage_bytes_per_tenant: 1_073_741_824,
          provider_document_name: CODE_NAME,
          session_id: "33333333-3333-4333-8333-333333333333",
          tenant_id: "44444444-4444-4444-8444-444444444444",
          writer_fence: 1,
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
    };
    const control = new HttpControlPlane(
      "https://control.example.test",
      "service-token-that-is-long-enough",
      1_000,
      fetcher,
    );
    const scope = await control.exchangeGrant({
      documentName: CODE_NAME,
      grant: "one-time-grant-that-is-long-enough",
      origin: ORIGIN,
    });
    expect(scope.documentKind).toBe(CODE_WORKSPACE_DOCUMENT_KIND);
    expect(bodies[0]?.document_kind).toBe(CODE_WORKSPACE_DOCUMENT_KIND);

    respondedKind = undefined;
    await expect(
      control.exchangeGrant({
        documentName: CODE_NAME,
        grant: "one-time-grant-that-is-long-enough",
        origin: ORIGIN,
      }),
    ).rejects.toMatchObject({ code: "control_plane_denied" });
    await expect(
      control.exchangeGrant({
        documentName: "provider-document",
        grant: "one-time-grant-that-is-long-enough",
        origin: ORIGIN,
      }),
    ).rejects.toMatchObject({ code: "control_plane_denied" });
  });
});

describe("ROOM-TOOLS-CODE-02A shared runtime budgets", () => {
  const runtimes: CollaborationRuntime[] = [];
  const clients: TestClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.destroy();
    for (const runtime of runtimes.splice(0))
      await runtime.drain().catch(() => undefined);
  });

  it("applies the stricter code update budget without shrinking the whiteboard budget", async () => {
    const checkpoints = new KindRecordingCheckpointStore();
    const runtime = createRuntime(
      checkpoints,
      new KindControlPlane([scopeFor(CODE_NAME), scopeFor(WHITEBOARD_NAME)]),
    );
    runtimes.push(runtime);
    await runtime.start();
    const code = createClient(runtime, CODE_NAME);
    const whiteboard = createClient(runtime, WHITEBOARD_NAME);
    clients.push(code, whiteboard);
    await Promise.all([code.synced, whiteboard.synced]);

    const oversized = "x".repeat(CODE_WORKSPACE_MAX_UPDATE_BYTES + 1_024);
    whiteboard.document.getText("probe").insert(0, oversized);
    code.document.getText("probe").insert(0, oversized);
    await code.closed;
    expect(code.closeReasons).toContain("update_denied");

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(whiteboard.isOpen()).toBe(true);
  }, 15_000);

  it("denies a cw_ document whose control-plane scope claims the whiteboard kind", async () => {
    const runtime = createRuntime(
      new KindRecordingCheckpointStore(),
      new KindControlPlane([
        scopeFor(CODE_NAME, { documentKind: WHITEBOARD_DOCUMENT_KIND }),
      ]),
    );
    runtimes.push(runtime);
    await runtime.start();
    const code = createClient(runtime, CODE_NAME);
    clients.push(code);
    await code.closed;
    expect(code.everSynced()).toBe(false);
  }, 10_000);
});

class KindRecordingCheckpointStore implements CheckpointStore {
  readonly loads: string[] = [];

  async close(): Promise<void> {}
  async probe(): Promise<void> {}
  async load(scope: CollaborationScope): Promise<StoredCheckpoint | null> {
    this.loads.push(checkpointTargetFor(scope).table);
    return null;
  }
  async store(scope: CollaborationScope): Promise<number> {
    checkpointTargetFor(scope);
    return 1;
  }
}

class KindControlPlane implements ControlPlane {
  private readonly scopes: Map<string, CollaborationScope>;

  constructor(scopes: CollaborationScope[]) {
    this.scopes = new Map(
      scopes.map((scope) => [scope.providerDocumentName, scope]),
    );
  }

  async exchangeGrant(input: {
    documentName: string;
  }): Promise<CollaborationScope> {
    const scope = this.scopes.get(input.documentName);
    if (!scope) throw new Error("denied");
    return { ...scope };
  }
  async probe(): Promise<RuntimeAuthorityState> {
    return { mode: "enabled" };
  }
  async validateScopes(scopes: CollaborationScope[]): Promise<Set<string>> {
    return new Set(scopes.map((scope) => scope.authorityLease));
  }
}

class AcquiredAuthorityGuard implements ProviderAuthorityGuard {
  private held = false;
  async acquire(): Promise<void> {
    this.held = true;
  }
  assertHeld(): void {
    if (!this.held) throw new Error("not_acquired");
  }
  async probe(): Promise<void> {
    this.assertHeld();
  }
  async release(): Promise<void> {
    this.held = false;
  }
}

function createRuntime(
  checkpoints: CheckpointStore,
  controlPlane: ControlPlane,
): CollaborationRuntime {
  return createCollaborationRuntime(runtimeConfig(), {
    authorityGuard: new AcquiredAuthorityGuard(),
    checkpoints,
    controlPlane,
    logger: { event: () => undefined },
    snapshots: {
      put: async () => {
        throw new Error("unused");
      },
      probe: async () => undefined,
    },
  });
}

function runtimeConfig(): RuntimeConfig {
  return {
    address: "127.0.0.1",
    allowedOrigins: new Set([ORIGIN]),
    b2: {
      applicationKey: "unused",
      bucket: "unused",
      endpoint: "https://unused.example",
      keyId: "unused",
      region: "unused",
    },
    buildId: "test-build",
    controlPlaneToken: "unused",
    controlPlaneUrl: "http://127.0.0.1",
    databaseUrl: "postgresql://unused:unused@127.0.0.1/unused",
    drainTimeoutMs: 5_000,
    maxAwarenessBytes: 16 * 1024,
    maxAwarenessDepth: 8,
    maxAwarenessMessagesPerSecond: 30,
    maxAwarenessStates: 1,
    maxConnections: 10,
    maxConnectionsPerActor: 3,
    maxConnectionsPerDocument: 10,
    maxConnectionsPerTenant: 10,
    maxDocumentBytes: 10 * 1024 * 1024,
    maxFrameBytes: 1024 * 1024,
    maxIngressBytesPerSecond: 4 * 1024 * 1024,
    maxMessagesPerSecond: 60,
    maxReconnectAttempts: 8,
    maxUpdateBytes: 768 * 1024,
    metricsToken: "metrics-token-that-is-long-enough",
    port: 0,
    probeTimeoutMs: 250,
    profile: "FREE_PRIVATE_ALPHA",
  };
}

interface TestClient {
  closeReasons: string[];
  closed: Promise<void>;
  destroy(): void;
  document: Y.Doc;
  everSynced(): boolean;
  isOpen(): boolean;
  synced: Promise<void>;
}

function createClient(runtime: CollaborationRuntime, name: string): TestClient {
  const document = new Y.Doc();
  const closeReasons: string[] = [];
  let resolveClosed!: () => void;
  let resolveSynced!: () => void;
  let synced = false;
  let open = true;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
  const syncedPromise = new Promise<void>(
    (resolve) => (resolveSynced = resolve),
  );
  const OriginWebSocket = class extends NodeWebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, { headers: { Origin: ORIGIN } });
    }
  };
  const socket = new HocuspocusProviderWebsocket({
    WebSocketPolyfill: OriginWebSocket,
    autoConnect: false,
    delay: 25,
    factor: 1,
    jitter: false,
    maxAttempts: 1,
    maxDelay: 25,
    minDelay: 25,
    url: `ws://127.0.0.1:${runtime.address().port}`,
  });
  const provider = new HocuspocusProvider({
    document,
    name,
    onAuthenticationFailed: () => {
      open = false;
      resolveClosed();
    },
    onClose: ({ event }) => {
      open = false;
      closeReasons.push(event.reason);
      resolveClosed();
    },
    onSynced: () => {
      synced = true;
      resolveSynced();
    },
    token: "one-time-grant-that-is-long-enough",
    websocketProvider: socket,
  });
  provider.attach();
  void socket.connect();
  return {
    closeReasons,
    closed,
    destroy: () => {
      provider.destroy();
      socket.destroy();
      document.destroy();
    },
    document,
    everSynced: () => synced,
    isOpen: () => open,
    synced: syncedPromise,
  };
}
