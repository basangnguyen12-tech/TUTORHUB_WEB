import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../app/i18n";
import {
  CustomBackgroundError,
  DEFAULT_VISUAL_EFFECTS,
  type ClassroomVisualEffectsState,
  type CustomBackgroundItem,
  type CustomBackgroundLibrary,
} from "../app/visualEffects";
import { VisualEffectsPicker } from "./VisualEffectsPicker";

function fakeLibrary(
  overrides: Partial<CustomBackgroundLibrary> = {},
  initialItems: CustomBackgroundItem[] = [],
): CustomBackgroundLibrary {
  const items = [...initialItems];
  return {
    status: "ready",
    items,
    canAdd: items.length < 4,
    add: vi.fn(async () => ({
      id: "uploaded-0001",
      url: "blob:test/uploaded",
    })),
    remove: vi.fn(async () => undefined),
    urlFor: (id) => items.find((item) => item.id === id)?.url ?? null,
    ...overrides,
  };
}

function renderPicker({
  library = fakeLibrary(),
  initial = DEFAULT_VISUAL_EFFECTS,
  surface = "modal",
  disabled = false,
}: {
  library?: CustomBackgroundLibrary;
  initial?: ClassroomVisualEffectsState;
  surface?: "modal" | "drawer";
  disabled?: boolean;
} = {}) {
  const onChange = vi.fn();
  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <VisualEffectsPicker
        disabled={disabled}
        library={library}
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
        surface={surface}
        value={value}
      />
    );
  }
  const view = render(
    <I18nProvider initialLanguage="en">
      <Harness />
    </I18nProvider>,
  );
  return { ...view, onChange };
}

function activateTab(name: string) {
  const tab = screen.getByRole("tab", { name });
  // Radix tabs activate on mouse down (and on focus via arrow keys).
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
  return tab;
}

afterEach(() => cleanup());

describe("VisualEffectsPicker", () => {
  it("offers Backgrounds and Lighting tabs with keyboard roving", async () => {
    renderPicker();
    const tabs = screen.getByRole("tablist", { name: "Effect type" });
    const [backgrounds, lighting] = within(tabs).getAllByRole("tab");
    expect(backgrounds).toHaveAccessibleName("Backgrounds");
    expect(lighting).toHaveAccessibleName("Lighting");
    expect(backgrounds).toHaveAttribute("aria-selected", "true");

    act(() => backgrounds?.focus());
    fireEvent.keyDown(backgrounds as HTMLElement, { key: "ArrowRight" });
    // Radix moves roving focus on the next task.
    await waitFor(() => expect(lighting).toHaveFocus());
    expect(lighting).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("group", { name: "Face brightness" }),
    ).toBeInTheDocument();
  });

  it("selects blur and the seven learning spaces with pressed state", () => {
    const { onChange } = renderPicker();
    const none = screen.getByRole("button", { name: "None" });
    expect(none).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Strong blur" }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_VISUAL_EFFECTS,
      background: { kind: "blur", strength: "strong" },
    });
    expect(screen.getByRole("button", { name: "Strong blur" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(none).toHaveAttribute("aria-pressed", "false");

    const spaces = screen.getByRole("region", { name: "Learning spaces" });
    const presets = within(spaces).getAllByRole("button");
    expect(presets.map((preset) => preset.textContent)).toEqual([
      "Library",
      "Classroom",
      "Nordic study",
      "Lecture hall",
      "Daylight office",
      "Reading room",
      "Botanical",
    ]);
    for (const preset of presets) {
      expect(preset).toHaveAttribute("aria-pressed", "false");
      const image = preset.querySelector("img");
      expect(image).toHaveAttribute("alt", "");
      expect(image?.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    }
    fireEvent.click(within(spaces).getByRole("button", { name: "Library" }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_VISUAL_EFFECTS,
      background: { kind: "preset", presetId: "academic-library" },
    });
    expect(
      within(spaces).getByRole("button", { name: "Library" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("uploads, selects and removes personal backgrounds", async () => {
    const library = fakeLibrary({}, [
      { id: "stored-0001", url: "blob:test/stored" },
    ]);
    const { onChange } = renderPicker({ library });
    expect(
      screen.getByText(/stay on this device \(up to 4 images\)/),
    ).toBeInTheDocument();

    const input = screen.getByTestId("vfx-upload-input");
    const file = new File(["x"], "me.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({
        ...DEFAULT_VISUAL_EFFECTS,
        background: { kind: "custom", imageId: "uploaded-0001" },
      }),
    );
    expect(library.add).toHaveBeenCalledWith(file);
    expect(
      await screen.findByText("Personal background added and selected."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Your image 1" }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_VISUAL_EFFECTS,
      background: { kind: "custom", imageId: "stored-0001" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Remove your image 1" }),
    );
    await waitFor(() =>
      expect(library.remove).toHaveBeenCalledWith("stored-0001"),
    );
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({
        ...DEFAULT_VISUAL_EFFECTS,
        background: { kind: "none" },
      }),
    );
    expect(screen.getByRole("button", { name: "Upload image" })).toHaveFocus();
  });

  it("explains rejected uploads and hides uploads without a device scope", async () => {
    const library = fakeLibrary({
      add: vi.fn(async () => {
        throw new CustomBackgroundError("unsupported_type");
      }),
    });
    const { unmount } = renderPicker({ library });
    fireEvent.change(screen.getByTestId("vfx-upload-input"), {
      target: { files: [new File(["x"], "a.gif", { type: "image/gif" })] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Only JPG, PNG or WebP images are supported.",
    );
    unmount();

    renderPicker({
      library: fakeLibrary({ status: "disabled", canAdd: false }),
    });
    expect(screen.queryByRole("button", { name: "Upload image" })).toBeNull();
    expect(screen.queryByTestId("vfx-upload-input")).toBeNull();
  });

  it("marks the upload tile unavailable once four images are stored", () => {
    const items = [1, 2, 3, 4].map((index) => ({
      id: `stored-000${index}`,
      url: `blob:test/${index}`,
    }));
    renderPicker({ library: fakeLibrary({ canAdd: false }, items) });
    expect(
      screen.getByRole("button", { name: "Upload image" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getAllByRole("button", { name: /^Remove your image/ }),
    ).toHaveLength(4);
  });

  it("adjusts face brightness and tone, then resets to default", () => {
    const { onChange } = renderPicker({ surface: "drawer" });
    activateTab("Lighting");
    const brightness = screen.getByRole("group", { name: "Face brightness" });
    expect(
      within(brightness).getByRole("radio", { name: "Default" }),
    ).toBeChecked();
    expect(
      screen.queryByRole("button", { name: "Reset to default" }),
    ).toBeNull();

    fireEvent.click(
      within(brightness).getByRole("radio", { name: "Low-light boost" }),
    );
    fireEvent.click(screen.getByRole("radio", { name: "Warm" }));
    expect(onChange).toHaveBeenLastCalledWith({
      background: { kind: "none" },
      lighting: { brightness: "low_light", tone: "warm" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT_VISUAL_EFFECTS);
    expect(
      screen.queryByRole("button", { name: "Reset to default" }),
    ).toBeNull();
  });

  it("disables every choice while locked", () => {
    renderPicker({ disabled: true });
    expect(screen.getByRole("button", { name: "None" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Library" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Upload image" }),
    ).toHaveAttribute("aria-disabled", "true");
  });
});
