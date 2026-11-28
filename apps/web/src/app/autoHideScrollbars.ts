import { useEffect } from "react";

/**
 * Overlay-style scrollbars: an element with `.scroll-autohide` keeps its
 * scrollbar transparent and only shows it while it is being scrolled (wheel,
 * drag, keyboard or touch), then hides it again once scrolling has stopped.
 * The CSS lives in styles.css; this hook toggles `data-scrolling`.
 *
 * One capture-phase listener on the document covers every such element
 * (`scroll` does not bubble), shared by every caller.
 */
export const AUTO_HIDE_SCROLLBAR_CLASS = "scroll-autohide";
export const SCROLLBAR_IDLE_MS = 900;

const timers = new WeakMap<Element, number>();
let subscribers = 0;

function onScroll(event: Event) {
  const target = event.target;
  if (
    !(target instanceof Element) ||
    !target.classList.contains(AUTO_HIDE_SCROLLBAR_CLASS)
  ) {
    return;
  }
  if (!target.hasAttribute("data-scrolling")) {
    target.setAttribute("data-scrolling", "");
  }
  const pending = timers.get(target);
  if (pending !== undefined) {
    window.clearTimeout(pending);
  }
  timers.set(
    target,
    window.setTimeout(() => {
      timers.delete(target);
      target.removeAttribute("data-scrolling");
    }, SCROLLBAR_IDLE_MS),
  );
}

export function useAutoHideScrollbars() {
  useEffect(() => {
    subscribers += 1;
    if (subscribers === 1) {
      document.addEventListener("scroll", onScroll, {
        capture: true,
        passive: true,
      });
    }
    return () => {
      subscribers -= 1;
      if (subscribers === 0) {
        document.removeEventListener("scroll", onScroll, { capture: true });
      }
    };
  }, []);
}
