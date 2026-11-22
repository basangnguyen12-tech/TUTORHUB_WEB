import {
  issueClassMediaToken,
  recordClassMediaEvent,
  rotateCSRFToken,
  type MediaEventRequest,
  type MediaTokenResponse,
} from "@tutorhub/api-client";
import type { LocalUserChoices } from "@livekit/components-react";

export interface MediaJoinSetup {
  credential: MediaTokenResponse;
  csrfToken: string;
}

export interface MediaRoomNavigationState extends MediaJoinSetup {
  choices: LocalUserChoices;
}

function getApiBaseUrl() {
  return import.meta.env.VITE_API_BASE_URL ?? "/api";
}

export async function requestMediaJoinSetup(
  classID: string,
  signal?: AbortSignal,
): Promise<MediaJoinSetup> {
  const baseUrl = getApiBaseUrl();
  const csrf = await rotateCSRFToken({ baseUrl, signal });
  const credential = await issueClassMediaToken(classID, csrf.csrf_token, {
    baseUrl,
    signal,
  });

  return { credential, csrfToken: csrf.csrf_token };
}

export async function recordMediaEvent(
  classID: string,
  csrfToken: string,
  event: MediaEventRequest,
): Promise<void> {
  await recordClassMediaEvent(classID, event, csrfToken, {
    baseUrl: getApiBaseUrl(),
  });
}

export function hasMediaDeviceSupport(target: typeof navigator | undefined) {
  return Boolean(
    target?.mediaDevices &&
    typeof target.mediaDevices.getUserMedia === "function" &&
    typeof target.mediaDevices.enumerateDevices === "function",
  );
}

const loopbackHostnames = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function currentPageHostname() {
  return typeof window === "undefined" ? "" : window.location.hostname;
}

/**
 * Accepts only bare LiveKit origins. `wss:` is always allowed; plaintext `ws:`
 * is accepted solely for local development, when both this page and the media
 * server resolve to a loopback hostname.
 */
export function isAllowedLiveKitServerURL(
  serverUrl: string,
  currentHostname: string = currentPageHostname(),
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    return false;
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    return false;
  }
  if (parsed.protocol === "wss:") {
    return true;
  }
  if (parsed.protocol === "ws:") {
    return (
      loopbackHostnames.has(currentHostname.toLowerCase()) &&
      loopbackHostnames.has(parsed.hostname.toLowerCase())
    );
  }
  return false;
}

export function readMediaRoomState(
  value: unknown,
): MediaRoomNavigationState | null {
  if (
    !isRecord(value) ||
    !isRecord(value.credential) ||
    !isRecord(value.choices)
  ) {
    return null;
  }

  const credential = value.credential;
  const choices = value.choices;
  if (
    typeof value.csrfToken !== "string" ||
    value.csrfToken.length === 0 ||
    typeof credential.access_token !== "string" ||
    credential.access_token.length === 0 ||
    typeof credential.server_url !== "string" ||
    !isAllowedLiveKitServerURL(credential.server_url) ||
    typeof credential.room_name !== "string" ||
    typeof credential.participant_identity !== "string" ||
    typeof credential.participant_name !== "string" ||
    typeof credential.attempt_id !== "string" ||
    typeof credential.can_publish !== "boolean" ||
    typeof credential.expires_at !== "string" ||
    typeof choices.videoEnabled !== "boolean" ||
    typeof choices.audioEnabled !== "boolean" ||
    typeof choices.videoDeviceId !== "string" ||
    typeof choices.audioDeviceId !== "string" ||
    typeof choices.username !== "string"
  ) {
    return null;
  }

  return value as unknown as MediaRoomNavigationState;
}

export function mediaErrorCode(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "device_permission_denied";
      case "NotFoundError":
      case "DevicesNotFoundError":
        return "device_not_found";
      case "NotReadableError":
      case "TrackStartError":
        return "device_in_use";
      default:
        return "media_device_error";
    }
  }
  if (error instanceof Error) {
    const name = error.name.toLowerCase().replace(/[^a-z0-9.-]+/g, "_");
    return name ? `livekit_${name}`.slice(0, 64) : "livekit_error";
  }

  return "unknown_media_error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
