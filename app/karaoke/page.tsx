"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { LyricLine, Track } from "@/lib/types";
import { getEngine, loadStem, loadTrack, type LoadedTrack } from "@/lib/client/dj";
import { SearchPicker } from "@/components/SearchPicker";
import { HeatmapBar } from "@/components/HeatmapBar";

async function fetchLyrics(t: Track): Promise<{ lines: LyricLine[]; synced: boolean }> {
  const clean = t.title.replace(/[([].*?[)\]]/g, "").trim();
  const res = await fetch(
    `/api/lyrics?track=${encodeURIComponent(clean)}&artist=${encodeURIComponent(t.artist)}&duration=${t.duration}`
  );
  if (!res.ok) return { lines: [], synced: false };
  return res.json();
}

export default function KaraokePage() {
  const [track, setTrack] = useState<Track | null>(null);
  const [loaded, setLoaded] = useState<LoadedTrack | null>(null);
  const [instrumental, setInstrumental] = useState<AudioBuffer | null>(null);
  const [stemStatus, setStemStatus] = useState<"idle" | "separating" | "ready" | "failed">("idle");
  const [stripVocals, setStripVocals] = useState(true);
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

  /** Kick off demucs separation for real karaoke (slow the first time). */
  function warmInstrumental(id: string) {
    setStemStatus("separating");
    loadStem(id, "instrumental")
      .then((buf) => {
        setInstrumental(buf);
        setStemStatus("ready");
      })
      .catch((e) => {
        setStemStatus("failed");
        setStatus(
          `⚠ vocal stripping failed (${e instanceof Error ? e.message : e}) - you can still sing over the original`
        );
      });
  }

  async function pick(t: Track) {
    setTrack(t);
    setLoaded(null);
    setLyrics([]);
    setInstrumental(null);
    setStemStatus("idle");
    setPlaying(false);
    getEngine().stop();
    warmInstrumental(t.id); // start the slow job first - it dominates the wait
    const [l, ly] = await Promise.all([
      loadTrack(t.id, setStatus).catch(() => null),
      fetchLyrics(t),
    ]);
    setLoaded(l);
    setLyrics(ly.lines);
    setSynced(ly.synced);
    setStatus(ly.lines.length ? "" : "no lyrics found - try another version");
  }

  /** The buffer we should be singing over right now. */
  const activeBuffer = (): AudioBuffer | null =>
    stripVocals && instrumental ? instrumental : (loaded?.buffer ?? null);

  async function play(fromSec = 0) {
    const buf = activeBuffer();
    if (!buf) return;
    await getEngine().resume();
    getEngine().startTrack(buf, fromSec);
    setPlaying(true);
  }

  /** Flip vocals on/off mid-song without losing the playhead. */
  function toggleVocals(next: boolean) {
    setStripVocals(next);
    if (!playing || !loaded) return;
    const pos = getEngine().position();
    const buf = next && instrumental ? instrumental : loaded.buffer;
    getEngine().startTrack(buf, pos);
  }

  const currentLine = lyrics.findLast?.((l) => l.time <= position) ?? null;

  useEffect(() => {
    if (!currentLine) return;
    lineRefs.current
      .get(currentLine.time)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [currentLine]);

  const waitingOnStem = stripVocals && stemStatus === "separating";

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Karaoke</h1>
        <p className="text-sm text-zinc-400">
          Real karaoke: the vocals are stripped off, the lyrics stay on screen,
          you are the singer. Want songs chained by their lyrics? That moved to{" "}
          <Link href="/lyricdj" className="text-cyan-400 underline">
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
          {stemStatus === "ready" && (
            <span className="ml-1 text-emerald-400">· vocals stripped ✓</span>
          )}
        </p>
      )}
      {waitingOnStem && (
        <p className="animate-pulse text-sm text-amber-400">
          🎛 stripping vocals (demucs)… first time on a song takes 1–4 min
        </p>
      )}
      {status && <p className="animate-pulse text-sm text-amber-400">{status}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => play(0)}
          disabled={!loaded || !lyrics.length || waitingOnStem}
          className="rounded-lg bg-cyan-600 px-5 py-2 font-semibold hover:bg-cyan-500 disabled:opacity-40"
        >
          {waitingOnStem ? "⏳ preparing karaoke…" : "▶ Sing"}
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
        <label
          className="flex items-center gap-2 text-sm text-zinc-300"
          title="Off = sing over the original track (also the fallback when stem separation is unavailable)"
        >
          <input
            type="checkbox"
            checked={stripVocals}
            onChange={(e) => toggleVocals(e.target.checked)}
            disabled={stemStatus === "failed"}
          />
          🎤 Strip vocals
        </label>
      </div>

      {playing && loaded && (
        <HeatmapBar
          meta={loaded.meta}
          position={position}
          onSeek={(sec) => play(sec)}
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
              onClick={() => play(l.time)}
              className={`cursor-pointer text-lg transition ${
                currentLine?.time === l.time
                  ? "scale-105 font-bold text-cyan-300"
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
