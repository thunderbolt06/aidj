"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { LyricLine, Track } from "@/lib/types";
import { getEngine, loadTrack, type LoadedTrack } from "@/lib/client/dj";
import { SearchPicker } from "@/components/SearchPicker";
import { HeatmapBar } from "@/components/HeatmapBar";

async function fetchLyrics(t: Track): Promise<{ lines: LyricLine[]; synced: boolean }> {
  const clean = t.title.replace(/[([].*?[)\]]/g, "").trim();
  const res = await fetch(
    `/api/lyrics?track=${encodeURIComponent(clean)}&artist=${encodeURIComponent(t.artist)}`
  );
  if (!res.ok) return { lines: [], synced: false };
  return res.json();
}

export default function KaraokePage() {
  const [track, setTrack] = useState<Track | null>(null);
  const [loaded, setLoaded] = useState<LoadedTrack | null>(null);
  const [lyrics, setLyrics] = useState<LyricLine[]>([]);
  const [synced, setSynced] = useState(false);
  const [status, setStatus] = useState("");
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const lineRefs = useRef<Map<number, HTMLLIElement>>(new Map());

  useEffect(() => {
    const id = setInterval(() => setPosition(getEngine().position()), 200);
    return () => {
      clearInterval(id);
      getEngine().stop();
    };
  }, []);

  async function pick(t: Track) {
    setTrack(t);
    setLoaded(null);
    setLyrics([]);
    const [l, ly] = await Promise.all([
      loadTrack(t.id, setStatus).catch(() => null),
      fetchLyrics(t),
    ]);
    setLoaded(l);
    setLyrics(ly.lines);
    setSynced(ly.synced);
    setStatus(ly.lines.length ? "" : "no lyrics found — try another version");
  }

  async function play() {
    if (!loaded) return;
    await getEngine().resume();
    getEngine().startTrack(loaded.buffer, 0);
    setPlaying(true);
  }

  const currentLine = lyrics.findLast?.((l) => l.time <= position) ?? null;

  useEffect(() => {
    if (!currentLine) return;
    lineRefs.current
      .get(currentLine.time)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [currentLine]);

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Karaoke</h1>
        <p className="text-sm text-zinc-400">
          Synced lyrics, tap any line to jump there. Want songs chained by
          their lyrics? That moved to{" "}
          <Link href="/lyricdj" className="text-fuchsia-400 underline">
            Lyric DJ
          </Link>
          .
        </p>
      </header>

      <SearchPicker placeholder="What are we singing?" onPick={pick} />
      {track && (
        <p className="truncate text-sm">
          {track.title}{" "}
          {synced && <span className="text-emerald-400">· synced ✓</span>}
        </p>
      )}
      {status && <p className="animate-pulse text-sm text-amber-400">{status}</p>}

      <div className="flex gap-3">
        <button
          onClick={play}
          disabled={!loaded || !lyrics.length}
          className="rounded-lg bg-fuchsia-600 px-5 py-2 font-semibold hover:bg-fuchsia-500 disabled:opacity-40"
        >
          ▶ Sing
        </button>
        <button
          onClick={() => {
            getEngine().stop();
            setPlaying(false);
          }}
          className="rounded-lg border border-zinc-700 px-4 py-2 text-sm"
        >
          Stop
        </button>
      </div>

      {playing && loaded && (
        <HeatmapBar
          meta={loaded.meta}
          position={position}
          onSeek={(sec) => getEngine().startTrack(loaded.buffer, sec)}
        />
      )}

      {playing && lyrics.length > 0 && (
        <ul className="max-h-96 space-y-2 overflow-y-auto rounded-xl border border-zinc-800 p-6 text-center">
          {lyrics.map((l) => (
            <li
              key={l.time}
              ref={(el) => {
                if (el) lineRefs.current.set(l.time, el);
              }}
              onClick={() => loaded && getEngine().startTrack(loaded.buffer, l.time)}
              className={`cursor-pointer text-lg transition ${
                currentLine?.time === l.time
                  ? "scale-105 font-bold text-fuchsia-300"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {l.text}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
