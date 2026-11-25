import { describe, expect, it } from "vitest";
import {
  CLASSROOM_TOOL_MANIFEST,
  groupClassroomTools,
  isClassroomToolGridKey,
  isClassroomToolID,
  nextClassroomToolIndex,
} from "./registry";

describe("ROOM-TOOLS-CODE-01 classroom tools registry", () => {
  it("groups registered tools by category in manifest order", () => {
    const groups = groupClassroomTools([{ id: "code" }, { id: "whiteboard" }]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.category).toBe("present");
    expect(groups[0]?.titleKey).toBe("classroomTools.groupPresent");
    expect(groups[0]?.tools.map((tool) => tool.id)).toEqual([
      "whiteboard",
      "code",
    ]);
    expect(groupClassroomTools([])).toEqual([]);
    expect(CLASSROOM_TOOL_MANIFEST.code.descriptionKey).toBe(
      "classroomTools.codeDescription",
    );
  });

  it("recognises only known tool ids and grid keys", () => {
    expect(isClassroomToolID("code")).toBe(true);
    expect(isClassroomToolID("arena")).toBe(false);
    expect(isClassroomToolID(undefined)).toBe(false);
    expect(isClassroomToolGridKey("ArrowDown")).toBe(true);
    expect(isClassroomToolGridKey("Enter")).toBe(false);
  });

  it("walks a grouped 4-column grid in two dimensions", () => {
    // Group A: 6 tools (rows [0..3], [4,5]); group B: 3 tools (row [6,7,8]).
    const sizes = [6, 3];
    expect(nextClassroomToolIndex(sizes, 4, 0, "ArrowRight")).toBe(1);
    expect(nextClassroomToolIndex(sizes, 4, 8, "ArrowRight")).toBe(0);
    expect(nextClassroomToolIndex(sizes, 4, 0, "ArrowLeft")).toBe(8);
    expect(nextClassroomToolIndex(sizes, 4, 1, "ArrowDown")).toBe(5);
    // Column 3 clamps to the shorter next row.
    expect(nextClassroomToolIndex(sizes, 4, 3, "ArrowDown")).toBe(5);
    // A new group starts a new row.
    expect(nextClassroomToolIndex(sizes, 4, 5, "ArrowDown")).toBe(7);
    expect(nextClassroomToolIndex(sizes, 4, 7, "ArrowUp")).toBe(5);
    expect(nextClassroomToolIndex(sizes, 4, 6, "ArrowUp")).toBe(4);
    // Edges stay put vertically.
    expect(nextClassroomToolIndex(sizes, 4, 2, "ArrowUp")).toBe(2);
    expect(nextClassroomToolIndex(sizes, 4, 8, "ArrowDown")).toBe(8);
    expect(nextClassroomToolIndex(sizes, 4, 5, "Home")).toBe(0);
    expect(nextClassroomToolIndex(sizes, 4, 2, "End")).toBe(8);
    // Narrow layouts reflow the rows.
    expect(nextClassroomToolIndex(sizes, 2, 0, "ArrowDown")).toBe(2);
    expect(nextClassroomToolIndex([], 4, 0, "ArrowRight")).toBe(-1);
  });
});
