/**
 * First-release years from MusicBrainz - a source that is neither Claude nor a
 * store listing, used to settle songs the models disagree on and to audit the
 * years in the library (audit_years.mjs).
 *
 * A recording's `first-release-date` is the earliest release it appears on.
 * That makes it an UPPER bound on the original year, not the year: MusicBrainz
 * keeps remasters, re-recordings and credit variants ("Paul McCartney" vs
 * "Paul McCartney and Wings") as separate recordings, and the one a strict
 * match lands on is often the 1995 reissue of a 1974 song. It can show that a
 * year is too late, never that it is too early.
 *
 * Matching is deliberately strict (same title, same first artist, search
 * score >= 90) - a miss costs nothing, a wrong match would poison the check.
 * Messy YouTube-upload titles mostly miss.
 *
 * Polite by design: one request a second, answers cached on disk.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIBRARY = process.env.LIBRARY_DIR || path.join(ROOT, "library");
const CACHE = path.join(LIBRARY, "sources", "years", "musicbrainz.json");
const UA = "everplay-library-years/0.1 (personal, local music-library tool)";
const GAP_MS = 1100;

const norm = (s) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Title without the YouTube clutter: "(Lyrical)", "| Full Video", "[HD]". */
export function cleanTitle(t) {
  return norm(
    t
      .replace(/[([].*?[)\]]/g, " ")
      .replace(/\|.*$/, " ")
      .replace(/\b(official|lyrical|lyrics?|video|audio|hd|full song|remastered( \d{4})?)\b/gi, " ")
  );
}

/** The first credited artist ("A, B & C" / "A feat. B" -> "A"). */
function firstArtist(a) {
  return norm(a.split(/,|&| feat\.? | ft\.? | x | and /i)[0] ?? a);
}

export function loadCache() {
  try {
    return JSON.parse(readFileSync(CACHE, "utf8"));
  } catch {
    return {};
  }
}

export function saveCache(cache) {
  mkdirSync(path.dirname(CACHE), { recursive: true });
  writeFileSync(`${CACHE}.tmp`, JSON.stringify(cache));
  renameSync(`${CACHE}.tmp`, CACHE);
}

let lastCall = 0;
/** The parsed answer; throws when MusicBrainz could not be reached (that is not "no match"). */
async function get(url) {
  let why = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = lastCall + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) return res.json();
      why = `HTTP ${res.status}`;
      // 503 / 429 is MusicBrainz asking for fewer requests; anything else will not improve
      if (res.status !== 503 && res.status !== 429) break;
    } catch (e) {
      why = e.message; // a stalled or dropped connection - back off and retry
    }
    await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
  }
  throw new Error(`MusicBrainz unreachable (${why})`);
}

/**
 * { year, mbTitle, mbArtist } for the earliest matching recording, or null
 * when nothing matches strictly.
 */
export async function lookupYear(artist, title) {
  const t = cleanTitle(title);
  const a = firstArtist(artist);
  if (!t || !a) return null;
  const q = `recording:"${t.replace(/"/g, " ")}" AND artist:"${a.replace(/"/g, " ")}"`;
  const json = await get(
    `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(q)}&fmt=json&limit=25`
  );
  let best = null;
  for (const r of json.recordings ?? []) {
    if ((r.score ?? 0) < 90) continue;
    if (cleanTitle(r.title ?? "") !== t) continue;
    const names = (r["artist-credit"] ?? []).map((c) => norm(c.name ?? c.artist?.name ?? ""));
    if (!names.some((n) => n && (n === a || n.includes(a) || a.includes(n)))) continue;
    // a live take or a remix is not the song's first release
    if (/live|remix|cover|karaoke|demo|instrumental|acoustic/i.test(r.disambiguation ?? "")) continue;
    const year = Number(/^(\d{4})/.exec(r["first-release-date"] ?? "")?.[1]);
    if (!year || year < 1900) continue;
    if (!best || year < best.year)
      best = { year, mbTitle: r.title, mbArtist: (r["artist-credit"] ?? []).map((c) => c.name).join(", ") };
  }
  return best;
}

/**
 * Cached lookup: `cache` is the object from loadCache(), keyed by track id.
 * Only real answers are cached (a hit or a clean "no match"); an unreachable
 * MusicBrainz throws and the song is asked again next time.
 */
export async function lookupCached(cache, song) {
  if (song.id in cache) return cache[song.id];
  const hit = await lookupYear(song.artist, song.title);
  cache[song.id] = hit;
  return hit;
}

