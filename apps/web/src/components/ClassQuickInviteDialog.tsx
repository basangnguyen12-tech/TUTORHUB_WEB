import { APIRequestError, type ClassroomClass } from "@tutorhub/api-client";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Select,
} from "@tutorhub/ui";
import { Copy, Link2, Mail, UserPlus } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";
import {
  useCreateClassInviteCode,
  useDirectClassEnrollment,
} from "../app/classEnrollments";
import { useI18n, type TranslationKey } from "../app/i18n";
import type { TenantOperationAvailability } from "../app/tenantCapabilities";
import { TenantOperationNotice } from "./TenantOperationNotice";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function inviteErrorKey(error: Error | null): TranslationKey {
  if (error instanceof APIRequestError) {
    const code = error.problem?.code;
    if (code === "feature_disabled") {
      return "capabilities.reasonFeatureDisabled";
    }
    if (code === "quota_exceeded") {
      return error.status === 429
        ? "capabilities.reasonRateLimited"
        : "capabilities.reasonQuotaExhausted";
    }
    const byStatus: Partial<Record<number, TranslationKey>> = {
      403: "classEnrollment.mutationForbidden",
      404: "classEnrollment.mutationNotFound",
      409: "classEnrollment.mutationConflict",
      429: "classEnrollment.mutationRateLimited",
    };
    const key = byStatus[error.status];
    if (key) {
      return key;
    }
  }
  return "classEnrollment.mutationError";
}

interface ClassQuickInviteDialogProps {
  classroom: ClassroomClass;
  createInviteAvailability: TenantOperationAvailability;
  onOpenChange: (open: boolean) => void;
  onRetryCapabilities?: () => void;
  open: boolean;
  tenantID: string;
}

/**
 * CLASS-CLASSIN-UI-01 (ClassIn ref-06): quick "Invite members" dialog with a
 * direct e-mail enrollment bar and a one-time invite link card. The join URL
 * is shown once and only kept in this component's state.
 */
export default function ClassQuickInviteDialog({
  classroom,
  createInviteAvailability,
  onOpenChange,
  onRetryCapabilities,
  open,
  tenantID,
}: ClassQuickInviteDialogProps) {
  const { t } = useI18n();
  const emailID = useId();
  const usageID = useId();
  const directEnrollment = useDirectClassEnrollment(tenantID);
  const createInviteCode = useCreateClassInviteCode();
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState(false);
  const [enrolled, setEnrolled] = useState(false);
  const [expiresInSeconds, setExpiresInSeconds] = useState("604800");
  const [usageLimit, setUsageLimit] = useState("30");
  const [usageError, setUsageError] = useState(false);
  const [oneTimeURL, setOneTimeURL] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"copied" | "manual" | null>(
    null,
  );
  const linkInput = useRef<HTMLInputElement>(null);
  const active = classroom.status === "active";
  const pending = directEnrollment.isPending || createInviteCode.isPending;

  const reset = () => {
    setEmail("");
    setEmailError(false);
    setEnrolled(false);
    setExpiresInSeconds("604800");
    setUsageLimit("30");
    setUsageError(false);
    setOneTimeURL(null);
    setCopyStatus(null);
    directEnrollment.reset();
    createInviteCode.reset();
  };

  const enroll = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = email.trim().toLowerCase();
    if (normalized.length > 320 || !emailPattern.test(normalized)) {
      setEmailError(true);
      return;
    }
    setEmailError(false);
    setEnrolled(false);
    directEnrollment.mutate(
      { classID: classroom.id, memberEmail: normalized },
      {
        onSuccess: () => {
          setEmail("");
          setEnrolled(true);
        },
      },
    );
  };

  const createLink = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!createInviteAvailability.available) {
      return;
    }
    const limit = Number(usageLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      setUsageError(true);
      return;
    }
    setUsageError(false);
    setCopyStatus(null);
    try {
      const response = await createInviteCode.mutateAsync({
        classID: classroom.id,
        input: {
          expires_in_seconds: Number(expiresInSeconds),
          usage_limit: limit,
        },
        tenantID,
      });
      setOneTimeURL(response.join_url);
      createInviteCode.reset();
    } catch {
      // The structured error is rendered below the card.
    }
  };

  const copy = async () => {
    if (!oneTimeURL) {
      return;
    }
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(oneTimeURL);
      setCopyStatus("copied");
    } catch {
      linkInput.current?.focus();
      linkInput.current?.select();
      setCopyStatus("manual");
    }
  };

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (pending) {
          return;
        }
        onOpenChange(nextOpen);
        if (!nextOpen) {
          reset();
        }
      }}
      open={open}
    >
      <DialogContent
        className="classin-dialog classin-invite-dialog"
        closeLabel={t("classInvite.close")}
      >
        <DialogTitle>{t("classInvite.title")}</DialogTitle>
        <DialogDescription>
          {t("classInvite.description", { title: classroom.title })}
        </DialogDescription>

        {!active && (
          <p className="classin-inline-note">{t("classInvite.inactive")}</p>
        )}

        <form className="classin-invite-email" onSubmit={enroll}>
          <div
            className="classin-pill-bar"
            data-invalid={emailError ? "true" : undefined}
          >
            <Mail aria-hidden="true" className="classin-pill-bar__icon" />
            <label className="visually-hidden" htmlFor={emailID}>
              {t("classEnrollment.emailLabel")}
            </label>
            <input
              aria-describedby={emailError ? `${emailID}-error` : undefined}
              aria-invalid={emailError || undefined}
              autoCapitalize="none"
              autoComplete="email"
              className="classin-pill-bar__input"
              disabled={!active}
              id={emailID}
              maxLength={320}
              onChange={(event) => {
                setEmail(event.target.value);
                setEmailError(false);
                setEnrolled(false);
              }}
              placeholder={t("classEnrollment.emailLabel")}
              required
              spellCheck={false}
              type="email"
              value={email}
            />
            <Button
              className="classin-pill-bar__submit"
              disabled={!active}
              leadingIcon={<UserPlus />}
              loading={directEnrollment.isPending}
              loadingLabel={t("classEnrollment.enrolling")}
              size="sm"
              type="submit"
            >
              {t("classInvite.add")}
            </Button>
          </div>
          {emailError && (
            <p
              className="classin-form-error"
              id={`${emailID}-error`}
              role="alert"
            >
              {t("classEnrollment.emailValidation")}
            </p>
          )}
          {directEnrollment.isError && (
            <p className="classin-form-error" role="alert">
              {t(inviteErrorKey(directEnrollment.error))}
            </p>
          )}
          {enrolled && (
            <p className="classin-form-success" role="status">
              {t("classEnrollment.enrollSuccess")}
            </p>
          )}
        </form>

        <section
          aria-labelledby={`${usageID}-title`}
          className="classin-action-card"
        >
          <span aria-hidden="true" className="classin-action-card__icon">
            <Link2 />
          </span>
          <div className="classin-action-card__body">
            <h3 id={`${usageID}-title`}>{t("classInvite.linkTitle")}</h3>
            <p>{t("classInvite.linkDescription")}</p>
            {active && (
              <TenantOperationNotice
                availability={createInviteAvailability}
                label={t("capabilities.operationCreateClassInvite")}
                onRetry={onRetryCapabilities}
              />
            )}
            {oneTimeURL ? (
              <div className="classin-invite-link">
                <p className="classin-form-success" role="status">
                  {t("classEnrollment.createSuccess")}
                </p>
                <label
                  className="classin-field-label"
                  htmlFor={`${usageID}-link`}
                >
                  {t("classEnrollment.linkLabel")}
                </label>
                <div className="classin-pill-bar">
                  <input
                    className="classin-pill-bar__input"
                    id={`${usageID}-link`}
                    readOnly
                    ref={linkInput}
                    value={oneTimeURL}
                  />
                  <Button
                    className="classin-pill-bar__submit"
                    leadingIcon={<Copy />}
                    onClick={() => void copy()}
                    size="sm"
                  >
                    {t("classEnrollment.copyAction")}
                  </Button>
                </div>
                {copyStatus && (
                  <p className="classin-form-success" role="status">
                    {t(
                      copyStatus === "copied"
                        ? "classEnrollment.copySuccess"
                        : "classEnrollment.copyManual",
                    )}
                  </p>
                )}
                <Button
                  className="classin-text-button"
                  onClick={() => {
                    setOneTimeURL(null);
                    setCopyStatus(null);
                  }}
                  size="sm"
                  variant="quiet"
                >
                  {t("classInvite.newLink")}
                </Button>
              </div>
            ) : (
              <form
                className="classin-invite-link__form"
                onSubmit={(event) => void createLink(event)}
              >
                <div className="classin-invite-link__fields">
                  <div>
                    <span aria-hidden="true" className="classin-field-label">
                      {t("classEnrollment.ttlLabel")}
                    </span>
                    <Select
                      ariaLabel={t("classEnrollment.ttlLabel")}
                      disabled={!active}
                      onValueChange={setExpiresInSeconds}
                      options={[
                        {
                          label: t("classEnrollment.ttlOneDay"),
                          value: "86400",
                        },
                        {
                          label: t("classEnrollment.ttlSevenDays"),
                          value: "604800",
                        },
                        {
                          label: t("classEnrollment.ttlThirtyDays"),
                          value: "2592000",
                        },
                      ]}
                      value={expiresInSeconds}
                    />
                  </div>
                  <div>
                    <label className="classin-field-label" htmlFor={usageID}>
                      {t("classEnrollment.usageLabel")}
                    </label>
                    <input
                      aria-describedby={
                        usageError ? `${usageID}-error` : undefined
                      }
                      aria-invalid={usageError || undefined}
                      className="classin-input"
                      disabled={!active}
                      id={usageID}
                      inputMode="numeric"
                      max={1000}
                      min={1}
                      onChange={(event) => setUsageLimit(event.target.value)}
                      required
                      type="number"
                      value={usageLimit}
                    />
                  </div>
                </div>
                {usageError && (
                  <p
                    className="classin-form-error"
                    id={`${usageID}-error`}
                    role="alert"
                  >
                    {t("classEnrollment.usageValidation")}
                  </p>
                )}
                {createInviteCode.isError && (
                  <p className="classin-form-error" role="alert">
                    {t(inviteErrorKey(createInviteCode.error))}
                  </p>
                )}
                <Button
                  className="classin-cta"
                  disabled={!active || !createInviteAvailability.available}
                  leadingIcon={<Link2 />}
                  loading={createInviteCode.isPending}
                  loadingLabel={t("classEnrollment.creating")}
                  size="sm"
                  type="submit"
                >
                  {t("classInvite.createLink")}
                </Button>
              </form>
            )}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
