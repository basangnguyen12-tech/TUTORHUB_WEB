// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { WhiteboardDocument } from "@tutorhub/api-client";
import {
  canonicalSceneToExcalidraw,
  semanticHash,
  validateCanonicalScene,
  WHITEBOARD_PAPER_MODES,
  type CanonicalElementV1,
  type CanonicalExcalidrawSceneV1,
  type CanonicalPageV1,
} from "@tutorhub/collaboration-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../app/i18n";
import LazyWhiteboardEngine, {
  CanonicalExcalidrawCanvas,
  type WhiteboardCanvasAuthority,
} from "./LazyWhiteboardEngine";
import { resolvePaperBaseColor } from "./whiteboardPaper";

interface FakeExcalidrawAppState {
  currentItemStrokeColor: string;
  scrollX: number;
  scrollY: number;
  viewBackgroundColor: string;
  zoom: { value: number };
}

interface FakeExcalidrawAPI {
  addFiles: ReturnType<typeof vi.fn>;
  appState: FakeExcalidrawAppState;
  getAppState: () => FakeExcalidrawAppState;
  getFiles: () => Record<string, never>;
  getSceneElements: () => never[];
  history: { clear: ReturnType<typeof vi.fn> };
  updateScene: ReturnType<typeof vi.fn>;
}

interface CapturedExcalidrawProps {
  UIOptions?: unknown;
  excalidrawAPI?: (api: unknown) => void;
  initialData?: { appState?: { viewBackgroundColor?: string } };
  onScrollChange?: (
    scrollX: number,
    scrollY: number,
    zoom: { value: number },
  ) => void;
  theme?: string;
}

const engineMocks = vi.hoisted(() => ({
  api: null as null | FakeExcalidrawAPI,
  createSession: vi.fn(),
  excalidrawProps: null as null | CapturedExcalidrawProps,
  grant: vi.fn(),
  status: null as null | ((status: string) => void),
  terminal: null as null | ((reason: string) => void),
}));

vi.mock("@excalidraw/excalidraw", async () => {
  const { useEffect } = await import("react");
  return {
    Excalidraw: (props: CapturedExcalidrawProps) => {
      engineMocks.excalidrawProps = props;
      useEffect(() => {
        if (engineMocks.api !== null) props.excalidrawAPI?.(engineMocks.api);
        // Mount-only, like Excalidraw's own API handoff.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return <div>Excalidraw canvas</div>;
    },
  };
});

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

function createFakeExcalidrawAPI(
  currentItemStrokeColor = "#1e1e1e",
): FakeExcalidrawAPI {
  const appState: FakeExcalidrawAppState = {
    currentItemStrokeColor,
    scrollX: 0,
    scrollY: 0,
    viewBackgroundColor: "transparent",
    zoom: { value: 1 },
  };
  return {
    addFiles: vi.fn(),
    appState,
    getAppState: () => appState,
    getFiles: () => ({}),
    getSceneElements: () => [],
    history: { clear: vi.fn() },
    updateScene: vi.fn(
      (update: { appState?: Partial<FakeExcalidrawAppState> }) => {
        Object.assign(appState, update.appState ?? {});
      },
    ),
  };
}

/** In-memory canonical authority with the real validation and hashing. */
function createMemoryAuthority(page: Partial<CanonicalPageV1> = {}) {
  let scene: CanonicalExcalidrawSceneV1 = validateCanonicalScene({
    elements: [],
    files: {},
    page: { backgroundColor: "#ffffff", id: "page-1", name: "Page 1", ...page },
    schemaVersion: 1,
  });
  const listeners = new Set<(next: CanonicalExcalidrawSceneV1) => void>();
  const publish = (next: unknown) => {
    scene = validateCanonicalScene(next);
    listeners.forEach((listener) => listener(scene));
  };
  const authority = {
    getProjection: () => canonicalSceneToExcalidraw(scene),
    getScene: () => scene,
    getSemanticHash: () => semanticHash(scene),
    redo: () => false,
    replaceScene: vi.fn(publish),
    subscribe: (listener: (next: CanonicalExcalidrawSceneV1) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    undo: () => false,
  } satisfies WhiteboardCanvasAuthority;
  return {
    authority,
    /** A remote (teacher) change arriving through the shared document. */
    receiveRemotePage: (nextPage: Partial<CanonicalPageV1>) =>
      publish({ ...scene, page: { ...scene.page, ...nextPage } }),
  };
}

function lastReplacedPage(
  authority: ReturnType<typeof createMemoryAuthority>["authority"],
) {
  const call = authority.replaceScene.mock.lastCall as
    [CanonicalExcalidrawSceneV1] | undefined;
  return call?.[0].page;
}

function strokeUpdates(api: FakeExcalidrawAPI): string[] {
  return api.updateScene.mock.calls
    .map(
      ([update]) =>
        (update as { appState?: { currentItemStrokeColor?: string } }).appState
          ?.currentItemStrokeColor,
    )
    .filter((value): value is string => typeof value === "string");
}

describe("LazyWhiteboardEngine", () => {
  beforeEach(() => {
    engineMocks.api = null;
    engineMocks.excalidrawProps = null;
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
    // ROOM-MEET-DOCK-04: a compact text-view key named by its label.
    expect(trigger).toHaveAttribute("data-tooltip", "Read whiteboard as text");
    expect(trigger.querySelector(".whiteboard-action-label")).toHaveTextContent(
      "Read whiteboard as text",
    );
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

  it("keeps Excalidraw transparent above the paper backdrop with theme switching disabled", () => {
    const { authority } = createMemoryAuthority();
    engineMocks.api = createFakeExcalidrawAPI();
    render(
      <I18nProvider initialLanguage="en">
        <CanonicalExcalidrawCanvas
          authority={authority}
          connectionStatus="connected"
          readOnly={false}
        />
      </I18nProvider>,
    );

    const props = engineMocks.excalidrawProps;
    expect(props?.theme).toBe("light");
    expect(props?.initialData?.appState?.viewBackgroundColor).toBe(
      "transparent",
    );
    expect(props?.UIOptions).toEqual({
      canvasActions: { changeViewBackgroundColor: false, toggleTheme: false },
    });
    const backdrop = screen.getByTestId("whiteboard-paper-backdrop");
    expect(backdrop).toHaveAttribute("aria-hidden", "true");
    expect(backdrop).toHaveAttribute("data-paper-mode", "plain");
    // Pan/zoom frames go straight to the backdrop without touching the doc.
    act(() => props?.onScrollChange?.(-120, 48, { value: 2 }));
    expect(authority.replaceScene).not.toHaveBeenCalled();
    // A page without paper fields stays untouched: no replace, no ink change.
    expect(strokeUpdates(engineMocks.api)).toEqual([]);
  });

  it("lets a teacher choose every paper and flips the next ink between dark and light surfaces", () => {
    const { authority } = createMemoryAuthority();
    const api = createFakeExcalidrawAPI("#1E1E1E");
    engineMocks.api = api;
    render(
      <I18nProvider initialLanguage="en">
        <CanonicalExcalidrawCanvas
          authority={authority}
          connectionStatus="connected"
          readOnly={false}
        />
      </I18nProvider>,
    );

    expect(screen.queryByTestId("whiteboard-paper-readonly")).toBeNull();
    const trigger = screen.getByTestId("whiteboard-paper-trigger");
    expect(trigger).toHaveAccessibleName("Paper: Plain Whiteboard");
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    // ROOM-STAGE-POLISH-04: a round palette key — no swatch chip or caret;
    // the current paper is the accessible name and the tooltip.
    const paletteIcon = trigger.querySelector("svg.lucide-palette");
    expect(paletteIcon).not.toBeNull();
    expect(paletteIcon).toHaveAttribute("aria-hidden", "true");
    expect(trigger.querySelector(".whiteboard-paper-swatch")).toBeNull();
    expect(trigger).not.toHaveTextContent("▾");
    expect(trigger).toHaveAttribute("data-tooltip", "Paper: Plain Whiteboard");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const dialog = screen.getByRole("dialog", { name: "Choose paper style" });
    expect(within(dialog).queryAllByRole("radio")).toHaveLength(0);
    const cards = dialog.querySelectorAll("button[data-paper-mode]");
    expect(
      Array.from(cards, (card) => card.getAttribute("data-paper-mode")),
    ).toEqual([...WHITEBOARD_PAPER_MODES]);
    expect(within(dialog).getByRole("button", { name: /Plain/ })).toHaveFocus();
    expect(
      within(dialog).getByRole("button", { name: "Light" }),
    ).toHaveAttribute("aria-pressed", "true");

    const card = (name: string) => within(dialog).getByRole("button", { name });
    const expectPaper = (mode: string, dark: boolean) => {
      expect(lastReplacedPage(authority)).toEqual({
        backgroundColor: resolvePaperBaseColor(
          mode as (typeof WHITEBOARD_PAPER_MODES)[number],
          dark,
        ),
        id: "page-1",
        name: "Page 1",
        paperDark: dark,
        paperMode: mode,
      });
      expect(screen.getByTestId("whiteboard-paper-backdrop")).toHaveAttribute(
        "data-paper-mode",
        mode,
      );
    };

    for (const [name, mode] of [
      ["Notebook", "notebook"],
      ["Grid", "grid"],
      ["Music Sheet", "music"],
      ["Art Canvas", "canvas"],
      ["Dots", "dots"],
      ["Lined", "lined"],
    ] as const) {
      fireEvent.click(card(name));
      expectPaper(mode, false);
      expect(card(name)).toHaveAttribute("aria-pressed", "true");
      expect(trigger).toHaveAccessibleName(`Paper: ${name}`);
    }
    // Light paper keeps the default ink.
    expect(strokeUpdates(api)).toEqual([]);
    expect(api.appState.currentItemStrokeColor).toBe("#1E1E1E");

    fireEvent.click(within(dialog).getByRole("button", { name: "Dark" }));
    expectPaper("lined", true);
    expect(strokeUpdates(api)).toEqual(["#ffffff"]);
    expect(
      within(dialog).getByRole("button", { name: "Dark" }),
    ).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(card("Art Canvas"));
    expectPaper("canvas", true);
    expect(lastReplacedPage(authority)?.backgroundColor).toBe("#232220");

    fireEvent.click(card("Blueprint"));
    expectPaper("blueprint", true);
    expect(
      within(dialog).getByRole("button", { name: "Light" }),
    ).toBeDisabled();
    expect(dialog).toHaveAccessibleDescription(
      "Blueprint and Blackboard always keep their own surface colour.",
    );

    fireEvent.click(card("Blackboard"));
    expectPaper("blackboard", true);
    expect(lastReplacedPage(authority)?.backgroundColor).toBe("#1b3d2b");
    // Still a dark surface: no extra ink change.
    expect(strokeUpdates(api)).toEqual(["#ffffff"]);

    fireEvent.click(card("Notebook"));
    expectPaper("notebook", true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Light" }));
    expectPaper("notebook", false);
    expect(strokeUpdates(api)).toEqual(["#ffffff", "#1e1e1e"]);
    expect(api.appState.currentItemStrokeColor).toBe("#1e1e1e");

    // Blackboard is dark even with paperDark = false.
    fireEvent.click(card("Blackboard"));
    expectPaper("blackboard", false);
    expect(strokeUpdates(api)).toEqual(["#ffffff", "#1e1e1e", "#ffffff"]);

    fireEvent.keyDown(card("Blackboard"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
    // The round key keeps its palette icon while name + tooltip follow paper.
    expect(trigger).toHaveAccessibleName("Paper: Blackboard");
    expect(trigger).toHaveAttribute("data-tooltip", "Paper: Blackboard");
    expect(trigger.querySelectorAll("svg.lucide-palette")).toHaveLength(1);
  });

  it("never recolours a custom ink and closes the paper popover on an outside press", () => {
    const { authority } = createMemoryAuthority();
    const api = createFakeExcalidrawAPI("#e03131");
    engineMocks.api = api;
    render(
      <I18nProvider initialLanguage="vi">
        <CanonicalExcalidrawCanvas
          authority={authority}
          connectionStatus="connected"
          readOnly={false}
        />
      </I18nProvider>,
    );
    const trigger = screen.getByTestId("whiteboard-paper-trigger");
    expect(trigger).toHaveAccessibleName("Giấy: Bảng trắng (Trơn)");
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Chọn chế độ giấy" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Bảng phấn" }));
    expect(lastReplacedPage(authority)?.paperMode).toBe("blackboard");
    expect(strokeUpdates(api)).toEqual([]);
    expect(api.appState.currentItemStrokeColor).toBe("#e03131");
    expect(trigger).toHaveAccessibleName("Giấy: Bảng phấn");

    fireEvent.pointerDown(screen.getByText("Excalidraw canvas"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows students a read-only paper badge that follows the teacher's paper live", () => {
    const { authority, receiveRemotePage } = createMemoryAuthority();
    const api = createFakeExcalidrawAPI();
    engineMocks.api = api;
    render(
      <I18nProvider initialLanguage="en">
        <CanonicalExcalidrawCanvas
          authority={authority}
          connectionStatus="connected"
          readOnly
        />
      </I18nProvider>,
    );

    expect(screen.queryByTestId("whiteboard-paper-trigger")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Paper:/ }),
    ).not.toBeInTheDocument();
    const badge = screen.getByTestId("whiteboard-paper-readonly");
    expect(badge.tagName).toBe("P");
    expect(badge).toHaveTextContent("Paper: Plain Whiteboard");

    act(() =>
      receiveRemotePage({
        backgroundColor: "#fdfdfd",
        paperDark: false,
        paperMode: "notebook",
      }),
    );
    expect(badge).toHaveTextContent("Paper: Notebook");
    expect(badge).toHaveAttribute("data-paper-mode", "notebook");
    expect(screen.getByTestId("whiteboard-paper-backdrop")).toHaveAttribute(
      "data-paper-mode",
      "notebook",
    );

    act(() =>
      receiveRemotePage({
        backgroundColor: "#1e293b",
        paperDark: true,
        paperMode: "grid",
      }),
    );
    expect(badge).toHaveTextContent("Paper: Grid · Dark");
    expect(
      screen.getByRole("region", { name: "Interactive whiteboard canvas" }),
    ).toHaveAttribute("data-paper-surface", "dark");

    act(() =>
      receiveRemotePage({
        backgroundColor: "#1b3d2b",
        paperDark: true,
        paperMode: "blackboard",
      }),
    );
    expect(badge).toHaveTextContent("Paper: Blackboard");
    expect(badge).not.toHaveTextContent("Dark");
    // Students never write the document or retarget ink.
    expect(authority.replaceScene).not.toHaveBeenCalled();
    expect(strokeUpdates(api)).toEqual([]);
  });
  it("drops the engine bar in the classroom and portals the paper picker into the Top Bar slot", () => {
    const slot = globalThis.document.createElement("div");
    globalThis.document.body.append(slot);
    const view = render(
      <I18nProvider initialLanguage="en">
        <CanonicalExcalidrawCanvas
          authority={semanticAuthority}
          classroom
          connectionStatus="connected"
          readOnly={false}
          toolbarSlot={slot}
        />
      </I18nProvider>,
    );

    // ROOM-COMPACT-05: no bar, no "read as text" key, no visible status line.
    expect(view.container.querySelector(".whiteboard-engine-bar")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Read whiteboard as text" }),
    ).toBeNull();
    const status = screen.getByText("Whiteboard connected.");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveClass("whiteboard-sr-only");
    expect(view.container.querySelector(".whiteboard-engine")).toHaveClass(
      "whiteboard-engine--classroom",
    );

    const trigger = within(slot).getByTestId("whiteboard-paper-trigger");
    expect(trigger).toHaveAccessibleName("Paper: Plain Whiteboard");
    expect(view.container).not.toContainElement(trigger);

    // The text alternative stays reachable: keyboard focus opens it and
    // closing hands focus to the canvas (there is no trigger key).
    const fallback = screen.getByTestId("whiteboard-semantic-fallback");
    expect(fallback).toHaveClass("whiteboard-semantic-fallback--collapsed");
    act(() => screen.getByRole("button", { name: "Next page" }).focus());
    expect(fallback).toHaveClass("whiteboard-semantic-fallback--open");
    fireEvent.click(screen.getByRole("button", { name: "Close text view" }));
    expect(fallback).toHaveClass("whiteboard-semantic-fallback--collapsed");
    expect(
      screen.getByRole("region", { name: "Interactive whiteboard canvas" }),
    ).toHaveFocus();
    view.unmount();
    expect(slot).toBeEmptyDOMElement();
    slot.remove();
  });

  it("waits for the Top Bar slot before showing the classroom paper picker", () => {
    const view = render(
      <I18nProvider initialLanguage="en">
        <CanonicalExcalidrawCanvas
          authority={semanticAuthority}
          classroom
          connectionStatus="connecting"
          readOnly={false}
        />
      </I18nProvider>,
    );
    expect(screen.queryByTestId("whiteboard-paper-trigger")).toBeNull();
    expect(screen.getByText("Connecting to the whiteboard…")).toHaveClass(
      "whiteboard-sr-only",
    );
    expect(view.container.querySelector(".whiteboard-engine-bar")).toBeNull();
  });

  it("passes classroom mode through the lazy engine to a student's read-only badge", async () => {
    const slot = globalThis.document.createElement("div");
    globalThis.document.body.append(slot);
    render(
      <I18nProvider initialLanguage="en">
        <LazyWhiteboardEngine
          actorID="b0f39fdb-0789-454d-8517-ae313dd81ca9"
          capability="view"
          classroom
          document={document}
          tenantID="2a388dc1-e3a5-4888-8d65-d9bd57fd4fc7"
          toolbarSlot={slot}
        />
      </I18nProvider>,
    );

    expect(
      await screen.findByText("Whiteboard connected. · View only"),
    ).toHaveClass("whiteboard-sr-only");
    const badge = within(slot).getByTestId("whiteboard-paper-readonly");
    expect(badge).toHaveTextContent("Paper: Plain Whiteboard");
    expect(within(slot).queryByTestId("whiteboard-paper-trigger")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Read whiteboard as text" }),
    ).toBeNull();
    cleanup();
    slot.remove();
  });
});

describe("ROOM-TOOLS-FILES-01B document snippets on the live canvas", () => {
  const pixel =
    "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA";

  function snippet(id: string) {
    return {
      byteLength: 42,
      createdAt: 1,
      dataURL: pixel,
      height: 300,
      id,
      mimeType: "image/webp" as const,
      pageNumber: 3,
      sourceName: "Đề KT.pdf",
      width: 400,
    };
  }

  afterEach(() => cleanup());

  async function nextFrame() {
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
  }

  it("inserts a pending snippet as a locked image with a source caption", async () => {
    const { createWhiteboardSnippetBridge } =
      await import("./whiteboardSnippetBridge");
    engineMocks.api = createFakeExcalidrawAPI();
    const memory = createMemoryAuthority();
    const bridge = createWhiteboardSnippetBridge();
    bridge.push(snippet("first"));
    render(
      <I18nProvider initialLanguage="vi">
        <CanonicalExcalidrawCanvas
          authority={memory.authority}
          connectionStatus="connected"
          readOnly={false}
          snippetBridge={bridge}
        />
      </I18nProvider>,
    );
    await nextFrame();

    const scene = memory.authority.getScene();
    const image = scene.elements.find((element) => element.type === "image");
    const caption = scene.elements.find((element) => element.type === "text");
    expect(image).toMatchObject({ fileId: "doc-snip-first", locked: true });
    expect(caption).toMatchObject({
      locked: true,
      text: "Trích từ Đề KT.pdf — trang 3",
    });
    expect(scene.files["doc-snip-first"]).toMatchObject({
      dataURL: pixel,
      mimeType: "image/webp",
    });
    expect(bridge.peek()).toBeNull();
    expect(bridge.lastReport()).toEqual({
      outcome: "inserted",
      snippetID: "first",
    });
    expect(
      screen.getByText("Đã chèn ảnh trích từ tài liệu vào Bảng trắng."),
    ).toBeInTheDocument();
  });

  it("refuses snippets on a view-only board and at the 12-snippet limit", async () => {
    const { createWhiteboardSnippetBridge } =
      await import("./whiteboardSnippetBridge");
    engineMocks.api = createFakeExcalidrawAPI();
    const memory = createMemoryAuthority();
    const bridge = createWhiteboardSnippetBridge();
    bridge.push(snippet("viewer"));
    const view = render(
      <I18nProvider initialLanguage="en">
        <CanonicalExcalidrawCanvas
          authority={memory.authority}
          connectionStatus="connected"
          readOnly
          snippetBridge={bridge}
        />
      </I18nProvider>,
    );
    await nextFrame();
    expect(memory.authority.replaceScene).not.toHaveBeenCalled();
    expect(bridge.lastReport()?.outcome).toBe("readOnly");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "You can't edit this whiteboard, so the snippet wasn't added.",
    );
    view.unmount();

    // A board that already holds 12 document snippets refuses a 13th.
    const full = createMemoryAuthority();
    for (let index = 0; index < 12; index += 1) {
      bridge.push(snippet(`s${index}`));
      engineMocks.api = createFakeExcalidrawAPI();
      const mounted = render(
        <I18nProvider initialLanguage="en">
          <CanonicalExcalidrawCanvas
            authority={full.authority}
            connectionStatus="connected"
            readOnly={false}
            snippetBridge={bridge}
          />
        </I18nProvider>,
      );
      await nextFrame();
      mounted.unmount();
    }
    expect(
      full.authority
        .getScene()
        .elements.filter((element) => element.type === "image"),
    ).toHaveLength(12);
    bridge.push(snippet("thirteenth"));
    engineMocks.api = createFakeExcalidrawAPI();
    render(
      <I18nProvider initialLanguage="en">
        <CanonicalExcalidrawCanvas
          authority={full.authority}
          connectionStatus="connected"
          readOnly={false}
          snippetBridge={bridge}
        />
      </I18nProvider>,
    );
    await nextFrame();
    expect(bridge.lastReport()?.outcome).toBe("limit");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This whiteboard already has 12 document snippets.",
    );
  });
});
