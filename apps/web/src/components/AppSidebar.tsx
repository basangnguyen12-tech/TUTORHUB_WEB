import { Tooltip, TooltipProvider } from "@tutorhub/ui";
import {
  Building2,
  CalendarDays,
  ChevronsUpDown,
  Circle,
  GraduationCap,
  House,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import { Link, NavLink } from "react-router";
import { useI18n, type TranslationKey } from "../app/i18n";
import type { NavigationItem } from "../app/routes";
import { UserAvatar } from "./UserAvatar";

/**
 * NAV-SIDEBAR-SAAS-01: modern SaaS sidebar (workspace switcher on top, grouped
 * icon + label items, desktop icon-rail collapse, mobile drawer). Which items
 * show is still decided by `getVisibleNavigationItems`; this file only groups
 * and renders them.
 */

/**
 * UI-only flag (no user data), so it is global rather than per tenant/user.
 * The default (expanded) state is never written.
 */
export const SIDEBAR_COLLAPSED_KEY = "tutorhub.sidebar-collapsed";

/**
 * TutorHub logo downscaled from `images/auth/logomoi.png` (sign-in page and
 * favicon, 512px / 455KB) to 64px / ~9KB: sharp at 28px on 2x screens.
 */
const BRAND_LOGO_SRC = "/images/brand/tutorhub-logo-64.png";

function BrandLogo() {
  return (
    <img
      alt=""
      className="app-switcher__logo"
      decoding="async"
      height={28}
      src={BRAND_LOGO_SRC}
      width={28}
    />
  );
}

function readSidebarCollapsed() {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeSidebarCollapsed(collapsed: boolean) {
  try {
    if (collapsed) {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
    } else {
      window.localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
    }
  } catch {
    // Storage can be unavailable (private mode, blocked site data).
  }
}

interface NavigationGroupDefinition {
  id: string;
  labelKey?: TranslationKey;
  paths: readonly string[];
}

const navigationGroupDefinitions: readonly NavigationGroupDefinition[] = [
  { id: "main", paths: ["/app/home"] },
  {
    id: "learning",
    labelKey: "shell.navGroup.learning",
    paths: ["/app/classrooms", "/app/messages", "/app/calendar"],
  },
  {
    id: "manage",
    labelKey: "shell.navGroup.manage",
    paths: ["/app/workspace", "/app/settings"],
  },
];

const navigationIcons: Readonly<Record<string, LucideIcon>> = {
  "/app/home": House,
  "/app/classrooms": GraduationCap,
  "/app/messages": MessageSquare,
  "/app/calendar": CalendarDays,
  "/app/workspace": Building2,
  "/app/settings": Settings,
};

interface NavigationGroup {
  id: string;
  labelKey?: TranslationKey;
  items: readonly NavigationItem[];
}

/**
 * Groups already-filtered items, keeping their order. A group left empty by
 * the permission filter is dropped together with its label; an item no group
 * claims falls back to the first (unlabelled) group.
 */
function groupNavigationItems(
  items: readonly NavigationItem[],
): NavigationGroup[] {
  const claimed = new Set(
    navigationGroupDefinitions.flatMap((group) => group.paths),
  );
  return navigationGroupDefinitions
    .map((group, index) => ({
      id: group.id,
      labelKey: group.labelKey,
      items: items.filter(
        (item) =>
          group.paths.includes(item.to) ||
          (index === 0 && !claimed.has(item.to)),
      ),
    }))
    .filter((group) => group.items.length > 0);
}

export interface WorkspaceOption {
  id: string;
  name: string;
}

export interface WorkspaceSwitcherProps {
  activeTenant: WorkspaceOption | null | undefined;
  options: readonly WorkspaceOption[];
  isPending: boolean;
  onSelect: (tenantID: string) => void;
}

/**
 * Keeps the native `<select>` (combobox semantics, keyboard and screen reader
 * behaviour) laid transparently over a Cloudflare-style switcher face.
 */
export function WorkspaceSwitcher({
  activeTenant,
  options,
  isPending,
  onSelect,
}: WorkspaceSwitcherProps) {
  const { t } = useI18n();

  if (!activeTenant) {
    return (
      <div className="workspace-select app-switcher app-switcher--empty">
        <Link
          className="app-switcher__choose"
          title={t("shell.chooseWorkspace")}
          to="/app/home"
        >
          <BrandLogo />
          <span className="app-switcher__text">
            <strong>{t("shell.chooseWorkspace")}</strong>
          </span>
        </Link>
      </div>
    );
  }

  const canSwitch = options.length > 1;

  return (
    <div
      className={`workspace-select app-switcher${canSwitch ? " app-switcher--interactive" : ""}${isPending ? " app-switcher--busy" : ""}`}
      title={activeTenant.name}
    >
      <BrandLogo />
      <span
        aria-hidden={canSwitch ? true : undefined}
        className="app-switcher__text"
      >
        {!canSwitch && (
          <span className="visually-hidden">
            {t("workspace.activeLabel")}:{" "}
          </span>
        )}
        <strong>{activeTenant.name}</strong>
        <small>{t("brand.product")}</small>
      </span>
      {canSwitch && (
        <>
          <ChevronsUpDown
            aria-hidden="true"
            className="app-switcher__chevron"
          />
          <select
            aria-busy={isPending || undefined}
            aria-label={t("workspace.activeLabel")}
            className="app-switcher__select"
            disabled={isPending}
            onChange={(event) => onSelect(event.target.value)}
            value={activeTenant.id}
          >
            {options.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.name}
              </option>
            ))}
          </select>
        </>
      )}
    </div>
  );
}

interface SidebarLinkProps {
  item: NavigationItem;
  collapsed: boolean;
  onNavigate: () => void;
}

function SidebarLink({ item, collapsed, onNavigate }: SidebarLinkProps) {
  const { t } = useI18n();
  const Icon = navigationIcons[item.to] ?? Circle;
  const label = t(item.labelKey);
  const link = (
    // A string className on purpose: the collapsed-rail Tooltip trigger (Radix
    // Slot) joins classNames as strings and would break a className function.
    // The active state is styled from NavLink's `aria-current="page"`.
    <NavLink
      className="app-navigation__link"
      onClick={onNavigate}
      title={collapsed ? undefined : label}
      to={item.to}
    >
      <Icon
        aria-hidden="true"
        className="app-navigation__icon"
        strokeWidth={1.75}
      />
      <span className="app-navigation__text">{label}</span>
    </NavLink>
  );

  return collapsed ? (
    <Tooltip content={label} side="right">
      {link}
    </Tooltip>
  ) : (
    link
  );
}

export interface AppSidebarProps {
  items: readonly NavigationItem[];
  /** True while the sidebar renders as the mobile drawer (≤ 680px). */
  isCompact: boolean;
  /** Mobile drawer state; ignored on wider screens. */
  isOpen: boolean;
  /** `restoreFocus` returns focus to the drawer toggle (Esc, backdrop, ×). */
  onClose: (restoreFocus: boolean) => void;
  workspaceSwitcher: ReactElement;
  displayName: string;
  roleLabel: string;
}

export function AppSidebar({
  items,
  isCompact,
  isOpen,
  onClose,
  workspaceSwitcher,
  displayName,
  roleLabel,
}: AppSidebarProps) {
  const { t } = useI18n();
  const [isCollapsedPreference, setIsCollapsedPreference] =
    useState(readSidebarCollapsed);
  const collapsed = isCollapsedPreference && !isCompact;
  const drawerActive = isOpen && isCompact;
  const sidebarID = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const groups = groupNavigationItems(items);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!drawerActive) return undefined;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        onCloseRef.current(true);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [drawerActive]);

  const toggleCollapsed = () => {
    const next = !isCollapsedPreference;
    writeSidebarCollapsed(next);
    setIsCollapsedPreference(next);
  };

  const collapseLabel = collapsed
    ? t("shell.expandSidebar")
    : t("shell.collapseSidebar");

  // Own provider: the shell must not depend on an outer TooltipProvider.
  return (
    <TooltipProvider delayDuration={350}>
      {drawerActive && (
        <div
          aria-hidden="true"
          className="app-sidebar-backdrop"
          data-testid="app-sidebar-backdrop"
          onClick={() => onClose(true)}
        />
      )}
      <aside
        aria-label={t("shell.navigation")}
        className={`app-sidebar${isOpen ? " app-sidebar--open" : ""}${collapsed ? " app-sidebar--collapsed" : ""}`}
        id={sidebarID}
      >
        <div className="app-sidebar__header">
          {workspaceSwitcher}
          <button
            aria-label={t("shell.closeNavigation")}
            className="app-sidebar__close"
            onClick={() => onClose(true)}
            ref={closeButtonRef}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </div>

        <nav className="app-navigation" aria-label={t("shell.navigation")}>
          {groups.map((group) => {
            const labelID = `${sidebarID}-${group.id}`;
            return (
              <div
                aria-labelledby={group.labelKey ? labelID : undefined}
                className="app-navigation__group"
                key={group.id}
                role={group.labelKey ? "group" : undefined}
              >
                {group.labelKey && (
                  <p className="app-navigation__label" id={labelID}>
                    {t(group.labelKey)}
                  </p>
                )}
                <ul className="app-navigation__list">
                  {group.items.map((item) => (
                    <li key={item.to}>
                      <SidebarLink
                        collapsed={collapsed}
                        item={item}
                        onNavigate={() => onClose(false)}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>

        <div className="app-sidebar__bottom">
          <Link
            className="app-sidebar__footer"
            onClick={() => onClose(false)}
            title={t("shell.accountSettings")}
            to="/app/settings"
          >
            {/* MSG-AVATAR-SEARCH-CLASSIN-01: Zalo-style default avatar; the
                name next to it carries the meaning. */}
            <UserAvatar className="app-sidebar__avatar" size="sm" />
            <span className="app-sidebar__identity">
              <span className="app-sidebar__role">{roleLabel}</span>
              <strong>{displayName}</strong>
            </span>
          </Link>
          <Tooltip content={collapseLabel} side={collapsed ? "right" : "top"}>
            <button
              aria-controls={sidebarID}
              aria-expanded={!collapsed}
              aria-label={collapseLabel}
              className="app-sidebar__collapse"
              onClick={toggleCollapsed}
              type="button"
            >
              {collapsed ? (
                <PanelLeftOpen aria-hidden="true" />
              ) : (
                <PanelLeftClose aria-hidden="true" />
              )}
            </button>
          </Tooltip>
        </div>
      </aside>
    </TooltipProvider>
  );
}
