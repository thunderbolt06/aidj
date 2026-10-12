"use client";

import { useEffect, useState } from "react";
import type { Track } from "@/lib/types";
import { searchTracks } from "@/lib/client/dj";

interface Stats {
  songs: number;
  loops: number;
  sfx: number;
  hours: number;
  genres: { name: string; count: number }[];
  licenses: { name: string; count: number }[];
}

/**
 * The crate: what is in the library, browsable by genre / tempo / key, with
 * the licence and source of every track (the attribution CC licences ask for).
 */
export default function LibraryPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [q, setQ] = useState("");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/library")
      .then(async (r) => (r.ok ? setStats(await r.json()) : setError((await r.json()).error)))
      .catch(() => setError("library unavailable"));
  }, []);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      searchTracks(q, { limit: 60 })
        .then((r) => alive && setTracks(r))
        .catch((e) => alive && setError(e instanceof Error ? e.message : "search failed"));
    }, 120);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q]);

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-bold">Library</h1>
        <p className="text-sm text-zinc-400">
          Every track is downloaded and analyzed ahead of time - tempo, key,
          energy, hook and mix points - so nothing is computed while you listen.
        </p>
      </header>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {stats && (
        <div className="grid grid-cols-4 gap-2 text-center">
          {[
            [stats.songs, "songs"],
            [stats.hours, "hours"],
            [stats.loops, "beat loops"],
            [stats.sfx, "effects"],
          ].map(([n, label]) => (
            <div key={label} className="rounded-xl border border-zinc-800 p-3">
              <div className="text-xl font-bold text-cyan-400">{n}</div>
              <div className="text-[10px] uppercase tracking-widest text-zinc-500">{label}</div>
            </div>
          ))}
        </div>
      )}

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Filter - title, artist, genre, 120bpm, 8A…"
        className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-cyan-500"
      />

      {stats && (
        <div className="flex flex-wrap gap-1.5">
          {stats.genres.slice(0, 24).map((g) => (
            <button
              key={g.name}
              onClick={() => setQ(q === g.name ? "" : g.name)}
              className={`rounded-full border px-2.5 py-1 text-xs transition ${
                q === g.name
                  ? "border-cyan-500 bg-cyan-950/60 text-cyan-200"
                  : "border-zinc-800 text-zinc-400 hover:border-zinc-600"
              }`}
            >
              {g.name} <span className="text-zinc-600">{g.count}</span>
            </button>
          ))}
        </div>
      )}

      <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
        {tracks.map((t) => (
          <li key={t.id} className="flex items-center gap-3 p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={t.thumbnail} alt="" className="h-10 w-16 shrink-0 rounded object-cover" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">
                {t.sourceUrl ? (
                  <a href={t.sourceUrl} target="_blank" rel="noreferrer" className="hover:text-cyan-300">
                    {t.title}
                  </a>
                ) : (
                  t.title
                )}
                <span className="text-zinc-400"> · {t.artist}</span>
              </p>
              <p className="truncate text-xs text-zinc-500">
                {t.genres?.join(", ")}
                {t.license && (
                  <>
                    {" · "}
                    {t.licenseUrl ? (
                      <a href={t.licenseUrl} target="_blank" rel="noreferrer" className="underline decoration-zinc-700 hover:text-zinc-300">
                        {t.license}
                      </a>
                    ) : (
                      t.license
                    )}
                  </>
                )}
              </p>
            </div>
            <div className="shrink-0 text-right text-[10px] leading-tight text-zinc-500">
              <span className="block text-cyan-400">{Math.round(t.bpm ?? 0)} BPM</span>
              {t.camelot}
            </div>
          </li>
        ))}
      </ul>

      {stats && stats.licenses.length > 0 && (
        <section className="text-xs text-zinc-500">
          <h2 className="mb-1 uppercase tracking-widest">Licences in this library</h2>
          <p>{stats.licenses.map((l) => `${l.name} (${l.count})`).join(" · ")}</p>
        </section>
      )}
    </main>
  );
}
