// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../app/i18n";
import { MediaLobbyWaitingCountContext } from "../../components/MediaLobbyPanel";
import {
  ClassroomMediaShell,
  type ClassroomSignalControls,
  type RoomVisualEffectsRuntime,
} from "./ClassroomMediaShell";

const PARTICIPANT_A = "018f4c7b-9b0a-7a34-8a4c-96d26cb87221";
const PARTICIPANT_B = "018f4c7b-9b0a-7a34-8a4c-96d26cb87222";

const liveKitState = vi.hoisted(() => {
  class MockRemoteTrackPublication {
    isDesired = false;
    isEnabled = true;
    readonly track = { streamState: "active" };
    videoQuality = "high";
    readonly setSubscribed = vi.fn();
    readonly setVideoQuality = vi.fn();

    constructor() {
      this.setSubscribed.mockImplementation((subscribed: boolean) => {
        this.isDesired = subscribed;
        subscriptionTransitions.push({ publication: this, subscribed });
      });
      this.setVideoQuality.mockImplementation((quality: string) => {
        this.videoQuality = quality;
      });
    }
  }

  const subscriptionTransitions: Array<{
    publication: MockRemoteTrackPublication;
    subscribed: boolean;
  }> = [];

  const connectionQualityListeners = new Set<(quality: string) => void>();
  const deviceSetters = {
    audioinput: vi.fn().mockResolvedValue(undefined),
    audiooutput: vi.fn().mockResolvedValue(undefined),
    videoinput: vi.fn().mockResolvedValue(undefined),
  };
  const mediaState = { cameraEnabled: false };
  const localParticipant = {
    connectionQuality: "excellent",
    off: vi.fn((event: string, handler: (quality: string) => void) => {
      if (event === "connectionQualityChanged") {
        connectionQualityListeners.delete(handler);
      }
    }),
    on: vi.fn((event: string, handler: (quality: string) => void) => {
      if (event === "connectionQualityChanged") {
        connectionQualityListeners.add(handler);
      }
    }),
    setCameraEnabled: vi.fn().mockResolvedValue(undefined),
    setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
    setScreenShareEnabled: vi.fn().mockResolvedValue(undefined),
  };

  return {
    MockRemoteTrackPublication,
    cameraPublication: undefined as undefined | { track: unknown },
    cameraTrackRefs: [] as MockTrackReference[],
    deviceSetters,
    screenShareTrackRefs: [] as MockTrackReference[],
    audioTrackRefs: [] as MockTrackReference[],
    speakingParticipants: [] as MockParticipant[],
    mediaDeviceSelect: vi.fn(),
    mediaState,
    subscriptionTransitions,
    trackOptions: [] as Array<{ onlySubscribed?: boolean } | undefined>,
    terminalMediaCleanup: vi.fn().mockResolvedValue(undefined),
    localParticipant,
    emitConnectionQuality(quality: string) {
      localParticipant.connectionQuality = quality;
      for (const listener of connectionQualityListeners) listener(quality);
    },
  };
});

interface MockParticipant {
  attributes?: Record<string, string>;
  identity: string;
  isLocal: boolean;
  joinedAt?: Date;
  name: string;
}

interface MockTrackReference {
  participant: MockParticipant;
  publication:
    InstanceType<typeof liveKitState.MockRemoteTrackPublication> | object;
  source: string;
}

const toolLifecycle = { mounts: 0, unmounts: 0 };

function TestWhiteboardTool() {
  useEffect(() => {
    toolLifecycle.mounts += 1;
    return () => {
      toolLifecycle.unmounts += 1;
    };
  }, []);
  return <p>Lazy whiteboard content</p>;
}

vi.mock("livekit-client", () => ({
  ConnectionQuality: {
    Excellent: "excellent",
    Good: "good",
    Lost: "lost",
    Poor: "poor",
    Unknown: "unknown",
  },
  ParticipantEvent: {
    ConnectionQualityChanged: "connectionQualityChanged",
  },
  RemoteTrackPublication: liveKitState.MockRemoteTrackPublication,
  Track: {
    Source: {
      Camera: "camera",
      Microphone: "microphone",
      ScreenShare: "screen_share",
      ScreenShareAudio: "screen_share_audio",
    },
    StreamState: {
      Active: "active",
      Paused: "paused",
      Unknown: "unknown",
    },
  },
  VideoQuality: {
    HIGH: "high",
    LOW: "low",
  },
}));

vi.mock("@livekit/components-react", () => ({
  ParticipantTile: ({
    children,
    className,
    trackRef,
    ...props
  }: {
    children?: ReactNode;
    className?: string;
    trackRef: MockTrackReference;
  }) => (
    <div
      className={className}
      data-lk-source={trackRef.source}
      data-lk-video-muted="false"
      {...props}
    >
      {children}
    </div>
  ),
  VideoTrack: (props: { "aria-label"?: string; className?: string }) => (
    <video aria-label={props["aria-label"]} className={props.className} />
  ),
  isTrackReference: (trackRef: MockTrackReference) =>
    Boolean(trackRef.publication),
  useLocalParticipant: () => ({
    cameraTrack: liveKitState.cameraPublication,
    isCameraEnabled: liveKitState.mediaState.cameraEnabled,
    isMicrophoneEnabled: false,
    isScreenShareEnabled: false,
    localParticipant: liveKitState.localParticipant,
  }),
  useMediaDeviceSelect: ({
    kind,
  }: {
    kind: keyof typeof liveKitState.deviceSetters;
  }) => {
    liveKitState.mediaDeviceSelect(kind);
    return {
      activeDeviceId: "default",
      devices: [],
      setActiveMediaDevice: liveKitState.deviceSetters[kind],
      className: kind,
    };
  },
  useParticipants: () =>
    liveKitState.cameraTrackRefs.map(({ participant }) => participant),
  useSpeakingParticipants: () => liveKitState.speakingParticipants,
  useTracks: (
    sources: Array<string | { source: string }>,
    options?: { onlySubscribed?: boolean },
  ) => {
    liveKitState.trackOptions.push(options);
    const first = sources[0];
    const source = typeof first === "string" ? first : first?.source;
    if (source === "microphone") return liveKitState.audioTrackRefs;
    return source === "screen_share"
      ? liveKitState.screenShareTrackRefs
      : liveKitState.cameraTrackRefs;
  },
}));

describe("ClassroomMediaShell", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "innerWidth", {
      configurable: true,
      value: 1_280,
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    liveKitState.cameraTrackRefs = createCameraTracks(25);
    liveKitState.screenShareTrackRefs = [];
    liveKitState.audioTrackRefs = createAudioTracks(25);
    liveKitState.speakingParticipants = [];
    liveKitState.localParticipant.connectionQuality = "excellent";
    liveKitState.mediaState.cameraEnabled = false;
    liveKitState.cameraPublication = undefined;
    liveKitState.localParticipant.on.mockClear();
    liveKitState.localParticipant.off.mockClear();
    liveKitState.localParticipant.setCameraEnabled
      .mockReset()
      .mockImplementation(async (enabled: boolean) => {
        liveKitState.mediaState.cameraEnabled = enabled;
      });
    liveKitState.localParticipant.setMicrophoneEnabled
      .mockReset()
      .mockResolvedValue(undefined);
    liveKitState.localParticipant.setScreenShareEnabled
      .mockReset()
      .mockResolvedValue(undefined);
    for (const setter of Object.values(liveKitState.deviceSetters)) {
      setter.mockReset().mockResolvedValue(undefined);
    }
    liveKitState.mediaDeviceSelect.mockClear();
    liveKitState.terminalMediaCleanup.mockReset().mockResolvedValue(undefined);
    liveKitState.subscriptionTransitions.length = 0;
    liveKitState.trackOptions.length = 0;
    toolLifecycle.mounts = 0;
    toolLifecycle.unmounts = 0;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("keeps the grid stable and subscribes only the current 12-video page", async () => {
    const { container } = renderShell();

    expect(container.querySelectorAll(".media-p405-grid > li")).toHaveLength(
      12,
    );
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    expect(container.innerHTML).not.toContain("provider-participant-");

    const remotePublications = liveKitState.cameraTrackRefs
      .slice(1)
      .map(
        ({ publication }) =>
          publication as InstanceType<
            typeof liveKitState.MockRemoteTrackPublication
          >,
      );
    await waitFor(() => {
      expect(remotePublications[0]?.setSubscribed).toHaveBeenLastCalledWith(
        true,
      );
      expect(remotePublications[11]?.isDesired).toBe(false);
      expect(
        (
          liveKitState.audioTrackRefs[0]?.publication as InstanceType<
            typeof liveKitState.MockRemoteTrackPublication
          >
        ).isDesired,
      ).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "Next video page" }));
    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
    await waitFor(() => {
      expect(remotePublications[0]?.setSubscribed).toHaveBeenLastCalledWith(
        false,
      );
      expect(remotePublications[11]?.setSubscribed).toHaveBeenLastCalledWith(
        true,
      );
    });
  });

  it("observes unpublished remote sources before manually subscribing", () => {
    renderShell();

    expect(liveKitState.trackOptions.length).toBeGreaterThanOrEqual(3);
    expect(
      liveKitState.trackOptions.every(
        (options) => options?.onlySubscribed === false,
      ),
    ).toBe(true);
  });

  it("subscribes a publication that crosses a duplicate provider module boundary", async () => {
    const publication = new liveKitState.MockRemoteTrackPublication();
    Object.setPrototypeOf(publication, Object.prototype);
    liveKitState.cameraTrackRefs = [
      {
        participant: {
          identity: "provider-duplicate-module",
          isLocal: false,
          joinedAt: new Date(1_000),
          name: "Remote participant",
        },
        publication,
        source: "camera",
      },
    ];

    renderShell();

    await waitFor(() =>
      expect(publication.setSubscribed).toHaveBeenCalledWith(true),
    );
  });

  it("keeps local-first session order without provider identity or time", () => {
    const tracks = createCameraTracks(5);
    liveKitState.cameraTrackRefs = [...tracks].reverse();
    const view = renderShell();
    const visibleNames = () =>
      Array.from(
        view.container.querySelectorAll(
          ".media-p405-grid .media-p405-tile-meta > span",
        ),
      ).map((element) => element.textContent);

    expect(visibleNames()).toEqual([
      "Learner 1",
      "Learner 5",
      "Learner 4",
      "Learner 3",
      "Learner 2",
    ]);

    tracks.forEach((track, index) => {
      track.participant.identity = `provider-identity-rewritten-${index}`;
      track.participant.joinedAt = new Date(50_000 - index);
    });
    liveKitState.cameraTrackRefs = [
      tracks[2]!,
      tracks[4]!,
      tracks[0]!,
      tracks[3]!,
      tracks[1]!,
    ];
    view.rerender(shellElement());
    expect(visibleNames()).toEqual([
      "Learner 1",
      "Learner 5",
      "Learner 4",
      "Learner 3",
      "Learner 2",
    ]);

    const newcomer = createCameraTracks(1)[0]!;
    newcomer.participant.isLocal = false;
    newcomer.participant.name = "Learner 6";
    liveKitState.cameraTrackRefs = [newcomer, ...liveKitState.cameraTrackRefs];
    view.rerender(shellElement());
    expect(visibleNames()).toEqual([
      "Learner 1",
      "Learner 5",
      "Learner 4",
      "Learner 3",
      "Learner 2",
      "Learner 6",
    ]);
  });

  it("uses only the signed participant key to correlate canonical server roster order", () => {
    liveKitState.cameraTrackRefs = createCameraTracks(3);
    const participantKeys = [
      "018f4c7b-9b0a-7a34-8a4c-96d26cb87221",
      "018f4c7b-9b0a-7a34-8a4c-96d26cb87222",
      "018f4c7b-9b0a-7a34-8a4c-96d26cb87223",
    ];
    liveKitState.cameraTrackRefs.forEach((track, index) => {
      track.participant.attributes = {
        "tutorhub.participant_key": participantKeys[index]!,
      };
      track.participant.identity = `unsafe-provider-identity-${index}`;
      track.participant.name = `unsafe-provider-name-${index}@example.test`;
      track.participant.joinedAt = new Date(99_000 - index);
    });
    const signals = createSignalControls({
      projection: {
        ...createSignalControls().projection!,
        self_participant_key: participantKeys[1]!,
        roster: [
          {
            participant_key: participantKeys[2]!,
            roster_sequence: 1,
            display_name: "Canonical First",
            instance_role: "attendee",
            connection_state: "connected",
          },
          {
            participant_key: participantKeys[1]!,
            roster_sequence: 2,
            display_name: "Canonical Self",
            instance_role: "host",
            connection_state: "connected",
          },
          {
            participant_key: participantKeys[0]!,
            roster_sequence: 3,
            display_name: "Canonical Last",
            instance_role: "attendee",
            connection_state: "reconnecting",
          },
        ],
      },
    });
    const view = renderShell({ signals });
    const visibleNames = Array.from(
      view.container.querySelectorAll(
        ".media-p405-grid .media-p405-tile-meta > span",
      ),
    ).map((element) => element.textContent);

    expect(visibleNames).toEqual([
      "Canonical First",
      "Canonical Self",
      "Canonical Last",
    ]);
    expect(view.container.textContent).not.toContain("unsafe-provider");
  });

  it("requires server ACK for hand/reaction success and exposes bounded moderation controls", async () => {
    const toggleHand = vi.fn().mockResolvedValue(undefined);
    const sendReaction = vi.fn().mockResolvedValue(undefined);
    const lowerHand = vi.fn().mockResolvedValue(undefined);
    const lowerAll = vi.fn().mockResolvedValue(undefined);
    const signals = createSignalControls({
      onLowerAllHands: lowerAll,
      onLowerHand: lowerHand,
      onSendReaction: sendReaction,
      onToggleHand: toggleHand,
      projection: {
        ...createSignalControls().projection!,
        viewer_operations: {
          can_raise_hand: true,
          can_send_reaction: true,
          can_moderate_hands: true,
        },
        raised_hands: [
          {
            display_name: "Student One",
            participant_key: PARTICIPANT_B,
            queue_position: 1,
            raised_at: "2030-08-03T00:00:00Z",
            signal_sequence: 4,
          },
        ],
      },
    });
    renderShell({ signals });

    const raise = screen.getByRole("button", { name: "Raise hand" });
    fireEvent.click(raise);
    expect(toggleHand).toHaveBeenCalledTimes(1);
    expect(raise).toHaveAttribute("aria-pressed", "false");
    expect(await screen.findByText("Your hand is raised.")).toBeInTheDocument();

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Send a reaction" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: /Clap/ }));
    await waitFor(() => expect(sendReaction).toHaveBeenCalledWith("clap"));

    fireEvent.click(
      screen.getByRole("button", { name: "Open classroom roster" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Classroom roster" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Lower all hands" }));
    await waitFor(() => expect(lowerAll).toHaveBeenCalledTimes(1));
    fireEvent.click(
      screen.getByRole("button", { name: "Lower Student One's hand" }),
    );
    await waitFor(() =>
      expect(lowerHand).toHaveBeenCalledWith(
        "018f4c7b-9b0a-7a34-8a4c-96d26cb87222",
      ),
    );
  });

  it("opens persistent room chat as a labelled drawer and restores trigger focus", async () => {
    renderShell({ chat: <div>Persistent room history</div> });

    const opener = screen.getByRole("button", { name: "Open in-room chat" });
    opener.focus();
    fireEvent.click(opener);

    expect(opener).toHaveAttribute("aria-expanded", "true");
    expect(
      await screen.findByRole("heading", { name: "In-room chat" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Persistent room history")).toBeInTheDocument();

    const close = screen
      .getAllByRole("button", { name: "Close" })
      .find((button) => button.textContent?.trim() === "Close");
    expect(close).toBeDefined();
    fireEvent.click(close!);
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("mounts a registered classroom tool lazily without remounting media and restores focus", async () => {
    const view = renderShell({
      tools: [
        {
          content: <TestWhiteboardTool />,
          icon: <span aria-hidden="true">W</span>,
          id: "whiteboard",
          label: "Open whiteboard",
          title: "Classroom whiteboard",
        },
      ],
    });
    const mediaTile = view.container.querySelector(".media-p405-grid > li");
    const opener = screen.getByRole("button", { name: "Open whiteboard" });

    expect(toolLifecycle.mounts).toBe(0);
    expect(
      screen.queryByText("Lazy whiteboard content"),
    ).not.toBeInTheDocument();
    opener.focus();
    fireEvent.click(opener);

    expect(opener).toHaveAttribute("aria-expanded", "true");
    expect(
      await screen.findByRole("heading", { name: "Classroom whiteboard" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Lazy whiteboard content")).toBeInTheDocument();
    expect(toolLifecycle.mounts).toBe(1);
    expect(view.container.querySelector(".media-p405-grid > li")).toBe(
      mediaTile,
    );

    const close = screen
      .getAllByRole("button", { name: "Close" })
      .find((button) => button.textContent?.trim() === "Close");
    expect(close).toBeDefined();
    fireEvent.click(close!);

    await waitFor(() => expect(opener).toHaveFocus());
    expect(toolLifecycle.unmounts).toBe(1);
    expect(view.container.querySelector(".media-p405-grid > li")).toBe(
      mediaTile,
    );
  });

  it("puts an open tool on a non-modal central stage beside the camera strip", async () => {
    const view = renderShell({
      chat: <div>Persistent room history</div>,
      tools: [
        {
          content: <TestWhiteboardTool />,
          icon: <span aria-hidden="true">W</span>,
          id: "whiteboard",
          label: "Open whiteboard",
          title: "Classroom whiteboard",
        },
      ],
    });
    const classroom = view.container.querySelector(".media-p405-classroom");
    const mediaStage = view.container.querySelector(".media-p405-stage");
    const mediaTile = view.container.querySelector(".media-p405-grid > li");
    const opener = screen.getByRole("button", { name: "Open whiteboard" });

    fireEvent.click(opener);

    const stage = screen.getByRole("region", { name: "Classroom whiteboard" });
    expect(classroom).toHaveClass("media-p405-classroom--tool-stage");
    expect(opener).toHaveAttribute("aria-expanded", "true");
    expect(opener).toHaveAttribute("aria-controls", stage.id);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Classroom whiteboard" }),
      ).toHaveFocus(),
    );
    // The media stage keeps its exact DOM and simply becomes the side strip.
    expect(view.container.querySelector(".media-p405-stage")).toBe(mediaStage);
    expect(view.container.querySelector(".media-p405-grid > li")).toBe(
      mediaTile,
    );
    expect(
      view.container.querySelectorAll(".media-p405-grid > li"),
    ).toHaveLength(12);

    // The Dock stays interactive (no modal focus trap / aria-hidden siblings).
    fireEvent.click(screen.getByRole("button", { name: "Turn microphone on" }));
    await waitFor(() =>
      expect(
        liveKitState.localParticipant.setMicrophoneEnabled,
      ).toHaveBeenCalledWith(true),
    );
    expect(
      screen.getByRole("button", { name: "Open in-room chat" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Leave room" })).toBeEnabled();
    expect(screen.getByText("Lazy whiteboard content")).toBeInTheDocument();

    fireEvent.click(opener);
    expect(opener).toHaveAttribute("aria-expanded", "false");
    expect(opener).not.toHaveAttribute("aria-controls");
    expect(classroom).not.toHaveClass("media-p405-classroom--tool-stage");
    expect(
      screen.queryByRole("region", { name: "Classroom whiteboard" }),
    ).not.toBeInTheDocument();
    expect(toolLifecycle.mounts).toBe(1);
    expect(toolLifecycle.unmounts).toBe(1);
    expect(view.container.querySelector(".media-p405-grid > li")).toBe(
      mediaTile,
    );
  });

  it("auto-opens a presented tool once per key without stealing keyboard focus", async () => {
    const whiteboardTool = (autoOpenKey: string | null) => ({
      autoOpenKey,
      content: <TestWhiteboardTool />,
      icon: <span aria-hidden="true">W</span>,
      id: "whiteboard" as const,
      label: "Open whiteboard",
      title: "Classroom whiteboard",
    });
    const view = renderShell({ tools: [whiteboardTool(null)] });
    const mediaTile = view.container.querySelector(".media-p405-grid > li");
    const opener = screen.getByRole("button", { name: "Open whiteboard" });
    const microphone = screen.getByRole("button", {
      name: "Turn microphone on",
    });
    microphone.focus();
    expect(
      screen.queryByRole("region", { name: "Classroom whiteboard" }),
    ).not.toBeInTheDocument();

    view.rerender(shellElement({ tools: [whiteboardTool("board-1:1")] }));

    expect(
      screen.getByRole("region", { name: "Classroom whiteboard" }),
    ).toBeInTheDocument();
    expect(opener).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText(
        "Classroom whiteboard is now being presented on the stage.",
      ),
    ).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
    });
    expect(microphone).toHaveFocus();
    expect(toolLifecycle.mounts).toBe(1);
    expect(view.container.querySelector(".media-p405-grid > li")).toBe(
      mediaTile,
    );

    // A manual close sticks for the same presenter generation.
    const close = screen
      .getAllByRole("button", { name: "Close" })
      .find((button) => button.textContent?.trim() === "Close");
    fireEvent.click(close!);
    await waitFor(() => expect(opener).toHaveFocus());
    expect(
      screen.queryByRole("region", { name: "Classroom whiteboard" }),
    ).not.toBeInTheDocument();
    view.rerender(shellElement({ tools: [whiteboardTool("board-1:1")] }));
    view.rerender(shellElement({ tools: [whiteboardTool(null)] }));
    view.rerender(shellElement({ tools: [whiteboardTool("board-1:1")] }));
    expect(
      screen.queryByRole("region", { name: "Classroom whiteboard" }),
    ).not.toBeInTheDocument();
    expect(opener).toHaveAttribute("aria-expanded", "false");

    // A new presenter generation brings the stage back, still without focus.
    microphone.focus();
    view.rerender(shellElement({ tools: [whiteboardTool("board-1:2")] }));
    expect(
      screen.getByRole("region", { name: "Classroom whiteboard" }),
    ).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
    });
    expect(microphone).toHaveFocus();
    expect(toolLifecycle.mounts).toBe(2);
  });

  it("keeps a manually opened tool open and quiet when its key first appears", async () => {
    const whiteboardTool = (autoOpenKey: string | null) => ({
      autoOpenKey,
      content: <TestWhiteboardTool />,
      icon: <span aria-hidden="true">W</span>,
      id: "whiteboard" as const,
      label: "Open whiteboard",
      title: "Classroom whiteboard",
    });
    const view = renderShell({ tools: [whiteboardTool(null)] });
    const opener = screen.getByRole("button", { name: "Open whiteboard" });

    fireEvent.click(opener);
    const heading = await screen.findByRole("heading", {
      name: "Classroom whiteboard",
    });
    await waitFor(() => expect(heading).toHaveFocus());

    view.rerender(shellElement({ tools: [whiteboardTool("board-1:1")] }));

    expect(heading).toHaveFocus();
    expect(toolLifecycle.mounts).toBe(1);
    expect(
      screen.queryByText(
        "Classroom whiteboard is now being presented on the stage.",
      ),
    ).not.toBeInTheDocument();

    // Closing from the Dock is respected for that same key.
    fireEvent.click(opener);
    view.rerender(shellElement({ tools: [whiteboardTool("board-1:1")] }));
    expect(
      screen.queryByRole("region", { name: "Classroom whiteboard" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the waiting room inside the roster drawer and surfaces waiting requests", async () => {
    const view = renderShell({
      lobby: <section aria-label="Waiting room panel">Lobby queue</section>,
      lobbyWaitingCount: 2,
      signals: createSignalControls(),
    });

    expect(screen.queryByText("Lobby queue")).not.toBeInTheDocument();
    expect(view.container.querySelector(".media-p405-lobby")).toBeNull();
    const roster = screen.getByRole("button", {
      name: "Open classroom roster (2 waiting to join)",
    });
    expect(roster.querySelector(".media-p406-roster-badge")).toHaveTextContent(
      "2",
    );
    expect(
      screen
        .getAllByRole("status")
        .some((element) => element.textContent === "2 waiting to join"),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "View waiting room" }));

    expect(
      await screen.findByRole("heading", { name: "Classroom roster" }),
    ).toBeInTheDocument();
    const lobby = screen.getByRole("region", { name: "Waiting room panel" });
    const rosterList = screen.getByRole("list", {
      name: "Participants in classroom order",
    });
    expect(
      lobby.compareDocumentPosition(rosterList) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("takes no stage space when nobody is waiting and reads the provider count", () => {
    const view = render(
      <MediaLobbyWaitingCountContext value={3}>
        {shellElement({ lobby: <p>Lobby queue</p> })}
      </MediaLobbyWaitingCountContext>,
    );
    expect(
      screen.getByRole("button", {
        name: "Open classroom roster (3 waiting to join)",
      }),
    ).toBeInTheDocument();

    view.rerender(
      <MediaLobbyWaitingCountContext value={0}>
        {shellElement({ lobby: <p>Lobby queue</p> })}
      </MediaLobbyWaitingCountContext>,
    );
    expect(
      screen.queryByRole("button", { name: "View waiting room" }),
    ).not.toBeInTheDocument();
    expect(
      view.container.querySelector(".media-p406-lobby-banner"),
    ).toHaveClass("media-p406-lobby-banner--idle");
    expect(
      screen.getByRole("button", { name: "Open classroom roster" }),
    ).toBeInTheDocument();
    expect(view.container.querySelector(".media-p406-roster-badge")).toBeNull();

    view.rerender(
      <MediaLobbyWaitingCountContext value={3}>
        {shellElement()}
      </MediaLobbyWaitingCountContext>,
    );
    expect(
      screen.queryByRole("button", { name: /Open classroom roster/ }),
    ).not.toBeInTheDocument();
    expect(view.container.querySelector(".media-p406-lobby-banner")).toBeNull();
  });

  it("collapses the pager when every participant fits on one page", () => {
    const view = renderShell();
    const pager = () => document.getElementById("media-p405-pagination");
    expect(pager()).not.toHaveClass("media-p405-pagination--single");

    liveKitState.cameraTrackRefs = createCameraTracks(5);
    view.rerender(shellElement());
    expect(pager()).toHaveClass("media-p405-pagination--single");
    expect(screen.getByText("Page 1 of 1")).toBeInTheDocument();
  });

  it("retires an old page before subscribing replacements in reversed provider order", async () => {
    liveKitState.cameraTrackRefs = [...createCameraTracks(25)].reverse();
    renderShell();
    const cameraPublications = new Set(
      liveKitState.cameraTrackRefs
        .map(({ publication }) => publication)
        .filter(
          (
            publication,
          ): publication is InstanceType<
            typeof liveKitState.MockRemoteTrackPublication
          > => publication instanceof liveKitState.MockRemoteTrackPublication,
        ),
    );
    await waitFor(() =>
      expect(
        [...cameraPublications].filter(({ isDesired }) => isDesired),
      ).toHaveLength(11),
    );
    liveKitState.subscriptionTransitions.length = 0;

    fireEvent.click(screen.getByRole("button", { name: "Next video page" }));
    await waitFor(() =>
      expect(
        [...cameraPublications].filter(({ isDesired }) => isDesired),
      ).toHaveLength(12),
    );

    const pageTransitions = liveKitState.subscriptionTransitions.filter(
      ({ publication }) => cameraPublications.has(publication),
    );
    const firstSubscribe = pageTransitions.findIndex(
      ({ subscribed }) => subscribed,
    );
    const lastUnsubscribe = pageTransitions.reduce(
      (lastIndex, { subscribed }, index) => (subscribed ? lastIndex : index),
      -1,
    );
    expect(firstSubscribe).toBeGreaterThan(0);
    expect(lastUnsubscribe).toBeLessThan(firstSubscribe);
  });

  it("commits a clamped page before the roster grows again", async () => {
    const view = renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Next video page" }));
    fireEvent.click(screen.getByRole("button", { name: "Next video page" }));
    expect(screen.getByText("Page 3 of 3")).toBeInTheDocument();

    liveKitState.cameraTrackRefs = createCameraTracks(5);
    view.rerender(shellElement());
    await waitFor(() => {
      expect(screen.getByText("Page 1 of 1")).toBeInTheDocument();
      expect(document.getElementById("media-p405-pagination")).toHaveFocus();
    });

    liveKitState.cameraTrackRefs = createCameraTracks(25);
    view.rerender(shellElement());
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
  });

  it("renders only controls authorized by the exact credential grants", () => {
    renderShell({
      canPublishCameraMicrophone: false,
      canShareScreen: false,
      canSubscribe: false,
    });

    expect(screen.getByText("Listen-only mode")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Turn microphone on" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Turn camera on" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Share screen" }),
    ).not.toBeInTheDocument();
    expect(
      liveKitState.localParticipant.setMicrophoneEnabled,
    ).not.toHaveBeenCalled();
    expect(
      liveKitState.localParticipant.setCameraEnabled,
    ).not.toHaveBeenCalled();
    expect(
      liveKitState.localParticipant.setScreenShareEnabled,
    ).not.toHaveBeenCalled();
    expect(liveKitState.mediaDeviceSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Devices" }));
    expect(liveKitState.mediaDeviceSelect).toHaveBeenCalledTimes(1);
    expect(liveKitState.mediaDeviceSelect).toHaveBeenCalledWith("audiooutput");
    expect(
      (
        liveKitState.audioTrackRefs[0]?.publication as InstanceType<
          typeof liveKitState.MockRemoteTrackPublication
        >
      ).isDesired,
    ).toBe(false);
  });

  it.each([
    {
      name: "subscribe-only",
      canPublishCameraMicrophone: false,
      canShareScreen: false,
      canSubscribe: true,
      microphoneVisible: false,
      shareVisible: false,
    },
    {
      name: "camera/microphone without share",
      canPublishCameraMicrophone: true,
      canShareScreen: false,
      canSubscribe: true,
      microphoneVisible: true,
      shareVisible: false,
    },
    {
      name: "share without camera/microphone",
      canPublishCameraMicrophone: false,
      canShareScreen: true,
      canSubscribe: true,
      microphoneVisible: false,
      shareVisible: true,
    },
  ])(
    "projects the exact $name credential grant",
    ({
      canPublishCameraMicrophone,
      canShareScreen,
      canSubscribe,
      microphoneVisible,
      shareVisible,
    }) => {
      renderShell({
        canPublishCameraMicrophone,
        canShareScreen,
        canSubscribe,
      });

      expect(
        Boolean(screen.queryByRole("button", { name: "Turn microphone on" })),
      ).toBe(microphoneVisible);
      expect(
        Boolean(screen.queryByRole("button", { name: "Turn camera on" })),
      ).toBe(microphoneVisible);
      expect(
        Boolean(screen.queryByRole("button", { name: "Share screen" })),
      ).toBe(shareVisible);
      expect(
        (
          liveKitState.audioTrackRefs[0]?.publication as InstanceType<
            typeof liveKitState.MockRemoteTrackPublication
          >
        ).isDesired,
      ).toBe(canSubscribe);
    },
  );

  it("uses custom media controls and arrow-key toolbar navigation", async () => {
    renderShell();
    const microphone = screen.getByRole("button", {
      name: "Turn microphone on",
    });
    const camera = screen.getByRole("button", { name: "Turn camera on" });

    expect(microphone).toHaveAttribute("tabindex", "0");
    expect(camera).toHaveAttribute("tabindex", "-1");
    microphone.focus();
    fireEvent.keyDown(microphone, { key: "ArrowRight" });
    expect(camera).toHaveFocus();
    expect(microphone).toHaveAttribute("tabindex", "-1");
    expect(camera).toHaveAttribute("tabindex", "0");

    fireEvent.click(camera);
    await waitFor(() =>
      expect(
        liveKitState.localParticipant.setCameraEnabled,
      ).toHaveBeenCalledWith(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Share screen" }));
    await waitFor(() =>
      expect(
        liveKitState.localParticipant.setScreenShareEnabled,
      ).toHaveBeenCalledWith(true),
    );
  });

  it("bounds the active-speaker rail and restores the prior mode after sharing", async () => {
    const view = renderShell();
    const activeSpeaker = screen.getByRole("button", {
      name: "Active speaker",
    });
    fireEvent.click(activeSpeaker);
    expect(activeSpeaker).toHaveAttribute("aria-pressed", "true");
    expect(
      view.container.querySelectorAll(".media-p405-rail-list > li"),
    ).toHaveLength(6);

    liveKitState.screenShareTrackRefs = [
      {
        participant: liveKitState.cameraTrackRefs[4]!.participant,
        publication: new liveKitState.MockRemoteTrackPublication(),
        source: "screen_share",
      },
    ];
    view.rerender(shellElement());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Presentation" }),
      ).toHaveAttribute("aria-pressed", "true"),
    );
    const presenterCamera = liveKitState.cameraTrackRefs[4]
      ?.publication as InstanceType<
      typeof liveKitState.MockRemoteTrackPublication
    >;
    const presenterShare = liveKitState.screenShareTrackRefs[0]
      ?.publication as InstanceType<
      typeof liveKitState.MockRemoteTrackPublication
    >;
    expect(presenterCamera.isDesired).toBe(false);
    expect(presenterShare.isDesired).toBe(true);

    liveKitState.screenShareTrackRefs = [];
    view.rerender(shellElement());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Active speaker" }),
      ).toHaveAttribute("aria-pressed", "true"),
    );
  });

  it("restores exact screen-share focus after presentation ends", async () => {
    const view = renderShell();
    const shareControl = screen.getByRole("button", { name: "Share screen" });
    shareControl.focus();
    fireEvent.click(shareControl);
    await waitFor(() =>
      expect(
        liveKitState.localParticipant.setScreenShareEnabled,
      ).toHaveBeenCalledWith(true),
    );

    liveKitState.screenShareTrackRefs = [
      {
        participant: liveKitState.cameraTrackRefs[4]!.participant,
        publication: new liveKitState.MockRemoteTrackPublication(),
        source: "screen_share",
      },
    ];
    view.rerender(shellElement());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Presentation" }),
      ).toHaveAttribute("aria-pressed", "true"),
    );
    expect(shareControl).toHaveFocus();

    liveKitState.screenShareTrackRefs = [];
    view.rerender(shellElement());
    await waitFor(() => expect(shareControl).toHaveFocus());
  });

  it("uses drawer trigger semantics and returns focus on compact layouts", async () => {
    Object.defineProperty(globalThis, "innerWidth", {
      configurable: true,
      value: 320,
    });
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Active speaker" }));
    const opener = await screen.findByRole("button", {
      name: "Open participant list",
    });

    opener.focus();
    fireEvent.click(opener);
    expect(opener).toHaveAttribute("aria-expanded", "true");
    const close = screen
      .getAllByRole("button", { name: "Close" })
      .find((button) => button.textContent?.trim() === "Close");
    expect(close).toBeDefined();
    fireEvent.click(close!);
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("keeps one toolbar tab stop and restores focus after a pin changes layout", async () => {
    renderShell();
    const toolbar = screen.getByRole("toolbar", {
      name: "Classroom controls",
    });
    const pin = screen.getByRole("button", { name: "Pin Learner 1" });

    fireEvent.click(pin);

    const activeSpeaker = screen.getByRole("button", {
      name: "Active speaker",
    });
    await waitFor(() => expect(activeSpeaker).toHaveFocus());
    expect(activeSpeaker).toHaveAttribute("aria-pressed", "true");
    expect(
      Array.from(toolbar.querySelectorAll("button")).filter(
        (button) => button.tabIndex === 0,
      ),
    ).toEqual([activeSpeaker]);
  });

  it("degrades video one tier at a time while preserving layout, audio and controls", async () => {
    vi.useFakeTimers();
    liveKitState.mediaState.cameraEnabled = true;
    const view = renderShell();
    const firstRemoteCamera = liveKitState.cameraTrackRefs[1]
      ?.publication as InstanceType<
      typeof liveKitState.MockRemoteTrackPublication
    >;

    expect(
      view.container.querySelectorAll(".media-p405-grid > li"),
    ).toHaveLength(12);
    expect(
      view.container.querySelectorAll(".media-p405-grid video"),
    ).toHaveLength(12);

    act(() => liveKitState.emitConnectionQuality("poor"));
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(
      screen.getByText(/showing fewer videos while keeping audio/i),
    ).toBeInTheDocument();
    expect(
      view.container.querySelectorAll(".media-p405-grid > li"),
    ).toHaveLength(12);
    expect(
      view.container.querySelectorAll(".media-p405-grid video"),
    ).toHaveLength(6);

    act(() => vi.advanceTimersByTime(5_000));
    expect(firstRemoteCamera.setVideoQuality).toHaveBeenLastCalledWith("low");
    expect(
      firstRemoteCamera.setSubscribed.mock.invocationCallOrder[0],
    ).toBeLessThan(
      firstRemoteCamera.setVideoQuality.mock.invocationCallOrder[0]!,
    );

    act(() => vi.advanceTimersByTime(5_000));
    expect(
      view.container.querySelectorAll(".media-p405-grid > li"),
    ).toHaveLength(12);
    expect(
      view.container.querySelectorAll(".media-p405-grid video"),
    ).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(
      view.container.querySelectorAll(".media-p405-grid video"),
    ).toHaveLength(0);
    expect(screen.getByRole("toolbar")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Turn camera on" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Turn microphone on" }),
    ).toBeEnabled();
    expect(liveKitState.localParticipant.setCameraEnabled).toHaveBeenCalledWith(
      false,
    );
    expect(
      (
        liveKitState.audioTrackRefs[0]?.publication as InstanceType<
          typeof liveKitState.MockRemoteTrackPublication
        >
      ).isDesired,
    ).toBe(true);

    act(() => liveKitState.emitConnectionQuality("excellent"));
    act(() => vi.advanceTimersByTime(15_000));
    expect(
      view.container.querySelectorAll(".media-p405-grid video"),
    ).toHaveLength(1);
    expect(
      liveKitState.localParticipant.setCameraEnabled,
    ).not.toHaveBeenCalledWith(true);

    view.unmount();
    expect(liveKitState.localParticipant.off).toHaveBeenCalledWith(
      "connectionQualityChanged",
      expect.any(Function),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the public paused stream state as bounded degradation evidence", () => {
    vi.useFakeTimers();
    const pausedPublication = liveKitState.cameraTrackRefs[1]
      ?.publication as InstanceType<
      typeof liveKitState.MockRemoteTrackPublication
    >;
    pausedPublication.track.streamState = "paused";
    const view = renderShell();

    act(() => vi.advanceTimersByTime(5_000));

    expect(
      view.container.querySelectorAll(".media-p405-grid video"),
    ).toHaveLength(6);
    expect(
      screen.getByText(/showing fewer videos while keeping audio/i),
    ).toBeInTheDocument();
  });

  it("holds degradation for adaptive-disabled video and a hidden document", () => {
    vi.useFakeTimers();
    const pausedPublication = liveKitState.cameraTrackRefs[1]
      ?.publication as InstanceType<
      typeof liveKitState.MockRemoteTrackPublication
    >;
    pausedPublication.track.streamState = "paused";
    pausedPublication.isEnabled = false;
    const view = renderShell();

    act(() => vi.advanceTimersByTime(20_000));
    expect(
      view.container.querySelectorAll(".media-p405-grid video"),
    ).toHaveLength(12);

    pausedPublication.isEnabled = true;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    act(() => vi.advanceTimersByTime(20_000));
    expect(
      view.container.querySelectorAll(".media-p405-grid video"),
    ).toHaveLength(12);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    act(() => vi.advanceTimersByTime(6_000));
    expect(
      view.container.querySelectorAll(".media-p405-grid video"),
    ).toHaveLength(6);
  });

  it("keeps presentation video ahead of cameras until audio-only", async () => {
    vi.useFakeTimers();
    liveKitState.screenShareTrackRefs = [
      {
        participant: liveKitState.cameraTrackRefs[4]!.participant,
        publication: new liveKitState.MockRemoteTrackPublication(),
        source: "screen_share",
      },
    ];
    const view = renderShell();
    act(() => liveKitState.emitConnectionQuality("poor"));

    act(() => vi.advanceTimersByTime(15_000));
    const sharePublication = liveKitState.screenShareTrackRefs[0]
      ?.publication as InstanceType<
      typeof liveKitState.MockRemoteTrackPublication
    >;
    expect(
      view.container.querySelector(
        'video[aria-label="Screen shared by Learner 5"]',
      ),
    ).toBeInTheDocument();
    expect(sharePublication.isDesired).toBe(true);
    expect(sharePublication.videoQuality).toBe("high");

    act(() => vi.advanceTimersByTime(5_000));
    expect(
      view.container.querySelector(
        'video[aria-label="Screen shared by Learner 5"]',
      ),
    ).not.toBeInTheDocument();
    expect(sharePublication.isDesired).toBe(false);
  });

  it("uses the full camera budget when an active share is not on stage", async () => {
    liveKitState.screenShareTrackRefs = [
      {
        participant: liveKitState.cameraTrackRefs[4]!.participant,
        publication: new liveKitState.MockRemoteTrackPublication(),
        source: "screen_share",
      },
    ];
    const view = renderShell();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Presentation" }),
      ).toHaveAttribute("aria-pressed", "true"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Grid" }));

    expect(
      view.container.querySelectorAll(".media-p405-grid video"),
    ).toHaveLength(12);
  });

  it("invalidates a pending media operation on leave while still mounted", async () => {
    const deferred = createDeferred<void>();
    liveKitState.localParticipant.setCameraEnabled.mockReturnValueOnce(
      deferred.promise,
    );
    const onLeave = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const view = renderShell({ onLeave });

    fireEvent.click(screen.getByRole("button", { name: "Turn camera on" }));
    expect(
      screen.getByRole("button", { name: "Turn microphone on" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Devices" })).toHaveAttribute(
      "tabindex",
      "0",
    );
    fireEvent.click(screen.getByRole("button", { name: "Leave room" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave classroom" }));
    expect(onLeave).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferred.reject(new Error("late device failure"));
      await deferred.promise.catch(() => undefined);
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(consoleError).not.toHaveBeenCalled();
    view.unmount();
    consoleError.mockRestore();
  });

  it("hard-stops media when a camera operation resolves after leave", async () => {
    const deferred = createDeferred<void>();
    liveKitState.localParticipant.setCameraEnabled.mockReturnValueOnce(
      deferred.promise,
    );
    const view = renderShell();

    fireEvent.click(screen.getByRole("button", { name: "Turn camera on" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave room" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave classroom" }));
    await act(async () => {
      deferred.resolve();
      await deferred.promise;
    });

    expect(liveKitState.localParticipant.setCameraEnabled).toHaveBeenCalledWith(
      true,
    );
    expect(liveKitState.terminalMediaCleanup).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("hard-stops screen capture that resolves after terminal abort", async () => {
    const deferred = createDeferred<void>();
    const controlAbortController = new AbortController();
    liveKitState.localParticipant.setScreenShareEnabled.mockReturnValueOnce(
      deferred.promise,
    );
    renderShell({ controlAbortSignal: controlAbortController.signal });

    fireEvent.click(screen.getByRole("button", { name: "Share screen" }));
    act(() => controlAbortController.abort());
    await act(async () => {
      deferred.resolve();
      await deferred.promise;
    });

    expect(
      liveKitState.localParticipant.setScreenShareEnabled,
    ).toHaveBeenCalledWith(true);
    expect(liveKitState.terminalMediaCleanup).toHaveBeenCalledTimes(1);
  });

  it("hard-stops capture after a late camera device switch", async () => {
    const deferred = createDeferred<void>();
    liveKitState.deviceSetters.videoinput.mockReturnValueOnce(deferred.promise);
    renderShell();

    fireEvent.click(screen.getByRole("button", { name: "Devices" }));
    fireEvent.change(screen.getByLabelText("Active camera"), {
      target: { value: "default" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Leave room" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave classroom" }));
    await act(async () => {
      deferred.resolve();
      await deferred.promise;
    });

    expect(liveKitState.deviceSetters.videoinput).toHaveBeenCalledTimes(1);
    expect(liveKitState.terminalMediaCleanup).toHaveBeenCalledTimes(1);
  });

  it("invalidates a pending media operation when the room enters a terminal state", async () => {
    const deferred = createDeferred<void>();
    const controlAbortController = new AbortController();
    liveKitState.localParticipant.setCameraEnabled.mockReturnValueOnce(
      deferred.promise,
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    renderShell({ controlAbortSignal: controlAbortController.signal });

    fireEvent.click(screen.getByRole("button", { name: "Turn camera on" }));
    act(() => controlAbortController.abort());

    expect(
      screen.getByRole("button", { name: "Turn camera on" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Devices" })).toBeDisabled();
    await act(async () => {
      deferred.reject(new Error("late terminal device failure"));
      await deferred.promise.catch(() => undefined);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("hard-stops a media operation that resolves after unmount", async () => {
    const deferred = createDeferred<void>();
    liveKitState.localParticipant.setCameraEnabled.mockReturnValueOnce(
      deferred.promise,
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const view = renderShell();

    fireEvent.click(screen.getByRole("button", { name: "Turn camera on" }));
    view.unmount();
    await act(async () => {
      deferred.resolve();
      await deferred.promise;
    });

    expect(liveKitState.terminalMediaCleanup).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("cancels queued focus work when the shell unmounts", () => {
    vi.useFakeTimers();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const view = renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Next video page" }));
    fireEvent.click(screen.getByRole("button", { name: "Next video page" }));

    liveKitState.cameraTrackRefs = createCameraTracks(5);
    view.rerender(shellElement());
    const focusCallsBeforeUnmount = focus.mock.calls.length;
    view.unmount();
    act(() => vi.runOnlyPendingTimers());

    expect(focus).toHaveBeenCalledTimes(focusCallsBeforeUnmount);
    focus.mockRestore();
  });

  describe("ROOM-STUDIO-02 studio surface", () => {
    it.each([
      { participants: 1, tiles: 1 },
      { participants: 2, tiles: 2 },
      { participants: 5, tiles: 5 },
      { participants: 25, tiles: 12 },
    ])(
      "reports $tiles visible tiles for $participants participants to the adaptive stage",
      ({ participants, tiles }) => {
        liveKitState.cameraTrackRefs = createCameraTracks(participants);
        liveKitState.audioTrackRefs = createAudioTracks(participants);
        const { container } = renderShell();
        const grid = container.querySelector(".media-p405-grid");

        expect(grid).toHaveAttribute("data-tile-count", String(tiles));
        expect(grid).toHaveClass(
          "media-p405-grid",
          "media-p405-grid--capacity-12",
        );
        expect(
          container.querySelectorAll(".media-p405-grid > li"),
        ).toHaveLength(tiles);
      },
    );

    it("shows a session clock hidden from assistive technology beside the unchanged status", () => {
      vi.useFakeTimers();
      liveKitState.cameraTrackRefs = createCameraTracks(2);
      liveKitState.audioTrackRefs = createAudioTracks(2);
      const { container } = renderShell();
      const clock = container.querySelector(".media-p405-session-clock");

      expect(clock).toHaveAttribute("aria-hidden", "true");
      expect(clock).toHaveTextContent("00:00");
      const status = screen.getByText("Connected / 2 participants");
      expect(status).toHaveAttribute("role", "status");
      expect(status).toHaveAttribute("aria-live", "polite");
      expect(status).not.toContainElement(clock as HTMLElement);

      act(() => {
        vi.advanceTimersByTime(65_000);
      });
      expect(clock).toHaveTextContent(/^01:05$/);
      act(() => {
        vi.advanceTimersByTime(3_540_000);
      });
      expect(clock).toHaveTextContent(/^01:00:05$/);
      expect(screen.getByText("Connected / 2 participants")).toBe(status);
    });

    it("keeps the clock at 00:00 until the room connects", () => {
      vi.useFakeTimers();
      liveKitState.cameraTrackRefs = createCameraTracks(1);
      liveKitState.audioTrackRefs = createAudioTracks(1);
      const view = renderShell({ connectionStatus: "connecting" });
      const clock = () =>
        view.container.querySelector(".media-p405-session-clock");

      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(clock()).toHaveTextContent("00:00");
      view.rerender(shellElement({ connectionStatus: "connected" }));
      act(() => {
        vi.advanceTimersByTime(3_000);
      });
      expect(clock()).toHaveTextContent("00:03");
    });

    it("adds decorative captions and cluster dividers without changing names or roving order", () => {
      liveKitState.cameraTrackRefs = createCameraTracks(5);
      liveKitState.audioTrackRefs = createAudioTracks(5);
      renderShell({
        chat: <p>Room chat</p>,
        signals: createSignalControls(),
        tools: [
          {
            content: <TestWhiteboardTool />,
            icon: <span aria-hidden="true">W</span>,
            id: "whiteboard",
            label: "Open whiteboard",
            title: "Classroom whiteboard",
          },
        ],
      });
      const toolbar = screen.getByRole("toolbar", {
        name: "Classroom controls",
      });

      expect(
        Array.from(
          toolbar.querySelectorAll<HTMLElement>("[data-media-control]"),
        ).map((control) => control.dataset.mediaControl),
      ).toEqual([
        "microphone",
        "camera",
        "screen-share",
        "devices",
        "effects",
        "hand",
        "reaction",
        "chat",
        "tool-whiteboard",
        "roster",
        "layout-grid",
        "layout-active-speaker",
        "layout-presentation",
      ]);
      for (const [name, caption] of [
        ["Turn microphone on", "Mic"],
        ["Turn camera on", "Camera"],
        ["Share screen", "Share"],
        ["Devices", "Setup"],
        ["Backgrounds and effects", "Effects"],
        ["Raise hand", "Raise"],
        ["Send a reaction", "React"],
        ["Open in-room chat", "Chat"],
        ["Open whiteboard", "Board"],
        ["Open classroom roster", "People"],
      ] as const) {
        const button = within(toolbar).getByRole("button", { name });
        const captionElement = button.querySelector(".media-p405-dock-caption");
        expect(captionElement).toHaveTextContent(caption);
        expect(captionElement).toHaveAttribute("aria-hidden", "true");
      }
      const layoutGroup = within(toolbar).getByRole("group", {
        name: "Layout mode",
      });
      expect(
        layoutGroup.querySelector(".media-p405-dock-caption"),
      ).toHaveAttribute("aria-hidden", "true");
      const dividers = document.querySelectorAll(".media-p405-dock-divider");
      expect(dividers).toHaveLength(3);
      dividers.forEach((divider) => {
        expect(divider).toHaveAttribute("aria-hidden", "true");
        expect(divider).not.toHaveAttribute("data-media-control");
      });

      const microphone = within(toolbar).getByRole("button", {
        name: "Turn microphone on",
      });
      expect(microphone).toHaveAttribute("tabindex", "0");
      const camera = within(toolbar).getByRole("button", {
        name: "Turn camera on",
      });
      camera.focus();
      fireEvent.keyDown(camera, { key: "ArrowRight" });
      expect(
        within(toolbar).getByRole("button", { name: "Share screen" }),
      ).toHaveFocus();
      fireEvent.keyDown(document.activeElement as HTMLElement, {
        key: "End",
      });
      expect(
        within(toolbar).getByRole("button", { name: "Active speaker" }),
      ).toHaveFocus();
      fireEvent.keyDown(document.activeElement as HTMLElement, {
        key: "Home",
      });
      expect(microphone).toHaveFocus();
      expect(screen.getByRole("button", { name: "Leave room" })).toHaveClass(
        "media-p405-dock-leave",
        "th-button--danger",
      );
    });

    it("anchors the device popover inside the Dock after Leave", () => {
      liveKitState.cameraTrackRefs = createCameraTracks(2);
      liveKitState.audioTrackRefs = createAudioTracks(2);
      const { container } = renderShell();
      fireEvent.click(screen.getByRole("button", { name: "Devices" }));

      const panel = container.querySelector(".media-p405-device-panel");
      const footer = container.querySelector(".media-p405-footer");
      expect(footer).toContainElement(panel as HTMLElement);
      expect(
        screen
          .getByRole("button", { name: "Leave room" })
          .compareDocumentPosition(panel as HTMLElement) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it("mirrors only the local camera self-view, never remote cameras or a shared screen", async () => {
      liveKitState.cameraTrackRefs = createCameraTracks(3);
      liveKitState.audioTrackRefs = createAudioTracks(3);
      const view = renderShell();
      const gridVideos = () =>
        Array.from(
          view.container.querySelectorAll<HTMLVideoElement>(
            ".media-p405-tile video",
          ),
        ).map((video) => ({
          label: video.getAttribute("aria-label"),
          mirrored: video.classList.contains("media-p405-video--mirror"),
        }));

      expect(gridVideos()).toEqual([
        { label: "Video from Learner 1", mirrored: true },
        { label: "Video from Learner 2", mirrored: false },
        { label: "Video from Learner 3", mirrored: false },
      ]);

      liveKitState.screenShareTrackRefs = [
        {
          participant: liveKitState.cameraTrackRefs[0]!.participant,
          publication: {},
          source: "screen_share",
        },
      ];
      view.rerender(shellElement());
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Presentation" }),
        ).toHaveAttribute("aria-pressed", "true"),
      );
      const shared = view.container.querySelector<HTMLVideoElement>(
        ".media-p405-stage .media-p405-tile--stage video",
      );
      expect(shared).toHaveAttribute(
        "aria-label",
        "Screen shared by Learner 1",
      );
      expect(shared).not.toHaveClass("media-p405-video--mirror");
    });
  });
});

describe("ClassroomMediaShell visual effects (ADR-0041)", () => {
  beforeEach(() => {
    liveKitState.cameraTrackRefs = createCameraTracks(5);
    liveKitState.screenShareTrackRefs = [];
    liveKitState.audioTrackRefs = createAudioTracks(5);
    liveKitState.speakingParticipants = [];
    liveKitState.mediaState.cameraEnabled = false;
    liveKitState.cameraPublication = undefined;
    liveKitState.localParticipant.setCameraEnabled
      .mockReset()
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  interface FakeProcessor {
    name: string;
    visualEffectsMode: "lighting" | "background";
    applyPlan: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    init: ReturnType<typeof vi.fn>;
    restart: ReturnType<typeof vi.fn>;
  }

  function fakeCameraTrack() {
    let processor: FakeProcessor | undefined;
    const track = {
      getProcessor: vi.fn(() => processor),
      setProcessor: vi.fn(async (next: FakeProcessor) => {
        processor = next;
      }),
      stopProcessor: vi.fn(async () => {
        processor = undefined;
      }),
    };
    return track;
  }

  function fakeRuntime(supported = true) {
    const processors: FakeProcessor[] = [];
    const runtime = {
      supportsVisualEffects: vi.fn(() => supported),
      createVisualEffectsProcessor: vi.fn(
        async (plan: { mode: "lighting" | "background" }) => {
          const processor: FakeProcessor = {
            name: "processor-" + String(processors.length),
            visualEffectsMode: plan.mode,
            applyPlan: vi.fn(
              async (next: { mode: string }) => next.mode === plan.mode,
            ),
            destroy: vi.fn(async () => undefined),
            init: vi.fn(async () => undefined),
            restart: vi.fn(async () => undefined),
          };
          processors.push(processor);
          return processor;
        },
      ),
    };
    return {
      processors,
      runtime,
      loadRuntime: vi.fn(
        async () => runtime as unknown as RoomVisualEffectsRuntime,
      ),
    };
  }

  function toolbarOrder() {
    const toolbar = screen.getByRole("toolbar", { name: "Classroom controls" });
    return Array.from(
      toolbar.querySelectorAll<HTMLElement>("[data-media-control]"),
    ).map((control) => control.dataset.mediaControl);
  }

  it("puts Effects after Devices and before the hand without changing roving order", () => {
    const signals = createSignalControls({
      projection: {
        ...createSignalControls().projection!,
        viewer_operations: {
          can_raise_hand: true,
          can_send_reaction: true,
          can_moderate_hands: false,
        },
      },
    });
    renderShell({ signals });
    const order = toolbarOrder();
    expect(order.slice(0, 7)).toEqual([
      "microphone",
      "camera",
      "screen-share",
      "devices",
      "effects",
      "hand",
      "reaction",
    ]);
    const hand = screen.getByRole("button", { name: "Raise hand" });
    hand.focus();
    fireEvent.keyDown(hand, { key: "ArrowRight" });
    expect(
      screen.getByRole("button", { name: "Send a reaction" }),
    ).toHaveFocus();
    const effects = screen.getByRole("button", {
      name: "Backgrounds and effects",
    });
    expect(effects).toHaveAttribute("id", "media-p405-control-effects");
    expect(effects).toHaveAttribute("aria-haspopup", "dialog");
    expect(effects).toHaveAttribute("tabindex", "-1");
  });

  it("renders no effects control for listen-only credentials", () => {
    renderShell({ canPublishCameraMicrophone: false, canShareScreen: false });
    expect(
      screen.queryByRole("button", { name: "Backgrounds and effects" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Effects: None" })).toBeNull();
    expect(screen.getByText("Effects: None")).toBeInTheDocument();
    expect(toolbarOrder()).not.toContain("effects");
  });

  it("labels the active effect and opens a non-modal right drawer from the header", async () => {
    const { runtime, loadRuntime } = fakeRuntime();
    const { container } = renderShell({
      visualEffects: {
        initialState: {
          background: { kind: "preset", presetId: "academic-library" },
          lighting: { brightness: "normal", tone: "natural" },
        },
        loadRuntime,
      },
    });
    const badge = screen.getByRole("button", { name: "Effects: Library" });
    expect(badge).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(badge);

    const drawer = await screen.findByRole("dialog", {
      name: "Backgrounds and effects",
    });
    expect(drawer).toHaveAttribute("data-theme", "dark");
    expect(drawer).not.toHaveAttribute("aria-modal");
    expect(drawer.className).toContain("media-p405-effects-drawer");
    expect(badge).toHaveAttribute("aria-expanded", "true");
    expect(
      container.querySelector(".media-p405-shell--effects-open"),
    ).not.toBeNull();
    // Non-modal: the toolbar and stage stay reachable while it is open.
    expect(
      screen.getByRole("toolbar", { name: "Classroom controls" }),
    ).toBeVisible();
    expect(
      within(drawer).getByText(
        "Turn on your camera to preview effects on yourself.",
      ),
    ).toBeInTheDocument();
    expect(
      within(drawer).getByRole("button", { name: "Library" }),
    ).toHaveAttribute("aria-pressed", "true");
    // The camera is off: nothing is attached and nothing is loaded.
    expect(runtime.createVisualEffectsProcessor).not.toHaveBeenCalled();

    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(badge).toHaveFocus();
  });

  it("attaches, updates, swaps and removes the camera processor", async () => {
    liveKitState.mediaState.cameraEnabled = true;
    const track = fakeCameraTrack();
    liveKitState.cameraPublication = { track };
    const { processors, runtime, loadRuntime } = fakeRuntime();
    const { unmount } = renderShell({ visualEffects: { loadRuntime } });

    fireEvent.click(
      screen.getByRole("button", { name: "Backgrounds and effects" }),
    );
    const drawer = await screen.findByRole("dialog", {
      name: "Backgrounds and effects",
    });
    expect(within(drawer).getByLabelText("Your camera")).toBeInTheDocument();

    fireEvent.click(
      within(drawer).getByRole("button", { name: "Slight blur" }),
    );
    await waitFor(() => expect(track.setProcessor).toHaveBeenCalledTimes(1));
    expect(runtime.createVisualEffectsProcessor).toHaveBeenCalledWith(
      {
        mode: "background",
        background: { kind: "blur", blurRadius: 8 },
        lighting: { brightness: "normal", tone: "natural" },
      },
      expect.objectContaining({ onOverload: expect.any(Function) }),
    );
    expect(
      screen.getByRole("button", { name: "Effects: Slight blur" }),
    ).toBeVisible();

    // Same mode: updated in place without flicker.
    fireEvent.click(
      within(drawer).getByRole("button", { name: "Strong blur" }),
    );
    await waitFor(() => expect(processors[0]?.applyPlan).toHaveBeenCalled());
    expect(track.setProcessor).toHaveBeenCalledTimes(1);

    // Off: the processor is removed and the raw camera restored.
    fireEvent.click(within(drawer).getByRole("button", { name: "None" }));
    await waitFor(() => expect(track.stopProcessor).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Effects: None" })).toBeVisible();

    // Lighting only: a lighting processor, no background pipeline.
    fireEvent.mouseDown(within(drawer).getByRole("tab", { name: "Lighting" }), {
      button: 0,
    });
    fireEvent.click(
      within(drawer).getByRole("radio", { name: "Low-light boost" }),
    );
    await waitFor(() => expect(track.setProcessor).toHaveBeenCalledTimes(2));
    expect(processors[1]?.visualEffectsMode).toBe("lighting");
    expect(
      screen.getByRole("button", { name: "Effects: Low-light boost" }),
    ).toBeVisible();

    unmount();
    await waitFor(() => expect(track.stopProcessor).toHaveBeenCalledTimes(2));
  });

  it("keeps the raw camera with a polite notice when effects are unsupported", async () => {
    liveKitState.mediaState.cameraEnabled = true;
    const track = fakeCameraTrack();
    liveKitState.cameraPublication = { track };
    const { runtime, loadRuntime } = fakeRuntime(false);
    renderShell({
      visualEffects: {
        initialState: {
          background: { kind: "blur", strength: "strong" },
          lighting: { brightness: "normal", tone: "natural" },
        },
        loadRuntime,
      },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Backgrounds and effects" }),
    );
    const drawer = await screen.findByRole("dialog", {
      name: "Backgrounds and effects",
    });
    expect(
      await within(drawer).findByText(
        "This device or browser doesn't support this effect; using your original camera.",
      ),
    ).toBeInTheDocument();
    expect(runtime.createVisualEffectsProcessor).not.toHaveBeenCalled();
    expect(track.setProcessor).not.toHaveBeenCalled();
  });

  it("never attaches a new processor while the camera is off", async () => {
    liveKitState.mediaState.cameraEnabled = false;
    const track = fakeCameraTrack();
    liveKitState.cameraPublication = { track };
    const { loadRuntime } = fakeRuntime();
    renderShell({
      visualEffects: {
        initialState: {
          background: { kind: "blur", strength: "light" },
          lighting: { brightness: "normal", tone: "natural" },
        },
        loadRuntime,
      },
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(loadRuntime).not.toHaveBeenCalled();
    expect(track.setProcessor).not.toHaveBeenCalled();
    expect(
      liveKitState.localParticipant.setCameraEnabled,
    ).not.toHaveBeenCalled();
  });
});

function renderShell(
  overrides: Partial<Parameters<typeof ClassroomMediaShell>[0]> = {},
) {
  return render(shellElement(overrides));
}

function shellElement(
  overrides: Partial<Parameters<typeof ClassroomMediaShell>[0]> = {},
) {
  return (
    <I18nProvider initialLanguage="en">
      <ClassroomMediaShell
        canPublishCameraMicrophone
        canShareScreen
        canSubscribe
        connectionStatus="connected"
        onLeave={vi.fn()}
        onTerminalMediaCleanup={liveKitState.terminalMediaCleanup}
        {...overrides}
      />
    </I18nProvider>
  );
}

function createCameraTracks(count: number): MockTrackReference[] {
  return Array.from({ length: count }, (_, index) => ({
    participant: {
      identity: `provider-participant-${index + 1}`,
      isLocal: index === 0,
      joinedAt: new Date(1_000 + index),
      name: `Learner ${index + 1}`,
    },
    publication:
      index === 0 ? {} : new liveKitState.MockRemoteTrackPublication(),
    source: "camera",
  }));
}

function createAudioTracks(count: number): MockTrackReference[] {
  return Array.from({ length: count }, (_, index) => ({
    participant: {
      identity: `provider-participant-${index + 1}`,
      isLocal: false,
      joinedAt: new Date(1_000 + index),
      name: `Learner ${index + 1}`,
    },
    publication: new liveKitState.MockRemoteTrackPublication(),
    source: "microphone",
  }));
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createSignalControls(
  overrides: Partial<ClassroomSignalControls> = {},
): ClassroomSignalControls {
  return {
    error: false,
    loading: false,
    mutating: false,
    projection: {
      room_instance_id: "c5f918a5-a09e-4f94-9fab-fb0ab5702a4d",
      projection_version: 4,
      last_signal_sequence: 9,
      self_participant_key: PARTICIPANT_A,
      viewer_operations: {
        can_raise_hand: true,
        can_send_reaction: true,
        can_moderate_hands: false,
      },
      roster: [
        {
          participant_key: PARTICIPANT_A,
          roster_sequence: 1,
          display_name: "Teacher One",
          instance_role: "host",
          connection_state: "connected",
        },
        {
          participant_key: PARTICIPANT_B,
          roster_sequence: 2,
          display_name: "Student One",
          instance_role: "attendee",
          connection_state: "connected",
        },
      ],
      raised_hands: [],
      reactions: { clusters: [], hidden_cluster_count: 0, summary: [] },
      server_time: "2030-08-03T00:00:00Z",
    },
    refreshing: false,
    onLowerAllHands: vi.fn().mockResolvedValue(undefined),
    onLowerHand: vi.fn().mockResolvedValue(undefined),
    onResync: vi.fn().mockResolvedValue(undefined),
    onSendReaction: vi.fn().mockResolvedValue(undefined),
    onToggleHand: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
