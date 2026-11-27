import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { TenantCapabilities } from "@tutorhub/api-client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../app/i18n";
import type { TenantOperationAvailability } from "../../app/tenantCapabilities";
import { availableTenantCapabilities } from "../../test/tenantCapabilities";
import {
  MessagesWelcomeCarousel,
  WELCOME_AUTOPLAY_MS,
  type MessagesWelcomeCarouselProps,
} from "./MessagesWelcomeCarousel";

const tenantID = "4b18543a-74de-419f-9fe8-d0c3dfc991eb";
const available: TenantOperationAvailability = {
  available: true,
  reason: "available",
};

type Features = TenantCapabilities["features"];

function featuresWith(enabled: {
  classroom_code_tool?: boolean;
  classroom_files_tool?: boolean;
  classroom_whiteboards?: boolean;
}): Features {
  const features = { ...availableTenantCapabilities(tenantID).features };
  for (const [key, value] of Object.entries(enabled) as Array<
    [keyof typeof enabled, boolean]
  >) {
    features[key] = { configured_enabled: value, enabled: value };
  }
  return features;
}

function stubMatchMedia(reducedMotion = false) {
  const listeners = { add: vi.fn(), remove: vi.fn() };
  vi.stubGlobal("matchMedia", (query: string) => ({
    addEventListener: listeners.add,
    addListener: vi.fn(),
    dispatchEvent: vi.fn(),
    matches: reducedMotion && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    removeEventListener: listeners.remove,
    removeListener: vi.fn(),
  }));
  return listeners;
}

function renderCarousel(props: Partial<MessagesWelcomeCarouselProps> = {}) {
  const onStartConversation = vi.fn();
  const view = render(
    <I18nProvider initialLanguage="vi">
      <MemoryRouter>
        <MessagesWelcomeCarousel
          createAvailability={available}
          features={undefined}
          onStartConversation={onStartConversation}
          {...props}
        />
      </MemoryRouter>
    </I18nProvider>,
  );
  return { ...view, onStartConversation };
}

function region() {
  return screen.getByRole("region", { name: "Giới thiệu tính năng TutorHub" });
}

function slides() {
  return within(region())
    .getAllByRole("group", { hidden: true })
    .filter((group) => group.getAttribute("aria-roledescription") === "slide");
}

function activeSlide() {
  const active = slides().find((group) => !group.hasAttribute("inert"));
  if (!active) {
    throw new Error("No active slide");
  }
  return active;
}

function activeLabel() {
  return activeSlide().getAttribute("aria-label");
}

function dots() {
  return within(screen.getByRole("group", { name: "Chọn slide" })).getAllByRole(
    "button",
  );
}

function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

describe("MessagesWelcomeCarousel", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, "hidden");
  });

  it("shows only live features and filters gated slides by capability", () => {
    stubMatchMedia();
    renderCarousel({ features: undefined });
    expect(slides().map((slide) => slide.getAttribute("aria-label"))).toEqual([
      "1 / 3: Nhắn tin lớp học & trò chuyện riêng",
      "2 / 3: Phòng học trực tuyến",
      "3 / 3: Lịch học & nhắc lịch",
    ]);
    cleanup();

    renderCarousel({
      features: featuresWith({
        classroom_code_tool: true,
        classroom_files_tool: true,
        classroom_whiteboards: true,
      }),
    });
    expect(slides().map((slide) => slide.getAttribute("data-slide"))).toEqual([
      "chat",
      "room",
      "whiteboard",
      "files",
      "calendar",
      "code",
    ]);
    cleanup();

    renderCarousel({
      features: featuresWith({
        classroom_code_tool: true,
        classroom_files_tool: false,
        classroom_whiteboards: false,
      }),
    });
    expect(slides()).toHaveLength(4);
    expect(screen.queryByText("Bảng trắng cộng tác")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Tài liệu & trình chiếu PDF"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Code cùng nhau trong lớp")).toBeInTheDocument();
  });

  it("follows the APG carousel pattern with arrows, dots and arrow keys", () => {
    stubMatchMedia();
    renderCarousel();
    const carousel = region();
    expect(carousel).toHaveAttribute("aria-roledescription", "trình chiếu");
    const [first, second, third] = slides();
    expect(first).not.toHaveAttribute("inert");
    expect(second).toHaveAttribute("inert");
    expect(second).toHaveAttribute("aria-hidden", "true");
    expect(
      within(second!)
        .getByRole("link", { hidden: true, name: "Vào lớp học" })
        .closest("[inert]"),
    ).toBe(second);
    // Only the active slide renders its 3D scene; the rest keep text only.
    expect(first!.querySelector(".mw-scene")).not.toBeNull();
    expect(third!.querySelector(".mw-scene")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Slide tiếp theo" }));
    expect(activeLabel()).toBe("2 / 3: Phòng học trực tuyến");
    expect(first).toHaveAttribute("inert");
    expect(dots()[1]).toHaveAttribute("aria-current", "true");
    expect(dots()[0]).not.toHaveAttribute("aria-current");

    fireEvent.click(dots()[2]!);
    expect(activeLabel()).toBe("3 / 3: Lịch học & nhắc lịch");
    expect(dots()[2]).toHaveAttribute("aria-current", "true");
    expect(dots()[2]).toHaveAccessibleName("Đến slide 3: Lịch học & nhắc lịch");

    fireEvent.click(screen.getByRole("button", { name: "Slide trước" }));
    expect(activeLabel()).toBe("2 / 3: Phòng học trực tuyến");

    // ←/→ while focus is on a dot keeps focus on the current dot.
    act(() => dots()[1]!.focus());
    fireEvent.keyDown(dots()[1]!, { key: "ArrowRight" });
    expect(activeLabel()).toBe("3 / 3: Lịch học & nhắc lịch");
    expect(dots()[2]).toHaveFocus();
    fireEvent.keyDown(dots()[2]!, { key: "ArrowRight" });
    expect(activeLabel()).toBe("1 / 3: Nhắn tin lớp học & trò chuyện riêng");
    fireEvent.keyDown(dots()[0]!, { key: "ArrowLeft" });
    expect(activeLabel()).toBe("3 / 3: Lịch học & nhắc lịch");

    // From inside a slide, focus follows to the newly shown slide.
    const link = within(activeSlide()).getByRole("link", {
      name: "Xem lịch học",
    });
    act(() => link.focus());
    fireEvent.keyDown(link, { key: "ArrowLeft" });
    expect(activeLabel()).toBe("2 / 3: Phòng học trực tuyến");
    expect(activeSlide()).toHaveFocus();
  });

  it("auto-advances every 6 seconds and Pause / Play toggles rotation", () => {
    vi.useFakeTimers();
    stubMatchMedia();
    renderCarousel();
    const live = region().querySelector(".mw-slides");
    expect(live).toHaveAttribute("aria-live", "off");
    expect(region()).toHaveAttribute("data-motion", "running");

    act(() => vi.advanceTimersByTime(WELCOME_AUTOPLAY_MS - 1));
    expect(activeLabel()).toMatch(/^1 \/ 3/);
    act(() => vi.advanceTimersByTime(1));
    expect(activeLabel()).toMatch(/^2 \/ 3/);

    fireEvent.click(
      screen.getByRole("button", { name: "Tạm dừng trình chiếu" }),
    );
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(region()).toHaveAttribute("data-motion", "paused");
    act(() => vi.advanceTimersByTime(WELCOME_AUTOPLAY_MS * 3));
    expect(activeLabel()).toMatch(/^2 \/ 3/);

    fireEvent.click(screen.getByRole("button", { name: "Phát trình chiếu" }));
    expect(live).toHaveAttribute("aria-live", "off");
    act(() => vi.advanceTimersByTime(WELCOME_AUTOPLAY_MS));
    expect(activeLabel()).toMatch(/^3 \/ 3/);
  });

  it("pauses on hover and hidden tabs, and stops once focus moves inside", () => {
    vi.useFakeTimers();
    stubMatchMedia();
    renderCarousel();

    fireEvent.pointerEnter(region());
    expect(region()).toHaveAttribute("data-motion", "paused");
    act(() => vi.advanceTimersByTime(WELCOME_AUTOPLAY_MS * 2));
    expect(activeLabel()).toMatch(/^1 \/ 3/);
    fireEvent.pointerLeave(region());
    act(() => vi.advanceTimersByTime(WELCOME_AUTOPLAY_MS));
    expect(activeLabel()).toMatch(/^2 \/ 3/);

    setDocumentHidden(true);
    expect(region()).toHaveAttribute("data-motion", "paused");
    act(() => vi.advanceTimersByTime(WELCOME_AUTOPLAY_MS * 2));
    expect(activeLabel()).toMatch(/^2 \/ 3/);
    setDocumentHidden(false);
    act(() => vi.advanceTimersByTime(WELCOME_AUTOPLAY_MS));
    expect(activeLabel()).toMatch(/^3 \/ 3/);

    // Focusing the rotation control itself does not stop rotation…
    act(() =>
      screen.getByRole("button", { name: "Tạm dừng trình chiếu" }).focus(),
    );
    act(() => vi.advanceTimersByTime(WELCOME_AUTOPLAY_MS));
    expect(activeLabel()).toMatch(/^1 \/ 3/);
    // …but focus anywhere else inside stops it until Play is pressed.
    act(() => screen.getByRole("button", { name: "Slide tiếp theo" }).focus());
    expect(
      screen.getByRole("button", { name: "Phát trình chiếu" }),
    ).toBeInTheDocument();
    expect(region().querySelector(".mw-slides")).toHaveAttribute(
      "aria-live",
      "polite",
    );
    act(() => vi.advanceTimersByTime(WELCOME_AUTOPLAY_MS * 3));
    expect(activeLabel()).toMatch(/^1 \/ 3/);
  });

  it("pauses while scrolled off screen", () => {
    vi.useFakeTimers();
    stubMatchMedia();
    let notify: IntersectionObserverCallback = () => undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          notify = callback;
        }
        disconnect = disconnect;
        observe = vi.fn();
        takeRecords = () => [];
        unobserve = vi.fn();
      },
    );
    const { unmount } = renderCarousel();
    const observer = {} as IntersectionObserver;

    act(() =>
      notify(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        observer,
      ),
    );
    expect(region()).toHaveAttribute("data-motion", "paused");
    act(() => vi.advanceTimersByTime(WELCOME_AUTOPLAY_MS * 2));
    expect(activeLabel()).toMatch(/^1 \/ 3/);
    act(() =>
      notify([{ isIntersecting: true } as IntersectionObserverEntry], observer),
    );
    act(() => vi.advanceTimersByTime(WELCOME_AUTOPLAY_MS));
    expect(activeLabel()).toMatch(/^2 \/ 3/);

    unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("never auto-rotates or animates with prefers-reduced-motion", () => {
    vi.useFakeTimers();
    stubMatchMedia(true);
    renderCarousel();
    expect(region()).toHaveAttribute("data-reduced-motion", "true");
    expect(
      screen.queryByRole("button", { name: "Tạm dừng trình chiếu" }),
    ).not.toBeInTheDocument();
    expect(region().querySelector(".mw-slides")).toHaveAttribute(
      "aria-live",
      "polite",
    );
    // No assemble phase on first paint either.
    expect(activeSlide()).toHaveAttribute("data-state", "active");

    act(() => vi.advanceTimersByTime(WELCOME_AUTOPLAY_MS * 5));
    expect(activeLabel()).toMatch(/^1 \/ 3/);

    fireEvent.click(screen.getByRole("button", { name: "Slide tiếp theo" }));
    expect(activeLabel()).toMatch(/^2 \/ 3/);
    // The illustration still renders, statically.
    expect(activeSlide().querySelector(".mw-scene")).not.toBeNull();
  });

  it("starts a conversation through the page's dialog opener and links real routes", () => {
    stubMatchMedia();
    const { onStartConversation } = renderCarousel({
      features: featuresWith({
        classroom_code_tool: true,
        classroom_files_tool: true,
        classroom_whiteboards: true,
      }),
    });

    fireEvent.click(
      within(activeSlide()).getByRole("button", {
        name: "Bắt đầu trò chuyện",
      }),
    );
    expect(onStartConversation).toHaveBeenCalledTimes(1);
    // Rotation stops so the button is still there when the dialog closes.
    expect(
      screen.getByRole("button", { name: "Phát trình chiếu" }),
    ).toBeInTheDocument();

    expect(
      slides().map(
        (slide) =>
          within(slide)
            .queryByRole("link", { hidden: true })
            ?.getAttribute("href") ?? null,
      ),
    ).toEqual([
      null,
      "/app/classrooms",
      "/app/classrooms",
      "/app/classrooms",
      "/app/calendar",
      "/app/classrooms",
    ]);
  });

  it("disables the start action with the capability reason", () => {
    stubMatchMedia();
    const { onStartConversation } = renderCarousel({
      createAvailability: { available: false, reason: "feature_disabled" },
    });
    const cta = within(activeSlide()).getByRole("button", {
      name: "Bắt đầu trò chuyện",
    });
    expect(cta).toBeDisabled();
    expect(cta).toHaveAccessibleDescription(
      "Tính năng này đang bị tắt cho workspace hiện tại.",
    );
    fireEvent.click(cta);
    expect(onStartConversation).not.toHaveBeenCalled();
  });

  it("tilts through CSS variables from one animation frame without re-rendering", () => {
    stubMatchMedia();
    const frames: FrameRequestCallback[] = [];
    let nextFrameID = 0;
    const request = vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      nextFrameID += 1;
      return nextFrameID;
    });
    const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", request);
    vi.stubGlobal("cancelAnimationFrame", cancel);
    const { unmount } = renderCarousel();
    const frame = region().querySelector<HTMLElement>(".mw-frame")!;
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({
      bottom: 100,
      height: 100,
      left: 0,
      right: 200,
      toJSON: () => ({}),
      top: 0,
      width: 200,
      x: 0,
      y: 0,
    });

    fireEvent.pointerMove(frame, { clientX: 200, clientY: 0 });
    fireEvent.pointerMove(frame, { clientX: 190, clientY: 5 });
    expect(request).toHaveBeenCalledTimes(1);
    act(() => frames.shift()!(16));
    expect(Number(frame.style.getPropertyValue("--mw-tx"))).toBeGreaterThan(0);
    expect(Number(frame.style.getPropertyValue("--mw-ty"))).toBeLessThan(0);
    expect(request).toHaveBeenCalledTimes(2);

    const removeListener = vi.spyOn(frame, "removeEventListener");
    unmount();
    expect(cancel).toHaveBeenCalledWith(2);
    expect(removeListener).toHaveBeenCalledWith(
      "pointermove",
      expect.any(Function),
    );
    expect(removeListener).toHaveBeenCalledWith(
      "pointerleave",
      expect.any(Function),
    );
  });

  it("leaves no timers or listeners behind after unmount", () => {
    vi.useFakeTimers();
    const mediaQuery = stubMatchMedia();
    const removeDocumentListener = vi.spyOn(document, "removeEventListener");
    const clearTimer = vi.spyOn(window, "clearTimeout");
    const { unmount } = renderCarousel();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
    expect(clearTimer).toHaveBeenCalled();
    expect(removeDocumentListener).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    expect(mediaQuery.remove).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );
  });
});
