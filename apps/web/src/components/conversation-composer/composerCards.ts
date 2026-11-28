/**
 * MSG-COMPOSER-TOOLS-01: helpers for server-authored cards (contact card,
 * instant class). Cards are only ever rendered from `message.embed`, which the
 * server resolves per reader; message text never produces an actionable card.
 */
import {
  APIRequestError,
  createMediaSpace,
  getMediaSpace,
  type Conversation,
  rotateCSRFToken,
  startMediaSpace,
  type ActiveMessage,
  type CreateMediaSpaceRequest,
  type MediaSpace,
  type SendMessageRequest,
} from "@tutorhub/api-client";
import { useEffect, useState } from "react";
import type { useI18n } from "../../app/i18n";
import { MediaSpaceNotReadyError } from "../../app/mediaSpaces";

export type MessageEmbed = NonNullable<ActiveMessage["embed"]>;
export type ContactCardEmbed = Extract<MessageEmbed, { kind: "contact_card" }>;
export type InstantClassEmbed = Extract<
  MessageEmbed,
  { kind: "instant_class" }
>;
/** MSG-STICKER-03 (ADR-0047): a catalog sticker, resolved per reader. */
export type StickerMessageEmbed = Extract<MessageEmbed, { kind: "sticker" }>;
export type MessageEmbedInput = NonNullable<SendMessageRequest["embed"]>;

export const INSTANT_CLASS_DURATIONS = [15, 30, 45, 60] as const;
export type InstantClassDuration = (typeof INSTANT_CLASS_DURATIONS)[number];
export const INSTANT_CLASS_TITLE_MAX = 200;

function getApiBaseUrl() {
  return import.meta.env.VITE_API_BASE_URL ?? "/api";
}

/** The browser IANA zone; the API rejects the literal `local`. */
export function browserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && zone !== "local" ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Creates (or, with the same key, replays) the instant media space behind a
 * temporary class and starts its live room immediately so people clicking
 * "Join class" enter prejoin/lobby instead of "room not open".
 */
export async function createInstantClassSpace(
  tenantID: string,
  input: { durationMinutes: number; idempotencyKey: string; title: string },
): Promise<MediaSpace> {
  const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
  const request: CreateMediaSpaceRequest = {
    idempotency_key: input.idempotencyKey,
    source: {
      duration_minutes: input.durationMinutes,
      kind: "instant",
      timezone: browserTimeZone(),
      title: input.title,
    },
  };
  const space = await createMediaSpace(tenantID, request, csrf.csrf_token, {
    baseUrl: getApiBaseUrl(),
  });
  if (
    space.status === "scheduled" &&
    space.viewer_operations?.can_start === true
  ) {
    const startCsrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
    return startMediaSpace(
      tenantID,
      space.id,
      {
        expected_version: space.version,
        idempotency_key: `${input.idempotencyKey}:start`,
        reason_code: "product_launch",
      },
      startCsrf.csrf_token,
      { baseUrl: getApiBaseUrl() },
    );
  }
  return space;
}

/**
 * Ensures a scheduled instant-class space is open before navigating to prejoin.
 * If the viewer owns/can start the space, starts it on the spot; otherwise
 * raises `MediaSpaceNotReadyError` so the card shows a clear inline notice.
 */
export async function openInstantClassSpace(
  tenantID: string,
  spaceID: string,
): Promise<MediaSpace> {
  const space = await getMediaSpace(tenantID, spaceID, {
    baseUrl: getApiBaseUrl(),
  });
  if (space.status === "open") {
    return space;
  }
  if (
    space.status !== "scheduled" ||
    space.viewer_operations?.can_start !== true
  ) {
    throw new MediaSpaceNotReadyError("The media space is not open.");
  }
  const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
  return startMediaSpace(
    tenantID,
    space.id,
    {
      expected_version: space.version,
      idempotency_key: crypto.randomUUID(),
      reason_code: "product_launch",
    },
    csrf.csrf_token,
    { baseUrl: getApiBaseUrl() },
  );
}

/** `mm:ss` below an hour, `h:mm:ss` above. */
export function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(rest)}`
    : `${pad(minutes)}:${pad(rest)}`;
}

function monotonicNow() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Counts down from a server-measured `remaining_seconds` with the monotonic
 * clock, so a wrong device clock cannot shorten or extend the class.
 */
export function useServerCountdown(remainingSeconds: number): number {
  const [state, setState] = useState(() => ({
    baseline: monotonicNow(),
    source: remainingSeconds,
    value: Math.max(0, remainingSeconds),
  }));
  let current = state;
  if (state.source !== remainingSeconds) {
    // A fresh server value restarts the countdown from now.
    current = {
      baseline: monotonicNow(),
      source: remainingSeconds,
      value: Math.max(0, remainingSeconds),
    };
    setState(current);
  }
  const { baseline, source, value } = current;
  useEffect(() => {
    if (value <= 0) return;
    const timer = window.setInterval(() => {
      const elapsed = Math.floor((monotonicNow() - baseline) / 1000);
      const next = Math.max(0, source - elapsed);
      setState((previous) =>
        previous.baseline === baseline && previous.value !== next
          ? { ...previous, value: next }
          : previous,
      );
    }, 1000);
    return () => window.clearInterval(timer);
  }, [baseline, source, value]);
  return value;
}

/** Problem codes the card flows explain to people. */
export function cardErrorKey(
  error: unknown,
):
  | "conversations.cardErrorUnavailable"
  | "conversations.cardErrorForbidden"
  | "conversations.cardErrorFeatureOff"
  | "conversations.cardErrorGeneric" {
  if (error instanceof APIRequestError) {
    const code = error.problem?.code;
    // Feature controls answer 403 feature_disabled; check the code first.
    if (code === "feature_disabled" || error.status === 503) {
      return "conversations.cardErrorFeatureOff";
    }
    if (code === "message_embed_unavailable" || error.status === 404) {
      return "conversations.cardErrorUnavailable";
    }
    if (error.status === 403) {
      return "conversations.cardErrorForbidden";
    }
  }
  return "conversations.cardErrorGeneric";
}

export interface ContactCandidate {
  name: string;
  self: boolean;
  userID: string;
}

/** You, then everyone you have a direct conversation with (already visible). */
export function contactCandidates(
  conversations: readonly Conversation[],
  actorID: string,
  youLabel: string,
  locale: string,
): ContactCandidate[] {
  const byID = new Map<string, string>();
  let selfName: string | null = null;
  for (const item of conversations) {
    if (item.kind !== "direct") continue;
    for (const participant of item.participants) {
      if (participant.user_id === actorID) {
        selfName = participant.display_name;
      } else {
        byID.set(participant.user_id, participant.display_name);
      }
    }
  }
  const others = [...byID.entries()]
    .map(([userID, name]) => ({ name, self: false, userID }))
    .sort((left, right) => left.name.localeCompare(right.name, locale));
  return [
    { name: selfName ?? youLabel, self: true, userID: actorID },
    ...others,
  ];
}

type Translate = ReturnType<typeof useI18n>["t"];

/** One-line text for a card message (reply excerpt, conversation list). */
export function cardPreviewText(
  embed: MessageEmbed | undefined,
  t: Translate,
  language: "vi" | "en" = "vi",
): string | null {
  if (!embed) return null;
  if (embed.kind === "contact_card") {
    return embed.available && embed.display_name
      ? t("conversations.contactCardPreview", { name: embed.display_name })
      : t("conversations.contactCardUnavailable");
  }
  if (embed.kind === "sticker") {
    return embed.available && embed.labels
      ? t("conversations.stickerPreview", {
          label: language === "vi" ? embed.labels.vi : embed.labels.en,
        })
      : t("conversations.stickerUnavailable");
  }
  return t("conversations.instantClassPreview", { title: embed.title });
}

/** Text a card contributes to in-thread search (both languages). */
export function embedSearchText(embed: MessageEmbed | undefined): string {
  if (!embed) return "";
  if (embed.kind === "contact_card") {
    return embed.available ? (embed.display_name ?? "") : "";
  }
  if (embed.kind === "sticker") {
    return embed.available && embed.labels
      ? `Sticker ${embed.labels.vi} ${embed.labels.en}`
      : "";
  }
  return embed.title;
}
