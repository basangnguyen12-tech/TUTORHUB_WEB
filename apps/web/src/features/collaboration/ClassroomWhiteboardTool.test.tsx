// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { APIRequestError, type WhiteboardDocument } from "@tutorhub/api-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../app/i18n";
import { ClassroomWhiteboardTool } from "./ClassroomWhiteboardTool";

const whiteboardMocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  tool: vi.fn(),
  transition: vi.fn(),
}));

vi.mock("../../app/whiteboards", () => ({
  usePrepareWhiteboard: whiteboardMocks.prepare,
  useTransitionWhiteboard: whiteboardMocks.transition,
  useWhiteboardTool: whiteboardMocks.tool,
}));

vi.mock("./LazyWhiteboardEngine", () => ({
  default: ({
    capability,
    onRecoveryRequired,
  }: {
    capability: string;
    onRecoveryRequired: () => void;
  }) => (
    <div>
      <p>Canonical engine capability: {capability}</p>
      <button onClick={onRecoveryRequired}>Simulate authority fence</button>
    </div>
  ),
}));

const document: WhiteboardDocument = {
  created_at: "2030-08-22T00:00:00Z",
  current_generation: 1,
  id: "21aac229-f1f6-4f21-85cf-3ecfe6f43529",
  media_space_id: "0e0f92c4-347c-4022-b4d1-c81208a972e3",
  revoke_generation: 1,
  status: "open",
  updated_at: "2030-08-22T00:00:00Z",
  version: 1,
  viewer_capabilities: {
    can_close: false,
    can_create_snapshot: false,
    can_exchange_grant: true,
    can_export: false,
    can_open: false,
    can_restore: false,
    can_resume: false,
    can_suspend: false,
    capability: "view",
  },
};

describe("ClassroomWhiteboardTool", () => {
  beforeEach(() => {
    whiteboardMocks.prepare.mockReturnValue({
      isError: false,
      isPending: false,
      mutate: vi.fn(),
    });
    whiteboardMocks.transition.mockReturnValue({
      isError: false,
      isPending: false,
      mutate: vi.fn(),
    });
  });

  afterEach(() => cleanup());

  it("projects a disabled tool as feature-off without querying the server", () => {
    whiteboardMocks.tool.mockReturnValue({
      isError: false,
      isPending: true,
    });

    render(
      <I18nProvider initialLanguage="en">
        <ClassroomWhiteboardTool
          actorID="b0f39fdb-0789-454d-8517-ae313dd81ca9"
          enabled={false}
          mediaSpaceID="0e0f92c4-347c-4022-b4d1-c81208a972e3"
          tenantID="2a388dc1-e3a5-4888-8d65-d9bd57fd4fc7"
        />
      </I18nProvider>,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Whiteboard is currently off for this environment.",
    );
    expect(whiteboardMocks.tool).toHaveBeenLastCalledWith(
      "2a388dc1-e3a5-4888-8d65-d9bd57fd4fc7",
      "0e0f92c4-347c-4022-b4d1-c81208a972e3",
      false,
    );
  });

  it.each([
    [503, "Whiteboard is currently off for this environment."],
    [403, "You do not have access to this whiteboard."],
  ])("projects HTTP %i without exposing a retry action", (status, message) => {
    whiteboardMocks.tool.mockReturnValue({
      error: new APIRequestError(status),
      isError: true,
      isPending: false,
      refetch: vi.fn(),
    });

    renderTool();

    expect(screen.getByText(message)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
  });

  it("keeps private-alpha limits, guidance, and support visible in error states", () => {
    whiteboardMocks.tool.mockReturnValue({
      error: new Error("bounded failure"),
      isError: true,
      isPending: false,
      refetch: vi.fn(),
    });

    renderTool();

    expect(
      screen.getByRole("heading", {
        level: 3,
        name: "Whiteboard trial guidance",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Limits: 2 documents, 10 concurrent connections, 64 MiB per document, and 600 operations/minute.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Render Free can cold-start, briefly interrupt service, and provides no HA.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Teacher quick-start")).toBeInTheDocument();
    expect(
      screen.getByText(/choose “Read whiteboard as text”/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", {
        name: "Open support and report a Private Alpha whiteboard issue",
      }),
    ).toHaveAttribute("href", "/app/settings?source=whiteboard-private-alpha");
  });

  it("keeps loading and retry states keyboard reachable", () => {
    const refetch = vi.fn();
    whiteboardMocks.tool.mockReturnValue({
      isError: false,
      isPending: true,
    });
    const view = renderTool();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking whiteboard access",
    );

    whiteboardMocks.tool.mockReturnValue({
      error: new Error("bounded failure"),
      isError: true,
      isPending: false,
      refetch,
    });
    view.rerender(toolElement());
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    expect(retry).toHaveFocus();
    retry.click();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("uses only server-projected create permission in the empty state", () => {
    whiteboardMocks.tool.mockReturnValue({
      data: { can_create: false, document: null },
      isError: false,
      isPending: false,
    });
    const view = renderTool();
    expect(
      screen.queryByRole("button", { name: "Prepare whiteboard" }),
    ).not.toBeInTheDocument();

    whiteboardMocks.tool.mockReturnValue({
      data: { can_create: true, document: null },
      isError: false,
      isPending: false,
    });
    view.rerender(toolElement());
    expect(
      screen.getByRole("button", { name: "Prepare whiteboard" }),
    ).toBeInTheDocument();
  });

  it("passes the exact server-projected view capability to the lazy engine", async () => {
    const refetch = vi.fn();
    whiteboardMocks.tool.mockReturnValue({
      data: { can_create: false, document },
      isError: false,
      isPending: false,
      refetch,
    });

    renderTool();

    expect(
      await screen.findByText("Canonical engine capability: view"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Suspend" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Presenting")).toBeInTheDocument();
    expect(
      screen.getAllByRole("link", {
        name: "Open support and report a Private Alpha whiteboard issue",
      }),
    ).toHaveLength(1);
    screen.getByRole("button", { name: "Simulate authority fence" }).click();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("tucks the private-alpha guidance into a compact trial disclosure on the document view", () => {
    whiteboardMocks.tool.mockReturnValue({
      data: { can_create: false, document },
      isError: false,
      isPending: false,
      refetch: vi.fn(),
    });

    const view = renderTool();

    const disclosure = view.container.querySelector(
      "details.whiteboard-trial-disclosure",
    );
    expect(disclosure).not.toBeNull();
    expect(disclosure).not.toHaveAttribute("open");
    expect(disclosure?.querySelector("summary")).toHaveTextContent(
      "Trial info",
    );
    // ROOM-MEET-DOCK-04: an Info key whose label feeds the room tooltip.
    expect(disclosure?.querySelector("summary")).toHaveAttribute(
      "data-tooltip",
      "Trial info",
    );
    expect(
      disclosure?.querySelector("summary .whiteboard-action-icon"),
    ).toHaveAttribute("aria-hidden", "true");
    expect(
      disclosure?.querySelector(".whiteboard-private-alpha-notice"),
    ).not.toBeNull();
    expect(
      view.container.querySelectorAll(".whiteboard-private-alpha-notice"),
    ).toHaveLength(1);
  });

  it("never prepares or opens on its own without autoStart", () => {
    const prepare = vi.fn();
    const transition = vi.fn();
    whiteboardMocks.prepare.mockReturnValue({
      isError: false,
      isPending: false,
      mutate: prepare,
    });
    whiteboardMocks.transition.mockReturnValue({
      isError: false,
      isPending: false,
      mutate: transition,
    });
    whiteboardMocks.tool.mockReturnValue({
      data: { can_create: true, document: null },
      isError: false,
      isPending: false,
    });
    const view = renderTool();
    whiteboardMocks.tool.mockReturnValue({
      data: { can_create: false, document: createdDocument() },
      isError: false,
      isPending: false,
      refetch: vi.fn(),
    });
    view.rerender(toolElement());

    expect(prepare).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it("prepares exactly once per media space when autoStart is on", () => {
    const prepare = vi.fn();
    whiteboardMocks.prepare.mockReturnValue({
      isError: false,
      isPending: false,
      mutate: prepare,
    });
    whiteboardMocks.tool.mockReturnValue({
      data: { can_create: true, document: null },
      isError: false,
      isPending: false,
    });

    const view = renderTool({ autoStart: true });
    view.rerender(toolElement({ autoStart: true }));
    view.rerender(toolElement({ autoStart: true }));

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Trial info")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        hidden: true,
        name: "Whiteboard trial guidance",
      }),
    ).not.toBeVisible();
  });

  it("does not auto-prepare without server create permission or after a failure", () => {
    const prepare = vi.fn();
    whiteboardMocks.prepare.mockReturnValue({
      isError: true,
      isPending: false,
      mutate: prepare,
    });
    whiteboardMocks.tool.mockReturnValue({
      data: { can_create: true, document: null },
      isError: false,
      isPending: false,
    });
    const view = renderTool({ autoStart: true });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The whiteboard could not be updated",
    );

    whiteboardMocks.prepare.mockReturnValue({
      isError: false,
      isPending: false,
      mutate: prepare,
    });
    whiteboardMocks.tool.mockReturnValue({
      data: { can_create: false, document: null },
      isError: false,
      isPending: false,
    });
    view.rerender(toolElement({ autoStart: true }));

    expect(prepare).not.toHaveBeenCalled();
  });

  it("opens a prepared whiteboard once when the server allows opening", () => {
    const transition = vi.fn();
    whiteboardMocks.transition.mockReturnValue({
      isError: false,
      isPending: false,
      mutate: transition,
    });
    const prepared = createdDocument();
    whiteboardMocks.tool.mockReturnValue({
      data: { can_create: false, document: prepared },
      isError: false,
      isPending: false,
      refetch: vi.fn(),
    });

    const view = renderTool({ autoStart: true });
    whiteboardMocks.tool.mockReturnValue({
      data: { can_create: false, document: { ...prepared } },
      isError: false,
      isPending: false,
      refetch: vi.fn(),
    });
    view.rerender(toolElement({ autoStart: true }));

    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition).toHaveBeenCalledWith({
      document: prepared,
      operation: "open",
    });
  });

  it("leaves a prepared whiteboard closed for viewers without open permission", () => {
    const transition = vi.fn();
    whiteboardMocks.transition.mockReturnValue({
      isError: false,
      isPending: false,
      mutate: transition,
    });
    whiteboardMocks.tool.mockReturnValue({
      data: {
        can_create: false,
        document: {
          ...createdDocument(),
          viewer_capabilities: {
            ...document.viewer_capabilities,
            can_open: false,
          },
        },
      },
      isError: false,
      isPending: false,
      refetch: vi.fn(),
    });

    renderTool({ autoStart: true });

    expect(transition).not.toHaveBeenCalled();
    expect(
      screen.getByText("The whiteboard is ready for a teacher to open."),
    ).toBeInTheDocument();
  });

  it("never re-opens a whiteboard the teacher deliberately paused", () => {
    const transition = vi.fn();
    whiteboardMocks.transition.mockReturnValue({
      isError: false,
      isPending: false,
      mutate: transition,
    });
    const presenting: WhiteboardDocument = {
      ...document,
      viewer_capabilities: {
        ...document.viewer_capabilities,
        can_suspend: true,
        capability: "edit",
      },
    };
    whiteboardMocks.tool.mockReturnValue({
      data: { can_create: false, document: presenting },
      isError: false,
      isPending: false,
      refetch: vi.fn(),
    });
    const view = renderTool({ autoStart: true });

    // ROOM-MEET-DOCK-04: Pause icon + label that names the key and its tooltip.
    const suspend = screen.getByRole("button", { name: "Suspend" });
    expect(suspend).toHaveAttribute("data-tooltip", "Suspend");
    expect(suspend).toHaveClass("whiteboard-action");
    expect(suspend.querySelector(".th-button__icon svg")).not.toBeNull();
    fireEvent.click(suspend);
    expect(transition).toHaveBeenCalledWith({
      document: presenting,
      operation: "suspend",
    });

    whiteboardMocks.tool.mockReturnValue({
      data: { can_create: false, document: createdDocument() },
      isError: false,
      isPending: false,
      refetch: vi.fn(),
    });
    view.rerender(toolElement({ autoStart: true }));

    expect(transition).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Open and present" }));
    expect(transition).toHaveBeenLastCalledWith({
      document: createdDocument(),
      operation: "open",
    });
  });
});

function createdDocument(): WhiteboardDocument {
  return {
    ...document,
    status: "created",
    viewer_capabilities: {
      ...document.viewer_capabilities,
      can_open: true,
      capability: "edit",
    },
  };
}

function renderTool(options: { autoStart?: boolean } = {}) {
  return render(toolElement(options));
}

function toolElement({ autoStart }: { autoStart?: boolean } = {}) {
  return (
    <I18nProvider initialLanguage="en">
      <ClassroomWhiteboardTool
        actorID="b0f39fdb-0789-454d-8517-ae313dd81ca9"
        autoStart={autoStart}
        enabled
        mediaSpaceID="0e0f92c4-347c-4022-b4d1-c81208a972e3"
        tenantID="2a388dc1-e3a5-4888-8d65-d9bd57fd4fc7"
      />
    </I18nProvider>
  );
}
