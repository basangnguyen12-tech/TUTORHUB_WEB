/**
 * ROOM-TOOLS-CODE-02B (ADR-0043 §4): presence for the shared Code workspace.
 *
 * The collaboration runtime rewrites every awareness `user` field to
 * `{ id, displayName? }` and stamps a server-verified
 * `tutorhub: { capability, … }`, so nothing a peer claims about its colour or
 * role reaches us. Each client therefore publishes `user.displayName` plus a
 * small top-level `codePresence` record, and every viewer derives a peer's
 * name and 8-tone colour from the server roster (by participant key) and
 * "presenter" only from the server stamp. Remote cursors are drawn by
 * `y-codemirror.next` through `createRemoteCursorAwareness`, which hands the
 * binding sanitized states only (a fixed palette instead of a peer-chosen CSS
 * colour string) and coalesces local cursor writes under the runtime's
 * awareness message budget. This module has no Yjs import.
 */
import { fnv1aHash, mediaTileTone } from "../media/classroomSignals";

export const CODE_PRESENCE_TONE_COUNT = 8;

/**
 * Cursor colours for the dark editor (`#0f131b`): the eight Meet tile hues a
 * step lighter, so a caret reads >= 3:1 against the editor and the dark name
 * label (`#0b0f17`) reads >= 8:1 on every tone.
 */
export const CODE_CURSOR_COLORS: readonly string[] = Object.freeze([
  "#7dd3e0",
  "#a5b4fc",
  "#fdb49a",
  "#86efac",
  "#d8b4fe",
  "#f5cf8b",
  "#93c5fd",
  "#f9a8d4",
]);

/** Minimal structural view of a y-protocols `Awareness`. */
export interface CodeAwarenessLike {
  readonly doc: { readonly clientID: number };
  getLocalState(): Record<string, unknown> | null;
  getStates(): Map<number, Record<string, unknown>>;
  off(event: "change", listener: (...args: never[]) => void): void;
  on(event: "change", listener: (...args: never[]) => void): void;
  setLocalStateField(field: string, value: unknown): void;
}

export interface CodePresenceRosterEntry {
  readonly display_name: string;
  readonly participant_key: string;
  readonly roster_sequence: number;
}

/** The server roster, joined by participant key. */
export interface CodePresenceRoster {
  readonly participants: readonly CodePresenceRosterEntry[];
  readonly roomInstanceID: string;
  readonly selfParticipantKey: string;
}

export interface CodePresenceIdentity {
  readonly name: string;
  readonly tone: number;
}

export interface CodePresencePeer extends CodePresenceIdentity {
  readonly clientID: number;
  readonly fileId: string | null;
  readonly initial: string;
  readonly line: number | null;
  readonly presenter: boolean;
}

export interface LocalCodePresence {
  readonly fileId: string | null;
  readonly line: number | null;
  readonly name: string;
  readonly participantKey: string | null;
  readonly tone: number;
}

const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const PARTICIPANT_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NAME_LENGTH = 48;
const MAX_LINE = 1_000_000;

export function codeCursorColor(tone: number): {
  readonly color: string;
  readonly colorLight: string;
} {
  const color = CODE_CURSOR_COLORS[clampTone(tone)] ?? "#93c5fd";
  // ~16 % alpha keeps selected text legible on the dark editor.
  return { color, colorLight: `${color}29` };
}

export function clampTone(tone: number): number {
  if (!Number.isSafeInteger(tone)) return 0;
  const slot = tone % CODE_PRESENCE_TONE_COUNT;
  return slot < 0 ? slot + CODE_PRESENCE_TONE_COUNT : slot;
}

/** Initial for a presence dot: the first letter, upper-cased. */
export function presenceInitial(name: string): string {
  return (Array.from(name.trim())[0] ?? "?").toLocaleUpperCase();
}

export function sanitizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Control characters and line/paragraph separators become spaces.
  const cleaned = Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029
      ? " "
      : character;
  })
    .slice(0, MAX_NAME_LENGTH)
    .join("")
    .trim();
  return cleaned === "" ? null : cleaned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rosterTone(roster: CodePresenceRoster, sequence: number): number {
  return mediaTileTone(sequence, fnv1aHash(roster.roomInstanceID));
}

/** The viewer's own name and tone, from the roster when present. */
export function localPresenceIdentity(
  roster: CodePresenceRoster | null,
  fallbackName: string,
): CodePresenceIdentity & { readonly participantKey: string | null } {
  const self = roster?.participants.find(
    (person) => person.participant_key === roster.selfParticipantKey,
  );
  if (roster && self) {
    return {
      name: sanitizeDisplayName(self.display_name) ?? fallbackName,
      participantKey: self.participant_key,
      tone: rosterTone(roster, self.roster_sequence),
    };
  }
  return {
    name: sanitizeDisplayName(fallbackName) ?? "?",
    participantKey: null,
    tone: 0,
  };
}

/**
 * Name and tone for one remote awareness state. The roster (server truth)
 * wins; otherwise the runtime-kept `displayName` and a stable tone.
 */
export function remotePresenceIdentity(
  state: Record<string, unknown>,
  clientID: number,
  roster: CodePresenceRoster | null,
  fallbackName: string,
): CodePresenceIdentity {
  const presence = isRecord(state.codePresence) ? state.codePresence : null;
  const key =
    typeof presence?.participantKey === "string" &&
    PARTICIPANT_KEY_PATTERN.test(presence.participantKey)
      ? presence.participantKey
      : null;
  const person =
    key && roster
      ? roster.participants.find((entry) => entry.participant_key === key)
      : undefined;
  if (roster && person) {
    return {
      name: sanitizeDisplayName(person.display_name) ?? fallbackName,
      tone: rosterTone(roster, person.roster_sequence),
    };
  }
  const user = isRecord(state.user) ? state.user : null;
  const name = sanitizeDisplayName(user?.displayName) ?? fallbackName;
  const tone =
    typeof presence?.tone === "number" && Number.isSafeInteger(presence.tone)
      ? clampTone(presence.tone)
      : clampTone(fnv1aHash(String(clientID)));
  return { name, tone };
}

/** Server-stamped capability (the runtime overwrites `tutorhub`). */
export function isServerPresenter(state: Record<string, unknown>): boolean {
  return isRecord(state.tutorhub) && state.tutorhub.capability === "present";
}

function presenceFileId(state: Record<string, unknown>): string | null {
  const presence = isRecord(state.codePresence) ? state.codePresence : null;
  return typeof presence?.fileId === "string" &&
    FILE_ID_PATTERN.test(presence.fileId)
    ? presence.fileId
    : null;
}

function presenceLine(state: Record<string, unknown>): number | null {
  const presence = isRecord(state.codePresence) ? state.codePresence : null;
  const line = presence?.line;
  return typeof line === "number" &&
    Number.isSafeInteger(line) &&
    line >= 1 &&
    line <= MAX_LINE
    ? line
    : null;
}

/** Every remote peer with a sanitized identity, ordered by client id. */
export function readCodePresencePeers(
  awareness: CodeAwarenessLike,
  roster: CodePresenceRoster | null,
  fallbackName: string,
): CodePresencePeer[] {
  const self = awareness.doc.clientID;
  const peers: CodePresencePeer[] = [];
  for (const [clientID, state] of awareness.getStates()) {
    if (clientID === self || !isRecord(state)) continue;
    const identity = remotePresenceIdentity(
      state,
      clientID,
      roster,
      fallbackName,
    );
    peers.push({
      ...identity,
      clientID,
      fileId: presenceFileId(state),
      initial: presenceInitial(identity.name),
      line: presenceLine(state),
      presenter: isServerPresenter(state),
    });
  }
  return peers.sort((left, right) => left.clientID - right.clientID);
}

export function publishLocalPresence(
  awareness: CodeAwarenessLike,
  presence: LocalCodePresence,
): void {
  const current = awareness.getLocalState();
  const user = isRecord(current?.user) ? current.user : null;
  if (user?.displayName !== presence.name) {
    awareness.setLocalStateField("user", { displayName: presence.name });
  }
  const next = {
    fileId: presence.fileId,
    line: presence.line,
    participantKey: presence.participantKey,
    tone: clampTone(presence.tone),
  };
  const previous = isRecord(current?.codePresence)
    ? current.codePresence
    : null;
  if (
    previous?.fileId !== next.fileId ||
    previous?.line !== next.line ||
    previous?.participantKey !== next.participantKey ||
    previous?.tone !== next.tone
  ) {
    awareness.setLocalStateField("codePresence", next);
  }
}

function isRelativePositionJSON(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const id = (candidate: unknown) =>
    candidate === null ||
    candidate === undefined ||
    (isRecord(candidate) &&
      Number.isSafeInteger(candidate.client) &&
      Number.isSafeInteger(candidate.clock));
  return (
    id(value.item) &&
    id(value.type) &&
    (value.tname === undefined ||
      value.tname === null ||
      (typeof value.tname === "string" && value.tname.length <= 64)) &&
    (value.assoc === undefined || Number.isSafeInteger(value.assoc))
  );
}

function sanitizeCursor(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return isRelativePositionJSON(value.anchor) &&
    isRelativePositionJSON(value.head)
    ? { anchor: value.anchor, head: value.head }
    : null;
}

/** At most ~8 cursor messages per second (the runtime allows 30). */
const CURSOR_FLUSH_MS = 120;

export interface RemoteCursorAwareness extends CodeAwarenessLike {
  destroy(): void;
}

/**
 * The awareness object handed to `yCollab`: remote states are reduced to a
 * sanitized `{ cursor, user: { name, color, colorLight } }`, and local
 * `cursor` writes are coalesced (trailing) to respect the message budget.
 */
export function createRemoteCursorAwareness(
  awareness: CodeAwarenessLike,
  identify: (
    state: Record<string, unknown>,
    clientID: number,
  ) => CodePresenceIdentity,
): RemoteCursorAwareness {
  let pending: { readonly value: unknown } | null = null;
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let lastFlush = 0;
  let destroyed = false;

  const flush = () => {
    timer = null;
    if (destroyed || pending === null) return;
    const { value } = pending;
    pending = null;
    lastFlush = Date.now();
    awareness.setLocalStateField("cursor", value);
  };

  return {
    get doc() {
      return awareness.doc;
    },
    destroy() {
      destroyed = true;
      if (timer !== null) globalThis.clearTimeout(timer);
      timer = null;
      pending = null;
    },
    getLocalState() {
      const state = awareness.getLocalState();
      if (state === null || pending === null) return state;
      return { ...state, cursor: pending.value };
    },
    getStates() {
      const sanitized = new Map<number, Record<string, unknown>>();
      for (const [clientID, state] of awareness.getStates()) {
        if (clientID === awareness.doc.clientID) {
          sanitized.set(clientID, state);
          continue;
        }
        if (!isRecord(state)) continue;
        const identity = identify(state, clientID);
        const { color, colorLight } = codeCursorColor(identity.tone);
        sanitized.set(clientID, {
          cursor: sanitizeCursor(state.cursor),
          user: { color, colorLight, name: identity.name },
        });
      }
      return sanitized;
    },
    off(event, listener) {
      awareness.off(event, listener);
    },
    on(event, listener) {
      awareness.on(event, listener);
    },
    setLocalStateField(field, value) {
      if (destroyed) return;
      if (field !== "cursor") {
        awareness.setLocalStateField(field, value);
        return;
      }
      pending = { value };
      if (timer !== null) return;
      const wait = Math.max(0, lastFlush + CURSOR_FLUSH_MS - Date.now());
      if (wait === 0) flush();
      else timer = globalThis.setTimeout(flush, wait);
    },
  };
}

/** Up to `limit` peers on one file, plus how many more are there. */
export function peersOnFile(
  peers: readonly CodePresencePeer[],
  fileId: string,
  limit = 3,
): { readonly extra: number; readonly shown: readonly CodePresencePeer[] } {
  const onFile = peers.filter((peer) => peer.fileId === fileId);
  return {
    extra: Math.max(0, onFile.length - limit),
    shown: onFile.slice(0, limit),
  };
}
