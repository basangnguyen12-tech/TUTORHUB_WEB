import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../app/i18n";
import { ScreenshotEditor } from "./ScreenshotEditor";

function capture(width = 1000, height = 500) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function renderEditor(
  exportImage = vi
    .fn()
    .mockResolvedValue(
      new File(["png"], "screenshot.png", { type: "image/png" }),
    ),
) {
  const props = {
    capture: capture(),
    exportImage,
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    onRetake: vi.fn(),
  };
  render(
    <I18nProvider initialLanguage="en">
      <ScreenshotEditor {...props} />
    </I18nProvider>,
  );
  return props;
}

describe("ScreenshotEditor", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("opens as a labelled modal with the whole capture selected and focused", async () => {
    renderEditor();

    const dialog = await screen.findByRole("dialog", {
      name: "Crop screenshot",
    });
    expect(dialog).toHaveAccessibleDescription(/Drag to choose the area/);
    const selection = screen.getByRole("group", {
      name: "Selection 1000 × 500 px at 0, 0",
    });
    await waitFor(() => expect(selection).toHaveFocus());
    expect(screen.getByText("1000 × 500 px")).toBeInTheDocument();
  });

  it("resizes with Shift+arrows, moves with arrows and confirms with Enter", async () => {
    const props = renderEditor();
    const selection = await screen.findByRole("group", {
      name: /^Selection/,
    });

    fireEvent.keyDown(selection, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(selection, { key: "ArrowUp", shiftKey: true });
    expect(selection).toHaveAccessibleName("Selection 990 × 495 px at 0, 0");
    fireEvent.keyDown(selection, { key: "ArrowRight" });
    fireEvent.keyDown(selection, { key: "ArrowDown" });
    expect(selection).toHaveAccessibleName("Selection 990 × 495 px at 10, 5");
    // The crop never leaves the image.
    fireEvent.keyDown(selection, { key: "ArrowRight" });
    expect(selection).toHaveAccessibleName("Selection 990 × 495 px at 10, 5");

    fireEvent.keyDown(selection, { key: "Enter" });
    await waitFor(() => expect(props.onConfirm).toHaveBeenCalledTimes(1));
    const [source, crop] = props.exportImage.mock.calls[0] ?? [];
    expect(source).toBe(props.capture);
    expect(crop).toMatchObject({ height: 0.99, width: 0.99 });
    expect(props.onConfirm.mock.calls[0]?.[0]).toBeInstanceOf(File);
  });

  it("reports an export failure and keeps the editor open", async () => {
    const props = renderEditor(
      vi.fn().mockRejectedValue(new RangeError("too large")),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Use image" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not prepare the image.",
    );
    expect(props.onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("offers retake, cancel and Escape", async () => {
    const props = renderEditor();

    fireEvent.click(await screen.findByRole("button", { name: "Retake" }));
    expect(props.onRetake).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(props.onCancel).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(props.onCancel).toHaveBeenCalledTimes(3);
  });
});
