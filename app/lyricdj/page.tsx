"use client";

import { useEffect, useRef, useState } from "react";
import type { LyricLine, Track } from "@/lib/types";
import { getEngine, loadTrack, searchTracks, type LoadedTrack } from "@/lib/client/dj";
import { SearchPicker } from "@/components/SearchPicker";

interface ChainStop {
  track: Track;
  loaded: LoadedTrack;
  lyrics: LyricLine[];
  /** Lyric-matched handoff to the NEXT stop (null for the last song). */
  handoff: {
    outTime: number; // when to leave this song (at outLine)
    outLine: string;
    inTime: number; // where the next song enters (its matched line)
    inLine: string;
    reasoning: string;
  } | null;
}

async function fetchLyrics(t: Track): Promise<LyricLine[]> {
  const clean = t.title.replace(/[([].*?[)\]]/g, "").trim();
  const res = await fetch(
    `/api/lyrics?track=${encodeURIComponent(clean)}&artist=${encodeURIComponent(t.artist)}`
  );
  if (!res.ok) return [];
  const j = await res.json();
  return j.synced ? j.lines : [];
}

/**
 * Lyric DJ: the ENTIRE set is computed before playback — songs found, audio
 * loaded, lyric lines matched — then it just plays. (User feedback: no
 * thinking during the show.)
 */
export default function LyricDjPage() {
  const [seed, setSeed] = useState<Track | null>(null);
  const [chain, setChain] = useState<ChainStop[]>([]);
  const [status, setStatus] = useState("");
  const [building, setBuilding] = useState(false);
  const [playingIdx, setPlayingIdx] = useState(-1);
  const [position, setPosition] = useState(0);
  const playState = useRef({ idx: -1, fired: false });

  useEffect(() => {
    const id = setInterval(() => setPosition(getEngine().position()), 200);
    return () => {
      clearInterval(id);
      getEngine().stop();
    };
  }, []);

  async function build(t: Track) {
    setSeed(t);
    setChain([]);
    setBuilding(true);
    try {
      setStatus("loading seed song + lyrics…");
      const [seedLoaded, seedLyrics] = await Promise.all([
        loadTrack(t.id),
        fetchLyrics(t),
      ]);
      if (!seedLyrics.length)
        throw new Error("no synced lyrics for the seed — try another song");

      setStatus("AI building the lyric chain…");
      const chainRes = await fetch("/api/ai/lyricchain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: t.title, lines: seedLyrics }),
      });
      if (!chainRes.ok) throw new Error("chain failed — ANTHROPIC_API_KEY?");
      const { chain: picks } = (await chainRes.json()) as {
        chain: { query: string; connection: string }[];
      };

      setStatus("finding + loading every song and its lyrics…");
      const stops: { track: Track; loaded: LoadedTrack; lyrics: LyricLine[] }[] = [
        { track: t, loaded: seedLoaded, lyrics: seedLyrics },
      ];
      for (const pick of picks) {
        const results = await searchTracks(pick.query).catch(() => []);
        const found = results[0];
        if (!found) continue;
        try {
          const [loaded, lyrics] = await Promise.all([
            loadTrack(found.id, setStatus),
            fetchLyrics(found),
          ]);
          if (lyrics.length) stops.push({ track: found, loaded, lyrics });
        } catch {
          /* skip unloadable songs */
        }
      }
      if (stops.length < 2) throw new Error("couldn't assemble a chain with lyrics");

      setStatus("matching lyric lines for every transition…");
      const matches = await Promise.all(
        stops.slice(0, -1).map(async (stop, i) => {
          const next = stops[i + 1];
          const res = await fetch("/api/ai/lyricmatch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              a: { title: stop.track.title, lines: stop.lyrics },
              b: { title: next.track.title, lines: next.lyrics },
            }),
          });
          if (!res.ok) return null;
          return res.json();
        })
      );

      setChain(
        stops.map((stop, i) => ({
          ...stop,
          handoff: matches[i]
            ? {
                outTime: matches[i].aTime,
                outLine: matches[i].aLine,
                inTime: matches[i].bTime,
                inLine: matches[i].bLine,
                reasoning: matches[i].reasoning,
              }
            : null,
        }))
      );
      setStatus("");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "build failed");
    } finally {
      setBuilding(false);
    }
  }

  async function play() {
    if (!chain.length) return;
    await getEngine().resume();
    const first = chain[0];
    // start a little before the matched out-line so you hear the connection coming
    const startAt = first.handoff
      ? Math.max(0, first.handoff.outTime - 30)
      : Math.max(0, (first.loaded.meta.famousStart ?? 30) - 10);
    getEngine().startTrack(first.loaded.buffer, startAt);
    playState.current = { idx: 0, fired: false };
    setPlayingIdx(0);
  }

  // watch the playhead; fire each pre-computed handoff at its lyric line
  useEffect(() => {
    const ps = playState.current;
    if (ps.idx < 0 || ps.fired) return;
    const stop = chain[ps.idx];
    const next = chain[ps.idx + 1];
    if (!stop?.handoff || !next) return;
    if (position >= stop.handoff.outTime - 0.5) {
      ps.fired = true;
      getEngine().onTransitionEnd = () => {
        playState.current = { idx: ps.idx + 1, fired: false };
        setPlayingIdx(ps.idx + 1);
      };
      getEngine().transition(next.loaded.buffer, {
        style: "crossfade",
        outPoint: position,
        inPoint: Math.max(0, stop.handoff.inTime - 3),
        duration: 3,
        beatMatch: false,
        reasoning: stop.handoff.reasoning,
      });
    }
  }, [position, chain]);

  const active = chain[playingIdx];
  const currentLine =
    active?.lyrics.findLast?.((l) => l.time <= position) ?? null;

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Lyric DJ</h1>
        <p className="text-sm text-zinc-400">
          Pick a seed song. The AI builds a whole setlist where every
          transition lands on lyric lines that connect — all computed before a
          single note plays.
        </p>
      </header>

      {!chain.length && <SearchPicker placeholder="Seed song…" onPick={build} />}
      {seed && building && (
        <p className="animate-pulse text-sm text-amber-400">{status}</p>
      )}
      {!building && status && <p className="text-sm text-red-400">{status}</p>}

      {chain.length > 0 && (
        <>
          <ol className="space-y-3">
            {chain.map((stop, i) => (
              <li key={stop.track.id}>
                <div
                  className={`rounded-xl border p-3 text-sm ${
                    i === playingIdx
                      ? "border-fuchsia-600 bg-fuchsia-950/30"
                      : "border-zinc-800"
                  }`}
                >
                  <p className="truncate font-semibold">
                    {i + 1}. {stop.track.title}
                  </p>
                  {stop.handoff && (
                    <p className="mt-1 text-xs text-zinc-400">
                      exits on{" "}
                      <span className="text-fuchsia-300">
                        “{stop.handoff.outLine}”
                      </span>{" "}
                      → next enters on{" "}
                      <span className="text-fuchsia-300">
                        “{stop.handoff.inLine}”
                      </span>
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <div className="flex gap-3">
            <button
              onClick={play}
              disabled={playingIdx >= 0}
              className="rounded-lg bg-fuchsia-600 px-5 py-2 font-semibold hover:bg-fuchsia-500 disabled:opacity-40"
            >
              ▶ Play the set
            </button>
            <button
              onClick={() => {
                getEngine().stop();
                setPlayingIdx(-1);
                playState.current = { idx: -1, fired: false };
              }}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm"
            >
              Stop
            </button>
            <button
              onClick={() => {
                getEngine().stop();
                setChain([]);
                setSeed(null);
                setPlayingIdx(-1);
                playState.current = { idx: -1, fired: false };
              }}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm"
            >
              New chain
            </button>
          </div>
          {active && currentLine && (
            <p className="rounded-xl border border-zinc-800 p-6 text-center text-xl font-bold text-fuchsia-200">
              {currentLine.text}
            </p>
          )}
        </>
      )}
    </main>
  );
}
