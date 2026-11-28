import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_HIDE_SCROLLBAR_CLASS,
  SCROLLBAR_IDLE_MS,
  useAutoHideScrollbars,
} from "./autoHideScrollbars";

describe("useAutoHideScrollbars", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  function scroller(className = AUTO_HIDE_SCROLLBAR_CLASS) {
    const element = document.createElement("div");
    element.className = className;
    document.body.append(element);
    return element;
  }

  it("shows the scrollbar while scrolling and hides it once scrolling stops", () => {
    vi.useFakeTimers();
    const hook = renderHook(() => useAutoHideScrollbars());
    const element = scroller();
    const plain = scroller("conversation-list");

    element.dispatchEvent(new Event("scroll"));
    plain.dispatchEvent(new Event("scroll"));
    expect(element).toHaveAttribute("data-scrolling");
    expect(plain).not.toHaveAttribute("data-scrolling");

    // Continued scrolling keeps it visible.
    vi.advanceTimersByTime(SCROLLBAR_IDLE_MS - 100);
    element.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(SCROLLBAR_IDLE_MS - 100);
    expect(element).toHaveAttribute("data-scrolling");

    vi.advanceTimersByTime(100);
    expect(element).not.toHaveAttribute("data-scrolling");

    // No listener is left behind after the last user unmounts.
    hook.unmount();
    element.dispatchEvent(new Event("scroll"));
    expect(element).not.toHaveAttribute("data-scrolling");
  });
});
