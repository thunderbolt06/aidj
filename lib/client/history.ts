"use client";

/**
 * What this listener has heard lately (track ids, newest first), kept in
 * localStorage across sets. The pickers push these far down the list, so the
 * same vibe twice in a row - or tomorrow - doesn't open with the same songs.
 * A convenience, not state anyone else needs: it may come back empty.
 */

const STORAGE_KEY = "everplay:recent";
const KEEP = 300;

function read(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
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
