import { APIRequestError } from "@tutorhub/api-client";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Skeleton,
} from "@tutorhub/ui";
import { Search, X } from "lucide-react";
import {
  useId,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { foldSearchText } from "../../app/conversationPreferences";
import { useConversations } from "../../app/conversations";
import { useI18n } from "../../app/i18n";
import {
  INSTANT_CLASS_DURATIONS,
  INSTANT_CLASS_TITLE_MAX,
  cardErrorKey,
  contactCandidates,
  type InstantClassDuration,
} from "./composerCards";

/**
 * MSG-COMPOSER-TOOLS-01: pick one contact, preview the card, send it. The
 * server re-checks that the contact is shareable.
 */
export function ContactCardDialog({
  actorID,
  avatar,
  onClose,
  onSend,
  tenantID,
}: {
  actorID: string;
  avatar: (name: string, seed: string) => ReactNode;
  onClose: () => void;
  onSend: (userID: string) => Promise<void>;
  tenantID: string;
}) {
  const { language, t } = useI18n();
  const conversations = useConversations(tenantID);
  const [query, setQuery] = useState("");
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchID = useId();
  const groupName = useId();
  const locale = language === "vi" ? "vi-VN" : "en-US";
  const candidates = useMemo(
    () =>
      contactCandidates(
        (conversations.data?.pages ?? []).flatMap((page) => page.items),
        actorID,
        t("conversations.contactCardYou"),
        locale,
      ),
    [actorID, conversations.data?.pages, locale, t],
  );
  const folded = foldSearchText(query);
  const visible = folded
    ? candidates.filter((item) => foldSearchText(item.name).includes(folded))
    : candidates;
  const selected = candidates.find((item) => item.userID === selectedID);
  const forbidden =
    conversations.error instanceof APIRequestError &&
    conversations.error.status === 403;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || pending) return;
    setPending(true);
    setError(null);
    try {
      await onSend(selected.userID);
    } catch (reason) {
      setError(t(cardErrorKey(reason)));
      setPending(false);
    }
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      open
    >
      <DialogContent
        className="conversations-dialog composer-card-dialog"
        closeLabel={t("conversations.screenshotClose")}
      >
        <DialogTitle>{t("conversations.contactCardDialogTitle")}</DialogTitle>
        <DialogDescription>
          {t("conversations.contactCardDialogDescription")}
        </DialogDescription>
        <form className="composer-card-dialog__form" onSubmit={submit}>
          <label className="visually-hidden" htmlFor={searchID}>
            {t("conversations.contactCardSearch")}
          </label>
          <div className="composer-card-dialog__search">
            <Search aria-hidden="true" />
            <input
              autoComplete="off"
              id={searchID}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("conversations.contactCardSearch")}
              type="search"
              value={query}
            />
          </div>
          <fieldset className="composer-card-dialog__options">
            <legend className="visually-hidden">
              {t("conversations.contactCardDialogTitle")}
            </legend>
            {visible.map((item) => (
              <label className="composer-card-option" key={item.userID}>
                <input
                  checked={selectedID === item.userID}
                  name={groupName}
                  onChange={() => setSelectedID(item.userID)}
                  type="radio"
                  value={item.userID}
                />
                {avatar(item.name, item.userID)}
                <span className="composer-card-option__name">
                  {item.name}
                  {item.self &&
                    item.name !== t("conversations.contactCardYou") && (
                      <span className="composer-card-option__suffix">
                        {" "}
                        {t("conversations.contactCardYouSuffix")}
                      </span>
                    )}
                </span>
              </label>
            ))}
            {conversations.isPending && (
              <div aria-hidden="true" className="composer-card-dialog__loading">
                <Skeleton height={36} />
                <Skeleton height={36} />
              </div>
            )}
            {visible.length === 0 && (
              <p className="composer-card-dialog__empty">
                {t("conversations.contactCardNoMatch")}
              </p>
            )}
          </fieldset>
          {conversations.isPending && (
            <p className="visually-hidden" role="status">
              {t("conversations.contactCardLoading")}
            </p>
          )}
          {conversations.isError && (
            <p className="composer-card-dialog__notice" role="alert">
              <span>
                {forbidden
                  ? t("conversations.cardErrorForbidden")
                  : t("conversations.contactCardListError")}
              </span>
              {!forbidden && (
                <button
                  className="conversation-composer__notice-action"
                  onClick={() => void conversations.refetch()}
                  type="button"
                >
                  {t("conversations.contactCardRetry")}
                </button>
              )}
            </p>
          )}
          {conversations.hasNextPage && (
            <Button
              loading={conversations.isFetchingNextPage}
              onClick={() => void conversations.fetchNextPage()}
              size="sm"
              variant="quiet"
            >
              {t("conversations.contactCardMore")}
            </Button>
          )}
          <p className="composer-card-dialog__hint">
            {t("conversations.contactCardHint")}
          </p>
          {selected && (
            <div className="composer-card-dialog__preview">
              <span className="composer-card-dialog__preview-label">
                {t("conversations.contactCardPreviewLabel")}
              </span>
              <p className="conversation-card__person">
                {avatar(selected.name, selected.userID)}
                <strong>{selected.name}</strong>
              </p>
            </div>
          )}
          {error && (
            <p className="conversations-page__form-error" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button disabled={pending} onClick={onClose} variant="secondary">
              {t("conversations.instantClassCancel")}
            </Button>
            <Button
              disabled={!selected}
              loading={pending}
              loadingLabel={t("conversations.contactCardSending")}
              type="submit"
            >
              {t("conversations.contactCardSend")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * MSG-COMPOSER-TOOLS-01: name and duration of an instant class. Everyone in
 * the conversation is invited; the host admits them from the lobby.
 */
export function InstantClassDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (input: {
    durationMinutes: InstantClassDuration;
    title: string;
  }) => Promise<void>;
}) {
  const { t } = useI18n();
  const [duration, setDuration] = useState<InstantClassDuration>(15);
  const [customTitle, setCustomTitle] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const titleID = useId();
  const errorID = useId();
  const groupName = useId();
  const defaultTitle = t("conversations.instantClassDefaultTitle", {
    minutes: duration,
  });
  const title = customTitle ?? defaultTitle;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const trimmed = title.trim();
    if (!trimmed || [...trimmed].length > INSTANT_CLASS_TITLE_MAX) {
      setInvalid(true);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onCreate({ durationMinutes: duration, title: trimmed });
    } catch (reason) {
      setError(t(cardErrorKey(reason)));
      setPending(false);
    }
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      open
    >
      <DialogContent
        className="conversations-dialog composer-card-dialog"
        closeLabel={t("conversations.screenshotClose")}
      >
        <DialogTitle>
          {t("conversations.instantClassDialogTitle", { minutes: duration })}
        </DialogTitle>
        <DialogDescription>
          {t("conversations.instantClassDialogDescription")}
        </DialogDescription>
        <form
          className="composer-card-dialog__form"
          noValidate
          onSubmit={submit}
        >
          <label className="composer-card-dialog__label" htmlFor={titleID}>
            {t("conversations.instantClassTitleLabel")}
          </label>
          <div className="composer-card-dialog__field">
            <input
              aria-describedby={invalid ? errorID : undefined}
              aria-invalid={invalid || undefined}
              id={titleID}
              maxLength={INSTANT_CLASS_TITLE_MAX}
              onChange={(event) => {
                setCustomTitle(event.target.value);
                setInvalid(false);
              }}
              required
              type="text"
              value={title}
            />
            {title && (
              <button
                aria-label={t("conversations.instantClassTitleClear")}
                className="conversation-composer__chip-close"
                onClick={() => setCustomTitle("")}
                type="button"
              >
                <X aria-hidden="true" />
              </button>
            )}
          </div>
          {invalid && (
            <p
              className="conversations-page__form-error"
              id={errorID}
              role="alert"
            >
              {t("conversations.instantClassTitleRequired")}
            </p>
          )}
          <fieldset className="composer-card-dialog__durations">
            <legend className="composer-card-dialog__label">
              {t("conversations.instantClassDuration")}
            </legend>
            {INSTANT_CLASS_DURATIONS.map((minutes) => (
              <label className="composer-duration" key={minutes}>
                <input
                  checked={duration === minutes}
                  name={groupName}
                  onChange={() => setDuration(minutes)}
                  type="radio"
                  value={minutes}
                />
                <span>
                  {t("conversations.instantClassMinutes", { minutes })}
                </span>
              </label>
            ))}
          </fieldset>
          {error && (
            <p className="conversations-page__form-error" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button disabled={pending} onClick={onClose} variant="secondary">
              {t("conversations.instantClassCancel")}
            </Button>
            <Button
              loading={pending}
              loadingLabel={t("conversations.instantClassCreating")}
              type="submit"
            >
              {t("conversations.instantClassCreate")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
