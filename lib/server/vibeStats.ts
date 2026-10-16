import VIBES from "@/lib/vibes.json";
import { ageless, freshness, loadCatalog, type CatalogRow } from "@/lib/server/library";
import { ALL_VIBES, loadVibeIndex, type VibeIndex } from "@/lib/server/vibes";
import { readEvents, type ListenEvent, type PlayEnd, type PlayEvent } from "@/lib/server/events";

/**
 * The numbers behind the stats page (app/stats): for every vibe, what the
 * library has for it (songs, playlists, how old they are) next to how its
 * sets actually go (listeners, plays, skips) - and the issues that follow.
 *
 * Listening is credited to a set's main vibe (the first of its 1-3). Skip
 * rate = NEXT taps / songs that ended by the listener's or the DJ's choice;
 * songs cut off by a stop, a closed tab or a new vibe count for neither.
 */

const DAY = 86_400_000;
const EARLY_SKIP_SEC = 20;
const DECIDED: PlayEnd[] = ["auto", "skip", "drop", "pick"];
const BAIL_ENDS: PlayEnd[] = ["stop", "left", "revibe"];
const NO_VIBE = "(no vibe)";

export type Level = "critical" | "warning";
export interface Issue {
  level: Level;
  text: string;
}

interface Listening {
  listeners: number;
  sets: number;
  plays: number;
  minutes: number;
  skips: number;
  earlySkips: number;
  picks: number;
  skipRate: number | null;
  /** sets that ended (stop / tab closed / new vibe) within their first 2 songs */
  bailRate: number | null;
  songsPerSet: number | null;
  lastPlayed: number | null;
}

export interface VibeRow {
  label: string;
  group: "general" | "hindi" | "punjabi";
  /** also harvested in Hindi and Punjabi */
  anyLanguage: boolean;
  /** an era ("90s nostalgia") or a timeless genre ("jazz"): old songs are the point, so age is never flagged */
  era: boolean;
  library: {
    songs: number;
    playlists: number;
    /** share of the playlists' entries the library has */
    coverage: number | null;
    medianYear: number | null;
    p25Year: number | null;
    p75Year: number | null;
    /** share of dated songs from the last 5 years */
    recentShare: number | null;
    /**
     * share of what listeners are served that predates 2000: songs weighted
     * like the picker does (affinity and age lean, both squared). The pool's
     * median year says what the playlists hold; the picker leans young, so
     * this says what a set actually sounds like.
     */
    oldShare: number | null;
    languages: Record<string, number>;
  };
  listening: Listening;
  issues: Issue[];
  status: Level | "good";
}

export interface ListenerRow {
  id: string;
  firstSeen: number;
  lastSeen: number;
  days: number;
  sets: number;
  plays: number;
  minutes: number;
  skipRate: number | null;
  topVibe: string | null;
}

export interface Overview {
  generatedAt: number;
  /** month of the playlist harvest */
  harvest: string | null;
  days: number | null;
  totals: {
    listeners: number;
    active7: number;
    new7: number;
    returning: number;
    sets: number;
    plays: number;
    hours: number;
    skipRate: number | null;
    earlySkipRate: number | null;
    songsPerSet: number | null;
    librarySongs: number;
    vibesWithData: number;
  };
  daily: { day: string; plays: number; skips: number; listeners: number }[];
  ends: Record<PlayEnd, number>;
  pages: { page: string; sets: number; plays: number }[];
  requests: {
    total: number;
    chips: number;
    typed: number;
    /** typed requests no playlist vibe covered - vibes people want and don't have */
    unmatched: { prompt: string; count: number; last: number }[];
  };
  listeners: ListenerRow[];
  vibes: VibeRow[];
  noVibe: Listening;
}

export interface SongStat {
  id: string;
  title: string;
  artist: string;
  year: number | null;
  affinity?: number;
  plays: number;
  skips: number;
}

export interface VibeDetail {
  row: VibeRow;
  playlists: { id: string; title: string; channel: string | null; size: number; inLibrary: number; modified: string | null }[];
  /** songs per 5-year bucket */
  years: { from: number; songs: number }[];
  topSongs: SongStat[];
  mostSkipped: SongStat[];
  daily: { day: string; plays: number; skips: number }[];
}

const median = (xs: number[], q = 0.5) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
};
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function groupOf(label: string): VibeRow["group"] {
  if (VIBES.hindi.includes(label)) return "hindi";
  if (VIBES.punjabi.includes(label)) return "punjabi";
  return "general";
}

function libraryFacts(label: string, index: VibeIndex | null, byId: Map<string, CatalogRow>) {
  const ps = [...new Set(index?.vibePlaylists.get(label) ?? [])];
  const ids = [...(index?.affinity.get(label)?.keys() ?? [])];
  const rows = ids.map((id) => byId.get(id)).filter((r): r is CatalogRow => !!r);
  const years = rows.map((r) => r.year).filter((y): y is number => !!y);
  const thisYear = new Date().getFullYear();
  const languages: Record<string, number> = {};
  for (const r of rows) if (r.language) languages[r.language] = (languages[r.language] ?? 0) + 1;
  const aff = index?.affinity.get(label);
  let served = 0;
  let servedOld = 0;
  for (const r of rows) {
    if (!r.year) continue;
    const w = ((aff?.get(r.id) ?? 0) * freshness(r)) ** 2;
    served += w;
    if (r.year < 2000) servedOld += w;
  }
  const entries = ps.reduce((s, p) => s + (index?.playlists[p]?.size ?? 0), 0);
  const have = ps.reduce((s, p) => s + (index?.members[p]?.length ?? 0), 0);
  return {
    ps,
    rows,
    years,
    facts: {
      songs: rows.length,
      playlists: ps.length,
      coverage: entries ? Math.min(1, have / entries) : null,
      medianYear: median(years),
      p25Year: median(years, 0.25),
      p75Year: median(years, 0.75),
      recentShare: ratio(years.filter((y) => y >= thisYear - 5).length, years.length),
      oldShare: ratio(servedOld, served),
      languages,
    },
  };
}

function listening(plays: PlayEvent[], setIds: Set<string>): Listening {
  const bySet = new Map<string, PlayEvent[]>();
  for (const p of plays) bySet.set(p.setId, [...(bySet.get(p.setId) ?? []), p]);
  for (const id of setIds) if (!bySet.has(id)) bySet.set(id, []);
  const decided = plays.filter((p) => DECIDED.includes(p.end)).length;
  const skips = plays.filter((p) => p.end === "skip");
  const played = [...bySet.values()].filter((ps) => ps.length);
  const bailed = played.filter((ps) => ps.length <= 2 && BAIL_ENDS.includes(ps[ps.length - 1].end));
  return {
    listeners: new Set(plays.map((p) => p.listener)).size,
    sets: bySet.size,
    plays: plays.length,
    minutes: Math.round(plays.reduce((s, p) => s + p.playedSec, 0) / 60),
    skips: skips.length,
    earlySkips: skips.filter((p) => p.playedSec < EARLY_SKIP_SEC).length,
    picks: plays.filter((p) => p.end === "pick").length,
    skipRate: ratio(skips.length, decided),
    bailRate: ratio(bailed.length, played.length),
    songsPerSet: ratio(plays.length, played.length),
    lastPlayed: plays.length ? plays[plays.length - 1].at : null,
  };
}

function issuesFor(row: Omit<VibeRow, "issues" | "status">): Issue[] {
  const out: Issue[] = [];
  const { library: l, listening: x } = row;
  if (!l.playlists) out.push({ level: "critical", text: "No playlists found in this month's harvest" });
  else if (l.playlists < 5) out.push({ level: "warning", text: `Only ${l.playlists} playlists behind it` });
  if (l.playlists && l.songs < 60) out.push({ level: "critical", text: `Only ${l.songs} songs - sets will repeat` });
  else if (l.playlists && l.songs < 150) out.push({ level: "warning", text: `Thin: ${l.songs} songs` });
  // an all-language vibe is also a Hindi and a Punjabi vibe: each needs its own pool
  if (row.anyLanguage && l.playlists)
    for (const [code, name] of [["hi", "Hindi"], ["pa", "Punjabi"]] as const) {
      const n = l.languages[code] ?? 0;
      if (n < 60) out.push({ level: "critical", text: `Only ${n} ${name} songs - ${name} sets will repeat` });
      else if (n < 150) out.push({ level: "warning", text: `Thin in ${name}: ${n} songs` });
    }
  if (l.coverage != null && l.coverage < 0.2)
    out.push({ level: "warning", text: `Library has ${Math.round(l.coverage * 100)}% of its playlists' songs` });
  if (!row.era && l.oldShare != null && l.oldShare >= 0.2)
    out.push({
      level: l.oldShare >= 0.4 ? "critical" : "warning",
      text: `Leans old: ${Math.round(l.oldShare * 100)}% of what's served is from before 2000 (pool median ${l.medianYear})`,
    });
  if (x.skipRate != null && x.plays >= 15 && x.skipRate >= 0.25)
    out.push({
      level: x.skipRate >= 0.4 ? "critical" : "warning",
      text: `${Math.round(x.skipRate * 100)}% of songs skipped`,
    });
  if (x.bailRate != null && x.sets >= 5 && x.bailRate >= 0.4)
    out.push({ level: "warning", text: `${Math.round(x.bailRate * 100)}% of sets abandoned in the first 2 songs` });
  return out;
}

async function load(days: number | null) {
  const since = days ? Date.now() - days * DAY : 0;
  const [cat, index, events] = await Promise.all([loadCatalog(), loadVibeIndex(), readEvents(since)]);
  const plays = events.filter((e): e is PlayEvent => e.type === "play");
  const sets = events.filter((e): e is Extract<ListenEvent, { type: "set" }> => e.type === "set");
  return { cat, index, events, plays, sets };
}

const mainVibe = (e: { vibes: string[] }) => e.vibes[0] || NO_VIBE;

function vibeRows(
  index: VibeIndex | null,
  byId: Map<string, CatalogRow>,
  plays: PlayEvent[],
  sets: { setId: string; vibes: string[] }[]
): VibeRow[] {
  const playsBy = new Map<string, PlayEvent[]>();
  for (const p of plays) playsBy.set(mainVibe(p), [...(playsBy.get(mainVibe(p)) ?? []), p]);
  const setsBy = new Map<string, Set<string>>();
  for (const s of sets) setsBy.set(mainVibe(s), (setsBy.get(mainVibe(s)) ?? new Set()).add(s.setId));
  const labels = [...new Set([...ALL_VIBES, ...(index?.labels ?? [])])];
  return labels.map((label) => {
    const base = {
      label,
      group: groupOf(label),
      anyLanguage: VIBES.anyLanguage.includes(label),
      era: ageless(label),
      library: libraryFacts(label, index, byId).facts,
      listening: listening(playsBy.get(label) ?? [], setsBy.get(label) ?? new Set()),
    };
    const issues = issuesFor(base);
    const status: VibeRow["status"] = issues.some((i) => i.level === "critical")
      ? "critical"
      : issues.length
        ? "warning"
        : "good";
    return { ...base, issues, status };
  });
}

export async function overview(days: number | null): Promise<Overview> {
  const { cat, index, events, plays, sets } = await load(days);
  const now = Date.now();
  const firstSeen = new Map<string, number>();
  // "new this week" needs everyone's first visit, not the window's
  for (const e of days ? await readEvents(0) : events)
    if (e.listener && !firstSeen.has(e.listener)) firstSeen.set(e.listener, e.at);

  const songs = cat.tracks.filter((r) => r.kind === "song").length;
  const decided = plays.filter((p) => DECIDED.includes(p.end)).length;
  const skips = plays.filter((p) => p.end === "skip");
  const all = listening(plays, new Set(sets.map((s) => s.setId)));

  const daily: Overview["daily"] = [];
  const span = Math.min(days ?? 30, 90);
  for (let d = span - 1; d >= 0; d--) {
    const day = dayOf(now - d * DAY);
    const ps = plays.filter((p) => dayOf(p.at) === day);
    daily.push({
      day,
      plays: ps.length,
      skips: ps.filter((p) => p.end === "skip").length,
      listeners: new Set(ps.map((p) => p.listener)).size,
    });
  }

  const ends = Object.fromEntries(
    (["auto", "skip", "drop", "pick", "revibe", "stop", "left"] as PlayEnd[]).map((k) => [
      k,
      plays.filter((p) => p.end === k).length,
    ])
  ) as Record<PlayEnd, number>;

  const pageMap = new Map<string, { sets: number; plays: number }>();
  for (const s of sets) {
    const m = pageMap.get(s.page) ?? { sets: 0, plays: 0 };
    m.sets++;
    pageMap.set(s.page, m);
  }
  for (const p of plays) {
    const m = pageMap.get(p.page) ?? { sets: 0, plays: 0 };
    m.plays++;
    pageMap.set(p.page, m);
  }

  const intents = events.filter((e): e is Extract<ListenEvent, { type: "intent" }> => e.type === "intent");
  const unmatched = new Map<string, { prompt: string; count: number; last: number }>();
  for (const i of intents) {
    if (i.chip || i.vibes.length) continue;
    const key = i.prompt.trim().toLowerCase();
    if (!key) continue;
    const u = unmatched.get(key) ?? { prompt: i.prompt.trim(), count: 0, last: 0 };
    u.count++;
    u.last = i.at;
    unmatched.set(key, u);
  }

  // listeners: everyone who played something in the window
  const byListener = new Map<string, PlayEvent[]>();
  for (const p of plays) byListener.set(p.listener, [...(byListener.get(p.listener) ?? []), p]);
  const listeners: ListenerRow[] = [...byListener].map(([id, ps]) => {
    const vibeCount = new Map<string, number>();
    for (const p of ps) if (p.vibes[0]) vibeCount.set(p.vibes[0], (vibeCount.get(p.vibes[0]) ?? 0) + 1);
    const top = [...vibeCount].sort((a, b) => b[1] - a[1])[0];
    return {
      id: id.slice(0, 8),
      firstSeen: firstSeen.get(id) ?? ps[0].at,
      lastSeen: ps[ps.length - 1].at,
      days: new Set(ps.map((p) => dayOf(p.at))).size,
      sets: new Set(ps.map((p) => p.setId)).size,
      plays: ps.length,
      minutes: Math.round(ps.reduce((s, p) => s + p.playedSec, 0) / 60),
      skipRate: ratio(
        ps.filter((p) => p.end === "skip").length,
        ps.filter((p) => DECIDED.includes(p.end)).length
      ),
      topVibe: top?.[0] ?? null,
    };
  });
  listeners.sort((a, b) => b.lastSeen - a.lastSeen);

  const vibes = vibeRows(index, cat.byId, plays, sets);
  const noVibe = listening(
    plays.filter((p) => !p.vibes.length),
    new Set(sets.filter((s) => !s.vibes.length).map((s) => s.setId))
  );

  return {
    generatedAt: now,
    harvest: index?.month ?? null,
    days,
    totals: {
      listeners: byListener.size,
      active7: new Set(plays.filter((p) => p.at >= now - 7 * DAY).map((p) => p.listener)).size,
      new7: [...firstSeen.values()].filter((t) => t >= now - 7 * DAY).length,
      returning: listeners.filter((l) => l.days >= 2).length,
      sets: all.sets,
      plays: plays.length,
      hours: plays.reduce((s, p) => s + p.playedSec, 0) / 3600,
      skipRate: ratio(skips.length, decided),
      earlySkipRate: ratio(skips.filter((p) => p.playedSec < EARLY_SKIP_SEC).length, decided),
      songsPerSet: all.songsPerSet,
      librarySongs: songs,
      vibesWithData: index?.labels.length ?? 0,
    },
    daily,
    ends,
    pages: [...pageMap].map(([page, m]) => ({ page, ...m })).sort((a, b) => b.sets - a.sets),
    requests: {
      total: intents.length,
      chips: intents.filter((i) => i.chip).length,
      typed: intents.filter((i) => !i.chip).length,
      unmatched: [...unmatched.values()].sort((a, b) => b.count - a.count || b.last - a.last).slice(0, 20),
    },
    listeners: listeners.slice(0, 50),
    vibes,
    noVibe,
  };
}

export async function vibeDetail(label: string, days: number | null): Promise<VibeDetail | null> {
  const { cat, index, plays, sets } = await load(days);
  const row = vibeRows(index, cat.byId, plays, sets).find((r) => r.label === label);
  if (!row) return null;
  const { ps, rows, years } = libraryFacts(label, index, cat.byId);
  const mine = plays.filter((p) => mainVibe(p) === label);

  const songPlays = new Map<string, { plays: number; skips: number }>();
  for (const p of mine) {
    const s = songPlays.get(p.track) ?? { plays: 0, skips: 0 };
    s.plays++;
    if (p.end === "skip") s.skips++;
    songPlays.set(p.track, s);
  }
  const stat = (r: CatalogRow, affinity?: number): SongStat => ({
    id: r.id,
    title: r.title,
    artist: r.artist,
    year: r.year ?? null,
    affinity,
    plays: songPlays.get(r.id)?.plays ?? 0,
    skips: songPlays.get(r.id)?.skips ?? 0,
  });

  const aff = index?.affinity.get(label);
  const topSongs = rows
    .map((r) => ({ r, a: aff?.get(r.id) ?? 0 }))
    .sort((a, b) => b.a - a.a)
    .slice(0, 15)
    .map(({ r, a }) => stat(r, +a.toFixed(3)));
  const mostSkipped = [...songPlays]
    .filter(([, s]) => s.skips > 0)
    .sort((a, b) => b[1].skips / b[1].plays - a[1].skips / a[1].plays || b[1].skips - a[1].skips)
    .slice(0, 15)
    .map(([id]) => cat.byId.get(id))
    .filter((r): r is CatalogRow => !!r)
    .map((r) => stat(r, aff?.get(r.id)));

  const buckets = new Map<number, number>();
  for (const y of years) buckets.set(Math.floor(y / 5) * 5, (buckets.get(Math.floor(y / 5) * 5) ?? 0) + 1);
  const keys = [...buckets.keys()].sort((a, b) => a - b);
  const yearHist: VibeDetail["years"] = [];
  for (let y = keys[0]; keys.length && y <= keys[keys.length - 1]; y += 5)
    yearHist.push({ from: y, songs: buckets.get(y) ?? 0 });

  const daily: VibeDetail["daily"] = [];
  const span = Math.min(days ?? 30, 90);
  for (let d = span - 1; d >= 0; d--) {
    const day = dayOf(Date.now() - d * DAY);
    const dp = mine.filter((p) => dayOf(p.at) === day);
    daily.push({ day, plays: dp.length, skips: dp.filter((p) => p.end === "skip").length });
  }

  return {
    row,
    playlists: ps
      .map((p) => {
        const pl = index!.playlists[p];
        return {
          id: pl.id,
          title: pl.title,
          channel: pl.channel ?? null,
          size: pl.size,
          inLibrary: index!.members[p]?.length ?? 0,
          modified: pl.modified ?? null,
        };
      })
      .sort((a, b) => b.inLibrary - a.inLibrary),
    years: yearHist,
    topSongs,
    mostSkipped,
    daily,
  };
}
