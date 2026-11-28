import { Button, IconButton } from "@tutorhub/ui";
import { Building2, Menu, RefreshCw, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useNavigation,
} from "react-router";
import { useAutoHideScrollbars } from "../app/autoHideScrollbars";
import { getVisibleNavigationItems, navigationItems } from "../app/routes";
import { useI18n } from "../app/i18n";
import { useOnlineStatus } from "../app/onlineStatus";
import { isAdminMFARequired, useStepUpRequest } from "../app/security";
import { useSession } from "../app/session";
import { useWorkspaceActions } from "../app/workspaces";
import { useTenantCapabilities } from "../app/tenantCapabilities";
import { AdminMfaRequiredNotice } from "./AdminMfaRequiredNotice";
import { AppSidebar, WorkspaceSwitcher } from "./AppSidebar";
import { StepUpAuthDialog } from "./StepUpAuthDialog";
import { SystemSettingsProvider } from "./SystemSettingsCard";

/** Same threshold as the drawer media query in styles.css. */
const COMPACT_SIDEBAR_QUERY = "(max-width: 680px)";

function subscribeCompactSidebar(onChange: () => void) {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(COMPACT_SIDEBAR_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getCompactSidebarSnapshot() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia(COMPACT_SIDEBAR_QUERY).matches
  );
}

/** True while the sidebar renders as the mobile drawer. */
function useCompactSidebar() {
  return useSyncExternalStore(
    subscribeCompactSidebar,
    getCompactSidebarSnapshot,
    () => false,
  );
}

export function AppShell() {
  const { t } = useI18n();
  const session = useSession();
  const navigate = useNavigate();
  const { switchWorkspace } = useWorkspaceActions({
    onSwitchSuccess: () => navigate("/app/home", { replace: true }),
  });
  const location = useLocation();
  const navigation = useNavigation();
  const isOnline = useOnlineStatus();
  const stepUp = useStepUpRequest();
  const [isNavigationOpen, setIsNavigationOpen] = useState(false);
  const isCompact = useCompactSidebar();
  const [wasCompact, setWasCompact] = useState(isCompact);
  const menuToggleRef = useRef<HTMLButtonElement>(null);
  const restoreMenuFocus = useRef(false);
  const activeTenant = session.currentUser?.active_tenant;
  // AUTH-09B: without an active workspace only account settings render here.
  const visibleNavigationItems = getVisibleNavigationItems(
    session.currentUser?.permissions ?? [],
    { hasActiveTenant: Boolean(activeTenant) },
  );
  const onSettingsPage = location.pathname.startsWith("/app/settings");
  const tenantCapabilities = useTenantCapabilities(
    activeTenant?.id,
    Boolean(activeTenant?.id),
  );
  const notificationEnabled =
    tenantCapabilities.data?.features.in_app_notifications?.enabled === true;
  const notificationTenantID =
    notificationEnabled && activeTenant ? activeTenant.id : null;
  // Language, connection, notifications and sign-out live in Settings >
  // System now; the shell only tells that card whether notifications apply.
  const systemSettings = useMemo(
    () => ({ notificationTenantID }),
    [notificationTenantID],
  );
  useAutoHideScrollbars();
  const activeMemberships =
    session.currentUser?.memberships.filter(
      (membership) => membership.status === "active",
    ) ?? [];
  const tenantOptions = activeMemberships.length
    ? activeMemberships
    : activeTenant?.status === "active"
      ? [activeTenant]
      : [];

  const currentItem = navigationItems.find((item) =>
    location.pathname.startsWith(item.to),
  );
  const role = session.currentUser?.active_tenant?.role ?? "guest";
  const roleLabel =
    role === "org_admin"
      ? t("shell.role.admin")
      : role === "teacher"
        ? t("shell.role.teacher")
        : role === "student"
          ? t("shell.role.student")
          : t("shell.role.guest");
  const displayName =
    session.currentUser?.user.display_name || t("shell.profile");
  const drawerActive = isNavigationOpen && isCompact;

  const closeNavigation = useCallback((restoreFocus: boolean) => {
    restoreMenuFocus.current = restoreFocus;
    setIsNavigationOpen(false);
  }, []);

  // The drawer only exists on narrow screens; widening the window closes it.
  if (wasCompact !== isCompact) {
    setWasCompact(isCompact);
    if (!isCompact) setIsNavigationOpen(false);
  }

  // Focus goes back to the toggle once `inert` has left the workspace column.
  useEffect(() => {
    if (!isNavigationOpen && restoreMenuFocus.current) {
      restoreMenuFocus.current = false;
      menuToggleRef.current?.focus();
    }
  }, [isNavigationOpen]);

  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
        inert={drawerActive || undefined}
      >
        {t("shell.skip")}
      </a>

      <AppSidebar
        displayName={displayName}
        isCompact={isCompact}
        isOpen={isNavigationOpen}
        items={visibleNavigationItems}
        onClose={closeNavigation}
        roleLabel={roleLabel}
        workspaceSwitcher={
          <WorkspaceSwitcher
            activeTenant={activeTenant}
            isPending={switchWorkspace.isPending}
            onSelect={(tenantID) => {
              if (!switchWorkspace.isPending && tenantID !== activeTenant?.id) {
                switchWorkspace.mutate(tenantID);
              }
            }}
            options={tenantOptions}
          />
        }
      />

      <div className="app-workspace" inert={drawerActive || undefined}>
        {/* Phones only (the sidebar is a drawer there): the drawer toggle and
            the page name. Desktop has no top bar, so pages get the height. */}
        <header className="app-topbar">
          <div className="app-topbar__context">
            <IconButton
              aria-expanded={isNavigationOpen}
              className="menu-toggle"
              label={
                isNavigationOpen
                  ? t("shell.closeNavigation")
                  : t("shell.openNavigation")
              }
              onClick={() => setIsNavigationOpen((open) => !open)}
              ref={menuToggleRef}
              size="sm"
              variant="secondary"
            >
              {isNavigationOpen ? <X /> : <Menu />}
            </IconButton>
            <span className="app-topbar__eyebrow">{t("brand.product")}</span>
            <strong>
              {currentItem ? t(currentItem.labelKey) : t("nav.home")}
            </strong>
          </div>
        </header>

        {switchWorkspace.isPending && (
          <p className="visually-hidden" role="status">
            {t("workspace.switching")}
          </p>
        )}

        {switchWorkspace.isError &&
          isAdminMFARequired(switchWorkspace.error) && (
            <section className="workspace-admin-mfa">
              <AdminMfaRequiredNotice
                onVerify={() => {
                  const tenantID = switchWorkspace.variables;
                  stepUp.request(
                    () => {
                      if (tenantID) switchWorkspace.mutate(tenantID);
                    },
                    { requireAal2: true },
                  );
                }}
                showSettingsLink={!onSettingsPage}
              />
            </section>
          )}

        {switchWorkspace.isError &&
          !isAdminMFARequired(switchWorkspace.error) && (
            <section className="workspace-switch-error" role="alert">
              <span>{t("workspace.selectError")}</span>
              <Button
                disabled={!switchWorkspace.variables}
                onClick={() => {
                  if (switchWorkspace.variables) {
                    switchWorkspace.mutate(switchWorkspace.variables);
                  }
                }}
                size="sm"
                variant="secondary"
              >
                {t("state.retry")}
              </Button>
            </section>
          )}

        {!isOnline && (
          <section className="connectivity-notice" role="status">
            <div>
              <strong>{t("shell.offline")}</strong>
              <p>{t("shell.offlineMessage")}</p>
            </div>
            <Button
              leadingIcon={<RefreshCw />}
              onClick={() => window.location.reload()}
              size="sm"
              variant="secondary"
            >
              {t("shell.retryConnection")}
            </Button>
          </section>
        )}

        <main id="main-content" tabIndex={-1}>
          {navigation.state !== "idle" && (
            <div className="route-progress" aria-live="polite" />
          )}
          {!activeTenant && (
            <section
              aria-labelledby="tenantless-notice-title"
              className="tenantless-notice"
            >
              <div>
                <h2 id="tenantless-notice-title">
                  {t("shell.noWorkspaceTitle")}
                </h2>
                <p>{t("shell.noWorkspace")}</p>
              </div>
              <Link
                className="th-button th-button--secondary th-button--sm tenantless-notice__link"
                to="/app/home"
              >
                <span aria-hidden="true" className="th-button__icon">
                  <Building2 />
                </span>
                <span>{t("shell.chooseWorkspace")}</span>
              </Link>
            </section>
          )}
          <SystemSettingsProvider value={systemSettings}>
            <Outlet />
          </SystemSettingsProvider>
        </main>
      </div>

      <StepUpAuthDialog {...stepUp.dialog} />
    </div>
  );
}
