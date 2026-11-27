import { APIRequestError, type ClassroomClass } from "@tutorhub/api-client";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@tutorhub/ui";
import { KeyRound, Search, UserPlus } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";
import { parseClassInvitationToken } from "../app/classInvitationToken";
import { useJoinClassInvitation } from "../app/classEnrollments";
import { useI18n, type TranslationKey } from "../app/i18n";
import type { TenantOperationAvailability } from "../app/tenantCapabilities";

function joinErrorKey(error: Error | null): TranslationKey {
  if (
    error instanceof APIRequestError &&
    error.problem?.code === "feature_disabled"
  ) {
    return "capabilities.reasonFeatureDisabled";
  }
  if (
    error instanceof APIRequestError &&
    error.problem?.code === "quota_exceeded"
  ) {
    return error.status === 429
      ? "capabilities.reasonRateLimited"
      : "capabilities.reasonQuotaExhausted";
  }
  if (error instanceof APIRequestError && error.status === 401) {
    return "classInvitation.sessionExpired";
  }
  if (error instanceof APIRequestError && error.status === 403) {
    return "classInvitation.forbidden";
  }
  if (error instanceof APIRequestError && error.status === 429) {
    return "classInvitation.rateLimited";
  }
  if (
    error instanceof APIRequestError &&
    [400, 404, 409, 410].includes(error.status)
  ) {
    return "classInvitation.unavailableDescription";
  }
  return "classInvitation.joinError";
}

interface ClassJoinDialogProps {
  availability: TenantOperationAvailability;
  onJoined: (classroom: ClassroomClass, tenantID: string) => void;
  /** Controlled mode (e.g. opened from the quick-actions menu). */
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  /** Render the stand-alone "Join with a code" trigger button. */
  showTrigger?: boolean;
  tenantID: string;
}

/**
 * CLASS-CLASSIN-UI-01 (ClassIn ref-05): a white dialog with a pill search bar.
 * The invitation token only lives in a ref and the POST body; it never
 * reaches the URL, web storage or the query/mutation caches.
 */
export function ClassJoinDialog({
  availability,
  onJoined,
  onOpenChange,
  open: controlledOpen,
  showTrigger = true,
  tenantID,
}: ClassJoinDialogProps) {
  const { t } = useI18n();
  const inputID = useId();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const [input, setInput] = useState("");
  const [validationError, setValidationError] = useState(false);
  const token = useRef<string | null>(null);
  const joinInvitation = useJoinClassInvitation(() => token.current, tenantID);
  const errorMessage = validationError
    ? t("classInvitation.tokenValidation")
    : joinInvitation.isError
      ? t(joinErrorKey(joinInvitation.error))
      : undefined;
  const hintID = `${inputID}-hint`;
  const errorID = `${inputID}-error`;

  const setOpen = (nextOpen: boolean) => {
    if (controlledOpen === undefined) {
      setUncontrolledOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  };

  const reset = () => {
    token.current = null;
    setInput("");
    setValidationError(false);
    joinInvitation.reset();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!availability.available) {
      return;
    }
    const parsedToken = input
      ? parseClassInvitationToken(input)
      : token.current;
    if (!parsedToken) {
      setValidationError(true);
      return;
    }

    token.current = parsedToken;
    setInput("");
    setValidationError(false);
    try {
      const result = await joinInvitation.mutateAsync();
      token.current = null;
      onJoined(result.classroom, tenantID);
      setOpen(false);
      reset();
    } catch {
      // Keep only the in-memory ref so a transient failure can be retried.
    }
  };

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (joinInvitation.isPending) {
          return;
        }
        setOpen(nextOpen);
        if (!nextOpen) {
          reset();
        }
      }}
      open={open}
    >
      {showTrigger && (
        <DialogTrigger asChild>
          <Button
            className="classin-secondary-pill"
            disabled={!availability.available}
            leadingIcon={<UserPlus />}
            variant="secondary"
          >
            {t("classInvitation.openDialog")}
          </Button>
        </DialogTrigger>
      )}
      <DialogContent
        className="classin-dialog classin-join-dialog"
        closeLabel={t("classInvitation.closeDialog")}
      >
        <DialogTitle>{t("classInvitation.title")}</DialogTitle>
        <DialogDescription>
          {t("classInvitation.description")}
        </DialogDescription>
        <form
          className="classin-join-form"
          onSubmit={(event) => void submit(event)}
        >
          <div
            className="classin-pill-bar"
            data-invalid={errorMessage ? "true" : undefined}
          >
            <Search aria-hidden="true" className="classin-pill-bar__icon" />
            <label className="visually-hidden" htmlFor={inputID}>
              {t("classInvitation.tokenLabel")}
            </label>
            <input
              aria-describedby={errorMessage ? `${errorID} ${hintID}` : hintID}
              aria-invalid={errorMessage ? true : undefined}
              autoCapitalize="none"
              autoComplete="off"
              className="classin-pill-bar__input"
              id={inputID}
              maxLength={2048}
              onChange={(event) => {
                token.current = null;
                setInput(event.target.value);
                setValidationError(false);
                joinInvitation.reset();
              }}
              placeholder={t("classInvitation.tokenPlaceholder")}
              required={!joinInvitation.isError}
              spellCheck={false}
              type="password"
              value={input}
            />
            <Button
              className="classin-pill-bar__submit"
              disabled={!availability.available}
              loading={joinInvitation.isPending}
              loadingLabel={t("classInvitation.joining")}
              size="sm"
              type="submit"
            >
              {joinInvitation.isError
                ? t("classInvitation.retryJoin")
                : t("classInvitation.joinAction")}
            </Button>
          </div>
          {errorMessage && (
            <p className="classin-form-error" id={errorID} role="alert">
              {errorMessage}
            </p>
          )}
          <div className="classin-join-form__guide">
            <span aria-hidden="true" className="classin-join-form__glyph">
              <KeyRound />
            </span>
            <p id={hintID}>{t("classInvitation.tokenHint")}</p>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
