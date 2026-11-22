import { describe, expect, it } from "vitest";
import {
  hasMediaDeviceSupport,
  isAllowedLiveKitServerURL,
  mediaErrorCode,
  readMediaRoomState,
} from "./media";

describe("media room state", () => {
  it("detects browsers without the required media APIs", () => {
    expect(hasMediaDeviceSupport(undefined)).toBe(false);
    expect(
      hasMediaDeviceSupport({ mediaDevices: {} } as unknown as Navigator),
    ).toBe(false);
    expect(
      hasMediaDeviceSupport({
        mediaDevices: {
          getUserMedia: () => Promise.resolve(new MediaStream()),
          enumerateDevices: () => Promise.resolve([]),
        },
      } as unknown as Navigator),
    ).toBe(true);
  });

  it("accepts complete in-memory navigation state and rejects refresh state", () => {
    const state = {
      csrfToken: "csrf-token",
      credential: {
        access_token: "short-lived-token",
        server_url: "wss://staging.example.test",
        room_name: "th_tenant_class",
        participant_identity: "u_actor_s_session",
        participant_name: "Student",
        attempt_id: "16abf9c1-69af-44a7-a844-36a6a19e2db2",
        can_publish: true,
        expires_at: "2026-07-14T05:05:00Z",
      },
      choices: {
        videoEnabled: true,
        audioEnabled: true,
        videoDeviceId: "camera",
        audioDeviceId: "microphone",
        username: "Student",
      },
    };

    expect(readMediaRoomState(state)).toEqual(state);
    expect(readMediaRoomState(null)).toBeNull();
    expect(
      readMediaRoomState({ ...state, credential: { access_token: "" } }),
    ).toBeNull();
  });

  it("always accepts a bare wss:// LiveKit origin", () => {
    expect(
      isAllowedLiveKitServerURL("wss://media.example.test", "tutorhub.vn"),
    ).toBe(true);
    expect(
      isAllowedLiveKitServerURL("wss://media.example.test:7443/", "localhost"),
    ).toBe(true);
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "allows plaintext ws:// only between loopback hosts (page %s)",
    (pageHost) => {
      expect(isAllowedLiveKitServerURL("ws://127.0.0.1:7880", pageHost)).toBe(
        true,
      );
      expect(isAllowedLiveKitServerURL("ws://localhost:7880", pageHost)).toBe(
        true,
      );
      expect(isAllowedLiveKitServerURL("ws://[::1]:7880/", pageHost)).toBe(
        true,
      );
      expect(
        isAllowedLiveKitServerURL("ws://media.example.test:7880", pageHost),
      ).toBe(false);
    },
  );

  it("rejects ws:// on any non-loopback origin", () => {
    expect(
      isAllowedLiveKitServerURL("ws://127.0.0.1:7880", "tutorhub.vn"),
    ).toBe(false);
    expect(
      isAllowedLiveKitServerURL("ws://localhost:7880", "staging.tutorhub.vn"),
    ).toBe(false);
    expect(
      isAllowedLiveKitServerURL("ws://media.tutorhub.vn", "tutorhub.vn"),
    ).toBe(false);
  });

  it.each([
    "",
    "not a url",
    "https://media.example.test",
    "http://127.0.0.1:7880",
    "wss://user:secret@media.example.test",
    "wss://media.example.test/rtc",
    "wss://media.example.test/?token=leak",
    "wss://media.example.test/#fragment",
    "ws://127.0.0.1:7880/rtc",
  ])("rejects malformed or decorated server URL %j", (serverUrl) => {
    expect(isAllowedLiveKitServerURL(serverUrl, "localhost")).toBe(false);
  });

  it("applies the transport policy to legacy navigation state", () => {
    const state = {
      csrfToken: "csrf-token",
      credential: {
        access_token: "short-lived-token",
        server_url: "ws://127.0.0.1:7880",
        room_name: "th_tenant_class",
        participant_identity: "u_actor_s_session",
        participant_name: "Student",
        attempt_id: "16abf9c1-69af-44a7-a844-36a6a19e2db2",
        can_publish: true,
        expires_at: "2026-07-14T05:05:00Z",
      },
      choices: {
        videoEnabled: true,
        audioEnabled: true,
        videoDeviceId: "camera",
        audioDeviceId: "microphone",
        username: "Student",
      },
    };
    // jsdom serves the page from localhost, so loopback ws:// is accepted.
    expect(window.location.hostname).toBe("localhost");
    expect(readMediaRoomState(state)).toEqual(state);
    expect(
      readMediaRoomState({
        ...state,
        credential: {
          ...state.credential,
          server_url: "ws://media.example.test",
        },
      }),
    ).toBeNull();
  });

  it("maps raw device errors to bounded telemetry codes", () => {
    expect(mediaErrorCode(new DOMException("denied", "NotAllowedError"))).toBe(
      "device_permission_denied",
    );
    expect(mediaErrorCode(new Error("connection failed"))).toBe(
      "livekit_error",
    );
  });
});
