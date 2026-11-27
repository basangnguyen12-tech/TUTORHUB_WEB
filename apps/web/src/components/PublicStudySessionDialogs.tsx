import {
  APIRequestError,
  resolveMediaSpace,
  type TenantCapabilities,
} from "@tutorhub/api-client";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Skeleton,
  SkeletonGroup,
  TextField,
} from "@tutorhub/ui";
import {
  CalendarClock,
  Check,
  Copy,
  Minus,
  RotateCw,
  Search,
  Video,
} from "lucide-react";
import { useId, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import {
  useCreateStudyMeeting,
  useStudyMeetingList,
  type StudyMeeting,
} from "../app/availabilityPollManagement";
import {
  civilInputFromInstant,
  instantInTimezone,
  resolveCivilDateTime,
} from "../app/classSessionTime";
import { useI18n, type TranslationKey } from "../app/i18n";
import { launchMediaSpace, MediaSpaceNotReadyError } from "../app/mediaSpaces";
import type { TenantOperationAvailability } from "../app/tenantCapabilities";
import { ClassCoverArt } from "./ClassCoverArt";
import { MediaSpaceLaunchAction } from "./MediaSpaceLaunchAction";
import { TenantOperationNotice } from "./TenantOperationNotice";

const minuteMS = 60_000;
const durations = [40, 60, 90, 120] as const;
type Duration = (typeof durations)[number];
type StartMode = "now" | "scheduled";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const spacePathPattern =
  /^\/app\/media\/spaces\/([0-9a-f-]{36})(?:\/prejoin|\/instances\/[0-9a-f-]{36}\/room)?\/?$/i;

function getApiBaseUrl() {
  return import.meta.env.VITE_API_BASE_URL ?? "/api";
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    parts.length > 1
      ? `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`
      : (parts[0]?.slice(0, 2) ?? "");
  return letters.toUpperCase() || "?";
}

function formatMeetingRange(
  meeting: Pick<StudyMeeting, "ends_at" | "starts_at">,
  locale: string,
  timezone: string,
) {
  const formatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  });
  const start = new Date(meeting.starts_at);
  const end = new Date(meeting.ends_at);
  try {
    return formatter.formatRange(start, end);
  } catch {
    return `${formatter.format(start)} – ${formatter.format(end)}`;
  }
}

function createErrorKey(error: unknown): TranslationKey {
  if (error instanceof APIRequestError) {
    if (error.problem?.code === "feature_disabled") {
      return "capabilities.reasonFeatureDisabled";
    }
    if (error.problem?.code === "quota_exceeded" || error.status === 429) {
      return error.status === 429
        ? "capabilities.reasonRateLimited"
        : "capabilities.reasonQuotaExhausted";
    }
    if (error.status === 403) {
      return "publicSession.forbidden";
    }
  }
  return "publicSession.createError";
}

function RoomIllustration() {
  return (
    <svg
      aria-hidden="true"
      className="public-session__illustration"
      focusable="false"
      viewBox="0 0 240 150"
    >
      <rect fill="#f4f6f9" height="150" rx="14" width="240" />
      {[0, 1, 2, 3, 4].map((index) => (
        <rect
          fill="#e3e8ef"
          height="18"
          key={index}
          rx="4"
          width="38"
          x={18 + index * 42}
          y="14"
        />
      ))}
      <rect
        fill="#fff"
        height="88"
        rx="8"
        stroke="#dfe3e8"
        width="204"
        x="18"
        y="42"
      />
      <circle cx="54" cy="78" fill="#dbeafe" r="16" />
      <rect fill="#dfe3e8" height="7" rx="3.5" width="84" x="80" y="66" />
      <rect fill="#e9edf2" height="7" rx="3.5" width="64" x="80" y="80" />
      <rect fill="#e9edf2" height="7" rx="3.5" width="96" x="80" y="94" />
      <rect fill="#e3f4ea" height="34" rx="6" width="40" x="172" y="86" />
      <circle cx="192" cy="99" fill="#86c9a0" r="6" />
    </svg>
  );
}

interface CreatePublicSessionDialogProps {
  availability: TenantOperationAvailability;
  features: TenantCapabilities["features"] | undefined;
  onOpenChange: (open: boolean) => void;
  onRetryCapabilities?: () => void;
  open: boolean;
  organizerName: string;
  tenantID: string;
  timezone: string;
}

/** ClassIn ref-04: create a StudyMeeting and, if "now", open its media room. */
export function CreatePublicSessionDialog({
  availability,
  features,
  onOpenChange,
  onRetryCapabilities,
  open,
  organizerName,
  tenantID,
  timezone,
}: CreatePublicSessionDialogProps) {
  const { language, t } = useI18n();
  const navigate = useNavigate();
  const formID = useId();
  const locale = language === "vi" ? "vi-VN" : "en-US";
  const createMeeting = useCreateStudyMeeting(tenantID);
  const mediaRoomsEnabled = features?.classroom_media_rooms?.enabled === true;
  const [title, setTitle] = useState(() =>
    t("publicSession.defaultTitle", { name: organizerName }),
  );
  const [startMode, setStartMode] = useState<StartMode>("now");
  const [startsAt, setStartsAt] = useState(() =>
    civilInputFromInstant(
      new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000).toISOString(),
      timezone,
    ),
  );
  const [duration, setDuration] = useState<Duration>(40);
  const [formError, setFormError] = useState<TranslationKey | null>(null);
  const [launching, setLaunching] = useState(false);
  const [launchFailed, setLaunchFailed] = useState(false);
  const [created, setCreated] = useState<StudyMeeting | null>(null);
  const [copyStatus, setCopyStatus] = useState<"copied" | "manual" | null>(
    null,
  );
  const busy = createMeeting.isPending || launching;
  const capabilityRows = [
    ["publicSession.featureMedia", mediaRoomsEnabled],
    [
      "publicSession.featureWhiteboard",
      features?.classroom_whiteboards?.enabled,
    ],
    ["publicSession.featurePdf", features?.classroom_files_tool?.enabled],
    ["publicSession.featureCode", features?.classroom_code_tool?.enabled],
  ] as const satisfies readonly (readonly [
    TranslationKey,
    boolean | undefined,
  ])[];

  const openRoom = async (meeting: StudyMeeting) => {
    setLaunching(true);
    setLaunchFailed(false);
    try {
      const space = await launchMediaSpace(tenantID, {
        canStart: true,
        source: { kind: "study_meeting", study_meeting_id: meeting.id },
      });
      onOpenChange(false);
      void navigate(`/app/media/spaces/${space.id}/prejoin`, {
        state: { classTitle: meeting.title, returnTo: "/app/classrooms" },
      });
      return true;
    } catch {
      setLaunchFailed(true);
      return false;
    } finally {
      setLaunching(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!availability.available || busy) {
      return;
    }
    const trimmedTitle = title.trim();
    const titleLength = Array.from(trimmedTitle).length;
    if (titleLength < 1 || titleLength > 200) {
      setFormError("publicSession.titleError");
      return;
    }
    let startISO: string | null = null;
    let startMS = Number.NaN;
    if (startMode === "now") {
      startMS = Math.floor(Date.now() / minuteMS) * minuteMS;
      startISO = instantInTimezone(new Date(startMS).toISOString(), timezone);
    } else {
      const resolved = resolveCivilDateTime(startsAt, timezone, "earlier");
      if (resolved.kind === "resolved") {
        startISO = resolved.value;
        startMS = Date.parse(resolved.value);
      }
    }
    const endISO = Number.isFinite(startMS)
      ? instantInTimezone(
          new Date(startMS + duration * minuteMS).toISOString(),
          timezone,
        )
      : null;
    if (!startISO || !endISO) {
      setFormError("publicSession.timeError");
      return;
    }
    setFormError(null);
    let meeting: StudyMeeting;
    try {
      meeting = await createMeeting.mutateAsync({
        class_id: null,
        ends_at: endISO,
        idempotency_key: crypto.randomUUID(),
        starts_at: startISO,
        timezone,
        title: trimmedTitle,
      });
    } catch {
      return;
    }
    if (startMode === "now" && mediaRoomsEnabled && (await openRoom(meeting))) {
      return;
    }
    setCreated(meeting);
  };

  const copyDetails = async (meeting: StudyMeeting) => {
    const text = t("publicSession.shareText", {
      code: meeting.id,
      time: formatMeetingRange(meeting, locale, timezone),
      title: meeting.title,
    });
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(text);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("manual");
    }
  };

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!busy) {
          onOpenChange(nextOpen);
        }
      }}
      open={open}
    >
      <DialogContent
        className="classin-dialog public-session-dialog"
        closeLabel={t("publicSession.close")}
      >
        <DialogTitle>
          {created
            ? t("publicSession.createdTitle")
            : t("publicSession.createTitle")}
        </DialogTitle>
        <DialogDescription>
          {created
            ? t("publicSession.createdDescription")
            : t("publicSession.createDescription")}
        </DialogDescription>

        {created ? (
          <div className="public-session__created">
            <div className="public-session__summary">
              <span aria-hidden="true" className="public-session__summary-icon">
                <Check />
              </span>
              <div>
                <strong>{created.title}</strong>
                <span>{formatMeetingRange(created, locale, timezone)}</span>
              </div>
            </div>
            <dl className="public-session__code">
              <dt>{t("publicSession.codeLabel")}</dt>
              <dd>
                <code>{created.id}</code>
              </dd>
            </dl>
            {!mediaRoomsEnabled && (
              <p className="classin-inline-note">
                {t("publicSession.mediaOff")}
              </p>
            )}
            {launchFailed && (
              <p className="classin-form-error" role="alert">
                {t("publicSession.launchError")}
              </p>
            )}
            {copyStatus && (
              <p className="classin-form-success" role="status">
                {t(
                  copyStatus === "copied"
                    ? "publicSession.copied"
                    : "publicSession.copyManual",
                )}
              </p>
            )}
            <div className="classin-dialog__footer">
              <Button
                leadingIcon={<Copy />}
                onClick={() => void copyDetails(created)}
                variant="secondary"
              >
                {t("publicSession.copyDetails")}
              </Button>
              {mediaRoomsEnabled && (
                <Button
                  className="classin-cta classin-cta--green"
                  leadingIcon={<Video />}
                  loading={launching}
                  loadingLabel={t("media.launch.opening")}
                  onClick={() => void openRoom(created)}
                >
                  {t("publicSession.openRoomNow")}
                </Button>
              )}
              <Button
                className="classin-cta"
                disabled={launching}
                onClick={() => onOpenChange(false)}
              >
                {t("publicSession.done")}
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="public-session__layout"
            id={formID}
            onSubmit={(event) => void submit(event)}
          >
            <div className="public-session__main">
              <div className="public-session__title-row">
                <ClassCoverArt
                  className="public-session__thumb"
                  theme="starry-night"
                />
                <TextField
                  className="public-session__title-field"
                  label={t("publicSession.titleLabel")}
                  maxLength={200}
                  onChange={(event) => setTitle(event.target.value)}
                  required
                  value={title}
                />
              </div>

              <TenantOperationNotice
                availability={availability}
                label={t("classroom.quickCreatePublic")}
                onRetry={onRetryCapabilities}
              />

              <fieldset className="public-session__row">
                <legend>{t("publicSession.startLabel")}</legend>
                <div className="classin-segmented">
                  {(["now", "scheduled"] as const).map((mode) => (
                    <label key={mode}>
                      <input
                        checked={startMode === mode}
                        name={`${formID}-start`}
                        onChange={() => setStartMode(mode)}
                        type="radio"
                        value={mode}
                      />
                      <span>
                        {mode === "now"
                          ? t("publicSession.startNow")
                          : t("publicSession.startScheduled")}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {startMode === "scheduled" && (
                <TextField
                  label={t("publicSession.startAtLabel", { timezone })}
                  onChange={(event) => setStartsAt(event.target.value)}
                  onInput={(event) => setStartsAt(event.currentTarget.value)}
                  required
                  type="datetime-local"
                  value={startsAt}
                />
              )}

              <fieldset className="public-session__row">
                <legend>{t("publicSession.durationLabel")}</legend>
                <div className="classin-segmented">
                  {durations.map((minutes) => (
                    <label key={minutes}>
                      <input
                        checked={duration === minutes}
                        name={`${formID}-duration`}
                        onChange={() => setDuration(minutes)}
                        type="radio"
                        value={minutes}
                      />
                      <span>
                        {t("publicSession.durationOption", { minutes })}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="public-session__row public-session__organizer">
                <span className="public-session__row-label">
                  {t("publicSession.organizerLabel")}
                </span>
                <span className="public-session__person">
                  <span aria-hidden="true" className="classin-avatar">
                    {initials(organizerName)}
                  </span>
                  {organizerName}
                </span>
              </div>

              {formError && (
                <p className="classin-form-error" role="alert">
                  {t(formError)}
                </p>
              )}
              {createMeeting.isError && (
                <p className="classin-form-error" role="alert">
                  {t(createErrorKey(createMeeting.error))}
                </p>
              )}
            </div>

            <aside
              aria-label={t("publicSession.previewLabel")}
              className="public-session__aside"
            >
              <RoomIllustration />
              <ul className="public-session__features">
                {capabilityRows.map(([labelKey, enabled]) => (
                  <li data-enabled={enabled ? "true" : "false"} key={labelKey}>
                    <span aria-hidden="true">
                      {enabled ? <Check /> : <Minus />}
                    </span>
                    <span>{t(labelKey)}</span>
                    <strong>
                      {enabled
                        ? t("publicSession.featureOn")
                        : t("publicSession.featureOff")}
                    </strong>
                  </li>
                ))}
              </ul>
            </aside>

            <div className="classin-dialog__footer public-session__footer">
              <Button
                className="classin-cta classin-cta--green"
                disabled={!availability.available}
                leadingIcon={
                  startMode === "now" ? <Video /> : <CalendarClock />
                }
                loading={busy}
                loadingLabel={
                  launching
                    ? t("media.launch.opening")
                    : t("publicSession.submitting")
                }
                type="submit"
              >
                {startMode === "now" && mediaRoomsEnabled
                  ? t("publicSession.submitNow")
                  : t("publicSession.submitScheduled")}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

type JoinTarget = { kind: "space"; id: string } | { kind: "uuid"; id: string };

/** Accepts a same-origin waiting-room link/path or a bare UUID. */
function parsePublicSessionTarget(
  raw: string,
  origin: string,
): JoinTarget | null {
  const value = raw.trim();
  if (uuidPattern.test(value)) {
    return { kind: "uuid", id: value.toLowerCase() };
  }
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) {
    return null;
  }
  const match = spacePathPattern.exec(url.pathname);
  const id = match?.[1];
  return id && uuidPattern.test(id)
    ? { kind: "space", id: id.toLowerCase() }
    : null;
}

interface JoinPublicSessionDialogProps {
  currentUserID: string;
  mediaRoomsEnabled: boolean;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  tenantID: string;
  timezone: string;
}

/** ClassIn ref-05 style: pill bar for a link/code plus the user's meetings. */
export function JoinPublicSessionDialog({
  currentUserID,
  mediaRoomsEnabled,
  onOpenChange,
  open,
  tenantID,
  timezone,
}: JoinPublicSessionDialogProps) {
  const { language, t } = useI18n();
  const navigate = useNavigate();
  const inputID = useId();
  const locale = language === "vi" ? "vi-VN" : "en-US";
  const meetingsQuery = useStudyMeetingList(open ? tenantID : undefined);
  const [input, setInput] = useState("");
  const [error, setError] = useState<TranslationKey | null>(null);
  const [pending, setPending] = useState(false);
  // The dialog is mounted when opened, so this is the "now" of that visit.
  const [nowMS] = useState(() => Date.now());
  const origin =
    typeof window === "undefined" ? "http://localhost" : window.location.origin;

  const upcoming = useMemo(
    () =>
      (meetingsQuery.data?.meetings ?? [])
        .filter(
          (meeting) =>
            meeting.status === "scheduled" &&
            Date.parse(meeting.ends_at) > nowMS,
        )
        .sort(
          (left, right) =>
            Date.parse(left.starts_at) - Date.parse(right.starts_at),
        ),
    [meetingsQuery.data?.meetings, nowMS],
  );
  const keyword = input.trim().toLocaleLowerCase(locale);
  const isTargetInput = parsePublicSessionTarget(input, origin) !== null;
  const visible =
    keyword && !isTargetInput
      ? upcoming.filter((meeting) =>
          meeting.title.toLocaleLowerCase(locale).includes(keyword),
        )
      : upcoming;

  const goToSpace = (spaceID: string, title?: string) => {
    onOpenChange(false);
    void navigate(`/app/media/spaces/${spaceID}/prejoin`, {
      state: { classTitle: title, returnTo: "/app/classrooms" },
    });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = parsePublicSessionTarget(input, origin);
    if (!target) {
      setError("publicSession.joinInvalid");
      return;
    }
    setError(null);
    if (target.kind === "space") {
      goToSpace(target.id);
      return;
    }
    const meeting = upcoming.find((item) => item.id === target.id);
    setPending(true);
    try {
      if (meeting) {
        const space = await launchMediaSpace(tenantID, {
          canStart: meeting.owner_user_id === currentUserID,
          source: { kind: "study_meeting", study_meeting_id: meeting.id },
        });
        goToSpace(space.id, meeting.title);
        return;
      }
      // Not one of the viewer's meetings: an invited member may still resolve
      // its room; otherwise the UUID is treated as a media space ID.
      const space = await resolveMediaSpace(
        tenantID,
        { kind: "study_meeting", study_meeting_id: target.id },
        { baseUrl: getApiBaseUrl() },
      );
      goToSpace(space.id);
    } catch (launchError) {
      if (
        !meeting &&
        launchError instanceof APIRequestError &&
        [400, 404].includes(launchError.status)
      ) {
        goToSpace(target.id);
        return;
      }
      setError(
        launchError instanceof MediaSpaceNotReadyError ||
          (launchError instanceof APIRequestError &&
            [403, 404].includes(launchError.status))
          ? "publicSession.joinNotFound"
          : "publicSession.joinError",
      );
    } finally {
      setPending(false);
    }
  };

  const listForbidden =
    meetingsQuery.error instanceof APIRequestError &&
    meetingsQuery.error.status === 403;

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!pending) {
          onOpenChange(nextOpen);
          if (!nextOpen) {
            setInput("");
            setError(null);
          }
        }
      }}
      open={open}
    >
      <DialogContent
        className="classin-dialog classin-join-dialog public-session-join"
        closeLabel={t("publicSession.joinClose")}
      >
        <DialogTitle>{t("publicSession.joinTitle")}</DialogTitle>
        <DialogDescription>
          {t("publicSession.joinDescription")}
        </DialogDescription>
        <form
          className="classin-join-form"
          onSubmit={(event) => void submit(event)}
        >
          <div
            className="classin-pill-bar"
            data-invalid={error ? "true" : undefined}
          >
            <Search aria-hidden="true" className="classin-pill-bar__icon" />
            <label className="visually-hidden" htmlFor={inputID}>
              {t("publicSession.joinInputLabel")}
            </label>
            <input
              aria-describedby={`${inputID}-hint`}
              aria-invalid={error ? true : undefined}
              autoComplete="off"
              className="classin-pill-bar__input"
              id={inputID}
              maxLength={2048}
              onChange={(event) => {
                setInput(event.target.value);
                setError(null);
              }}
              placeholder={t("publicSession.joinInputPlaceholder")}
              spellCheck={false}
              type="text"
              value={input}
            />
            <Button
              className="classin-pill-bar__submit"
              loading={pending}
              loadingLabel={t("media.launch.opening")}
              size="sm"
              type="submit"
            >
              {t("publicSession.joinAction")}
            </Button>
          </div>
          {error && (
            <p className="classin-form-error" role="alert">
              {t(error)}
            </p>
          )}
          <p className="classin-inline-note" id={`${inputID}-hint`}>
            {t("publicSession.joinHint")}
          </p>
        </form>

        <section
          aria-labelledby={`${inputID}-list`}
          className="public-session-join__list"
        >
          <h3 id={`${inputID}-list`}>{t("publicSession.listTitle")}</h3>
          {!mediaRoomsEnabled && (
            <p className="classin-inline-note">
              {t("publicSession.mediaUnavailable")}
            </p>
          )}
          {meetingsQuery.isPending && (
            <SkeletonGroup label={t("publicSession.listLoading")}>
              <Skeleton height={56} />
              <Skeleton height={56} />
            </SkeletonGroup>
          )}
          {meetingsQuery.isError && (
            <div className="classin-inline-error" role="alert">
              <span>
                {listForbidden
                  ? t("publicSession.listForbidden")
                  : t("publicSession.listError")}
              </span>
              {!listForbidden && (
                <Button
                  leadingIcon={<RotateCw />}
                  onClick={() => void meetingsQuery.refetch()}
                  size="sm"
                  variant="secondary"
                >
                  {t("state.retry")}
                </Button>
              )}
            </div>
          )}
          {meetingsQuery.isSuccess && visible.length === 0 && (
            <p className="public-session-join__empty">
              {upcoming.length === 0
                ? t("publicSession.listEmpty")
                : t("publicSession.listFiltered")}
            </p>
          )}
          {visible.length > 0 && (
            <ul className="public-session-join__items">
              {visible.map((meeting) => {
                const live =
                  Date.parse(meeting.starts_at) <= nowMS &&
                  Date.parse(meeting.ends_at) > nowMS;
                return (
                  <li key={meeting.id}>
                    <span
                      aria-hidden="true"
                      className="public-session-join__icon"
                    >
                      <Video />
                    </span>
                    <div>
                      <strong>{meeting.title}</strong>
                      <span>
                        {live && (
                          <em className="classin-live-dot">
                            {t("publicSession.liveNow")}
                          </em>
                        )}
                        {formatMeetingRange(meeting, locale, timezone)}
                      </span>
                    </div>
                    {mediaRoomsEnabled && (
                      <MediaSpaceLaunchAction
                        canStart={meeting.owner_user_id === currentUserID}
                        source={{
                          kind: "study_meeting",
                          study_meeting_id: meeting.id,
                        }}
                        tenantID={tenantID}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}
