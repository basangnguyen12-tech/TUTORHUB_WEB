import { afterEach, describe, expect, it, vi } from "vitest";
import { fnv1aHash, mediaTileTone } from "../media/classroomSignals";
import {
  CODE_CURSOR_COLORS,
  createRemoteCursorAwareness,
  localPresenceIdentity,
  peersOnFile,
  publishLocalPresence,
  readCodePresencePeers,
  remotePresenceIdentity,
  sanitizeDisplayName,
  type CodeAwarenessLike,
  type CodePresenceRoster,
} from "./codePresence";

type Listener = (...args: never[]) => void;

class FakeAwareness implements CodeAwarenessLike {
  readonly doc = { clientID: 1 };
  readonly states = new Map<number, Record<string, unknown>>([[1, {}]]);
  readonly writes: Array<[string, unknown]> = [];
  private readonly listeners = new Set<Listener>();

  getLocalState() {
    return this.states.get(1) ?? null;
  }
  getStates() {
    return this.states;
  }
  on(_event: "change", listener: Listener) {
    this.listeners.add(listener);
  }
  off(_event: "change", listener: Listener) {
    this.listeners.delete(listener);
  }
  setLocalStateField(field: string, value: unknown) {
    this.writes.push([field, value]);
    this.states.set(1, { ...this.getLocalState(), [field]: value });
  }
}

const roster: CodePresenceRoster = {
  participants: [
    {
      display_name: "Cô Thu Hà",
      participant_key: "teacher-key-0001",
      roster_sequence: 1,
    },
    {
      display_name: "Minh Anh",
      participant_key: "student-key-0002",
      roster_sequence: 2,
    },
  ],
  roomInstanceID: "c5f918a5-a09e-4f94-9fab-fb0ab5702a4d",
  selfParticipantKey: "student-key-0002",
};

const salt = fnv1aHash(roster.roomInstanceID);

afterEach(() => vi.useRealTimers());

describe("code presence", () => {
  it("takes names and 8-tone slots from the server roster", () => {
    const self = localPresenceIdentity(roster, "fallback");
    expect(self).toEqual({
      name: "Minh Anh",
      participantKey: "student-key-0002",
      tone: mediaTileTone(2, salt),
    });
    expect(
      remotePresenceIdentity(
        {
          codePresence: { participantKey: "teacher-key-0001", tone: 7 },
          user: { displayName: "Ai đó giả danh" },
        },
        9,
        roster,
        "?",
      ),
    ).toEqual({ name: "Cô Thu Hà", tone: mediaTileTone(1, salt) });
  });

  it("treats only the server-stamped capability as the presenter", () => {
    const awareness = new FakeAwareness();
    awareness.states.set(2, {
      codePresence: {
        fileId: "file000000000001",
        line: 12,
        participantKey: "teacher-key-0001",
      },
      tutorhub: { capability: "present" },
    });
    awareness.states.set(3, {
      // A student claiming to present is not believed.
      codePresence: {
        fileId: "file000000000002",
        participantKey: "student-key-0002",
        presenter: true,
      },
      tutorhub: { capability: "view" },
    });
    const peers = readCodePresencePeers(awareness, roster, "?");
    expect(peers.map((peer) => [peer.clientID, peer.presenter])).toEqual([
      [2, true],
      [3, false],
    ]);
    expect(peers[0]).toMatchObject({
      fileId: "file000000000001",
      initial: "C",
      line: 12,
    });
    expect(peersOnFile(peers, "file000000000001")).toEqual({
      extra: 0,
      shown: [peers[0]],
    });
  });

  it("drops malformed presence fields and strips control characters", () => {
    const awareness = new FakeAwareness();
    awareness.states.set(4, {
      codePresence: { fileId: "../../x", line: -3, tone: 99 },
      user: { displayName: "Lan\u0007\n Anh" },
    });
    const [peer] = readCodePresencePeers(awareness, null, "Bạn học");
    expect(peer).toMatchObject({
      fileId: null,
      line: null,
      name: "Lan   Anh",
      tone: 99 % 8,
    });
    expect(sanitizeDisplayName("x".repeat(200))).toHaveLength(48);
    expect(sanitizeDisplayName("   ")).toBeNull();
  });

  it("hands the cursor binding a fixed palette instead of a peer colour", () => {
    const awareness = new FakeAwareness();
    const cursor = {
      anchor: {
        assoc: 0,
        item: { client: 5, clock: 3 },
        tname: null,
        type: null,
      },
      head: {
        assoc: 0,
        item: { client: 5, clock: 3 },
        tname: null,
        type: null,
      },
    };
    awareness.states.set(5, {
      cursor,
      user: {
        color: "red; background-image: url(https://evil.example/x)",
        name: "<img src=x>",
      },
    });
    awareness.states.set(6, { cursor: { anchor: 5, head: "x" } });
    const adapter = createRemoteCursorAwareness(awareness, () => ({
      name: "Minh Anh",
      tone: 3,
    }));
    const states = adapter.getStates();
    expect(states.get(5)).toEqual({
      cursor,
      user: {
        color: CODE_CURSOR_COLORS[3],
        colorLight: `${CODE_CURSOR_COLORS[3]}29`,
        name: "Minh Anh",
      },
    });
    expect(states.get(6)?.cursor).toBeNull();
    adapter.destroy();
  });

  it("coalesces local cursor writes under the runtime awareness budget", () => {
    vi.useFakeTimers();
    const awareness = new FakeAwareness();
    const adapter = createRemoteCursorAwareness(awareness, () => ({
      name: "x",
      tone: 0,
    }));
    for (let index = 0; index < 20; index += 1) {
      adapter.setLocalStateField("cursor", { anchor: index, head: index });
    }
    expect(
      awareness.writes.filter(([field]) => field === "cursor"),
    ).toHaveLength(1);
    expect(adapter.getLocalState()?.cursor).toEqual({ anchor: 19, head: 19 });
    vi.advanceTimersByTime(130);
    const cursors = awareness.writes.filter(([field]) => field === "cursor");
    expect(cursors).toHaveLength(2);
    expect(cursors[1]?.[1]).toEqual({ anchor: 19, head: 19 });
    adapter.destroy();
  });

  it("publishes only changed presence fields", () => {
    const awareness = new FakeAwareness();
    const presence = {
      fileId: "file000000000001",
      line: 4,
      name: "Minh Anh",
      participantKey: "student-key-0002",
      tone: 2,
    };
    publishLocalPresence(awareness, presence);
    publishLocalPresence(awareness, presence);
    expect(awareness.writes.map(([field]) => field)).toEqual([
      "user",
      "codePresence",
    ]);
    expect(awareness.getLocalState()).toMatchObject({
      codePresence: { fileId: "file000000000001", line: 4, tone: 2 },
      user: { displayName: "Minh Anh" },
    });
  });
});
