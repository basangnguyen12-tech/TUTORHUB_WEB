import { APIRequestError } from "@tutorhub/api-client";
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
  Skeleton,
  SkeletonGroup,
} from "@tutorhub/ui";
import { ChevronUp, MoreVertical, UserRoundX } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  mediaLobbyIdempotencyKey,
  useMediaAdmissions,
  useResolveMediaAdmission,
  type MediaAdmissionItem,
  type MediaAdmissionPage,
} from "../app/mediaLobby";
import { useI18n } from "../app/i18n";
import { shouldConcealTenantScopedData } from "../app/tenantDataAccess";
import { chatAvatarTone } from "../features/media/classroomChatMedia";

interface MediaLobbyPanelProps {
  enabled: boolean;
  roomInstanceID: string;
  roomInstanceVersion: number;
  spaceID: string;
  spaceVersion: number;
  tenantID: string;
}

/**
 * Number of people currently waiting for admission. The classroom shell reads
 * it to badge the roster control while the roster drawer (and the full lobby
 * panel inside it) is closed and therefore unmounted.
 */
// eslint-disable-next-line react-refresh/only-export-components -- Shared waiting-count contract; ClassroomLiveKitRoom forwards a fixed prop set, so the shell reads this context instead of a new prop.
export const MediaLobbyWaitingCountContext = createContext(0);

/**
 * ROOM-PEOPLE-03: the People panel's search box filters this waiting group
 * too. The room page builds the `lobby` node itself, so the panel hands the
 * accent-insensitive matcher down through context (same pattern as the
 * waiting count) and hears back how many waiting rows still match.
 */
export interface MediaLobbyFilter {
  readonly active: boolean;
  readonly matches: (displayName: string) => boolean;
  readonly onMatchCountChange?: (count: number) => void;
}

// eslint-disable-next-line react-refresh/only-export-components -- Shared filter contract between the classroom People panel and the page-owned lobby node.
export const MediaLobbyFilterContext = createContext<MediaLobbyFilter | null>(
  null,
);

/**
 * Observes the same admissions query as {@link MediaLobbyPanel} (identical
 * query key, so the cache and polling are shared) and publishes only the
 * waiting count. Fails closed to `0` while disabled, loading or erroring.
 */
export function MediaLobbyWaitingCountProvider({
  children,
  enabled,
  roomInstanceID,
  roomInstanceVersion,
  spaceID,
  spaceVersion,
  tenantID,
}: MediaLobbyPanelProps & { children: ReactNode }) {
  const admissions = useMediaAdmissions(
    tenantID,
    spaceID,
    roomInstanceID,
    spaceVersion,
    roomInstanceVersion,
    enabled,
  );
  const count =
    enabled && !admissions.isError
      ? waitingAdmissions(admissions.data).length
      : 0;
  return (
    <MediaLobbyWaitingCountContext value={count}>
      {children}
    </MediaLobbyWaitingCountContext>
  );
}

function waitingAdmissions(
  page: MediaAdmissionPage | undefined,
): MediaAdmissionItem[] {
  return (page?.items ?? []).filter((item) => item.status === "waiting");
}

/**
 * ROOM-PEOPLE-03 — the People panel's "Waiting to join" group (Google Meet
 * pattern): hidden entirely while nobody waits, one slim row per request with
 * an inline Admit and a ⋮ menu holding Deny (still confirmed). Admissions keep
 * their exact CAS, idempotency and fail-closed handling; the server polls, so
 * there is no manual refresh. A polite live region (always mounted) announces
 * new requests while the panel is open.
 */
export function MediaLobbyPanel({
  enabled,
  roomInstanceID,
  roomInstanceVersion,
  spaceID,
  spaceVersion,
  tenantID,
}: MediaLobbyPanelProps) {
  const { t } = useI18n();
  const filter = useContext(MediaLobbyFilterContext);
  const sectionLabelID = useId();
  const listID = useId();
  const groupToggle = useRef<HTMLButtonElement>(null);
  const feedbackLine = useRef<HTMLParagraphElement>(null);
  const idempotencyKeys = useRef(new Map<string, string>());
  const [denyTarget, setDenyTarget] = useState<MediaAdmissionItem | null>(null);
  const [feedback, setFeedback] = useState<{
    action: "admit" | "deny";
    displayName: string;
  } | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [seenWaitingCount, setSeenWaitingCount] = useState<number | null>(null);
  const admissions = useMediaAdmissions(
    tenantID,
    spaceID,
    roomInstanceID,
    spaceVersion,
    roomInstanceVersion,
    enabled,
  );
  const resolve = useResolveMediaAdmission(tenantID, spaceID, roomInstanceID);

  const commandForbidden =
    resolve.error instanceof APIRequestError && resolve.error.status === 403;
  const concealed =
    shouldConcealTenantScopedData(admissions.error) || commandForbidden;
  const forbidden =
    admissions.error instanceof APIRequestError &&
    admissions.error.status === 403;
  const waiting = concealed ? [] : waitingAdmissions(admissions.data);
  const visibleWaiting = filter?.active
    ? waiting.filter((item) => filter.matches(item.display_name))
    : waiting;
  const queueReady = enabled && admissions.isSuccess && !concealed;

  // A new request (the queue grew since the panel last looked) re-opens the
  // group and is announced once; the first observation stays silent because
  // the stage banner and the Dock badge already said it.
  if (queueReady && seenWaitingCount !== waiting.length) {
    if (seenWaitingCount !== null && waiting.length > seenWaitingCount) {
      setCollapsed(false);
      setAnnouncement(
        t("media.people.waitingAnnouncement", { count: waiting.length }),
      );
    }
    setSeenWaitingCount(waiting.length);
  }

  const reportMatchCount = filter?.onMatchCountChange;
  const matchCount = enabled ? visibleWaiting.length : 0;
  useEffect(() => {
    reportMatchCount?.(matchCount);
  }, [matchCount, reportMatchCount]);
  useEffect(() => () => reportMatchCount?.(0), [reportMatchCount]);

  if (!enabled) {
    return null;
  }

  const actionPending = (admissionID: string) =>
    resolve.isPending && resolve.variables?.admissionID === admissionID;

  const command = (action: "admit" | "deny", item: MediaAdmissionItem) => {
    const commandKey = `${action}:${item.id}:${item.version}`;
    let idempotencyKey = idempotencyKeys.current.get(commandKey);
    if (!idempotencyKey) {
      idempotencyKey = mediaLobbyIdempotencyKey(`admission-${action}`);
      idempotencyKeys.current.set(commandKey, idempotencyKey);
    }
    resolve.mutate(
      {
        action,
        admissionID: item.id,
        input: {
          expected_space_version: spaceVersion,
          expected_room_instance_id: roomInstanceID,
          expected_room_instance_version: roomInstanceVersion,
          expected_admission_version: item.version,
          idempotency_key: idempotencyKey,
          ...(action === "deny" ? { reason_code: "moderator_denied" } : {}),
        },
      },
      {
        onSuccess: () => {
          idempotencyKeys.current.delete(commandKey);
          setDenyTarget(null);
          setFeedback({ action, displayName: item.display_name });
          // The resolved row leaves the list: keep focus in the group, or on
          // the confirmation when the group has just emptied.
          globalThis.requestAnimationFrame(() => {
            const toggle = groupToggle.current;
            if (toggle?.isConnected) toggle.focus();
            else feedbackLine.current?.focus();
          });
        },
      },
    );
  };

  const showError = admissions.isError || commandForbidden;
  const showLoading = admissions.isPending && !showError;
  const showGroup = showLoading || showError || visibleWaiting.length > 0;
  const count = visibleWaiting.length;

  return (
    <div className="media-p406-people-waiting">
      <p
        aria-atomic="true"
        aria-live="polite"
        className="media-p406-people-sr-only"
        role="status"
      >
        {announcement}
      </p>

      {feedback && !concealed && (
        <p
          className="media-p406-people-feedback"
          ref={feedbackLine}
          role="status"
          tabIndex={-1}
        >
          {t(
            feedback.action === "admit"
              ? "media.p404.lobby.admitted"
              : "media.p404.lobby.denied",
            { name: feedback.displayName },
          )}
        </p>
      )}

      {showGroup && (
        <section
          aria-labelledby={sectionLabelID}
          className="media-p406-people-section"
        >
          <h3 className="media-p406-people-section__label" id={sectionLabelID}>
            {t("media.people.waitingSection")}
          </h3>
          <div className="media-p406-people-group" data-group="waiting">
            {showError ? (
              <div className="media-p406-people-state" role="alert">
                <h4 className="media-p406-people-state__title">
                  {t(
                    concealed || forbidden
                      ? "media.p404.lobby.forbiddenTitle"
                      : "media.p404.lobby.errorTitle",
                  )}
                </h4>
                <p className="media-p406-people-state__text">
                  {t(
                    concealed || forbidden
                      ? "media.p404.lobby.forbiddenDescription"
                      : "media.p404.lobby.errorDescription",
                  )}
                </p>
                <Button
                  onClick={() => {
                    resolve.reset();
                    void admissions.refetch();
                  }}
                  size="sm"
                  variant="secondary"
                >
                  {t("state.retry")}
                </Button>
              </div>
            ) : showLoading ? (
              <SkeletonGroup
                className="media-p406-people-skeleton"
                label={t("media.people.waitingLoading")}
              >
                <span className="media-p406-people-skeleton__row">
                  <Skeleton height={32} width={32} />
                  <Skeleton height={12} width="55%" />
                </span>
              </SkeletonGroup>
            ) : (
              <>
                <h4 className="media-p406-people-group__heading">
                  <button
                    aria-controls={listID}
                    aria-expanded={!collapsed}
                    className="media-p406-people-group__toggle"
                    onClick={() => setCollapsed((value) => !value)}
                    ref={groupToggle}
                    type="button"
                  >
                    <span className="media-p406-people-group__label">
                      {t("media.people.waitingGroup")}
                    </span>{" "}
                    <span
                      aria-hidden="true"
                      className="media-p406-people-group__dot"
                    >
                      ·
                    </span>{" "}
                    <span className="media-p406-people-group__count">
                      {count}
                    </span>
                    <ChevronUp
                      aria-hidden="true"
                      className="media-p406-people-group__chevron"
                    />
                  </button>
                </h4>
                <ul
                  aria-label={t("media.p404.lobby.listLabel")}
                  className="media-p406-people-list"
                  hidden={collapsed}
                  id={listID}
                >
                  {visibleWaiting.map((item) => (
                    <li
                      className="media-p406-people-row media-p406-people-row--waiting"
                      key={item.id}
                    >
                      <span
                        aria-hidden="true"
                        className="media-p406-people-avatar"
                        data-tone={chatAvatarTone(item.display_name)}
                      >
                        {avatarInitial(item.display_name)}
                      </span>
                      <span className="media-p406-people-row__text">
                        <span className="media-p406-people-row__name">
                          <span
                            className="media-p406-people-row__display"
                            title={item.display_name}
                          >
                            {item.display_name}
                          </span>
                        </span>
                      </span>
                      <span className="media-p406-people-row__waiting-actions">
                        <Button
                          aria-label={t("media.p404.lobby.admitNamed", {
                            name: item.display_name,
                          })}
                          className="media-p406-people-admit"
                          disabled={resolve.isPending}
                          loading={actionPending(item.id)}
                          loadingLabel={t("media.p404.lobby.resolving")}
                          onClick={() => command("admit", item)}
                          size="sm"
                          variant="quiet"
                        >
                          {t("media.people.admit")}
                        </Button>
                        <Menu modal={false}>
                          <MenuTrigger asChild>
                            <IconButton
                              className="media-p406-people-more"
                              disabled={resolve.isPending}
                              label={t("media.people.waitingMenu", {
                                name: item.display_name,
                              })}
                              size="sm"
                              variant="quiet"
                            >
                              <MoreVertical />
                            </IconButton>
                          </MenuTrigger>
                          <MenuContent
                            align="end"
                            aria-label={t("media.people.waitingMenu", {
                              name: item.display_name,
                            })}
                            className="media-p407-participant-menu"
                            data-theme="dark"
                          >
                            <MenuItem
                              onSelect={() => {
                                resolve.reset();
                                setDenyTarget(item);
                              }}
                              tone="danger"
                            >
                              <UserRoundX aria-hidden="true" />
                              {t("media.p404.lobby.deny")}
                            </MenuItem>
                          </MenuContent>
                        </Menu>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </section>
      )}

      {resolve.isError && !denyTarget && !commandForbidden && (
        <div className="media-p406-people-inline-error" role="alert">
          <p>{t(mediaLobbyMutationErrorKey(resolve.error))}</p>
          <Button
            onClick={() => {
              resolve.reset();
              void admissions.refetch();
            }}
            size="sm"
            variant="secondary"
          >
            {t("media.p404.reload")}
          </Button>
        </div>
      )}

      <Dialog
        onOpenChange={(open) => {
          if (!open && !resolve.isPending) {
            setDenyTarget(null);
            resolve.reset();
          }
        }}
        open={Boolean(denyTarget && !concealed)}
      >
        <DialogContent
          closeLabel={t("media.p404.closeDialog")}
          data-theme="dark"
        >
          <DialogTitle>{t("media.p404.lobby.denyTitle")}</DialogTitle>
          <DialogDescription>
            {t("media.p404.lobby.denyDescription", {
              name: denyTarget?.display_name ?? "",
            })}
          </DialogDescription>
          {resolve.isError && (
            <p className="media-p404-error" role="alert">
              {t(mediaLobbyMutationErrorKey(resolve.error))}
            </p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button disabled={resolve.isPending} variant="secondary">
                {t("media.p404.cancel")}
              </Button>
            </DialogClose>
            <Button
              disabled={!denyTarget}
              loading={resolve.isPending}
              loadingLabel={t("media.p404.lobby.resolving")}
              onClick={() => {
                if (denyTarget) command("deny", denyTarget);
              }}
              variant="danger"
            >
              {t("media.p404.lobby.confirmDeny")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The camera-off tile's initial, so a person reads the same in both places. */
function avatarInitial(name: string): string {
  return (Array.from(name.trim())[0] ?? "?").toLocaleUpperCase();
}

function mediaLobbyMutationErrorKey(error: unknown) {
  if (error instanceof APIRequestError) {
    if (error.status === 409) return "media.p404.conflict" as const;
    if (error.status === 429) return "media.p404.rateLimited" as const;
    if (error.status === 503) return "media.p404.unavailable" as const;
  }
  return "media.p404.commandError" as const;
}
