// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useContext, useEffect, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../app/i18n";
import { MediaLobbyFilterContext } from "../../components/MediaLobbyPanel";
import {
  ClassroomCodeEditorGrantsContext,
  type ClassroomCodeEditorGrantsModel,
} from "../classroom-tools/codeEditorGrantsContext";
import {
  ClassroomPdfAnnotatorGrantsContext,
  type ClassroomPdfAnnotatorGrantsModel,
} from "../classroom-tools/pdfAnnotatorGrantsContext";
import type { ClassroomModerationControlsModel } from "./ClassroomModerationControls";
import {
  ClassroomPeoplePanel,
  type ClassroomPeoplePanelProps,
  type ClassroomPeopleSignals,
} from "./ClassroomPeoplePanel";
import type {
  ClassroomRosterParticipant,
  ClassroomSignalProjection,
} from "./classroomSignals";

const key = (index: number) =>
  `018f4c7b-9b0a-7a34-8a4c-${String(index).padStart(12, "0")}`;

function person(
  index: number,
  display_name: string,
  overrides: Partial<ClassroomRosterParticipant> = {},
): ClassroomRosterParticipant {
  return {
    participant_key: key(index),
    roster_sequence: index,
    display_name,
    instance_role: "attendee",
    connection_state: "connected",
    ...overrides,
  };
}

function projection(
  overrides: Partial<ClassroomSignalProjection> = {},
): ClassroomSignalProjection {
  return {
    room_instance_id: "c5f918a5-a09e-4f94-9fab-fb0ab5702a4d",
    projection_version: 4,
    last_signal_sequence: 9,
    self_participant_key: key(3),
    viewer_operations: {
      can_raise_hand: true,
      can_send_reaction: true,
      can_moderate_hands: true,
    },
    roster: [
      person(1, "Thu Hà", { instance_role: "host" }),
      person(2, "Minh Anh"),
      person(3, "Gia Bảo"),
      person(4, "Phạm Quỳnh Như", { connection_state: "reconnecting" }),
      person(5, "Đức Huy", { connection_state: "joining" }),
      person(6, "Khánh Linh", { instance_role: "co_host" }),
    ],
    raised_hands: [
      {
        participant_key: key(5),
        signal_sequence: 7,
        raised_at: "2030-08-03T00:00:01Z",
        display_name: "Đức Huy",
        queue_position: 1,
      },
      {
        participant_key: key(2),
        signal_sequence: 8,
        raised_at: "2030-08-03T00:00:02Z",
        display_name: "Minh Anh",
        queue_position: 2,
      },
    ],
    reactions: { clusters: [], hidden_cluster_count: 0, summary: [] },
    server_time: "2030-08-03T00:00:00Z",
    ...overrides,
  };
}

function signals(
  overrides: Partial<ClassroomPeopleSignals> = {},
): ClassroomPeopleSignals {
  return {
    error: false,
    loading: false,
    mutating: false,
    projection: projection(),
    refreshing: false,
    onResync: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function moderation(
  operationsFor: readonly number[],
): ClassroomModerationControlsModel {
  const noop = vi.fn().mockResolvedValue(undefined);
  return {
    roomLocked: false,
    canLockRoom: true,
    canEndRoom: true,
    participantOperations: operationsFor.map((index) => ({
      participantKey: key(index),
      canPromoteCoHost: true,
      canDemoteCoHost: false,
      canRemoteMute: true,
      canRemove: false,
    })),
    mutationState: { status: "idle" },
    providerEffect: { status: "idle" },
    onSetRoomLocked: noop,
    onEndRoom: noop,
    onPromoteCoHost: noop,
    onDemoteCoHost: noop,
    onRemoteMute: noop,
    onRemoveParticipant: noop,
  };
}

function renderPanel(overrides: Partial<ClassroomPeoplePanelProps> = {}) {
  const onLowerAll = vi.fn();
  const onLowerHand = vi.fn();
  const view = render(
    <I18nProvider initialLanguage="en">
      <ClassroomPeoplePanel
        moderationDisabled={false}
        onLowerAll={onLowerAll}
        onLowerHand={onLowerHand}
        signals={signals()}
        {...overrides}
      />
    </I18nProvider>,
  );
  return { ...view, onLowerAll, onLowerHand };
}

function rowNames(list: HTMLElement) {
  return within(list)
    .getAllByRole("listitem")
    .map(
      (row) =>
        row.querySelector(".media-p406-people-row__display")?.textContent ?? "",
    );
}

afterEach(cleanup);

describe("ClassroomPeoplePanel (ROOM-PEOPLE-03)", () => {
  it("groups staff and students with counts and orders you → raised hands → roster_sequence", () => {
    renderPanel();

    expect(screen.getByRole("heading", { name: "In class" })).toBeVisible();
    const staffToggle = screen.getByRole("button", {
      name: "Teachers & organizers 2",
    });
    const studentToggle = screen.getByRole("button", { name: "Students 4" });
    expect(staffToggle).toHaveAttribute("aria-expanded", "true");
    expect(studentToggle).toHaveAttribute("aria-expanded", "true");

    expect(
      rowNames(screen.getByRole("list", { name: "Teachers & organizers" })),
    ).toEqual(["Thu Hà", "Khánh Linh"]);
    // You (Gia Bảo) first, then hands in FIFO queue order (Đức Huy #1,
    // Minh Anh #2), then roster_sequence — never alphabetical.
    expect(rowNames(screen.getByRole("list", { name: "Students" }))).toEqual([
      "Gia Bảo",
      "Đức Huy",
      "Minh Anh",
      "Phạm Quỳnh Như",
    ]);
    // No ordinal numbering; you are marked "(You)".
    expect(screen.getByText("(You)")).toBeVisible();
    expect(document.body.textContent).not.toMatch(/\b1\.\s/u);
  });

  it("merges a single-role class into one Participants group", () => {
    renderPanel({
      signals: signals({
        projection: projection({
          roster: [person(1, "Student A"), person(2, "Student B")],
          raised_hands: [],
          self_participant_key: key(1),
        }),
      }),
    });
    expect(
      screen.getByRole("button", { name: "Participants 2" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Teachers & organizers/ }),
    ).not.toBeInTheDocument();
  });

  it("hides the default Connected state and shows roles and unusual connections as a quiet second line", () => {
    renderPanel();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    expect(screen.getByText("Reconnecting…")).toHaveAttribute(
      "data-connection",
      "reconnecting",
    );
    expect(screen.getByText("Joining…")).toBeVisible();
    expect(screen.getByText("Host")).toBeVisible();
    expect(screen.getByText("Co-host")).toBeVisible();
    // Students carry no role pill or second line.
    const student = screen.getByText("Gia Bảo").closest("li") as HTMLElement;
    expect(student.querySelector(".media-p406-people-row__meta")).toBeNull();
  });

  it("searches people case- and accent-insensitively and offers a polite empty result", () => {
    renderPanel();
    const search = screen.getByRole("searchbox", { name: "Search for people" });

    fireEvent.change(search, { target: { value: "QUYNH nhu" } });
    expect(screen.getByText("Phạm Quỳnh Như")).toBeVisible();
    expect(screen.queryByText("Minh Anh")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Students 1" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Teachers & organizers/ }),
    ).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "duc" } });
    expect(screen.getByText("Đức Huy")).toBeVisible();

    fireEvent.change(search, { target: { value: "zzz" } });
    const empty = screen.getByRole("status");
    expect(empty).toHaveTextContent("No results for “zzz”");
    fireEvent.click(
      within(empty).getByRole("button", { name: "Clear search" }),
    );
    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
    expect(screen.getByText("Minh Anh")).toBeVisible();
  });

  it("shares the search with the waiting group and only reports no results when both are empty", () => {
    function TestLobby() {
      const filter = useContext(MediaLobbyFilterContext);
      const names = ["Lê Hoàng Nam"].filter(
        (name) => !filter?.active || filter.matches(name),
      );
      const report = filter?.onMatchCountChange;
      useEffect(() => report?.(names.length), [names.length, report]);
      return (
        <ul aria-label="Waiting">
          {names.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      );
    }
    renderPanel({ lobby: <TestLobby /> });
    const search = screen.getByRole("searchbox", { name: "Search for people" });

    fireEvent.change(search, { target: { value: "hoang" } });
    expect(screen.getByText("Lê Hoàng Nam")).toBeVisible();
    expect(screen.queryByText(/No results/)).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "nobody" } });
    expect(screen.queryByText("Lê Hoàng Nam")).not.toBeInTheDocument();
    expect(screen.getByText("No results for “nobody”")).toBeVisible();
  });

  it("collapses and expands each group with aria-expanded", () => {
    renderPanel();
    const toggle = screen.getByRole("button", { name: "Students 4" });
    const list = screen.getByRole("list", { name: "Students" });
    expect(toggle).toHaveAttribute("aria-controls", list.id);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(list).not.toBeVisible();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(list).toBeVisible();
  });

  it("keeps the ⋮ key keyboard-reachable with full names and exact server permissions", async () => {
    renderPanel({ moderation: moderation([2]) });

    // Only the server-granted target gets a menu; self and others get none.
    const trigger = screen.getByRole("button", { name: "Moderate Minh Anh" });
    expect(
      screen.queryByRole("button", { name: "Moderate Gia Bảo" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Moderate Thu Hà" }),
    ).not.toBeInTheDocument();
    // Revealed on hover by opacity only: still a real, tabbable button.
    expect(trigger).not.toHaveAttribute("tabindex", "-1");
    expect(
      trigger.closest("[hidden], [inert], [aria-hidden='true']"),
    ).toBeNull();
    expect(trigger.closest(".media-p406-people-row__actions")).not.toBeNull();
    trigger.focus();
    expect(trigger).toHaveFocus();

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    const menu = await screen.findByRole("menu", { name: "Moderate Minh Anh" });
    expect(
      within(menu).getByRole("menuitem", { name: "Promote to co-host" }),
    ).toBeVisible();
    expect(
      within(menu).getByRole("menuitem", { name: "Mute microphone remotely" }),
    ).toBeVisible();
    expect(
      within(menu).queryByRole("menuitem", { name: "Remove from room" }),
    ).not.toBeInTheDocument();
  });

  it("shows raised-hand chips, lets a moderator lower one hand and all hands from the pinned footer", () => {
    const { onLowerAll, onLowerHand } = renderPanel();

    const minh = screen.getByText("Minh Anh").closest("li") as HTMLElement;
    expect(
      within(minh).getByText("Hand raised, position 2"),
    ).toBeInTheDocument();
    fireEvent.click(
      within(minh).getByRole("button", { name: "Lower Minh Anh's hand" }),
    );
    expect(onLowerHand).toHaveBeenCalledWith(key(2));

    const footer = screen.getByRole("group", { name: "Host actions" });
    fireEvent.click(
      within(footer).getByRole("button", { name: "Lower all hands (2)" }),
    );
    expect(onLowerAll).toHaveBeenCalledTimes(1);
  });

  it("offers no hand controls without moderation authority", () => {
    const base = projection();
    renderPanel({
      signals: signals({
        projection: {
          ...base,
          viewer_operations: {
            ...base.viewer_operations,
            can_moderate_hands: false,
          },
        },
      }),
    });
    expect(screen.getByText("Hand raised, position 1")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Lower .*hand/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Host actions" }),
    ).not.toBeInTheDocument();
  });

  it("renders mic-off and speaking cues from joined media state only", () => {
    renderPanel({
      mediaStates: new Map([
        [key(1), { microphoneEnabled: true, speaking: true }],
        [key(2), { microphoneEnabled: false, speaking: false }],
      ]),
    });
    const host = screen.getByText("Thu Hà").closest("li") as HTMLElement;
    const minh = screen.getByText("Minh Anh").closest("li") as HTMLElement;
    const gia = screen.getByText("Gia Bảo").closest("li") as HTMLElement;
    expect(within(host).getByRole("img", { name: "Speaking" })).toBeVisible();
    expect(
      within(minh).getByRole("img", { name: "Microphone off" }),
    ).toBeVisible();
    // Unknown media state: no cue at all.
    expect(within(gia).queryByRole("img")).not.toBeInTheDocument();
  });

  it("covers loading, load error with retry, stale sync error and empty states", () => {
    const resync = vi.fn().mockResolvedValue(undefined);
    const view = renderPanel({
      signals: signals({ loading: true, projection: null }),
    });
    expect(
      screen.getByRole("status", { name: "Loading participants" }),
    ).toBeInTheDocument();

    const rerender = (node: ReactNode) =>
      view.rerender(<I18nProvider initialLanguage="en">{node}</I18nProvider>);
    const panel = (overrides: Partial<ClassroomPeopleSignals>) => (
      <ClassroomPeoplePanel
        moderationDisabled={false}
        onLowerAll={vi.fn()}
        onLowerHand={vi.fn()}
        signals={signals({ onResync: resync, ...overrides })}
      />
    );

    rerender(panel({ error: true, projection: null }));
    const alert = screen.getByRole("alert");
    fireEvent.click(
      within(alert).getByRole("button", { name: "Retry synchronization" }),
    );
    expect(resync).toHaveBeenCalledTimes(1);

    rerender(panel({ error: true }));
    expect(screen.getByText("The list could not be synced.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(resync).toHaveBeenCalledTimes(2);
    // Stale data stays readable under the notice.
    expect(screen.getByText("Minh Anh")).toBeVisible();

    rerender(
      panel({
        projection: projection({ roster: [], raised_hands: [] }),
      }),
    );
    expect(screen.getByText("Nobody is in the class yet.")).toBeVisible();
  });
});

describe("ClassroomPeoplePanel Code edit grants (ROOM-TOOLS-CODE-02B)", () => {
  const classroom = () =>
    signals({
      projection: projection({
        roster: [
          person(1, "Thu Hà", { instance_role: "host" }),
          person(2, "Minh Anh"),
          person(3, "Gia Bảo"),
          person(4, "Phạm Quỳnh Như", { connection_state: "reconnecting" }),
          person(7, "Lan Chi"),
          person(8, "Tuấn Tú"),
          person(9, "Hoà Bình"),
        ],
        raised_hands: [],
      }),
    });

  function codeGrants(
    overrides: Partial<ClassroomCodeEditorGrantsModel> = {},
  ): ClassroomCodeEditorGrantsModel {
    return {
      activeParticipantKeys: new Set<string>(),
      canManage: true,
      error: null,
      maxEditors: 3,
      pendingParticipantKey: null,
      onDismissError: vi.fn(),
      onGrant: vi.fn(),
      onRevoke: vi.fn(),
      ...overrides,
    };
  }

  function renderWithGrants(
    grants: ClassroomCodeEditorGrantsModel | null,
    overrides: Partial<ClassroomPeoplePanelProps> = {},
    language: "en" | "vi" = "en",
  ) {
    const panel = (value: ClassroomCodeEditorGrantsModel | null) => (
      <I18nProvider initialLanguage={language}>
        <ClassroomCodeEditorGrantsContext value={value}>
          <ClassroomPeoplePanel
            moderationDisabled={false}
            onLowerAll={vi.fn()}
            onLowerHand={vi.fn()}
            signals={classroom()}
            {...overrides}
          />
        </ClassroomCodeEditorGrantsContext>
      </I18nProvider>
    );
    const view = render(panel(grants));
    return {
      ...view,
      update: (value: ClassroomCodeEditorGrantsModel | null) =>
        view.rerender(panel(value)),
    };
  }

  const row = (name: string) =>
    screen.getByText(name).closest("li") as HTMLElement;

  async function openMenu(name: string) {
    const trigger = screen.getByRole("button", { name });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    return screen.findByRole("menu", { name });
  }

  it("marks only students holding an edit grant and changes nothing without a shared session", () => {
    const view = renderWithGrants(null);
    expect(
      screen.queryByRole("img", { name: "Can edit Code" }),
    ).not.toBeInTheDocument();
    // No Code session and no moderation: no ⋮ key at all.
    expect(
      screen.queryByRole("button", { name: /^(Actions for|Moderate) / }),
    ).not.toBeInTheDocument();

    view.update(
      codeGrants({
        activeParticipantKeys: new Set([key(2), key(1)]),
        canManage: false,
      }),
    );
    expect(
      within(row("Minh Anh")).getByRole("img", { name: "Can edit Code" }),
    ).toBeVisible();
    // Staff never carry the badge; other students neither.
    expect(
      within(row("Thu Hà")).queryByRole("img", { name: "Can edit Code" }),
    ).toBeNull();
    expect(
      within(row("Lan Chi")).queryByRole("img", { name: "Can edit Code" }),
    ).toBeNull();
    // Seeing the badge is not managing it.
    expect(
      screen.queryByRole("button", { name: "Actions for Minh Anh" }),
    ).not.toBeInTheDocument();
  });

  it("grants and revokes from the ⋮ menu even without room moderation rights", async () => {
    const grants = codeGrants();
    const view = renderWithGrants(grants);

    // Only connected students other than you are grant targets.
    expect(
      screen.queryByRole("button", { name: "Actions for Gia Bảo" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Actions for Thu Hà" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Actions for Phạm Quỳnh Như" }),
    ).not.toBeInTheDocument();

    let menu = await openMenu("Actions for Minh Anh");
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Let edit Code (10 min)" }),
    );
    expect(grants.onGrant).toHaveBeenCalledWith(key(2));
    expect(grants.onRevoke).not.toHaveBeenCalled();

    const granted = codeGrants({ activeParticipantKeys: new Set([key(2)]) });
    view.update(granted);
    expect(
      within(row("Minh Anh")).getByRole("img", { name: "Can edit Code" }),
    ).toBeVisible();
    menu = await openMenu("Actions for Minh Anh");
    expect(
      within(menu).queryByRole("menuitem", { name: /Let edit Code/ }),
    ).toBeNull();
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Stop Code editing" }),
    );
    expect(granted.onRevoke).toHaveBeenCalledWith(key(2));
    expect(granted.onGrant).not.toHaveBeenCalled();
  });

  it("puts the Code grant above the moderation actions in one menu", async () => {
    renderWithGrants(codeGrants(), { moderation: moderation([2]) });
    const menu = await openMenu("Moderate Minh Anh");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Let edit Code (10 min)",
      "Promote to co-host",
      "Mute microphone remotely",
    ]);
    expect(within(menu).getByRole("separator")).toBeInTheDocument();
  });

  it("locks granting once three other students edit, while revoking stays available", async () => {
    const grants = codeGrants({
      activeParticipantKeys: new Set([key(7), key(8), key(9)]),
    });
    renderWithGrants(grants);

    const menu = await openMenu("Actions for Minh Anh");
    const grant = within(menu).getByRole("menuitem", {
      name: /Let edit Code \(10 min\)/,
    });
    expect(grant).toHaveAttribute("aria-disabled", "true");
    expect(grant).toHaveTextContent("3 students are already editing");
    fireEvent.click(grant);
    expect(grants.onGrant).not.toHaveBeenCalled();
    fireEvent.keyDown(menu, { key: "Escape" });

    const other = await openMenu("Actions for Lan Chi");
    const revoke = within(other).getByRole("menuitem", {
      name: "Stop Code editing",
    });
    expect(revoke).not.toHaveAttribute("aria-disabled");
    fireEvent.click(revoke);
    expect(grants.onRevoke).toHaveBeenCalledWith(key(7));
  });

  it("disables the row's item while its grant change is in flight", async () => {
    renderWithGrants(codeGrants({ pendingParticipantKey: key(2) }));
    const menu = await openMenu("Actions for Minh Anh");
    expect(
      within(menu).getByRole("menuitem", { name: "Let edit Code (10 min)" }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("reports the three-editor limit and a failed change as dismissible alerts", () => {
    const grants = codeGrants({ error: "limit" });
    const view = renderWithGrants(grants, {}, "vi");
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Tối đa 3 học sinh được sửa cùng lúc");
    fireEvent.click(
      within(alert).getByRole("button", { name: "Đóng thông báo" }),
    );
    expect(grants.onDismissError).toHaveBeenCalledTimes(1);

    view.update(codeGrants({ error: "failed" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Chưa cập nhật được quyền sửa Code. Hãy thử lại.",
    );
    view.update(codeGrants());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("ClassroomPeoplePanel PDF annotator grants (ROOM-TOOLS-FILES-02B)", () => {
  const classroom = () =>
    signals({
      projection: projection({
        roster: [
          person(1, "Thu Hà", { instance_role: "host" }),
          person(2, "Minh Anh"),
          person(3, "Gia Bảo"),
          person(4, "Phạm Quỳnh Như", { connection_state: "reconnecting" }),
          person(7, "Lan Chi"),
          person(8, "Tuấn Tú"),
          person(9, "Hoà Bình"),
        ],
        raised_hands: [],
      }),
    });

  function pdfGrants(
    overrides: Partial<ClassroomPdfAnnotatorGrantsModel> = {},
  ): ClassroomPdfAnnotatorGrantsModel {
    return {
      activeParticipantKeys: new Set<string>(),
      canManage: true,
      error: null,
      maxAnnotators: 3,
      pendingParticipantKey: null,
      onDismissError: vi.fn(),
      onGrant: vi.fn(),
      onRevoke: vi.fn(),
      ...overrides,
    };
  }

  function codeGrants(
    overrides: Partial<ClassroomCodeEditorGrantsModel> = {},
  ): ClassroomCodeEditorGrantsModel {
    return {
      activeParticipantKeys: new Set<string>(),
      canManage: true,
      error: null,
      maxEditors: 3,
      pendingParticipantKey: null,
      onDismissError: vi.fn(),
      onGrant: vi.fn(),
      onRevoke: vi.fn(),
      ...overrides,
    };
  }

  function renderWithPdf(
    grants: ClassroomPdfAnnotatorGrantsModel | null,
    code: ClassroomCodeEditorGrantsModel | null = null,
    language: "en" | "vi" = "en",
  ) {
    const panel = (
      value: ClassroomPdfAnnotatorGrantsModel | null,
      codeValue: ClassroomCodeEditorGrantsModel | null,
    ) => (
      <I18nProvider initialLanguage={language}>
        <ClassroomCodeEditorGrantsContext value={codeValue}>
          <ClassroomPdfAnnotatorGrantsContext value={value}>
            <ClassroomPeoplePanel
              moderationDisabled={false}
              onLowerAll={vi.fn()}
              onLowerHand={vi.fn()}
              signals={classroom()}
            />
          </ClassroomPdfAnnotatorGrantsContext>
        </ClassroomCodeEditorGrantsContext>
      </I18nProvider>
    );
    const view = render(panel(grants, code));
    return {
      ...view,
      update: (
        value: ClassroomPdfAnnotatorGrantsModel | null,
        codeValue: ClassroomCodeEditorGrantsModel | null = code,
      ) => view.rerender(panel(value, codeValue)),
    };
  }

  const row = (name: string) =>
    screen.getByText(name).closest("li") as HTMLElement;

  async function openMenu(name: string) {
    const trigger = screen.getByRole("button", { name });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    return screen.findByRole("menu", { name });
  }

  it("shows the Documents drawing badge only on students holding a grant", () => {
    const view = renderWithPdf(null);
    expect(
      screen.queryByRole("img", { name: "Can draw on Documents" }),
    ).not.toBeInTheDocument();
    view.update(
      pdfGrants({
        activeParticipantKeys: new Set([key(2), key(1)]),
        canManage: false,
      }),
    );
    const badge = within(row("Minh Anh")).getByRole("img", {
      name: "Can draw on Documents",
    });
    expect(badge).toBeVisible();
    expect(badge).toHaveAttribute("data-people-tip", "Can draw on Documents");
    // It sits in the status column, so other status icons stay aligned.
    expect(badge.closest(".media-p406-people-row__status")).not.toBeNull();
    expect(
      within(row("Thu Hà")).queryByRole("img", {
        name: "Can draw on Documents",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Actions for Minh Anh" }),
    ).not.toBeInTheDocument();
  });

  it("grants and revokes Documents drawing (10 minutes) from the ⋮ menu", async () => {
    const grants = pdfGrants();
    const view = renderWithPdf(grants, null, "vi");
    expect(
      screen.queryByRole("button", { name: "Thao tác với Gia Bảo" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Thao tác với Phạm Quỳnh Như" }),
    ).not.toBeInTheDocument();

    let menu = await openMenu("Thao tác với Minh Anh");
    fireEvent.click(
      within(menu).getByRole("menuitem", {
        name: "Cho phép vẽ lên Tài liệu (10 phút)",
      }),
    );
    expect(grants.onGrant).toHaveBeenCalledWith(key(2));

    const granted = pdfGrants({ activeParticipantKeys: new Set([key(2)]) });
    view.update(granted);
    expect(
      within(row("Minh Anh")).getByRole("img", {
        name: "Đang được phép vẽ lên Tài liệu",
      }),
    ).toBeVisible();
    menu = await openMenu("Thao tác với Minh Anh");
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Thu hồi quyền vẽ Tài liệu" }),
    );
    expect(granted.onRevoke).toHaveBeenCalledWith(key(2));
  });

  it("locks granting at three annotators while revoking stays available", async () => {
    const grants = pdfGrants({
      activeParticipantKeys: new Set([key(7), key(8), key(9)]),
    });
    renderWithPdf(grants);
    const menu = await openMenu("Actions for Minh Anh");
    const grant = within(menu).getByRole("menuitem", {
      name: /Let draw on Documents \(10 min\)/,
    });
    expect(grant).toHaveAttribute("aria-disabled", "true");
    expect(grant).toHaveTextContent("3 students are already drawing");
    fireEvent.click(grant);
    expect(grants.onGrant).not.toHaveBeenCalled();
    fireEvent.keyDown(menu, { key: "Escape" });
    const other = await openMenu("Actions for Lan Chi");
    fireEvent.click(
      within(other).getByRole("menuitem", { name: "Stop Documents drawing" }),
    );
    expect(grants.onRevoke).toHaveBeenCalledWith(key(7));
  });

  it("keeps the Code and Documents grants apart when both sessions are open", async () => {
    const code = codeGrants({ activeParticipantKeys: new Set([key(2)]) });
    const pdf = pdfGrants();
    renderWithPdf(pdf, code);
    expect(
      within(row("Minh Anh")).getByRole("img", { name: "Can edit Code" }),
    ).toBeVisible();
    expect(
      within(row("Minh Anh")).queryByRole("img", {
        name: "Can draw on Documents",
      }),
    ).toBeNull();
    const menu = await openMenu("Actions for Minh Anh");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Stop Code editing", "Let draw on Documents (10 min)"]);
    expect(within(menu).getByRole("separator")).toBeInTheDocument();
    fireEvent.click(
      within(menu).getByRole("menuitem", {
        name: "Let draw on Documents (10 min)",
      }),
    );
    expect(pdf.onGrant).toHaveBeenCalledWith(key(2));
    expect(code.onRevoke).not.toHaveBeenCalled();
  });

  it("reports the annotator limit and a failed change as dismissible alerts", () => {
    const grants = pdfGrants({ error: "limit" });
    const view = renderWithPdf(grants, null, "vi");
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "Tối đa 3 học sinh được vẽ lên Tài liệu cùng lúc",
    );
    fireEvent.click(
      within(alert).getByRole("button", { name: "Đóng thông báo" }),
    );
    expect(grants.onDismissError).toHaveBeenCalledTimes(1);
    view.update(pdfGrants({ error: "failed" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Chưa cập nhật được quyền vẽ Tài liệu. Hãy thử lại.",
    );
  });
});
