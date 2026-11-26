import type { TranslationKey } from "../../app/i18n";

/**
 * ROOM-TOOLS-CODE-01 / ADR-0043 §1: the classroom tools registry.
 *
 * The manifest is tiny static metadata that lives in the room chunk; each
 * tool's implementation stays behind its own `React.lazy` boundary
 * (`LazyWhiteboardEngine`, `LazyCodeWorkspace`, `LazyDocumentViewer`), so
 * the client entry chunk grows by 0 bytes. Only tools the room page actually registers (implemented
 * and permitted) appear in the Dock's Classroom tools popover.
 */
export const CLASSROOM_TOOL_IDS = ["whiteboard", "code", "files"] as const;

export type ClassroomToolID = (typeof CLASSROOM_TOOL_IDS)[number];

/** Popover groups, in display order (future slices add stem/activity/session). */
export type ClassroomToolCategory = "present" | "stem" | "activity" | "session";

export interface ClassroomToolManifest {
  readonly category: ClassroomToolCategory;
  readonly descriptionKey: TranslationKey;
  readonly id: ClassroomToolID;
  readonly order: number;
}

export const CLASSROOM_TOOL_CATEGORIES: readonly {
  readonly id: ClassroomToolCategory;
  readonly titleKey: TranslationKey;
}[] = [
  { id: "present", titleKey: "classroomTools.groupPresent" },
  { id: "stem", titleKey: "classroomTools.groupStem" },
  { id: "activity", titleKey: "classroomTools.groupActivity" },
  { id: "session", titleKey: "classroomTools.groupSession" },
];

export const CLASSROOM_TOOL_MANIFEST: Readonly<
  Record<ClassroomToolID, ClassroomToolManifest>
> = {
  whiteboard: {
    category: "present",
    descriptionKey: "classroomTools.whiteboardDescription",
    id: "whiteboard",
    order: 10,
  },
  code: {
    category: "present",
    descriptionKey: "classroomTools.codeDescription",
    id: "code",
    order: 20,
  },
  // ROOM-TOOLS-FILES-01B / ADR-0045 §1: the Documents ("Tài liệu") tool.
  files: {
    category: "present",
    descriptionKey: "classroomTools.filesDescription",
    id: "files",
    order: 30,
  },
};

export function isClassroomToolID(value: unknown): value is ClassroomToolID {
  return (
    typeof value === "string" &&
    (CLASSROOM_TOOL_IDS as readonly string[]).includes(value)
  );
}

export interface ClassroomToolGroup<Tool> {
  readonly category: ClassroomToolCategory;
  readonly titleKey: TranslationKey;
  readonly tools: readonly Tool[];
}

/** Groups registered tools by category and manifest order (empty groups dropped). */
export function groupClassroomTools<
  Tool extends { readonly id: ClassroomToolID },
>(tools: readonly Tool[]): ClassroomToolGroup<Tool>[] {
  return CLASSROOM_TOOL_CATEGORIES.flatMap(({ id, titleKey }) => {
    const members = tools
      .filter((tool) => CLASSROOM_TOOL_MANIFEST[tool.id].category === id)
      .sort(
        (left, right) =>
          CLASSROOM_TOOL_MANIFEST[left.id].order -
          CLASSROOM_TOOL_MANIFEST[right.id].order,
      );
    return members.length > 0
      ? [{ category: id, titleKey, tools: members }]
      : [];
  });
}

export type ClassroomToolGridKey =
  "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End";

export function isClassroomToolGridKey(
  key: string,
): key is ClassroomToolGridKey {
  return (
    key === "ArrowLeft" ||
    key === "ArrowRight" ||
    key === "ArrowUp" ||
    key === "ArrowDown" ||
    key === "Home" ||
    key === "End"
  );
}

/**
 * 2D roving-tabindex step over a grouped grid. Each group starts a new row of
 * `columns` cells; Left/Right walk the reading order (wrapping), Up/Down keep
 * the column (clamping to a shorter row) and stop at the first/last row,
 * Home/End jump to the first/last tool. Returns the next flat index.
 */
export function nextClassroomToolIndex(
  groupSizes: readonly number[],
  columns: number,
  current: number,
  key: ClassroomToolGridKey,
): number {
  const total = groupSizes.reduce((sum, size) => sum + size, 0);
  if (total === 0) return -1;
  const safeCurrent = Math.min(Math.max(current, 0), total - 1);
  if (key === "Home") return 0;
  if (key === "End") return total - 1;
  if (key === "ArrowRight") return (safeCurrent + 1) % total;
  if (key === "ArrowLeft") return (safeCurrent - 1 + total) % total;

  const cols = Math.max(1, Math.floor(columns));
  const rows: number[][] = [];
  let offset = 0;
  for (const size of groupSizes) {
    for (let start = 0; start < size; start += cols) {
      const row: number[] = [];
      for (let cell = start; cell < Math.min(size, start + cols); cell += 1) {
        row.push(offset + cell);
      }
      rows.push(row);
    }
    offset += size;
  }
  const rowIndex = rows.findIndex((row) => row.includes(safeCurrent));
  const column = rows[rowIndex]?.indexOf(safeCurrent) ?? 0;
  const targetRow = rows[rowIndex + (key === "ArrowDown" ? 1 : -1)];
  if (!targetRow) return safeCurrent;
  return targetRow[Math.min(column, targetRow.length - 1)] ?? safeCurrent;
}
