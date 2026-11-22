import { APIRequestError, type ClassroomClass } from "@tutorhub/api-client";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  SelectField,
  Skeleton,
  SkeletonGroup,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TextAreaField,
  TextField,
  type ButtonSize,
} from "@tutorhub/ui";
import { ChevronDown, Plus, Power, RotateCw } from "lucide-react";
import { useId, useMemo, useState, type FormEvent } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";
import {
  useClassDetail,
  useClassList,
  useCreateClass,
  useUpdateClass,
  type ClassStatusFilter,
} from "../app/classes";
import { useLeaveClass } from "../app/classEnrollments";
import { useI18n, type TranslationKey } from "../app/i18n";
import { useSession } from "../app/session";
import {
  tenantOperationAvailability,
  useTenantCapabilities,
  type TenantOperationAvailability,
} from "../app/tenantCapabilities";
import { shouldConcealTenantScopedData } from "../app/tenantDataAccess";
import { useTenantDetail } from "../app/workspaces";
import { ClassEnrollmentPanel } from "../components/ClassEnrollmentPanel";
import { ClassConversationAction } from "../components/ClassConversationAction";
import { ClassFilesPanel } from "../components/ClassFilesPanel";
import { ClassJoinDialog } from "../components/ClassJoinDialog";
import { ClassManagementPanel } from "../components/ClassManagementPanel";
import { ClassroomQuickLaunchAction } from "../components/ClassroomQuickLaunchAction";
import { ClassRosterPanel } from "../components/ClassRosterPanel";
import { ClassSessionPanel } from "../components/ClassSessionPanel";
import { TenantOperationNotice } from "../components/TenantOperationNotice";
import "./ClassroomPages.css";

const classCodePattern = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

function leaveClassErrorKey(error: Error | null): TranslationKey {
  if (error instanceof APIRequestError && error.status === 403) {
    return "classEnrollment.leaveForbidden";
  }
  if (error instanceof APIRequestError && error.status === 404) {
    return "classEnrollment.leaveNotFound";
  }
  if (error instanceof APIRequestError && error.status === 409) {
    return "classEnrollment.leaveConflict";
  }
  return "classEnrollment.leaveError";
}

const classDetailTabs = [
  "sessions",
  "materials",
  "members",
  "settings",
] as const;
type ClassDetailTab = (typeof classDetailTabs)[number];

function isClassDetailTab(value: string | null): value is ClassDetailTab {
  return classDetailTabs.some((tab) => tab === value);
}

const activationErrorKeys = [
  "classroom.activateError",
  "classroom.activateQuotaError",
  "classroom.updateConflict",
  "classroom.updateForbidden",
] as const satisfies readonly TranslationKey[];
type ActivationErrorKey = (typeof activationErrorKeys)[number];

function activateClassErrorKey(error: Error | null): ActivationErrorKey {
  if (error instanceof APIRequestError) {
    const code = error.problem?.code ?? "";
    const type = error.problem?.type ?? "";
    if (
      error.status === 429 ||
      code === "quota_exceeded" ||
      type.endsWith(":quota_exceeded")
    ) {
      return "classroom.activateQuotaError";
    }
    if (error.status === 403) {
      return "classroom.updateForbidden";
    }
    if (error.status === 409) {
      return "classroom.updateConflict";
    }
  }
  return "classroom.activateError";
}

/** Reads the activation failure handed over by the create dialog, if any. */
function activationNoticeFromState(state: unknown): ActivationErrorKey | null {
  if (typeof state !== "object" || state === null) {
    return null;
  }
  const value = (state as { activationError?: unknown }).activationError;
  return activationErrorKeys.find((key) => key === value) ?? null;
}

export function ClassroomListPage() {
  const { t } = useI18n();
  const session = useSession();
  const activeTenant = session.currentUser?.active_tenant;
  const canCreate =
    session.currentUser?.permissions.includes("class.create") ?? false;
  const [statusFilter, setStatusFilter] = useState<ClassStatusFilter>("all");
  const classesQuery = useClassList(activeTenant?.id, statusFilter);
  const capabilitiesQuery = useTenantCapabilities(activeTenant?.id);
  const createAvailability = tenantOperationAvailability(
    capabilitiesQuery,
    "create_class",
  );
  const joinAvailability = tenantOperationAvailability(
    capabilitiesQuery,
    "join_class_invite_link",
  );
  const activateAvailability = tenantOperationAvailability(
    capabilitiesQuery,
    "activate_class",
  );
  const schedulingAvailability = tenantOperationAvailability(
    capabilitiesQuery,
    "schedule_class_session",
  );
  const mediaRoomsEnabled =
    capabilitiesQuery.data?.features.classroom_media_rooms?.enabled;
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [joinedClass, setJoinedClass] = useState<{
    classroom: ClassroomClass;
    tenantID: string;
  } | null>(null);
  const classrooms = useMemo(() => {
    const byID = new Map<string, ClassroomClass>();
    for (const page of classesQuery.data?.pages ?? []) {
      for (const classroom of page.items) {
        if (!byID.has(classroom.id)) {
          byID.set(classroom.id, classroom);
        }
      }
    }
    return [...byID.values()];
  }, [classesQuery.data?.pages]);
  const classesConcealed = shouldConcealTenantScopedData(classesQuery.error);

  return (
    <div className="page-content classroom-page">
      <header className="classroom-heading">
        <div>
          <p>{activeTenant?.name}</p>
          <h1>{t("classroom.title")}</h1>
          <span>{t("classroom.description")}</span>
        </div>
        {!classesConcealed && (
          <div className="classroom-heading__actions">
            {activeTenant && (
              <ClassJoinDialog
                availability={joinAvailability}
                onJoined={(classroom, tenantID) => {
                  setStatusFilter("all");
                  setJoinedClass({ classroom, tenantID });
                }}
                tenantID={activeTenant.id}
              />
            )}
            {canCreate && (
              <Button
                aria-expanded={isCreateOpen}
                aria-haspopup="dialog"
                className="classroom-primary-action"
                disabled={!createAvailability.available}
                leadingIcon={<Plus />}
                onClick={() => setIsCreateOpen(true)}
              >
                {t("classroom.createAction")}
              </Button>
            )}
          </div>
        )}
      </header>

      {!classesConcealed && activeTenant && (
        <div className="tenant-operation-notices">
          <TenantOperationNotice
            availability={joinAvailability}
            label={t("capabilities.operationJoinClass")}
            onRetry={() => void capabilitiesQuery.refetch()}
          />
          {canCreate && (
            <TenantOperationNotice
              availability={createAvailability}
              label={t("capabilities.operationCreateClass")}
              onRetry={() => void capabilitiesQuery.refetch()}
            />
          )}
        </div>
      )}

      {!classesConcealed && canCreate && (
        <CreateClassDialog
          activateAvailable={activateAvailability.available}
          available={createAvailability.available}
          onOpenChange={setIsCreateOpen}
          open={isCreateOpen}
        />
      )}

      {!classesConcealed &&
        joinedClass &&
        joinedClass.tenantID === activeTenant?.id && (
          <p className="classroom-join-feedback" role="status">
            <span>
              {t("classInvitation.joinedSuccess", {
                title: joinedClass.classroom.title,
              })}
            </span>
            <Link to={`/app/classrooms/${joinedClass.classroom.id}`}>
              {t("classInvitation.openJoinedClass")}
            </Link>
          </p>
        )}

      <section aria-labelledby="class-list-heading" className="classroom-index">
        <div className="classroom-index__heading">
          <div>
            <h2 id="class-list-heading">{t("classroom.listTitle")}</h2>
            <p>{t("classroom.listDescription")}</p>
          </div>
          {!classesConcealed && classesQuery.data && (
            <span>
              {t("classroom.classCount", {
                count: classrooms.length,
              })}
            </span>
          )}
        </div>

        {!classesConcealed && (
          <div className="classroom-list-controls">
            <SelectField
              ariaLabel={t("classroom.statusFilterLabel")}
              label={t("classroom.statusFilterLabel")}
              onValueChange={(value) =>
                setStatusFilter(value as ClassStatusFilter)
              }
              options={[
                { label: t("classroom.statusFilterAll"), value: "all" },
                { label: t("classroom.statusDraft"), value: "draft" },
                { label: t("classroom.statusActive"), value: "active" },
                { label: t("classroom.statusArchived"), value: "archived" },
              ]}
              value={statusFilter}
            />
          </div>
        )}

        {classesQuery.isPending && <ClassListSkeleton />}
        {classesQuery.isError &&
          (classesConcealed || classrooms.length === 0) && (
            <ClassroomQueryError
              error={classesQuery.error}
              onRetry={() => void classesQuery.refetch()}
            />
          )}
        {!classesConcealed && classesQuery.data && classrooms.length === 0 && (
          <ClassroomEmptyState
            canCreate={canCreate && createAvailability.available}
            filtered={statusFilter !== "all"}
            onCreate={() => setIsCreateOpen(true)}
          />
        )}
        {!classesConcealed && classesQuery.data && classrooms.length > 0 && (
          <>
            <ClassCardGrid
              activateAvailability={activateAvailability}
              classes={classrooms}
              mediaRoomsEnabled={mediaRoomsEnabled}
              schedulingAvailability={schedulingAvailability}
            />
            {classesQuery.isFetchNextPageError && (
              <div className="classroom-pagination-error" role="alert">
                <span>{t("classroom.loadMoreError")}</span>
                <Button
                  onClick={() => void classesQuery.fetchNextPage()}
                  size="sm"
                  variant="secondary"
                >
                  {t("state.retry")}
                </Button>
              </div>
            )}
            {classesQuery.hasNextPage && !classesQuery.isFetchNextPageError && (
              <div className="classroom-pagination">
                <Button
                  leadingIcon={<ChevronDown />}
                  loading={classesQuery.isFetchingNextPage}
                  loadingLabel={t("classroom.loadingMore")}
                  onClick={() => void classesQuery.fetchNextPage()}
                  variant="secondary"
                >
                  {t("classroom.loadMore")}
                </Button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

export function ClassroomDetailPage() {
  const { classId } = useParams();
  const { language, t } = useI18n();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const session = useSession();
  const activeTenant = session.currentUser?.active_tenant;
  const classQuery = useClassDetail(activeTenant?.id, classId);
  const capabilitiesQuery = useTenantCapabilities(activeTenant?.id);
  const requestedTab = searchParams.get("tab");
  const activeTab: ClassDetailTab = isClassDetailTab(requestedTab)
    ? requestedTab
    : "sessions";

  const changeTab = (value: string) => {
    if (!isClassDetailTab(value) || value === activeTab) {
      return;
    }
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === "sessions") {
          next.delete("tab");
        } else {
          next.set("tab", value);
        }
        return next;
      },
      { replace: true, state: location.state },
    );
  };

  if (classQuery.isPending) {
    return (
      <div className="page-content classroom-page">
        <ClassDetailSkeleton />
      </div>
    );
  }
  if (classQuery.isError) {
    return (
      <div className="page-content classroom-page">
        <Link className="classroom-back-link" to="/app/classrooms">
          {t("classroom.backToList")}
        </Link>
        <ClassroomQueryError
          error={classQuery.error}
          onRetry={() => void classQuery.refetch()}
        />
      </div>
    );
  }

  const classroom = classQuery.data;
  const mediaRoomsEnabled =
    capabilitiesQuery.data?.features.classroom_media_rooms?.enabled;
  const schedulingAvailability = tenantOperationAvailability(
    capabilitiesQuery,
    "schedule_class_session",
  );
  const activateAvailability = tenantOperationAvailability(
    capabilitiesQuery,
    "activate_class",
  );
  const activationNotice =
    classroom.status === "draft"
      ? activationNoticeFromState(location.state)
      : null;
  const ownerLabel =
    classroom.owner_user_id === session.currentUser?.user.id
      ? t("classroom.ownerYou")
      : t("classroom.ownerMember");
  const dateFormatter = new Intl.DateTimeFormat(
    language === "vi" ? "vi-VN" : "en-US",
    { dateStyle: "medium", timeStyle: "short" },
  );

  return (
    <article className="page-content classroom-page classroom-detail">
      <Link className="classroom-back-link" to="/app/classrooms">
        {t("classroom.backToList")}
      </Link>
      <header className="classroom-detail__header">
        <div className="classroom-detail__heading">
          <div className="classroom-detail__identity">
            <code>{classroom.code}</code>
            <ClassStatus status={classroom.status} />
          </div>
          <h1>{classroom.title}</h1>
          <p>{classroom.description || t("classroom.noDescription")}</p>
          <dl className="classroom-detail__meta">
            <div>
              <dt>{t("classroom.workspaceLabel")}</dt>
              <dd>{activeTenant?.name}</dd>
            </div>
            <div>
              <dt>{t("classroom.ownerLabel")}</dt>
              <dd>{ownerLabel}</dd>
            </div>
            <div>
              <dt>{t("classroom.timezoneLabel")}</dt>
              <dd>{classroom.timezone}</dd>
            </div>
          </dl>
        </div>
        <div className="classroom-detail__actions">
          <ClassroomQuickLaunchAction
            classroom={classroom}
            mediaRoomsEnabled={mediaRoomsEnabled}
            schedulingAvailability={schedulingAvailability}
          />
          <div className="classroom-detail__conversation">
            <ClassConversationAction classID={classroom.id} />
          </div>
        </div>
      </header>

      {classroom.status === "draft" && (
        <section
          aria-labelledby="classroom-draft-banner-title"
          className="classroom-draft-banner"
        >
          <div>
            <h2 id="classroom-draft-banner-title">
              {t("classroom.draftBannerTitle")}
            </h2>
            <p>{t("classroom.draftBannerDescription")}</p>
            {activationNotice && (
              <p className="classroom-draft-banner__error" role="alert">
                {t(activationNotice)}
              </p>
            )}
          </div>
          {classroom.viewer_access.can_update_class &&
            activateAvailability.available && (
              <ClassActivateAction
                classroom={classroom}
                label={t("classroom.activateNowAction")}
              />
            )}
        </section>
      )}

      <Tabs
        className="classroom-tabs"
        onValueChange={changeTab}
        value={activeTab}
      >
        <TabsList
          aria-label={t("classroom.tabsLabel")}
          className="classroom-tabs__list"
        >
          <TabsTrigger className="classroom-tabs__trigger" value="sessions">
            {t("classroom.tab.sessions")}
          </TabsTrigger>
          <TabsTrigger className="classroom-tabs__trigger" value="materials">
            {t("classroom.tab.materials")}
          </TabsTrigger>
          <TabsTrigger className="classroom-tabs__trigger" value="members">
            {t("classroom.tab.members")}
          </TabsTrigger>
          <TabsTrigger className="classroom-tabs__trigger" value="settings">
            {t("classroom.tab.settings")}
          </TabsTrigger>
        </TabsList>

        <TabsContent className="classroom-tabs__panel" value="sessions">
          <ClassSessionPanel
            classroom={classroom}
            mediaRoomsEnabled={mediaRoomsEnabled === true}
            schedulingAvailability={schedulingAvailability}
          />
        </TabsContent>

        <TabsContent className="classroom-tabs__panel" value="materials">
          <ClassFilesPanel classroom={classroom} />
        </TabsContent>

        <TabsContent className="classroom-tabs__panel" value="members">
          <ClassRosterPanel classroom={classroom} />
          <ClassEnrollmentPanel
            classroom={classroom}
            createInviteAvailability={tenantOperationAvailability(
              capabilitiesQuery,
              "create_class_invite_link",
            )}
            onRetryCapabilities={() => void capabilitiesQuery.refetch()}
          />
        </TabsContent>

        <TabsContent className="classroom-tabs__panel" value="settings">
          <section
            aria-labelledby="classroom-information-heading"
            className="classroom-detail__section"
          >
            <h2 id="classroom-information-heading">
              {t("classroom.informationTitle")}
            </h2>
            <dl className="classroom-detail__facts">
              <div>
                <dt>{t("classroom.workspaceLabel")}</dt>
                <dd>{activeTenant?.name}</dd>
              </div>
              <div>
                <dt>{t("classroom.ownerLabel")}</dt>
                <dd>{ownerLabel}</dd>
              </div>
              <div>
                <dt>{t("classroom.timezoneLabel")}</dt>
                <dd>{classroom.timezone}</dd>
              </div>
              <div>
                <dt>{t("classroom.createdLabel")}</dt>
                <dd>{dateFormatter.format(new Date(classroom.created_at))}</dd>
              </div>
              <div>
                <dt>{t("classroom.updatedLabel")}</dt>
                <dd>{dateFormatter.format(new Date(classroom.updated_at))}</dd>
              </div>
              {classroom.archived_at && (
                <div>
                  <dt>{t("classroom.archivedLabel")}</dt>
                  <dd>
                    {dateFormatter.format(new Date(classroom.archived_at))}
                  </dd>
                </div>
              )}
            </dl>
          </section>
          <ClassManagementPanel
            activateAvailability={activateAvailability}
            classroom={classroom}
            onReload={async () => (await classQuery.refetch()).data}
            onRetryCapabilities={() => void capabilitiesQuery.refetch()}
            restoreAvailability={tenantOperationAvailability(
              capabilitiesQuery,
              "create_class",
            )}
          />
          {classroom.viewer_access.can_leave && (
            <LeaveClassAction classroom={classroom} />
          )}
        </TabsContent>
      </Tabs>
    </article>
  );
}

function ClassActivateAction({
  classroom,
  label,
  size = "md",
}: {
  classroom: ClassroomClass;
  label: string;
  size?: ButtonSize;
}) {
  const { t } = useI18n();
  const session = useSession();
  const updateClass = useUpdateClass(session.currentUser?.active_tenant?.id);

  return (
    <div className="class-activate-action">
      <Button
        leadingIcon={<Power />}
        loading={updateClass.isPending}
        loadingLabel={t("classroom.activating")}
        onClick={() =>
          updateClass.mutate({
            classID: classroom.id,
            input: { expected_version: classroom.version, status: "active" },
          })
        }
        size={size}
      >
        {label}
      </Button>
      {updateClass.isError && (
        <p className="class-activate-action__error" role="alert">
          {t(activateClassErrorKey(updateClass.error))}
        </p>
      )}
    </div>
  );
}

function LeaveClassAction({ classroom }: { classroom: ClassroomClass }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const session = useSession();
  const leaveClass = useLeaveClass();
  const [open, setOpen] = useState(false);
  const tenantID = session.currentUser?.active_tenant?.id;

  const leave = () => {
    if (!tenantID) {
      return;
    }
    leaveClass.mutate(
      { classID: classroom.id, tenantID },
      {
        onSuccess: () => {
          setOpen(false);
          navigate("/app/classrooms", { replace: true });
        },
      },
    );
  };

  return (
    <section
      aria-labelledby="classroom-leave-title"
      className="classroom-detail__section classroom-leave"
    >
      <div>
        <h2 id="classroom-leave-title">{t("classEnrollment.leaveAction")}</h2>
        <p>{t("classEnrollment.leaveDescription")}</p>
      </div>
      <Button onClick={() => setOpen(true)} variant="danger">
        {t("classEnrollment.leaveAction")}
      </Button>

      <Dialog
        onOpenChange={(nextOpen) => {
          if (!leaveClass.isPending) {
            setOpen(nextOpen);
            if (!nextOpen) {
              leaveClass.reset();
            }
          }
        }}
        open={open}
      >
        <DialogContent closeLabel={t("classEnrollment.closeDialog")}>
          <DialogTitle>{t("classEnrollment.leaveTitle")}</DialogTitle>
          <DialogDescription>
            {t("classEnrollment.leaveDescription")}
          </DialogDescription>
          {leaveClass.isError && (
            <p className="class-enrollments__error" role="alert">
              {t(leaveClassErrorKey(leaveClass.error))}
            </p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button disabled={leaveClass.isPending} variant="secondary">
                {t("classEnrollment.cancelAction")}
              </Button>
            </DialogClose>
            <Button
              loading={leaveClass.isPending}
              loadingLabel={t("classEnrollment.leaving")}
              onClick={leave}
              variant="danger"
            >
              {t("classEnrollment.leaveConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function CreateClassDialog({
  activateAvailable,
  available,
  onOpenChange,
  open,
}: {
  activateAvailable: boolean;
  available: boolean;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const draftCheckboxID = useId();
  const [saveAsDraft, setSaveAsDraft] = useState(false);
  const session = useSession();
  const activeTenantID = session.currentUser?.active_tenant?.id;
  const createClass = useCreateClass(activeTenantID);
  const activeTenant = useTenantDetail(open ? activeTenantID : undefined);
  const [code, setCode] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [timezone, setTimezone] = useState("");
  const [timezoneTouched, setTimezoneTouched] = useState(false);
  const [validationError, setValidationError] = useState<TranslationKey | null>(
    null,
  );

  const displayedTimezone = timezoneTouched
    ? timezone
    : (activeTenant.data?.timezone ??
      session.currentUser?.user.timezone ??
      "UTC");

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!available) {
      return;
    }
    const normalizedCode = code.trim().toUpperCase();
    const normalizedTitle = title.trim();

    if (!classCodePattern.test(normalizedCode)) {
      setValidationError("classroom.codeError");
      return;
    }
    const normalizedTitleLength = Array.from(normalizedTitle).length;
    if (normalizedTitleLength < 1 || normalizedTitleLength > 200) {
      setValidationError("classroom.titleError");
      return;
    }
    if (Array.from(description.trim()).length > 4000) {
      setValidationError("classroom.descriptionError");
      return;
    }
    const normalizedTimezone = displayedTimezone.trim();
    if (
      !normalizedTimezone ||
      normalizedTimezone.length > 100 ||
      !isValidTimeZone(normalizedTimezone)
    ) {
      setValidationError("classroom.timezoneError");
      return;
    }

    setValidationError(null);
    createClass.mutate(
      {
        activate: !saveAsDraft && activateAvailable,
        input: {
          code: normalizedCode,
          title: normalizedTitle,
          description: description.trim(),
          timezone: normalizedTimezone,
        },
      },
      {
        onSuccess: ({ activationError, classroom }) => {
          onOpenChange(false);
          // A failed auto-activation (e.g. active-class quota) keeps the new
          // draft; the detail page then shows the activation reminder.
          void navigate(
            `/app/classrooms/${classroom.id}`,
            activationError
              ? {
                  state: {
                    activationError: activateClassErrorKey(activationError),
                  },
                }
              : undefined,
          );
        },
      },
    );
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="class-create-dialog"
        closeLabel={t("classroom.closeCreate")}
      >
        <DialogTitle>{t("classroom.createTitle")}</DialogTitle>
        <DialogDescription>
          {t("classroom.createDescription")}
        </DialogDescription>

        <form className="class-create-form" onSubmit={submit}>
          <TextField
            autoComplete="off"
            hint={t("classroom.codeHelp")}
            label={t("classroom.codeLabel")}
            maxLength={32}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder={t("classroom.codePlaceholder")}
            required
            value={code}
          />
          <TextField
            label={t("classroom.titleLabel")}
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("classroom.titlePlaceholder")}
            required
            value={title}
          />
          <TextField
            autoComplete="off"
            hint={t("classroom.timezoneHelp")}
            label={t("classroom.timezoneLabel")}
            maxLength={100}
            onChange={(event) => {
              setTimezoneTouched(true);
              setTimezone(event.target.value);
            }}
            required
            value={displayedTimezone}
          />
          <TextAreaField
            className="class-create-form__description"
            hint={`${Array.from(description).length}/4000`}
            label={t("classroom.descriptionLabel")}
            maxLength={4000}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t("classroom.descriptionPlaceholder")}
            rows={4}
            value={description}
          />
          <div className="class-create-form__draft">
            <input
              checked={saveAsDraft}
              id={draftCheckboxID}
              onChange={(event) => setSaveAsDraft(event.target.checked)}
              type="checkbox"
            />
            <label htmlFor={draftCheckboxID}>
              {t("classroom.saveAsDraftLabel")}
            </label>
          </div>

          {(validationError || createClass.isError) && (
            <p className="class-create-form__error" role="alert">
              {validationError
                ? t(validationError)
                : getCreateErrorMessage(createClass.error, t)}
            </p>
          )}

          <DialogFooter className="class-create-form__actions">
            <DialogClose asChild>
              <Button variant="secondary">{t("classroom.cancelAction")}</Button>
            </DialogClose>
            <Button
              disabled={!available}
              loading={createClass.isPending}
              loadingLabel={t("classroom.creating")}
              type="submit"
            >
              {t("classroom.createSubmit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ClassCardGrid({
  activateAvailability,
  classes,
  mediaRoomsEnabled,
  schedulingAvailability,
}: {
  activateAvailability: TenantOperationAvailability;
  classes: readonly ClassroomClass[];
  mediaRoomsEnabled: boolean | undefined;
  schedulingAvailability: TenantOperationAvailability;
}) {
  const { language } = useI18n();
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(language === "vi" ? "vi-VN" : "en-US", {
        dateStyle: "medium",
      }),
    [language],
  );

  return (
    <ul className="class-card-grid">
      {classes.map((classroom) => (
        <li key={classroom.id}>
          <ClassCard
            activateAvailability={activateAvailability}
            classroom={classroom}
            dateFormatter={dateFormatter}
            mediaRoomsEnabled={mediaRoomsEnabled}
            schedulingAvailability={schedulingAvailability}
          />
        </li>
      ))}
    </ul>
  );
}

function ClassCard({
  activateAvailability,
  classroom,
  dateFormatter,
  mediaRoomsEnabled,
  schedulingAvailability,
}: {
  activateAvailability: TenantOperationAvailability;
  classroom: ClassroomClass;
  dateFormatter: Intl.DateTimeFormat;
  mediaRoomsEnabled: boolean | undefined;
  schedulingAvailability: TenantOperationAvailability;
}) {
  const { t } = useI18n();
  const titleID = useId();
  const detailPath = `/app/classrooms/${classroom.id}`;
  const canActivate =
    classroom.status === "draft" &&
    classroom.viewer_access.can_update_class &&
    activateAvailability.available;

  return (
    <article aria-labelledby={titleID} className="class-card">
      <div className="class-card__header">
        <code>{classroom.code}</code>
        <ClassStatus status={classroom.status} />
      </div>
      <div className="class-card__body">
        <h3 className="class-card__title" id={titleID}>
          <Link className="class-card__title-link" to={detailPath}>
            {classroom.title}
          </Link>
        </h3>
        <p className="class-card__description">
          {classroom.description || t("classroom.noDescription")}
        </p>
        <time className="class-card__updated" dateTime={classroom.updated_at}>
          {t("classroom.updatedShort", {
            date: dateFormatter.format(new Date(classroom.updated_at)),
          })}
        </time>
      </div>
      <div className="class-card__actions">
        {classroom.status === "active" && (
          <ClassroomQuickLaunchAction
            classroom={classroom}
            mediaRoomsEnabled={mediaRoomsEnabled}
            schedulingAvailability={schedulingAvailability}
            size="sm"
          />
        )}
        {canActivate && (
          <ClassActivateAction
            classroom={classroom}
            label={t("classroom.activateAction")}
            size="sm"
          />
        )}
        <Link
          aria-describedby={titleID}
          className="class-card__details"
          to={detailPath}
        >
          {t("classroom.viewDetails")}
        </Link>
      </div>
    </article>
  );
}

function ClassStatus({ status }: { status: ClassroomClass["status"] }) {
  const { t } = useI18n();
  const key: TranslationKey =
    status === "active"
      ? "classroom.statusActive"
      : status === "archived"
        ? "classroom.statusArchived"
        : "classroom.statusDraft";

  return (
    <span className="class-status" data-status={status}>
      {t(key)}
    </span>
  );
}

function ClassroomEmptyState({
  canCreate,
  filtered,
  onCreate,
}: {
  canCreate: boolean;
  filtered: boolean;
  onCreate: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="classroom-empty-state">
      <span aria-hidden="true">01</span>
      <h3>
        {filtered
          ? t("classroom.emptyFilteredTitle")
          : t("classroom.emptyTitle")}
      </h3>
      <p>
        {filtered
          ? t("classroom.emptyFilteredDescription")
          : t("classroom.emptyDescription")}
      </p>
      {canCreate && (
        <Button leadingIcon={<Plus />} onClick={onCreate} size="sm">
          {t("classroom.createFirstAction")}
        </Button>
      )}
    </div>
  );
}

function ClassroomQueryError({
  error,
  onRetry,
}: {
  error: Error;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const isForbidden = error instanceof APIRequestError && error.status === 403;
  const isNotFound = error instanceof APIRequestError && error.status === 404;
  return (
    <div className="classroom-error" role="alert">
      <div>
        <strong>
          {isForbidden
            ? t("classroom.forbiddenTitle")
            : isNotFound
              ? t("classroom.notFoundTitle")
              : t("classroom.errorTitle")}
        </strong>
        <p>
          {isForbidden
            ? t("classroom.forbiddenDescription")
            : isNotFound
              ? t("classroom.notFoundDescription")
              : t("classroom.errorDescription")}
        </p>
      </div>
      {!isNotFound && (
        <Button
          leadingIcon={<RotateCw />}
          onClick={onRetry}
          size="sm"
          variant="secondary"
        >
          {t("state.retry")}
        </Button>
      )}
    </div>
  );
}

function ClassListSkeleton() {
  const { t } = useI18n();
  return (
    <SkeletonGroup
      className="class-list-skeleton"
      label={t("classroom.loadingList")}
    >
      {[0, 1, 2].map((item) => (
        <Skeleton key={item} />
      ))}
    </SkeletonGroup>
  );
}

function ClassDetailSkeleton() {
  const { t } = useI18n();
  return (
    <SkeletonGroup
      className="class-detail-skeleton"
      label={t("classroom.loadingDetail")}
    >
      <Skeleton />
      <Skeleton />
      <Skeleton />
    </SkeletonGroup>
  );
}

function getCreateErrorMessage(
  error: Error | null,
  t: (key: TranslationKey) => string,
) {
  if (
    error instanceof APIRequestError &&
    error.problem?.code === "feature_disabled"
  ) {
    return t("capabilities.reasonFeatureDisabled");
  }
  if (error instanceof APIRequestError && error.status === 409) {
    return t("classroom.duplicateCodeError");
  }
  if (error instanceof APIRequestError && error.status === 403) {
    return t("classroom.createForbiddenError");
  }
  return t("classroom.createError");
}

function isValidTimeZone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}
