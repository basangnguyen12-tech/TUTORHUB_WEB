import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  APIRequestError,
  createClassSession,
  listClassSessions,
  rotateCSRFToken,
  type ClassSession,
  type ClassroomClass,
} from "@tutorhub/api-client";
import { Button, type ButtonSize } from "@tutorhub/ui";
import { Video } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { invalidateTenantAudit } from "../app/audit";
import { instantInTimezone } from "../app/classSessionTime";
import { classSessionQueryKeys } from "../app/classSessions";
import { useI18n, type TranslationKey } from "../app/i18n";
import { launchMediaSpace, MediaSpaceNotReadyError } from "../app/mediaSpaces";
import { useSession } from "../app/session";
import {
  invalidateTenantCapabilities,
  type TenantOperationAvailability,
} from "../app/tenantCapabilities";

const minuteMS = 60_000;
const lookbackMS = 6 * 60 * minuteMS;
const lookaheadMS = 24 * 60 * minuteMS;
const upcomingWindowMS = 60 * minuteMS;
const instantSessionMS = 90 * minuteMS;
const sessionPageSize = 50;
const maxSessionPages = 4;
const maxSessionTitleLength = 200;

type QuickLaunchOutcome =
  | { kind: "launched"; spaceID: string }
  | { kind: "no_live_session" }
  | { kind: "scheduling_unavailable" };

function getApiBaseUrl() {
  return import.meta.env.VITE_API_BASE_URL ?? "/api";
}

function sessionStartMS(session: ClassSession) {
  return Date.parse(session.starts_at);
}

/** Prefer a live session, then the earliest one that is running or starts within the hour. */
function pickLaunchableSession(
  sessions: readonly ClassSession[],
  nowMS: number,
): ClassSession | null {
  const byStart = (left: ClassSession, right: ClassSession) =>
    sessionStartMS(left) - sessionStartMS(right);
  const live = sessions.filter((session) => session.status === "live");
  if (live.length > 0) {
    return [...live].sort(byStart)[0] ?? null;
  }
  const upcoming = sessions.filter(
    (session) =>
      session.status === "scheduled" &&
      Date.parse(session.ends_at) > nowMS &&
      sessionStartMS(session) <= nowMS + upcomingWindowMS,
  );
  return [...upcoming].sort(byStart)[0] ?? null;
}

async function findLaunchableSession(classID: string, nowMS: number) {
  const rangeStart = new Date(nowMS - lookbackMS).toISOString();
  const rangeEnd = new Date(nowMS + lookaheadMS).toISOString();
  const sessions: ClassSession[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxSessionPages; page += 1) {
    const result = await listClassSessions(
      classID,
      {
        cursor,
        limit: sessionPageSize,
        range_end: rangeEnd,
        range_start: rangeStart,
      },
      { baseUrl: getApiBaseUrl() },
    );
    sessions.push(...result.items);
    if (!result.next_cursor) {
      break;
    }
    cursor = result.next_cursor;
  }
  return pickLaunchableSession(sessions, nowMS);
}

function truncateCodePoints(value: string, maxLength: number) {
  const codePoints = Array.from(value);
  return codePoints.length <= maxLength
    ? value
    : codePoints.slice(0, Math.max(0, maxLength)).join("").trimEnd();
}

function quickLaunchErrorKey(error: Error | null): TranslationKey {
  if (error instanceof MediaSpaceNotReadyError) {
    return "media.launch.notReady";
  }
  if (
    error instanceof APIRequestError &&
    error.problem?.code === "class_session_schedule_conflict"
  ) {
    return "classSession.scheduleConflict";
  }
  return "media.launch.error";
}

interface ClassroomQuickLaunchActionProps {
  classroom: ClassroomClass;
  /** `undefined` while tenant capabilities are still resolving. */
  mediaRoomsEnabled: boolean | undefined;
  schedulingAvailability: TenantOperationAvailability;
  size?: ButtonSize;
}

/**
 * One-tap classroom entry (ClassIn / Meet style): reuse a live or imminent
 * session, or let an instructor open a 90-minute live session on the spot.
 */
export function ClassroomQuickLaunchAction({
  classroom,
  mediaRoomsEnabled,
  schedulingAvailability,
  size = "md",
}: ClassroomQuickLaunchActionProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const session = useSession();
  const tenantID = session.currentUser?.active_tenant?.id;
  const canScheduleSessions = classroom.viewer_access.can_schedule_sessions;
  const canJoinRoom = classroom.viewer_access.can_join_room;
  const returnTo = `/app/classrooms/${classroom.id}`;

  const launch = useMutation<QuickLaunchOutcome, Error, void>({
    mutationFn: async () => {
      if (!tenantID) {
        throw new Error("An active workspace is required.");
      }
      const nowMS = Date.now();
      let target = await findLaunchableSession(classroom.id, nowMS);
      let createdNow = false;
      if (!target) {
        if (!canScheduleSessions) {
          return { kind: "no_live_session" };
        }
        if (!schedulingAvailability.available) {
          return { kind: "scheduling_unavailable" };
        }
        const startMS = Math.floor(nowMS / minuteMS) * minuteMS;
        const startsAt = instantInTimezone(
          new Date(startMS).toISOString(),
          classroom.timezone,
        );
        const endsAt = instantInTimezone(
          new Date(startMS + instantSessionMS).toISOString(),
          classroom.timezone,
        );
        if (!startsAt || !endsAt) {
          throw new Error("invalid_class_timezone");
        }
        const suffixLength = Array.from(
          t("classroom.quickLaunch.sessionTitle", { title: "" }),
        ).length;
        const title = t("classroom.quickLaunch.sessionTitle", {
          title: truncateCodePoints(
            classroom.title,
            maxSessionTitleLength - suffixLength,
          ),
        });
        const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
        target = await createClassSession(
          classroom.id,
          {
            description: "",
            ends_at: endsAt,
            starts_at: startsAt,
            timezone: classroom.timezone,
            title: truncateCodePoints(title, maxSessionTitleLength),
          },
          csrf.csrf_token,
          { baseUrl: getApiBaseUrl() },
        );
        createdNow = true;
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: classSessionQueryKeys.lists(tenantID, classroom.id),
          }),
          invalidateTenantAudit(queryClient, tenantID),
          invalidateTenantCapabilities(queryClient, tenantID),
        ]);
      }
      const space = await launchMediaSpace(tenantID, {
        canStart: createdNow || canScheduleSessions,
        source: { class_session_id: target.id, kind: "class_session" },
      });
      return { kind: "launched", spaceID: space.id };
    },
    onSuccess: (outcome) => {
      if (outcome.kind === "launched") {
        void navigate(`/app/media/spaces/${outcome.spaceID}/prejoin`, {
          state: { classTitle: classroom.title, returnTo },
        });
      }
    },
    retry: false,
  });

  if (classroom.status !== "active") {
    return null;
  }
  if (mediaRoomsEnabled === false) {
    return canJoinRoom ? (
      <Link
        className="classroom-live-action"
        to={`/app/classrooms/${classroom.id}/prejoin`}
      >
        <span aria-hidden="true" />
        {t("classroom.joinRoomAction")}
      </Link>
    ) : null;
  }
  if (mediaRoomsEnabled !== true || (!canScheduleSessions && !canJoinRoom)) {
    return null;
  }

  const outcome = launch.data;
  return (
    <div className="classroom-quick-launch">
      <Button
        disabled={!tenantID}
        leadingIcon={<Video />}
        loading={launch.isPending}
        loadingLabel={t("media.launch.opening")}
        onClick={() => launch.mutate()}
        size={size}
        variant="primary"
      >
        {canScheduleSessions
          ? t("classroom.quickLaunch.start")
          : t("classroom.quickLaunch.join")}
      </Button>
      {outcome && outcome.kind !== "launched" && !launch.isPending && (
        <p className="classroom-quick-launch__status" role="status">
          {outcome.kind === "no_live_session"
            ? t("classroom.quickLaunch.noLiveSession")
            : t("classroom.quickLaunch.schedulingUnavailable")}
        </p>
      )}
      {launch.isError && (
        <p className="classroom-quick-launch__error" role="alert">
          {t(quickLaunchErrorKey(launch.error))}
        </p>
      )}
    </div>
  );
}
