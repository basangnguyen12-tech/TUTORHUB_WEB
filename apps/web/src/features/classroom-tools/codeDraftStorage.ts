import { CODE_DRAFT_STORAGE_PREFIX } from "../../app/session";
import type { ClassroomCodeWorkspaceSnapshot } from "./codeSession";
import { sanitizeWorkspaceSnapshot, utf8Bytes } from "./codeWorkspaceModel";

/**
 * ROOM-TOOLS-CODE-01 bounded session draft (ADR-0043 §2, ADR-0029): one
 * localStorage record per (tenant, actor, media space), 8-hour TTL, file
 * contents ≤ 64 KB (enforced by the workspace model) and a hard cap on the
 * serialized record. `clearPrivateSessionCache()` wipes the prefix on sign-out.
 */
export const CODE_DRAFT_TTL_MS = 8 * 60 * 60 * 1000;
/** Contents ≤ 64 KB + stdin ≤ 16 KB, plus JSON escaping headroom. */
export const CODE_DRAFT_MAX_RECORD_BYTES = 96 * 1024;
const SCHEMA_VERSION = 1;

export interface CodeDraftScope {
  readonly actorID: string;
  readonly mediaSpaceID: string;
  readonly tenantID: string;
}

interface StoredCodeDraft {
  readonly actor_id: string;
  readonly expires_at: number;
  readonly media_space_id: string;
  readonly schema_version: 1;
  readonly tenant_id: string;
  readonly workspace: unknown;
}

function scopeReady(scope: CodeDraftScope): boolean {
  return Boolean(scope.actorID && scope.mediaSpaceID && scope.tenantID);
}

export function codeDraftKey(scope: CodeDraftScope): string {
  return `${CODE_DRAFT_STORAGE_PREFIX}v1:${encodeURIComponent(
    scope.tenantID,
  )}:${encodeURIComponent(scope.actorID)}:${encodeURIComponent(
    scope.mediaSpaceID,
  )}`;
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function remove(storage: Storage, key: string) {
  try {
    storage.removeItem(key);
  } catch {
    // Advisory storage: the in-memory workspace stays authoritative.
  }
}

export function readCodeDraft(
  scope: CodeDraftScope,
  now = Date.now(),
  storage: Storage | null = defaultStorage(),
): ClassroomCodeWorkspaceSnapshot | null {
  if (!storage || !scopeReady(scope)) return null;
  const key = codeDraftKey(scope);
  let serialized: string | null;
  try {
    serialized = storage.getItem(key);
  } catch {
    return null;
  }
  if (!serialized) return null;
  if (utf8Bytes(serialized) > CODE_DRAFT_MAX_RECORD_BYTES) {
    remove(storage, key);
    return null;
  }
  try {
    const record = JSON.parse(serialized) as Partial<StoredCodeDraft> | null;
    const valid =
      record !== null &&
      typeof record === "object" &&
      record.schema_version === SCHEMA_VERSION &&
      record.tenant_id === scope.tenantID &&
      record.actor_id === scope.actorID &&
      record.media_space_id === scope.mediaSpaceID &&
      typeof record.expires_at === "number" &&
      Number.isSafeInteger(record.expires_at) &&
      record.expires_at > now &&
      record.expires_at <= now + CODE_DRAFT_TTL_MS;
    const workspace = valid
      ? sanitizeWorkspaceSnapshot(record.workspace)
      : null;
    if (!workspace || workspace.files.length === 0) {
      remove(storage, key);
      return null;
    }
    return workspace;
  } catch {
    remove(storage, key);
    return null;
  }
}

export function writeCodeDraft(
  scope: CodeDraftScope,
  workspace: ClassroomCodeWorkspaceSnapshot,
  now = Date.now(),
  storage: Storage | null = defaultStorage(),
): boolean {
  if (!storage || !scopeReady(scope)) return false;
  const safe = sanitizeWorkspaceSnapshot(workspace);
  if (!safe) return false;
  const record: StoredCodeDraft = {
    actor_id: scope.actorID,
    expires_at: now + CODE_DRAFT_TTL_MS,
    media_space_id: scope.mediaSpaceID,
    schema_version: SCHEMA_VERSION,
    tenant_id: scope.tenantID,
    workspace: safe,
  };
  const serialized = JSON.stringify(record);
  if (utf8Bytes(serialized) > CODE_DRAFT_MAX_RECORD_BYTES) return false;
  try {
    storage.setItem(codeDraftKey(scope), serialized);
    return true;
  } catch {
    return false;
  }
}

export function removeCodeDraft(
  scope: CodeDraftScope,
  storage: Storage | null = defaultStorage(),
) {
  if (storage && scopeReady(scope)) remove(storage, codeDraftKey(scope));
}
