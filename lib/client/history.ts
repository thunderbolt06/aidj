"use client";

/**
 * What this listener has heard lately (track ids, newest first), kept in
 * localStorage across sets. The pickers push these far down the list, so the
 * same vibe twice in a row - or tomorrow - doesn't open with the same songs.
 * A convenience, not state anyone else needs: it may come back empty.
 */

const STORAGE_KEY = "everplay:recent";
const SKIPPED_KEY = "everplay:skipped";
const KEEP = 300;
/** Shorter than this and a skip says "not this one", not "heard enough". */
export const SKIP_SEC = 20;

function read(key = STORAGE_KEY): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    const ids = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Remember that a track started playing. */
export function notePlayed(id: string) {
  if (typeof window === "undefined" || !id) return;
  try {
    const next = [id, ...read().filter((x) => x !== id)].slice(0, KEEP);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private mode / storage full: picks just lose the history */
  }
}

/** Recently played track ids, newest first - send as `recent` to the pickers. */
export function recentlyPlayed(): string[] {
  return read();
}

/**
 * Remember that the listener skipped a track within SKIP_SEC: the pickers
 * keep it out from then on and steer the set away from what it was like.
 */
export function noteSkipped(id: string) {
  if (typeof window === "undefined" || !id) return;
  try {
    const next = [id, ...read(SKIPPED_KEY).filter((x) => x !== id)].slice(0, KEEP);
    window.localStorage.setItem(SKIPPED_KEY, JSON.stringify(next));
  } catch {
    /* private mode / storage full: picks just lose the skips */
  }
}

/** `recent` and `skipped` for a picker request body (/api/ai/intent, /api/ai/suggest). */
export function listenerHistory(): { recent: string[]; skipped: string[] } {
  return { recent: read(), skipped: read(SKIPPED_KEY) };
}
