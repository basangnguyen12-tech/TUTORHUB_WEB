// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { WhiteboardDocument } from "@tutorhub/api-client";
import type { CanonicalElementV1 } from "@tutorhub/collaboration-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../app/i18n";
import LazyWhiteboardEngine, {
  CanonicalExcalidrawCanvas,
  type WhiteboardCanvasAuthority,
} from "./LazyWhiteboardEngine";

const engineMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  grant: vi.fn(),
  status: null as null | ((status: string) => void),
  terminal: null as null | ((reason: string) => void),
}));

vi.mock("@excalidraw/excalidraw", () => ({
  Excalidraw: () => <div>Excalidraw canvas</div>,
}));

vi.mock("@tutorhub/collaboration-client", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@tutorhub/collaboration-client")>();
  return {
    ...original,
    createBrowserCollaborationSession: engineMocks.createSession,
  };
});

vi.mock("../../app/whiteboards", () => ({
  requestWhiteboardGrant: engineMocks.grant,
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

const authority = {
  getProjection: () => ({
    appState: { viewBackgroundColor: "#ffffff" },
    elements: [],
    files: {},
    page: { backgroundColor: "#ffffff", id: "page-1", name: "Page 1" },
  }),
  getScene: () => ({ elements: [], files: {}, metadata: {}, page: {} }),
  getSemanticHash: () => "empty",
  subscribe: () => () => undefined,
};

const semanticElements: CanonicalElementV1[] = Array.from(
  { length: 55 },
  (_, index) => ({
    height: 80,
    id: `shape-${index + 1}`,
    text: `Lesson shape ${index + 1}`,
    type: "rectangle",
    width: 120,
    x: index * 10,
    y: index * 5,
  }),
);

const semanticAuthority: WhiteboardCanvasAuthority = {
  getProjection: () => ({
    appState: { viewBackgroundColor: "#ffffff" },
    elements: semanticElements,
    files: {},
    page: { id: "page-1", name: "Page 1" },
  }),
  getScene: () => ({
    elements: semanticElements,
    files: {},
    page: { backgroundColor: "#ffffff", id: "page-1", name: "Page 1" },
    schemaVersion: 1,
  }),
  getSemanticHash: () => "semantic-fixture",
  redo: () => true,
  replaceScene: () => undefined,
  subscribe: () => () => undefined,
  undo: () => true,
};

describe("LazyWhiteboardEngine", () => {
  beforeEach(() => {
    engineMocks.grant.mockClear();
    engineMocks.createSession.mockClear();
    engineMocks.status = null;
    engineMocks.terminal = null;
    engineMocks.grant.mockResolvedValue({
      capability: "view",
      credential: "opaque-credential-that-is-long-enough",
      document_id: document.id,
      expires_at: "2030-08-22T00:05:00Z",
      generation: 1,
      provider_url: "wss://collaboration.example.test",
      revoke_generation: 1,
    });
    engineMocks.createSession.mockImplementation(async (options) => {
      engineMocks.status = options.onStatus;
      engineMocks.terminal = options.onTerminal;
      options.onStatus?.("connected");
      return {
        authority,
        capability: "view",
        destroy: vi.fn(),
        generation: 1,
      };
    });
  });

  afterEach(() => cleanup());

  it("announces read-only and reconnect states while retaining the semantic fallback", async () => {
    render(
      <I18nProvider initialLanguage="en">
        <LazyWhiteboardEngine
          actorID="b0f39fdb-0789-454d-8517-ae313dd81ca9"
          capability="view"
          document={document}
          tenantID="2a388dc1-e3a5-4888-8d65-d9bd57fd4fc7"
        />
      </I18nProvider>,
    );

    expect(
      await screen.findByText(/Whiteboard connected.*View only/),
    ).toBeInTheDocument();
    expect(screen.getByText("The whiteboard is empty.")).toBeInTheDocument();
    expect(screen.getByText("Excalidraw canvas")).toBeInTheDocument();

    act(() => engineMocks.status?.("reconnecting"));
    expect(
      screen.getByText(/Restoring the whiteboard connection.*View only/),
    ).toBeInTheDocument();
  });

  it("requests a control-plane refresh after a terminal generation fence", async () => {
    const onRecoveryRequired = vi.fn();
    render(
      <I18nProvider initialLanguage="en">
        <LazyWhiteboardEngine
          actorID="b0f39fdb-0789-454d-8517-ae313dd81ca9"
          capability="view"
          document={document}
          onRecoveryRequired={onRecoveryRequired}
          tenantID="2a388dc1-e3a5-4888-8d65-d9bd57fd4fc7"
        />
      </I18nProvider>,
    );

    expect(await screen.findByText(/Whiteboard connected/)).toBeInTheDocument();
    act(() => engineMocks.terminal?.("authority_changed"));
    expect(onRecoveryRequired).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The drawing tools could not connect",
    );
  });

  it("keeps one live session when re-rendered with an equivalent document copy", async () => {
    const firstRecovery = vi.fn();
    const latestRecovery = vi.fn();
    const engine = (
      nextDocument: WhiteboardDocument,
      onRecoveryRequired: () => void,
    ) => (
      <I18nProvider initialLanguage="en">
        <LazyWhiteboardEngine
          actorID="b0f39fdb-0789-454d-8517-ae313dd81ca9"
          capability="view"
          document={nextDocument}
          onRecoveryRequired={onRecoveryRequired}
          tenantID="2a388dc1-e3a5-4888-8d65-d9bd57fd4fc7"
        />
      </I18nProvider>
    );
    const view = render(engine(document, firstRecovery));
    expect(await screen.findByText(/Whiteboard connected/)).toBeInTheDocument();
    const firstSession = (await engineMocks.createSession.mock.results[0]
      ?.value) as { destroy: ReturnType<typeof vi.fn> };

    // Fresh object + fresh callback with the same authority fence (what a
    // refetch or a parent re-render produces) must not re-exchange a grant.
    view.rerender(engine({ ...document }, () => undefined));
    view.rerender(
      engine(
        { ...document, updated_at: "2030-08-22T00:01:00Z" },
        latestRecovery,
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(engineMocks.grant).toHaveBeenCalledTimes(1);
    expect(engineMocks.createSession).toHaveBeenCalledTimes(1);
    expect(firstSession.destroy).not.toHaveBeenCalled();
    expect(screen.getByText("Excalidraw canvas")).toBeInTheDocument();

    act(() => engineMocks.terminal?.("authority_changed"));
    expect(latestRecovery).toHaveBeenCalledTimes(1);
    expect(firstRecovery).not.toHaveBeenCalled();
  });

  it("re-exchanges exactly once when the authority fence advances", async () => {
    const engine = (nextDocument: WhiteboardDocument) => (
      <I18nProvider initialLanguage="en">
        <LazyWhiteboardEngine
          actorID="b0f39fdb-0789-454d-8517-ae313dd81ca9"
          capability="view"
          document={nextDocument}
          tenantID="2a388dc1-e3a5-4888-8d65-d9bd57fd4fc7"
        />
      </I18nProvider>
    );
    const view = render(engine(document));
    expect(await screen.findByText(/Whiteboard connected/)).toBeInTheDocument();
    const firstSession = (await engineMocks.createSession.mock.results[0]
      ?.value) as { destroy: ReturnType<typeof vi.fn> };

    view.rerender(engine({ ...document, revoke_generation: 2 }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(firstSession.destroy).toHaveBeenCalledTimes(1);
    expect(engineMocks.grant).toHaveBeenCalledTimes(2);
    expect(engineMocks.grant).toHaveBeenLastCalledWith(
      "2a388dc1-e3a5-4888-8d65-d9bd57fd4fc7",
      expect.objectContaining({ id: document.id, revoke_generation: 2 }),
      "view",
      expect.any(AbortSignal),
    );
  });

  it("keeps the text alternative collapsed until requested and restores focus", () => {
    render(
      <I18nProvider initialLanguage="en">
        <CanonicalExcalidrawCanvas
          authority={semanticAuthority}
          connectionStatus="connected"
          readOnly={false}
        />
      </I18nProvider>,
    );
    const fallback = screen.getByTestId("whiteboard-semantic-fallback");
    const trigger = screen.getByRole("button", {
      name: "Read whiteboard as text",
    });

    expect(fallback).toHaveClass("whiteboard-semantic-fallback--collapsed");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("aria-controls", fallback.id);
    expect(
      screen.getByRole("region", { name: "Interactive whiteboard canvas" }),
    ).toHaveAccessibleDescription(
      "The canvas is the visual surface. This structured list is the reading alternative generated from the same whiteboard data.",
    );

    fireEvent.click(trigger);
    expect(fallback).toHaveClass("whiteboard-semantic-fallback--open");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("heading", { name: "Whiteboard text representation" }),
    ).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Close text view" }));
    expect(fallback).toHaveClass("whiteboard-semantic-fallback--collapsed");
    expect(trigger).toHaveFocus();

    // Keyboard focus entering the collapsed panel reveals it.
    act(() => screen.getByRole("button", { name: "Next page" }).focus());
    expect(fallback).toHaveClass("whiteboard-semantic-fallback--open");
    fireEvent.keyDown(screen.getByRole("button", { name: "Next page" }), {
      key: "Escape",
    });
    expect(fallback).toHaveClass("whiteboard-semantic-fallback--collapsed");
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    fireEvent.click(
      screen.getByRole("button", { name: "Move focus to drawing canvas" }),
    );
    expect(fallback).toHaveClass("whiteboard-semantic-fallback--collapsed");
    expect(
      screen.getByRole("region", { name: "Interactive whiteboard canvas" }),
    ).toHaveFocus();
  });

  it("paginates the semantic fallback and provides explicit focus handoff", () => {
    render(
      <I18nProvider initialLanguage="en">
        <CanonicalExcalidrawCanvas
          authority={semanticAuthority}
          connectionStatus="connected"
          readOnly
        />
      </I18nProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Read whiteboard as text" }),
    );
    expect(
      screen.getByRole("heading", { name: "Whiteboard text representation" }),
    ).toHaveFocus();
    expect(screen.getAllByRole("listitem")).toHaveLength(50);
    expect(screen.getByTestId("whiteboard-semantic-page")).toHaveTextContent(
      "Page 1/2 · 55 elements",
    );

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByText(/Lesson shape 55/)).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Move focus to drawing canvas" }),
    );
    expect(
      screen.getByRole("region", { name: "Interactive whiteboard canvas" }),
    ).toHaveFocus();
  });
});
