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
import { useContext, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../app/i18n";
import { MediaLobbyWaitingCountContext } from "../../components/MediaLobbyPanel";
import {
  ClassroomHeaderSlotContext,
  ClassroomMediaShell,
  type ClassroomSignalControls,
  type RoomVisualEffectsRuntime,
} from "./ClassroomMediaShell";
import type { ClassroomModerationControlsModel } from "./ClassroomModerationControls";
import { ClassroomToolActionsContext } from "../classroom-tools/toolActions";

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
      await screen.findByRole("heading", { name: "People (2)" }),
    ).toBeInTheDocument();
    // ROOM-PEOPLE-03: the one bulk action the server supports, pinned at the
    // drawer's foot with its live count.
    const hostActions = screen.getByRole("group", { name: "Host actions" });
    fireEvent.click(
      within(hostActions).getByRole("button", {
        name: "Lower all hands (1)",
      }),
    );
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

    // ROOM-CHAT-01: only the round ✕ closes the inspector (no footer key).
    const drawer = screen.getByRole("dialog", { name: "In-room chat" });
    const closeKeys = within(drawer).getAllByRole("button", { name: "Close" });
    expect(closeKeys).toHaveLength(1);
    expect(closeKeys[0]?.textContent?.trim()).toBe("");
    fireEvent.click(closeKeys[0]!);
    await waitFor(() => expect(opener).toHaveFocus());
    expect(opener).toHaveAttribute("aria-expanded", "false");
  });

  it("ROOM-CHAT-01 docks chat, people and effects in one non-modal inspector slot", async () => {
    const onChatOpenChange = vi.fn();
    const view = renderShell({
      chat: <div>Persistent room history</div>,
      onChatOpenChange,
      signals: createSignalControls(),
    });
    const shell = view.container.querySelector(".media-p405-shell");
    const chat = screen.getByRole("button", { name: "Open in-room chat" });
    const people = screen.getByRole("button", {
      name: "Open classroom roster",
    });

    expect(chat).toHaveAttribute("aria-expanded", "false");
    expect(chat).toHaveClass("th-button--secondary");
    expect(onChatOpenChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(chat);
    const chatDrawer = await screen.findByRole("dialog", {
      name: "In-room chat",
    });
    expect(chatDrawer).toHaveAccessibleDescription(
      "Saved for class members · To: Everyone",
    );
    expect(chat).toHaveAttribute("aria-expanded", "true");
    expect(chat).toHaveClass("th-button--primary");
    expect(onChatOpenChange).toHaveBeenLastCalledWith(true);
    expect(shell).toHaveClass("media-p405-shell--inspector-open");
    expect(shell).toHaveAttribute("data-inspector", "chat");
    // Non-modal: no overlay and the stage stays interactive.
    expect(document.querySelector(".th-dialog-overlay")).toBeNull();
    fireEvent.pointerDown(view.container.querySelector(".media-p405-stage")!);
    expect(screen.getByRole("dialog", { name: "In-room chat" })).toBeVisible();

    // Opening People replaces Chat in the same slot.
    fireEvent.click(people);
    expect(
      await screen.findByRole("dialog", { name: "People (2)" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "In-room chat" }),
      ).not.toBeInTheDocument(),
    );
    expect(chat).toHaveAttribute("aria-expanded", "false");
    expect(people).toHaveAttribute("aria-expanded", "true");
    expect(shell).toHaveAttribute("data-inspector", "roster");
    expect(onChatOpenChange).toHaveBeenLastCalledWith(false);

    // Escape closes the inspector and gives the stage its width back.
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await waitFor(() =>
      expect(shell).not.toHaveClass("media-p405-shell--inspector-open"),
    );
    await waitFor(() => expect(people).toHaveFocus());
  });

  it("ROOM-CHAT-01 shows a bounded unread badge on the closed chat key", async () => {
    const view = renderShell({
      chat: <div>Persistent room history</div>,
      chatUnreadCount: 3,
    });
    const chat = screen.getByRole("button", {
      name: "Open in-room chat, 3 unread messages",
    });
    expect(screen.getByTestId("media-p408-chat-badge")).toHaveTextContent("3");

    view.rerender(
      shellElement({
        chat: <div>Persistent room history</div>,
        chatUnreadCount: 120,
      }),
    );
    expect(screen.getByTestId("media-p408-chat-badge")).toHaveTextContent(
      "99+",
    );
    view.rerender(
      shellElement({
        chat: <div>Persistent room history</div>,
        chatUnreadCapped: true,
        chatUnreadCount: 40,
      }),
    );
    expect(screen.getByTestId("media-p408-chat-badge")).toHaveTextContent(
      "99+",
    );

    fireEvent.click(chat);
    await screen.findByRole("dialog", { name: "In-room chat" });
    expect(screen.queryByTestId("media-p408-chat-badge")).toBeNull();
    expect(chat).toHaveAccessibleName("Open in-room chat");

    view.rerender(
      shellElement({
        chat: <div>Persistent room history</div>,
        chatUnreadCount: 0,
      }),
    );
    expect(screen.queryByTestId("media-p408-chat-badge")).toBeNull();
  });

  it("mounts a registered classroom tool lazily without remounting media and restores focus", async () => {
    const view = renderShell({
      tools: [
        {
          content: <TestWhiteboardTool />,
          icon: <span aria-hidden="true">W</span>,
          id: "whiteboard",
          label: "Whiteboard",
          title: "Classroom whiteboard",
        },
      ],
    });
    const mediaTile = view.container.querySelector(".media-p405-grid > li");
    const opener = toolsTrigger();

    expect(toolLifecycle.mounts).toBe(0);
    expect(
      screen.queryByText("Lazy whiteboard content"),
    ).not.toBeInTheDocument();
    opener.focus();
    chooseTool("Whiteboard");

    expect(
      screen.queryByRole("dialog", { name: "Classroom tools" }),
    ).toBeNull();
    expect(opener).toHaveClass("th-button--primary");
    expect(opener).toHaveAccessibleDescription("On stage: Whiteboard");
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
          label: "Whiteboard",
          title: "Classroom whiteboard",
        },
      ],
    });
    const classroom = view.container.querySelector(".media-p405-classroom");
    const mediaStage = view.container.querySelector(".media-p405-stage");
    const mediaTile = view.container.querySelector(".media-p405-grid > li");
    const opener = toolsTrigger();

    chooseTool("Whiteboard");

    const stage = screen.getByRole("region", { name: "Classroom whiteboard" });
    expect(stage).toHaveAttribute("id", "media-p506-stage-whiteboard");
    expect(classroom).toHaveClass("media-p405-classroom--tool-stage");
    expect(opener).toHaveClass("th-button--primary");
    expect(opener).toHaveAttribute("aria-expanded", "false");
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

    // Choosing the open tool again closes its stage.
    const popover = openToolsPopover();
    const tile = within(popover).getByRole("button", { name: "Whiteboard" });
    expect(tile).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(tile);
    await waitFor(() => expect(opener).toHaveFocus());
    expect(opener).toHaveClass("th-button--secondary");
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
      label: "Whiteboard",
      title: "Classroom whiteboard",
    });
    const view = renderShell({ tools: [whiteboardTool(null)] });
    const mediaTile = view.container.querySelector(".media-p405-grid > li");
    const opener = toolsTrigger();
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
    expect(opener).toHaveClass("th-button--primary");
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
    expect(opener).toHaveClass("th-button--secondary");

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
      label: "Whiteboard",
      title: "Classroom whiteboard",
    });
    const view = renderShell({ tools: [whiteboardTool(null)] });

    chooseTool("Whiteboard");
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
    chooseTool("Whiteboard");
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
      await screen.findByRole("heading", { name: "People (2)" }),
    ).toBeInTheDocument();
    const lobby = screen.getByRole("region", { name: "Waiting room panel" });
    const inClass = screen.getByRole("region", { name: "In class" });
    expect(
      lobby.compareDocumentPosition(inClass) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // ROOM-PEOPLE-03: the open drawer owns the waiting announcement, so the
    // stage banner steps aside (no duplicate live text, no second button).
    expect(
      screen.queryByRole("button", { name: "View waiting room" }),
    ).not.toBeInTheDocument();
    expect(
      screen
        .getAllByRole("status")
        .some((element) => element.textContent === "2 waiting to join"),
    ).toBe(false);
    // The Dock badge keeps its behaviour while the drawer is open.
    expect(
      screen.getByRole("button", {
        name: "Open classroom roster (2 waiting to join)",
      }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("ROOM-PEOPLE-03 titles the drawer with the class size, drops the footer Close key and clears search on Escape", async () => {
    renderShell({ signals: createSignalControls() });
    fireEvent.click(
      screen.getByRole("button", { name: "Open classroom roster" }),
    );
    const drawer = await screen.findByRole("dialog", { name: "People (2)" });
    expect(
      screen.queryByRole("heading", { name: "Classroom roster" }),
    ).not.toBeInTheDocument();
    // Only the round ✕ closes it (no duplicate footer "Close").
    const closeKeys = within(drawer).getAllByRole("button", { name: "Close" });
    expect(closeKeys).toHaveLength(1);
    expect(closeKeys[0]?.textContent?.trim()).toBe("");

    const search = within(drawer).getByRole("searchbox", {
      name: "Search for people",
    });
    fireEvent.change(search, { target: { value: "stu" } });
    fireEvent.keyDown(search, { key: "Escape" });
    expect(search).toHaveValue("");
    expect(screen.getByRole("dialog", { name: "People (2)" })).toBeVisible();
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "People (2)" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("ROOM-PEOPLE-03 shows mic-off and speaking cues only through the signed participant key", async () => {
    liveKitState.cameraTrackRefs = createCameraTracks(3);
    const keys = [PARTICIPANT_A, PARTICIPANT_B];
    liveKitState.cameraTrackRefs.forEach((track, index) => {
      const key = keys[index];
      if (key)
        track.participant.attributes = { "tutorhub.participant_key": key };
      track.participant.identity = `unsafe-provider-identity-${index}`;
      (
        track.participant as { isMicrophoneEnabled?: boolean }
      ).isMicrophoneEnabled = false;
    });
    renderShell({ signals: createSignalControls() });
    fireEvent.click(
      screen.getByRole("button", { name: "Open classroom roster" }),
    );
    const drawer = await screen.findByRole("dialog", { name: "People (2)" });
    const student = within(drawer)
      .getByText("Student One")
      .closest("li") as HTMLElement;
    const teacher = within(drawer)
      .getByText("Teacher One")
      .closest("li") as HTMLElement;
    // Remote: the provider says muted. Self: the local hook's state (off).
    expect(
      within(student).getByRole("img", { name: "Microphone off" }),
    ).toBeInTheDocument();
    expect(
      within(teacher).getByRole("img", { name: "Microphone off" }),
    ).toBeInTheDocument();
    expect(drawer.textContent).not.toContain("unsafe-provider");
    expect(drawer.textContent).not.toContain(PARTICIPANT_B);
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
    chooseLayout("Active speaker");
    expect(layoutMode(view.container)).toBe("active-speaker");
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
      expect(layoutMode(view.container)).toBe("presentation"),
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
      expect(layoutMode(view.container)).toBe("active-speaker"),
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
      expect(layoutMode(view.container)).toBe("presentation"),
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
    chooseLayout("Active speaker");
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
    const view = renderShell();
    const toolbar = screen.getByRole("toolbar", {
      name: "Classroom controls",
    });
    const pin = screen.getByRole("button", { name: "Pin Learner 1" });

    fireEvent.click(pin);

    // The pinned tile remounts on the stage, so focus falls back to the one
    // Dock key that owns the layout (ROOM-COMPACT-05).
    const layout = screen.getByRole("button", { name: "Change layout" });
    await waitFor(() => expect(layout).toHaveFocus());
    expect(layoutMode(view.container)).toBe("active-speaker");
    expect(
      Array.from(toolbar.querySelectorAll("button")).filter(
        (button) => button.tabIndex === 0,
      ),
    ).toEqual([layout]);
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
      expect(layoutMode(view.container)).toBe("presentation"),
    );

    chooseLayout("Grid");

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

  describe("ROOM-UI-POLISH-01 full screen and stage focus", () => {
    const whiteboardTool = () => ({
      content: <TestWhiteboardTool />,
      icon: <span aria-hidden="true">W</span>,
      id: "whiteboard" as const,
      label: "Whiteboard",
      title: "Classroom whiteboard",
    });
    const topBar = () =>
      document.querySelector<HTMLElement>("header.media-p405-header")!;
    let fullscreenElement: Element | null = null;
    const root = document.documentElement;

    function installFullscreenAPI({
      enabled,
      rejects = false,
    }: {
      enabled: boolean;
      rejects?: boolean;
    }) {
      fullscreenElement = null;
      Object.defineProperty(document, "fullscreenEnabled", {
        configurable: true,
        value: enabled,
      });
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        get: () => fullscreenElement,
      });
      const request = vi.fn(async () => {
        if (rejects) throw new TypeError("Permissions check failed");
        fullscreenElement = root;
        document.dispatchEvent(new Event("fullscreenchange"));
      });
      const exit = vi.fn(async () => {
        fullscreenElement = null;
        document.dispatchEvent(new Event("fullscreenchange"));
      });
      Object.defineProperty(root, "requestFullscreen", {
        configurable: true,
        value: request,
      });
      Object.defineProperty(document, "exitFullscreen", {
        configurable: true,
        value: exit,
      });
      return { exit, request };
    }

    afterEach(() => {
      for (const key of [
        "fullscreenEnabled",
        "fullscreenElement",
        "exitFullscreen",
      ]) {
        Reflect.deleteProperty(document, key);
      }
      Reflect.deleteProperty(root, "requestFullscreen");
      fullscreenElement = null;
    });

    it("always shows the Full screen key in the Top Bar and adds Stage focus beside Close when a tool opens", () => {
      installFullscreenAPI({ enabled: true });
      renderShell({ tools: [whiteboardTool()] });
      const initialFullKey = within(topBar()).getByRole("button", {
        name: "Full screen (Shift+F)",
      });
      expect(initialFullKey).not.toHaveAttribute("aria-pressed");
      expect(initialFullKey).not.toHaveAttribute("data-active");
      expect(
        within(topBar()).queryByRole("button", { name: "Expand the stage" }),
      ).toBeNull();

      chooseTool("Whiteboard");
      const stageKey = within(topBar()).getByRole("button", {
        name: "Expand the stage",
      });
      const fullKey = within(topBar()).getByRole("button", {
        name: "Full screen (Shift+F)",
      });
      const close = within(topBar()).getByRole("button", { name: "Close" });
      // tool slot → stage focus → full screen → Close, all in the actions.
      expect(stageKey.previousElementSibling).toHaveClass(
        "media-p405-header-tool-slot",
      );
      expect(stageKey.nextElementSibling).toBe(fullKey);
      expect(fullKey.nextElementSibling).toBe(close);
      expect(fullKey).not.toHaveAttribute("aria-pressed");
      expect(fullKey).not.toHaveAttribute("data-active");
      expect(fullKey).toHaveAttribute("aria-keyshortcuts", "Shift+F");
      expect(fullKey).toHaveAttribute("data-tooltip", "Full screen (Shift+F)");
      expect(fullKey).toHaveAttribute("data-tooltip-side", "bottom");
      expect(stageKey).not.toHaveAttribute("aria-pressed");
      expect(stageKey).not.toHaveAttribute("data-active");
      expect(stageKey).toHaveAttribute("data-tooltip", "Expand the stage");
    });

    it("toggles document full screen from the key and Shift+F without remounting media", async () => {
      const { exit, request } = installFullscreenAPI({ enabled: true });
      const view = renderShell({ tools: [whiteboardTool()] });
      chooseTool("Whiteboard");
      const mediaTile = view.container.querySelector(".media-p405-grid > li");
      const videos = Array.from(view.container.querySelectorAll("video"));

      fireEvent.click(
        within(topBar()).getByRole("button", { name: "Full screen (Shift+F)" }),
      );
      await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      // Only the document element: portals on <body> stay in the tree.
      expect(request.mock.contexts[0]).toBe(root);
      const exitKey = await within(topBar()).findByRole("button", {
        name: "Exit full screen (Esc)",
      });
      expect(exitKey).toHaveAttribute("data-active", "true");
      expect(exitKey).toHaveAttribute("data-tooltip", "Exit full screen (Esc)");

      // Shift+F from the page leaves full screen.
      fireEvent.keyDown(document.body, { key: "F", shiftKey: true });
      await waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
      expect(
        await within(topBar()).findByRole("button", {
          name: "Full screen (Shift+F)",
        }),
      ).not.toHaveAttribute("data-active");

      // Typing, modifiers and auto-repeat never toggle it.
      const field = document.createElement("input");
      document.body.append(field);
      field.focus();
      fireEvent.keyDown(field, { key: "F", shiftKey: true });
      field.remove();
      const editor = document.createElement("div");
      editor.className = "cm-editor";
      const line = document.createElement("span");
      editor.append(line);
      document.body.append(editor);
      fireEvent.keyDown(line, { key: "F", shiftKey: true });
      editor.remove();
      fireEvent.keyDown(document.body, {
        ctrlKey: true,
        key: "F",
        shiftKey: true,
      });
      fireEvent.keyDown(document.body, {
        altKey: true,
        key: "F",
        shiftKey: true,
      });
      fireEvent.keyDown(document.body, {
        key: "F",
        repeat: true,
        shiftKey: true,
      });
      fireEvent.keyDown(document.body, { key: "f" });
      expect(request).toHaveBeenCalledTimes(1);

      fireEvent.keyDown(document.body, { key: "F", shiftKey: true });
      await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      await within(topBar()).findByRole("button", {
        name: "Exit full screen (Esc)",
      });
      // The browser's own Esc exit is mirrored through fullscreenchange.
      fullscreenElement = null;
      fireEvent(document, new Event("fullscreenchange"));
      expect(
        await within(topBar()).findByRole("button", {
          name: "Full screen (Shift+F)",
        }),
      ).toBeInTheDocument();

      expect(view.container.querySelector(".media-p405-grid > li")).toBe(
        mediaTile,
      );
      expect(Array.from(view.container.querySelectorAll("video"))).toEqual(
        videos,
      );
      expect(toolLifecycle.mounts).toBe(1);

      // Leaving the room undoes the full screen the room turned on.
      fireEvent.keyDown(document.body, { key: "F", shiftKey: true });
      await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(fullscreenElement).toBe(root));
      view.unmount();
      expect(exit).toHaveBeenCalledTimes(2);
    });

    it("falls back to a pseudo full screen without the Fullscreen API or after a refusal", async () => {
      installFullscreenAPI({ enabled: false });
      const view = renderShell({ tools: [whiteboardTool()] });
      const shell = view.container.querySelector(".media-p405-shell")!;

      // Works directly from the camera room before opening any tool.
      fireEvent.click(
        within(topBar()).getByRole("button", { name: "Full screen (Shift+F)" }),
      );
      expect(shell).toHaveAttribute("data-pseudo-fullscreen", "true");
      const exitKey = within(topBar()).getByRole("button", {
        name: "Exit full screen (Esc)",
      });
      expect(exitKey).toHaveAttribute("data-active", "true");
      // An unhandled Escape leaves the pseudo full screen.
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(shell).not.toHaveAttribute("data-pseudo-fullscreen");

      chooseTool("Whiteboard");
      fireEvent.keyDown(document.body, { key: "F", shiftKey: true });
      expect(shell).toHaveAttribute("data-pseudo-fullscreen", "true");
      fireEvent.click(within(topBar()).getByRole("button", { name: "Close" }));
      const lonelyKey = within(topBar()).getByRole("button", {
        name: "Exit full screen (Esc)",
      });
      fireEvent.click(lonelyKey);
      expect(shell).not.toHaveAttribute("data-pseudo-fullscreen");
      expect(
        within(topBar()).getByRole("button", {
          name: "Full screen (Shift+F)",
        }),
      ).toBeInTheDocument();
      view.unmount();

      // A refused request (permissions policy, no user activation) degrades
      // to the pseudo mode instead of an unhandled rejection.
      const refused = installFullscreenAPI({ enabled: true, rejects: true });
      const second = renderShell({ tools: [whiteboardTool()] });
      fireEvent.click(
        within(topBar()).getByRole("button", { name: "Full screen (Shift+F)" }),
      );
      await waitFor(() =>
        expect(
          second.container.querySelector(".media-p405-shell"),
        ).toHaveAttribute("data-pseudo-fullscreen", "true"),
      );
      expect(refused.request).toHaveBeenCalledTimes(1);
      second.unmount();
      expect(refused.exit).not.toHaveBeenCalled();
    });

    it("expands the stage over the camera column without remounting a video", () => {
      const view = renderShell({ tools: [whiteboardTool()] });
      const classroom = view.container.querySelector(".media-p405-classroom")!;
      const mediaStage = view.container.querySelector(".media-p405-stage");
      const mediaTile = view.container.querySelector(".media-p405-grid > li");
      chooseTool("Whiteboard");
      const videos = Array.from(view.container.querySelectorAll("video"));
      expect(videos.length).toBeGreaterThan(0);

      fireEvent.click(
        within(topBar()).getByRole("button", { name: "Expand the stage" }),
      );
      expect(classroom).toHaveClass(
        "media-p405-classroom--tool-stage",
        "media-p405-classroom--stage-focus",
      );
      const showKey = within(topBar()).getByRole("button", {
        name: "Show the video strip",
      });
      expect(showKey).toHaveAttribute("data-active", "true");
      expect(showKey).toHaveAttribute("data-tooltip", "Show the video strip");
      // Same nodes: the strip is hidden by CSS, never unmounted.
      expect(view.container.querySelector(".media-p405-stage")).toBe(
        mediaStage,
      );
      expect(view.container.querySelector(".media-p405-grid > li")).toBe(
        mediaTile,
      );
      expect(Array.from(view.container.querySelectorAll("video"))).toEqual(
        videos,
      );
      expect(videos.every((video) => video.isConnected)).toBe(true);
      expect(screen.getByText("Lazy whiteboard content")).toBeInTheDocument();

      fireEvent.click(showKey);
      expect(classroom).not.toHaveClass("media-p405-classroom--stage-focus");
      expect(Array.from(view.container.querySelectorAll("video"))).toEqual(
        videos,
      );

      // Closing the tool resets the choice for the next one.
      fireEvent.click(
        within(topBar()).getByRole("button", { name: "Expand the stage" }),
      );
      fireEvent.click(within(topBar()).getByRole("button", { name: "Close" }));
      expect(classroom).not.toHaveClass("media-p405-classroom--stage-focus");
      chooseTool("Whiteboard");
      expect(
        within(topBar()).getByRole("button", { name: "Expand the stage" }),
      ).not.toHaveAttribute("data-active");
      expect(toolLifecycle.mounts).toBe(2);

      // Below 960px the camera strip is a bottom row: no key, no class.
      Object.defineProperty(globalThis, "innerWidth", {
        configurable: true,
        value: 800,
      });
      fireEvent(window, new Event("resize"));
      expect(
        within(topBar()).queryByRole("button", { name: "Expand the stage" }),
      ).toBeNull();
      expect(classroom).not.toHaveClass("media-p405-classroom--stage-focus");
    });

    it("shows the roster sync notice as a slim status pill", () => {
      renderShell({ signals: createSignalControls({ loading: true }) });
      const notice = screen.getByText("Syncing the classroom roster...");
      expect(notice).toHaveAttribute("role", "status");
      expect(notice).toHaveClass(
        "media-p405-notice",
        "media-p405-notice--sync",
      );
    });
  });

  describe("ROOM-MEET-DOCK-04 room tooltip", () => {
    const roomTooltip = () => screen.getByTestId("room-tooltip");
    const hover = (element: HTMLElement, pointerType = "mouse") =>
      fireEvent.pointerOver(element, { pointerType });
    const leave = (element: HTMLElement, next: Element | null = null) =>
      fireEvent.pointerOut(element, {
        pointerType: "mouse",
        relatedTarget: next,
      });
    const advance = (milliseconds: number) =>
      act(() => {
        vi.advanceTimersByTime(milliseconds);
      });
    const studioShell = () =>
      renderShell({
        moderation: {
          canEndRoom: true,
          canLockRoom: true,
          mutationState: { status: "idle" },
          onDemoteCoHost: vi.fn(),
          onEndRoom: vi.fn(),
          onPromoteCoHost: vi.fn(),
          onRemoteMute: vi.fn(),
          onRemoveParticipant: vi.fn(),
          onSetRoomLocked: vi.fn(),
          participantOperations: [],
          providerEffect: { status: "idle" },
          roomLocked: false,
        },
        signals: createSignalControls(),
        tools: [
          {
            content: <TestWhiteboardTool />,
            icon: <span aria-hidden="true">W</span>,
            id: "whiteboard",
            label: "Whiteboard",
            title: "Classroom whiteboard",
          },
        ],
      });

    beforeEach(() => {
      vi.useFakeTimers();
      liveKitState.cameraTrackRefs = createCameraTracks(2);
      liveKitState.audioTrackRefs = createAudioTracks(2);
    });

    it("mounts one hidden, aria-hidden layer at the end of the shell", () => {
      const { container } = studioShell();
      const tooltip = roomTooltip();
      expect(tooltip).toHaveAttribute("aria-hidden", "true");
      expect(tooltip).not.toBeVisible();
      expect(tooltip).toHaveAttribute("data-state", "closed");
      expect(
        container.querySelector(".media-p405-shell")?.lastElementChild,
      ).toBe(tooltip);
      // The tooltip never names or describes a control a second time.
      expect(
        document.querySelector("[aria-describedby='room-tooltip']"),
      ).toBeNull();
    });

    it("waits 140ms on a first hover, then hands off to the next key at once", () => {
      studioShell();
      const share = screen.getByRole("button", { name: "Share screen" });
      const devices = screen.getByRole("button", { name: "Devices" });

      hover(share);
      advance(139);
      expect(roomTooltip()).not.toBeVisible();
      advance(1);
      expect(roomTooltip()).toBeVisible();
      expect(roomTooltip()).toHaveTextContent("Share screen");
      expect(roomTooltip()).toHaveAttribute("data-state", "open");
      expect(roomTooltip()).not.toHaveAttribute("data-instant");

      // Warm hand-off: sliding along the Dock moves the tooltip with 0ms.
      leave(share, devices);
      hover(devices);
      expect(roomTooltip()).toBeVisible();
      expect(roomTooltip()).toHaveTextContent("Devices");
      expect(roomTooltip()).toHaveAttribute("data-instant", "true");

      // After the 400ms warm window a fresh hover waits again.
      leave(devices);
      expect(roomTooltip()).not.toBeVisible();
      advance(401);
      hover(share);
      expect(roomTooltip()).not.toBeVisible();
      advance(140);
      expect(roomTooltip()).toHaveTextContent("Share screen");
    });

    it("stays quiet while the pointer sweeps across the Dock and never shows for touch", () => {
      studioShell();
      const share = screen.getByRole("button", { name: "Share screen" });
      const devices = screen.getByRole("button", { name: "Devices" });

      hover(share);
      advance(80);
      leave(share, devices);
      hover(devices);
      advance(80);
      expect(roomTooltip()).not.toBeVisible();
      leave(devices);
      advance(500);
      expect(roomTooltip()).not.toBeVisible();

      hover(share, "touch");
      advance(1_000);
      expect(roomTooltip()).not.toBeVisible();
    });

    it("shows at once for keyboard focus and follows the control's live name", async () => {
      studioShell();
      const camera = screen.getByRole("button", { name: "Turn camera on" });
      // A Tab press: the room now treats focus moves as keyboard focus.
      fireEvent.keyDown(document.body, { key: "Tab" });
      act(() => camera.focus());
      expect(roomTooltip()).toBeVisible();
      expect(roomTooltip()).toHaveTextContent("Turn camera on");

      // Space/Enter toggles the camera: the same open tooltip renames itself.
      fireEvent.click(camera);
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });
      const cameraOn = screen.getByRole("button", { name: "Turn camera off" });
      expect(cameraOn).toHaveAttribute("data-tooltip", "Turn camera off");
      expect(roomTooltip()).toHaveTextContent("Turn camera off");

      // Roving to the next key moves the tooltip with it.
      fireEvent.keyDown(cameraOn, { key: "ArrowRight" });
      expect(roomTooltip()).toHaveTextContent("Share screen");
    });

    it("hides on Escape without moving focus and on any press", () => {
      studioShell();
      const devices = screen.getByRole("button", { name: "Devices" });
      fireEvent.keyDown(document.body, { key: "Tab" });
      act(() => devices.focus());
      expect(roomTooltip()).toHaveTextContent("Devices");

      fireEvent.keyDown(devices, { key: "Escape" });
      expect(roomTooltip()).not.toBeVisible();
      expect(devices).toHaveFocus();
      // Dismissed while the pointer stays on the key.
      hover(devices);
      advance(500);
      expect(roomTooltip()).not.toBeVisible();
      leave(devices);

      const share = screen.getByRole("button", { name: "Share screen" });
      hover(share);
      advance(140);
      expect(roomTooltip()).toHaveTextContent("Share screen");
      fireEvent.pointerDown(share, { pointerType: "mouse" });
      expect(roomTooltip()).not.toBeVisible();

      // The focus a click leaves behind (pointer modality) stays silent.
      leave(share);
      act(() => share.focus());
      expect(roomTooltip()).not.toBeVisible();
    });

    it("never covers the popover, menu or drawer its control opens", async () => {
      studioShell();
      const devices = screen.getByRole("button", { name: "Devices" });
      hover(devices);
      advance(140);
      expect(roomTooltip()).toHaveTextContent("Devices");

      // A keyboard activation fires no pointerdown: the observer still hides
      // the tooltip as soon as the control reports aria-expanded="true".
      fireEvent.click(devices);
      expect(devices).toHaveAttribute("aria-expanded", "true");
      await act(async () => {
        await Promise.resolve();
      });
      expect(roomTooltip()).not.toBeVisible();

      // An already expanded control does not show a tooltip at all.
      leave(devices);
      advance(500);
      hover(devices);
      advance(500);
      expect(roomTooltip()).not.toBeVisible();
    });

    it("keeps the Classroom tools key's name while a tool is on the stage", () => {
      studioShell();
      const tools = toolsTrigger();
      chooseTool("Whiteboard");
      expect(tools).toHaveClass("th-button--primary");
      expect(tools).toHaveAttribute("aria-expanded", "false");
      hover(tools);
      advance(140);
      expect(roomTooltip()).toHaveTextContent("Classroom tools");
    });

    it("keeps Effects and End room off the Top Bar whose keys' tooltips hang below", () => {
      studioShell();
      const header = document.querySelector<HTMLElement>(
        "header.media-p405-header",
      )!;
      // ROOM-COMPACT-05: Effects lives only in the Dock; End room only in the
      // end-call popover.
      expect(
        within(header).queryByRole("button", { name: /Effects/ }),
      ).toBeNull();
      expect(
        within(header).queryByRole("button", { name: "End room" }),
      ).toBeNull();
      expect(
        screen.getAllByRole("button", { name: "Backgrounds and effects" }),
      ).toHaveLength(1);
      const lock = within(header).getByRole("button", { name: "Lock room" });
      expect(lock).toHaveAttribute("data-tooltip", "Lock room");
      expect(lock).toHaveAttribute("data-tooltip-side", "bottom");
      expect(lock.querySelector(".media-p405-button-label")).toHaveTextContent(
        "Lock room",
      );

      chooseTool("Whiteboard");
      const close = within(header).getByRole("button", { name: "Close" });
      expect(close).toHaveAttribute("data-tooltip", "Close");
      expect(close).toHaveClass("media-p405-header-close");
      hover(close);
      advance(140);
      expect(roomTooltip()).toHaveTextContent("Close");
      expect(roomTooltip()).toHaveAttribute("data-side", "bottom");
    });
  });

  describe("ROOM-COMPACT-05 Top Bar slot, layout menu and end-call control", () => {
    const hostModeration = (
      overrides: Partial<ClassroomModerationControlsModel> = {},
    ): ClassroomModerationControlsModel => ({
      canEndRoom: true,
      canLockRoom: true,
      mutationState: { status: "idle" },
      onDemoteCoHost: vi.fn().mockResolvedValue(undefined),
      onEndRoom: vi.fn().mockResolvedValue(undefined),
      onPromoteCoHost: vi.fn().mockResolvedValue(undefined),
      onRemoteMute: vi.fn().mockResolvedValue(undefined),
      onRemoveParticipant: vi.fn().mockResolvedValue(undefined),
      onSetRoomLocked: vi.fn().mockResolvedValue(undefined),
      participantOperations: [],
      providerEffect: { status: "idle" },
      roomLocked: false,
      ...overrides,
    });
    const popover = () => screen.queryByTestId("leave-end-popover");

    beforeEach(() => {
      liveKitState.cameraTrackRefs = createCameraTracks(2);
      liveKitState.audioTrackRefs = createAudioTracks(2);
    });

    it("lets an open tool portal its compact controls into the Top Bar slot", async () => {
      function SlotTool() {
        const slot = useContext(ClassroomHeaderSlotContext);
        return (
          <>
            <p>Board surface</p>
            {slot?.element
              ? createPortal(
                  <button type="button">Paper picker</button>,
                  slot.element,
                )
              : null}
          </>
        );
      }
      renderShell({
        tools: [
          {
            content: <SlotTool />,
            icon: <span aria-hidden="true">W</span>,
            id: "whiteboard",
            label: "Whiteboard",
            title: "Classroom whiteboard",
          },
        ],
      });
      const header = document.querySelector<HTMLElement>(
        "header.media-p405-header",
      )!;
      expect(
        within(header).queryByRole("button", { name: "Close" }),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: "Paper picker" })).toBeNull();

      chooseTool("Whiteboard");
      const paper = within(header).getByRole("button", {
        name: "Paper picker",
      });
      expect(paper.closest(".media-p405-header-tool-slot")).not.toBeNull();
      expect(screen.getByText("Board surface")).toBeInTheDocument();
      // No titlebar inside the stage: the heading only names it for AT.
      const heading = screen.getByRole("heading", {
        level: 2,
        name: "Classroom whiteboard",
      });
      expect(heading).toHaveClass("media-p405-sr-only");
      expect(
        screen.getByRole("region", { name: "Classroom whiteboard" }),
      ).toContainElement(heading);
      await waitFor(() => expect(heading).toHaveFocus());

      fireEvent.click(within(header).getByRole("button", { name: "Close" }));
      expect(screen.queryByRole("button", { name: "Paper picker" })).toBeNull();
      await waitFor(() => expect(toolsTrigger()).toHaveFocus());
    });

    it("turns the layout groove into one key whose menu marks the current mode", async () => {
      const view = renderShell();
      const trigger = screen.getByRole("button", { name: "Change layout" });
      expect(trigger).toHaveAttribute("id", "media-p405-control-layout");
      expect(trigger).toHaveAttribute("data-media-control", "layout");
      expect(trigger).toHaveAttribute("data-tooltip", "Change layout");

      const menu = openLayoutMenu();
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      expect(
        within(menu)
          .getAllByRole("menuitemradio")
          .map((item) => item.textContent),
      ).toEqual(["Grid", "Active speaker", "Presentation"]);
      expect(
        within(menu).getByRole("menuitemradio", { name: "Grid" }),
      ).toHaveAttribute("aria-checked", "true");
      // Presentation needs someone sharing a screen.
      expect(
        within(menu).getByRole("menuitemradio", { name: "Presentation" }),
      ).toHaveAttribute("aria-disabled", "true");

      fireEvent.click(
        within(menu).getByRole("menuitemradio", { name: "Active speaker" }),
      );
      expect(layoutMode(view.container)).toBe("active-speaker");
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(
        within(openLayoutMenu()).getByRole("menuitemradio", {
          name: "Active speaker",
        }),
      ).toHaveAttribute("aria-checked", "true");
    });

    it("gives a participant only Leave room with its tooltip and confirmation", () => {
      renderShell({
        moderation: hostModeration({ canEndRoom: false, canLockRoom: false }),
      });
      const leave = screen.getByRole("button", { name: "Leave room" });
      expect(leave).toHaveAttribute("id", "media-p405-control-leave");
      expect(leave).toHaveAttribute("data-tooltip", "Leave room");
      fireEvent.pointerEnter(leave, { pointerType: "mouse" });
      expect(popover()).toBeNull();

      fireEvent.click(leave);
      expect(
        screen.getByRole("heading", { name: "Leave the classroom?" }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "End room" })).toBeNull();
    });

    it("falls back to Leave room once the room's controls are terminated", () => {
      const controller = new AbortController();
      controller.abort();
      renderShell({
        controlAbortSignal: controller.signal,
        moderation: hostModeration(),
      });
      expect(
        screen.getByRole("button", { name: "Leave room" }),
      ).toHaveAttribute("data-tooltip", "Leave room");
      expect(
        screen.queryByRole("button", { name: "Leave or end room" }),
      ).toBeNull();
    });

    it("opens End room / Leave room on host hover and bridges the gap for 150ms", () => {
      vi.useFakeTimers();
      renderShell({ moderation: hostModeration() });
      const trigger = screen.getByRole("button", { name: "Leave or end room" });
      const root = trigger.closest<HTMLElement>(".media-p405-leave")!;
      expect(trigger).toHaveAttribute("id", "media-p405-control-leave");
      // The popover replaces the single tooltip, so none is declared.
      expect(trigger).not.toHaveAttribute("data-tooltip");
      expect(trigger).toHaveAttribute("aria-expanded", "false");

      fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
      const group = popover()!;
      expect(group).toHaveAttribute("role", "group");
      expect(group).toHaveAccessibleName("Leave options");
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      expect(trigger).toHaveAttribute("aria-controls", group.id);
      expect(
        within(group)
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual(["End room", "Leave room"]);

      // Sliding out and back within the grace period keeps it open.
      fireEvent.pointerLeave(root, { pointerType: "mouse" });
      act(() => {
        vi.advanceTimersByTime(100);
      });
      fireEvent.pointerEnter(
        within(group).getByRole("button", { name: "End room" }),
        { pointerType: "mouse" },
      );
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(popover()).not.toBeNull();

      fireEvent.pointerLeave(root, { pointerType: "mouse" });
      act(() => {
        vi.advanceTimersByTime(149);
      });
      expect(popover()).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(popover()).toBeNull();
      expect(trigger).toHaveAttribute("aria-expanded", "false");

      // Touch never opens it by hover.
      fireEvent.pointerEnter(trigger, { pointerType: "touch" });
      expect(popover()).toBeNull();
    });

    it("dismisses a hover-opened popover on Escape and only takes idle focus", () => {
      renderShell({ moderation: hostModeration() });
      const trigger = screen.getByRole("button", { name: "Leave or end room" });

      // Hovered, never focused: Escape still reaches it (WCAG 1.4.13).
      (document.activeElement as HTMLElement | null)?.blur();
      fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
      expect(popover()).not.toBeNull();
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(popover()).toBeNull();
      expect(trigger).toHaveFocus();

      // Focus resting on another control stays where it is.
      const microphone = screen.getByRole("button", {
        name: "Turn microphone on",
      });
      microphone.focus();
      fireEvent.pointerLeave(trigger.closest(".media-p405-leave")!, {
        pointerType: "mouse",
      });
      fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
      expect(popover()).not.toBeNull();
      // The focused key's tooltip takes the first Escape (topmost first).
      fireEvent.keyDown(microphone, { key: "Escape" });
      fireEvent.keyDown(microphone, { key: "Escape" });
      expect(popover()).toBeNull();
      expect(microphone).toHaveFocus();
    });

    it("opens from the keyboard on End room, roves, and closes on Escape or an outside press", async () => {
      renderShell({ moderation: hostModeration() });
      const trigger = screen.getByRole("button", { name: "Leave or end room" });
      trigger.focus();
      // Enter / Space report a click without pointer detail.
      fireEvent.click(trigger, { detail: 0 });
      const end = screen.getByRole("button", { name: "End room" });
      await waitFor(() => expect(end).toHaveFocus());
      fireEvent.keyDown(end, { key: "ArrowDown" });
      expect(screen.getByRole("button", { name: "Leave room" })).toHaveFocus();
      fireEvent.keyDown(document.activeElement as HTMLElement, {
        key: "Home",
      });
      expect(end).toHaveFocus();

      fireEvent.keyDown(end, { key: "Escape" });
      expect(popover()).toBeNull();
      expect(trigger).toHaveFocus();

      // A mouse click pins it; a second click or an outside press closes it.
      fireEvent.click(trigger, { detail: 1 });
      expect(popover()).not.toBeNull();
      expect(trigger).toHaveFocus();
      fireEvent.click(trigger, { detail: 1 });
      expect(popover()).toBeNull();
      fireEvent.click(trigger, { detail: 1 });
      fireEvent.pointerDown(document.body);
      expect(popover()).toBeNull();
    });

    it("confirms End room from the popover and hands focus back to the pill", async () => {
      const onEndRoom = vi.fn().mockResolvedValue(undefined);
      const view = renderShell({ moderation: hostModeration({ onEndRoom }) });
      const trigger = screen.getByRole("button", { name: "Leave or end room" });

      fireEvent.click(trigger, { detail: 1 });
      fireEvent.click(screen.getByRole("button", { name: "End room" }));
      expect(popover()).toBeNull();
      expect(
        screen.getByRole("heading", { name: "End this classroom?" }),
      ).toBeInTheDocument();
      fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[0]!);
      await waitFor(() =>
        expect(
          screen.queryByRole("heading", { name: "End this classroom?" }),
        ).toBeNull(),
      );
      await waitFor(() => expect(trigger).toHaveFocus());
      expect(onEndRoom).not.toHaveBeenCalled();

      fireEvent.click(trigger, { detail: 0 });
      fireEvent.click(await screen.findByRole("button", { name: "End room" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm end" }));
      await waitFor(() => expect(onEndRoom).toHaveBeenCalledTimes(1));
      view.rerender(
        shellElement({
          moderation: hostModeration({
            onEndRoom,
            providerEffect: { status: "applied", action: "end_room" },
          }),
        }),
      );
      await waitFor(() =>
        expect(
          screen.queryByRole("heading", { name: "End this classroom?" }),
        ).toBeNull(),
      );
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Leave or end room" }),
        ).toHaveFocus(),
      );
    });

    it("disables End room while a moderation command is in flight", () => {
      renderShell({
        moderation: hostModeration({
          mutationState: { status: "submitting", action: "lock_room" },
        }),
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Leave or end room" }),
        { detail: 1 },
      );
      expect(screen.getByRole("button", { name: "End room" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Leave room" })).toBeEnabled();
    });

    it("confirms Leave room from the host popover", async () => {
      const onLeave = vi.fn();
      renderShell({ moderation: hostModeration(), onLeave });
      const trigger = screen.getByRole("button", { name: "Leave or end room" });

      fireEvent.click(trigger, { detail: 1 });
      fireEvent.click(screen.getByRole("button", { name: "Leave room" }));
      expect(
        screen.getByRole("heading", { name: "Leave the classroom?" }),
      ).toBeInTheDocument();
      fireEvent.click(screen.getAllByRole("button", { name: "Stay" })[0]!);
      await waitFor(() => expect(trigger).toHaveFocus());
      expect(onLeave).not.toHaveBeenCalled();

      fireEvent.click(trigger, { detail: 1 });
      fireEvent.click(screen.getByRole("button", { name: "Leave room" }));
      fireEvent.click(screen.getByRole("button", { name: "Leave classroom" }));
      expect(onLeave).toHaveBeenCalledTimes(1);
    });
  });

  describe("ROOM-STAGE-POLISH-04 tile badges, floating reactions and tones", () => {
    const PARTICIPANT_C = "018f4c7b-9b0a-7a34-8a4c-96d26cb87223";
    const PARTICIPANT_D = "018f4c7b-9b0a-7a34-8a4c-96d26cb87224";
    const PARTICIPANT_E = "018f4c7b-9b0a-7a34-8a4c-96d26cb87225";
    const KEYS = [
      PARTICIPANT_A,
      PARTICIPANT_B,
      PARTICIPANT_C,
      PARTICIPANT_D,
      PARTICIPANT_E,
    ];
    const NAMES = [
      "Teacher One",
      "Student 1",
      "Student 2",
      "Student 3",
      "Student 4",
    ];
    const expiry = "2030-08-03T00:00:10Z";

    function useRoster(count: number) {
      liveKitState.cameraTrackRefs = createCameraTracks(count);
      liveKitState.cameraTrackRefs.forEach((track, index) => {
        track.participant.attributes = {
          "tutorhub.participant_key": KEYS[index]!,
        };
      });
      return KEYS.slice(0, count).map((participant_key, index) => ({
        participant_key,
        roster_sequence: index + 1,
        display_name: NAMES[index]!,
        instance_role: index === 0 ? ("host" as const) : ("attendee" as const),
        connection_state: "connected" as const,
      }));
    }

    function tileOf(container: HTMLElement, name: string) {
      const tile = Array.from(
        container.querySelectorAll<HTMLElement>(".media-p405-tile"),
      ).find(
        (candidate) =>
          candidate.querySelector(".media-p405-tile-meta > span")
            ?.textContent === name &&
          candidate.getAttribute("data-lk-source") === "camera",
      );
      if (!tile) throw new Error(`No camera tile for ${name}.`);
      return tile;
    }

    function hand(participantKey: string, position: number) {
      return {
        display_name: NAMES[KEYS.indexOf(participantKey)]!,
        participant_key: participantKey,
        queue_position: position,
        raised_at: "2030-08-03T00:00:00Z",
        signal_sequence: position,
      };
    }

    function reaction(
      participantKey: string,
      type: "clap" | "heart" | "thumbs_up",
      sequence: number,
    ) {
      return {
        participant_key: participantKey,
        reaction: type,
        signal_sequence: sequence,
        accepted_at: "2030-08-03T00:00:00Z",
        expires_at: expiry,
      };
    }

    it("puts the hand and the newest reaction in the top-right corner of the sender's own tile", () => {
      const roster = useRoster(3);
      const signals = createSignalControls({
        projection: {
          ...createSignalControls().projection!,
          roster,
          raised_hands: [hand(PARTICIPANT_B, 1), hand(PARTICIPANT_C, 2)],
          participant_reactions: [
            reaction(PARTICIPANT_B, "heart", 9),
            reaction(PARTICIPANT_A, "clap", 8),
          ],
        },
      });
      const view = renderShell({ signals });

      const student = tileOf(view.container, "Student 1");
      const badges = student.querySelector(".media-p406-tile-signals");
      expect(badges).toHaveAttribute("aria-hidden", "true");
      // Reaction first, hand last: the hand stays anchored in the corner.
      expect(Array.from(badges!.children, (child) => child.className)).toEqual([
        "media-p406-tile-reaction",
        "media-p406-tile-hand",
      ]);
      expect(
        badges!.querySelector(".media-p406-tile-reaction"),
      ).toHaveTextContent("❤️");
      expect(
        badges!.querySelector(".media-p406-tile-hand svg.lucide-hand"),
      ).not.toBeNull();
      // Two hands wait, so the queue number joins the hand.
      expect(
        badges!.querySelector(".media-p406-tile-hand__position"),
      ).toHaveTextContent("1");

      const teacher = tileOf(view.container, "Teacher One");
      expect(teacher.querySelector(".media-p406-tile-hand")).toBeNull();
      expect(
        teacher.querySelector(".media-p406-tile-reaction"),
      ).toHaveAttribute("data-reaction", "clap");

      const second = tileOf(view.container, "Student 2");
      expect(second.querySelector(".media-p406-tile-reaction")).toBeNull();
      expect(
        second.querySelector(".media-p406-tile-hand__position"),
      ).toHaveTextContent("2");
      // Badges never join the tile's accessible name (no double announcement).
      expect(student).toHaveAttribute("aria-label", "Video from Student 1");

      // One hand alone: Zoom / Meet style, no queue number.
      view.rerender(
        shellElement({
          signals: createSignalControls({
            projection: {
              ...signals.projection!,
              raised_hands: [hand(PARTICIPANT_B, 1)],
              participant_reactions: [],
            },
          }),
        }),
      );
      const alone = tileOf(view.container, "Student 1");
      expect(alone.querySelector(".media-p406-tile-hand")).not.toBeNull();
      expect(alone.querySelector(".media-p406-tile-hand__position")).toBeNull();
      expect(alone.querySelector(".media-p406-tile-reaction")).toBeNull();
      expect(
        tileOf(view.container, "Student 2").querySelector(
          ".media-p406-tile-signals",
        ),
      ).toBeNull();
    });

    it("re-pops the tile reaction for a newer signal and keeps badges on rail tiles only, never the share", async () => {
      const roster = useRoster(3);
      const projection = {
        ...createSignalControls().projection!,
        roster,
        raised_hands: [hand(PARTICIPANT_B, 1)],
        participant_reactions: [reaction(PARTICIPANT_B, "clap", 8)],
      };
      const view = renderShell({
        signals: createSignalControls({ projection }),
      });
      const first = tileOf(view.container, "Student 1").querySelector(
        ".media-p406-tile-reaction",
      );
      view.rerender(
        shellElement({
          signals: createSignalControls({
            projection: {
              ...projection,
              participant_reactions: [reaction(PARTICIPANT_B, "clap", 11)],
            },
          }),
        }),
      );
      const second = tileOf(view.container, "Student 1").querySelector(
        ".media-p406-tile-reaction",
      );
      expect(second).toHaveAttribute("data-reaction", "clap");
      // A new server sequence remounts the badge so the pop-in runs again.
      expect(second).not.toBe(first);

      liveKitState.screenShareTrackRefs = [
        {
          participant: liveKitState.cameraTrackRefs[2]!.participant,
          publication: new liveKitState.MockRemoteTrackPublication(),
          source: "screen_share",
        },
      ];
      view.rerender(
        shellElement({ signals: createSignalControls({ projection }) }),
      );
      await waitFor(() =>
        expect(layoutMode(view.container)).toBe("presentation"),
      );
      const share = view.container.querySelector<HTMLElement>(
        '.media-p405-tile--stage[data-lk-source="screen_share"]',
      );
      expect(share).not.toBeNull();
      expect(share!.querySelector(".media-p406-tile-signals")).toBeNull();
      expect(share).not.toHaveAttribute("data-tone");
      const railStudent = Array.from(
        view.container.querySelectorAll<HTMLElement>(
          ".media-p405-rail-list .media-p405-tile",
        ),
      ).find(
        (tile) =>
          tile.querySelector(".media-p405-tile-meta > span")?.textContent ===
          "Student 1",
      );
      expect(railStudent).toBeDefined();
      expect(
        railStudent!.querySelector(".media-p406-tile-hand"),
      ).not.toBeNull();
      expect(railStudent).toHaveAttribute("data-tone");
    });

    it("gives every camera-off tile a distinct Meet-style tone shared by its medallion", () => {
      const roster = useRoster(5);
      const signals = createSignalControls({
        projection: { ...createSignalControls().projection!, roster },
      });
      const view = renderShell({ signals });
      const tones = NAMES.map((name) => {
        const tile = tileOf(view.container, name);
        const tone = tile.getAttribute("data-tone");
        expect(tone).toMatch(/^[0-7]$/);
        expect(
          tile.querySelector(".media-p405-avatar")?.getAttribute("data-tone"),
        ).toBe(tone);
        return tone;
      });
      // Teacher One + Student 1..4: five different surfaces.
      expect(new Set(tones).size).toBe(5);

      // Stable for the whole session: polling a new snapshot keeps every tone.
      view.rerender(
        shellElement({
          signals: createSignalControls({
            projection: {
              ...signals.projection!,
              projection_version: 9,
              last_signal_sequence: 30,
            },
          }),
        }),
      );
      expect(
        NAMES.map((name) =>
          tileOf(view.container, name).getAttribute("data-tone"),
        ),
      ).toEqual(tones);

      // A two-person class never shares one surface.
      cleanup();
      const pair = useRoster(2);
      const pairView = renderShell({
        signals: createSignalControls({
          projection: { ...createSignalControls().projection!, roster: pair },
        }),
      });
      expect(
        tileOf(pairView.container, "Teacher One").getAttribute("data-tone"),
      ).not.toBe(
        tileOf(pairView.container, "Student 1").getAttribute("data-tone"),
      );
    });

    it("flies at most three bounded clusters with a deterministic sway and refreshes a cluster on a newer event", () => {
      const cluster = (
        type: "clap" | "heart" | "thumbs_up",
        first: number,
        count: number,
      ) => ({
        cluster_id: `${type}:${first}`,
        reaction: type,
        count,
        count_label: String(count),
        first_signal_sequence: first,
        last_signal_sequence: first + count - 1,
        accepted_at: "2030-08-03T00:00:00Z",
        expires_at: expiry,
      });
      const base = createSignalControls().projection!;
      const reactions = {
        clusters: [
          cluster("thumbs_up", 1, 1),
          cluster("clap", 2, 3),
          cluster("heart", 5, 2),
        ],
        hidden_cluster_count: 0,
        summary: [],
      };
      const view = renderShell({
        signals: createSignalControls({ projection: { ...base, reactions } }),
      });
      const region = view.container.querySelector(".media-p406-reactions");
      expect(region).toHaveAttribute("aria-hidden", "true");
      const clusters = Array.from(
        region!.querySelectorAll<HTMLElement>(".media-p406-reaction-cluster"),
      );
      expect(clusters).toHaveLength(3);
      for (const node of clusters) {
        const drift = Number.parseFloat(
          node.style.getPropertyValue("--reaction-drift-x"),
        );
        expect(Math.abs(drift)).toBeLessThanOrEqual(28);
        expect(
          node.querySelectorAll(".media-p406-reaction-echo").length,
        ).toBeLessThanOrEqual(2);
      }
      // Single reaction: glyph only. Grouped burst: ×N chip + bounded echoes.
      expect(
        clusters[0]!.querySelector(".media-p406-reaction-count"),
      ).toBeNull();
      expect(
        clusters[0]!.querySelectorAll(".media-p406-reaction-echo"),
      ).toHaveLength(0);
      expect(
        clusters[1]!.querySelector(".media-p406-reaction-count"),
      ).toHaveTextContent("×3");
      expect(
        clusters[1]!.querySelectorAll(".media-p406-reaction-echo"),
      ).toHaveLength(2);
      expect(
        clusters[2]!.querySelectorAll(".media-p406-reaction-echo"),
      ).toHaveLength(1);

      // Same clusters re-polled: nothing remounts mid-flight.
      view.rerender(
        shellElement({
          signals: createSignalControls({
            projection: { ...base, reactions: { ...reactions } },
          }),
        }),
      );
      const repolled = Array.from(
        view.container.querySelectorAll(".media-p406-reaction-cluster"),
      );
      expect(repolled[1]).toBe(clusters[1]);

      // One more clap joins the cluster: it remounts and flies again.
      view.rerender(
        shellElement({
          signals: createSignalControls({
            projection: {
              ...base,
              reactions: {
                ...reactions,
                clusters: [
                  reactions.clusters[0]!,
                  cluster("clap", 2, 4),
                  reactions.clusters[2]!,
                ],
              },
            },
          }),
        }),
      );
      const refreshed = Array.from(
        view.container.querySelectorAll(".media-p406-reaction-cluster"),
      );
      expect(refreshed).toHaveLength(3);
      expect(refreshed[1]).not.toBe(clusters[1]);
      expect(refreshed[0]).toBe(clusters[0]);
      expect(
        refreshed[1]!.querySelector(".media-p406-reaction-count"),
      ).toHaveTextContent("×4");
    });
  });

  describe("ROOM-TOOLS-CODE-01 Classroom tools popover", () => {
    const codeLifecycle = { mounts: 0, unmounts: 0 };
    function TestCodeTool() {
      useEffect(() => {
        codeLifecycle.mounts += 1;
        return () => {
          codeLifecycle.unmounts += 1;
        };
      }, []);
      return <p>Lazy code workspace</p>;
    }
    const tools = () => [
      {
        content: <TestWhiteboardTool />,
        icon: <span aria-hidden="true">W</span>,
        id: "whiteboard" as const,
        label: "Whiteboard",
        title: "Classroom whiteboard",
      },
      {
        content: <TestCodeTool />,
        icon: <span aria-hidden="true">C</span>,
        id: "code" as const,
        label: "Code",
        title: "Code tool",
      },
    ];

    beforeEach(() => {
      codeLifecycle.mounts = 0;
      codeLifecycle.unmounts = 0;
    });

    it("opens a non-modal grid dialog with 2D roving focus and Escape back to the key", async () => {
      renderShell({ tools: tools() });
      const trigger = toolsTrigger();
      expect(trigger).toHaveAttribute("id", "media-p506-control-tools");
      expect(trigger).toHaveAttribute("data-media-control", "tools");
      expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(trigger).toHaveClass("th-button--secondary");
      expect(
        screen.queryByRole("button", { name: "Whiteboard" }),
      ).not.toBeInTheDocument();

      trigger.focus();
      fireEvent.click(trigger);
      const popover = screen.getByRole("dialog", { name: "Classroom tools" });
      expect(popover).not.toHaveAttribute("aria-modal");
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      expect(trigger).toHaveAttribute("aria-controls", popover.id);
      expect(
        within(popover).getByRole("group", { name: "Present & collaborate" }),
      ).toBeInTheDocument();
      const board = within(popover).getByRole("button", { name: "Whiteboard" });
      const code = within(popover).getByRole("button", { name: "Code" });
      expect(board).toHaveAttribute("id", "media-p506-tool-option-whiteboard");
      expect(code).toHaveAttribute("id", "media-p506-tool-option-code");
      expect(board).toHaveAttribute("aria-pressed", "false");
      expect(board).toHaveAccessibleDescription(
        "Draw and teach on the shared board.",
      );
      await waitFor(() => expect(board).toHaveFocus());
      expect(board).toHaveAttribute("tabindex", "0");
      expect(code).toHaveAttribute("tabindex", "-1");

      fireEvent.keyDown(board, { key: "ArrowRight" });
      expect(code).toHaveFocus();
      expect(code).toHaveAttribute("tabindex", "0");
      fireEvent.keyDown(code, { key: "ArrowRight" });
      expect(board).toHaveFocus();
      fireEvent.keyDown(board, { key: "ArrowLeft" });
      expect(code).toHaveFocus();
      fireEvent.keyDown(code, { key: "Home" });
      expect(board).toHaveFocus();
      fireEvent.keyDown(board, { key: "End" });
      expect(code).toHaveFocus();
      // One row: Up / Down keep the current tile.
      fireEvent.keyDown(code, { key: "ArrowDown" });
      expect(code).toHaveFocus();
      fireEvent.keyDown(code, { key: "ArrowUp" });
      expect(code).toHaveFocus();

      fireEvent.keyDown(code, { key: "Escape" });
      expect(
        screen.queryByRole("dialog", { name: "Classroom tools" }),
      ).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
      expect(trigger).toHaveAttribute("aria-expanded", "false");
    });

    it("swaps Whiteboard and Code on one stage without remounting media", async () => {
      const view = renderShell({ tools: tools() });
      const mediaTile = view.container.querySelector(".media-p405-grid > li");
      const trigger = toolsTrigger();

      chooseTool("Whiteboard");
      await waitFor(() =>
        expect(
          screen.getByRole("heading", { name: "Classroom whiteboard" }),
        ).toHaveFocus(),
      );
      expect(trigger).toHaveAccessibleDescription("On stage: Whiteboard");

      chooseTool("Code");
      const stage = screen.getByRole("region", { name: "Code tool" });
      expect(stage).toHaveAttribute("id", "media-p506-stage-code");
      expect(
        screen.queryByRole("region", { name: "Classroom whiteboard" }),
      ).not.toBeInTheDocument();
      await waitFor(() =>
        expect(
          screen.getByRole("heading", { name: "Code tool" }),
        ).toHaveFocus(),
      );
      expect(toolLifecycle.unmounts).toBe(1);
      expect(codeLifecycle.mounts).toBe(1);
      expect(trigger).toHaveAccessibleDescription("On stage: Code");
      expect(view.container.querySelector(".media-p405-grid > li")).toBe(
        mediaTile,
      );
      const popover = openToolsPopover();
      expect(
        within(popover).getByRole("button", { name: "Code" }),
      ).toHaveAttribute("aria-pressed", "true");
      await waitFor(() =>
        expect(
          within(popover).getByRole("button", { name: "Code" }),
        ).toHaveFocus(),
      );
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });

      const header = document.querySelector<HTMLElement>(
        "header.media-p405-header",
      )!;
      const close = within(header).getByRole("button", { name: "Close" });
      expect(close).toHaveAttribute("id", "media-p506-close-code");
      fireEvent.click(close);
      await waitFor(() => expect(trigger).toHaveFocus());
      expect(codeLifecycle.unmounts).toBe(1);
      expect(view.container.querySelector(".media-p405-grid > li")).toBe(
        mediaTile,
      );
    });

    it("calls onStageClose only when the Documents stage is closed, not when replaced (ROOM-TOOLS-FILES-01B)", async () => {
      const onStageClose = vi.fn();
      renderShell({
        tools: [
          ...tools(),
          {
            content: <p>Documents viewer</p>,
            icon: <span aria-hidden="true">D</span>,
            id: "files" as const,
            label: "Documents",
            onStageClose,
            title: "Documents tool",
          },
        ],
      });
      const trigger = toolsTrigger();
      chooseTool("Documents");
      expect(
        screen.getByRole("region", { name: "Documents tool" }),
      ).toHaveAttribute("id", "media-p506-stage-files");
      // Switching to another tool keeps the Documents memory.
      chooseTool("Code");
      expect(onStageClose).not.toHaveBeenCalled();
      chooseTool("Documents");
      const header = document.querySelector<HTMLElement>(
        "header.media-p405-header",
      )!;
      fireEvent.click(within(header).getByRole("button", { name: "Close" }));
      await waitFor(() => expect(trigger).toHaveFocus());
      expect(onStageClose).toHaveBeenCalledTimes(1);
      // Choosing the open tile again also closes the stage.
      chooseTool("Documents");
      chooseTool("Documents");
      expect(onStageClose).toHaveBeenCalledTimes(2);
      expect(
        screen.queryByRole("region", { name: "Documents tool" }),
      ).not.toBeInTheDocument();
    });

    it("lets hosted content open a tool or the chat through the room actions", async () => {
      function ChatProbe() {
        const actions = useContext(ClassroomToolActionsContext);
        return (
          <>
            <p>Chat with code card</p>
            <button onClick={() => actions?.openTool("code")} type="button">
              Open card in Code
            </button>
          </>
        );
      }
      function CodeProbe() {
        const actions = useContext(ClassroomToolActionsContext);
        return (
          <button onClick={() => actions?.openChat()} type="button">
            Send code to chat
          </button>
        );
      }
      renderShell({
        chat: <ChatProbe />,
        tools: [
          ...tools().slice(0, 1),
          {
            content: <CodeProbe />,
            icon: <span aria-hidden="true">C</span>,
            id: "code" as const,
            label: "Code",
            title: "Code tool",
          },
        ],
      });

      chooseTool("Code");
      fireEvent.click(
        screen.getByRole("button", { name: "Send code to chat" }),
      );
      const drawer = await screen.findByRole("dialog", {
        name: "In-room chat",
      });
      expect(within(drawer).getByText("Chat with code card")).toBeVisible();

      // "Open in Code" only ever brings the tool onto the stage (no toggle).
      fireEvent.click(
        within(drawer).getByRole("button", { name: "Open card in Code" }),
      );
      expect(screen.getByRole("region", { name: "Code tool" })).toBeVisible();
      await waitFor(() =>
        expect(
          screen.getByRole("heading", { name: "Code tool" }),
        ).toHaveFocus(),
      );
      fireEvent.click(
        within(drawer).getByRole("button", { name: "Open card in Code" }),
      );
      expect(screen.getByRole("region", { name: "Code tool" })).toBeVisible();

      // Escape inside the tools popover never dismisses the open chat.
      const popover = openToolsPopover();
      await waitFor(() =>
        expect(
          within(popover).getByRole("button", { name: "Code" }),
        ).toHaveFocus(),
      );
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      expect(
        screen.queryByRole("dialog", { name: "Classroom tools" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("dialog", { name: "In-room chat" }),
      ).toBeInTheDocument();
    });

    it("hides the tools key when the room registers no tools", () => {
      renderShell();
      expect(
        screen.queryByRole("button", { name: "Classroom tools" }),
      ).not.toBeInTheDocument();
    });
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
      expect(clock?.closest(".media-p405-live-pill")).not.toBeNull();
      // ROOM-COMPACT-05: the polite status keeps the full sentence for AT;
      // sighted users read the short count beside the people glyph.
      const status = screen
        .getByText("Connected / 2 participants")
        .closest("p") as HTMLElement;
      expect(status).toHaveAttribute("role", "status");
      expect(status).toHaveAttribute("aria-live", "polite");
      expect(status).not.toContainElement(clock as HTMLElement);
      expect(within(status).getByText("2 joined")).toHaveAttribute(
        "aria-hidden",
        "true",
      );

      act(() => {
        vi.advanceTimersByTime(65_000);
      });
      expect(clock).toHaveTextContent(/^01:05$/);
      act(() => {
        vi.advanceTimersByTime(3_540_000);
      });
      expect(clock).toHaveTextContent(/^01:00:05$/);
      expect(screen.getByText("Connected / 2 participants").closest("p")).toBe(
        status,
      );
    });

    it("names the lesson in the Top Bar and keeps the generic heading for AT only", () => {
      liveKitState.cameraTrackRefs = createCameraTracks(1);
      liveKitState.audioTrackRefs = createAudioTracks(1);
      const view = renderShell({ roomTitle: "Math 10 - Quadratics" });
      const title = screen.getByRole("heading", {
        level: 1,
        name: "Math 10 - Quadratics",
      });
      expect(title).toHaveClass("media-p405-room-title");
      expect(screen.queryByText("TutorHub classroom")).toBeNull();

      view.rerender(shellElement({ roomTitle: null }));
      const fallback = screen.getByRole("heading", { level: 1 });
      expect(fallback).toHaveTextContent("TutorHub classroom");
      expect(fallback).toHaveClass("media-p405-sr-only");
      expect(
        view.container.querySelector(".media-p405-header-divider"),
      ).toBeNull();
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

    it("keeps an icon-only Dock with cluster dividers without changing names or roving order", () => {
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
            label: "Whiteboard",
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
        "tools",
        "layout",
        "roster",
      ]);
      // ROOM-MEET-DOCK-04: no caption under any icon; each key carries its
      // full accessible name as the room tooltip instead.
      expect(document.querySelector(".media-p405-dock-caption")).toBeNull();
      for (const name of [
        "Turn microphone on",
        "Turn camera on",
        "Share screen",
        "Devices",
        "Backgrounds and effects",
        "Raise hand",
        "Send a reaction",
        "Open in-room chat",
        "Classroom tools",
        "Change layout",
        "Open classroom roster",
      ]) {
        const button = within(toolbar).getByRole("button", { name });
        expect(button).toHaveAttribute("data-tooltip", name);
      }
      const leave = screen.getByRole("button", { name: "Leave room" });
      expect(leave).toHaveAttribute("data-tooltip", "Leave room");
      expect(leave.querySelector(".media-p405-sr-only")).toHaveTextContent(
        "Leave room",
      );
      // ROOM-COMPACT-05: one divider, before the end-call pill.
      const dividers = document.querySelectorAll(".media-p405-dock-divider");
      expect(dividers).toHaveLength(1);
      expect(dividers[0]?.nextElementSibling).toBe(leave);
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
        within(toolbar).getByRole("button", { name: "Open classroom roster" }),
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
        expect(layoutMode(view.container)).toBe("presentation"),
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
    // ROOM-COMPACT-05: no effects summary in the Top Bar any more; the
    // listen-only badge stays.
    expect(screen.queryByText(/^Effects:/)).toBeNull();
    expect(screen.getByText("Listen-only mode")).toBeInTheDocument();
    expect(toolbarOrder()).not.toContain("effects");
  });

  it("describes the active effect on the Dock key and opens a non-modal right drawer", async () => {
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
    const badge = screen.getByRole("button", {
      name: "Backgrounds and effects",
    });
    expect(badge).toHaveAccessibleDescription("On: Library");
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
    const effectsKey = () =>
      screen.getByRole("button", { name: "Backgrounds and effects" });
    expect(effectsKey()).toHaveAccessibleDescription("On: Slight blur");

    // Same mode: updated in place without flicker.
    fireEvent.click(
      within(drawer).getByRole("button", { name: "Strong blur" }),
    );
    await waitFor(() => expect(processors[0]?.applyPlan).toHaveBeenCalled());
    expect(track.setProcessor).toHaveBeenCalledTimes(1);

    // Off: the processor is removed and the raw camera restored.
    fireEvent.click(within(drawer).getByRole("button", { name: "None" }));
    await waitFor(() => expect(track.stopProcessor).toHaveBeenCalledTimes(1));
    expect(effectsKey()).not.toHaveAttribute("aria-describedby");

    // Lighting only: a lighting processor, no background pipeline.
    fireEvent.mouseDown(within(drawer).getByRole("tab", { name: "Lighting" }), {
      button: 0,
    });
    fireEvent.click(
      within(drawer).getByRole("radio", { name: "Low-light boost" }),
    );
    await waitFor(() => expect(track.setProcessor).toHaveBeenCalledTimes(2));
    expect(processors[1]?.visualEffectsMode).toBe("lighting");
    expect(effectsKey()).toHaveAccessibleDescription("On: Low-light boost");

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

/** ROOM-COMPACT-05: the Dock's single layout key opens a radio menu. */
function openLayoutMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: "Change layout" }), {
    button: 0,
    ctrlKey: false,
  });
  return screen.getByRole("menu", { name: "Layout mode" });
}

function chooseLayout(name: "Grid" | "Active speaker" | "Presentation") {
  const menu = openLayoutMenu();
  fireEvent.click(within(menu).getByRole("menuitemradio", { name }));
}

/** ROOM-TOOLS-CODE-01: the Dock's one Classroom tools key opens a popover. */
function toolsTrigger() {
  return screen.getByRole("button", { name: "Classroom tools" });
}

function openToolsPopover() {
  fireEvent.click(toolsTrigger());
  return screen.getByRole("dialog", { name: "Classroom tools" });
}

function chooseTool(name: string) {
  const popover = openToolsPopover();
  fireEvent.click(within(popover).getByRole("button", { name }));
}

function layoutMode(container: HTMLElement) {
  const classroom = container.querySelector(".media-p405-classroom");
  return (
    (["grid", "active-speaker", "presentation"] as const).find((mode) =>
      classroom?.classList.contains(`media-p405-classroom--${mode}`),
    ) ?? null
  );
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
