import type { WhiteboardGrantCredential } from "@tutorhub/api-client";
import {
  createBrowserPdfAnnotationSession,
  isTrustedPresenterAwareness,
  type CanonicalPdfAnnotationAuthority,
  type CollaborationCapability,
  type CollaborationConnectionStatus,
  type CollaborationTerminalReason,
  type PdfAnnotationBinding,
  type PdfAnnotationMeta,
  type PdfStroke,
} from "@tutorhub/collaboration-client";
import {
  createLaserThrottle,
  parseLaserPoint,
  PDF_LASER_STALE_MS,
  type PdfLaserPoint,
} from "./pdfAnnotationModel";

/**
 * ROOM-TOOLS-FILES-02B (ADR-0045 Slice 2): everything that needs Yjs for the
 * classroom PDF presentation. This module is only reached through `import()`
 * once `classroom_pdf_collaboration` is on and the viewer is in
 * "Trình chiếu lớp" on an open presentation, so the Documents viewer chunk
 * (`LazyDocumentViewer-*`) carries no CRDT code and shares the one
 * `yjs@13.6.27` instance with the whiteboard and Code collaboration chunks.
 */

/** Minimal structural view of a y-protocols `Awareness`. */
export interface PdfAwarenessLike {
  readonly clientID: number;
  getLocalState(): Record<string, unknown> | null;
  getStates(): Map<number, Record<string, unknown>>;
  off(event: "change", listener: (...args: never[]) => void): void;
  on(event: "change", listener: (...args: never[]) => void): void;
  setLocalStateField(field: string, value: unknown): void;
}

/** Version-cached read model over the authority for the React overlay. */
export interface PdfInkStore {
  canRedo(): boolean;
  canUndo(): boolean;
  meta(): PdfAnnotationMeta;
  strokes(page: number): readonly PdfStroke[];
  subscribe(listener: () => void): () => void;
  version(): number;
}

export interface PdfLaserMark extends PdfLaserPoint {
  readonly clientID: number;
  /** The presenter's roster key (cosmetic: name and tone only). */
  readonly participantKey: string | null;
}

/** Server-stamped presenter lasers, keyed by page, stale after 1.5 s. */
export interface PdfLaserFeed {
  destroy(): void;
  marks(): readonly PdfLaserMark[];
  subscribe(listener: () => void): () => void;
}

export interface LivePdfSession {
  readonly authority: CanonicalPdfAnnotationAuthority;
  readonly capability: CollaborationCapability;
  destroy(): void;
  readonly ink: PdfInkStore;
  readonly laser: PdfLaserFeed;
  /** Presenter only: throttled to ≤ 20 Hz; `null` clears the laser. */
  publishLaser(point: PdfLaserPoint | null): void;
}

export interface OpenLivePdfSessionOptions {
  readonly actorID: string;
  readonly binding: PdfAnnotationBinding;
  readonly displayName?: string;
  readonly grant: WhiteboardGrantCredential;
  readonly onStatus: (status: CollaborationConnectionStatus) => void;
  readonly onTerminal: (reason: CollaborationTerminalReason) => void;
  readonly participantKey?: string | null;
  readonly tenantID: string;
}

export async function openLivePdfSession({
  actorID,
  binding,
  displayName,
  grant,
  onStatus,
  onTerminal,
  participantKey = null,
  tenantID,
}: OpenLivePdfSessionOptions): Promise<LivePdfSession> {
  const session = await createBrowserPdfAnnotationSession({
    actorId: actorID,
    binding,
    grant: {
      capability: grant.capability,
      credential: grant.credential,
      documentId: grant.document_id,
      expiresAt: grant.expires_at,
      generation: grant.generation,
      providerUrl: grant.provider_url,
      revokeGeneration: grant.revoke_generation,
    },
    onStatus,
    onTerminal,
    tenantId: tenantID,
  });
  const awareness = session.awareness as unknown as PdfAwarenessLike | null;
  const name = displayName?.trim().slice(0, 64);
  if (awareness && name) {
    awareness.setLocalStateField("user", { displayName: name });
  }
  const ink = createPdfInkStore(session.authority);
  const laser = createPdfLaserFeed(awareness, binding.pageCount);
  const presenter = session.capability === "present" && awareness !== null;
  const throttle = createLaserThrottle((point) => {
    awareness?.setLocalStateField(
      "pdfLaser",
      point
        ? { ...point, ...(participantKey ? { participantKey } : {}) }
        : null,
    );
  });
  let destroyed = false;
  return {
    authority: session.authority,
    capability: session.capability,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      throttle.clear();
      laser.destroy();
      session.destroy();
    },
    ink,
    laser,
    publishLaser: (point) => {
      if (!presenter || destroyed) return;
      if (point) throttle.move(point);
      else throttle.clear();
    },
  };
}

export function createPdfInkStore(
  authority: Pick<
    CanonicalPdfAnnotationAuthority,
    "canRedo" | "canUndo" | "metaState" | "strokes" | "subscribe"
  >,
): PdfInkStore {
  let version = 0;
  let pages = new Map<number, readonly PdfStroke[]>();
  let meta: PdfAnnotationMeta | null = null;
  const listeners = new Set<() => void>();
  let detach: (() => void) | null = null;
  const handle = () => {
    version += 1;
    pages = new Map();
    meta = null;
    for (const listener of [...listeners]) listener();
  };
  return {
    canRedo: () => authority.canRedo(),
    canUndo: () => authority.canUndo(),
    meta: () => {
      meta ??= authority.metaState();
      return meta;
    },
    strokes: (page) => {
      const cached = pages.get(page);
      if (cached) return cached;
      let next: readonly PdfStroke[];
      try {
        next = authority.strokes(page);
      } catch {
        next = [];
      }
      pages.set(page, next);
      return next;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      detach ??= authority.subscribe(handle);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          detach?.();
          detach = null;
        }
      };
    },
    version: () => version,
  };
}

/**
 * Only states stamped by the runtime as `present` (`tutorhub.capability`)
 * may draw a laser; a `view` or `edit` connection that writes `pdfLaser`
 * into its own awareness is ignored here, whatever it claims.
 */
export function createPdfLaserFeed(
  awareness: PdfAwarenessLike | null,
  pageCount: number,
  {
    now = () => Date.now(),
    staleMs = PDF_LASER_STALE_MS,
  }: { readonly now?: () => number; readonly staleMs?: number } = {},
): PdfLaserFeed {
  const listeners = new Set<() => void>();
  const seen = new Map<number, { at: number; key: string }>();
  let marks: readonly PdfLaserMark[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;

  const recompute = () => {
    if (!awareness) return;
    const time = now();
    const next: PdfLaserMark[] = [];
    for (const [clientID, state] of awareness.getStates()) {
      if (clientID === awareness.clientID) continue;
      if (!isTrustedPresenterAwareness(state)) continue;
      const point = parseLaserPoint(state.pdfLaser, pageCount);
      if (!point) {
        seen.delete(clientID);
        continue;
      }
      const key = `${point.page}:${point.x}:${point.y}`;
      const previous = seen.get(clientID);
      if (!previous || previous.key !== key) {
        seen.set(clientID, { at: time, key });
      }
      const at = seen.get(clientID)?.at ?? time;
      if (time - at > staleMs) continue;
      const rawKey = (state.pdfLaser as { participantKey?: unknown })
        .participantKey;
      next.push({
        ...point,
        clientID,
        participantKey:
          typeof rawKey === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(rawKey)
            ? rawKey
            : null,
      });
    }
    const changed =
      next.length !== marks.length ||
      next.some((mark, index) => {
        const previous = marks[index];
        return (
          !previous ||
          previous.clientID !== mark.clientID ||
          previous.page !== mark.page ||
          previous.x !== mark.x ||
          previous.y !== mark.y
        );
      });
    if (changed) {
      marks = next;
      for (const listener of [...listeners]) listener();
    }
    if (next.length > 0 && timer === null) {
      timer = globalThis.setInterval(recompute, 250);
    } else if (next.length === 0 && timer !== null) {
      globalThis.clearInterval(timer);
      timer = null;
    }
  };

  awareness?.on("change", recompute);
  recompute();
  return {
    destroy: () => {
      awareness?.off("change", recompute);
      if (timer !== null) globalThis.clearInterval(timer);
      timer = null;
      listeners.clear();
      marks = [];
    },
    marks: () => marks,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
