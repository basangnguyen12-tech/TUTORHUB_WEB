/**
 * ROOM-TOOLS-FILES-02B (ADR-0045 Slice 2): pure model of "Trình chiếu lớp" —
 * which pages a viewer sees, where a presenter's page goes, and the
 * "Theo dõi GV" / "Tự xem" state machine. Page numbers are always the
 * document's original 1-based numbers, so the annotation key `p:<page>` is
 * identical for the teacher (every page) and a student (hidden pages left
 * out): a 5-page document with page 3 hidden shows students frames 1, 2, 4, 5.
 */

/** The original page numbers a viewer gets a frame for, in order. */
export function displayPages(
  pageCount: number,
  hiddenPages: readonly number[],
  showHidden: boolean,
): number[] {
  const count = Math.max(1, Math.floor(pageCount));
  const hidden = showHidden ? new Set<number>() : new Set(hiddenPages);
  const pages: number[] = [];
  for (let page = 1; page <= count; page += 1) {
    if (!hidden.has(page)) pages.push(page);
  }
  // Never leave a viewer without a page (the presenter cannot hide them all).
  return pages.length > 0 ? pages : [1];
}

/** The displayed page closest to `page` (ties go to the later page). */
export function nearestDisplayPage(
  page: number,
  pages: readonly number[],
): number {
  if (pages.length === 0) return 1;
  let best = pages[0] as number;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of pages) {
    const distance = Math.abs(candidate - page);
    if (
      distance < bestDistance ||
      (distance === bestDistance && candidate > best)
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** True when hiding `page` still leaves at least one page for students. */
export function canHidePage(
  pageCount: number,
  hiddenPages: readonly number[],
  page: number,
): boolean {
  if (!Number.isSafeInteger(page) || page < 1 || page > pageCount) {
    return false;
  }
  const hidden = new Set(hiddenPages);
  if (hidden.has(page)) return true;
  return hidden.size + 1 < pageCount;
}

/** The hidden set after toggling `page` (null: refused, would hide all). */
export function toggleHiddenPage(
  pageCount: number,
  hiddenPages: readonly number[],
  page: number,
): number[] | null {
  const hidden = new Set(hiddenPages);
  if (hidden.has(page)) {
    hidden.delete(page);
  } else {
    if (!canHidePage(pageCount, hiddenPages, page)) return null;
    hidden.add(page);
  }
  return [...hidden].sort((left, right) => left - right);
}

/**
 * The page a presenter publishes: the current page, unless it is hidden from
 * students — then the last public page stays (the teacher can preview a
 * hidden page without dragging the class onto it).
 */
export function presenterPublishPage(
  currentPage: number,
  hiddenPages: readonly number[],
  lastPublic: number,
): number {
  return hiddenPages.includes(currentPage) ? lastPublic : currentPage;
}

// ---- Follow state machine ---------------------------------------------------

export interface FollowState {
  /** "Theo dõi GV" (true) or "Tự xem" (false). */
  readonly following: boolean;
  /** Bumped whenever the viewer must scroll to the presenter's page. */
  readonly seq: number;
}

export type FollowEvent =
  /** Wheel, touch pan, scrollbar, page box, keys, thumbnail, search, link. */
  | { readonly type: "manual" }
  /** Pen, highlighter or eraser on a page: never changes following. */
  | { readonly type: "ink" }
  /** The presenter's page changed (or the session just synced). */
  | { readonly type: "presenterMoved" }
  /** "Quay về trang GV" or the "Theo dõi GV" key. */
  | { readonly type: "follow" }
  /** The "Theo dõi GV" key pressed while following. */
  | { readonly type: "unfollow" }
  /** The teacher locked follow: everyone is pinned to the presenter. */
  | { readonly type: "locked" };

export const INITIAL_FOLLOW_STATE: FollowState = Object.freeze({
  following: true,
  seq: 0,
});

export function followReducer(
  state: FollowState,
  event: FollowEvent,
  locked = false,
): FollowState {
  switch (event.type) {
    case "ink":
      return state;
    case "manual":
    case "unfollow":
      // A locked viewer cannot leave the presenter's page.
      return locked || !state.following
        ? state
        : { ...state, following: false };
    case "presenterMoved":
      return state.following || locked
        ? { following: true, seq: state.seq + 1 }
        : state;
    case "follow":
    case "locked":
      return { following: true, seq: state.seq + 1 };
    default:
      return state;
  }
}

/** Keys that move between pages or scroll the page column. */
export const MANUAL_NAVIGATION_KEYS: ReadonlySet<string> = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " ",
]);
