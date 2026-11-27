export const CLASSROOM_REACTION_TYPES = [
  "thumbs_up",
  "clap",
  "heart",
  "celebrate",
  "laugh",
  "surprised",
] as const;

export type ClassroomReactionType = (typeof CLASSROOM_REACTION_TYPES)[number];

export const CLASSROOM_INSTANCE_ROLES = [
  "host",
  "co_host",
  "teaching_assistant",
  "attendee",
] as const;

export type ClassroomInstanceRole = (typeof CLASSROOM_INSTANCE_ROLES)[number];

export const CLASSROOM_PARTICIPANT_CONNECTION_STATES = [
  "joining",
  "connected",
  "reconnecting",
] as const;

export type ClassroomParticipantConnectionState =
  (typeof CLASSROOM_PARTICIPANT_CONNECTION_STATES)[number];

export const REACTION_GROUP_WINDOW_MS = 750;
export const REACTION_TTL_MS = 10_000;
export const MAX_VISIBLE_REACTION_CLUSTERS = 3;
export const MAX_VISIBLE_REACTION_COUNT = 99;

const MAX_SNAPSHOT_PARTICIPANTS = 50;
const MAX_SNAPSHOT_HANDS = 50;
const MAX_SNAPSHOT_REACTION_CLUSTERS = 50;
const MAX_SNAPSHOT_PARTICIPANT_REACTIONS = 50;
const MAX_SERVER_REACTION_CLUSTER_COUNT = 100;
// A cluster starts at its first event but may expire from the last event
// accepted inside the grouping window. This matches the Core API tolerance.
const MAX_REACTION_CLUSTER_TTL_MS = REACTION_TTL_MS + REACTION_GROUP_WINDOW_MS;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ClassroomRosterParticipant {
  readonly participant_key: string;
  readonly roster_sequence: number;
  readonly display_name: string;
  readonly instance_role: ClassroomInstanceRole;
  readonly connection_state: ClassroomParticipantConnectionState;
  readonly moderation_operations?: ClassroomParticipantModerationOperations;
}

export interface ClassroomParticipantModerationOperations {
  readonly can_promote_co_host: boolean;
  readonly can_demote_co_host: boolean;
  readonly can_remote_mute: boolean;
  readonly can_remove: boolean;
}

export interface ClassroomRaisedHand {
  readonly participant_key: string;
  readonly signal_sequence: number;
  readonly raised_at: string;
}

/** Server-grouped, TTL-bounded reaction aggregate from the snapshot API. */
export interface ClassroomReactionCluster {
  readonly reaction: ClassroomReactionType;
  readonly count: number;
  readonly first_signal_sequence: number;
  readonly last_signal_sequence: number;
  readonly accepted_at: string;
  readonly expires_at: string;
}

/**
 * ROOM-STAGE-POLISH-04: the newest unexpired reaction of one active roster
 * participant, correlated only through the opaque participant key. It feeds a
 * decorative badge on that participant's own tile; room-level announcements
 * stay with the grouped reaction clusters.
 */
export interface ClassroomParticipantReaction {
  readonly participant_key: string;
  readonly reaction: ClassroomReactionType;
  readonly signal_sequence: number;
  readonly accepted_at: string;
  readonly expires_at: string;
}

/** Raw event model used by the deterministic 750 ms grouping reducer. */
export interface ClassroomReactionEvent {
  readonly event_id: string;
  readonly reaction: ClassroomReactionType;
  readonly signal_sequence: number;
  readonly accepted_at: string;
  readonly expires_at: string;
}

export interface ClassroomSignalViewerOperations {
  readonly can_raise_hand: boolean;
  readonly can_send_reaction: boolean;
  readonly can_moderate_hands: boolean;
  readonly can_lock_room?: boolean;
  readonly can_end_room?: boolean;
}

/**
 * Privacy-bounded server snapshot. User IDs, email addresses,
 * ParticipantSession IDs and provider identities deliberately have no place
 * in this projection contract.
 */
export interface ClassroomSignalSnapshot {
  readonly room_instance_id: string;
  readonly room_locked?: boolean;
  readonly projection_version: number;
  readonly last_signal_sequence: number;
  readonly self_participant_key: string;
  readonly viewer_operations: ClassroomSignalViewerOperations;
  readonly participants: readonly ClassroomRosterParticipant[];
  readonly raised_hands: readonly ClassroomRaisedHand[];
  readonly reaction_clusters: readonly ClassroomReactionCluster[];
  /** Optional: older Core API builds and fixtures omit it. */
  readonly participant_reactions?: readonly ClassroomParticipantReaction[];
  readonly server_time: string;
}

export interface ClassroomRaisedHandProjection extends ClassroomRaisedHand {
  readonly display_name: string;
  readonly queue_position: number;
}

export interface ClassroomReactionVisualCluster extends ClassroomReactionCluster {
  readonly cluster_id: string;
  readonly count_label: string;
}

export interface ClassroomReactionSummary {
  readonly reaction: ClassroomReactionType;
  readonly count: number;
  readonly count_label: string;
}

export interface ClassroomReactionProjection {
  readonly clusters: readonly ClassroomReactionVisualCluster[];
  readonly summary: readonly ClassroomReactionSummary[];
  readonly hidden_cluster_count: number;
}

export interface ClassroomSignalProjection {
  readonly room_instance_id: string;
  readonly room_locked?: boolean;
  readonly projection_version: number;
  readonly last_signal_sequence: number;
  readonly self_participant_key: string;
  readonly viewer_operations: ClassroomSignalViewerOperations;
  readonly roster: readonly ClassroomRosterParticipant[];
  readonly raised_hands: readonly ClassroomRaisedHandProjection[];
  readonly reactions: ClassroomReactionProjection;
  /**
   * Unexpired, roster-bound, newest-per-participant reactions ordered by
   * signal_sequence descending. Optional so hand-built fixtures stay valid;
   * `projectClassroomSignalSnapshot` always sets it.
   */
  readonly participant_reactions?: readonly ClassroomParticipantReaction[];
  readonly server_time: string;
}

/** ROOM-STAGE-POLISH-04: decorative signal state for one participant tile. */
export interface ClassroomTileSignal {
  readonly hand: {
    readonly queue_position: number;
    /** The queue number only adds information once two or more hands wait. */
    readonly show_position: boolean;
  } | null;
  readonly reaction: {
    readonly reaction: ClassroomReactionType;
    readonly signal_sequence: number;
  } | null;
}

export interface ClassroomSignalSequenceGap {
  readonly expected_sequence: number;
  readonly received_sequence: number;
  readonly missing_count: number;
}

export type ClassroomSignalSequenceDisposition = "duplicate" | "next" | "gap";

export type ClassroomSignalSnapshotValidation =
  | {
      readonly valid: true;
      readonly snapshot: ClassroomSignalSnapshot;
      readonly issues: readonly [];
    }
  | {
      readonly valid: false;
      readonly snapshot: null;
      readonly issues: readonly string[];
    };

export type ClassroomSignalSnapshotFoldResult =
  | {
      readonly status: "applied" | "unchanged";
      readonly projection: ClassroomSignalProjection;
      readonly sequence_gap: ClassroomSignalSequenceGap | null;
      readonly issues: readonly [];
    }
  | {
      readonly status: "stale";
      readonly projection: ClassroomSignalProjection;
      readonly sequence_gap: null;
      readonly issues: readonly [];
    }
  | {
      readonly status: "invalid";
      readonly projection: ClassroomSignalProjection | null;
      readonly sequence_gap: null;
      readonly issues: readonly string[];
    };

/** Validate an untrusted Core API snapshot before it reaches classroom UI state. */
export function validateClassroomSignalSnapshot(
  input: unknown,
): ClassroomSignalSnapshotValidation {
  const issues: string[] = [];
  if (!isRecord(input)) {
    return invalidSnapshot("snapshot must be an object");
  }

  const roomInstanceId = readUUID(
    input.room_instance_id,
    "room_instance_id",
    issues,
  );
  const projectionVersion = readPositiveInteger(
    input.projection_version,
    "projection_version",
    issues,
  );
  const lastSignalSequence = readNonNegativeInteger(
    input.last_signal_sequence,
    "last_signal_sequence",
    issues,
  );
  const selfParticipantKey = readParticipantKey(
    input.self_participant_key,
    "self_participant_key",
    issues,
  );
  const hasModerationProjection = containsModerationProjection(input);
  const roomLocked = readRoomLocked(
    input.room_locked,
    hasModerationProjection,
    issues,
  );
  const viewerOperations = readViewerOperations(
    input.viewer_operations,
    hasModerationProjection,
    issues,
  );
  const participants = readRoster(
    input.participants,
    hasModerationProjection,
    issues,
  );
  const raisedHands = readRaisedHands(input.raised_hands, issues);
  const reactionClusters = readReactionClusters(
    input.reaction_clusters,
    issues,
  );
  const participantReactions = readParticipantReactions(
    input.participant_reactions,
    issues,
  );
  const serverTime = readDateTime(input.server_time, "server_time", issues);

  const participantKeys = new Set<string>();
  for (const participant of participants) {
    if (participantKeys.has(participant.participant_key)) {
      issues.push("participants contains a duplicate participant_key");
    }
    participantKeys.add(participant.participant_key);
  }
  if (selfParticipantKey !== null && !participantKeys.has(selfParticipantKey)) {
    issues.push("self_participant_key is outside the roster");
  }

  const handKeys = new Set<string>();
  for (const hand of raisedHands) {
    if (!participantKeys.has(hand.participant_key)) {
      issues.push("raised_hands contains a participant outside the roster");
    }
    if (handKeys.has(hand.participant_key)) {
      issues.push(
        "raised_hands contains more than one active hand per participant",
      );
    }
    if (
      lastSignalSequence !== null &&
      hand.signal_sequence > lastSignalSequence
    ) {
      issues.push(
        "raised_hands contains a sequence after last_signal_sequence",
      );
    }
    handKeys.add(hand.participant_key);
  }

  const reactionKeys = new Set<string>();
  for (const cluster of reactionClusters) {
    const clusterKey = `${cluster.reaction}:${cluster.first_signal_sequence}`;
    if (reactionKeys.has(clusterKey)) {
      issues.push("reaction_clusters contains a duplicate cluster");
    }
    if (cluster.first_signal_sequence > cluster.last_signal_sequence) {
      issues.push(
        "reaction cluster first_signal_sequence must not exceed last_signal_sequence",
      );
    }
    if (
      lastSignalSequence !== null &&
      cluster.last_signal_sequence > lastSignalSequence
    ) {
      issues.push(
        "reaction_clusters contains a sequence after last_signal_sequence",
      );
    }
    const clusterTTL =
      dateTimeMs(cluster.expires_at) - dateTimeMs(cluster.accepted_at);
    if (clusterTTL <= 0) {
      issues.push("reaction cluster expires_at must be after accepted_at");
    } else if (clusterTTL > MAX_REACTION_CLUSTER_TTL_MS) {
      issues.push(
        `reaction cluster TTL must not exceed ${MAX_REACTION_CLUSTER_TTL_MS} milliseconds`,
      );
    }
    reactionKeys.add(clusterKey);
  }

  for (const reaction of participantReactions ?? []) {
    if (!participantKeys.has(reaction.participant_key)) {
      issues.push(
        "participant_reactions contains a participant outside the roster",
      );
    }
    if (
      lastSignalSequence !== null &&
      reaction.signal_sequence > lastSignalSequence
    ) {
      issues.push(
        "participant_reactions contains a sequence after last_signal_sequence",
      );
    }
    const reactionTTL =
      dateTimeMs(reaction.expires_at) - dateTimeMs(reaction.accepted_at);
    if (reactionTTL <= 0) {
      issues.push("participant reaction expires_at must be after accepted_at");
    } else if (reactionTTL > REACTION_TTL_MS) {
      issues.push(
        `participant reaction TTL must not exceed ${REACTION_TTL_MS} milliseconds`,
      );
    }
  }

  if (
    issues.length > 0 ||
    roomInstanceId === null ||
    projectionVersion === null ||
    lastSignalSequence === null ||
    selfParticipantKey === null ||
    viewerOperations === null ||
    serverTime === null
  ) {
    return {
      valid: false,
      snapshot: null,
      issues,
    };
  }

  return {
    valid: true,
    snapshot: {
      room_instance_id: roomInstanceId,
      ...(roomLocked === undefined ? {} : { room_locked: roomLocked }),
      projection_version: projectionVersion,
      last_signal_sequence: lastSignalSequence,
      self_participant_key: selfParticipantKey,
      viewer_operations: viewerOperations,
      participants,
      raised_hands: raisedHands,
      reaction_clusters: reactionClusters,
      ...(participantReactions === undefined
        ? {}
        : { participant_reactions: participantReactions }),
      server_time: serverTime,
    },
    issues: [],
  };
}

/**
 * Fold an authoritative full snapshot. Older snapshots never overwrite a
 * newer projection. A sequence jump is reported for observability, while the
 * accepted full snapshot itself closes that gap.
 */
export function foldClassroomSignalSnapshot(
  current: ClassroomSignalProjection | null,
  incoming: unknown,
  serverNowMs: number,
): ClassroomSignalSnapshotFoldResult {
  const validation = validateClassroomSignalSnapshot(incoming);
  if (!validation.valid) {
    return {
      status: "invalid",
      projection: current,
      sequence_gap: null,
      issues: validation.issues,
    };
  }

  const snapshot = validation.snapshot;
  if (current && snapshotIsOlder(current, snapshot)) {
    return {
      status: "stale",
      projection: current,
      sequence_gap: null,
      issues: [],
    };
  }

  const unchanged = Boolean(
    current &&
    snapshot.projection_version === current.projection_version &&
    snapshot.last_signal_sequence === current.last_signal_sequence,
  );
  const sequenceGap =
    current && snapshot.last_signal_sequence > current.last_signal_sequence
      ? identifyClassroomSignalSequenceGap(
          current.last_signal_sequence,
          snapshot.last_signal_sequence,
        )
      : null;

  return {
    status: unchanged ? "unchanged" : "applied",
    projection: projectClassroomSignalSnapshot(snapshot, serverNowMs),
    sequence_gap: sequenceGap,
    issues: [],
  };
}

export function projectClassroomSignalSnapshot(
  snapshot: ClassroomSignalSnapshot,
  serverNowMs: number,
): ClassroomSignalProjection {
  assertFiniteTime(serverNowMs, "Classroom signal projection time");
  const roster = sortCanonicalRoster(snapshot.participants);
  return {
    room_instance_id: snapshot.room_instance_id,
    ...(snapshot.room_locked === undefined
      ? {}
      : { room_locked: snapshot.room_locked }),
    projection_version: snapshot.projection_version,
    last_signal_sequence: snapshot.last_signal_sequence,
    self_participant_key: snapshot.self_participant_key,
    viewer_operations: snapshot.viewer_operations,
    roster,
    raised_hands: projectRaisedHandQueue(snapshot.raised_hands, roster),
    reactions: projectReactionClusters(snapshot.reaction_clusters, serverNowMs),
    participant_reactions: projectParticipantReactions(
      snapshot.participant_reactions ?? [],
      roster,
      serverNowMs,
    ),
    server_time: snapshot.server_time,
  };
}

export function sortCanonicalRoster(
  participants: readonly ClassroomRosterParticipant[],
): readonly ClassroomRosterParticipant[] {
  return [...participants].sort(
    (left, right) =>
      left.roster_sequence - right.roster_sequence ||
      left.participant_key.localeCompare(right.participant_key),
  );
}

export function projectRaisedHandQueue(
  raisedHands: readonly ClassroomRaisedHand[],
  roster: readonly ClassroomRosterParticipant[],
): readonly ClassroomRaisedHandProjection[] {
  const displayNames = new Map(
    roster.map(({ participant_key, display_name }) => [
      participant_key,
      display_name,
    ]),
  );
  let queuePosition = 0;

  return [...raisedHands]
    .sort(
      (left, right) =>
        left.signal_sequence - right.signal_sequence ||
        left.participant_key.localeCompare(right.participant_key),
    )
    .flatMap((hand) => {
      const displayName = displayNames.get(hand.participant_key);
      if (!displayName) {
        return [];
      }
      queuePosition += 1;
      return [
        {
          ...hand,
          display_name: displayName,
          queue_position: queuePosition,
        },
      ];
    });
}

/**
 * Keep the newest unexpired allowlisted reaction for every participant still
 * in the roster, newest first. Bounded by the 50-participant roster.
 */
export function projectParticipantReactions(
  reactions: readonly ClassroomParticipantReaction[],
  roster: readonly ClassroomRosterParticipant[],
  serverNowMs: number,
): readonly ClassroomParticipantReaction[] {
  assertFiniteTime(serverNowMs, "Participant reaction projection time");
  const rosterKeys = new Set(
    roster.map(({ participant_key }) => participant_key),
  );
  const newest = new Map<string, ClassroomParticipantReaction>();
  for (const reaction of reactions) {
    if (
      !rosterKeys.has(reaction.participant_key) ||
      !isClassroomReactionType(reaction.reaction) ||
      !(dateTimeMs(reaction.expires_at) > serverNowMs)
    ) {
      continue;
    }
    const current = newest.get(reaction.participant_key);
    if (!current || reaction.signal_sequence > current.signal_sequence) {
      newest.set(reaction.participant_key, reaction);
    }
  }
  return [...newest.values()]
    .sort(
      (left, right) =>
        right.signal_sequence - left.signal_sequence ||
        left.participant_key.localeCompare(right.participant_key),
    )
    .slice(0, MAX_SNAPSHOT_PARTICIPANT_REACTIONS);
}

/**
 * ROOM-STAGE-POLISH-04: index the raised-hand queue and per-participant
 * reactions by opaque participant key, so each video tile can look up its own
 * top-right badges in O(1). Media items carry the same key as their id once
 * the server roster is authoritative.
 */
export function projectTileSignals(
  projection:
    | Pick<ClassroomSignalProjection, "participant_reactions" | "raised_hands">
    | null
    | undefined,
): ReadonlyMap<string, ClassroomTileSignal> {
  const tiles = new Map<string, ClassroomTileSignal>();
  if (!projection) return tiles;
  const showPosition = projection.raised_hands.length >= 2;
  for (const hand of projection.raised_hands) {
    tiles.set(hand.participant_key, {
      hand: {
        queue_position: hand.queue_position,
        show_position: showPosition,
      },
      reaction: null,
    });
  }
  for (const reaction of projection.participant_reactions ?? []) {
    if (!isClassroomReactionType(reaction.reaction)) continue;
    const current = tiles.get(reaction.participant_key);
    if (
      current?.reaction &&
      current.reaction.signal_sequence >= reaction.signal_sequence
    ) {
      continue;
    }
    tiles.set(reaction.participant_key, {
      hand: current?.hand ?? null,
      reaction: {
        reaction: reaction.reaction,
        signal_sequence: reaction.signal_sequence,
      },
    });
  }
  return tiles;
}

/**
 * Project server-grouped reactions. Only the newest three clusters can create
 * visual nodes; the summary remains bounded to the six allowlisted enums.
 */
export function projectReactionClusters(
  clusters: readonly ClassroomReactionCluster[],
  serverNowMs: number,
): ClassroomReactionProjection {
  assertFiniteTime(serverNowMs, "Reaction projection time");
  const active = [...clusters]
    .filter((cluster) => dateTimeMs(cluster.expires_at) > serverNowMs)
    .sort(compareReactionClusters);
  const visible = active.slice(-MAX_VISIBLE_REACTION_CLUSTERS);
  const totals = new Map<ClassroomReactionType, number>();

  for (const cluster of active) {
    totals.set(
      cluster.reaction,
      (totals.get(cluster.reaction) ?? 0) + cluster.count,
    );
  }

  return {
    clusters: visible.map((cluster) => ({
      ...cluster,
      cluster_id: `${cluster.reaction}:${cluster.first_signal_sequence}`,
      count_label: visibleReactionCount(cluster.count),
    })),
    summary: CLASSROOM_REACTION_TYPES.flatMap((reaction) => {
      const count = totals.get(reaction) ?? 0;
      return count > 0
        ? [
            {
              reaction,
              count,
              count_label: visibleReactionCount(count),
            },
          ]
        : [];
    }),
    hidden_cluster_count: Math.max(0, active.length - visible.length),
  };
}

/**
 * Deterministic model of the server grouping rule. A cluster uses a fixed
 * 750 ms window anchored at its first event, preventing a continuous stream
 * from extending one burst forever.
 */
export function groupClassroomReactionEvents(
  events: readonly ClassroomReactionEvent[],
): readonly ClassroomReactionCluster[] {
  const sorted = [...events].sort(compareReactionEvents);
  const allClusters: MutableReactionCluster[] = [];
  const latestClusterByReaction = new Map<
    ClassroomReactionType,
    MutableReactionCluster
  >();

  for (const event of sorted) {
    const acceptedAtMs = dateTimeMs(event.accepted_at);
    const latest = latestClusterByReaction.get(event.reaction);
    if (
      latest &&
      acceptedAtMs - latest.windowStartedAtMs <= REACTION_GROUP_WINDOW_MS
    ) {
      latest.count += 1;
      latest.last_signal_sequence = Math.max(
        latest.last_signal_sequence,
        event.signal_sequence,
      );
      if (dateTimeMs(event.expires_at) > latest.expiresAtMs) {
        latest.expires_at = event.expires_at;
        latest.expiresAtMs = dateTimeMs(event.expires_at);
      }
      continue;
    }

    const cluster: MutableReactionCluster = {
      reaction: event.reaction,
      count: 1,
      first_signal_sequence: event.signal_sequence,
      last_signal_sequence: event.signal_sequence,
      accepted_at: event.accepted_at,
      windowStartedAtMs: acceptedAtMs,
      expires_at: event.expires_at,
      expiresAtMs: dateTimeMs(event.expires_at),
    };
    allClusters.push(cluster);
    latestClusterByReaction.set(event.reaction, cluster);
  }

  return allClusters.map(finishReactionCluster);
}

export function classifyClassroomSignalSequence(
  lastSequence: number,
  receivedSequence: number,
): ClassroomSignalSequenceDisposition {
  if (!isNonNegativeInteger(lastSequence)) {
    throw new TypeError("lastSequence must be a non-negative safe integer.");
  }
  if (!isPositiveInteger(receivedSequence)) {
    throw new TypeError("receivedSequence must be a positive safe integer.");
  }
  if (receivedSequence <= lastSequence) {
    return "duplicate";
  }
  return receivedSequence === lastSequence + 1 ? "next" : "gap";
}

export function identifyClassroomSignalSequenceGap(
  lastSequence: number,
  receivedSequence: number,
): ClassroomSignalSequenceGap | null {
  if (
    classifyClassroomSignalSequence(lastSequence, receivedSequence) !== "gap"
  ) {
    return null;
  }
  return {
    expected_sequence: lastSequence + 1,
    received_sequence: receivedSequence,
    missing_count: receivedSequence - lastSequence - 1,
  };
}

export function visibleReactionCount(count: number): string {
  const bounded = Math.max(0, Math.trunc(Number.isFinite(count) ? count : 0));
  return bounded > MAX_VISIBLE_REACTION_COUNT
    ? `${MAX_VISIBLE_REACTION_COUNT}+`
    : String(bounded);
}

interface MutableReactionCluster {
  readonly reaction: ClassroomReactionType;
  count: number;
  readonly first_signal_sequence: number;
  last_signal_sequence: number;
  accepted_at: string;
  readonly windowStartedAtMs: number;
  expires_at: string;
  expiresAtMs: number;
}

function finishReactionCluster(
  cluster: MutableReactionCluster,
): ClassroomReactionCluster {
  return {
    reaction: cluster.reaction,
    count: cluster.count,
    first_signal_sequence: cluster.first_signal_sequence,
    last_signal_sequence: cluster.last_signal_sequence,
    accepted_at: cluster.accepted_at,
    expires_at: cluster.expires_at,
  };
}

function snapshotIsOlder(
  current: ClassroomSignalProjection,
  incoming: ClassroomSignalSnapshot,
): boolean {
  return (
    incoming.projection_version < current.projection_version ||
    (incoming.projection_version === current.projection_version &&
      incoming.last_signal_sequence < current.last_signal_sequence)
  );
}

function compareReactionEvents(
  left: ClassroomReactionEvent,
  right: ClassroomReactionEvent,
): number {
  return (
    dateTimeMs(left.accepted_at) - dateTimeMs(right.accepted_at) ||
    left.signal_sequence - right.signal_sequence ||
    left.event_id.localeCompare(right.event_id)
  );
}

function compareReactionClusters(
  left: ClassroomReactionCluster,
  right: ClassroomReactionCluster,
): number {
  return (
    dateTimeMs(left.accepted_at) - dateTimeMs(right.accepted_at) ||
    left.first_signal_sequence - right.first_signal_sequence ||
    left.reaction.localeCompare(right.reaction)
  );
}

function containsModerationProjection(input: Record<string, unknown>): boolean {
  if (input.room_locked !== undefined) return true;
  if (isRecord(input.viewer_operations)) {
    if (
      input.viewer_operations.can_lock_room !== undefined ||
      input.viewer_operations.can_end_room !== undefined
    ) {
      return true;
    }
  }
  return (
    Array.isArray(input.participants) &&
    input.participants.some(
      (participant) =>
        isRecord(participant) &&
        participant.moderation_operations !== undefined,
    )
  );
}

function readRoomLocked(
  input: unknown,
  required: boolean,
  issues: string[],
): boolean | undefined {
  if (input === undefined && !required) return undefined;
  if (typeof input !== "boolean") {
    issues.push("room_locked must be a boolean");
    return undefined;
  }
  return input;
}

function readViewerOperations(
  input: unknown,
  moderationRequired: boolean,
  issues: string[],
): ClassroomSignalViewerOperations | null {
  if (!isRecord(input)) {
    issues.push("viewer_operations must be an object");
    return null;
  }
  const fields = [
    "can_raise_hand",
    "can_send_reaction",
    "can_moderate_hands",
  ] as const;
  const moderationFields = ["can_lock_room", "can_end_room"] as const;
  for (const field of fields) {
    if (typeof input[field] !== "boolean") {
      issues.push(`viewer_operations.${field} must be a boolean`);
    }
  }
  if (moderationRequired) {
    for (const field of moderationFields) {
      if (typeof input[field] !== "boolean") {
        issues.push(`viewer_operations.${field} must be a boolean`);
      }
    }
  }
  if (!fields.every((field) => typeof input[field] === "boolean")) {
    return null;
  }
  if (
    moderationRequired &&
    !moderationFields.every((field) => typeof input[field] === "boolean")
  ) {
    return null;
  }
  return {
    can_raise_hand: input.can_raise_hand as boolean,
    can_send_reaction: input.can_send_reaction as boolean,
    can_moderate_hands: input.can_moderate_hands as boolean,
    ...(moderationRequired
      ? {
          can_lock_room: input.can_lock_room as boolean,
          can_end_room: input.can_end_room as boolean,
        }
      : {}),
  };
}

function readRoster(
  input: unknown,
  moderationRequired: boolean,
  issues: string[],
): readonly ClassroomRosterParticipant[] {
  if (!boundedArray(input, MAX_SNAPSHOT_PARTICIPANTS)) {
    issues.push(
      `participants must be an array with at most ${MAX_SNAPSHOT_PARTICIPANTS} items`,
    );
    return [];
  }
  return input.flatMap((value, index) => {
    if (!isRecord(value)) {
      issues.push(`participants[${index}] must be an object`);
      return [];
    }
    const participantKey = readParticipantKey(
      value.participant_key,
      `participants[${index}].participant_key`,
      issues,
    );
    const rosterSequence = readPositiveInteger(
      value.roster_sequence,
      `participants[${index}].roster_sequence`,
      issues,
    );
    const displayName = readBoundedString(
      value.display_name,
      `participants[${index}].display_name`,
      200,
      issues,
    );
    const instanceRole = value.instance_role;
    if (!isClassroomInstanceRole(instanceRole)) {
      issues.push(`participants[${index}].instance_role is not allowed`);
    }
    const connectionState = value.connection_state;
    if (!isParticipantConnectionState(connectionState)) {
      issues.push(`participants[${index}].connection_state is not allowed`);
    }
    const moderationOperations = readParticipantModerationOperations(
      value.moderation_operations,
      moderationRequired,
      index,
      issues,
    );
    if (
      participantKey === null ||
      rosterSequence === null ||
      displayName === null ||
      !isClassroomInstanceRole(instanceRole) ||
      !isParticipantConnectionState(connectionState) ||
      (moderationRequired && moderationOperations === undefined)
    ) {
      return [];
    }
    return [
      {
        participant_key: participantKey,
        roster_sequence: rosterSequence,
        display_name: displayName,
        instance_role: instanceRole,
        connection_state: connectionState,
        ...(moderationOperations === undefined
          ? {}
          : { moderation_operations: moderationOperations }),
      },
    ];
  });
}

function readParticipantModerationOperations(
  input: unknown,
  required: boolean,
  participantIndex: number,
  issues: string[],
): ClassroomParticipantModerationOperations | undefined {
  if (input === undefined && !required) return undefined;
  if (!isRecord(input)) {
    issues.push(
      `participants[${participantIndex}].moderation_operations must be an object`,
    );
    return undefined;
  }
  const fields = [
    "can_promote_co_host",
    "can_demote_co_host",
    "can_remote_mute",
    "can_remove",
  ] as const;
  for (const field of fields) {
    if (typeof input[field] !== "boolean") {
      issues.push(
        `participants[${participantIndex}].moderation_operations.${field} must be a boolean`,
      );
    }
  }
  if (!fields.every((field) => typeof input[field] === "boolean")) {
    return undefined;
  }
  return {
    can_promote_co_host: input.can_promote_co_host as boolean,
    can_demote_co_host: input.can_demote_co_host as boolean,
    can_remote_mute: input.can_remote_mute as boolean,
    can_remove: input.can_remove as boolean,
  };
}

function readRaisedHands(
  input: unknown,
  issues: string[],
): readonly ClassroomRaisedHand[] {
  if (!boundedArray(input, MAX_SNAPSHOT_HANDS)) {
    issues.push(
      `raised_hands must be an array with at most ${MAX_SNAPSHOT_HANDS} items`,
    );
    return [];
  }
  return input.flatMap((value, index) => {
    if (!isRecord(value)) {
      issues.push(`raised_hands[${index}] must be an object`);
      return [];
    }
    const participantKey = readParticipantKey(
      value.participant_key,
      `raised_hands[${index}].participant_key`,
      issues,
    );
    const signalSequence = readPositiveInteger(
      value.signal_sequence,
      `raised_hands[${index}].signal_sequence`,
      issues,
    );
    const raisedAt = readDateTime(
      value.raised_at,
      `raised_hands[${index}].raised_at`,
      issues,
    );
    if (
      participantKey === null ||
      signalSequence === null ||
      raisedAt === null
    ) {
      return [];
    }
    return [
      {
        participant_key: participantKey,
        signal_sequence: signalSequence,
        raised_at: raisedAt,
      },
    ];
  });
}

function readReactionClusters(
  input: unknown,
  issues: string[],
): readonly ClassroomReactionCluster[] {
  if (!boundedArray(input, MAX_SNAPSHOT_REACTION_CLUSTERS)) {
    issues.push(
      `reaction_clusters must be an array with at most ${MAX_SNAPSHOT_REACTION_CLUSTERS} items`,
    );
    return [];
  }
  return input.flatMap((value, index) => {
    if (!isRecord(value)) {
      issues.push(`reaction_clusters[${index}] must be an object`);
      return [];
    }
    const reaction = value.reaction;
    if (!isClassroomReactionType(reaction)) {
      issues.push(`reaction_clusters[${index}].reaction is not allowed`);
    }
    const count = readBoundedPositiveInteger(
      value.count,
      `reaction_clusters[${index}].count`,
      MAX_SERVER_REACTION_CLUSTER_COUNT,
      issues,
    );
    const firstSignalSequence = readPositiveInteger(
      value.first_signal_sequence,
      `reaction_clusters[${index}].first_signal_sequence`,
      issues,
    );
    const lastSignalSequence = readPositiveInteger(
      value.last_signal_sequence,
      `reaction_clusters[${index}].last_signal_sequence`,
      issues,
    );
    const acceptedAt = readDateTime(
      value.accepted_at,
      `reaction_clusters[${index}].accepted_at`,
      issues,
    );
    const expiresAt = readDateTime(
      value.expires_at,
      `reaction_clusters[${index}].expires_at`,
      issues,
    );
    if (
      !isClassroomReactionType(reaction) ||
      count === null ||
      firstSignalSequence === null ||
      lastSignalSequence === null ||
      acceptedAt === null ||
      expiresAt === null
    ) {
      return [];
    }
    return [
      {
        reaction,
        count,
        first_signal_sequence: firstSignalSequence,
        last_signal_sequence: lastSignalSequence,
        accepted_at: acceptedAt,
        expires_at: expiresAt,
      },
    ];
  });
}

/** Optional array: `undefined` when the server omitted the field. */
function readParticipantReactions(
  input: unknown,
  issues: string[],
): readonly ClassroomParticipantReaction[] | undefined {
  if (input === undefined) return undefined;
  if (!boundedArray(input, MAX_SNAPSHOT_PARTICIPANT_REACTIONS)) {
    issues.push(
      `participant_reactions must be an array with at most ${MAX_SNAPSHOT_PARTICIPANT_REACTIONS} items`,
    );
    return [];
  }
  return input.flatMap((value, index) => {
    if (!isRecord(value)) {
      issues.push(`participant_reactions[${index}] must be an object`);
      return [];
    }
    const participantKey = readParticipantKey(
      value.participant_key,
      `participant_reactions[${index}].participant_key`,
      issues,
    );
    const reaction = value.reaction;
    if (!isClassroomReactionType(reaction)) {
      issues.push(`participant_reactions[${index}].reaction is not allowed`);
    }
    const signalSequence = readPositiveInteger(
      value.signal_sequence,
      `participant_reactions[${index}].signal_sequence`,
      issues,
    );
    const acceptedAt = readDateTime(
      value.accepted_at,
      `participant_reactions[${index}].accepted_at`,
      issues,
    );
    const expiresAt = readDateTime(
      value.expires_at,
      `participant_reactions[${index}].expires_at`,
      issues,
    );
    if (
      participantKey === null ||
      !isClassroomReactionType(reaction) ||
      signalSequence === null ||
      acceptedAt === null ||
      expiresAt === null
    ) {
      return [];
    }
    return [
      {
        participant_key: participantKey,
        reaction,
        signal_sequence: signalSequence,
        accepted_at: acceptedAt,
        expires_at: expiresAt,
      },
    ];
  });
}

function readParticipantKey(
  input: unknown,
  path: string,
  issues: string[],
): string | null {
  return readUUID(input, path, issues);
}

function readUUID(
  input: unknown,
  path: string,
  issues: string[],
): string | null {
  if (typeof input !== "string" || !UUID_PATTERN.test(input)) {
    issues.push(`${path} must be a UUID`);
    return null;
  }
  return input;
}

function readBoundedString(
  input: unknown,
  path: string,
  maxLength: number,
  issues: string[],
): string | null {
  if (
    typeof input !== "string" ||
    input.trim().length === 0 ||
    Array.from(input).length > maxLength
  ) {
    issues.push(
      `${path} must be a non-empty string of at most ${maxLength} Unicode code points`,
    );
    return null;
  }
  return input;
}

function readDateTime(
  input: unknown,
  path: string,
  issues: string[],
): string | null {
  if (typeof input !== "string" || !Number.isFinite(Date.parse(input))) {
    issues.push(`${path} must be a valid date-time`);
    return null;
  }
  return input;
}

function readPositiveInteger(
  input: unknown,
  path: string,
  issues: string[],
): number | null {
  if (!isPositiveInteger(input)) {
    issues.push(`${path} must be a positive safe integer`);
    return null;
  }
  return input;
}

function readBoundedPositiveInteger(
  input: unknown,
  path: string,
  maximum: number,
  issues: string[],
): number | null {
  const value = readPositiveInteger(input, path, issues);
  if (value !== null && value > maximum) {
    issues.push(`${path} must not exceed ${maximum}`);
    return null;
  }
  return value;
}

function readNonNegativeInteger(
  input: unknown,
  path: string,
  issues: string[],
): number | null {
  if (!isNonNegativeInteger(input)) {
    issues.push(`${path} must be a non-negative safe integer`);
    return null;
  }
  return input;
}

function assertFiniteTime(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite.`);
  }
}

function dateTimeMs(value: string): number {
  return Date.parse(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isClassroomReactionType(
  value: unknown,
): value is ClassroomReactionType {
  return CLASSROOM_REACTION_TYPES.some((reaction) => reaction === value);
}

function isClassroomInstanceRole(
  value: unknown,
): value is ClassroomInstanceRole {
  return CLASSROOM_INSTANCE_ROLES.some((role) => role === value);
}

function isParticipantConnectionState(
  value: unknown,
): value is ClassroomParticipantConnectionState {
  return CLASSROOM_PARTICIPANT_CONNECTION_STATES.some(
    (state) => state === value,
  );
}

function boundedArray(
  value: unknown,
  maximum: number,
): value is readonly unknown[] {
  return Array.isArray(value) && value.length <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ROOM-STAGE-POLISH-04: eight Meet-style camera-off surfaces (tile + avatar). */
export const MEDIA_TILE_TONE_COUNT = 8;

/**
 * Deterministic 0–7 palette slot shared by video tiles and People panel rows
 * so each participant keeps the exact same Google Meet tone everywhere.
 */
export function mediaTileTone(sequence: number, salt: number): number {
  const slot = (salt + sequence) % MEDIA_TILE_TONE_COUNT;
  return slot < 0 ? slot + MEDIA_TILE_TONE_COUNT : slot;
}

/**
 * ROOM-TILE-TEAMS-01: honorifics and academic titles that lead a display name
 * ("ThS. Lê Văn Tuấn", "Dr. Ann Lee"). They are dropped before initials are
 * taken, but only while at least one real name word remains.
 */
const NAME_TITLE_PREFIXES = new Set([
  "bs",
  "cn",
  "dr",
  "gs",
  "gsts",
  "ks",
  "miss",
  "mr",
  "mrs",
  "ms",
  "mx",
  "pgs",
  "pgsts",
  "prof",
  "ths",
  "ts",
  "tskh",
]);

/** First letter or digit of a word, with any combining marks it carries. */
const INITIAL_PATTERN = /[\p{L}\p{N}]\p{M}*/u;

/**
 * ROOM-TILE-TEAMS-01: Microsoft Teams style initials for a camera-off
 * avatar. Bracketed asides ("(Unverified)", "[Khách]") and leading titles are
 * ignored; two or more words give the first letter of the first and of the
 * last word, one word gives one letter, nothing readable gives "?". Letters
 * are upper-cased with Vietnamese rules ("đào thế dũng" → "ĐD").
 */
export function participantInitials(displayName: string): string {
  const normalized = displayName.normalize("NFC");
  const withoutAsides = normalized
    .replace(/\([^()]*\)|\[[^[\]]*\]/gu, " ")
    .replace(/[()[\]]/gu, " ");
  const words = (withoutAsides.trim() ? withoutAsides : normalized)
    .split(/\s+/u)
    .filter((word) => INITIAL_PATTERN.test(word));
  while (
    words.length > 1 &&
    NAME_TITLE_PREFIXES.has(
      (words[0] ?? "").toLocaleLowerCase("vi").replace(/[^\p{L}]/gu, ""),
    )
  ) {
    words.shift();
  }
  const initial = (word: string | undefined) =>
    word?.match(INITIAL_PATTERN)?.[0] ?? "";
  const letters =
    words.length > 1
      ? `${initial(words[0])}${initial(words[words.length - 1])}`
      : initial(words[0]);
  return letters ? letters.toLocaleUpperCase("vi") : "?";
}

/** 32-bit FNV-1a over UTF-16 code units: small, fast and well spread. */
export function fnv1aHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function invalidSnapshot(issue: string): ClassroomSignalSnapshotValidation {
  return {
    valid: false,
    snapshot: null,
    issues: [issue],
  };
}
