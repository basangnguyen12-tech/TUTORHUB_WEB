import { describe, expect, it } from "vitest";
import {
  canHidePage,
  displayPages,
  followReducer,
  INITIAL_FOLLOW_STATE,
  nearestDisplayPage,
  presenterPublishPage,
  toggleHiddenPage,
  type FollowState,
} from "./pdfPresentationModel";

describe("displayPages", () => {
  it("keeps original page numbers when pages are hidden from students", () => {
    expect(displayPages(5, [3], false)).toEqual([1, 2, 4, 5]);
    // The presenter sees every page.
    expect(displayPages(5, [3], true)).toEqual([1, 2, 3, 4, 5]);
    expect(displayPages(2, [1, 2], false)).toEqual([1]);
  });

  it("maps a hidden or missing page to the nearest shown one", () => {
    expect(nearestDisplayPage(3, [1, 2, 4, 5])).toBe(4);
    expect(nearestDisplayPage(9, [1, 2, 4, 5])).toBe(5);
    expect(nearestDisplayPage(2, [1, 2, 4, 5])).toBe(2);
  });
});

describe("hidden pages", () => {
  it("never hides every page", () => {
    expect(canHidePage(3, [1], 2)).toBe(true);
    expect(canHidePage(3, [1, 2], 3)).toBe(false);
    expect(canHidePage(3, [1, 2], 2)).toBe(true);
    expect(canHidePage(3, [], 4)).toBe(false);
    expect(toggleHiddenPage(3, [1, 2], 3)).toBeNull();
    expect(toggleHiddenPage(5, [4], 2)).toEqual([2, 4]);
    expect(toggleHiddenPage(5, [2, 4], 2)).toEqual([4]);
  });

  it("publishes the last public page while the teacher previews a hidden one", () => {
    expect(presenterPublishPage(3, [2], 1)).toBe(3);
    expect(presenterPublishPage(2, [2], 1)).toBe(1);
  });
});

describe("followReducer (Theo dõi GV / Tự xem)", () => {
  const follow = (
    state: FollowState,
    ...types: Parameters<typeof followReducer>[1]["type"][]
  ) =>
    types.reduce(
      (current, type) => followReducer(current, { type } as never),
      state,
    );

  it("follows the presenter by default and scrolls on every move", () => {
    const moved = followReducer(INITIAL_FOLLOW_STATE, {
      type: "presenterMoved",
    });
    expect(moved).toEqual({ following: true, seq: 1 });
  });

  it("never leaves Theo dõi GV while drawing, erasing or highlighting", () => {
    const state = follow(
      INITIAL_FOLLOW_STATE,
      "ink",
      "ink",
      "presenterMoved",
      "ink",
    );
    expect(state.following).toBe(true);
    expect(state.seq).toBe(1);
  });

  it("switches to Tự xem on manual navigation and stops scrolling", () => {
    const own = follow(INITIAL_FOLLOW_STATE, "manual");
    expect(own.following).toBe(false);
    const moved = followReducer(own, { type: "presenterMoved" });
    expect(moved).toBe(own);
    const back = followReducer(own, { type: "follow" });
    expect(back).toEqual({ following: true, seq: 1 });
  });

  it("pins a locked viewer to the presenter", () => {
    const own = follow(INITIAL_FOLLOW_STATE, "manual");
    const locked = followReducer(own, { type: "locked" }, true);
    expect(locked.following).toBe(true);
    expect(followReducer(locked, { type: "manual" }, true)).toBe(locked);
    expect(followReducer(locked, { type: "unfollow" }, true)).toBe(locked);
    expect(followReducer(own, { type: "presenterMoved" }, true)).toEqual({
      following: true,
      seq: 1,
    });
  });
});
