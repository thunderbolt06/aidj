"use client";

import { useEffect, useRef, useState } from "react";
import type { LyricLine, Track } from "@/lib/types";
import { getEngine, loadTrack, type LoadedTrack } from "@/lib/client/dj";
import { SearchPicker } from "@/components/SearchPicker";

interface LyricMatch {
  aTime: number;
  aLine: string;
  bTime: number;
  bLine: string;
  reasoning: string;
}

async function fetchLyrics(t: Track): Promise<LyricLine[]> {
  // strip "(Official Video)" noise for better lyric search hits
  const clean = t.title.replace(/[([].*?[)\]]/g, "").trim();
  const res = await fetch(
    `/api/lyrics?track=${encodeURIComponent(clean)}&artist=${encodeURIComponent(t.artist)}`
  );
  if (!res.ok) return [];
  return (await res.json()).lines ?? [];
}

export default function KaraokePage() {
  const [a, setATrack] = useState<{ track: Track; loaded?: LoadedTrack; lyrics?: LyricLine[] } | null>(null);
  const [b, setBTrack] = useState<{ track: Track; loaded?: LoadedTrack; lyrics?: LyricLine[] } | null>(null);
  const [status, setStatus] = useState("");
  const [position, setPosition] = useState(0);
  const [playingSong, setPlayingSong] = useState<"A" | "B" | null>(null);
  const [match, setMatch] = useState<LyricMatch | null>(null);
  const transitionArmed = useRef<LyricMatch | null>(null);
  const lineRefs = useRef<Map<number, HTMLLIElement>>(new Map());

  useEffect(() => {
    const id = setInterval(() => setPosition(getEngine().position()), 200);
    return () => clearInterval(id);
  }, []);

  async function pick(which: "A" | "B", t: Track) {
    const set = which === "A" ? setATrack : setBTrack;
    set({ track: t });
    const [loaded, lyrics] = await Promise.all([
      loadTrack(t.id, setStatus).catch(() => undefined),
      fetchLyrics(t),
    ]);
    set({ track: t, loaded, lyrics });
    if (!lyrics.length) setStatus(`no lyrics found for ${t.title}`);
  }

  async function play() {
    if (!a?.loaded) return;
    await getEngine().resume();
    getEngine().startTrack(a.loaded.buffer, 0);
    setPlayingSong("A");
  }

  async function lyricTransition() {
    if (!a?.lyrics?.length || !b?.lyrics?.length || !b.loaded) {
      setStatus("need synced lyrics on both songs");
      return;
    }
    setStatus("AI matching lyric lines…");
    const res = await fetch("/api/ai/lyricmatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        a: { title: a.track.title, lines: a.lyrics },
        b: { title: b.track.title, lines: b.lyrics },
      }),
    });
    if (!res.ok) {
      setStatus("lyric match failed — is ANTHROPIC_API_KEY set?");
      return;
    }
    const m: LyricMatch = await res.json();
    setMatch(m);
    transitionArmed.current = m;
    setStatus(`armed: will transition at "${m.aLine}" (${Math.round(m.aTime)}s)`);
  }

  // fire the armed transition when the playhead reaches the matched A line
  useEffect(() => {
    const m = transitionArmed.current;
    if (!m || playingSong !== "A" || !a?.loaded || !b?.loaded) return;
    if (position >= m.aTime - 1) {
      transitionArmed.current = null;
      getEngine().onTransitionEnd = () => setPlayingSong("B");
      getEngine().transition(b.loaded.buffer, {
        style: "crossfade",
        outPoint: position,
        inPoint: Math.max(0, m.bTime - 4),
        duration: 4,
        beatMatch: false,
        reasoning: m.reasoning,
      });
      setStatus("");
    }
  }, [position, playingSong, a, b]);

  const active = playingSong === "B" ? b : a;
  const lyrics = active?.lyrics ?? [];
  const currentLine = lyrics.findLast?.((l) => l.time <= position) ?? null;

  // auto-scroll the highlighted line into view
  useEffect(() => {
    if (!currentLine) return;
    lineRefs.current
      .get(currentLine.time)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [currentLine]);

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Karaoke + Lyric Transitions</h1>
        <p className="text-sm text-zinc-400">
          Synced lyrics, tap a line to jump. Add a song B and the AI finds two
          lyric lines that connect the songs — and transitions right there.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="mb-1 text-xs uppercase text-zinc-500">Song A</p>
          <SearchPicker onPick={(t) => pick("A", t)} />
          {a && <p className="mt-1 truncate text-sm">{a.track.title}</p>}
        </div>
        <div>
          <p className="mb-1 text-xs uppercase text-zinc-500">Song B (optional)</p>
          <SearchPicker onPick={(t) => pick("B", t)} />
          {b && <p className="mt-1 truncate text-sm">{b.track.title}</p>}
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <button
          onClick={play}
          disabled={!a?.loaded}
          className="rounded-lg bg-zinc-100 px-5 py-2 font-semibold text-zinc-900 disabled:opacity-40"
        >
          ▶ Sing
        </button>
        <button
          onClick={lyricTransition}
          disabled={!a?.lyrics?.length || !b?.lyrics?.length || !b?.loaded}
          className="rounded-lg bg-fuchsia-600 px-5 py-2 font-semibold hover:bg-fuchsia-500 disabled:opacity-40"
        >
          ✨ Lyric transition A→B
        </button>
        <button
          onClick={() => {
            getEngine().stop();
            setPlayingSong(null);
          }}
          className="rounded-lg border border-zinc-700 px-4 py-2 text-sm"
        >
          Stop
        </button>
      </div>

      {status && <p className="animate-pulse text-sm text-amber-400">{status}</p>}

      {match && (
        <div className="rounded-xl border border-fuchsia-900/50 bg-fuchsia-950/20 p-4 text-sm">
          <p>
            “{match.aLine}” <span className="text-fuchsia-400">→</span> “
            {match.bLine}”
          </p>
          <p className="mt-1 text-xs text-zinc-400">{match.reasoning}</p>
        </div>
      )}

      {playingSong && lyrics.length > 0 && (
        <ul className="max-h-96 space-y-2 overflow-y-auto rounded-xl border border-zinc-800 p-6 text-center">
          {lyrics.map((l) => (
            <li
              key={l.time}
              ref={(el) => {
                if (el) lineRefs.current.set(l.time, el);
              }}
              onClick={() => {
                if (active?.loaded)
                  getEngine().startTrack(active.loaded.buffer, l.time);
              }}
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
