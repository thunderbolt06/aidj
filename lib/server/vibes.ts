import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import VIBES from "@/lib/vibes.json";
import { signUrl } from "@/lib/server/cloudfrontSign";

/**
 * The vibe index (library/vibes.json, built monthly by
 * scripts/library/harvest_vibes.py): for every vibe chip, the public YouTube
 * playlists people made for it, and which library songs sit in which
 * playlist. Two things fall out of that:
 *
 *  - vibe affinity: a song in 7 of the 10 "road trip" playlists is a road-trip
 *    song, whatever genre tag it lacks. Higher up a playlist counts more; a
 *    song that is in every vibe's playlists counts a little less for each.
 *  - song-to-song similarity: songs that keep appearing in the same playlists
 *    go together ("people who put A in a playlist also put B").
 *
 * Read the same way as the catalog: off disk locally, over signed HTTP when
 * LIBRARY_URL is set. A missing index is not an error - the pickers fall back
 * to the catalog's tempo / key / energy matching.
 */
const LIBRARY_DIR = process.env.LIBRARY_DIR || path.join(process.cwd(), "library");
const LIBRARY_URL = (process.env.LIBRARY_URL || "").replace(/\/+$/, "");
const REMOTE_TTL_MS = 30 * 60_000;

export interface VibePlaylist {
  id: string;
  title: string;
  channel?: string;
  size: number;
  /** last edit, YYYYMMDD */
  modified?: string;
}

interface RawIndex {
  month: string;
  vibes: { label: string; lang: string; playlists: number[] }[];
  playlists: VibePlaylist[];
  /** song id -> flat [playlist index, position, playlist index, position, ...] */
  songs: Record<string, number[]>;
}

export interface VibeIndex {
  month: string;
  /** Vibe labels that have playlist data. */
  labels: string[];
  /** The harvested playlists, and which of them each vibe drew on (all languages). */
  playlists: VibePlaylist[];
  vibePlaylists: Map<string, number[]>;
  /** vibe label -> song id -> affinity (0..1) */
  affinity: Map<string, Map<string, number>>;
  /** song id -> playlists it is in */
  memberships: Map<string, number[]>;
  /** playlist -> songs in it */
  members: string[][];
  /** how much one shared playlist says (small curated lists say more) */
  playlistWeight: number[];
  /** song id -> sum of its playlists' squared weights (cosine norm) */
  degree: Map<string, number>;
}

let cached: { index: VibeIndex | null; stamp: number } | null = null;

/** The top of a curated playlist is its core; the tail still counts, half as much. */
function positionWeight(pos: number): number {
  return 1 - 0.5 * Math.min(1, pos / 150);
}

function build(raw: RawIndex): VibeIndex {
  const members: string[][] = raw.playlists.map(() => []);
  const memberships = new Map<string, number[]>();
  const position = new Map<string, number>(); // `${song}:${playlist}` -> position
  for (const [id, flat] of Object.entries(raw.songs)) {
    const ps: number[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      ps.push(flat[i]);
      members[flat[i]]?.push(id);
      position.set(`${id}:${flat[i]}`, flat[i + 1]);
    }
    memberships.set(id, ps);
  }
  const playlistWeight = raw.playlists.map((p) => 1 / Math.log2(1 + Math.max(10, p.size) / 10));
  const degree = new Map<string, number>();
  for (const [id, ps] of memberships)
    degree.set(id, ps.reduce((s, p) => s + playlistWeight[p] ** 2, 0));

  // support: the share of a vibe's playlists (in that language) a song is in
  const support = new Map<string, Map<string, number>>();
  for (const v of raw.vibes) {
    if (!v.playlists.length) continue;
    const m = support.get(v.label) ?? new Map<string, number>();
    for (const p of v.playlists)
      for (const id of members[p] ?? [])
        m.set(id, (m.get(id) ?? 0) + positionWeight(position.get(`${id}:${p}`) ?? 0) / v.playlists.length);
    support.set(v.label, m);
  }
  // specificity: a song every vibe claims says less about any one of them
  const vibeCount = new Map<string, number>();
  for (const m of support.values())
    for (const id of m.keys()) vibeCount.set(id, (vibeCount.get(id) ?? 0) + 1);
  const V = Math.max(2, support.size);
  const affinity = new Map<string, Map<string, number>>();
  for (const [label, m] of support) {
    const out = new Map<string, number>();
    for (const [id, s] of m) {
      const spec = Math.sqrt(Math.log(1 + V / (vibeCount.get(id) ?? 1)) / Math.log(1 + V));
      out.set(id, Math.min(1, s) * spec);
    }
    affinity.set(label, out);
  }
  const vibePlaylists = new Map<string, number[]>();
  for (const v of raw.vibes)
    vibePlaylists.set(v.label, [...(vibePlaylists.get(v.label) ?? []), ...v.playlists]);
  return {
    month: raw.month,
    labels: [...affinity.keys()],
    playlists: raw.playlists,
    vibePlaylists,
    affinity,
    memberships,
    members,
    playlistWeight,
    degree,
  };
}

export async function loadVibeIndex(): Promise<VibeIndex | null> {
  try {
    if (LIBRARY_URL) {
      if (cached && Date.now() - cached.stamp < REMOTE_TTL_MS) return cached.index;
      const res = await fetch(signUrl(`${LIBRARY_URL}/vibes.json`));
      // not uploaded yet: remember that too, so every pick doesn't refetch
      const index = res.ok ? build(await res.json()) : null;
      cached = { index, stamp: Date.now() };
      return index;
    }
    const file = path.join(LIBRARY_DIR, "vibes.json");
    const mtime = (await stat(file)).mtimeMs;
    if (cached?.stamp === mtime) return cached.index;
    cached = { index: build(JSON.parse(await readFile(file, "utf8"))), stamp: mtime };
    return cached.index;
  } catch {
    return null;
  }
}

export interface VibeWeight {
  label: string;
  weight: number;
}

/** Every chip label, whether or not this month's harvest found playlists for it. */
export const ALL_VIBES: string[] = [
  ...new Set([...VIBES.general, ...VIBES.hindi, ...VIBES.punjabi]),
];

/** Vibes that bring songs in their own language, and the words that ask for it. */
const LANGUAGE_VIBES: [Set<string>, RegExp][] = [
  [new Set(VIBES.hindi), /\b(hindi|bollywood|desi|ghazal|sufi|filmi)\b/i],
  [new Set(VIBES.punjabi), /\b(punjabi|bhangra|desi)\b/i],
];

const STOP = new Set(["the", "and", "for", "music", "songs", "song", "some", "with", "while", "time", "mood", "vibes", "vibe", "playlist", "hours", "only", "a", "of", "to", "in", "my", "me", "we"]);

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => w.replace(/(ing|s)$/, ""));
}

/**
 * Turn a request into weighted vibes. A chip resolves to itself; the AI's
 * picks (labels it chose from the list) come next; otherwise the labels that
 * share the most words with what was typed. Labels without playlist data are
 * dropped - they would contribute nothing.
 */
export function resolveVibes(
  index: VibeIndex,
  prompt: string,
  aiPicks: unknown = []
): VibeWeight[] {
  const have = new Set(index.labels);
  const p = prompt.trim().toLowerCase();
  if (have.has(p)) return [{ label: p, weight: 1 }];
  const picks = (Array.isArray(aiPicks) ? aiPicks : [])
    .map((x) => String(x).trim().toLowerCase())
    .filter((x, i, a) => have.has(x) && a.indexOf(x) === i)
    .slice(0, 3);
  if (picks.length) return picks.map((label, i) => ({ label, weight: [1, 0.6, 0.4][i] }));
  const want = new Set(words(p));
  if (!want.size) return [];
  // a shared word ("friends") must not turn an English request into a Hindi set
  const allowed = (label: string) =>
    LANGUAGE_VIBES.every(([labels, asks]) => !labels.has(label) || asks.test(p));
  return index.labels
    .filter(allowed)
    .map((label) => {
      const ws = words(label);
      const hits = ws.filter((w) => want.has(w)).length;
      return { label, weight: hits / Math.sqrt(ws.length || 1) };
    })
    .filter((v) => v.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((v, i, a) => ({ label: v.label, weight: v.weight / a[0].weight }));
}

/** song id -> how strongly the weighted vibes claim it (0..1). */
export function vibeScores(index: VibeIndex, vibes: VibeWeight[]): Map<string, number> {
  const out = new Map<string, number>();
  const total = vibes.reduce((s, v) => s + v.weight, 0) || 1;
  for (const v of vibes) {
    const aff = index.affinity.get(v.label);
    if (!aff) continue;
    for (const [id, a] of aff) out.set(id, (out.get(id) ?? 0) + (a * v.weight) / total);
  }
  return out;
}

/**
 * song id -> how often it shares a playlist with `id`, as a cosine over
 * weighted playlist membership (0..1). Empty when `id` is in no playlist.
 */
export function relatedSongs(index: VibeIndex, id: string): Map<string, number> {
  const out = new Map<string, number>();
  const mine = index.memberships.get(id);
  if (!mine) return out;
  for (const p of mine) {
    const w = index.playlistWeight[p];
    for (const other of index.members[p]) if (other !== id) out.set(other, (out.get(other) ?? 0) + w * w);
  }
  const da = index.degree.get(id) ?? 1;
  for (const [other, dot] of out) out.set(other, dot / Math.sqrt(da * (index.degree.get(other) ?? 1)));
  return out;
}

/** The vibes a song belongs to most, strongest first. */
export function vibesOfSong(index: VibeIndex, id: string, n = 3): VibeWeight[] {
  const out: VibeWeight[] = [];
  for (const [label, aff] of index.affinity) {
    const a = aff.get(id);
    if (a) out.push({ label, weight: a });
  }
  return out.sort((a, b) => b.weight - a.weight).slice(0, n);
}
