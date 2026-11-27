import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLASSROOM_PREFERENCES_PREFIX,
  classCodePattern,
  classCoverThemes,
  classroomPreferencesKey,
  clearClassroomPreferences,
  coverThemeFor,
  defaultCoverTheme,
  deriveClassCode,
  emptyClassroomPreferences,
  orderClassesWithPins,
  parseClassroomPreferences,
  randomCodeSuffix,
  setClassCover,
  togglePinnedClass,
  useClassroomPreferences,
  withCodeSuffix,
  writeClassroomPreferences,
} from "./classroomPreferences";

const tenantID = "4b18543a-74de-419f-9fe8-d0c3dfc991eb";
const userID = "be85eb92-0f18-4163-85ba-50e4d343d632";
const classA = "a912f628-f3d2-4c18-84c6-42a9e858dc8d";
const classB = "f24d8c4b-b141-475f-b20a-ed0bfe96da6b";
const classC = "0d0a3b8e-7f39-4bd1-9cf0-6c1c8a3e2f10";
const fixedRandom = () => 0;

describe("classroomPreferences", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("drops malformed or oversized stored values", () => {
    expect(parseClassroomPreferences(null)).toBe(emptyClassroomPreferences);
    expect(parseClassroomPreferences("{not json")).toBe(
      emptyClassroomPreferences,
    );
    expect(
      parseClassroomPreferences(
        JSON.stringify({
          pinned: [classA, classA, 42, "<script>", classB],
          covers: { [classA]: "alpine-lake", [classB]: "unknown-theme" },
        }),
      ),
    ).toEqual({
      pinned: [classA, classB],
      covers: { [classA]: "alpine-lake" },
    });
  });

  it("orders pinned classes first and keeps the rest stable", () => {
    const classes = [{ id: classA }, { id: classB }, { id: classC }];
    let preferences = togglePinnedClass(emptyClassroomPreferences, classC);
    preferences = togglePinnedClass(preferences, classB);
    expect(orderClassesWithPins(classes, preferences).map((c) => c.id)).toEqual(
      [classB, classC, classA],
    );
    preferences = togglePinnedClass(preferences, classB);
    expect(orderClassesWithPins(classes, preferences).map((c) => c.id)).toEqual(
      [classC, classA, classB],
    );
  });

  it("removes the storage key once preferences are back to the default", () => {
    const key = classroomPreferencesKey(tenantID, userID);
    const pinned = togglePinnedClass(emptyClassroomPreferences, classA);
    writeClassroomPreferences(window.localStorage, key, pinned);
    expect(window.localStorage.getItem(key)).toContain(classA);
    writeClassroomPreferences(
      window.localStorage,
      key,
      togglePinnedClass(pinned, classA),
    );
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it("only stores a cover choice that differs from the stable default", () => {
    const fallback = defaultCoverTheme(classA);
    expect(defaultCoverTheme(classA)).toBe(fallback);
    expect(classCoverThemes).toContain(fallback);
    const other = classCoverThemes.find((theme) => theme !== fallback)!;
    const chosen = setClassCover(emptyClassroomPreferences, classA, other);
    expect(coverThemeFor(chosen, classA)).toBe(other);
    expect(setClassCover(chosen, classA, fallback).covers).toEqual({});
  });

  it("never writes storage until the user pins a class", () => {
    const { result } = renderHook(() =>
      useClassroomPreferences(tenantID, userID),
    );
    expect(window.localStorage).toHaveLength(0);
    expect(result.current.isPinned(classA)).toBe(false);

    act(() => result.current.togglePin(classA));
    expect(result.current.isPinned(classA)).toBe(true);
    expect(
      window.localStorage.getItem(classroomPreferencesKey(tenantID, userID)),
    ).toBe(JSON.stringify({ pinned: [classA], covers: {} }));

    act(() => result.current.togglePin(classA));
    expect(window.localStorage).toHaveLength(0);
  });

  it("scopes preferences per tenant and user and clears every scope", () => {
    const otherKey = classroomPreferencesKey(tenantID, classB);
    writeClassroomPreferences(
      window.localStorage,
      otherKey,
      togglePinnedClass(emptyClassroomPreferences, classC),
    );
    window.localStorage.setItem("unrelated", "keep");
    const { result } = renderHook(() =>
      useClassroomPreferences(tenantID, userID),
    );
    expect(result.current.isPinned(classC)).toBe(false);

    expect(otherKey.startsWith(CLASSROOM_PREFERENCES_PREFIX)).toBe(true);
    clearClassroomPreferences(window.localStorage);
    expect(window.localStorage.getItem(otherKey)).toBeNull();
    expect(window.localStorage.getItem("unrelated")).toBe("keep");
    expect(window.localStorage).toHaveLength(1);
  });

  it("derives valid class codes from Vietnamese class names", () => {
    expect(deriveClassCode("Lớp 11 - Tiếng Anh (3)")).toBe(
      "LOP-11-TIENG-ANH-3",
    );
    expect(deriveClassCode("Đại số tuyến tính")).toBe("DAI-SO-TUYEN-TINH");
    expect(deriveClassCode("Cơ sở An toàn thông tin nâng cao học kỳ 2")).toBe(
      "CO-SO-AN-TOAN-THONG-TIN-NA",
    );
    expect(deriveClassCode("Lý", randomCodeSuffix(4, fixedRandom))).toBe(
      "CLS-LY-AAAA",
    );
    expect(deriveClassCode("!!!", "AAAA")).toBe("CLS-AAAA");
    for (const title of ["Lý", "Toán 9A", "  ", "Ngữ văn — chuyên đề"]) {
      expect(deriveClassCode(title)).toMatch(classCodePattern);
    }
  });

  it("appends a retry suffix within the 32-character limit", () => {
    const long = "CO-SO-AN-TOAN-THONG-TIN-NA";
    const retried = withCodeSuffix(long, "AAAA");
    expect(retried).toBe(`${long}-AAAA`);
    expect(withCodeSuffix("A".repeat(32))).toMatch(classCodePattern);
    expect(withCodeSuffix("A".repeat(32)).length).toBeLessThanOrEqual(32);
  });
});
