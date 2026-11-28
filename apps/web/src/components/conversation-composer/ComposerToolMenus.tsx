import { Menu, MenuContent, MenuItem, MenuTrigger } from "@tutorhub/ui";
import {
  FolderOpen,
  Monitor,
  Scissors,
  TimerReset,
  Upload,
} from "lucide-react";
import { Link } from "react-router";
import { useI18n } from "../../app/i18n";
import {
  SCREEN_CAPTURE_DELAY_SECONDS,
  captureShortcutLabel,
  type ScreenCaptureMode,
} from "./screenCapture";

function MenuItemText({ hint, label }: { hint?: string; label: string }) {
  return (
    <span className="conversation-composer-menu__text">
      <span className="conversation-composer-menu__label">{label}</span>
      {hint && <span className="conversation-composer-menu__hint">{hint}</span>}
    </span>
  );
}

/** MSG-COMPOSER-TOOLS-01: "Screenshot ▾" (APG menu button). */
export function ComposerCaptureMenu({
  busy,
  disabled,
  fullReason,
  onCapture,
}: {
  busy: boolean;
  disabled: boolean;
  /** Set when the message already carries the maximum number of files. */
  fullReason: string | null;
  onCapture: (mode: ScreenCaptureMode) => void;
}) {
  const { t } = useI18n();
  const label = t("conversations.screenshot", {
    shortcut: captureShortcutLabel(),
  });
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          aria-busy={busy || undefined}
          aria-keyshortcuts="Control+Alt+X"
          aria-label={label}
          className="conversation-composer__tool"
          data-tooltip={label}
          // Stays enabled while busy so focus is not dropped to <body>.
          disabled={disabled}
          type="button"
        >
          <Scissors aria-hidden="true" />
        </button>
      </MenuTrigger>
      <MenuContent
        align="start"
        className="conversation-mention-menu conversation-composer-menu"
        side="top"
      >
        <MenuItem
          disabled={busy || fullReason !== null}
          onSelect={() => onCapture("screen")}
        >
          <Monitor aria-hidden="true" />
          <MenuItemText
            hint={fullReason ?? t("conversations.screenshotNowHint")}
            label={t("conversations.screenshotNow")}
          />
        </MenuItem>
        <MenuItem
          disabled={busy || fullReason !== null}
          onSelect={() => onCapture("delayed")}
        >
          <TimerReset aria-hidden="true" />
          <MenuItemText
            hint={fullReason ?? t("conversations.screenshotDelayedHint")}
            label={t("conversations.screenshotDelayed", {
              seconds: SCREEN_CAPTURE_DELAY_SECONDS,
            })}
          />
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

/** MSG-COMPOSER-TOOLS-01: "Send file ▾" (device upload, class materials). */
export function ComposerFileMenu({
  canUpload,
  classID,
  disabled,
  fullReason,
  onPickFromDevice,
}: {
  canUpload: boolean;
  classID?: string;
  disabled: boolean;
  fullReason: string | null;
  onPickFromDevice: () => void;
}) {
  const { t } = useI18n();
  const label = t("conversations.sendFile");
  if (!canUpload) {
    // A one-item menu adds a step for nothing: link straight to materials.
    if (!classID) return null;
    const materials = t("conversations.openMaterialsTool");
    return (
      <Link
        aria-label={materials}
        className="conversation-composer__tool"
        data-tooltip={materials}
        to={`/app/classrooms/${classID}?tab=materials`}
      >
        <FolderOpen aria-hidden="true" />
      </Link>
    );
  }
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          aria-label={label}
          className="conversation-composer__tool"
          data-tooltip={label}
          disabled={disabled}
          type="button"
        >
          <FolderOpen aria-hidden="true" />
        </button>
      </MenuTrigger>
      <MenuContent
        align="start"
        className="conversation-mention-menu conversation-composer-menu"
        side="top"
      >
        <MenuItem disabled={fullReason !== null} onSelect={onPickFromDevice}>
          <Upload aria-hidden="true" />
          <MenuItemText
            hint={fullReason ?? undefined}
            label={t("conversations.sendFromDevice")}
          />
        </MenuItem>
        {classID && (
          <MenuItem asChild>
            <Link to={`/app/classrooms/${classID}?tab=materials`}>
              <FolderOpen aria-hidden="true" />
              <MenuItemText label={t("conversations.openMaterialsTool")} />
            </Link>
          </MenuItem>
        )}
      </MenuContent>
    </Menu>
  );
}
