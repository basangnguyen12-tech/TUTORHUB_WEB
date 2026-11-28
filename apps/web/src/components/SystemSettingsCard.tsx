import { Button } from "@tutorhub/ui";
import { LogOut, Settings2 } from "lucide-react";
import { createContext, useContext, useId, type ReactNode } from "react";
import { useI18n } from "../app/i18n";
import { useOnlineStatus } from "../app/onlineStatus";
import { useSession } from "../app/session";
import { NotificationBell } from "./NotificationBell";

/**
 * Shell facts the System card needs but must not query itself: AppShell
 * already resolves the tenant's notification capability, so the card only
 * reads it (outside the shell, e.g. in page tests, notifications stay off).
 */
export interface SystemSettingsShell {
  /** Tenant whose in-app notifications are enabled, else `null`. */
  notificationTenantID: string | null;
}

const SystemSettingsContext = createContext<SystemSettingsShell>({
  notificationTenantID: null,
});

export function SystemSettingsProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: SystemSettingsShell;
}) {
  return (
    <SystemSettingsContext.Provider value={value}>
      {children}
    </SystemSettingsContext.Provider>
  );
}

function SettingRow({
  children,
  hint,
  label,
}: {
  children: ReactNode;
  hint: string;
  label: ReactNode;
}) {
  return (
    <li className="system-settings__row">
      <div className="system-settings__text">
        {label}
        <span>{hint}</span>
      </div>
      <div className="system-settings__control">{children}</div>
    </li>
  );
}

/**
 * Settings > System: the controls that used to live in the app top bar
 * (language, connection, notifications, sign out). Rendered in every state of
 * the settings page so signing out never depends on the profile loading.
 */
export function SystemSettingsCard() {
  const { language, setLanguage, t } = useI18n();
  const session = useSession();
  const isOnline = useOnlineStatus();
  const { notificationTenantID } = useContext(SystemSettingsContext);
  const languageID = useId();

  return (
    <section
      aria-labelledby="system-settings-title"
      className="profile-panel system-settings"
    >
      <div className="profile-panel__heading">
        <span aria-hidden="true" className="profile-panel__icon">
          <Settings2 />
        </span>
        <div>
          <h2 id="system-settings-title">{t("systemSettings.title")}</h2>
          <p>{t("systemSettings.description")}</p>
        </div>
      </div>

      <ul className="system-settings__list">
        <SettingRow
          hint={t("systemSettings.languageHint")}
          label={
            <label htmlFor={languageID}>
              <strong>{t("shell.language")}</strong>
            </label>
          }
        >
          <span className="language-select">
            <select
              id={languageID}
              onChange={(event) =>
                setLanguage(event.target.value === "en" ? "en" : "vi")
              }
              value={language}
            >
              <option value="vi">Tiếng Việt</option>
              <option value="en">English</option>
            </select>
          </span>
        </SettingRow>

        <SettingRow
          hint={t("systemSettings.connectionHint")}
          label={<strong>{t("systemSettings.connection")}</strong>}
        >
          <span
            className={`connection-status${isOnline ? " connection-status--online" : ""}`}
            role="status"
          >
            {isOnline ? t("shell.online") : t("shell.offline")}
          </span>
        </SettingRow>

        {notificationTenantID && (
          <SettingRow
            hint={t("systemSettings.notificationsHint")}
            label={<strong>{t("systemSettings.notifications")}</strong>}
          >
            <NotificationBell tenantID={notificationTenantID} />
          </SettingRow>
        )}

        <SettingRow
          hint={t("systemSettings.signOutHint")}
          label={<strong>{t("systemSettings.session")}</strong>}
        >
          <Button
            className="system-settings__sign-out"
            leadingIcon={<LogOut />}
            onClick={() => void session.signOut()}
            size="sm"
            variant="secondary"
          >
            {t("auth.signOut")}
          </Button>
        </SettingRow>
      </ul>
    </section>
  );
}
