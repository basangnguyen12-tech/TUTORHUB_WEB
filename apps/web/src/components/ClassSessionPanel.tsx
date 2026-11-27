import {
  APIRequestError,
  type CreateClassSessionRequest,
  type ClassSession,
  type ClassroomClass,
  type UpdateClassSessionRequest,
} from "@tutorhub/api-client";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  EmptyState,
  ErrorState,
  ForbiddenState,
  IconButton,
  OfflineState,
  Skeleton,
  SkeletonGroup,
  StatusBadge,
  TextAreaField,
  TextField,
} from "@tutorhub/ui";
import {
  ArrowUpDown,
  CalendarClock,
  CalendarPlus,
  FolderOpen,
  Pencil,
  Plus,
  RotateCw,
  Video,
  X,
} from "lucide-react";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import {
  civilInputFromInstant,
  isOrderedSessionRange,
  resolveCivilDateTime,
  type OverlapChoice,
} from "../app/classSessionTime";
import {
  useCancelClassSession,
  useClassSessionList,
  useCreateClassSession,
  useUpdateClassSession,
} from "../app/classSessions";
import { useI18n, type TranslationKey } from "../app/i18n";
import type { TenantOperationAvailability } from "../app/tenantCapabilities";
import { shouldConcealTenantScopedData } from "../app/tenantDataAccess";
import { useSession } from "../app/session";
import { MediaSpaceLaunchAction } from "./MediaSpaceLaunchAction";

interface ClassSessionPanelProps {
  classroom: ClassroomClass;
  mediaRoomsEnabled?: boolean;
  /** Shows the ClassIn-style shortcut cards (ref-08) when provided. */
  onOpenMaterials?: () => void;
  schedulingAvailability: TenantOperationAvailability;
}

type SessionFilter = "all" | "upcoming" | "ended";
const sessionFilters = [
  ["all", "classSession.filterAll"],
  ["upcoming", "classSession.filterUpcoming"],
  ["ended", "classSession.filterEnded"],
] as const satisfies readonly (readonly [SessionFilter, TranslationKey])[];

function matchesSessionFilter(session: ClassSession, filter: SessionFilter) {
  if (filter === "upcoming") {
    return session.status === "scheduled" || session.status === "live";
  }
  if (filter === "ended") {
    return session.status === "ended";
  }
  return true;
}

const rangeWindow = () => {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 1);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 92);
  return { start: start.toISOString(), end: end.toISOString() };
};

function sessionErrorKey(error: Error | null): TranslationKey {
  if (error instanceof APIRequestError && error.status === 403) {
    return "classSession.mutationForbidden";
  }
  if (
    error instanceof APIRequestError &&
    error.problem?.code === "class_session_schedule_conflict"
  ) {
    return "classSession.scheduleConflict";
  }
  if (error instanceof APIRequestError && error.status === 409) {
    return "classSession.conflict";
  }
  return "classSession.formError";
}

function formatSessionRange(
  session: ClassSession,
  viewerTimezone: string,
  locale: string,
) {
  const viewerFormatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: viewerTimezone,
  });
  const classFormatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: session.timezone,
  });
  const viewer = `${viewerFormatter.format(new Date(session.starts_at))} – ${viewerFormatter.format(new Date(session.ends_at))}`;
  const classTime =
    session.timezone === viewerTimezone
      ? undefined
      : `${classFormatter.format(new Date(session.starts_at))} – ${classFormatter.format(new Date(session.ends_at))}`;
  return { classTime, viewer };
}

export function ClassSessionPanel({
  classroom,
  mediaRoomsEnabled = false,
  onOpenMaterials,
  schedulingAvailability,
}: ClassSessionPanelProps) {
  const { language, t } = useI18n();
  const session = useSession();
  const tenantID = session.currentUser?.active_tenant?.id;
  const viewerTimezone =
    session.currentUser?.user.timezone || classroom.timezone;
  const locale = language === "vi" ? "vi-VN" : "en-US";
  const range = useMemo(() => rangeWindow(), []);
  const sessionsQuery = useClassSessionList(
    tenantID,
    classroom.id,
    range.start,
    range.end,
  );
  const createMutation = useCreateClassSession(tenantID);
  const updateMutation = useUpdateClassSession(tenantID);
  const cancelMutation = useCancelClassSession(tenantID);
  const [editing, setEditing] = useState<ClassSession | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<ClassSession | null>(null);
  const [filter, setFilter] = useState<SessionFilter>("all");
  const [newestFirst, setNewestFirst] = useState(false);

  const items = useMemo(() => {
    const seen = new Set<string>();
    return (sessionsQuery.data?.pages ?? [])
      .flatMap((page) => page.items)
      .filter((item) => {
        if (seen.has(item.id)) {
          return false;
        }
        seen.add(item.id);
        return true;
      });
  }, [sessionsQuery.data?.pages]);
  const visibleItems = useMemo(() => {
    const filtered = items.filter((item) => matchesSessionFilter(item, filter));
    const sorted = [...filtered].sort(
      (left, right) => Date.parse(left.starts_at) - Date.parse(right.starts_at),
    );
    return newestFirst ? sorted.reverse() : sorted;
  }, [filter, items, newestFirst]);

  const canSchedule =
    schedulingAvailability.available &&
    classroom.viewer_access.can_schedule_sessions;
  const concealed = shouldConcealTenantScopedData(sessionsQuery.error);
  const isOffline = typeof navigator !== "undefined" && !navigator.onLine;

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  return (
    <section
      aria-labelledby="class-session-heading"
      className="classroom-detail__section class-session-panel"
    >
      <div className="class-session-panel__heading">
        <div className="visually-hidden">
          <h2 id="class-session-heading">
            <CalendarClock aria-hidden="true" /> {t("classSession.title")}
          </h2>
          <p>{t("classSession.description")}</p>
        </div>
        <div
          aria-label={t("classSession.filterLabel")}
          className="classin-chip-group"
          role="group"
        >
          {sessionFilters.map(([value, labelKey]) => (
            <button
              aria-pressed={filter === value}
              className="classin-chip"
              key={value}
              onClick={() => setFilter(value)}
              type="button"
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
        <div className="class-session-panel__tools">
          <IconButton
            className="classin-icon-button"
            label={
              newestFirst
                ? t("classSession.sortNewest")
                : t("classSession.sortOldest")
            }
            onClick={() => setNewestFirst((current) => !current)}
            size="sm"
          >
            <ArrowUpDown />
          </IconButton>
          {canSchedule && (
            <Button
              className="classin-cta"
              leadingIcon={<Plus />}
              onClick={openCreate}
              size="sm"
            >
              {t("classSession.scheduleAction")}
            </Button>
          )}
        </div>
      </div>

      {onOpenMaterials && classroom.status === "active" && (
        <ul
          aria-label={t("classSession.quickActionsLabel")}
          className="class-quick-cards"
        >
          <li>
            {canSchedule ? (
              <button
                className="class-quick-card"
                data-tone="ice"
                onClick={openCreate}
                type="button"
              >
                <span aria-hidden="true" className="class-quick-card__icon">
                  <CalendarPlus />
                </span>
                <span className="class-quick-card__text">
                  <strong>{t("classSession.quickScheduleTitle")}</strong>
                  <span>{t("classSession.quickScheduleDescription")}</span>
                </span>
              </button>
            ) : (
              <Link
                className="class-quick-card"
                data-tone="ice"
                to="/app/calendar"
              >
                <span aria-hidden="true" className="class-quick-card__icon">
                  <CalendarClock />
                </span>
                <span className="class-quick-card__text">
                  <strong>{t("classSession.quickCalendarTitle")}</strong>
                  <span>{t("classSession.quickCalendarDescription")}</span>
                </span>
              </Link>
            )}
          </li>
          <li>
            <button
              className="class-quick-card"
              data-tone="lilac"
              onClick={onOpenMaterials}
              type="button"
            >
              <span aria-hidden="true" className="class-quick-card__icon">
                <FolderOpen />
              </span>
              <span className="class-quick-card__text">
                <strong>{t("classSession.quickMaterialsTitle")}</strong>
                <span>{t("classSession.quickMaterialsDescription")}</span>
              </span>
            </button>
          </li>
        </ul>
      )}

      {sessionsQuery.isPending && (
        <SkeletonGroup
          label={t("classSession.loading")}
          className="class-session-list"
        >
          <Skeleton height="5rem" />
          <Skeleton height="5rem" />
        </SkeletonGroup>
      )}

      {!sessionsQuery.isPending &&
        sessionsQuery.isError &&
        concealed &&
        (sessionsQuery.error instanceof APIRequestError &&
        sessionsQuery.error.status === 403 ? (
          <ForbiddenState
            description={t("classSession.forbiddenDescription")}
            title={t("classSession.forbiddenTitle")}
          />
        ) : sessionsQuery.error instanceof APIRequestError &&
          sessionsQuery.error.status === 404 ? (
          <ErrorState
            description={t("classSession.notFoundDescription")}
            title={t("classSession.notFoundTitle")}
          />
        ) : (
          <ErrorState
            actions={
              <Button
                leadingIcon={<RotateCw />}
                onClick={() => void sessionsQuery.refetch()}
                variant="secondary"
              >
                {t("state.retry")}
              </Button>
            }
            description={t("classSession.loadErrorDescription")}
            title={t("classSession.loadErrorTitle")}
          />
        ))}

      {!sessionsQuery.isPending && !concealed && isOffline && (
        <OfflineState
          actions={
            <Button
              leadingIcon={<RotateCw />}
              onClick={() => void sessionsQuery.refetch()}
              variant="secondary"
            >
              {t("state.retry")}
            </Button>
          }
          description={t("classSession.loadErrorDescription")}
          title={t("state.offlineTitle")}
        />
      )}

      {!sessionsQuery.isPending &&
        !concealed &&
        !isOffline &&
        sessionsQuery.isError &&
        items.length === 0 && (
          <ErrorState
            actions={
              <Button
                leadingIcon={<RotateCw />}
                onClick={() => void sessionsQuery.refetch()}
                variant="secondary"
              >
                {t("state.retry")}
              </Button>
            }
            description={t("classSession.loadErrorDescription")}
            title={t("classSession.loadErrorTitle")}
          />
        )}

      {!sessionsQuery.isPending &&
        !concealed &&
        !sessionsQuery.isError &&
        items.length === 0 && (
          <EmptyState
            actions={
              canSchedule ? (
                <Button leadingIcon={<Plus />} onClick={openCreate}>
                  {t("classSession.scheduleAction")}
                </Button>
              ) : undefined
            }
            description={t("classSession.emptyDescription")}
            title={t("classSession.emptyTitle")}
          />
        )}

      {!concealed && items.length > 0 && visibleItems.length === 0 && (
        <p className="class-session-panel__filtered-empty" role="status">
          {t("classSession.filteredEmpty")}
        </p>
      )}

      {!concealed && visibleItems.length > 0 && (
        <div className="class-session-list">
          {visibleItems.map((item) => {
            const rangeText = formatSessionRange(item, viewerTimezone, locale);
            const editable = canSchedule && item.viewer_access.can_update;
            const cancellable = canSchedule && item.viewer_access.can_cancel;
            const canOpenMedia =
              mediaRoomsEnabled &&
              classroom.status === "active" &&
              (item.status === "scheduled" || item.status === "live");
            const canStartMedia = item.viewer_access.can_update;
            const minutes = Math.max(
              0,
              Math.round(
                (Date.parse(item.ends_at) - Date.parse(item.starts_at)) /
                  60_000,
              ),
            );
            return (
              <article
                className="class-session-card"
                data-status={item.status}
                key={item.id}
              >
                <span aria-hidden="true" className="class-session-card__icon">
                  {item.status === "live" ? <Video /> : <CalendarClock />}
                </span>
                <div className="class-session-card__body">
                  <h3>{item.title}</h3>
                  <p className="class-session-card__meta">
                    <StatusBadge
                      tone={
                        item.status === "cancelled"
                          ? "danger"
                          : item.status === "ended"
                            ? "neutral"
                            : "success"
                      }
                    >
                      {item.status === "cancelled"
                        ? t("classSession.cancelled")
                        : item.status === "live"
                          ? t("classSession.live")
                          : item.status === "ended"
                            ? t("classSession.ended")
                            : t("classSession.scheduled")}
                    </StatusBadge>
                    <time dateTime={item.starts_at}>{rangeText.viewer}</time>
                    <span>
                      {t("classSession.durationMinutes", { minutes })}
                    </span>
                    <small>{t("classSession.viewerTime")}</small>
                  </p>
                  {rangeText.classTime && (
                    <small className="class-session-card__class-time">
                      {t("classSession.classTime", {
                        timezone: item.timezone,
                      })}
                      : {rangeText.classTime}
                    </small>
                  )}
                  {item.description && <p>{item.description}</p>}
                </div>
                {(canOpenMedia ||
                  ((editable || cancellable) &&
                    item.status === "scheduled")) && (
                  <div className="class-session-card__actions">
                    {canOpenMedia && (
                      <MediaSpaceLaunchAction
                        canStart={canStartMedia}
                        source={{
                          class_session_id: item.id,
                          kind: "class_session",
                        }}
                        tenantID={tenantID}
                      />
                    )}
                    {editable && (
                      <Button
                        leadingIcon={<Pencil />}
                        onClick={() => {
                          setEditing(item);
                          setFormOpen(true);
                        }}
                        size="sm"
                        variant="secondary"
                      >
                        {t("classSession.editAction")}
                      </Button>
                    )}
                    {cancellable && (
                      <Button
                        leadingIcon={<X />}
                        onClick={() => setCancelTarget(item)}
                        size="sm"
                        variant="danger"
                      >
                        {t("classSession.cancelAction")}
                      </Button>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {!concealed && sessionsQuery.hasNextPage && (
        <div className="class-session-panel__load-more">
          {sessionsQuery.isFetchNextPageError && (
            <p role="alert">{t("classSession.loadMoreError")}</p>
          )}
          <Button
            disabled={isOffline}
            loading={sessionsQuery.isFetchingNextPage}
            loadingLabel={t("classSession.loadingMore")}
            onClick={() => void sessionsQuery.fetchNextPage()}
            variant="secondary"
          >
            {t("classSession.loadMore")}
          </Button>
        </div>
      )}

      {formOpen && (
        <ClassSessionEditorDialog
          classTitle={classroom.title}
          classTimezone={classroom.timezone}
          error={createMutation.error ?? updateMutation.error ?? null}
          initial={editing}
          key={editing?.id ?? "create"}
          onOpenChange={(open) => {
            if (
              !open &&
              !createMutation.isPending &&
              !updateMutation.isPending
            ) {
              setFormOpen(false);
              createMutation.reset();
              updateMutation.reset();
            }
          }}
          onCreate={(input) => {
            createMutation.mutate(
              { classID: classroom.id, input },
              {
                onSuccess: () => setFormOpen(false),
              },
            );
          }}
          onUpdate={(input) => {
            if (!editing) {
              return;
            }
            updateMutation.mutate(
              { classID: classroom.id, sessionID: editing.id, input },
              {
                onSuccess: () => {
                  setFormOpen(false);
                  setEditing(null);
                },
              },
            );
          }}
          open={formOpen}
          pending={createMutation.isPending || updateMutation.isPending}
        />
      )}

      <Dialog
        onOpenChange={(open) => {
          if (!cancelMutation.isPending) {
            setCancelTarget(open ? cancelTarget : null);
            if (!open) {
              cancelMutation.reset();
            }
          }
        }}
        open={Boolean(cancelTarget)}
      >
        <DialogContent closeLabel={t("classSession.closeDialog")}>
          <DialogTitle>{t("classSession.cancelConfirmTitle")}</DialogTitle>
          <DialogDescription>
            {t("classSession.cancelConfirmDescription")}
          </DialogDescription>
          {cancelMutation.error && (
            <p className="form-error" role="alert">
              {t(sessionErrorKey(cancelMutation.error))}
            </p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button disabled={cancelMutation.isPending} variant="secondary">
                {t("classSession.cancel")}
              </Button>
            </DialogClose>
            <Button
              loading={cancelMutation.isPending}
              loadingLabel={t("classSession.cancelling")}
              onClick={() => {
                if (cancelTarget) {
                  cancelMutation.mutate(
                    {
                      classID: classroom.id,
                      sessionID: cancelTarget.id,
                      input: { expected_version: cancelTarget.version },
                    },
                    {
                      onSuccess: () => setCancelTarget(null),
                    },
                  );
                }
              }}
              variant="danger"
            >
              {t("classSession.cancelConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export interface ClassSessionEditorDialogProps {
  classTitle: string;
  classTimezone: string;
  context?: ReactNode;
  error: Error | null;
  initial: ClassSession | null;
  onCreate: (input: CreateClassSessionRequest) => void;
  onOpenChange: (open: boolean) => void;
  onUpdate: (input: UpdateClassSessionRequest) => void;
  open: boolean;
  pending: boolean;
}

export function ClassSessionEditorDialog({
  classTitle,
  classTimezone,
  context,
  error,
  initial,
  onCreate,
  onOpenChange,
  onUpdate,
  open,
  pending,
}: ClassSessionEditorDialogProps) {
  const { t } = useI18n();
  const [title, setTitle] = useState(initial?.title ?? classTitle);
  const [description, setDescription] = useState(initial?.description ?? "");
  const [startsAt, setStartsAt] = useState(
    initial ? civilInputFromInstant(initial.starts_at, initial.timezone) : "",
  );
  const [endsAt, setEndsAt] = useState(
    initial ? civilInputFromInstant(initial.ends_at, initial.timezone) : "",
  );
  const [timezone, setTimezone] = useState(initial?.timezone ?? classTimezone);
  const [overlapChoice, setOverlapChoice] = useState<OverlapChoice | "">("");
  const [formError, setFormError] = useState<TranslationKey | null>(null);
  const isEditing = Boolean(initial);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const submittedTitle = String(formData.get("title") ?? title);
    const submittedDescription = String(
      formData.get("description") ?? description,
    );
    const submittedStartsAt = String(formData.get("startsAt") ?? startsAt);
    const submittedEndsAt = String(formData.get("endsAt") ?? endsAt);
    const submittedTimezone = String(formData.get("timezone") ?? timezone);
    const start = resolveCivilDateTime(
      submittedStartsAt,
      submittedTimezone,
      overlapChoice || undefined,
    );
    const end = resolveCivilDateTime(
      submittedEndsAt,
      submittedTimezone,
      overlapChoice || undefined,
    );
    if (start.kind === "overlap" || end.kind === "overlap") {
      setFormError("classSession.timeOverlap");
      return;
    }
    if (start.kind === "invalid" || end.kind === "invalid") {
      const isGap =
        (start.kind === "invalid" && start.reason === "gap") ||
        (end.kind === "invalid" && end.reason === "gap");
      setFormError(isGap ? "classSession.timeGap" : "classSession.formError");
      return;
    }
    if (!isOrderedSessionRange(start.value, end.value)) {
      setFormError("classSession.invalidRange");
      return;
    }
    setFormError(null);
    if (isEditing && initial) {
      onUpdate({
        description: submittedDescription,
        ends_at: end.value,
        expected_version: initial.version,
        starts_at: start.value,
        timezone: submittedTimezone,
        title: submittedTitle.trim(),
      });
      return;
    }
    onCreate({
      description: submittedDescription,
      ends_at: end.value,
      starts_at: start.value,
      timezone: submittedTimezone,
      title: submittedTitle.trim(),
    });
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent closeLabel={t("classSession.closeDialog")}>
        <DialogTitle>
          {isEditing
            ? t("classSession.editTitle")
            : t("classSession.createTitle")}
        </DialogTitle>
        <DialogDescription>
          {t("classSession.formDescription")}
        </DialogDescription>
        {context}
        <form className="class-session-form" onSubmit={submit}>
          <TextField
            id="class-session-title"
            label={t("classSession.titleLabel")}
            maxLength={200}
            name="title"
            onChange={(event) => setTitle(event.target.value)}
            required
            value={title}
          />
          <TextAreaField
            id="class-session-description"
            label={t("classSession.descriptionLabel")}
            maxLength={4000}
            name="description"
            onChange={(event) => setDescription(event.target.value)}
            value={description}
          />
          <div className="class-session-form__grid">
            <TextField
              id="class-session-starts"
              label={t("classSession.startsAtLabel")}
              name="startsAt"
              onChange={(event) => setStartsAt(event.target.value)}
              onInput={(event) => setStartsAt(event.currentTarget.value)}
              required
              type="datetime-local"
              value={startsAt}
            />
            <TextField
              id="class-session-ends"
              label={t("classSession.endsAtLabel")}
              name="endsAt"
              onChange={(event) => setEndsAt(event.target.value)}
              onInput={(event) => setEndsAt(event.currentTarget.value)}
              required
              type="datetime-local"
              value={endsAt}
            />
          </div>
          <TextField
            id="class-session-timezone"
            label={t("classSession.timezoneLabel")}
            maxLength={100}
            name="timezone"
            onChange={(event) => setTimezone(event.target.value)}
            required
            value={timezone}
          />
          <label
            className="class-session-form__select"
            htmlFor="class-session-overlap"
          >
            {t("classSession.overlapLabel")}
            <select
              id="class-session-overlap"
              onChange={(event) =>
                setOverlapChoice(event.target.value as OverlapChoice | "")
              }
              value={overlapChoice}
            >
              <option value="">—</option>
              <option value="earlier">
                {t("classSession.overlapEarlier")}
              </option>
              <option value="later">{t("classSession.overlapLater")}</option>
            </select>
          </label>
          {(formError || error) && (
            <p className="form-error" role="alert">
              {formError ? t(formError) : t(sessionErrorKey(error))}
            </p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button disabled={pending} variant="secondary">
                {t("classSession.cancel")}
              </Button>
            </DialogClose>
            <Button
              loading={pending}
              loadingLabel={t("classSession.saving")}
              type="submit"
            >
              {t("classSession.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
