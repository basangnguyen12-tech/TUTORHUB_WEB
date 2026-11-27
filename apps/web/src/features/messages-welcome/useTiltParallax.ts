import { useEffect, type RefObject } from "react";

const EASING = 0.14;
const SETTLE = 0.002;

function clampUnit(value: number) {
  return Math.max(-1, Math.min(1, value));
}

/**
 * MSG-WELCOME-3D-01: pointer-driven 3D tilt. Writes `--mw-tx` / `--mw-ty`
 * (each in [-1, 1]) straight onto the target element from a single
 * requestAnimationFrame loop, so pointer moves never trigger a React render.
 * The values ease back to 0 when the pointer leaves, and every listener and
 * pending frame is released on cleanup or when `enabled` turns false.
 */
export function useTiltParallax(
  target: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  useEffect(() => {
    const element = target.current;
    if (
      !element ||
      !enabled ||
      typeof window.requestAnimationFrame !== "function"
    ) {
      return undefined;
    }

    let frame = 0;
    let rect: DOMRect | null = null;
    let goalX = 0;
    let goalY = 0;
    let currentX = 0;
    let currentY = 0;

    const write = () => {
      element.style.setProperty("--mw-tx", currentX.toFixed(3));
      element.style.setProperty("--mw-ty", currentY.toFixed(3));
    };

    const step = () => {
      frame = 0;
      currentX += (goalX - currentX) * EASING;
      currentY += (goalY - currentY) * EASING;
      if (
        Math.abs(goalX - currentX) < SETTLE &&
        Math.abs(goalY - currentY) < SETTLE
      ) {
        currentX = goalX;
        currentY = goalY;
      } else {
        frame = window.requestAnimationFrame(step);
      }
      write();
    };

    const schedule = () => {
      if (!frame) {
        frame = window.requestAnimationFrame(step);
      }
    };

    const handleMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") {
        return;
      }
      rect ??= element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }
      goalX = clampUnit(((event.clientX - rect.left) / rect.width) * 2 - 1);
      goalY = clampUnit(((event.clientY - rect.top) / rect.height) * 2 - 1);
      schedule();
    };

    const handleLeave = () => {
      rect = null;
      goalX = 0;
      goalY = 0;
      schedule();
    };

    element.addEventListener("pointermove", handleMove);
    element.addEventListener("pointerleave", handleLeave);
    return () => {
      element.removeEventListener("pointermove", handleMove);
      element.removeEventListener("pointerleave", handleLeave);
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      element.style.removeProperty("--mw-tx");
      element.style.removeProperty("--mw-ty");
    };
  }, [enabled, target]);
}
