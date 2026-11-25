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
  MenuSeparator,
  MenuTrigger,
} from "@tutorhub/ui";
import {
  Lock,
  MicOff,
  MoreVertical,
  Pencil,
  PencilOff,
  Unlock,
  UserMinus,
  UserPlus,
  UserRoundX,
} from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useI18n, type TranslationKey } from "../../app/i18n";

export type ClassroomModerationAction =
  | "lock_room"
  | "unlock_room"
  | "end_room"
  | "promote_co_host"
  | "demote_co_host"
  | "remote_mute"
  | "remove_participant";

export type ClassroomModerationFailureReason =
  | "forbidden"
  | "conflict"
  | "rate_limited"
  | "provider_unavailable"
  | "unknown";

export type ClassroomModerationMutationState =
  | { readonly status: "idle" }
  | {
      readonly status: "submitting";
      readonly action: ClassroomModerationAction;
      readonly targetParticipantKey?: string;
    }
  | {
      readonly status: "failed";
      readonly action: ClassroomModerationAction;
      readonly reason: ClassroomModerationFailureReason;
      readonly targetParticipantKey?: string;
    };

export type ClassroomModerationProviderEffect =
  | { readonly status: "idle" }
  | {
      readonly status: "pending";
      readonly action: ClassroomModerationAction;
      readonly targetParticipantKey?: string;
    }
  | {
      readonly status: "applied";
      readonly action: ClassroomModerationAction;
      readonly targetParticipantKey?: string;
    }
  | {
      readonly status: "reconcile_required";
      readonly action: ClassroomModerationAction;
      readonly targetParticipantKey?: string;
    };

/**
 * Fail-closed presentation contract. Every capability is an exact server
 * projection. The browser must never infer an operation from instance_role or
 * a LiveKit participant attribute.
 */
export interface ClassroomModerationParticipantOperations {
  readonly participantKey: string;
  readonly canPromoteCoHost: boolean;
  readonly canDemoteCoHost: boolean;
  readonly canRemoteMute: boolean;
  readonly canRemove: boolean;
}

export interface ClassroomModerationControlsModel {
  readonly roomLocked: boolean;
  readonly canLockRoom: boolean;
  readonly canEndRoom: boolean;
  readonly participantOperations: readonly ClassroomModerationParticipantOperations[];
  readonly mutationState: ClassroomModerationMutationState;
  readonly providerEffect: ClassroomModerationProviderEffect;
  readonly onSetRoomLocked: (locked: boolean) => Promise<void>;
  readonly onEndRoom: () => Promise<void>;
  readonly onPromoteCoHost: (participantKey: string) => Promise<void>;
  readonly onDemoteCoHost: (participantKey: string) => Promise<void>;
  readonly onRemoteMute: (participantKey: string) => Promise<void>;
  readonly onRemoveParticipant: (participantKey: string) => Promise<void>;
}

interface ClassroomModerationControlsProps {
  readonly controls: ClassroomModerationControlsModel;
  readonly disabled?: boolean;
}

/**
 * ROOM-TOOLS-CODE-02B: the temporary shared-Code edit grant for one student
 * row, offered by the room only while the viewer may manage editor grants
 * and the shared workspace is open (server projection).
 */
export interface ClassroomParticipantCodeGrantAction {
  readonly granted: boolean;
  readonly limitReached: boolean;
  readonly maxEditors: number;
  readonly pending: boolean;
  readonly onGrant: () => void;
  readonly onRevoke: () => void;
}

interface ClassroomParticipantModerationMenuProps {
  readonly codeGrant?: ClassroomParticipantCodeGrantAction;
  /** Absent when the viewer only manages Code edit grants. */
  readonly controls?: ClassroomModerationControlsModel;
  readonly disabled?: boolean;
  readonly displayName: string;
  readonly isSelf: boolean;
  readonly participantKey: string;
}

/**
 * ROOM-COMPACT-05 Top Bar slice: the 28px Lock key and the server-owned
 * moderation status. Ending the room moved to the Dock's end-call control
 * (`ClassroomEndRoomDialog`), so this region only renders while the viewer
 * may lock the room or a moderation outcome needs announcing.
 */
export function ClassroomModerationControls({
  controls,
  disabled = false,
}: ClassroomModerationControlsProps) {
  const { t } = useI18n();
  const busy = moderationBusy(controls);
  const status = moderationStatus(controls);
  const lockLabel = t(
    controls.roomLocked ? "media.p407.unlockRoom" : "media.p407.lockRoom",
  );

  if (!controls.canLockRoom && status === null) {
    return null;
  }

  return (
    <section
      aria-label={t("media.p407.roomControls")}
      className="media-p407-room-controls"
    >
      {controls.canLockRoom && (
        <div className="media-p407-room-actions" role="group">
          {/*
            Inside the classroom stylesheet the label span is hidden visually
            (a round glass key) and the room tooltip shows it below; every
            other host keeps the visible text. The label always stays the
            accessible name.
          */}
          <Button
            aria-pressed={controls.roomLocked}
            data-tooltip={lockLabel}
            data-tooltip-side="bottom"
            disabled={disabled || busy}
            leadingIcon={controls.roomLocked ? <Unlock /> : <Lock />}
            onClick={() =>
              runModerationCommand(() =>
                controls.onSetRoomLocked(!controls.roomLocked),
              )
            }
            size="sm"
            variant={controls.roomLocked ? "primary" : "secondary"}
          >
            <span className="media-p405-button-label">{lockLabel}</span>
          </Button>
        </div>
      )}

      {status && (
        <p
          aria-atomic="true"
          aria-live={status.alert ? "assertive" : "polite"}
          className="media-p407-status"
          role={status.alert ? "alert" : "status"}
        >
          {t(status.key)}
        </p>
      )}
    </section>
  );
}

/**
 * ROOM-COMPACT-05: the "End this classroom?" confirmation, opened from the
 * Dock's end-call popover. It stays open (and blocks dismissal) while the
 * command or its provider effect is in flight, closes once the server
 * reports the room ended, and always hands focus back to `returnFocusRef`.
 */
export function ClassroomEndRoomDialog({
  controls,
  open,
  onOpenChange,
  returnFocusRef,
}: {
  readonly controls: ClassroomModerationControlsModel;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const busy = moderationBusy(controls);
  const endApplied =
    controls.providerEffect.status === "applied" &&
    controls.providerEffect.action === "end_room";

  useEffect(() => {
    if (!open || !endApplied) return undefined;
    const frame = globalThis.requestAnimationFrame(() => onOpenChange(false));
    return () => globalThis.cancelAnimationFrame(frame);
  }, [endApplied, onOpenChange, open]);

  return (
    <Dialog
      onOpenChange={(next) => {
        if (next) {
          onOpenChange(true);
        } else if (!busy) {
          onOpenChange(false);
          globalThis.requestAnimationFrame(() =>
            returnFocusRef.current?.focus(),
          );
        }
      }}
      open={open}
    >
      <DialogContent
        closeLabel={t("media.p407.cancel")}
        data-theme="dark"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus();
        }}
      >
        <DialogTitle>{t("media.p407.endTitle")}</DialogTitle>
        <DialogDescription>{t("media.p407.endDescription")}</DialogDescription>
        <DialogFooter>
          <DialogClose asChild>
            <Button disabled={busy} variant="secondary">
              {t("media.p407.cancel")}
            </Button>
          </DialogClose>
          <Button
            disabled={busy}
            loading={
              controls.mutationState.status === "submitting" &&
              controls.mutationState.action === "end_room"
            }
            loadingLabel={t("media.p407.submitting")}
            onClick={() => runModerationCommand(controls.onEndRoom)}
            variant="danger"
          >
            {t("media.p407.confirmEnd")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** True while a moderation command or its provider effect is in flight. */
// eslint-disable-next-line react-refresh/only-export-components -- Shared fail-closed busy rule; the Dock's End room option must disable exactly when the dialog does.
export function classroomModerationBusy(
  controls: ClassroomModerationControlsModel,
): boolean {
  return moderationBusy(controls);
}

export function ClassroomParticipantModerationMenu({
  codeGrant,
  controls,
  disabled = false,
  displayName,
  isSelf,
  participantKey,
}: ClassroomParticipantModerationMenuProps) {
  const { t } = useI18n();
  const trigger = useRef<HTMLButtonElement>(null);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const operations = controls?.participantOperations.find(
    (candidate) => candidate.participantKey === participantKey,
  );
  const busy = controls ? moderationBusy(controls) : false;
  const providerEffect = controls?.providerEffect;

  useEffect(() => {
    if (
      removeDialogOpen &&
      providerEffect?.status === "applied" &&
      providerEffect.action === "remove_participant" &&
      providerEffect.targetParticipantKey === participantKey
    ) {
      const frame = globalThis.requestAnimationFrame(() => {
        setRemoveDialogOpen(false);
      });
      return () => globalThis.cancelAnimationFrame(frame);
    }
    return undefined;
  }, [participantKey, providerEffect, removeDialogOpen]);

  const hasModeration = Boolean(
    operations &&
    (operations.canPromoteCoHost ||
      operations.canDemoteCoHost ||
      operations.canRemoteMute ||
      operations.canRemove),
  );
  if (isSelf || (!hasModeration && !codeGrant)) return null;
  const menuLabel = hasModeration
    ? t("media.p407.participantMenu", { name: displayName })
    : t("media.people.code.menu", { name: displayName });

  return (
    <span className="media-p407-participant-actions">
      <Menu modal={false}>
        <MenuTrigger asChild>
          {/*
            ROOM-PEOPLE-03: a ⋮ key that the People row reveals on hover or
            keyboard focus (always shown for touch and forced colors); its
            accessible name always carries the person's name.
          */}
          <IconButton
            className="media-p406-people-action media-p407-participant-trigger"
            data-people-tip={t("media.people.moreActions")}
            disabled={hasModeration && !codeGrant ? disabled || busy : false}
            label={menuLabel}
            ref={trigger}
            size="sm"
            variant="quiet"
          >
            <MoreVertical />
          </IconButton>
        </MenuTrigger>
        <MenuContent
          align="end"
          aria-label={menuLabel}
          className="media-p407-participant-menu"
          data-theme="dark"
        >
          {codeGrant ? (
            codeGrant.granted ? (
              <MenuItem
                disabled={codeGrant.pending}
                onSelect={codeGrant.onRevoke}
              >
                <PencilOff aria-hidden="true" />
                {t("media.people.code.revoke")}
              </MenuItem>
            ) : (
              <MenuItem
                disabled={codeGrant.pending || codeGrant.limitReached}
                onSelect={codeGrant.onGrant}
              >
                <Pencil aria-hidden="true" />
                <span className="media-p407-menu-item__text">
                  <span>{t("media.people.code.grant")}</span>
                  {codeGrant.limitReached ? (
                    <span className="media-p407-menu-item__hint">
                      {t("media.people.code.limitHint", {
                        max: codeGrant.maxEditors,
                      })}
                    </span>
                  ) : null}
                </span>
              </MenuItem>
            )
          ) : null}
          {codeGrant && hasModeration ? <MenuSeparator /> : null}
          {controls && operations?.canPromoteCoHost && (
            <MenuItem
              disabled={disabled || busy}
              onSelect={() =>
                runModerationCommand(() =>
                  controls.onPromoteCoHost(participantKey),
                )
              }
            >
              <UserPlus aria-hidden="true" />
              {t("media.p407.promoteCoHost")}
            </MenuItem>
          )}
          {controls && operations?.canDemoteCoHost && (
            <MenuItem
              disabled={disabled || busy}
              onSelect={() =>
                runModerationCommand(() =>
                  controls.onDemoteCoHost(participantKey),
                )
              }
            >
              <UserMinus aria-hidden="true" />
              {t("media.p407.demoteCoHost")}
            </MenuItem>
          )}
          {controls && operations?.canRemoteMute && (
            <MenuItem
              disabled={disabled || busy}
              onSelect={() =>
                runModerationCommand(() =>
                  controls.onRemoteMute(participantKey),
                )
              }
            >
              <MicOff aria-hidden="true" />
              {t("media.p407.remoteMute")}
            </MenuItem>
          )}
          {controls && operations?.canRemove && (
            <MenuItem
              disabled={disabled || busy}
              onSelect={() => setRemoveDialogOpen(true)}
              tone="danger"
            >
              <UserRoundX aria-hidden="true" />
              {t("media.p407.remove")}
            </MenuItem>
          )}
        </MenuContent>
      </Menu>

      <Dialog
        onOpenChange={(open) => {
          if (open) {
            setRemoveDialogOpen(true);
          } else if (!busy) {
            setRemoveDialogOpen(false);
            globalThis.requestAnimationFrame(() => trigger.current?.focus());
          }
        }}
        open={removeDialogOpen && controls !== undefined}
      >
        <DialogContent
          closeLabel={t("media.p407.cancel")}
          data-theme="dark"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <DialogTitle>{t("media.p407.removeTitle")}</DialogTitle>
          <DialogDescription>
            {t("media.p407.removeDescription", { name: displayName })}
          </DialogDescription>
          <DialogFooter>
            <DialogClose asChild>
              <Button disabled={busy} variant="secondary">
                {t("media.p407.cancel")}
              </Button>
            </DialogClose>
            <Button
              disabled={busy}
              loading={
                controls?.mutationState.status === "submitting" &&
                controls.mutationState.action === "remove_participant" &&
                controls.mutationState.targetParticipantKey === participantKey
              }
              loadingLabel={t("media.p407.submitting")}
              onClick={() => {
                if (!controls) return;
                runModerationCommand(() =>
                  controls.onRemoveParticipant(participantKey),
                );
              }}
              variant="danger"
            >
              {t("media.p407.confirmRemove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </span>
  );
}

function moderationBusy(controls: ClassroomModerationControlsModel): boolean {
  return (
    controls.mutationState.status === "submitting" ||
    controls.providerEffect.status === "pending"
  );
}

function moderationStatus(
  controls: ClassroomModerationControlsModel,
): { readonly alert: boolean; readonly key: TranslationKey } | null {
  if (controls.mutationState.status === "failed") {
    return {
      alert: true,
      key: moderationFailureKey(controls.mutationState.reason),
    };
  }
  if (controls.providerEffect.status === "reconcile_required") {
    return { alert: true, key: "media.p407.reconcileRequired" };
  }
  if (controls.providerEffect.status === "pending") {
    return { alert: false, key: "media.p407.providerPending" };
  }
  if (controls.providerEffect.status === "applied") {
    return { alert: false, key: "media.p407.applied" };
  }
  return null;
}

function moderationFailureKey(
  reason: ClassroomModerationFailureReason,
): TranslationKey {
  return `media.p407.error.${reason}` as TranslationKey;
}

function runModerationCommand(command: () => Promise<void>): void {
  void command().catch(() => undefined);
}
