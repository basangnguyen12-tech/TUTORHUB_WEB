import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { LANGUAGE_STORAGE_KEY } from "../app/i18n";

afterEach(() => {
  try {
    window.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
  } catch {
    // Ignore restricted storage environments.
  }
});

for (const [name, implementation] of [
  ["hasPointerCapture", () => false],
  ["releasePointerCapture", () => undefined],
  ["setPointerCapture", () => undefined],
  ["scrollIntoView", () => undefined],
] as const) {
  if (!(name in HTMLElement.prototype)) {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      value: implementation,
    });
  }
}
