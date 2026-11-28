import { Button } from "@tutorhub/ui";
import { ArrowRight, Contact, Presentation, UserX } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate } from "react-router";
import { useCreateDirectConversation } from "../../app/conversations";
import { useI18n } from "../../app/i18n";
import { MediaSpaceNotReadyError } from "../../app/mediaSpaces";
import { ChatStickerView } from "../../features/media/ChatExpressionPicker";
import {
  cardErrorKey,
  formatCountdown,
  openInstantClassSpace,
  useServerCountdown,
  type ContactCardEmbed,
  type InstantClassEmbed,
  type MessageEmbed,
} from "./composerCards";

/**
 * MSG-COMPOSER-TOOLS-01: renders the server-resolved card of a message. The
 * card is built only from `message.embed`, never from text. MSG-STICKER-03:
 * a sticker renders as borderless artwork from the server-projected asset.
 */
export function MessageEmbedCard({
  actorID,
  avatar,
  embed,
  messageID,
  tenantID,
}: {
  actorID: string;
  /** Avatar for a contact card (passed in to avoid a module cycle). */
  avatar: (name: string, seed: string) => ReactNode;
  embed: MessageEmbed;
  messageID: string;
  tenantID: string;
}) {
  if (embed.kind === "sticker") {
    return <ChatStickerView embed={embed} size={140} />;
  }
  return embed.kind === "contact_card" ? (
    <ContactCardView
      actorID={actorID}
      avatar={avatar}
      embed={embed}
      messageID={messageID}
      tenantID={tenantID}
    />
  ) : (
    <InstantClassView embed={embed} tenantID={tenantID} />
  );
}

function ContactCardView({
  actorID,
  avatar,
  embed,
  messageID,
  tenantID,
}: {
  actorID: string;
  avatar: (name: string, seed: string) => ReactNode;
  embed: ContactCardEmbed;
  messageID: string;
  tenantID: string;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const createDirect = useCreateDirectConversation(tenantID);
  const [error, setError] = useState<string | null>(null);
  const name = embed.available ? embed.display_name : undefined;
  const userID = embed.available ? embed.user_id : undefined;

  if (!name || !userID) {
    return (
      <section
        aria-label={t("conversations.contactCardUnavailable")}
        className="conversation-card conversation-card--muted"
      >
        <span className="conversation-card__eyebrow">
          <Contact aria-hidden="true" />
          {t("conversations.contactCardEyebrow")}
        </span>
        <p className="conversation-card__person">
          <UserX aria-hidden="true" className="conversation-card__muted-icon" />
          {t("conversations.contactCardUnavailable")}
        </p>
      </section>
    );
  }

  const self = userID === actorID;
  return (
    <section
      aria-label={t("conversations.contactCardLabel", { name })}
      className="conversation-card"
    >
      <span className="conversation-card__eyebrow">
        <Contact aria-hidden="true" />
        {t("conversations.contactCardEyebrow")}
      </span>
      <p className="conversation-card__person">
        {avatar(name, userID)}
        <strong>{name}</strong>
      </p>
      {!self && (
        <Button
          className="conversation-card__action"
          loading={createDirect.isPending}
          loadingLabel={t("conversations.contactCardOpening")}
          onClick={() => {
            setError(null);
            createDirect.mutate(
              { source_message_id: messageID },
              {
                onError: (reason) => setError(t(cardErrorKey(reason))),
                onSuccess: (conversation) =>
                  navigate(`/app/messages/${conversation.id}`),
              },
            );
          }}
          size="sm"
          variant="secondary"
        >
          {t("conversations.contactCardMessage")}
        </Button>
      )}
      {error && (
        <p className="conversation-card__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

const ANNOUNCED_SECONDS = [300, 60] as const;

function InstantClassView({
  embed,
  tenantID,
}: {
  embed: InstantClassEmbed;
  tenantID: string;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const remaining = useServerCountdown(embed.remaining_seconds);
  const [announcement, setAnnouncement] = useState("");
  const [opening, setOpening] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const previous = useRef(remaining);
  const openStatus = embed.status === "scheduled" || embed.status === "open";
  const live = openStatus && remaining > 0;
  const prejoinPath = `/app/media/spaces/${embed.media_space_id}/prejoin`;

  const onJoinClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      embed.status === "open" ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.altKey ||
      event.ctrlKey ||
      event.shiftKey
    ) {
      return;
    }
    event.preventDefault();
    if (opening) return;
    setOpening(true);
    setJoinError(null);
    void openInstantClassSpace(tenantID, embed.media_space_id)
      .then(() => navigate(prejoinPath))
      .catch((error: unknown) => {
        setJoinError(
          t(
            error instanceof MediaSpaceNotReadyError
              ? "media.launch.notReady"
              : "media.launch.error",
          ),
        );
      })
      .finally(() => setOpening(false));
  };

  useEffect(() => {
    const before = previous.current;
    previous.current = remaining;
    if (!openStatus || before === remaining) return;
    // Announce milestones only, never every second.
    if (remaining === 0 && before > 0) {
      setAnnouncement(t("conversations.instantClassEndedAnnouncement"));
      return;
    }
    const milestone = ANNOUNCED_SECONDS.find(
      (value) => before > value && remaining <= value,
    );
    if (milestone) {
      setAnnouncement(
        t("conversations.instantClassMinutesLeft", {
          minutes: Math.round(milestone / 60),
        }),
      );
    }
  }, [openStatus, remaining, t]);

  const status = !openStatus
    ? embed.status === "cancelled"
      ? t("conversations.instantClassCancelled")
      : t("conversations.instantClassEnded")
    : remaining <= 0
      ? t("conversations.instantClassTimeUp")
      : embed.status === "open"
        ? t("conversations.instantClassOpen")
        : t("conversations.instantClassScheduled");

  return (
    <section
      aria-label={t("conversations.instantClassLabel", { title: embed.title })}
      className={
        live
          ? "conversation-card"
          : "conversation-card conversation-card--muted"
      }
    >
      <span className="conversation-card__eyebrow">
        <Presentation aria-hidden="true" />
        {t("conversations.instantClassEyebrow")}
      </span>
      <strong className="conversation-card__title">{embed.title}</strong>
      <dl className="conversation-card__facts">
        <div>
          <dt>{t("conversations.instantClassCountdown")}</dt>
          <dd>
            <time
              className="conversation-card__countdown"
              dateTime={`PT${Math.max(0, remaining)}S`}
            >
              {formatCountdown(remaining)}
            </time>
          </dd>
        </div>
        <div>
          <dt>{t("conversations.instantClassStatus")}</dt>
          <dd>{status}</dd>
        </div>
      </dl>
      {live && embed.viewer_can_join ? (
        <Link
          aria-busy={opening || undefined}
          className="th-button th-button--primary th-button--sm conversation-card__join"
          onClick={onJoinClick}
          to={prejoinPath}
        >
          <span>
            {opening
              ? t("media.launch.opening")
              : t("conversations.instantClassJoin")}
          </span>
          <ArrowRight aria-hidden="true" />
        </Link>
      ) : (
        <p className="conversation-card__note">
          {live
            ? t("conversations.instantClassNotInvited")
            : t("conversations.instantClassClosedNote")}
        </p>
      )}
      {joinError && (
        <p className="conversation-card__error" role="alert">
          {joinError}
        </p>
      )}
      <p aria-live="polite" className="visually-hidden">
        {announcement}
      </p>
    </section>
  );
}
