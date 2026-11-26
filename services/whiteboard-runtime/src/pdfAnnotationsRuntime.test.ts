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
  CollaborationCapability,
  CollaborationScope,
  ControlPlane,
  RuntimeAuthorityState,
  StoredCheckpoint,
} from "./contracts.js";
import { checkpointTargetFor } from "./checkpointStore.js";
import { HttpControlPlane } from "./controlPlane.js";
import {
  CODE_WORKSPACE_DOCUMENT_KIND,
  documentKindForName,
  parseDocumentKind,
  PDF_ANNOTATIONS_DOCUMENT_KIND,
  PDF_ANNOTATIONS_MAX_DOCUMENT_BYTES,
  PDF_ANNOTATIONS_MAX_UPDATE_BYTES,
  WHITEBOARD_DOCUMENT_KIND,
} from "./documentKind.js";
import type { ProviderAuthorityGuard } from "./providerAuthorityGuard.js";
import {
  createCollaborationRuntime,
  type CollaborationRuntime,
} from "./runtimeServer.js";

/**
 * ROOM-TOOLS-FILES-02A (ADR-0045 §4 Slice 2): `pdf.annotations.v1` (`pd_*`)
 * shares the Hocuspocus process with `wb_*` and `cw_*` but never their
 * credentials, checkpoint tables or budgets.
 */
const ORIGIN = "http://127.0.0.1:4181";
const PDF_NAME = `pd_${"p".repeat(32)}`;
const CODE_NAME = `cw_${"c".repeat(32)}`;
const WHITEBOARD_NAME = `wb_${"w".repeat(32)}`;
const PRESENTER_TOKEN = "presenter-grant-that-is-long-enough";
const VIEWER_TOKEN = "viewer-grant-that-is-long-enough-01";

function scopeFor(
  providerDocumentName: string,
  overrides: Partial<CollaborationScope> = {},
): CollaborationScope {
  return {
    actorId: "teacher-pdf",
    authorityLease: `${providerDocumentName.slice(0, 2)}${"l".repeat(41)}`,
    capability: "present",
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
    tenantId: "tenant-pdf",
    writerFence: 1,
    ...overrides,
  };
}

describe("ROOM-TOOLS-FILES-02A pdf.annotations.v1 document kind", () => {
  it("binds the pd_ prefix to exactly one kind with its own ceilings", () => {
    expect(documentKindForName(PDF_NAME)).toBe(PDF_ANNOTATIONS_DOCUMENT_KIND);
    expect(documentKindForName(CODE_NAME)).toBe(CODE_WORKSPACE_DOCUMENT_KIND);
    expect(documentKindForName(WHITEBOARD_NAME)).toBe(WHITEBOARD_DOCUMENT_KIND);
    expect(documentKindForName("pd_short")).toBeNull();
    expect(documentKindForName(`pd_${"x".repeat(126)}`)).toBeNull();
    expect(documentKindForName(`pd_${"a/".repeat(12)}`)).toBeNull();
    expect(parseDocumentKind(PDF_ANNOTATIONS_DOCUMENT_KIND)).toBe(
      PDF_ANNOTATIONS_DOCUMENT_KIND,
    );
    expect(parseDocumentKind("pdf.annotations.v2")).toBeNull();
    expect(PDF_ANNOTATIONS_MAX_DOCUMENT_BYTES).toBe(1024 * 1024);
    expect(PDF_ANNOTATIONS_MAX_UPDATE_BYTES).toBe(32 * 1024);
  });

  it("routes pd_ checkpoints to the static presentation table and rejects cross-kind scopes", () => {
    expect(checkpointTargetFor(scopeFor(PDF_NAME))).toEqual({
      documentColumn: "presentation_id",
      maxBytes: 1024 * 1024,
      table: "pdf_presentation_checkpoints",
    });
    for (const [name, kind] of [
      [PDF_NAME, CODE_WORKSPACE_DOCUMENT_KIND],
      [PDF_NAME, WHITEBOARD_DOCUMENT_KIND],
      [CODE_NAME, PDF_ANNOTATIONS_DOCUMENT_KIND],
      [WHITEBOARD_NAME, PDF_ANNOTATIONS_DOCUMENT_KIND],
    ] as const) {
      expect(() =>
        checkpointTargetFor(scopeFor(name, { documentKind: kind })),
      ).toThrow("checkpoint_corrupt");
    }
    const legacy = scopeFor(PDF_NAME);
    delete legacy.documentKind;
    expect(() => checkpointTargetFor(legacy)).toThrow("checkpoint_corrupt");
  });

  it("sends and verifies document_kind pdf.annotations.v1 through the HTTP control plane", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let respondedKind: unknown = PDF_ANNOTATIONS_DOCUMENT_KIND;
    const fetcher: typeof fetch = async (_input, init) => {
      bodies.push(
        JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      );
      return new Response(
        JSON.stringify({
          actor_id: "11111111-1111-4111-8111-111111111111",
          authority_lease: "a".repeat(43),
          capability: "view",
          document_id: "22222222-2222-4222-8222-222222222222",
          document_kind: respondedKind,
          generation: 1,
          max_connections_per_tenant: 50,
          max_operations_per_minute: 6_000,
          max_storage_bytes_per_tenant: 1_073_741_824,
          provider_document_name: PDF_NAME,
          session_id: "33333333-3333-4333-8333-333333333333",
          tenant_id: "44444444-4444-4444-8444-444444444444",
          writer_fence: 2,
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
    const grant = {
      grant: "one-time-grant-that-is-long-enough",
      origin: ORIGIN,
    };
    const scope = await control.exchangeGrant({
      ...grant,
      documentName: PDF_NAME,
    });
    expect(scope.documentKind).toBe(PDF_ANNOTATIONS_DOCUMENT_KIND);
    expect(scope.writerFence).toBe(2);
    expect(bodies[0]?.document_kind).toBe(PDF_ANNOTATIONS_DOCUMENT_KIND);

    for (const kind of [
      CODE_WORKSPACE_DOCUMENT_KIND,
      WHITEBOARD_DOCUMENT_KIND,
      undefined,
    ]) {
      respondedKind = kind;
      await expect(
        control.exchangeGrant({ ...grant, documentName: PDF_NAME }),
      ).rejects.toMatchObject({ code: "control_plane_denied" });
    }
  });
});

describe("ROOM-TOOLS-FILES-02A shared runtime isolation", () => {
  const runtimes: CollaborationRuntime[] = [];
  const clients: TestClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.destroy();
    for (const runtime of runtimes.splice(0))
      await runtime.drain().catch(() => undefined);
  });

  it("denies pd_, cw_ and wb_ credentials whose scope claims another kind", async () => {
    const runtime = createRuntime(
      new RecordingCheckpointStore(),
      new TokenControlPlane(
        new Map([
          [
            `${PDF_NAME}:${PRESENTER_TOKEN}`,
            scopeFor(PDF_NAME, { documentKind: CODE_WORKSPACE_DOCUMENT_KIND }),
          ],
          [
            `${CODE_NAME}:${PRESENTER_TOKEN}`,
            scopeFor(CODE_NAME, {
              documentKind: PDF_ANNOTATIONS_DOCUMENT_KIND,
            }),
          ],
          [
            `${WHITEBOARD_NAME}:${PRESENTER_TOKEN}`,
            scopeFor(WHITEBOARD_NAME, {
              documentKind: PDF_ANNOTATIONS_DOCUMENT_KIND,
            }),
          ],
        ]),
      ),
    );
    runtimes.push(runtime);
    await runtime.start();
    for (const name of [PDF_NAME, CODE_NAME, WHITEBOARD_NAME]) {
      const client = createClient(runtime, name, PRESENTER_TOKEN);
      clients.push(client);
      await client.closed;
      expect(client.everSynced()).toBe(false);
    }
  }, 15_000);

  it("denies a pd_ provider name presented with a cw_ scope", async () => {
    const runtime = createRuntime(
      new RecordingCheckpointStore(),
      new TokenControlPlane(
        new Map([[`${PDF_NAME}:${PRESENTER_TOKEN}`, scopeFor(CODE_NAME)]]),
      ),
    );
    runtimes.push(runtime);
    await runtime.start();
    const client = createClient(runtime, PDF_NAME, PRESENTER_TOKEN);
    clients.push(client);
    await client.closed;
    expect(client.everSynced()).toBe(false);
  }, 10_000);

  it("enforces the 32 KiB pd_ update ceiling without shrinking the whiteboard budget", async () => {
    const runtime = createRuntime(
      new RecordingCheckpointStore(),
      new TokenControlPlane(
        new Map([
          [`${PDF_NAME}:${PRESENTER_TOKEN}`, scopeFor(PDF_NAME)],
          [
            `${WHITEBOARD_NAME}:${PRESENTER_TOKEN}`,
            scopeFor(WHITEBOARD_NAME, { capability: "edit" }),
          ],
        ]),
      ),
    );
    runtimes.push(runtime);
    await runtime.start();
    const pdf = createClient(runtime, PDF_NAME, PRESENTER_TOKEN);
    const whiteboard = createClient(runtime, WHITEBOARD_NAME, PRESENTER_TOKEN);
    clients.push(pdf, whiteboard);
    await Promise.all([pdf.synced, whiteboard.synced]);

    const oversized = "x".repeat(PDF_ANNOTATIONS_MAX_UPDATE_BYTES + 1_024);
    whiteboard.document.getText("probe").insert(0, oversized);
    pdf.document.getText("probe").insert(0, oversized);
    await pdf.closed;
    expect(pdf.closeReasons).toContain("update_denied");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(whiteboard.isOpen()).toBe(true);
  }, 15_000);

  it("enforces the 1 MiB pd_ document ceiling", async () => {
    const seed = new Y.Doc();
    seed.getText("probe").insert(0, "s".repeat(1_030_000));
    const state = Y.encodeStateAsUpdate(seed);
    expect(state.byteLength).toBeLessThan(PDF_ANNOTATIONS_MAX_DOCUMENT_BYTES);
    const checkpoints = new RecordingCheckpointStore(state);
    const runtime = createRuntime(
      checkpoints,
      new TokenControlPlane(
        new Map([[`${PDF_NAME}:${PRESENTER_TOKEN}`, scopeFor(PDF_NAME)]]),
      ),
    );
    runtimes.push(runtime);
    await runtime.start();
    const pdf = createClient(runtime, PDF_NAME, PRESENTER_TOKEN);
    clients.push(pdf);
    await pdf.synced;
    expect(pdf.document.getText("probe").length).toBe(1_030_000);

    // 20 KB is below the 32 KiB update ceiling but crosses the 1 MiB cap.
    pdf.document.getText("probe").insert(0, "y".repeat(20_000));
    await pdf.closed;
    expect(pdf.closeReasons).toContain("update_denied");
  }, 20_000);

  it("rejects writes from a view-only (readOnly) pd_ connection", async () => {
    const checkpoints = new RecordingCheckpointStore();
    const runtime = createRuntime(
      checkpoints,
      new TokenControlPlane(
        new Map([
          [`${PDF_NAME}:${PRESENTER_TOKEN}`, scopeFor(PDF_NAME)],
          [
            `${PDF_NAME}:${VIEWER_TOKEN}`,
            scopeFor(PDF_NAME, {
              actorId: "student-pdf",
              authorityLease: `vw${"v".repeat(41)}`,
              capability: "view",
              sessionId: "session-student",
            }),
          ],
        ]),
      ),
    );
    runtimes.push(runtime);
    await runtime.start();
    const presenter = createClient(runtime, PDF_NAME, PRESENTER_TOKEN);
    clients.push(presenter);
    await presenter.synced;
    const viewer = createClient(runtime, PDF_NAME, VIEWER_TOKEN);
    clients.push(viewer);
    await viewer.synced;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(viewer.closeReasons).toEqual([]);

    viewer.document.getMap("pages").set("p:1", "forged-stroke");
    await viewer.closed;
    expect(viewer.closeReasons).toContain("write_disabled");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(presenter.document.getMap("pages").get("p:1")).toBeUndefined();
    expect(presenter.isOpen()).toBe(true);
  }, 15_000);

  it("loads and stores pd_ checkpoints in the presentation table with the scope writer fence", async () => {
    const seed = new Y.Doc();
    seed.getMap("meta").set("schemaVersion", 1);
    const checkpoints = new RecordingCheckpointStore(
      Y.encodeStateAsUpdate(seed),
    );
    const runtime = createRuntime(
      checkpoints,
      new TokenControlPlane(
        new Map([
          [
            `${PDF_NAME}:${PRESENTER_TOKEN}`,
            scopeFor(PDF_NAME, { writerFence: 3 }),
          ],
        ]),
      ),
    );
    runtimes.push(runtime);
    await runtime.start();
    const pdf = createClient(runtime, PDF_NAME, PRESENTER_TOKEN);
    clients.push(pdf);
    await pdf.synced;
    expect(pdf.document.getMap("meta").get("schemaVersion")).toBe(1);
    expect(checkpoints.loads).toEqual(["pdf_presentation_checkpoints"]);

    pdf.document.getMap("meta").set("presenterPage", 2);
    await waitFor(() => checkpoints.stores.length > 0, 12_000);
    expect(checkpoints.stores[0]).toEqual({
      table: "pdf_presentation_checkpoints",
      writerFence: 3,
    });
  }, 20_000);

  it("stamps awareness with the server capability so only present is trusted", async () => {
    const runtime = createRuntime(
      new RecordingCheckpointStore(),
      new TokenControlPlane(
        new Map([
          [`${PDF_NAME}:${PRESENTER_TOKEN}`, scopeFor(PDF_NAME)],
          [
            `${PDF_NAME}:${VIEWER_TOKEN}`,
            scopeFor(PDF_NAME, {
              actorId: "student-pdf",
              authorityLease: `vw${"v".repeat(41)}`,
              capability: "view",
              sessionId: "session-student",
            }),
          ],
        ]),
      ),
    );
    runtimes.push(runtime);
    await runtime.start();
    const presenter = createClient(runtime, PDF_NAME, PRESENTER_TOKEN);
    const viewer = createClient(runtime, PDF_NAME, VIEWER_TOKEN);
    clients.push(presenter, viewer);
    await Promise.all([presenter.synced, viewer.synced]);

    presenter.setAwarenessField("pdfPresence", { page: 3 });
    viewer.setAwarenessField("capability", "present");
    viewer.setAwarenessField("tutorhub", { capability: "present" });
    viewer.setAwarenessField("pdfPresence", { laser: { x: 0.5, y: 0.5 } });

    const capabilityOf = (
      states: Array<Record<string, unknown>>,
      predicate: (state: Record<string, unknown>) => boolean,
    ): unknown => {
      const state = states.find(predicate);
      const marker = state?.tutorhub as { capability?: unknown } | undefined;
      return marker?.capability;
    };
    await waitFor(
      () =>
        capabilityOf(viewer.awarenessStates(), (state) => {
          const presence = state.pdfPresence as { page?: unknown } | undefined;
          return presence?.page === 3;
        }) === "present",
      3_000,
    );
    await waitFor(
      () =>
        capabilityOf(presenter.awarenessStates(), (state) => {
          const presence = state.pdfPresence as { laser?: unknown } | undefined;
          return presence?.laser !== undefined;
        }) === "view",
      3_000,
    );
    const forged = presenter
      .awarenessStates()
      .find(
        (state) =>
          (state.tutorhub as { actorId?: unknown })?.actorId === "student-pdf",
      );
    expect(forged).toBeDefined();
    expect(forged).not.toHaveProperty("capability");
    expect(
      (forged?.tutorhub as { capability?: CollaborationCapability }).capability,
    ).toBe("view");
  }, 15_000);
});

class RecordingCheckpointStore implements CheckpointStore {
  readonly loads: string[] = [];
  readonly stores: Array<{ table: string; writerFence: number }> = [];

  constructor(private readonly seed?: Uint8Array) {}

  async close(): Promise<void> {}
  async probe(): Promise<void> {}
  async load(scope: CollaborationScope): Promise<StoredCheckpoint | null> {
    this.loads.push(checkpointTargetFor(scope).table);
    if (!this.seed) return null;
    return { checksum: "seed", state: this.seed, watermark: 1 };
  }
  async store(scope: CollaborationScope): Promise<number> {
    this.stores.push({
      table: checkpointTargetFor(scope).table,
      writerFence: scope.writerFence,
    });
    return this.stores.length;
  }
}

class TokenControlPlane implements ControlPlane {
  constructor(private readonly scopes: Map<string, CollaborationScope>) {}

  async exchangeGrant(input: {
    documentName: string;
    grant: string;
  }): Promise<CollaborationScope> {
    const scope = this.scopes.get(`${input.documentName}:${input.grant}`);
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
    maxFrameBytes: 2 * 1024 * 1024,
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

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for condition");
}

interface TestClient {
  awarenessStates(): Array<Record<string, unknown>>;
  closeReasons: string[];
  closed: Promise<void>;
  destroy(): void;
  document: Y.Doc;
  everSynced(): boolean;
  isOpen(): boolean;
  setAwarenessField(field: string, value: unknown): void;
  synced: Promise<void>;
}

function createClient(
  runtime: CollaborationRuntime,
  name: string,
  token: string,
): TestClient {
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
    token,
    websocketProvider: socket,
  });
  provider.attach();
  void socket.connect();
  return {
    awarenessStates: () =>
      [...(provider.awareness?.getStates().values() ?? [])] as Array<
        Record<string, unknown>
      >,
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
    setAwarenessField: (field, value) =>
      provider.setAwarenessField(field, value),
    synced: syncedPromise,
  };
}
