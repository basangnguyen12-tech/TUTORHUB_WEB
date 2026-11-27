import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * CLASS-CLASSIN-UI-01: light, per-(tenant, user) classroom list preferences
 * (pinned classes and the chosen cover theme). The default state is never
 * written: storage is only touched after the user pins a class or picks a
 * cover, and an all-default state removes the key again.
 */
export const CLASSROOM_PREFERENCES_PREFIX = "tutorhub.classroom-prefs:";

export const classCoverThemes = [
  "starry-night",
  "pastel-dawn",
  "alpine-lake",
  "golden-horizon",
  "misty-pine",
  "minimal-studio",
  "coral-bay",
  "lilac-dusk",
] as const;
export type ClassCoverTheme = (typeof classCoverThemes)[number];

export interface ClassroomPreferences {
  /** Pinned class IDs, most recently pinned first. */
  readonly pinned: readonly string[];
  readonly covers: Readonly<Record<string, ClassCoverTheme>>;
}

export const emptyClassroomPreferences: ClassroomPreferences = Object.freeze({
  pinned: Object.freeze([]) as readonly string[],
  covers: Object.freeze({}),
});

const maxPinned = 100;
const maxCovers = 300;
const classIDPattern = /^[A-Za-z0-9-]{1,64}$/;

export function isClassCoverTheme(value: unknown): value is ClassCoverTheme {
  return classCoverThemes.some((theme) => theme === value);
}

export function classroomPreferencesKey(tenantID: string, userID: string) {
  return `${CLASSROOM_PREFERENCES_PREFIX}${tenantID}:${userID}`;
}

/** Parses stored preferences defensively; anything malformed is dropped. */
export function parseClassroomPreferences(
  raw: string | null,
): ClassroomPreferences {
  if (!raw) {
    return emptyClassroomPreferences;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return emptyClassroomPreferences;
  }
  if (typeof value !== "object" || value === null) {
    return emptyClassroomPreferences;
  }
  const record = value as { pinned?: unknown; covers?: unknown };
  const pinned = Array.isArray(record.pinned)
    ? [
        ...new Set(
          record.pinned.filter(
            (id): id is string =>
              typeof id === "string" && classIDPattern.test(id),
          ),
        ),
      ].slice(0, maxPinned)
    : [];
  const covers: Record<string, ClassCoverTheme> = {};
  if (typeof record.covers === "object" && record.covers !== null) {
    for (const [id, theme] of Object.entries(record.covers).slice(
      0,
      maxCovers,
    )) {
      if (classIDPattern.test(id) && isClassCoverTheme(theme)) {
        covers[id] = theme;
      }
    }
  }
  return { pinned, covers };
}

function isDefaultState(preferences: ClassroomPreferences) {
  return (
    preferences.pinned.length === 0 &&
    Object.keys(preferences.covers).length === 0
  );
}

export function safeClassroomStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readClassroomPreferences(
  storage: Storage | null,
  key: string,
): ClassroomPreferences {
  if (!storage) {
    return emptyClassroomPreferences;
  }
  try {
    return parseClassroomPreferences(storage.getItem(key));
  } catch {
    return emptyClassroomPreferences;
  }
}

/** Persists an explicit user change; the default state removes the key. */
export function writeClassroomPreferences(
  storage: Storage | null,
  key: string,
  preferences: ClassroomPreferences,
) {
  if (!storage) {
    return;
  }
  try {
    if (isDefaultState(preferences)) {
      storage.removeItem(key);
    } else {
      storage.setItem(
        key,
        JSON.stringify({
          pinned: preferences.pinned,
          covers: preferences.covers,
        }),
      );
    }
  } catch {
    // Storage may be full or blocked; the in-memory state still applies.
  }
}

/** Removes every stored classroom preference (e.g. on sign-out). */
export function clearClassroomPreferences(storage: Storage | null) {
  if (!storage) {
    return;
  }
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(CLASSROOM_PREFERENCES_PREFIX)) {
        keys.push(key);
      }
    }
    for (const key of keys) {
      storage.removeItem(key);
    }
  } catch {
    // Best effort only.
  }
}

export function togglePinnedClass(
  preferences: ClassroomPreferences,
  classID: string,
): ClassroomPreferences {
  const pinned = preferences.pinned.includes(classID)
    ? preferences.pinned.filter((id) => id !== classID)
    : [classID, ...preferences.pinned].slice(0, maxPinned);
  return { ...preferences, pinned };
}

export function setClassCover(
  preferences: ClassroomPreferences,
  classID: string,
  theme: ClassCoverTheme | null,
): ClassroomPreferences {
  const covers = { ...preferences.covers };
  if (!theme || theme === defaultCoverTheme(classID)) {
    delete covers[classID];
  } else {
    covers[classID] = theme;
  }
  return { ...preferences, covers };
}

/** Stable default cover for a class (FNV-1a hash of its ID). */
export function defaultCoverTheme(classID: string): ClassCoverTheme {
  let hash = 0x811c9dc5;
  for (let index = 0; index < classID.length; index += 1) {
    hash ^= classID.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (
    classCoverThemes[(hash >>> 0) % classCoverThemes.length] ??
    classCoverThemes[0]
  );
}

export function coverThemeFor(
  preferences: ClassroomPreferences,
  classID: string,
): ClassCoverTheme {
  return preferences.covers[classID] ?? defaultCoverTheme(classID);
}

/** Pinned classes first (most recently pinned first), the rest keep order. */
export function orderClassesWithPins<T extends { id: string }>(
  classes: readonly T[],
  preferences: ClassroomPreferences,
): T[] {
  if (preferences.pinned.length === 0) {
    return [...classes];
  }
  const rank = new Map(preferences.pinned.map((id, index) => [id, index]));
  return classes
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftRank = rank.get(left.item.id) ?? Number.POSITIVE_INFINITY;
      const rightRank = rank.get(right.item.id) ?? Number.POSITIVE_INFINITY;
      return leftRank === rightRank
        ? left.index - right.index
        : leftRank - rightRank;
    })
    .map(({ item }) => item);
}

const vietnameseD = /[Đđ]/g;
const combiningMarks = /[̀-ͯ]/g;
export const classCodePattern = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function randomCodeSuffix(
  length = 4,
  random: () => number = Math.random,
) {
  let suffix = "";
  for (let index = 0; index < length; index += 1) {
    suffix += codeAlphabet[Math.floor(random() * codeAlphabet.length)];
  }
  return suffix;
}

/**
 * Derives a valid class code (`/^[A-Z0-9][A-Z0-9_-]{2,31}$/`) from a class
 * name: Vietnamese diacritics are folded, separators become `-`, the result
 * is capped at 26 characters and short results get a `CLS-` prefix plus the
 * given suffix (pass a stable one while rendering).
 */
export function deriveClassCode(
  title: string,
  fallbackSuffix: string = randomCodeSuffix(),
) {
  const folded = title
    .normalize("NFD")
    .replace(combiningMarks, "")
    .replace(vietnameseD, "D")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 26)
    .replace(/-+$/, "");
  if (folded.length >= 3 && classCodePattern.test(folded)) {
    return folded;
  }
  return `CLS-${folded ? `${folded}-` : ""}${fallbackSuffix}`
    .slice(0, 32)
    .replace(/-+$/, "");
}

/** Appends a fresh `-XXXX` suffix while keeping the 32-character limit. */
export function withCodeSuffix(
  code: string,
  suffix: string = randomCodeSuffix(),
) {
  return `${code.slice(0, 27).replace(/-+$/, "")}-${suffix}`;
}

/**
 * Reads the stored preferences once per (tenant, user) and only writes after
 * an explicit user change.
 */
export function useClassroomPreferences(
  tenantID: string | undefined,
  userID: string | undefined,
) {
  const key =
    tenantID && userID ? classroomPreferencesKey(tenantID, userID) : null;
  const [state, setState] = useState<{
    key: string | null;
    preferences: ClassroomPreferences;
  }>(() => ({
    key,
    preferences: key
      ? readClassroomPreferences(safeClassroomStorage(), key)
      : emptyClassroomPreferences,
  }));
  const preferences =
    state.key === key
      ? state.preferences
      : key
        ? readClassroomPreferences(safeClassroomStorage(), key)
        : emptyClassroomPreferences;

  useEffect(() => {
    if (!key || typeof window === "undefined") {
      return;
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key === key) {
        setState({
          key,
          preferences: parseClassroomPreferences(event.newValue),
        });
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key]);

  const update = useCallback(
    (change: (current: ClassroomPreferences) => ClassroomPreferences) => {
      if (!key) {
        return;
      }
      const next = change(preferences);
      writeClassroomPreferences(safeClassroomStorage(), key, next);
      setState({ key, preferences: next });
    },
    [key, preferences],
  );

  return useMemo(
    () => ({
      preferences,
      coverFor: (classID: string) => coverThemeFor(preferences, classID),
      isPinned: (classID: string) => preferences.pinned.includes(classID),
      setCover: (classID: string, theme: ClassCoverTheme | null) =>
        update((current) => setClassCover(current, classID, theme)),
      togglePin: (classID: string) =>
        update((current) => togglePinnedClass(current, classID)),
    }),
    [preferences, update],
  );
}
