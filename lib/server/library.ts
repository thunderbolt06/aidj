import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { camelotDistance } from "@/lib/audio/analysis";
import { toIsoCodes } from "@/lib/languages";
import { signUrl } from "@/lib/server/cloudfrontSign";
import {
  loadVibeIndex,
  relatedSongs,
  vibeScores,
  type VibeIndex,
  type VibeWeight,
} from "@/lib/server/vibes";
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
  /** Feel of the song ("romantic", "hype", "melancholic"), from label_songs.mjs. */
  moods?: string[];
  /** ISO 639-1 code, null when unknown (untagged or instrumental). */
  language?: string | null;
  /** Release year (exact, or the middle of a decade tag), null when unknown. */
  year?: number | null;
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
  /** Lowercased "title artist genres moods tags" per row, parallel to `tracks`. */
  haystack: string[];
  maxPopularity: number;
  /**
   * Song id -> energy as a percentile among songs (0..1). The analyzer's raw
   * intensity bunches up (most chart songs land between 0.56 and 0.81), so
   * "a bit calmer" or "peak energy" only mean something as ranks.
   */
  energy: Map<string, number>;
  /** Songs per language code. */
  languages: Map<string, number>;
}

let cached: { catalog: Catalog; stamp: number } | null = null;
const REMOTE_TTL_MS = 5 * 60_000;

function indexCatalog(rows: CatalogRow[]): Catalog {
  const languages = new Map<string, number>();
  for (const r of rows)
    if (r.kind === "song" && r.language)
      languages.set(r.language, (languages.get(r.language) ?? 0) + 1);
  const songs = rows.filter((r) => r.kind === "song").sort((a, b) => a.intensity - b.intensity);
  const energy = new Map(songs.map((r, i) => [r.id, songs.length > 1 ? i / (songs.length - 1) : 0.5]));
  return {
    tracks: rows,
    languages,
    byId: new Map(rows.map((r) => [r.id, r])),
    haystack: rows.map((r) =>
      [r.title, r.artist, ...r.genres, ...(r.moods ?? []), ...r.tags].join(" ").toLowerCase()
    ),
    maxPopularity: rows.reduce((m, r) => Math.max(m, r.popularity), 1),
    energy,
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
      "library is empty - run `npm run library:youtube` then `npm run library:ingest`"
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

/**
 * 0..1: how cleanly `b` mixes out of `a` by tempo and key. Only a
 * tie-breaker - the transition planner bridges any tempo gap (echo out,
 * filter sweep); a near tempo just earns the beat-matched blend (within 8%).
 */
function mixability(a: CatalogRow, b: CatalogRow): number {
  const tempo = Math.exp(-Math.pow(tempoGap(a.bpm, b.bpm) / 0.1, 2));
  const dist = camelotDistance(a.camelot, b.camelot);
  const key = dist === 0 ? 1 : dist === 1 ? 0.85 : dist === 2 ? 0.45 : 0.15;
  return 0.55 * tempo + 0.45 * key;
}

function styleSet(r: CatalogRow): Set<string> {
  return new Set([...r.genres, ...(r.moods ?? [])].map((x) => x.toLowerCase()));
}

/** 0..1: shared genres and moods (cosine over the two label sets), 0 when either has none. */
function styleMatch(a: CatalogRow, b: CatalogRow): number {
  const sa = styleSet(a);
  const sb = styleSet(b);
  if (!sa.size || !sb.size) return 0;
  let both = 0;
  for (const x of sa) if (sb.has(x)) both++;
  return both / Math.sqrt(sa.size * sb.size);
}

/** 0..1: released close together (a 2019 song after a 2020 one, not a 1975 one). */
function eraMatch(a: CatalogRow, b: CatalogRow): number {
  if (!a.year || !b.year) return 0.4;
  return Math.exp(-Math.abs(a.year - b.year) / 8);
}

/**
 * A song radio follows an era: 1 for the same year, easing to a floor of 0.2
 * a few decades away - a 2019 listener gets 2014-2024 songs, only now and then
 * a 1985 one (the weights are cubed, so the floor is a rare visit). Years of
 * obscure songs are good to a few years, hence the wide curve.
 */
function eraFollow(year: number | null | undefined, r: CatalogRow): number {
  if (!year || !r.year) return 1;
  return 0.2 + 0.8 * Math.exp(-Math.abs(year - r.year) / 12);
}

/**
 * The era the listener is in: the median year of their last few plays. One
 * old song that slipped into a modern set must not take the radio back to its
 * decade with it - the playing song counts, but so does where the set has been.
 */
function recentEra(cat: Catalog, recent: unknown): number | null {
  if (!Array.isArray(recent)) return null;
  const years: number[] = [];
  for (const id of recent.slice(0, 8)) {
    const y = typeof id === "string" ? cat.byId.get(id)?.year : null;
    if (y) years.push(y);
  }
  if (years.length < 4) return null;
  years.sort((a, b) => a - b);
  return years[years.length >> 1];
}

/** A song's energy percentile (0..1); 0.5 for anything not ranked. */
function energyOf(cat: Catalog, r: CatalogRow): number {
  return cat.energy.get(r.id) ?? 0.5;
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
 * A random order in which heavier items tend to come first (Efraimidis-
 * Spirakis: sort by u^(1/w)). Sorting by score plus a little jitter served
 * the same top songs every time; this keeps the best ones likely, never certain.
 */
function weightedOrder<T>(items: T[], weight: (t: T) => number): T[] {
  return items
    .map((t) => ({ t, k: Math.log(Math.random()) / Math.max(1e-9, weight(t)) }))
    .sort((a, b) => b.k - a.k)
    .map((x) => x.t);
}

/**
 * The listener's history (ids, newest first): the last ~40 plays are as good
 * as excluded, older ones only fade - a small vibe must still be able to play.
 */
function notRecent(recent: unknown): (id: string) => number {
  const at = new Map<string, number>();
  if (Array.isArray(recent))
    recent.slice(0, 300).forEach((id, i) => {
      if (typeof id === "string" && !at.has(id)) at.set(id, i);
    });
  return (id) => {
    const i = at.get(id);
    return i === undefined ? 1 : i < 40 ? 0.03 : 0.3;
  };
}

/**
 * 0..1 by release year: full marks from 2010, none by 1970. The chart crate
 * holds as many 60s songs as 2020s ones and the Hindi / Punjabi collections
 * reach back to the 40s, so with nothing else to go on a pick leans recent.
 */
function recency(r: CatalogRow): number {
  return r.year ? Math.min(1, Math.max(0, (r.year - 1970) / 40)) : 0.5;
}

/**
 * How much a song's age counts against it in a set with no era of its own:
 * 2010+ is untouched, a 2000 song carries 0.7, 1990 0.4, 1980 0.2. It is the
 * weight itself (or its cube, in the grid), so older songs are not banned,
 * they just turn up the way a classic does in a modern set - rarely.
 */
function freshness(r: CatalogRow): number {
  return 0.1 + 0.9 * recency(r) ** 1.5;
}

export const ERA_WORDS = /\b(retro|classics?|evergreen|oldies|old school|nostalgia|\d0s|\d{4}s)\b/i;

/**
 * Playlists mix eras ("100 greatest driving songs" is mostly the 70s) and
 * sets that keep reaching back decades feel dated: a lean toward recent
 * songs - unless the vibe is about an era ("90s nostalgia", "retro classics").
 */
function recencyLean(vibes: VibeWeight[], era: unknown): (r: CatalogRow) => number {
  if (era || vibes.some((v) => ERA_WORDS.test(v.label))) return () => 1;
  return freshness;
}

/** Vibe labels (or weighted vibes) a caller sent, kept to the ones with data. */
function vibeWeights(index: VibeIndex | null, vibes: unknown): VibeWeight[] {
  if (!index || !Array.isArray(vibes)) return [];
  const have = new Set(index.labels);
  const out: VibeWeight[] = [];
  for (const v of vibes.slice(0, 3)) {
    const label = String(typeof v === "string" ? v : v?.label ?? "").toLowerCase();
    const weight = typeof v === "string" ? [1, 0.6, 0.4][out.length] : Number(v?.weight) || 0;
    if (have.has(label) && weight > 0) out.push({ label, weight });
  }
  return out;
}

function maxOf(m: Map<string, number>): number {
  let max = 0;
  for (const v of m.values()) if (v > max) max = v;
  return max || 1;
}

/**
 * The 9-pick spread every "what next?" surface uses - 5 safe, 3 energy
 * shifts, 1 wildcard - chosen without an LLM round-trip, so refills are
 * instant. What fits comes first from the vibe playlists: songs the set's
 * vibe claims, and songs that share playlists with the one playing. Tempo /
 * key / energy then decide what mixes in cleanly. Without playlist data it is
 * tempo / key / energy alone, as before.
 */
export async function pickNext(opts: {
  current?: string;
  arc?: ArcTarget | null;
  exclude?: string[];
  count?: number;
  languages?: string[];
  /** The set's vibe, as the intent plan named it: keeps refills inside it. */
  vibes?: unknown;
  /** Recently played track ids, newest first. */
  recent?: unknown;
}): Promise<Pick[]> {
  const [cat, index] = await Promise.all([loadCatalog(), loadVibeIndex()]);
  const cur = resolveCurrent(cat, opts.current);
  const exclude = new Set(opts.exclude ?? []);
  if (cur) exclude.add(cur.id);
  const inLanguage = languageFilter(cat, opts.languages);
  let pool = cat.tracks.filter(
    (r) => r.kind === "song" && !exclude.has(r.id) && (!inLanguage || inLanguage(r))
  );
  if (!pool.length) return [];
  // no language chosen: the song playing sets it. A Hindi set must not wander
  // into the English crate (spread evenly over 60 years, so mostly old songs)
  if (!inLanguage && cur?.language) {
    const same = pool.filter((r) => r.language === cur.language);
    if (same.length >= 40) pool = same;
  }

  const vibes = vibeWeights(index, opts.vibes);
  const inVibe = index && vibes.length ? vibeScores(index, vibes) : new Map<string, number>();
  const near = index && cur ? relatedSongs(index, cur.id) : new Map<string, number>();
  const maxVibe = maxOf(inVibe);
  const maxNear = maxOf(near);
  // stay inside the vibe (and the playing song's playlist neighbours) while
  // there is enough of it to fill the grid; a thin one opens up to everything
  const inside = pool.filter((r) => inVibe.has(r.id) || near.has(r.id));
  if (inside.length >= 30) pool = inside;
  const fresh = notRecent(opts.recent);
  const lean = recencyLean(vibes, null);
  const eraNow = recentEra(cat, opts.recent);
  // follows the playing song's era and, once there is a history, the set's
  const follow = (r: CatalogRow) =>
    !cur ? 1 : eraNow ? 0.5 * eraFollow(cur.year, r) + 0.5 * eraFollow(eraNow, r) : eraFollow(cur.year, r);

  const target = opts.arc?.energy ?? (cur ? energyOf(cat, cur) : 0.6);
  const arcBpm = opts.arc?.bpm;
  // what belongs together first - the vibe's playlists, the playing song's
  // playlist neighbours, shared genres / moods, the same era - and tempo /
  // key only as a tie-breaker
  const base = (r: CatalogRow) => {
    const playlists =
      (1.2 * (inVibe.get(r.id) ?? 0)) / maxVibe + (0.9 * (near.get(r.id) ?? 0)) / maxNear;
    const style = cur ? 0.6 * styleMatch(cur, r) : 0;
    const era = cur ? 0.3 * eraMatch(cur, r) : 0.3 * recency(r);
    const mix = cur ? 0.25 * mixability(cur, r) : 0.1;
    const pop = 0.15 * (Math.log1p(r.popularity) / Math.log1p(cat.maxPopularity));
    const inWindow = arcBpm && r.bpm >= arcBpm[0] && r.bpm <= arcBpm[1] ? 0.15 : 0;
    // with no language chosen, a Hindi set still stays mostly Hindi
    const sameLanguage = cur?.language && r.language === cur.language ? 0.35 : 0;
    // a vibe set leans recent; a song radio follows the playing song's era (a
    // set that has both stays near the playing song, and recent)
    return (
      (playlists + style + era + mix + pop + inWindow + sameLanguage) *
      fresh(r.id) *
      follow(r) *
      (vibes.length ? lean(r) : 1)
    );
  };
  // cubed: the best fits come up most often, but not every time
  const ranked = weightedOrder(
    pool.map((row) => ({ row, s: base(row), gap: energyOf(cat, row) - target })),
    (c) => c.s ** 3
  );

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
  // the wildcard: still a good pick, in a different style from the playing song
  take("wild", 1, (c) => !!cur && styleMatch(cur, c.row) < 0.2);
  // thin library / narrow target: top up with the best remaining
  take("safe", (opts.count ?? 9) - picks.length, () => true);
  return picks.slice(0, opts.count ?? 9);
}

export interface IntentFilter {
  genres?: string[];
  /** Moods from the library's list ("romantic", "hype"). */
  moods?: string[];
  keywords?: string[];
  intensity?: [number, number];
  bpm?: [number, number];
  instrumental?: boolean | null;
  energyArc?: "flat" | "build" | "peak_and_release" | "wind_down";
  /** Release years the vibe asks for ("90s nostalgia"), null = any. */
  era?: [number, number] | null;
}

export interface IntentPickOptions {
  /** Vibes from the playlist index (resolveVibes); empty = filter only. */
  vibes?: VibeWeight[];
  /** Recently played track ids, newest first. */
  recent?: unknown;
  exclude?: string[];
}

/**
 * Build a queue for a vibe, then order it along the arc. With playlist data
 * the songs come from the vibe's playlists, drawn at random weighted by how
 * strongly the vibe claims them - so every request is a fresh set of
 * on-vibe songs. Otherwise (no index yet, or too few songs in the chosen
 * languages) the catalog filter: genre / mood / tags / energy.
 */
export async function pickForIntent(
  f: IntentFilter,
  count = 10,
  languages?: string[],
  { vibes = [], recent, exclude = [] }: IntentPickOptions = {}
): Promise<CatalogRow[]> {
  const [cat, index] = await Promise.all([loadCatalog(), loadVibeIndex()]);
  const inLanguage = languageFilter(cat, languages);
  const fresh = notRecent(recent);
  const skip = new Set(exclude);
  const songs = cat.tracks.filter(
    (r) => r.kind === "song" && !skip.has(r.id) && (!inLanguage || inLanguage(r))
  );
  const [lo, hi] = f.intensity ?? [0, 1];
  const era = Array.isArray(f.era) && f.era.length === 2 ? f.era : null;
  const eraFit = (r: CatalogRow) =>
    !era || !r.year ? 1 : r.year >= era[0] && r.year <= era[1] ? 1 : 0.15;

  let scored: { row: CatalogRow; s: number }[] = [];
  if (index && vibes.length) {
    const claim = vibeScores(index, vibes);
    const lean = recencyLean(vibes, era);
    for (const row of songs) {
      const v = claim.get(row.id);
      if (!v) continue;
      // the playlists already say what energy the vibe has; this only nudges
      const e = energyOf(cat, row);
      const gap = Math.abs(e - Math.min(Math.max(e, lo), hi));
      const energy = 1 - 0.5 * Math.min(1, gap / 0.3);
      // squared: core songs come up often, one-playlist songs now and then; the
      // age lean is squared too, so a classic is a rare visit, not a fixture
      scored.push({ row, s: v * v * energy * eraFit(row) * lean(row) ** 2 * fresh(row.id) });
    }
  }
  if (scored.length < Math.max(8, count)) scored = filterScores(cat, songs, f, eraFit, fresh, !era);

  const big = scored.length >= count * 5;
  const chosen: CatalogRow[] = [];
  const perArtist = new Map<string, number>();
  for (const { row } of weightedOrder(scored, (c) => c.s)) {
    if (chosen.length >= count) break;
    // a big pool can afford one song per artist per set
    if ((perArtist.get(row.artist) ?? 0) >= (big ? 1 : 2)) continue;
    perArtist.set(row.artist, (perArtist.get(row.artist) ?? 0) + 1);
    chosen.push(row);
  }

  const asc = [...chosen].sort((a, b) => energyOf(cat, a) - energyOf(cat, b));
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

/** The catalog filter: genre / mood / tag hits within a soft energy window. */
function filterScores(
  cat: Catalog,
  songs: CatalogRow[],
  f: IntentFilter,
  eraFit: (r: CatalogRow) => number,
  fresh: (id: string) => number,
  leanRecent: boolean
): { row: CatalogRow; s: number }[] {
  const genres = (f.genres ?? []).map((g) => g.toLowerCase());
  const moods = (f.moods ?? []).map((m) => m.toLowerCase());
  const keywords = (f.keywords ?? []).map((k) => k.toLowerCase());
  const [lo, hi] = f.intensity ?? [0, 1];
  const rowIndex = new Map(cat.tracks.map((r, i) => [r.id, i]));
  const out: { row: CatalogRow; s: number }[] = [];
  for (const row of songs) {
    if (f.instrumental === true && !row.instrumental) continue;
    const hay = cat.haystack[rowIndex.get(row.id)!];
    let s = 0;
    if (genres.length && row.genres.some((g) => genres.includes(g.toLowerCase()))) s += 2;
    for (const m of row.moods ?? []) if (moods.includes(m.toLowerCase())) s += 1.5;
    for (const k of keywords) if (hay.includes(k)) s += 1;
    if ((genres.length || moods.length || keywords.length) && s === 0) continue;
    const e = energyOf(cat, row);
    s -= Math.abs(e - Math.min(Math.max(e, lo), hi)) * 6; // soft energy window
    if (f.bpm) s -= row.bpm < f.bpm[0] || row.bpm > f.bpm[1] ? 0.5 : 0;
    s += Math.log1p(row.popularity) / Math.log1p(cat.maxPopularity);
    const lean = leanRecent ? freshness(row) ** 2 : 1;
    out.push({ row, s: Math.exp(1.5 * s) * lean * eraFit(row) * fresh(row.id) });
  }
  return out;
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
  moods: { name: string; count: number }[];
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
    moods: tally(songs.flatMap((r) => r.moods ?? []), 40),
    tags: tally(songs.flatMap((r) => r.tags), 60),
    licenses: tally(songs.map((r) => r.license ?? "Unknown"), 30),
    languages: [...cat.languages.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => ({ code, count })),
  };
}
