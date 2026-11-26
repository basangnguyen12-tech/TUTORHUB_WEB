// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PdfStroke } from "@tutorhub/collaboration-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../app/i18n";
import type { LivePdfSession, PdfLaserMark } from "./livePdfCollaboration";
import {
  PdfAnnotationOverlay,
  PdfInkToolbar,
  type PdfInkSettings,
} from "./PdfAnnotationOverlay";

const OWN = "student-actor-0002";
const TEACHER = "teacher-actor-0001";

function stroke(id: string, actorId: string, y: number): PdfStroke {
  return {
    actorId,
    id,
    page: 1,
    points: [
      { x: 0.1, y },
      { x: 0.9, y },
    ],
    tone: 1,
    tool: "pen",
    width: "m",
  };
}

function fakeSession(
  capability: "view" | "edit" | "present",
  strokes: readonly PdfStroke[] = [],
  marks: readonly PdfLaserMark[] = [],
) {
  const authority = {
    actorId: OWN,
    addStroke: vi.fn(),
    clearPageStrokes: vi.fn(),
    eraseOwnStroke: vi.fn(),
  };
  const session = {
    authority,
    capability,
    destroy: vi.fn(),
    ink: {
      canRedo: () => false,
      canUndo: () => true,
      meta: () => ({
        followLock: false,
        hiddenPages: [],
        pageCount: 3,
        presenterPage: 1,
      }),
      strokes: (page: number) => (page === 1 ? strokes : []),
      subscribe: () => () => undefined,
      version: () => 1,
    },
    laser: {
      destroy: () => undefined,
      marks: () => marks,
      subscribe: () => () => undefined,
    },
    publishLaser: vi.fn(),
  };
  return { authority, session: session as unknown as LivePdfSession };
}

const pen: PdfInkSettings = { tone: 1, tool: "pen", width: "m" };

function renderOverlay(
  session: LivePdfSession | null,
  settings: PdfInkSettings,
  extra: { onInk?: () => void; onNotice?: (key: string) => void } = {},
) {
  const onNotice = extra.onNotice ?? vi.fn();
  const view = render(
    <I18nProvider initialLanguage="vi">
      <PdfAnnotationOverlay
        aspect={1}
        laserLabel={() => "Laser của Thu Hà"}
        onInk={extra.onInk}
        onNotice={onNotice}
        page={1}
        session={session}
        settings={settings}
      />
    </I18nProvider>,
  );
  const surface = view.container.querySelector<HTMLElement>(
    "[data-pdf-ink-page='1']",
  ) as HTMLElement;
  surface.getBoundingClientRect = () =>
    ({
      bottom: 100,
      height: 100,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
    }) as DOMRect;
  return { onNotice, surface, view };
}

function drag(
  surface: HTMLElement,
  from: [number, number],
  to: [number, number],
) {
  const base = { button: 0, pointerId: 1, pointerType: "mouse" };
  fireEvent.pointerDown(surface, {
    ...base,
    clientX: from[0],
    clientY: from[1],
  });
  fireEvent.pointerMove(surface, {
    ...base,
    clientX: (from[0] + to[0]) / 2,
    clientY: (from[1] + to[1]) / 2,
  });
  fireEvent.pointerMove(surface, { ...base, clientX: to[0], clientY: to[1] });
  fireEvent.pointerUp(surface, { ...base, clientX: to[0], clientY: to[1] });
}

afterEach(() => cleanup());

describe("PdfAnnotationOverlay (ROOM-TOOLS-FILES-02B)", () => {
  it("shows every stroke to a view-only student and never writes", () => {
    const { authority, session } = fakeSession("view", [
      stroke("0000stroke01", TEACHER, 0.2),
    ]);
    const { surface } = renderOverlay(session, pen);
    expect(surface).toHaveAttribute("data-pdf-ink", "view");
    expect(surface.querySelectorAll("path[data-stroke-id]")).toHaveLength(1);
    drag(surface, [10, 10], [80, 40]);
    expect(authority.addStroke).not.toHaveBeenCalled();
  });

  it("writes one stroke per gesture on pointerup and reports ink activity (never navigation)", () => {
    const { authority, session } = fakeSession("edit");
    const onInk = vi.fn();
    const { surface } = renderOverlay(session, pen, { onInk });
    expect(surface).toHaveAttribute("data-pdf-ink", "draw");
    drag(surface, [10, 10], [80, 40]);
    expect(authority.addStroke).toHaveBeenCalledTimes(1);
    const [page, input] = authority.addStroke.mock.calls[0] as [
      number,
      { points: { x: number; y: number }[]; tone: number; tool: string },
    ];
    expect(page).toBe(1);
    expect(input.tool).toBe("pen");
    expect(input.tone).toBe(1);
    expect(input.points[0]).toEqual({ x: 0.1, y: 0.1 });
    expect(input.points.at(-1)).toEqual({ x: 0.8, y: 0.4 });
    expect(onInk).toHaveBeenCalledTimes(1);
  });

  it("lets an annotator erase only their own ink, with a polite notice otherwise", () => {
    const { authority, session } = fakeSession("edit", [
      stroke("0000teacher1", TEACHER, 0.2),
      stroke("0000student1", OWN, 0.6),
    ]);
    const { onNotice, surface } = renderOverlay(session, {
      ...pen,
      tool: "eraser",
    });
    drag(surface, [50, 20], [52, 21]);
    expect(authority.eraseOwnStroke).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledWith(
      "classroomTools.files.ink.error.notOwned",
    );
    drag(surface, [50, 60], [52, 61]);
    expect(authority.eraseOwnStroke).toHaveBeenCalledWith(1, "0000student1");
  });

  it("turns authority limits into notices instead of crashing", () => {
    const { authority, session } = fakeSession("edit");
    authority.addStroke.mockImplementation(() => {
      throw Object.assign(new Error("page_stroke_limit"), {
        code: "page_stroke_limit",
        name: "PdfAnnotationAuthorityError",
      });
    });
    const { onNotice, surface } = renderOverlay(session, pen);
    drag(surface, [10, 10], [80, 40]);
    expect(onNotice).toHaveBeenCalledWith(
      "classroomTools.files.ink.error.pageLimit",
    );
  });

  it("draws only the trusted presenter lasers of its page", () => {
    const { session } = fakeSession(
      "view",
      [],
      [
        { clientID: 5, page: 1, participantKey: "teacher", x: 0.25, y: 0.5 },
        { clientID: 5, page: 2, participantKey: "teacher", x: 0.3, y: 0.3 },
      ],
    );
    renderOverlay(session, pen);
    const laser = screen.getByRole("img", { name: "Laser của Thu Hà" });
    expect(laser).toHaveStyle({ left: "25%", top: "50%" });
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("publishes the presenter's laser while hovering and clears it on leave", () => {
    const { session } = fakeSession("present");
    const { surface } = renderOverlay(session, { ...pen, tool: "laser" });
    expect(surface).toHaveAttribute("data-pdf-ink", "laser");
    fireEvent.pointerMove(surface, {
      buttons: 0,
      clientX: 40,
      clientY: 20,
      pointerId: 1,
      pointerType: "mouse",
    });
    expect(session.publishLaser).toHaveBeenCalledWith({
      page: 1,
      x: 0.4,
      y: 0.2,
    });
    fireEvent.pointerLeave(surface);
    expect(session.publishLaser).toHaveBeenLastCalledWith(null);
  });
});

describe("PdfInkToolbar", () => {
  function renderToolbar(
    capability: "view" | "edit" | "present",
    onClearPage = vi.fn(),
  ) {
    const { session } = fakeSession(capability);
    const handlers = {
      onRedo: vi.fn(),
      onTone: vi.fn(),
      onTool: vi.fn(),
      onUndo: vi.fn(),
      onWidth: vi.fn(),
    };
    const view = render(
      <I18nProvider initialLanguage="vi">
        <PdfInkToolbar
          capability={capability}
          currentPage={2}
          onClearPage={onClearPage}
          session={session}
          settings={pen}
          {...handlers}
        />
      </I18nProvider>,
    );
    return { ...handlers, onClearPage, view };
  }

  it("offers nothing in view mode", () => {
    renderToolbar("view");
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("gives annotators pen, highlighter and eraser but no laser or page clear", () => {
    const handlers = renderToolbar("edit");
    const toolbar = screen.getByRole("toolbar", { name: "Công cụ chú thích" });
    expect(toolbar).toBeVisible();
    expect(screen.getByRole("button", { name: "Bút viết" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByRole("button", { name: "Laser chỉ bài" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Xóa tất cả nét trang 2" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Bút dạ quang" }));
    expect(handlers.onTool).toHaveBeenCalledWith("highlighter");
    fireEvent.click(screen.getByRole("button", { name: "Hoàn tác (Ctrl+Z)" }));
    expect(handlers.onUndo).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Làm lại (Ctrl+Y)" }),
    ).toBeDisabled();
  });

  it("asks the presenter to confirm before clearing a page", () => {
    const handlers = renderToolbar("present");
    expect(screen.getByRole("button", { name: "Laser chỉ bài" })).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Xóa tất cả nét trang 2" }),
    );
    const dialog = screen.getByRole("alertdialog", {
      name: "Xóa tất cả nét trên trang 2?",
    });
    expect(handlers.onClearPage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Hủy" }));
    expect(dialog).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Xóa tất cả nét trang 2" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Xóa nét" }));
    expect(handlers.onClearPage).toHaveBeenCalledTimes(1);
  });
});
