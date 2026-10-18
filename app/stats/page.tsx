"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { Cover } from "@/components/Cover";
import type { HopRow, Overview, TransitionStats, VibeDetail, VibeRow } from "@/lib/server/vibeStats";

/**
 * Vibe health: for every vibe chip, what the library has for it (songs,
 * playlists, how old they are) next to how its sets go (listeners, skips,
 * abandoned sets) - so the vibes that need work stand out. Data from
 * /api/stats (lib/server/vibeStats.ts); listening from lib/client/telemetry.
 */

const WINDOWS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 0, label: "All time" },
];
const GROUPS = ["all", "needs work", "general", "hindi", "punjabi"] as const;
const YEAR_MIN = 1960;
const YEAR_MAX = new Date().getFullYear();

const pct = (x: number | null | undefined) => (x == null ? "–" : `${Math.round(x * 100)}%`);
const num = (x: number | null | undefined, digits = 0) =>
  x == null ? "–" : x.toLocaleString(undefined, { maximumFractionDigits: digits });
const ago = (ms: number | null) => {
  if (!ms) return "–";
  const m = (Date.now() - ms) / 60000;
  if (m < 60) return `${Math.max(1, Math.round(m))}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};
const SEVERITY = { critical: 0, warning: 1, good: 2 };

const END_LABELS: Record<string, string> = {
  auto: "played through",
  skip: "skipped",
  drop: "dropped (held NEXT)",
  pick: "another song picked",
  revibe: "new vibe asked for",
  stop: "set stopped",
  left: "tab closed",
};

function Status({ s }: { s: VibeRow["status"] }) {
  if (s === "critical")
    return (
      <span className="inline-flex items-center gap-1 text-red-300">
        <span aria-hidden>✕</span> Fix
      </span>
    );
  if (s === "warning")
    return (
      <span className="inline-flex items-center gap-1 text-amber-300">
        <span aria-hidden>▲</span> Watch
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-emerald-300">
      <span aria-hidden>✓</span> OK
    </span>
  );
}

function Tile({ value, label, sub }: { value: string; label: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 p-3">
      <div className="text-2xl font-bold tabular-nums text-zinc-100">{value}</div>
      <div className="text-[10px] uppercase tracking-widest text-zinc-500">{label}</div>
      {sub && <div className="mt-1 text-xs text-zinc-400">{sub}</div>}
    </div>
  );
}

/** Where the middle half of a vibe's songs were released, on a 1960-now line. */
function YearSpan({ row }: { row: VibeRow }) {
  const { p25Year: a, p75Year: b, medianYear: m } = row.library;
  if (m == null || a == null || b == null) return <span className="text-zinc-600">–</span>;
  const x = (y: number) => `${((Math.max(YEAR_MIN, Math.min(YEAR_MAX, y)) - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * 100}%`;
  return (
    <span className="flex items-center gap-2" title={`middle half ${a}–${b}, median ${m}`}>
      <span className="w-9 tabular-nums">{m}</span>
      <span className="relative hidden h-2 w-20 rounded-full bg-zinc-800 sm:block">
        <span
          className="absolute top-0 h-2 rounded-full bg-cyan-900"
          style={{ left: x(a), width: `calc(${x(b)} - ${x(a)})` }}
        />
        <span className="absolute -top-0.5 h-3 w-0.5 rounded bg-cyan-300" style={{ left: x(m) }} />
      </span>
    </span>
  );
}

const TRIGGER_LABELS: Record<string, string> = {
  auto: "the DJ moved on",
  skip: "NEXT tapped",
  drop: "NEXT held (drop)",
  pick: "a song picked",
  back: "BACK",
};
const HOP_FILTERS = ["all", "disliked", "liked", "unrated"] as const;
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
const styleName = (s: string) => s.replace(/_/g, " ");

/**
 * Which transitions work: like / dislike from the popup after each one (and
 * B skipped within 20s, the silent verdict) by style, by what set it off, by
 * song - and every recent transition with its songs and cue points.
 */
function Transitions({ t }: { t: TransitionStats }) {
  const [filter, setFilter] = useState<(typeof HOP_FILTERS)[number]>("all");
  const recent = t.recent.filter(
    (r: HopRow) =>
      filter === "all" ||
      (filter === "liked" ? r.rating === "up" : filter === "disliked" ? r.rating === "down" : !r.rating)
  );
  const dislike = (x: { up: number; down: number }) => (x.up + x.down ? x.down / (x.up + x.down) : null);
  const T = t.totals;
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">Transitions</h2>
        <p className="text-xs text-zinc-500">
          {num(T.hops)} transitions · {num(T.up + T.down)} rated ({pct(T.rateShare)}) · 👍 {num(T.up)} · 👎{" "}
          {num(T.down)} · {pct(T.likeRate)} liked · {pct(T.quickSkipRate)} had the next song skipped within 20s
        </p>
      </div>
      {!T.hops ? (
        <p className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-sm text-zinc-400">
          No transitions logged in this window yet. Each one is logged as it plays, and a 👍 / 👎 popup
          asks the listener once the blend is over.
        </p>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="overflow-x-auto rounded-xl border border-zinc-800 lg:col-span-2">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-zinc-800 bg-zinc-900/60 text-xs text-zinc-400">
                  <tr>
                    {["Style", "Played", "👍", "👎", "Disliked", "Next skipped <20s", "Avg length"].map((h) => (
                      <th key={h} className="whitespace-nowrap px-2 py-2 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/70">
                  {t.byStyle.map((r) => (
                    <tr key={r.style}>
                      <td className="whitespace-nowrap px-2 py-1.5">{styleName(r.style)}</td>
                      <td className="px-2 py-1.5 tabular-nums">{r.hops}</td>
                      <td className="px-2 py-1.5 tabular-nums text-emerald-300">{r.up || "–"}</td>
                      <td className="px-2 py-1.5 tabular-nums text-red-300">{r.down || "–"}</td>
                      <td className="px-2 py-1.5 text-xs">
                        <RateBar value={dislike(r)} />
                      </td>
                      <td className="px-2 py-1.5 text-xs">
                        <RateBar value={r.quickSkipRate} warn={0.15} bad={0.3} />
                      </td>
                      <td className="px-2 py-1.5 tabular-nums text-zinc-400">{num(r.avgDur, 1)}s</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="space-y-4">
              <div className="rounded-xl border border-zinc-800 p-3">
                <h3 className="text-xs uppercase tracking-widest text-zinc-500">What set it off</h3>
                <ul className="mt-2 divide-y divide-zinc-800/70 text-sm">
                  {t.byTrigger.map((r) => (
                    <li key={r.trigger} className="flex justify-between gap-2 py-1.5">
                      <span>{TRIGGER_LABELS[r.trigger] ?? r.trigger}</span>
                      <span className="text-xs tabular-nums text-zinc-400">
                        {r.hops} · 👍 {r.up} · 👎 {r.down}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded-xl border border-zinc-800 p-3">
                <h3 className="text-xs uppercase tracking-widest text-zinc-500">Songs in disliked transitions</h3>
                <ul className="mt-2 max-h-56 divide-y divide-zinc-800/70 overflow-y-auto text-sm">
                  {t.songs.map((s) => (
                    <li key={s.id} className="flex justify-between gap-2 py-1.5">
                      <span className="min-w-0 truncate">
                        {s.title} <span className="text-zinc-500">· {s.artist}</span>
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-zinc-400">
                        👎 {s.down} · 👍 {s.up} · out {s.asFrom} / in {s.asTo}
                      </span>
                    </li>
                  ))}
                  {!t.songs.length && <li className="py-1.5 text-zinc-500">no disliked transitions</li>}
                </ul>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="mr-2 text-sm font-semibold">Recent transitions</h3>
              {HOP_FILTERS.map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`rounded-full border px-2.5 py-1 text-xs capitalize ${
                    filter === f ? "border-cyan-500 bg-cyan-950/60 text-cyan-200" : "border-zinc-800 text-zinc-400 hover:border-zinc-600"
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
            <div className="max-h-[32rem] overflow-auto rounded-xl border border-zinc-800">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 border-b border-zinc-800 bg-zinc-900 text-xs text-zinc-400">
                  <tr>
                    {["When", "", "Style", "From (left at)", "To (came in at)", "Length", "Set off by", "Details"].map((h, i) => (
                      <th key={i} className="whitespace-nowrap px-2 py-2 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/70">
                  {recent.map((r) => (
                    <tr key={r.hopId} className={r.rating === "down" ? "bg-red-950/20" : ""}>
                      <td className="whitespace-nowrap px-2 py-1.5 text-xs text-zinc-400">{ago(r.at)}</td>
                      <td className="px-2 py-1.5">{r.rating === "up" ? "👍" : r.rating === "down" ? "👎" : ""}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-cyan-300">{styleName(r.style)}</td>
                      <td className="max-w-[14rem] px-2 py-1.5">
                        <div className="truncate">{r.from.title}</div>
                        <div className="truncate text-xs text-zinc-500">
                          {r.from.artist} · <span className="tabular-nums text-zinc-300">{mmss(r.outSec)}</span>
                        </div>
                      </td>
                      <td className="max-w-[14rem] px-2 py-1.5">
                        <div className="truncate">{r.to.title}</div>
                        <div className="truncate text-xs text-zinc-500">
                          {r.to.artist} · <span className="tabular-nums text-zinc-300">{mmss(r.inSec)}</span>
                        </div>
                      </td>
                      <td className="px-2 py-1.5 tabular-nums text-zinc-400">{num(r.durSec, 1)}s</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-xs text-zinc-400">
                        {TRIGGER_LABELS[r.trigger] ?? r.trigger}
                      </td>
                      <td className="px-2 py-1.5 text-xs text-zinc-500">
                        {[
                          r.bpmFrom && r.bpmTo ? `${Math.round(r.bpmFrom)}→${Math.round(r.bpmTo)} bpm` : "",
                          r.keyFrom && r.keyTo ? `${r.keyFrom}→${r.keyTo}` : "",
                          r.keyLock ? "key-locked" : "",
                          r.vocal ? `vocal ${r.vocal}` : "",
                          r.ranOut ? "song ran out" : "",
                          r.vibe ?? "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                        {r.quickSkip && <span className="ml-1 text-amber-400">· next skipped fast</span>}
                      </td>
                    </tr>
                  ))}
                  {!recent.length && (
                    <tr>
                      <td colSpan={8} className="px-2 py-4 text-center text-sm text-zinc-500">
                        none in this window
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function RateBar({ value, warn = 0.25, bad = 0.4 }: { value: number | null; warn?: number; bad?: number }) {
  if (value == null) return <span className="text-zinc-600">–</span>;
  const tone = value >= bad ? "bg-red-400" : value >= warn ? "bg-amber-400" : "bg-zinc-500";
  return (
    <span className="flex items-center gap-2">
      <span className="w-9 tabular-nums">{pct(value)}</span>
      <span className="hidden h-1.5 w-12 overflow-hidden rounded-full bg-zinc-800 sm:block">
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, value * 100)}%` }} />
      </span>
    </span>
  );
}

/** Single-series vertical bars with a hover readout. */
function Bars({
  data,
  label,
  detail,
  height = 96,
}: {
  data: { key: string; value: number }[];
  label: (i: number) => string;
  detail: (i: number) => string;
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div>
      <div className="mb-1 h-4 text-xs text-zinc-400">
        {hover != null ? (
          <>
            <span className="text-zinc-200">{label(hover)}</span> · {detail(hover)}
          </>
        ) : (
          <span className="text-zinc-600">hover a bar</span>
        )}
      </div>
      <div className="flex items-end gap-[2px] border-b border-zinc-800" style={{ height }} onMouseLeave={() => setHover(null)}>
        {data.map((d, i) => (
          <div
            key={d.key}
            className="flex h-full flex-1 items-end"
            onMouseEnter={() => setHover(i)}
            onClick={() => setHover(i)}
          >
            <div
              className={`w-full rounded-t ${hover === i ? "bg-cyan-300" : "bg-cyan-500/80"}`}
              style={{ height: d.value ? `${Math.max(3, (d.value / max) * 100)}%` : 0 }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-zinc-600">
        <span>{label(0)}</span>
        <span>{label(data.length - 1)}</span>
      </div>
    </div>
  );
}

type SortKey =
  | "status"
  | "label"
  | "songs"
  | "playlists"
  | "coverage"
  | "year"
  | "listeners"
  | "sets"
  | "plays"
  | "skip"
  | "bail";

const SORTS: Record<SortKey, (r: VibeRow) => number | string> = {
  status: (r) => SEVERITY[r.status] * 1e6 - r.listening.plays,
  label: (r) => r.label,
  songs: (r) => r.library.songs,
  playlists: (r) => r.library.playlists,
  coverage: (r) => r.library.coverage ?? -1,
  year: (r) => r.library.medianYear ?? 0,
  listeners: (r) => r.listening.listeners,
  sets: (r) => r.listening.sets,
  plays: (r) => r.listening.plays,
  skip: (r) => r.listening.skipRate ?? -1,
  bail: (r) => r.listening.bailRate ?? -1,
};

function Detail({ label, days }: { label: string; days: number }) {
  const [d, setD] = useState<VibeDetail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    fetch(`/api/stats?days=${days}&vibe=${encodeURIComponent(label)}`)
      .then(async (r) => {
        const body = await r.json();
        if (!alive) return;
        if (r.ok) setD(body);
        else setError(body.error ?? "failed");
      })
      .catch(() => alive && setError("failed"));
    return () => {
      alive = false;
    };
  }, [label, days]);

  if (error) return <p className="p-4 text-sm text-red-400">{error}</p>;
  if (!d) return <p className="p-4 text-sm text-zinc-500">Loading {label}…</p>;
  const { row } = d;
  const langs = Object.entries(row.library.languages).sort((a, b) => b[1] - a[1]);
  return (
    <div className="grid gap-5 p-4 md:grid-cols-2">
      <section className="space-y-3">
        {row.issues.length > 0 ? (
          <ul className="space-y-1 text-sm">
            {row.issues.map((i) => (
              <li key={i.text} className={i.level === "critical" ? "text-red-300" : "text-amber-300"}>
                <span aria-hidden>{i.level === "critical" ? "✕" : "▲"}</span> {i.text}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-emerald-300">✓ Nothing flagged</p>
        )}
        <dl className="grid grid-cols-3 gap-2 text-xs">
          {[
            ["recent (5 yrs)", pct(row.library.recentShare)],
            ["middle half", row.library.p25Year ? `${row.library.p25Year}–${row.library.p75Year}` : "–"],
            ["languages", langs.map(([l, n]) => `${l} ${n}`).join(" · ") || "–"],
            ["minutes heard", num(row.listening.minutes)],
            ["songs / set", num(row.listening.songsPerSet, 1)],
            ["skips < 20s", num(row.listening.earlySkips)],
            ["picked instead", num(row.listening.picks)],
            ["last played", ago(row.listening.lastPlayed)],
            ["kind", row.era ? "era / timeless" : row.anyLanguage ? "all languages" : row.group],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg border border-zinc-800 p-2">
              <dt className="text-[10px] uppercase tracking-widest text-zinc-500">{k}</dt>
              <dd className="mt-0.5 truncate text-zinc-200">{v}</dd>
            </div>
          ))}
        </dl>
        {d.years.length > 0 && (
          <div>
            <h4 className="mb-1 text-xs uppercase tracking-widest text-zinc-500">Songs by release year</h4>
            <Bars
              data={d.years.map((y) => ({ key: String(y.from), value: y.songs }))}
              label={(i) => `${d.years[i].from}–${d.years[i].from + 4}`}
              detail={(i) => `${d.years[i].songs} songs`}
              height={72}
            />
          </div>
        )}
        {d.daily.some((x) => x.plays) && (
          <div>
            <h4 className="mb-1 text-xs uppercase tracking-widest text-zinc-500">Songs played per day</h4>
            <Bars
              data={d.daily.map((x) => ({ key: x.day, value: x.plays }))}
              label={(i) => d.daily[i].day}
              detail={(i) => `${d.daily[i].plays} played · ${d.daily[i].skips} skipped`}
              height={56}
            />
          </div>
        )}
      </section>

      <section className="space-y-4">
        <div>
          <h4 className="mb-1 text-xs uppercase tracking-widest text-zinc-500">
            Playlists ({d.playlists.length}) · library songs / playlist size
          </h4>
          <ul className="max-h-56 divide-y divide-zinc-800/70 overflow-y-auto rounded-lg border border-zinc-800 text-xs">
            {d.playlists.map((p) => (
              <li key={p.id} className="flex items-center gap-2 px-2 py-1.5">
                <a
                  href={`https://www.youtube.com/playlist?list=${p.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate hover:text-cyan-300"
                >
                  {p.title}
                  {p.channel && <span className="text-zinc-500"> · {p.channel}</span>}
                </a>
                <span className="shrink-0 tabular-nums text-zinc-400">
                  {p.inLibrary}/{p.size}
                </span>
              </li>
            ))}
            {!d.playlists.length && <li className="px-2 py-1.5 text-zinc-500">none this month</li>}
          </ul>
        </div>
        <SongList title="Most skipped" songs={d.mostSkipped} empty="no skips logged" showSkips />
        <SongList title="Core songs (strongest in its playlists)" songs={d.topSongs} empty="no songs" />
      </section>
    </div>
  );
}

function SongList({
  title,
  songs,
  empty,
  showSkips,
}: {
  title: string;
  songs: VibeDetail["topSongs"];
  empty: string;
  showSkips?: boolean;
}) {
  return (
    <div>
      <h4 className="mb-1 text-xs uppercase tracking-widest text-zinc-500">{title}</h4>
      <ul className="max-h-56 divide-y divide-zinc-800/70 overflow-y-auto rounded-lg border border-zinc-800 text-xs">
        {songs.map((s) => (
          <li key={s.id} className="flex items-center gap-2 px-2 py-1.5">
            <Cover src={s.thumbnail} lazy className="h-6 w-6 rounded" />
            <span className="min-w-0 flex-1 truncate">
              {s.title} <span className="text-zinc-500">· {s.artist}</span>
            </span>
            <span className="shrink-0 tabular-nums text-zinc-500">{s.year ?? "–"}</span>
            <span className="w-24 shrink-0 text-right tabular-nums text-zinc-400">
              {showSkips ? `${s.skips}/${s.plays} skipped` : s.plays ? `${s.plays} plays` : ""}
            </span>
          </li>
        ))}
        {!songs.length && <li className="px-2 py-1.5 text-zinc-500">{empty}</li>}
      </ul>
    </div>
  );
}

export default function StatsPage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [group, setGroup] = useState<(typeof GROUPS)[number]>("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "status", desc: false });
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/stats?days=${days}`)
      .then(async (r) => {
        const body = await r.json();
        if (!alive) return;
        setError(r.ok ? "" : (body.error ?? "stats unavailable"));
        if (r.ok) setData(body);
      })
      .catch(() => alive && setError("stats unavailable"));
    return () => {
      alive = false;
    };
  }, [days]);

  const rows = useMemo(() => {
    if (!data) return [];
    const f = q.trim().toLowerCase();
    const out = data.vibes.filter(
      (r) =>
        (group === "all" ||
          (group === "needs work" ? r.status !== "good" : r.group === group || (r.anyLanguage && group !== "general"))) &&
        (!f || r.label.includes(f))
    );
    const get = SORTS[sort.key];
    out.sort((a, b) => {
      const x = get(a);
      const y = get(b);
      const c = typeof x === "string" ? x.localeCompare(String(y)) : x - (y as number);
      return sort.desc ? -c : c;
    });
    return out;
  }, [data, group, q, sort]);

  const counts = useMemo(() => {
    const v = data?.vibes ?? [];
    return {
      critical: v.filter((r) => r.status === "critical").length,
      warning: v.filter((r) => r.status === "warning").length,
      good: v.filter((r) => r.status === "good").length,
    };
  }, [data]);

  function header(key: SortKey, text: string, cls = "") {
    const on = sort.key === key;
    return (
      <th className={`whitespace-nowrap px-2 py-2 font-medium ${cls}`}>
        <button
          onClick={() =>
            setSort(on ? { key, desc: !sort.desc } : { key, desc: !["label", "status"].includes(key) })
          }
          className={on ? "text-cyan-300" : "hover:text-zinc-200"}
        >
          {text}
          {on ? (sort.desc ? " ↓" : " ↑") : ""}
        </button>
      </th>
    );
  }

  const t = data?.totals;
  const noListening = !!data && data.totals.plays === 0;
  const endsTotal = data ? Object.values(data.ends).reduce((s, n) => s + n, 0) : 0;

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Vibe health</h1>
          <p className="text-sm text-zinc-400">
            What the library has for each vibe, next to how its sets go.
            {data?.harvest && <> Playlists from the {data.harvest} harvest.</>}
          </p>
        </div>
        <div className="flex rounded-lg border border-zinc-800 p-0.5 text-xs">
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              onClick={() => setDays(w.days)}
              className={`rounded-md px-2.5 py-1 ${days === w.days ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </header>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {!data && !error && <p className="text-sm text-zinc-500">Loading…</p>}

      {data && t && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Tile value={num(t.listeners)} label="listeners" sub={`${t.active7} this week · ${t.new7} new`} />
            <Tile value={num(t.returning)} label="came back" sub="listened on 2+ days" />
            <Tile value={num(t.sets)} label="sets" sub={`${num(t.songsPerSet, 1)} songs per set`} />
            <Tile value={num(t.plays)} label="songs played" sub={t.hours >= 1 ? `${num(t.hours, 1)} hours heard` : `${Math.round(t.hours * 60)} minutes heard`} />
            <Tile value={pct(t.skipRate)} label="skip rate" sub={`${pct(t.earlySkipRate)} within 20s`} />
            <Tile
              value={`${counts.critical + counts.warning}/${data.vibes.length}`}
              label="vibes need work"
              sub={`${counts.critical} to fix · ${counts.warning} to watch`}
            />
          </div>

          {noListening && (
            <p className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-sm text-zinc-400">
              No listening logged in this window yet. Library columns are live now; listeners,
              skips and abandoned sets fill in as people play sets.
            </p>
          )}

          {!noListening && (
            <section className="grid gap-4 md:grid-cols-3">
              <div className="rounded-xl border border-zinc-800 p-3 md:col-span-2">
                <h2 className="mb-2 text-xs uppercase tracking-widest text-zinc-500">Songs played per day</h2>
                <Bars
                  data={data.daily.map((d) => ({ key: d.day, value: d.plays }))}
                  label={(i) => data.daily[i].day}
                  detail={(i) =>
                    `${data.daily[i].plays} played · ${data.daily[i].skips} skipped · ${data.daily[i].listeners} listeners`
                  }
                />
              </div>
              <div className="rounded-xl border border-zinc-800 p-3">
                <h2 className="mb-2 text-xs uppercase tracking-widest text-zinc-500">How songs ended</h2>
                <ul className="space-y-1.5 text-xs">
                  {Object.entries(data.ends)
                    .filter(([, n]) => n)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, n]) => (
                      <li key={k}>
                        <div className="flex justify-between text-zinc-300">
                          <span>{END_LABELS[k] ?? k}</span>
                          <span className="tabular-nums text-zinc-400">
                            {n} · {pct(n / endsTotal)}
                          </span>
                        </div>
                        <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                          <div className="h-full rounded-full bg-cyan-500/80" style={{ width: `${(n / endsTotal) * 100}%` }} />
                        </div>
                      </li>
                    ))}
                </ul>
              </div>
            </section>
          )}

          {data.transitions && <Transitions t={data.transitions} />}

          <section className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="mr-2 text-lg font-semibold">Vibes</h2>
              {GROUPS.map((g) => (
                <button
                  key={g}
                  onClick={() => setGroup(g)}
                  className={`rounded-full border px-2.5 py-1 text-xs capitalize ${
                    group === g ? "border-cyan-500 bg-cyan-950/60 text-cyan-200" : "border-zinc-800 text-zinc-400 hover:border-zinc-600"
                  }`}
                >
                  {g}
                </button>
              ))}
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Find a vibe…"
                className="ml-auto w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm outline-none focus:border-cyan-500 sm:w-48"
              />
            </div>
            <div className="overflow-x-auto rounded-xl border border-zinc-800">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-zinc-800 bg-zinc-900/60 text-xs text-zinc-400">
                  <tr>
                    {header("status", "Status")}
                    {header("label", "Vibe")}
                    {header("songs", "Songs", "text-right")}
                    {header("playlists", "Playlists", "text-right")}
                    {header("coverage", "In library")}
                    {header("year", "Median year")}
                    {header("listeners", "Listeners", "text-right")}
                    {header("sets", "Sets", "text-right")}
                    {header("plays", "Plays", "text-right")}
                    {header("skip", "Skipped")}
                    {header("bail", "Abandoned")}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/70">
                  {rows.map((r) => (
                    <Fragment key={r.label}>
                      <tr
                        onClick={() => setOpen(open === r.label ? null : r.label)}
                        className={`cursor-pointer transition hover:bg-zinc-900/60 ${open === r.label ? "bg-zinc-900/60" : ""}`}
                        title={r.issues.map((i) => i.text).join("\n") || "nothing flagged"}
                      >
                        <td className="whitespace-nowrap px-2 py-2 text-xs">
                          <Status s={r.status} />
                        </td>
                        <td className="px-2 py-2">
                          <span className="block max-w-[16rem] truncate">{r.label}</span>
                          <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                            {r.anyLanguage ? "all languages" : r.group}
                            {r.era && " · era / timeless"}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">{num(r.library.songs)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{num(r.library.playlists)}</td>
                        <td className="px-2 py-2 text-xs">
                          <RateBar value={r.library.coverage} warn={2} bad={2} />
                        </td>
                        <td className="px-2 py-2 text-xs">
                          <YearSpan row={r} />
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">{num(r.listening.listeners)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{num(r.listening.sets)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{num(r.listening.plays)}</td>
                        <td className="px-2 py-2 text-xs">
                          <RateBar value={r.listening.skipRate} />
                        </td>
                        <td className="px-2 py-2 text-xs">
                          <RateBar value={r.listening.bailRate} warn={0.4} bad={0.6} />
                        </td>
                      </tr>
                      {open === r.label && (
                        <tr className="bg-zinc-900/30">
                          <td colSpan={11}>
                            <Detail label={r.label} days={days} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                  {!rows.length && (
                    <tr>
                      <td colSpan={11} className="px-2 py-4 text-center text-sm text-zinc-500">
                        no vibes match
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-zinc-500">
              Click a vibe for its playlists, release years and most-skipped songs. Listening is
              credited to a set&apos;s main vibe. Skipped = NEXT taps among songs that ended by
              choice; abandoned = sets stopped, closed or re-vibed within 2 songs. Era vibes
              (&quot;90s nostalgia&quot;) are never flagged for old songs.
              {data.noVibe.plays > 0 &&
                ` ${data.noVibe.plays} plays came from sets with no vibe (a song started from the library).`}
            </p>
          </section>

          <section className="grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-zinc-800 p-3">
              <h2 className="text-xs uppercase tracking-widest text-zinc-500">Requests</h2>
              <p className="mt-1 text-sm text-zinc-300">
                {num(data.requests.total)} vibe requests · {num(data.requests.chips)} chip taps ·{" "}
                {num(data.requests.typed)} typed
              </p>
              <h3 className="mt-3 text-xs text-zinc-400">Typed, and no playlist vibe covered it</h3>
              <ul className="mt-1 max-h-60 divide-y divide-zinc-800/70 overflow-y-auto text-sm">
                {data.requests.unmatched.map((u) => (
                  <li key={u.prompt} className="flex justify-between gap-2 py-1.5">
                    <span className="truncate">&ldquo;{u.prompt}&rdquo;</span>
                    <span className="shrink-0 text-xs tabular-nums text-zinc-500">
                      {u.count}× · {ago(u.last)}
                    </span>
                  </li>
                ))}
                {!data.requests.unmatched.length && <li className="py-1.5 text-zinc-500">none - every request found a vibe</li>}
              </ul>
            </div>
            <div className="rounded-xl border border-zinc-800 p-3">
              <h2 className="text-xs uppercase tracking-widest text-zinc-500">Where sets start</h2>
              <ul className="mt-2 divide-y divide-zinc-800/70 text-sm">
                {data.pages.map((p) => (
                  <li key={p.page} className="flex justify-between py-1.5">
                    <span className="font-mono text-xs">{p.page || "?"}</span>
                    <span className="text-xs tabular-nums text-zinc-400">
                      {p.sets} sets · {p.plays} songs
                    </span>
                  </li>
                ))}
                {!data.pages.length && <li className="py-1.5 text-zinc-500">no sets yet</li>}
              </ul>
              <p className="mt-3 text-xs text-zinc-500">
                Library: {num(t.librarySongs)} songs · {t.vibesWithData} vibes with playlist data
              </p>
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold">Listeners</h2>
            <p className="text-xs text-zinc-500">
              Anonymous - a random id each browser keeps. Newest activity first.
            </p>
            <div className="overflow-x-auto rounded-xl border border-zinc-800">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-zinc-800 bg-zinc-900/60 text-xs text-zinc-400">
                  <tr>
                    {["Listener", "First seen", "Last seen", "Days", "Sets", "Songs", "Minutes", "Skipped", "Favourite vibe"].map((h) => (
                      <th key={h} className="whitespace-nowrap px-2 py-2 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/70">
                  {data.listeners.map((l) => (
                    <tr key={l.id}>
                      <td className="px-2 py-1.5 font-mono text-xs">{l.id}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-xs text-zinc-400">{ago(l.firstSeen)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-xs text-zinc-400">{ago(l.lastSeen)}</td>
                      <td className="px-2 py-1.5 tabular-nums">{l.days}</td>
                      <td className="px-2 py-1.5 tabular-nums">{l.sets}</td>
                      <td className="px-2 py-1.5 tabular-nums">{l.plays}</td>
                      <td className="px-2 py-1.5 tabular-nums">{l.minutes}</td>
                      <td className="px-2 py-1.5 text-xs">
                        <RateBar value={l.skipRate} />
                      </td>
                      <td className="max-w-[12rem] truncate px-2 py-1.5 text-xs">{l.topVibe ?? "–"}</td>
                    </tr>
                  ))}
                  {!data.listeners.length && (
                    <tr>
                      <td colSpan={9} className="px-2 py-4 text-center text-sm text-zinc-500">
                        nobody has played a set in this window
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
