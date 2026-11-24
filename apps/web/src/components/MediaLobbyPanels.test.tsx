// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { APIRequestError } from "@tutorhub/api-client";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useContext, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../app/i18n";
import {
  MediaLobbyFilterContext,
  MediaLobbyPanel,
  MediaLobbyWaitingCountContext,
  MediaLobbyWaitingCountProvider,
} from "./MediaLobbyPanel";
import { MediaSpaceInvitePanel } from "./MediaSpaceInvitePanel";

const lobbyMocks = vi.hoisted(() => ({
  admissions: vi.fn(),
  cancel: vi.fn(),
  invite: vi.fn(),
  members: vi.fn(),
  mutateMember: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("../app/mediaLobby", () => ({
  mediaLobbyIdempotencyKey: (action: string) => `media-${action}-fixed-key`,
  useMediaAdmissions: lobbyMocks.admissions,
  useInviteMediaSpaceMember: lobbyMocks.invite,
  useMediaSpaceMembers: lobbyMocks.members,
  useMutateMediaSpaceMember: lobbyMocks.mutateMember,
  useResolveMediaAdmission: lobbyMocks.resolve,
}));

const tenantID = "4b18543a-74de-419f-9fe8-d0c3dfc991eb";
const spaceID = "c2dc1048-1d90-4c90-ae50-5fb436bfb607";
const roomInstanceID = "c5f918a5-a09e-4f94-9fab-fb0ab5702a4d";
const admissionID = "d48a301d-c468-4f65-8da2-029fc379ee74";
const userID = "f680fd29-c7f1-4083-af9b-52ad1db14ba9";

function queryResult(data: unknown) {
  return {
    data,
    error: null,
    isError: false,
    isFetching: false,
    isPending: false,
    isRefetching: false,
    isSuccess: true,
    refetch: vi.fn(),
  };
}

function mutationResult() {
  return {
    error: null,
    isError: false,
    isPending: false,
    mutate: vi.fn(),
    reset: vi.fn(),
    variables: undefined,
  };
}

function renderEnglish(node: ReactNode) {
  return render(<I18nProvider initialLanguage="en">{node}</I18nProvider>);
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  lobbyMocks.admissions.mockReturnValue(
    queryResult({
      room_instance_id: roomInstanceID,
      room_instance_version: 3,
      items: [
        {
          id: admissionID,
          status: "waiting",
          version: 2,
          display_name: "Student One",
          created_at: "2030-08-03T00:00:00Z",
        },
      ],
    }),
  );
  lobbyMocks.members.mockReturnValue(
    queryResult({
      items: [
        {
          user_id: userID,
          display_name: "Student One",
          status: "active",
          version: 1,
          created_at: "2030-08-03T00:00:00Z",
          updated_at: "2030-08-03T00:00:00Z",
        },
      ],
    }),
  );
  lobbyMocks.resolve.mockReturnValue(mutationResult());
  lobbyMocks.invite.mockReturnValue(mutationResult());
  lobbyMocks.mutateMember.mockReturnValue(mutationResult());
});

describe("MediaLobbyPanel", () => {
  it("renders a privacy-bounded queue and submits an exact admit CAS", () => {
    renderEnglish(
      <MediaLobbyPanel
        enabled
        roomInstanceID={roomInstanceID}
        roomInstanceVersion={3}
        spaceID={spaceID}
        spaceVersion={5}
        tenantID={tenantID}
      />,
    );

    // ROOM-PEOPLE-03: a Meet-style "Waiting to join" group with a counted,
    // collapsible box and one slim row per request (no manual refresh).
    expect(
      screen.getByRole("heading", { name: "Waiting to join" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Waiting to be admitted 1" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Student One")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Refresh/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Admit Student One" }),
    ).toHaveTextContent("Admit");
    expect(document.body).not.toHaveTextContent("student@example.test");
    fireEvent.click(screen.getByRole("button", { name: "Admit Student One" }));

    expect(lobbyMocks.resolve().mutate).toHaveBeenCalledWith(
      {
        action: "admit",
        admissionID,
        input: {
          expected_space_version: 5,
          expected_room_instance_id: roomInstanceID,
          expected_room_instance_version: 3,
          expected_admission_version: 2,
          idempotency_key: "media-admission-admit-fixed-key",
        },
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("requires confirmation before denying a waiting participant", async () => {
    renderEnglish(
      <MediaLobbyPanel
        enabled
        roomInstanceID={roomInstanceID}
        roomInstanceVersion={3}
        spaceID={spaceID}
        spaceVersion={5}
        tenantID={tenantID}
      />,
    );

    // ROOM-PEOPLE-03: Deny moved into the row's ⋮ menu; it still confirms.
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "More actions for Student One" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Deny" }));
    expect(
      await screen.findByRole("heading", { name: "Deny this join request?" }),
    ).toBeVisible();
    expect(lobbyMocks.resolve().mutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm denial" }));
    expect(lobbyMocks.resolve().mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "deny",
        admissionID,
        input: expect.objectContaining({ reason_code: "moderator_denied" }),
      }),
      expect.any(Object),
    );
  });

  it("ROOM-PEOPLE-03 hides the group while nobody waits, then reopens and announces a new request", () => {
    const waitingItem = (id: string, name: string) => ({
      id,
      status: "waiting",
      version: 1,
      display_name: name,
      created_at: "2030-08-03T00:00:00Z",
    });
    lobbyMocks.admissions.mockReturnValue(queryResult({ items: [] }));
    // A fresh element each time, so React re-reads the mocked query.
    const panel = () => (
      <MediaLobbyPanel
        enabled
        roomInstanceID={roomInstanceID}
        roomInstanceVersion={3}
        spaceID={spaceID}
        spaceVersion={5}
        tenantID={tenantID}
      />
    );
    const view = renderEnglish(panel());

    // Empty: no heading, no box, no description card — only a silent region.
    expect(
      screen.queryByRole("heading", { name: "Waiting to join" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    const live = screen.getByRole("status");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("");

    lobbyMocks.admissions.mockReturnValue(
      queryResult({ items: [waitingItem("a", "Student One")] }),
    );
    view.rerender(<I18nProvider initialLanguage="en">{panel()}</I18nProvider>);
    expect(
      screen.getByRole("heading", { name: "Waiting to join" }),
    ).toBeVisible();
    expect(live).toHaveTextContent("Someone asked to join. 1 waiting.");

    // A collapsed group re-opens by itself when someone else asks to join.
    const toggle = screen.getByRole("button", {
      name: "Waiting to be admitted 1",
    });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const list = document.getElementById(
      toggle.getAttribute("aria-controls") ?? "",
    );
    expect(list).toHaveAttribute("aria-label", "People waiting to be admitted");
    expect(list).not.toBeVisible();
    lobbyMocks.admissions.mockReturnValue(
      queryResult({
        items: [
          waitingItem("a", "Student One"),
          waitingItem("b", "Student Two"),
        ],
      }),
    );
    view.rerender(<I18nProvider initialLanguage="en">{panel()}</I18nProvider>);
    expect(
      screen.getByRole("button", { name: "Waiting to be admitted 2" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(live).toHaveTextContent("Someone asked to join. 2 waiting.");
    expect(screen.getByText("Student Two")).toBeVisible();
  });

  it("ROOM-PEOPLE-03 follows the People search and reports its matches", () => {
    lobbyMocks.admissions.mockReturnValue(
      queryResult({
        items: [
          {
            id: "a",
            status: "waiting",
            version: 1,
            display_name: "Phạm Quỳnh Như",
          },
          {
            id: "b",
            status: "waiting",
            version: 1,
            display_name: "Lê Hoàng Nam",
          },
        ],
      }),
    );
    const onMatchCountChange = vi.fn();
    renderEnglish(
      <MediaLobbyFilterContext
        value={{
          active: true,
          matches: (name) => name.includes("Như"),
          onMatchCountChange,
        }}
      >
        <MediaLobbyPanel
          enabled
          roomInstanceID={roomInstanceID}
          roomInstanceVersion={3}
          spaceID={spaceID}
          spaceVersion={5}
          tenantID={tenantID}
        />
      </MediaLobbyFilterContext>,
    );

    expect(screen.getByText("Phạm Quỳnh Như")).toBeVisible();
    expect(screen.queryByText("Lê Hoàng Nam")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Waiting to be admitted 1" }),
    ).toBeVisible();
    expect(onMatchCountChange).toHaveBeenLastCalledWith(1);
  });

  it("fails closed when moderation authority is revoked mid-session", () => {
    lobbyMocks.resolve.mockReturnValue({
      ...mutationResult(),
      error: new APIRequestError(403),
      isError: true,
    });

    renderEnglish(
      <MediaLobbyPanel
        enabled
        roomInstanceID={roomInstanceID}
        roomInstanceVersion={3}
        spaceID={spaceID}
        spaceVersion={5}
        tenantID={tenantID}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "The waiting room is unavailable" }),
    ).toBeVisible();
    expect(screen.queryByText("Student One")).not.toBeInTheDocument();
  });
});

function WaitingCountProbe() {
  return (
    <output aria-label="Waiting count">
      {useContext(MediaLobbyWaitingCountContext)}
    </output>
  );
}

function renderWaitingCount(enabled: boolean) {
  return renderEnglish(
    <MediaLobbyWaitingCountProvider
      enabled={enabled}
      roomInstanceID={roomInstanceID}
      roomInstanceVersion={3}
      spaceID={spaceID}
      spaceVersion={5}
      tenantID={tenantID}
    >
      <WaitingCountProbe />
    </MediaLobbyWaitingCountProvider>,
  );
}

describe("MediaLobbyWaitingCountProvider", () => {
  it("publishes only waiting admissions from the shared lobby query", () => {
    lobbyMocks.admissions.mockReturnValue(
      queryResult({
        room_instance_id: roomInstanceID,
        room_instance_version: 3,
        items: [
          { id: "a", status: "waiting", version: 1, display_name: "One" },
          { id: "b", status: "admitted", version: 2, display_name: "Two" },
          { id: "c", status: "waiting", version: 1, display_name: "Three" },
          { id: "d", status: "denied", version: 3, display_name: "Four" },
        ],
      }),
    );

    renderWaitingCount(true);

    expect(screen.getByLabelText("Waiting count")).toHaveTextContent("2");
    expect(lobbyMocks.admissions).toHaveBeenLastCalledWith(
      tenantID,
      spaceID,
      roomInstanceID,
      5,
      3,
      true,
    );
    expect(document.body).not.toHaveTextContent("Three");
  });

  it("fails closed to zero while disabled or when the queue cannot be read", () => {
    const view = renderWaitingCount(false);
    expect(screen.getByLabelText("Waiting count")).toHaveTextContent("0");
    expect(lobbyMocks.admissions).toHaveBeenLastCalledWith(
      tenantID,
      spaceID,
      roomInstanceID,
      5,
      3,
      false,
    );

    lobbyMocks.admissions.mockReturnValue({
      ...queryResult(undefined),
      error: new APIRequestError(403),
      isError: true,
      isSuccess: false,
    });
    view.unmount();
    renderWaitingCount(true);
    expect(screen.getByLabelText("Waiting count")).toHaveTextContent("0");
  });
});

describe("MediaSpaceInvitePanel", () => {
  it("normalizes an explicit member email without rendering it in the grant list", () => {
    renderEnglish(
      <MediaSpaceInvitePanel
        enabled
        spaceID={spaceID}
        spaceVersion={5}
        tenantID={tenantID}
      />,
    );

    fireEvent.change(
      screen.getByRole("textbox", { name: "Workspace member email" }),
      { target: { value: " Student@Example.Test " } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Invite member" }));

    expect(lobbyMocks.invite().mutate).toHaveBeenCalledWith(
      {
        target_member_email: "student@example.test",
        expected_space_version: 5,
        idempotency_key: "media-member-invite-fixed-key",
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    expect(screen.getByText("Student One")).toBeVisible();
    expect(document.body).not.toHaveTextContent("student@example.test");
  });

  it("confirms revocation before sending the exact member version", () => {
    renderEnglish(
      <MediaSpaceInvitePanel
        enabled
        spaceID={spaceID}
        spaceVersion={5}
        tenantID={tenantID}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Revoke Student One's access" }),
    );
    expect(
      screen.getByRole("heading", {
        name: "Revoke this member's access?",
      }),
    ).toBeVisible();
    expect(lobbyMocks.mutateMember().mutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm revocation" }));
    expect(lobbyMocks.mutateMember().mutate).toHaveBeenCalledWith(
      {
        action: "revoke",
        userID,
        input: {
          expected_member_version: 1,
          expected_space_version: 5,
          idempotency_key: "media-member-revoke-fixed-key",
          reason_code: "owner_revoked",
        },
      },
      expect.any(Object),
    );
  });

  it("keeps an exact-member 404 generic without hiding existing grants", () => {
    lobbyMocks.invite.mockReturnValue({
      ...mutationResult(),
      error: new APIRequestError(404),
      isError: true,
    });

    renderEnglish(
      <MediaSpaceInvitePanel
        enabled
        spaceID={spaceID}
        spaceVersion={5}
        tenantID={tenantID}
      />,
    );

    expect(screen.getByText("Student One")).toBeVisible();
    expect(
      screen.getByText(
        "This account cannot be invited. Check that it is an active member of the workspace.",
      ),
    ).toBeVisible();
  });
});
