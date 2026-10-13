import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { camelotDistance } from "@/lib/audio/analysis";
import { toIsoCodes } from "@/lib/languages";
import { signUrl } from "@/lib/server/cloudfrontSign";
import type { Track, TrackKind, TrackLicense, TrackMeta } from "@/lib/types";

/**
 * The pre-built music library (see scripts/library/). Replaces the YouTube
 * extractor: every track is already downloaded, analyzed and indexed, so
 * search is an in-memory scan and "loading" a track is two static reads.
 *
 * Two modes:
 *  - local  (default): reads LIBRARY_DIR (./library) off disk.
 *  - remote (LIBRARY_URL set): the same folder synced to any static host
 *    (R2 / S3 / a volume behind nginx). Vercel can't hold the audio, so prod
 *    reads catalog + meta over HTTP and redirects the browser to the audio.
 */
const LIBRARY_DIR = process.env.LIBRARY_DIR || path.join(process.cwd(), "library");
export const LIBRARY_URL = (process.env.LIBRARY_URL || "").replace(/\/+$/, "");

export interface CatalogRow {
  id: string;
  kind: TrackKind;
  title: string;
  artist: string;
  duration: number;
  bpm: number;
  bpmConfidence: number;
  camelot: string | null;
  intensity: number;
  genres: string[];
  tags: string[];
  /** ISO 639-1 code, null when unknown (untagged or instrumental). */
  language?: string | null;
  instrumental: boolean;
  popularity: number;
  license: string | null;
  licenseUrl?: string | null;
  source: string;
  sourceUrl?: string | null;
  file: string;
}

interface Catalog {
  tracks: CatalogRow[];
  byId: Map<string, CatalogRow>;
  /** Lowercased "title artist genres tags" per row, parallel to `tracks`. */
  haystack: string[];
  maxPopularity: number;
  /** Songs per language code. */
  languages: Map<string, number>;
}

let cached: { catalog: Catalog; stamp: number } | null = null;
const REMOTE_TTL_MS = 5 * 60_000;

/**
 * TEMPORARY: the openly-licensed crate (FMA) is switched off - nobody knows
 * those songs, so they don't pull people in. The files and catalog rows stay
 * on disk; set LIBRARY_FREE_SONGS=1 to bring them back. FX and loops are
 * unaffected.
 */
const FREE_SONGS = process.env.LIBRARY_FREE_SONGS === "1";
const FREE_SOURCES = new Set(["fma", "freesound"]);

function indexCatalog(all: CatalogRow[]): Catalog {
  const rows = FREE_SONGS
    ? all
    : all.filter((r) => r.kind !== "song" || !FREE_SOURCES.has(r.source));
  const languages = new Map<string, number>();
  for (const r of rows)
    if (r.kind === "song" && r.language)
      languages.set(r.language, (languages.get(r.language) ?? 0) + 1);
  return {
    tracks: rows,
    languages,
    byId: new Map(rows.map((r) => [r.id, r])),
    haystack: rows.map((r) =>
      [r.title, r.artist, ...r.genres, ...r.tags].join(" ").toLowerCase()
    ),
    maxPopularity: rows.reduce((m, r) => Math.max(m, r.popularity), 1),
  };
}

export async function loadCatalog(): Promise<Catalog> {
  if (LIBRARY_URL) {
    if (cached && Date.now() - cached.stamp < REMOTE_TTL_MS) return cached.catalog;
    const res = await fetch(signUrl(`${LIBRARY_URL}/catalog.json`));
    if (!res.ok) throw new Error(`library catalog unreachable (${res.status})`);
    cached = { catalog: indexCatalog((await res.json()).tracks), stamp: Date.now() };
    return cached.catalog;
  }
  const file = path.join(LIBRARY_DIR, "catalog.json");
  let mtime: number;
  try {
    mtime = (await stat(file)).mtimeMs;
  } catch {
    throw new Error(
      "library is empty - run `npm run library:fetch` then `npm run library:ingest`"
    );
  }
  // re-read when ingest rewrites the index, so new tracks appear without a restart
  if (cached?.stamp === mtime) return cached.catalog;
  const json = JSON.parse(await readFile(file, "utf8"));
  cached = { catalog: indexCatalog(json.tracks), stamp: mtime };
  return cached.catalog;
}

/**
 * Keeps the songs in the listener's languages (codes, labels or ISO codes).
 * No selection - or one the library has nothing in - means no constraint: a
 * language setting must narrow the picks, never leave the DJ with silence.
 * FX and loops always pass.
 */
function languageFilter(cat: Catalog, languages: unknown): ((r: CatalogRow) => boolean) | null {
  const want = toIsoCodes(languages).filter((l) => cat.languages.has(l));
  if (!want.length) return null;
  return (r) => r.kind !== "song" || (!!r.language && want.includes(r.language));
}

function coverUrl(id: string, origin: string): string {
  return LIBRARY_URL
    ? signUrl(`${LIBRARY_URL}/covers/${id}.jpg`, 24)
    : `${origin}/api/cover/${id}`;
}

export function toTrack(r: CatalogRow, origin: string): Track {
  return {
    id: r.id,
    title: r.title,
    artist: r.artist,
    duration: r.duration,
    thumbnail: coverUrl(r.id, origin),
    kind: r.kind,
    bpm: r.bpm,
    camelot: r.camelot,
    intensity: r.intensity,
    genres: r.genres.slice(0, 3),
    license: r.license,
    licenseUrl: r.licenseUrl ?? null,
    sourceUrl: r.sourceUrl ?? null,
  };
}

export interface SearchOptions {
  limit?: number;
  /** "song" (default), "sfx", "loop" or "all". */
  kind?: TrackKind | "all";
  /** Preferred song languages: filters browsing, ranks first when searching. */
  languages?: string[];
}

/**
 * Query syntax: free words match title / artist / genre / tag;
 * `id:<trackId>` resolves one exact track (how AI picks are addressed);
 * `128bpm` keeps tempos within ±4; a Camelot code (`8A`) keeps that key.
 * An empty query returns the most popular entries.
 */
export async function searchLibrary(
  query: string,
  origin: string,
  { limit = 12, kind = "song", languages }: SearchOptions = {}
): Promise<Track[]> {
  const cat = await loadCatalog();
  const inLanguage = languageFilter(cat, languages);
  const q = query.trim();
  if (q.toLowerCase().startsWith("id:")) {
    const row = cat.byId.get(q.slice(3).trim());
    return row ? [toTrack(row, origin)] : [];
  }

  let bpm: number | null = null;
  let key: string | null = null;
  const words: string[] = [];
  for (const tok of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    const b = /^(\d{2,3})bpm$/.exec(tok);
    if (b) bpm = parseInt(b[1], 10);
    else if (/^(1[0-2]|[1-9])[ab]$/.test(tok)) key = tok.toUpperCase();
    else words.push(tok);
  }

  const scored: { row: CatalogRow; score: number }[] = [];
  cat.tracks.forEach((row, i) => {
    if (kind !== "all" && row.kind !== kind) return;
    if (bpm !== null && Math.abs(row.bpm - bpm) > 4) return;
    if (key !== null && row.camelot !== key) return;
    let score = 0;
    // typing a name is asking for that song whatever its language, so the
    // setting only reorders a search - but it does decide what browsing shows
    if (inLanguage) {
      if (inLanguage(row)) score += 1;
      else if (!words.length) return;
    }
    if (words.length) {
      const title = row.title.toLowerCase();
      const artist = row.artist.toLowerCase();
      for (const w of words) {
        if (!cat.haystack[i].includes(w)) return; // every word must hit
        score += title.includes(w) ? 3 : artist.includes(w) ? 3 : 1.5;
      }
    }
    score += Math.log1p(row.popularity) / Math.log1p(cat.maxPopularity);
    scored.push({ row, score });
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => toTrack(s.row, origin));
}

interface StoredMeta
  extends Omit<TrackMeta, "thumbnail" | "license" | "licenseUrl" | "licenseInfo"> {
  file: string;
  license?: TrackLicense;
}

async function readMeta(id: string): Promise<StoredMeta> {
  if (!/^[\w-]+$/.test(id)) throw new Error("bad track id");
  if (LIBRARY_URL) {
    const res = await fetch(signUrl(`${LIBRARY_URL}/meta/${id}.json`));
    if (!res.ok) throw new Error(`track ${id} not in library`);
    return res.json();
  }
  try {
    return JSON.parse(await readFile(path.join(LIBRARY_DIR, "meta", `${id}.json`), "utf8"));
  } catch {
    throw new Error(`track ${id} not in library`);
  }
}

/** Everything the player needs, analysis included - no client-side compute. */
export async function getTrackMeta(id: string, origin: string): Promise<TrackMeta> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { file, license, ...meta } = await readMeta(id);
  return {
    ...meta,
    thumbnail: coverUrl(id, origin),
    license: license?.name ?? null,
    licenseUrl: license?.url ?? null,
    licenseInfo: license,
  };
}

/** Local path of a track's audio (local mode only). */
export async function getAudioFile(id: string): Promise<string> {
  const row = (await loadCatalog()).byId.get(id);
  if (!row) throw new Error(`track ${id} not in library`);
  return path.join(LIBRARY_DIR, "audio", row.file);
}

/** Public audio URL in remote mode, else null. */
export async function remoteAudioUrl(id: string): Promise<string | null> {
  if (!LIBRARY_URL) return null;
  const row = (await loadCatalog()).byId.get(id);
  if (!row) throw new Error(`track ${id} not in library`);
  return signUrl(`${LIBRARY_URL}/audio/${row.file}`);
}

export function coverFile(id: string): string {
  return path.join(LIBRARY_DIR, "covers", `${id}.jpg`);
}

/** Audio bytes regardless of mode (stems / alignment feed these to models). */
export async function getAudioBytes(id: string): Promise<Buffer> {
  const url = await remoteAudioUrl(id);
  if (url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`library audio failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
  return readFile(await getAudioFile(id));
}

// ── Picking: what plays next ───────────────────────────────────────────────

/** Tempo distance in octaves, treating half/double time as compatible. */
function tempoGap(a: number, b: number): number {
  if (a <= 0 || b <= 0) return 0.2;
  const r = Math.abs(Math.log2(b / a));
  return Math.min(r, Math.abs(r - 1));
}

function sharesGenre(a: CatalogRow, b: CatalogRow): boolean {
  return a.genres.some((g) => b.genres.includes(g));
}

/** 0..1: how cleanly `b` mixes out of `a` (tempo, key, genre). */
function mixability(a: CatalogRow, b: CatalogRow): number {
  const tempo = Math.exp(-Math.pow(tempoGap(a.bpm, b.bpm) / 0.1, 2));
  const dist = camelotDistance(a.camelot, b.camelot);
  const key = dist === 0 ? 1 : dist === 1 ? 0.85 : dist === 2 ? 0.45 : 0.15;
  return 0.4 * tempo + 0.35 * key + 0.25 * (sharesGenre(a, b) ? 1 : 0.3);
}

export interface ArcTarget {
  energy: number;
  phase?: string;
  bpm?: [number, number];
}

export interface Pick {
  row: CatalogRow;
  tag: "safe" | "shift" | "wild";
}

function resolveCurrent(cat: Catalog, current: string | undefined): CatalogRow | null {
  if (!current) return null;
  const byId = cat.byId.get(current.replace(/^id:/, ""));
  if (byId) return byId;
  // callers send "Title - Artist"
  const needle = current.toLowerCase();
  return (
    cat.tracks.find((r) => `${r.title} - ${r.artist}`.toLowerCase() === needle) ?? null
  );
}

/**
 * The 9-pick spread every "what next?" surface uses - 5 safe, 3 energy
 * shifts, 1 wildcard - chosen from precomputed tempo / key / intensity
 * instead of an LLM round-trip, so refills are instant and always mixable.
 */
export async function pickNext(opts: {
  current?: string;
  arc?: ArcTarget | null;
  exclude?: string[];
  count?: number;
  languages?: string[];
}): Promise<Pick[]> {
  const cat = await loadCatalog();
  const cur = resolveCurrent(cat, opts.current);
  const exclude = new Set(opts.exclude ?? []);
  if (cur) exclude.add(cur.id);
  const inLanguage = languageFilter(cat, opts.languages);
  const pool = cat.tracks.filter(
    (r) => r.kind === "song" && !exclude.has(r.id) && (!inLanguage || inLanguage(r))
  );
  if (!pool.length) return [];

  const target = opts.arc?.energy ?? cur?.intensity ?? 0.6;
  const arcBpm = opts.arc?.bpm;
  const base = (r: CatalogRow) => {
    const mix = cur ? mixability(cur, r) : 0.5;
    const pop = Math.log1p(r.popularity) / Math.log1p(cat.maxPopularity);
    const inWindow = arcBpm && r.bpm >= arcBpm[0] && r.bpm <= arcBpm[1] ? 0.15 : 0;
    // chart hits flow into chart hits, crate-digging into crate-digging: a set
    // of songs everyone knows shouldn't detour into an unknown instrumental
    const sameCrate = cur && r.source === cur.source ? 0.2 : 0;
    // with no language chosen, a Hindi set still stays mostly Hindi
    const sameLanguage = cur?.language && r.language === cur.language ? 0.2 : 0;
    // jitter so two sets from the same seed don't play the same order
    return (
      (0.7 * mix + 0.3 * pop + inWindow + sameCrate + sameLanguage) *
      (0.85 + Math.random() * 0.3)
    );
  };
  const ranked = pool
    .map((row) => ({ row, s: base(row), gap: row.intensity - target }))
    .sort((a, b) => b.s - a.s);

  const picks: Pick[] = [];
  const used = new Set<string>();
  const artists = new Map<string, number>();
  const take = (
    tag: Pick["tag"],
    n: number,
    ok: (c: (typeof ranked)[number]) => boolean
  ) => {
    for (const c of ranked) {
      if (n <= 0) break;
      if (used.has(c.row.id) || !ok(c)) continue;
      // don't let one prolific artist fill the grid
      if ((artists.get(c.row.artist) ?? 0) >= 2) continue;
      artists.set(c.row.artist, (artists.get(c.row.artist) ?? 0) + 1);
      used.add(c.row.id);
      picks.push({ row: c.row, tag });
      n--;
    }
  };
  // with an arc, "shift" still orbits the arc target rather than drifting off
  take("safe", 5, (c) => Math.abs(c.gap) <= 0.12);
  take("shift", 3, (c) => Math.abs(c.gap) > 0.12 && Math.abs(c.gap) <= (opts.arc ? 0.25 : 0.4));
  take("wild", 1, (c) => !!cur && !sharesGenre(cur, c.row));
  // thin library / narrow target: top up with the best remaining
  take("safe", (opts.count ?? 9) - picks.length, () => true);
  return picks.slice(0, opts.count ?? 9);
}

export interface IntentFilter {
  genres?: string[];
  keywords?: string[];
  intensity?: [number, number];
  bpm?: [number, number];
  instrumental?: boolean | null;
  energyArc?: "flat" | "build" | "peak_and_release" | "wind_down";
}

/** Build a queue for a vibe: filter the catalog, then order it along the arc. */
export async function pickForIntent(
  f: IntentFilter,
  count = 10,
  languages?: string[]
): Promise<CatalogRow[]> {
  const cat = await loadCatalog();
  const inLanguage = languageFilter(cat, languages);
  const genres = (f.genres ?? []).map((g) => g.toLowerCase());
  const keywords = (f.keywords ?? []).map((k) => k.toLowerCase());
  const [lo, hi] = f.intensity ?? [0, 1];
  const scored: { row: CatalogRow; s: number }[] = [];
  cat.tracks.forEach((row, i) => {
    if (row.kind !== "song") return;
    if (inLanguage && !inLanguage(row)) return;
    if (f.instrumental === true && !row.instrumental) return;
    let s = 0;
    if (genres.length) {
      const hit = row.genres.some((g) => genres.includes(g.toLowerCase()));
      if (hit) s += 2;
    }
    for (const k of keywords) if (cat.haystack[i].includes(k)) s += 1;
    if ((genres.length || keywords.length) && s === 0) return;
    const mid = Math.min(Math.max(row.intensity, lo), hi);
    s -= Math.abs(row.intensity - mid) * 6; // soft intensity window
    if (f.bpm) s -= (row.bpm < f.bpm[0] || row.bpm > f.bpm[1] ? 0.5 : 0);
    s += Math.log1p(row.popularity) / Math.log1p(cat.maxPopularity);
    scored.push({ row, s: s * (0.9 + Math.random() * 0.2) });
  });
  scored.sort((a, b) => b.s - a.s);

  const chosen: CatalogRow[] = [];
  const perArtist = new Map<string, number>();
  for (const { row } of scored) {
    if (chosen.length >= count) break;
    if ((perArtist.get(row.artist) ?? 0) >= 2) continue;
    perArtist.set(row.artist, (perArtist.get(row.artist) ?? 0) + 1);
    chosen.push(row);
  }

  const asc = [...chosen].sort((a, b) => a.intensity - b.intensity);
  switch (f.energyArc) {
    case "build":
      return asc;
    case "wind_down":
      return asc.reverse();
    case "peak_and_release": {
      // climb on the even ranks, come back down on the odd ones
      const up = asc.filter((_, i) => i % 2 === 0);
      const down = asc.filter((_, i) => i % 2 === 1).reverse();
      return [...up, ...down];
    }
    default:
      return chainByMixability(chosen);
  }
}

/** Greedy nearest-neighbour ordering so each track mixes into the next. */
function chainByMixability(rows: CatalogRow[]): CatalogRow[] {
  if (rows.length < 3) return rows;
  const left = [...rows];
  const out = [left.shift()!];
  while (left.length) {
    const last = out[out.length - 1];
    let best = 0;
    for (let i = 1; i < left.length; i++)
      if (mixability(last, left[i]) > mixability(last, left[best])) best = i;
    out.push(left.splice(best, 1)[0]);
  }
  return out;
}

/**
 * The songs a room of people would recognise (chart hits), most-played first.
 * Lyric games must pick from these rather than naming songs from memory - a
 * pick that is not in the library cannot be played.
 */
export async function knownSongs(limit = 500, languages?: string[]): Promise<CatalogRow[]> {
  const cat = await loadCatalog();
  const inLanguage = languageFilter(cat, languages);
  const songs = cat.tracks.filter((r) => r.kind === "song" && (!inLanguage || inLanguage(r)));
  const hits = songs.filter((r) => r.source === "youtube");
  return (hits.length >= 20 ? hits : songs)
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, limit);
}

export interface LibraryStats {
  songs: number;
  loops: number;
  sfx: number;
  hours: number;
  genres: { name: string; count: number }[];
  tags: { name: string; count: number }[];
  licenses: { name: string; count: number }[];
  /** Every language the library has songs in, whatever the filter. */
  languages: { code: string; count: number }[];
}

function tally(values: string[], top: number): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([name, count]) => ({ name, count }));
}

/** Counts and facets; `languages` narrows the song facets to those languages. */
export async function libraryStats(languages?: string[]): Promise<LibraryStats> {
  const cat = await loadCatalog();
  const inLanguage = languageFilter(cat, languages);
  const songs = cat.tracks.filter((r) => r.kind === "song" && (!inLanguage || inLanguage(r)));
  return {
    songs: songs.length,
    loops: cat.tracks.filter((r) => r.kind === "loop").length,
    sfx: cat.tracks.filter((r) => r.kind === "sfx").length,
    hours: +(songs.reduce((s, r) => s + r.duration, 0) / 3600).toFixed(1),
    genres: tally(songs.flatMap((r) => r.genres), 40),
    tags: tally(songs.flatMap((r) => r.tags), 60),
    licenses: tally(songs.map((r) => r.license ?? "Unknown"), 30),
    languages: [...cat.languages.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => ({ code, count })),
  };
}
