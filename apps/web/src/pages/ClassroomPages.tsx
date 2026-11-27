import { APIRequestError, type ClassroomClass } from "@tutorhub/api-client";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Select,
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
import {
  ArrowUpRight,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Copy,
  Ellipsis,
  FolderOpen,
  ImagePlus,
  Pin,
  PinOff,
  Plus,
  Power,
  RotateCw,
  Search,
  Settings,
  Share2,
  TvMinimalPlay,
  User,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useId,
  useMemo,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";
import { useStudyMeetingList } from "../app/availabilityPollManagement";
import {
  useClassDetail,
  useClassList,
  useCreateClass,
  useUpdateClass,
  type ClassStatusFilter,
} from "../app/classes";
import { useLeaveClass } from "../app/classEnrollments";
import {
  classCodePattern,
  classCoverThemes,
  deriveClassCode,
  orderClassesWithPins,
  randomCodeSuffix,
  useClassroomPreferences,
  withCodeSuffix,
  type ClassCoverTheme,
} from "../app/classroomPreferences";
import { useClassRoster } from "../app/classRoster";
import { useI18n, type TranslationKey } from "../app/i18n";
import { useSession } from "../app/session";
import {
  tenantOperationAvailability,
  useTenantCapabilities,
  type TenantOperationAvailability,
} from "../app/tenantCapabilities";
import { shouldConcealTenantScopedData } from "../app/tenantDataAccess";
import { useTenantDetail } from "../app/workspaces";
import { ClassConversationAction } from "../components/ClassConversationAction";
import { ClassCoverArt, ClassCoverPicker } from "../components/ClassCoverArt";
import { ClassEnrollmentPanel } from "../components/ClassEnrollmentPanel";
import { ClassFilesPanel } from "../components/ClassFilesPanel";
import { ClassJoinDialog } from "../components/ClassJoinDialog";
import { ClassManagementPanel } from "../components/ClassManagementPanel";
import { ClassroomQuickLaunchAction } from "../components/ClassroomQuickLaunchAction";
import { ClassRosterPanel } from "../components/ClassRosterPanel";
import { ClassSessionPanel } from "../components/ClassSessionPanel";
import { MediaSpaceLaunchAction } from "../components/MediaSpaceLaunchAction";
import { TenantOperationNotice } from "../components/TenantOperationNotice";
import "./ClassroomPages.css";

// Dialogs that are only needed after an explicit action stay out of the
// entry chunk (CLASS-CLASSIN-UI-01 bundle budget).
const ClassQuickInviteDialog = lazy(
  () => import("../components/ClassQuickInviteDialog"),
);
const CreatePublicSessionDialog = lazy(() =>
  import("../components/PublicStudySessionDialogs").then((module) => ({
    default: module.CreatePublicSessionDialog,
  })),
);
const JoinPublicSessionDialog = lazy(() =>
  import("../components/PublicStudySessionDialogs").then((module) => ({
    default: module.JoinPublicSessionDialog,
  })),
);

const publicStripWindowMS = 2 * 60 * 60 * 1000;
const createCoverThemes = classCoverThemes.slice(0, 6);

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

type ClassroomFilter = ClassStatusFilter | "pinned";
const classroomFilters = [
  "all",
  "pinned",
  "active",
  "draft",
  "archived",
] as const satisfies readonly ClassroomFilter[];

function isClassroomFilter(value: string): value is ClassroomFilter {
  return classroomFilters.some((filter) => filter === value);
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

/** Case- and Vietnamese-diacritic-insensitive search key. */
function searchKey(value: string) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[Đđ]/g, "d")
    .toLowerCase();
}

function classRoleKey(role: ClassroomClass["viewer_access"]["class_role"]) {
  switch (role) {
    case "owner":
      return "classRoster.roleOwner" as const;
    case "co_teacher":
      return "classRoster.roleCoTeacher" as const;
    case "teaching_assistant":
      return "classRoster.roleTeachingAssistant" as const;
    case "student":
      return "classRoster.roleStudent" as const;
    default:
      return null;
  }
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    parts.length > 1
      ? `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`
      : (parts[0]?.slice(0, 2) ?? "");
  return letters.toUpperCase() || "?";
}

export function ClassroomListPage() {
  const { t } = useI18n();
  const session = useSession();
  const activeTenant = session.currentUser?.active_tenant;
  const currentUser = session.currentUser?.user;
  const permissions = session.currentUser?.permissions ?? [];
  const canCreate = permissions.includes("class.create");
  const canViewWorkspace = permissions.includes("tenant.view");
  const preferences = useClassroomPreferences(
    activeTenant?.id,
    currentUser?.id,
  );
  const [filter, setFilter] = useState<ClassroomFilter>("all");
  const [search, setSearch] = useState("");
  const statusFilter: ClassStatusFilter = filter === "pinned" ? "all" : filter;
  const classesQuery = useClassList(activeTenant?.id, statusFilter);
  const capabilitiesQuery = useTenantCapabilities(activeTenant?.id);
  const features = capabilitiesQuery.data?.features;
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
  const studyMeetingAvailability = tenantOperationAvailability(
    capabilitiesQuery,
    "schedule_study_meeting",
  );
  const studyMeetingsEnabled = features?.availability_polls?.enabled === true;
  const mediaRoomsEnabled = features?.classroom_media_rooms?.enabled;
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isJoinOpen, setIsJoinOpen] = useState(false);
  const [isPublicCreateOpen, setIsPublicCreateOpen] = useState(false);
  const [isPublicJoinOpen, setIsPublicJoinOpen] = useState(false);
  const [inviteTarget, setInviteTarget] = useState<ClassroomClass | null>(null);
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
  const keyword = searchKey(search.trim());
  const visibleClasses = useMemo(
    () =>
      orderClassesWithPins(classrooms, preferences.preferences).filter(
        (classroom) =>
          (filter !== "pinned" ||
            preferences.preferences.pinned.includes(classroom.id)) &&
          (!keyword ||
            searchKey(
              `${classroom.title} ${classroom.code} ${classroom.description}`,
            ).includes(keyword)),
      ),
    [classrooms, filter, keyword, preferences.preferences],
  );
  const classesConcealed = shouldConcealTenantScopedData(classesQuery.error);
  const timezone =
    currentUser?.timezone ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "UTC";

  return (
    <div className="page-content classroom-page">
      <header className="classroom-toolbar">
        <h1 className="visually-hidden">{t("classroom.title")}</h1>
        {!classesConcealed && (
          <>
            <div className="classroom-toolbar__start">
              <Select
                ariaLabel={t("classroom.statusFilterLabel")}
                className="classroom-filter"
                onValueChange={(value) => {
                  if (isClassroomFilter(value)) {
                    setFilter(value);
                  }
                }}
                options={[
                  { label: t("classroom.filterAll"), value: "all" },
                  { label: t("classroom.filterPinned"), value: "pinned" },
                  { label: t("classroom.statusActive"), value: "active" },
                  { label: t("classroom.statusDraft"), value: "draft" },
                  { label: t("classroom.statusArchived"), value: "archived" },
                ]}
                value={filter}
              />
              <div className="classroom-search" role="search">
                <Search aria-hidden="true" />
                <input
                  aria-label={t("classroom.searchLabel")}
                  autoComplete="off"
                  maxLength={200}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t("classroom.searchPlaceholder")}
                  type="search"
                  value={search}
                />
                {search && (
                  <button
                    aria-label={t("classroom.searchClear")}
                    className="classroom-search__clear"
                    onClick={() => setSearch("")}
                    type="button"
                  >
                    <X aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
            <div className="classroom-toolbar__end">
              {activeTenant && (
                <ClassJoinDialog
                  availability={joinAvailability}
                  onJoined={(classroom, tenantID) => {
                    setFilter("all");
                    setJoinedClass({ classroom, tenantID });
                  }}
                  onOpenChange={setIsJoinOpen}
                  open={isJoinOpen}
                  tenantID={activeTenant.id}
                />
              )}
              <Menu modal={false}>
                <MenuTrigger asChild>
                  <button
                    aria-label={t("classroom.quickActions")}
                    className="classin-round-button"
                    type="button"
                  >
                    <Plus aria-hidden="true" />
                  </button>
                </MenuTrigger>
                <MenuContent align="end" className="classin-menu">
                  <MenuItem
                    disabled={!activeTenant || !joinAvailability.available}
                    onSelect={() => setIsJoinOpen(true)}
                  >
                    <Users aria-hidden="true" />
                    {t("classroom.quickJoinClass")}
                  </MenuItem>
                  <MenuItem
                    disabled={!studyMeetingsEnabled}
                    onSelect={() => setIsPublicJoinOpen(true)}
                  >
                    <TvMinimalPlay aria-hidden="true" />
                    <span className="classin-menu__text">
                      {t("classroom.quickJoinPublic")}
                      {!studyMeetingsEnabled && (
                        <small>{t("classroom.quickUnavailable")}</small>
                      )}
                    </span>
                  </MenuItem>
                  <MenuItem
                    disabled={!studyMeetingAvailability.available}
                    onSelect={() => setIsPublicCreateOpen(true)}
                  >
                    <Plus aria-hidden="true" />
                    <span className="classin-menu__text">
                      {t("classroom.quickCreatePublic")}
                      {!studyMeetingAvailability.available && (
                        <small>{t("classroom.quickUnavailable")}</small>
                      )}
                    </span>
                  </MenuItem>
                  {canViewWorkspace && (
                    <MenuItem asChild>
                      <Link to="/app/workspace">
                        <Share2 aria-hidden="true" />
                        {t("classroom.quickWorkspaceMembers")}
                      </Link>
                    </MenuItem>
                  )}
                </MenuContent>
              </Menu>
              {canCreate && (
                <Button
                  aria-expanded={isCreateOpen}
                  aria-haspopup="dialog"
                  className="classroom-primary-action classin-cta"
                  disabled={!createAvailability.available}
                  leadingIcon={<Plus />}
                  onClick={() => setIsCreateOpen(true)}
                >
                  {t("classroom.createAction")}
                </Button>
              )}
            </div>
          </>
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
          onCoverChosen={preferences.setCover}
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

      {/* Loaded only after the class list, so it never delays the grid. */}
      {!classesConcealed &&
        classesQuery.isSuccess &&
        studyMeetingsEnabled &&
        activeTenant &&
        currentUser && (
          <PublicSessionStrip
            currentUserID={currentUser.id}
            mediaRoomsEnabled={mediaRoomsEnabled === true}
            onViewAll={() => setIsPublicJoinOpen(true)}
            tenantID={activeTenant.id}
            timezone={timezone}
          />
        )}

      <section aria-labelledby="class-list-heading" className="classroom-index">
        <h2 className="visually-hidden" id="class-list-heading">
          {t("classroom.listTitle")}
        </h2>

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
            description={
              filter !== "all"
                ? t("classroom.emptyFilteredDescription")
                : t("classroom.emptyDescription")
            }
            onCreate={() => setIsCreateOpen(true)}
            title={
              filter !== "all"
                ? t("classroom.emptyFilteredTitle")
                : t("classroom.emptyTitle")
            }
          />
        )}
        {!classesConcealed &&
          classesQuery.data &&
          classrooms.length > 0 &&
          visibleClasses.length === 0 && (
            <ClassroomEmptyState
              canCreate={false}
              description={
                keyword
                  ? t("classroom.searchEmptyDescription")
                  : t("classroom.pinnedEmptyDescription")
              }
              onCreate={() => setIsCreateOpen(true)}
              title={
                keyword
                  ? t("classroom.searchEmptyTitle")
                  : t("classroom.pinnedEmptyTitle")
              }
            />
          )}
        {!classesConcealed && classesQuery.data && classrooms.length > 0 && (
          <>
            {visibleClasses.length > 0 && (
              <ul className="class-card-grid">
                {visibleClasses.map((classroom) => (
                  <li key={classroom.id}>
                    <ClassCard
                      activateAvailability={activateAvailability}
                      classroom={classroom}
                      cover={preferences.coverFor(classroom.id)}
                      mediaRoomsEnabled={mediaRoomsEnabled}
                      onInvite={setInviteTarget}
                      onTogglePin={preferences.togglePin}
                      pinned={preferences.isPinned(classroom.id)}
                      schedulingAvailability={schedulingAvailability}
                      workspaceName={activeTenant?.name ?? ""}
                    />
                  </li>
                ))}
              </ul>
            )}
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
                  className="classin-secondary-pill"
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

      {activeTenant && inviteTarget && (
        <Suspense fallback={null}>
          <ClassQuickInviteDialog
            classroom={inviteTarget}
            createInviteAvailability={tenantOperationAvailability(
              capabilitiesQuery,
              "create_class_invite_link",
            )}
            onOpenChange={(open) => {
              if (!open) {
                setInviteTarget(null);
              }
            }}
            onRetryCapabilities={() => void capabilitiesQuery.refetch()}
            open
            tenantID={activeTenant.id}
          />
        </Suspense>
      )}
      {activeTenant && currentUser && isPublicCreateOpen && (
        <Suspense fallback={null}>
          <CreatePublicSessionDialog
            availability={studyMeetingAvailability}
            features={features}
            onOpenChange={setIsPublicCreateOpen}
            onRetryCapabilities={() => void capabilitiesQuery.refetch()}
            open
            organizerName={currentUser.display_name}
            tenantID={activeTenant.id}
            timezone={timezone}
          />
        </Suspense>
      )}
      {activeTenant && currentUser && isPublicJoinOpen && (
        <Suspense fallback={null}>
          <JoinPublicSessionDialog
            currentUserID={currentUser.id}
            mediaRoomsEnabled={mediaRoomsEnabled === true}
            onOpenChange={setIsPublicJoinOpen}
            open
            tenantID={activeTenant.id}
            timezone={timezone}
          />
        </Suspense>
      )}
    </div>
  );
}

/**
 * A slim reminder for the viewer's public sessions that are live or start
 * within two hours. Loading and errors stay silent: the class list never
 * depends on the study-meeting endpoint.
 */
function PublicSessionStrip({
  currentUserID,
  mediaRoomsEnabled,
  onViewAll,
  tenantID,
  timezone,
}: {
  currentUserID: string;
  mediaRoomsEnabled: boolean;
  onViewAll: () => void;
  tenantID: string;
  timezone: string;
}) {
  const { language, t } = useI18n();
  const meetingsQuery = useStudyMeetingList(tenantID);
  const [nowMS] = useState(() => Date.now());
  const soon = (meetingsQuery.data?.meetings ?? [])
    .filter(
      (meeting) =>
        meeting.status === "scheduled" &&
        Date.parse(meeting.ends_at) > nowMS &&
        Date.parse(meeting.starts_at) <= nowMS + publicStripWindowMS,
    )
    .sort(
      (left, right) => Date.parse(left.starts_at) - Date.parse(right.starts_at),
    );
  const first = soon[0];
  if (!first) {
    return null;
  }
  const live = Date.parse(first.starts_at) <= nowMS;
  const time = new Intl.DateTimeFormat(language === "vi" ? "vi-VN" : "en-US", {
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(first.starts_at));

  return (
    <section
      aria-label={t("publicSession.bannerLabel")}
      className="public-session-strip"
      data-live={live ? "true" : "false"}
    >
      <span aria-hidden="true" className="public-session-strip__dot" />
      <p>
        <strong>
          {live
            ? t("publicSession.bannerLive", { title: first.title })
            : t("publicSession.bannerSoon", { title: first.title })}
        </strong>
        <time dateTime={first.starts_at}>{time}</time>
        {soon.length > 1 && (
          <span>
            {t("publicSession.bannerMore", { count: soon.length - 1 })}
          </span>
        )}
      </p>
      <div className="public-session-strip__actions">
        {mediaRoomsEnabled && (
          <MediaSpaceLaunchAction
            canStart={first.owner_user_id === currentUserID}
            source={{ kind: "study_meeting", study_meeting_id: first.id }}
            tenantID={tenantID}
          />
        )}
        <Button onClick={onViewAll} size="sm" variant="quiet">
          {t("publicSession.bannerViewAll")}
        </Button>
      </div>
    </section>
  );
}

export function ClassroomDetailPage() {
  const { classId } = useParams();
  const { language, t } = useI18n();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const session = useSession();
  const activeTenant = session.currentUser?.active_tenant;
  const preferences = useClassroomPreferences(
    activeTenant?.id,
    session.currentUser?.user.id,
  );
  const classQuery = useClassDetail(activeTenant?.id, classId);
  const capabilitiesQuery = useTenantCapabilities(activeTenant?.id);
  const [isCoverOpen, setIsCoverOpen] = useState(false);
  const [isInviteOpen, setIsInviteOpen] = useState(false);
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

  /** The tab list is drawn vertically: Up/Down move like Left/Right. */
  const moveTabFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
      return;
    }
    const tabs = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        '[role="tab"]:not([disabled])',
      ),
    );
    const index = tabs.findIndex((tab) => tab === document.activeElement);
    if (index < 0) {
      return;
    }
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    tabs[(index + step + tabs.length) % tabs.length]?.focus();
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
  const cover = preferences.coverFor(classroom.id);
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
  const createInviteAvailability = tenantOperationAvailability(
    capabilitiesQuery,
    "create_class_invite_link",
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
  const canInvite =
    classroom.status === "active" &&
    classroom.viewer_access.can_manage_enrollments;

  return (
    <article className="page-content classroom-page classroom-detail">
      <div className="classroom-detail__topbar">
        <Link className="classroom-back-link" to="/app/classrooms">
          {t("classroom.backToList")}
        </Link>
      </div>

      <Tabs
        className="classroom-tabs classroom-detail__layout"
        onValueChange={changeTab}
        value={activeTab}
      >
        <nav className="classroom-detail__nav">
          <div className="classroom-detail__identity">
            <ClassCoverArt
              className="classroom-detail__identity-cover"
              theme={cover}
            />
            <div>
              <p className="classroom-detail__identity-title">
                {classroom.title}
              </p>
              <code>{classroom.code}</code>
              <ClassStatus status={classroom.status} />
            </div>
          </div>
          <TabsList
            aria-label={t("classroom.tabsLabel")}
            className="classroom-tabs__list"
            onKeyDown={moveTabFocus}
          >
            <TabsTrigger className="classroom-tabs__trigger" value="sessions">
              <CalendarClock aria-hidden="true" />
              {t("classroom.tab.sessions")}
            </TabsTrigger>
            <TabsTrigger className="classroom-tabs__trigger" value="materials">
              <FolderOpen aria-hidden="true" />
              {t("classroom.tab.materials")}
            </TabsTrigger>
            <TabsTrigger className="classroom-tabs__trigger" value="members">
              <Users aria-hidden="true" />
              {t("classroom.tab.members")}
            </TabsTrigger>
            <TabsTrigger className="classroom-tabs__trigger" value="settings">
              <Settings aria-hidden="true" />
              {t("classroom.tab.settings")}
            </TabsTrigger>
          </TabsList>
        </nav>

        <div className="classroom-detail__stage">
          <header className="classroom-detail__header">
            <div className="classroom-detail__banner">
              <ClassCoverArt theme={cover} />
              <button
                className="classroom-detail__cover-button"
                onClick={() => setIsCoverOpen(true)}
                type="button"
              >
                <ImagePlus aria-hidden="true" />
                {t("classroom.coverChange")}
              </button>
            </div>
            <div className="classroom-detail__heading-row">
              <div className="classroom-detail__heading">
                <h1>{classroom.title}</h1>
                {classroom.description && <p>{classroom.description}</p>}
              </div>
              <div className="classroom-detail__actions">
                <ClassroomQuickLaunchAction
                  classroom={classroom}
                  mediaRoomsEnabled={mediaRoomsEnabled}
                  schedulingAvailability={schedulingAvailability}
                />
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
          {classroom.status === "archived" && (
            <section
              aria-labelledby="classroom-archived-banner-title"
              className="classroom-draft-banner"
              data-tone="archived"
            >
              <div>
                <h2 id="classroom-archived-banner-title">
                  {t("classroom.archivedBannerTitle")}
                </h2>
                <p>{t("classroom.archivedBannerDescription")}</p>
              </div>
            </section>
          )}

          <TabsContent className="classroom-tabs__panel" value="sessions">
            <ClassSessionPanel
              classroom={classroom}
              mediaRoomsEnabled={mediaRoomsEnabled === true}
              onOpenMaterials={() => changeTab("materials")}
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
              createInviteAvailability={createInviteAvailability}
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
                  <dd>
                    {dateFormatter.format(new Date(classroom.created_at))}
                  </dd>
                </div>
                <div>
                  <dt>{t("classroom.updatedLabel")}</dt>
                  <dd>
                    {dateFormatter.format(new Date(classroom.updated_at))}
                  </dd>
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
        </div>

        <aside
          aria-label={t("classroom.railLabel")}
          className="classroom-detail__rail"
        >
          <ClassMembersRail
            canInvite={canInvite}
            classroom={classroom}
            onInvite={() => setIsInviteOpen(true)}
            onOpenMembers={() => changeTab("members")}
            ownerLabel={ownerLabel}
          />
          <ClassInfoRail classroom={classroom} ownerLabel={ownerLabel} />
          <div className="classroom-rail-card classroom-rail-chat">
            <ClassConversationAction classID={classroom.id} />
          </div>
        </aside>
      </Tabs>

      <ClassCoverDialog
        classID={classroom.id}
        customized={classroom.id in preferences.preferences.covers}
        onChange={(theme) => preferences.setCover(classroom.id, theme)}
        onOpenChange={setIsCoverOpen}
        open={isCoverOpen}
        value={cover}
      />
      {activeTenant && isInviteOpen && canInvite && (
        <Suspense fallback={null}>
          <ClassQuickInviteDialog
            classroom={classroom}
            createInviteAvailability={createInviteAvailability}
            onOpenChange={setIsInviteOpen}
            onRetryCapabilities={() => void capabilitiesQuery.refetch()}
            open
            tenantID={activeTenant.id}
          />
        </Suspense>
      )}
    </article>
  );
}

function ClassMembersRail({
  canInvite,
  classroom,
  onInvite,
  onOpenMembers,
  ownerLabel,
}: {
  canInvite: boolean;
  classroom: ClassroomClass;
  onInvite: () => void;
  onOpenMembers: () => void;
  ownerLabel: string;
}) {
  const { t } = useI18n();
  const headingID = useId();
  const tenantID = useSession().currentUser?.active_tenant?.id;
  const canManage = classroom.viewer_access.can_manage_enrollments;
  // Shares the roster query of the Members tab (same key); learners never
  // request the management roster, so they never hit a 403 here.
  const roster = useClassRoster(tenantID, classroom.id, "", "all", canManage);
  const people = useMemo(() => {
    const firstPage = roster.data?.pages[0];
    const list = [
      ...(firstPage?.class_owner ? [firstPage.class_owner.user] : []),
      ...(roster.data?.pages ?? []).flatMap((page) =>
        page.items.map((member) => member.user),
      ),
    ];
    return [...new Map(list.map((user) => [user.id, user])).values()];
  }, [roster.data?.pages]);
  const hasMore = roster.hasNextPage;
  const roleKey = classRoleKey(classroom.viewer_access.class_role);

  return (
    <section aria-labelledby={headingID} className="classroom-rail-card">
      <div className="classroom-rail-card__head">
        <h2 id={headingID}>{t("classroom.tab.members")}</h2>
        {canManage && roster.isSuccess && (
          <span className="classroom-rail-card__meta">
            {t(
              hasMore
                ? "classroom.railMembersCountMore"
                : "classroom.railMembersCount",
              { count: people.length },
            )}
          </span>
        )}
        <IconButton
          className="classin-icon-button"
          label={t("classroom.railMembersOpen")}
          onClick={onOpenMembers}
          size="sm"
        >
          <ChevronRight />
        </IconButton>
      </div>
      {canManage ? (
        <div className="classroom-rail-members">
          {roster.isPending && (
            <SkeletonGroup
              className="classroom-rail-members__loading"
              label={t("classRoster.loading")}
            >
              <Skeleton height={32} />
            </SkeletonGroup>
          )}
          {roster.isError && (
            <p className="classroom-rail-card__note">
              {t("classroom.railMembersError")}
            </p>
          )}
          {roster.isSuccess && people.length === 0 && (
            <p className="classroom-rail-card__note">
              {t("classroom.railMembersEmpty")}
            </p>
          )}
          {people.length > 0 && (
            <ul className="classroom-rail-members__avatars">
              {people.slice(0, 7).map((person) => (
                <li key={person.id} title={person.display_name}>
                  <span aria-hidden="true" className="classin-avatar">
                    {initials(person.display_name)}
                  </span>
                  <span className="visually-hidden">{person.display_name}</span>
                </li>
              ))}
            </ul>
          )}
          {canInvite && (
            <IconButton
              className="classin-icon-button classroom-rail-members__invite"
              label={t("classroom.railInvite")}
              onClick={onInvite}
              size="sm"
            >
              <UserPlus />
            </IconButton>
          )}
        </div>
      ) : (
        <p className="classroom-rail-card__note">
          {roleKey ? t("classroom.yourRole", { role: t(roleKey) }) : ownerLabel}
        </p>
      )}
    </section>
  );
}

function ClassInfoRail({
  classroom,
  ownerLabel,
}: {
  classroom: ClassroomClass;
  ownerLabel: string;
}) {
  const { t } = useI18n();
  const headingID = useId();
  const [copyStatus, setCopyStatus] = useState<"copied" | "manual" | null>(
    null,
  );

  const copyCode = async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(classroom.code);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("manual");
    }
  };

  return (
    <section aria-labelledby={headingID} className="classroom-rail-card">
      <div className="classroom-rail-card__head">
        <h2 id={headingID}>{t("classroom.railInfo")}</h2>
      </div>
      <dl className="classroom-rail-facts">
        <div>
          <dt>{t("classroom.railCode")}</dt>
          <dd>
            <code>{classroom.code}</code>
            <IconButton
              className="classin-icon-button"
              label={t("classroom.copyCode")}
              onClick={() => void copyCode()}
              size="sm"
            >
              <Copy />
            </IconButton>
          </dd>
        </div>
        <div>
          <dt>{t("classroom.timezoneLabel")}</dt>
          <dd>{classroom.timezone}</dd>
        </div>
        <div>
          <dt>{t("classroom.railStatus")}</dt>
          <dd>
            <ClassStatus status={classroom.status} />
          </dd>
        </div>
        <div>
          <dt>{t("classroom.ownerLabel")}</dt>
          <dd>{ownerLabel}</dd>
        </div>
      </dl>
      {copyStatus && (
        <p className="classroom-rail-card__note" role="status">
          {t(
            copyStatus === "copied"
              ? "classroom.codeCopied"
              : "classroom.codeCopyManual",
          )}
        </p>
      )}
    </section>
  );
}

function ClassCoverDialog({
  classID,
  customized,
  onChange,
  onOpenChange,
  open,
  value,
}: {
  classID: string;
  customized: boolean;
  onChange: (theme: ClassCoverTheme | null) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  value: ClassCoverTheme;
}) {
  const { t } = useI18n();
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="classin-dialog classin-cover-dialog"
        closeLabel={t("classroom.coverClose")}
      >
        <DialogTitle>{t("classroom.coverDialogTitle")}</DialogTitle>
        <DialogDescription>
          {t("classroom.coverDialogDescription")}
        </DialogDescription>
        <ClassCoverPicker
          legend={t("classroom.coverLabel")}
          name={`class-cover-${classID}`}
          onChange={onChange}
          value={value}
        />
        <DialogFooter className="classin-dialog__footer">
          <Button
            disabled={!customized}
            onClick={() => onChange(null)}
            variant="secondary"
          >
            {t("classroom.coverReset")}
          </Button>
          <DialogClose asChild>
            <Button className="classin-cta">{t("classroom.coverDone")}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

/**
 * ClassIn ref-07: one step by default (class name + optional cover). The class
 * code is derived from the name until the user edits it under "Advanced
 * options"; a duplicate derived code is retried once with a short suffix.
 */
function CreateClassDialog({
  activateAvailable,
  available,
  onCoverChosen,
  onOpenChange,
  open,
}: {
  activateAvailable: boolean;
  available: boolean;
  onCoverChosen: (classID: string, theme: ClassCoverTheme) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const formID = useId();
  const advancedID = useId();
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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [cover, setCover] = useState<ClassCoverTheme | null>(null);
  const [fallbackSuffix] = useState(() => randomCodeSuffix());
  const [retrying, setRetrying] = useState(false);
  const [validationError, setValidationError] = useState<TranslationKey | null>(
    null,
  );

  const codeIsAuto = code.trim() === "";
  const normalizedTitle = title.trim();
  const autoCode = normalizedTitle
    ? deriveClassCode(normalizedTitle, fallbackSuffix)
    : "";
  const displayedTimezone = timezoneTouched
    ? timezone
    : (activeTenant.data?.timezone ??
      session.currentUser?.user.timezone ??
      "UTC");
  const pending = createClass.isPending || retrying;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!available || pending) {
      return;
    }
    const normalizedTitleLength = Array.from(normalizedTitle).length;
    if (normalizedTitleLength < 1 || normalizedTitleLength > 200) {
      setValidationError("classroom.titleError");
      return;
    }
    const normalizedCode = codeIsAuto ? autoCode : code.trim().toUpperCase();
    if (!classCodePattern.test(normalizedCode)) {
      setAdvancedOpen(true);
      setValidationError("classroom.codeError");
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
      setAdvancedOpen(true);
      setValidationError("classroom.timezoneError");
      return;
    }

    setValidationError(null);
    const input = {
      code: normalizedCode,
      title: normalizedTitle,
      description: description.trim(),
      timezone: normalizedTimezone,
    };
    const activate = !saveAsDraft && activateAvailable;
    let result: Awaited<ReturnType<typeof createClass.mutateAsync>>;
    try {
      result = await createClass.mutateAsync({ activate, input });
    } catch (error) {
      const duplicateAutoCode =
        codeIsAuto &&
        error instanceof APIRequestError &&
        error.status === 409 &&
        error.problem?.code !== "feature_disabled";
      if (!duplicateAutoCode) {
        return;
      }
      setRetrying(true);
      try {
        result = await createClass.mutateAsync({
          activate,
          input: { ...input, code: withCodeSuffix(normalizedCode) },
        });
      } catch {
        return;
      } finally {
        setRetrying(false);
      }
    }
    const { activationError, classroom } = result;
    if (cover) {
      onCoverChosen(classroom.id, cover);
    }
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
  };

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!pending) {
          onOpenChange(nextOpen);
        }
      }}
      open={open}
    >
      <DialogContent
        className="classin-dialog class-create-dialog"
        closeLabel={t("classroom.closeCreate")}
      >
        <DialogTitle>{t("classroom.createTitle")}</DialogTitle>
        <DialogDescription className="visually-hidden">
          {t("classroom.createDescription")}
        </DialogDescription>

        <form
          className="classin-create-form"
          id={formID}
          onSubmit={(event) => void submit(event)}
        >
          <TextField
            className="classin-create-form__title"
            hint={
              codeIsAuto && autoCode
                ? t("classroom.codeAutoHint", { code: autoCode })
                : undefined
            }
            label={t("classroom.titleLabel")}
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("classroom.titlePlaceholder")}
            required
            value={title}
          />
          <ClassCoverPicker
            legend={t("classroom.coverLabel")}
            name={`${formID}-cover`}
            onChange={setCover}
            themes={createCoverThemes}
            value={cover}
          />

          <button
            aria-controls={advancedID}
            aria-expanded={advancedOpen}
            className="classin-disclosure"
            onClick={() => setAdvancedOpen((current) => !current)}
            type="button"
          >
            <ChevronDown aria-hidden="true" />
            {t("classroom.advancedOptions")}
          </button>
          <div
            className="classin-create-form__advanced"
            hidden={!advancedOpen}
            id={advancedID}
          >
            <TextField
              autoComplete="off"
              hint={t("classroom.codeHelp")}
              label={t("classroom.codeLabel")}
              maxLength={32}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              placeholder={autoCode || t("classroom.codePlaceholder")}
              value={code}
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
              className="classin-create-form__description"
              hint={`${Array.from(description).length}/4000`}
              label={t("classroom.descriptionLabel")}
              maxLength={4000}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t("classroom.descriptionPlaceholder")}
              rows={3}
              value={description}
            />
            <label className="classin-checkbox">
              <input
                checked={saveAsDraft}
                onChange={(event) => setSaveAsDraft(event.target.checked)}
                type="checkbox"
              />
              <span>{t("classroom.saveAsDraftLabel")}</span>
            </label>
          </div>

          {(validationError || createClass.isError) && (
            <p className="classin-form-error" role="alert">
              {validationError
                ? t(validationError)
                : getCreateErrorMessage(createClass.error, t)}
            </p>
          )}

          <div className="classin-dialog__footer">
            <Button
              className="classin-cta"
              data-ready={normalizedTitle ? "true" : "false"}
              disabled={!available}
              loading={pending}
              loadingLabel={t("classroom.creating")}
              type="submit"
            >
              {t("classroom.createSubmit")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ClassCard({
  activateAvailability,
  classroom,
  cover,
  mediaRoomsEnabled,
  onInvite,
  onTogglePin,
  pinned,
  schedulingAvailability,
  workspaceName,
}: {
  activateAvailability: TenantOperationAvailability;
  classroom: ClassroomClass;
  cover: ClassCoverTheme;
  mediaRoomsEnabled: boolean | undefined;
  onInvite: (classroom: ClassroomClass) => void;
  onTogglePin: (classID: string) => void;
  pinned: boolean;
  schedulingAvailability: TenantOperationAvailability;
  workspaceName: string;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const titleID = useId();
  const detailPath = `/app/classrooms/${classroom.id}`;
  const access = classroom.viewer_access;
  const canActivate =
    classroom.status === "draft" &&
    access.can_update_class &&
    activateAvailability.available;
  const canInvite =
    classroom.status === "active" && access.can_manage_enrollments;
  const roleKey = classRoleKey(access.class_role);

  return (
    <article
      aria-labelledby={titleID}
      className="class-card"
      data-pinned={pinned ? "true" : undefined}
    >
      <div className="class-card__media">
        <ClassCoverArt className="class-card__cover" theme={cover} />
        {(pinned || classroom.status !== "active") && (
          <div className="class-card__flags">
            {pinned && (
              <span className="class-card__flag">
                <Pin aria-hidden="true" />
                {t("classroom.pinnedBadge")}
              </span>
            )}
            {classroom.status !== "active" && (
              <ClassStatus status={classroom.status} />
            )}
          </div>
        )}
        <span aria-hidden="true" className="class-card__avatar">
          <ClassCoverArt theme={cover} />
          <span className="class-card__role-dot">
            <User />
          </span>
        </span>
      </div>
      <div className="class-card__body">
        <h3 className="class-card__title" id={titleID}>
          <Link className="class-card__title-link" to={detailPath}>
            {classroom.title}
          </Link>
        </h3>
        <p className="class-card__subtitle">
          <code>{classroom.code}</code>
          <span>{classroom.description || workspaceName}</span>
        </p>
        {roleKey && (
          <span className="visually-hidden">
            {t("classroom.yourRole", { role: t(roleKey) })}
          </span>
        )}
      </div>
      <div className="class-card__actions">
        <div className="class-card__primary">
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
        </div>
        <Link
          aria-describedby={titleID}
          className="class-card__details"
          to={detailPath}
        >
          {t("classroom.viewDetails")}
        </Link>
        <Menu modal={false}>
          <MenuTrigger asChild>
            <button
              aria-label={t("classroom.cardOptions", {
                title: classroom.title,
              })}
              className="class-card__more"
              type="button"
            >
              <Ellipsis aria-hidden="true" />
            </button>
          </MenuTrigger>
          <MenuContent align="end" className="classin-menu">
            <MenuItem onSelect={() => onTogglePin(classroom.id)}>
              {pinned ? (
                <PinOff aria-hidden="true" />
              ) : (
                <Pin aria-hidden="true" />
              )}
              {pinned ? t("classroom.unpin") : t("classroom.pin")}
            </MenuItem>
            {canInvite && (
              <MenuItem onSelect={() => onInvite(classroom)}>
                <UserPlus aria-hidden="true" />
                {t("classroom.inviteMembers")}
              </MenuItem>
            )}
            <MenuItem onSelect={() => void navigate(detailPath)}>
              <ArrowUpRight aria-hidden="true" />
              {t("classroom.viewDetails")}
            </MenuItem>
            {(access.can_update_class || access.can_archive_class) && (
              <MenuItem
                onSelect={() => void navigate(`${detailPath}?tab=settings`)}
              >
                <Settings aria-hidden="true" />
                {t("classroom.openSettings")}
              </MenuItem>
            )}
          </MenuContent>
        </Menu>
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

function EmptyIllustration() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 160 112">
      <rect fill="#f3f5f8" height="76" rx="14" width="112" x="24" y="18" />
      <rect
        fill="#fff"
        height="40"
        rx="9"
        stroke="#e3e8ef"
        width="84"
        x="38"
        y="30"
      />
      <rect fill="#dbe7f5" height="6" rx="3" width="44" x="48" y="42" />
      <rect fill="#e9edf2" height="6" rx="3" width="58" x="48" y="54" />
      <circle cx="122" cy="84" fill="#dcfce7" r="16" />
      <path
        d="M115 84h14M122 77v14"
        stroke="#15803d"
        strokeLinecap="round"
        strokeWidth="3"
      />
    </svg>
  );
}

function ClassroomEmptyState({
  canCreate,
  description,
  onCreate,
  title,
}: {
  canCreate: boolean;
  description: string;
  onCreate: () => void;
  title: string;
}) {
  const { t } = useI18n();
  return (
    <div className="classroom-empty-state">
      <EmptyIllustration />
      <h3>{title}</h3>
      <p>{description}</p>
      {canCreate && (
        <Button
          className="classin-cta"
          leadingIcon={<Plus />}
          onClick={onCreate}
          size="sm"
        >
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
      {[0, 1, 2, 3].map((item) => (
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
