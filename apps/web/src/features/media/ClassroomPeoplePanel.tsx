import { Button, IconButton, Skeleton, SkeletonGroup } from "@tutorhub/ui";
import {
  ChevronUp,
  Hand,
  Highlighter,
  MicOff,
  Pencil,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useI18n, type TranslationKey } from "../../app/i18n";
import {
  MediaLobbyFilterContext,
  type MediaLobbyFilter,
} from "../../components/MediaLobbyPanel";
import {
  ClassroomCodeEditorGrantsContext,
  type ClassroomCodeEditorGrantsModel,
} from "../classroom-tools/codeEditorGrantsContext";
import {
  ClassroomPdfAnnotatorGrantsContext,
  type ClassroomPdfAnnotatorGrantsModel,
} from "../classroom-tools/pdfAnnotatorGrantsContext";
import { normalizeEmojiSearch } from "./classroomChatMedia";
import {
  ClassroomParticipantModerationMenu,
  type ClassroomModerationControlsModel,
  type ClassroomParticipantCodeGrantAction,
  type ClassroomParticipantPdfGrantAction,
} from "./ClassroomModerationControls";
import {
  fnv1aHash,
  mediaTileTone,
  type ClassroomInstanceRole,
  type ClassroomRaisedHandProjection,
  type ClassroomRosterParticipant,
  type ClassroomSignalProjection,
} from "./classroomSignals";

/** The slice of the shell's signal controls the People panel reads. */
export interface ClassroomPeopleSignals {
  readonly error: boolean;
  readonly loading: boolean;
  readonly mutating: boolean;
  readonly projection: ClassroomSignalProjection | null;
  readonly refreshing: boolean;
  readonly onResync: () => Promise<unknown>;
}

/**
 * Per-person media presentation joined by the shell from the server-signed
 * `tutorhub.participant_key` LiveKit attribute. Unknown fields render nothing.
 */
export interface ClassroomPeopleMediaState {
  readonly microphoneEnabled?: boolean;
  readonly speaking?: boolean;
}

export interface ClassroomPeoplePanelProps {
  readonly lobby?: ReactNode;
  readonly mediaStates?: ReadonlyMap<string, ClassroomPeopleMediaState>;
  readonly moderation?: ClassroomModerationControlsModel;
  readonly moderationDisabled: boolean;
  readonly signals?: ClassroomPeopleSignals;
  readonly onLowerAll: () => void;
  readonly onLowerHand: (participantKey: string) => void;
}

type PeopleGroupID = "staff" | "students" | "everyone";

interface PeopleGroup {
  readonly id: PeopleGroupID;
  readonly label: TranslationKey;
  readonly people: readonly ClassroomRosterParticipant[];
}

const STAFF_ROLES: ReadonlySet<ClassroomInstanceRole> = new Set([
  "host",
  "co_host",
  "teaching_assistant",
]);

/** A routine poll is quick; only a sync that lingers earns an indicator. */
const SLOW_SYNC_MS = 700;

/**
 * ROOM-PEOPLE-03 — the classroom People inspector body (Google Meet ×
 * Microsoft Teams × Zoom): one accent-insensitive search for both the waiting
 * group and the class, collapsible groups with counts, 52px rows without
 * cards or numbering, hover/focus-revealed row actions and a pinned host
 * footer. Order stays server-owned: you first, then raised hands in FIFO
 * queue order, then `roster_sequence`.
 */
export function ClassroomPeoplePanel({
  lobby,
  mediaStates,
  moderation,
  moderationDisabled,
  signals,
  onLowerAll,
  onLowerHand,
}: ClassroomPeoplePanelProps) {
  const { t } = useI18n();
  const baseID = useId();
  const [query, setQuery] = useState("");
  const [lobbyMatches, setLobbyMatches] = useState(0);
  const [collapsed, setCollapsed] = useState<
    Readonly<Partial<Record<PeopleGroupID, boolean>>>
  >({});
  const slowSync = useDelayedFlag(Boolean(signals?.refreshing), SLOW_SYNC_MS);
  // ROOM-TOOLS-CODE-02B: temporary shared-Code edit grants (room context).
  const codeGrants = useContext(ClassroomCodeEditorGrantsContext);
  // ROOM-TOOLS-FILES-02B: temporary PDF annotator grants (room context).
  const pdfGrants = useContext(ClassroomPdfAnnotatorGrantsContext);

  const normalizedQuery = normalizeEmojiSearch(query);
  const filterActive = normalizedQuery !== "";
  const lobbyFilter = useMemo<MediaLobbyFilter>(
    () => ({
      active: normalizedQuery !== "",
      matches: (displayName) =>
        normalizeEmojiSearch(displayName).includes(normalizedQuery),
      onMatchCountChange: setLobbyMatches,
    }),
    [normalizedQuery],
  );

  const projection = signals?.projection ?? null;
  const groups = useMemo(
    () => (projection ? peopleGroups(projection) : []),
    [projection],
  );
  const visibleGroups = groups.map((group) => ({
    ...group,
    visible: filterActive
      ? group.people.filter((person) =>
          lobbyFilter.matches(person.display_name),
        )
      : group.people,
  }));
  const rosterMatches = visibleGroups.reduce(
    (total, group) => total + group.visible.length,
    0,
  );
  const handByKey = new Map<string, ClassroomRaisedHandProjection>(
    projection?.raised_hands.map((hand) => [hand.participant_key, hand]) ?? [],
  );
  const canModerateHands =
    projection?.viewer_operations.can_moderate_hands ?? false;
  const raisedCount = projection?.raised_hands.length ?? 0;
  const noResults =
    filterActive &&
    lobbyMatches === 0 &&
    (!signals || (projection !== null && rosterMatches === 0));

  return (
    <div className="media-p406-people">
      <div className="media-p406-people__search" role="search">
        <Search aria-hidden="true" className="media-p406-people__search-icon" />
        <input
          aria-label={t("media.people.search")}
          autoComplete="off"
          className="media-p406-people__search-input"
          enterKeyHint="search"
          id={`${baseID}-search`}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // The drawer keeps Escape while the box is empty; with text,
            // Escape only clears it (the drawer skips its own dismissal).
            if (event.key === "Escape" && query !== "") setQuery("");
          }}
          placeholder={t("media.people.search")}
          spellCheck={false}
          type="search"
          value={query}
        />
        {query !== "" && (
          <IconButton
            className="media-p406-people__search-clear"
            label={t("media.people.clearSearch")}
            onClick={() => {
              setQuery("");
              document.getElementById(`${baseID}-search`)?.focus();
            }}
            size="sm"
            variant="quiet"
          >
            <X />
          </IconButton>
        )}
      </div>

      {signals?.error && projection ? (
        <div
          className="media-p406-people__sync"
          data-state="error"
          role="status"
        >
          <span>{t("media.people.syncError")}</span>
          <Button
            onClick={() => void signals.onResync()}
            size="sm"
            variant="quiet"
          >
            {t("media.people.retry")}
          </Button>
        </div>
      ) : slowSync && projection ? (
        <p className="media-p406-people__sync" data-state="syncing">
          <RefreshCw
            aria-hidden="true"
            className="media-p406-people__sync-icon"
          />
          {t("media.people.syncing")}
        </p>
      ) : null}

      {codeGrants?.error ? (
        <div className="media-p406-people__code-alert" role="alert">
          <span>
            {t(
              codeGrants.error === "limit"
                ? "media.people.code.limitError"
                : "media.people.code.failed",
              { max: codeGrants.maxEditors },
            )}
          </span>
          <IconButton
            className="media-p406-people__code-alert-dismiss"
            label={t("media.room.dismiss")}
            onClick={codeGrants.onDismissError}
            size="sm"
            variant="quiet"
          >
            <X />
          </IconButton>
        </div>
      ) : null}

      {pdfGrants?.error ? (
        <div className="media-p406-people__code-alert" role="alert">
          <span>
            {t(
              pdfGrants.error === "limit"
                ? "media.people.pdf.limitError"
                : "media.people.pdf.failed",
              { max: pdfGrants.maxAnnotators },
            )}
          </span>
          <IconButton
            className="media-p406-people__code-alert-dismiss"
            label={t("media.room.dismiss")}
            onClick={pdfGrants.onDismissError}
            size="sm"
            variant="quiet"
          >
            <X />
          </IconButton>
        </div>
      ) : null}

      <div className="media-p406-people__body">
        {lobby && (
          <div className="media-p406-roster-lobby">
            <MediaLobbyFilterContext value={lobbyFilter}>
              {lobby}
            </MediaLobbyFilterContext>
          </div>
        )}

        {signals && (
          <PeopleInClass
            baseID={baseID}
            codeGrants={codeGrants}
            collapsed={collapsed}
            pdfGrants={pdfGrants}
            handByKey={handByKey}
            mediaStates={mediaStates}
            moderation={moderation}
            moderationDisabled={moderationDisabled}
            onLowerHand={onLowerHand}
            onToggleGroup={(id) =>
              setCollapsed((current) => ({ ...current, [id]: !current[id] }))
            }
            signals={signals}
            visibleGroups={visibleGroups}
          />
        )}

        {noResults && (
          <div className="media-p406-people-empty" role="status">
            <p className="media-p406-people-empty__title">
              {t("media.people.noResultsTitle", { query: query.trim() })}
            </p>
            <p className="media-p406-people-empty__text">
              {t("media.people.noResultsDescription")}
            </p>
            <Button
              onClick={() => {
                setQuery("");
                document.getElementById(`${baseID}-search`)?.focus();
              }}
              size="sm"
              variant="secondary"
            >
              {t("media.people.clearSearch")}
            </Button>
          </div>
        )}
      </div>

      {canModerateHands && raisedCount > 0 && (
        <div
          aria-label={t("media.people.hostActions")}
          className="media-p406-people__footer"
          role="group"
        >
          <Button
            className="media-p406-people__lower-all"
            disabled={signals?.mutating}
            leadingIcon={<Hand />}
            onClick={onLowerAll}
            size="sm"
            variant="secondary"
          >
            {t("media.people.lowerAll", { count: raisedCount })}
          </Button>
        </div>
      )}
    </div>
  );
}

function PeopleInClass({
  baseID,
  codeGrants,
  collapsed,
  handByKey,
  mediaStates,
  moderation,
  moderationDisabled,
  onLowerHand,
  onToggleGroup,
  pdfGrants,
  signals,
  visibleGroups,
}: {
  readonly baseID: string;
  readonly codeGrants: ClassroomCodeEditorGrantsModel | null;
  readonly pdfGrants: ClassroomPdfAnnotatorGrantsModel | null;
  readonly collapsed: Readonly<Partial<Record<PeopleGroupID, boolean>>>;
  readonly handByKey: ReadonlyMap<string, ClassroomRaisedHandProjection>;
  readonly mediaStates?: ReadonlyMap<string, ClassroomPeopleMediaState>;
  readonly moderation?: ClassroomModerationControlsModel;
  readonly moderationDisabled: boolean;
  readonly onLowerHand: (participantKey: string) => void;
  readonly onToggleGroup: (id: PeopleGroupID) => void;
  readonly signals: ClassroomPeopleSignals;
  readonly visibleGroups: ReadonlyArray<
    PeopleGroup & { readonly visible: readonly ClassroomRosterParticipant[] }
  >;
}) {
  const { t } = useI18n();
  const projection = signals.projection;
  const toneSalt = useMemo(
    () => fnv1aHash(projection?.room_instance_id ?? ""),
    [projection?.room_instance_id],
  );
  const labelID = `${baseID}-in-class`;

  let content: ReactNode;
  // No snapshot yet and no error: still loading (fail quiet, never "empty").
  if (!projection && !signals.error) {
    content = (
      <SkeletonGroup
        className="media-p406-people-skeleton"
        label={t("media.people.loading")}
      >
        {[0, 1, 2].map((row) => (
          <span className="media-p406-people-skeleton__row" key={row}>
            <Skeleton height={32} width={32} />
            <Skeleton height={12} width={row === 0 ? "62%" : "48%"} />
          </span>
        ))}
      </SkeletonGroup>
    );
  } else if (!projection) {
    content = (
      <div className="media-p406-people-state" role="alert">
        <p className="media-p406-people-state__text">
          {t("media.p406.loadError")}
        </p>
        <Button
          onClick={() => void signals.onResync()}
          size="sm"
          variant="secondary"
        >
          {t("media.p406.retry")}
        </Button>
      </div>
    );
  } else if (projection.roster.length === 0) {
    content = (
      <p className="media-p406-people-empty__text">{t("media.people.empty")}</p>
    );
  } else {
    const canModerateHands = projection.viewer_operations.can_moderate_hands;
    const codeGrantTarget = (person: ClassroomRosterParticipant) =>
      codeGrants?.canManage === true &&
      person.instance_role === "attendee" &&
      person.connection_state === "connected" &&
      person.participant_key !== projection.self_participant_key;
    const pdfGrantTarget = (person: ClassroomRosterParticipant) =>
      pdfGrants?.canManage === true &&
      person.instance_role === "attendee" &&
      person.connection_state === "connected" &&
      person.participant_key !== projection.self_participant_key;
    const codeGrantRows =
      projection.roster.some(codeGrantTarget) ||
      projection.roster.some(pdfGrantTarget);
    // Every row reserves the same action width, so status icons line up in
    // one column whether or not a row shows a lower-hand key.
    const actionSlots =
      (canModerateHands &&
      projection.raised_hands.some(
        (hand) => hand.participant_key !== projection.self_participant_key,
      )
        ? 1
        : 0) +
      (codeGrantRows ||
      moderation?.participantOperations.some(
        (operations) =>
          operations.canPromoteCoHost ||
          operations.canDemoteCoHost ||
          operations.canRemoteMute ||
          operations.canRemove,
      )
        ? 1
        : 0);
    content = visibleGroups
      .filter((group) => group.visible.length > 0)
      .map((group) => {
        const listID = `${baseID}-${group.id}`;
        const isCollapsed = collapsed[group.id] === true;
        return (
          <div
            className="media-p406-people-group"
            data-group={group.id}
            key={group.id}
          >
            <h4 className="media-p406-people-group__heading">
              <button
                aria-controls={listID}
                aria-expanded={!isCollapsed}
                className="media-p406-people-group__toggle"
                onClick={() => onToggleGroup(group.id)}
                type="button"
              >
                <span className="media-p406-people-group__label">
                  {t(group.label)}
                </span>{" "}
                <span
                  aria-hidden="true"
                  className="media-p406-people-group__dot"
                >
                  ·
                </span>{" "}
                <span className="media-p406-people-group__count">
                  {group.visible.length}
                </span>
                <ChevronUp
                  aria-hidden="true"
                  className="media-p406-people-group__chevron"
                />
              </button>
            </h4>
            <ul
              aria-label={t(group.label)}
              className="media-p406-people-list"
              hidden={isCollapsed}
              id={listID}
            >
              {orderPeople(
                group.visible,
                projection.self_participant_key,
                handByKey,
              ).map((person) => (
                <PeopleRow
                  actionSlots={actionSlots}
                  canModerateHands={canModerateHands}
                  codeEditing={
                    person.instance_role === "attendee" &&
                    codeGrants?.activeParticipantKeys.has(
                      person.participant_key,
                    ) === true
                  }
                  codeGrant={
                    codeGrants && codeGrantTarget(person)
                      ? codeGrantAction(codeGrants, person.participant_key)
                      : undefined
                  }
                  pdfAnnotating={
                    person.instance_role === "attendee" &&
                    pdfGrants?.activeParticipantKeys.has(
                      person.participant_key,
                    ) === true
                  }
                  pdfGrant={
                    pdfGrants && pdfGrantTarget(person)
                      ? pdfGrantAction(pdfGrants, person.participant_key)
                      : undefined
                  }
                  hand={handByKey.get(person.participant_key)}
                  isSelf={
                    person.participant_key === projection.self_participant_key
                  }
                  key={person.participant_key}
                  media={mediaStates?.get(person.participant_key)}
                  moderation={moderation}
                  moderationDisabled={moderationDisabled}
                  mutating={signals.mutating}
                  onLowerHand={onLowerHand}
                  person={person}
                  tone={mediaTileTone(person.roster_sequence, toneSalt)}
                />
              ))}
            </ul>
          </div>
        );
      });
  }

  return (
    <section aria-labelledby={labelID} className="media-p406-roster">
      <h3 className="media-p406-people-section__label" id={labelID}>
        {t("media.people.inClass")}
      </h3>
      {content}
    </section>
  );
}

function codeGrantAction(
  grants: ClassroomCodeEditorGrantsModel,
  participantKey: string,
): ClassroomParticipantCodeGrantAction {
  const granted = grants.activeParticipantKeys.has(participantKey);
  return {
    granted,
    limitReached:
      !granted && grants.activeParticipantKeys.size >= grants.maxEditors,
    maxEditors: grants.maxEditors,
    pending: grants.pendingParticipantKey === participantKey,
    onGrant: () => grants.onGrant(participantKey),
    onRevoke: () => grants.onRevoke(participantKey),
  };
}

function pdfGrantAction(
  grants: ClassroomPdfAnnotatorGrantsModel,
  participantKey: string,
): ClassroomParticipantPdfGrantAction {
  const granted = grants.activeParticipantKeys.has(participantKey);
  return {
    granted,
    limitReached:
      !granted && grants.activeParticipantKeys.size >= grants.maxAnnotators,
    maxAnnotators: grants.maxAnnotators,
    pending: grants.pendingParticipantKey === participantKey,
    onGrant: () => grants.onGrant(participantKey),
    onRevoke: () => grants.onRevoke(participantKey),
  };
}

function PeopleRow({
  actionSlots,
  canModerateHands,
  codeEditing,
  codeGrant,
  hand,
  isSelf,
  media,
  moderation,
  moderationDisabled,
  mutating,
  onLowerHand,
  pdfAnnotating,
  pdfGrant,
  person,
  tone,
}: {
  readonly actionSlots: number;
  readonly canModerateHands: boolean;
  readonly codeEditing: boolean;
  readonly codeGrant?: ClassroomParticipantCodeGrantAction;
  readonly pdfAnnotating: boolean;
  readonly pdfGrant?: ClassroomParticipantPdfGrantAction;
  readonly hand?: ClassroomRaisedHandProjection;
  readonly isSelf: boolean;
  readonly media?: ClassroomPeopleMediaState;
  readonly moderation?: ClassroomModerationControlsModel;
  readonly moderationDisabled: boolean;
  readonly mutating: boolean;
  readonly onLowerHand: (participantKey: string) => void;
  readonly person: ClassroomRosterParticipant;
  readonly tone: number;
}) {
  const { t } = useI18n();
  const name = person.display_name;
  const role =
    person.instance_role === "attendee" ? null : person.instance_role;
  const connection =
    person.connection_state === "connected" ? null : person.connection_state;
  const microphoneOff = media?.microphoneEnabled === false;
  const speaking = !microphoneOff && media?.speaking === true;
  const canLowerHand = Boolean(hand) && canModerateHands && !isSelf;

  return (
    <li
      className="media-p406-people-row"
      data-connection={person.connection_state}
      data-hand={hand ? "raised" : undefined}
      data-self={isSelf || undefined}
    >
      <span
        aria-hidden="true"
        className="media-p406-people-avatar"
        data-tone={tone}
      >
        {(Array.from(name.trim())[0] ?? "?").toLocaleUpperCase()}
      </span>
      <span className="media-p406-people-row__text">
        <span className="media-p406-people-row__name">
          <span className="media-p406-people-row__display" title={name}>
            {name}
          </span>
          {isSelf && (
            <span className="media-p406-people-row__self">
              ({t("media.p406.you")})
            </span>
          )}
        </span>
        {(role || connection) && (
          <span className="media-p406-people-row__meta">
            {role && <span>{t(`media.people.role.${role}`)}</span>}
            {role && connection && <span aria-hidden="true"> · </span>}
            {connection && (
              <span
                className="media-p406-people-row__connection"
                data-connection={connection}
              >
                {t(`media.people.connection.${connection}`)}
              </span>
            )}
          </span>
        )}
      </span>
      <span className="media-p406-people-row__status">
        {codeEditing && (
          <span
            aria-label={t("media.people.code.editing")}
            className="media-p406-people-code-grant"
            data-people-tip={t("media.people.code.editing")}
            role="img"
          >
            <Pencil aria-hidden="true" />
          </span>
        )}
        {pdfAnnotating && (
          <span
            aria-label={t("media.people.pdf.annotating")}
            className="media-p406-people-code-grant media-p406-people-pdf-grant"
            data-people-tip={t("media.people.pdf.annotating")}
            role="img"
          >
            <Highlighter aria-hidden="true" />
          </span>
        )}
        {hand && (
          <span
            className="media-p406-people-hand"
            title={t("media.p406.handQueuePosition", {
              position: hand.queue_position,
            })}
          >
            <Hand aria-hidden="true" />
            <span aria-hidden="true">{hand.queue_position}</span>
            <span className="media-p406-people-sr-only">
              {t("media.p406.handQueuePosition", {
                position: hand.queue_position,
              })}
            </span>
          </span>
        )}
        {speaking && (
          <span
            aria-label={t("media.people.speaking")}
            className="media-p406-people-speaking"
            role="img"
          >
            <span />
            <span />
            <span />
          </span>
        )}
        {microphoneOff && (
          <span
            aria-label={t("media.people.micOff")}
            className="media-p406-people-mic"
            role="img"
          >
            <MicOff aria-hidden="true" />
          </span>
        )}
      </span>
      {actionSlots > 0 && (
        <span
          className="media-p406-people-row__actions"
          data-slots={actionSlots}
        >
          {canLowerHand && (
            <IconButton
              className="media-p406-people-action"
              data-people-tip={t("media.people.lowerHand")}
              disabled={mutating}
              label={t("media.p406.lowerNamedHand", { name })}
              onClick={() => onLowerHand(person.participant_key)}
              size="sm"
              variant="quiet"
            >
              <Hand />
            </IconButton>
          )}
          {(moderation || codeGrant || pdfGrant) && (
            <ClassroomParticipantModerationMenu
              codeGrant={codeGrant}
              pdfGrant={pdfGrant}
              controls={moderation}
              disabled={moderationDisabled}
              displayName={name}
              isSelf={isSelf}
              participantKey={person.participant_key}
            />
          )}
        </span>
      )}
    </li>
  );
}

function peopleGroups(projection: ClassroomSignalProjection): PeopleGroup[] {
  const staff = projection.roster.filter((person) =>
    STAFF_ROLES.has(person.instance_role),
  );
  const students = projection.roster.filter(
    (person) => !STAFF_ROLES.has(person.instance_role),
  );
  if (staff.length === 0 || students.length === 0) {
    return [
      {
        id: "everyone",
        label: "media.people.everyoneGroup",
        people: projection.roster,
      },
    ];
  }
  return [
    { id: "staff", label: "media.people.staffGroup", people: staff },
    { id: "students", label: "media.people.studentGroup", people: students },
  ];
}

/** You first, then raised hands in FIFO queue order, then `roster_sequence`. */
function orderPeople(
  people: readonly ClassroomRosterParticipant[],
  selfKey: string,
  handByKey: ReadonlyMap<string, ClassroomRaisedHandProjection>,
): ClassroomRosterParticipant[] {
  const rank = (person: ClassroomRosterParticipant) =>
    person.participant_key === selfKey
      ? 0
      : handByKey.has(person.participant_key)
        ? 1
        : 2;
  return [...people].sort((left, right) => {
    const byRank = rank(left) - rank(right);
    if (byRank !== 0) return byRank;
    const leftHand = handByKey.get(left.participant_key);
    const rightHand = handByKey.get(right.participant_key);
    if (leftHand && rightHand) {
      return leftHand.queue_position - rightHand.queue_position;
    }
    return (
      left.roster_sequence - right.roster_sequence ||
      left.participant_key.localeCompare(right.participant_key)
    );
  });
}

/** True once `active` has stayed true for `delayMs` (no flash on quick polls). */
function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    const timer = globalThis.setTimeout(
      () => setElapsed(active),
      active ? delayMs : 0,
    );
    return () => globalThis.clearTimeout(timer);
  }, [active, delayMs]);
  return active && elapsed;
}
