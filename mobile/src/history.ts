import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * What this listener has heard and skipped lately (track ids, newest first) -
 * port of the web lib/client/history.ts, backed by AsyncStorage. Loaded once
 * at app start (initHistory) so reads are synchronous; writes go to storage in
 * the background. Sent as `recent` / `skipped` with every pick request, so a
 * vibe tapped twice doesn't open with the same songs and a skipped song stays
 * gone. A convenience: if storage fails the picks just lose the history.
 */

const RECENT_KEY = "everplay:recent";
const SKIPPED_KEY = "everplay:skipped";
const KEEP = 300;
/** Shorter than this and a skip says "not this one", not "heard enough". */
export const SKIP_SEC = 20;

let recent: string[] = [];
let skipped: string[] = [];

const ids = (raw: string | null): string[] => {
  try {
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/** Hydrate the in-memory lists; call once at app start. */
export async function initHistory(): Promise<void> {
  try {
    const [r, s] = await AsyncStorage.multiGet([RECENT_KEY, SKIPPED_KEY]);
    recent = ids(r[1]);
    skipped = ids(s[1]);
  } catch {
    /* empty history stands */
  }
}

function push(list: string[], id: string, key: string): string[] {
  const next = [id, ...list.filter((x) => x !== id)].slice(0, KEEP);
  AsyncStorage.setItem(key, JSON.stringify(next)).catch(() => {});
  return next;
}

/** Remember that a track started playing. */
export function notePlayed(id: string) {
  if (id) recent = push(recent, id, RECENT_KEY);
}

/** Remember that the listener skipped a track within SKIP_SEC. */
export function noteSkipped(id: string) {
  if (id) skipped = push(skipped, id, SKIPPED_KEY);
}

/** `recent` and `skipped` for a picker request body (/api/ai/intent, /api/ai/suggest). */
export function listenerHistory(): { recent: string[]; skipped: string[] } {
  return { recent, skipped };
}
