"use client";

import { useEffect, useRef, useState } from "react";
import type { LyricLine, Track } from "@/lib/types";
import { getEngine, loadTrack, searchTracks, type LoadedTrack } from "@/lib/client/dj";
import {
  audioBufferToWav,
  renderWordplayClip,
  sliceAudioBuffer,
} from "@/lib/audio/render";
import { SearchPicker } from "@/components/SearchPicker";

interface ChainStop {
  track: Track;
  loaded: LoadedTrack;
  lyrics: LyricLine[];
  /** Lyric-matched handoff to the NEXT stop (null for the last song). */
  handoff: {
    outTime: number; // when A's matched line starts
    outLineEnd: number; // when A's matched line ends — the cut moment
    outLine: string;
    inTime: number; // where the next song enters (its matched line)
    inLine: string;
    sharedWord: string | null; // exact word both songs sing (null = semantic match)
    aWordTime: number; // moment A sings the word — the loop point
    aWordEnd: number; // word release in A — sets the natural loop length
    bWordTime: number; // moment B sings it — the drop point
    aligned: boolean; // true = Whisper-verified transients, false = estimate
    reasoning: string;
  } | null;
}

async function fetchLyrics(t: Track): Promise<LyricLine[]> {
  // server does the heavy title/artist cleaning; duration disambiguates covers
  const res = await fetch(
    `/api/lyrics?track=${encodeURIComponent(t.title)}&artist=${encodeURIComponent(
      t.artist
    )}&duration=${t.duration || ""}`
  );
  if (!res.ok) return [];
  const j = await res.json();
  return j.synced ? j.lines : [];
}

/** End of the lyric line starting at `time` = start of the following line. */
function lineEnd(lyrics: LyricLine[], time: number): number {
  const idx = lyrics.findIndex((l) => Math.abs(l.time - time) < 0.01);
  const next = idx >= 0 ? lyrics[idx + 1] : undefined;
  const end = next ? next.time : time + 4;
  return Math.min(end, time + 8); // a "line" longer than 8s is an instrumental gap
}

/**
 * Whisper-verify where the word is actually sung: transcribe the window
 * around the lyric line with word timestamps and pick the occurrence closest
 * to the estimate. Returns null when Whisper can't hear the word.
 */
async function alignWord(
  videoId: string,
  lineTime: number,
  lineEndTime: number,
  word: string,
  estimate: number
): Promise<{ start: number; end: number } | null> {
  try {
    const windowStart = Math.max(0, lineTime - 2);
    const res = await fetch("/api/align", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: videoId,
        windowStart,
        windowDur: Math.min(30, lineEndTime - windowStart + 3),
        word,
      }),
    });
    if (!res.ok) return null;
    const { hits } = (await res.json()) as {
      hits: { start: number; end: number }[];
    };
    if (!hits?.length) return null;
    return hits.reduce((best, h) =>
      Math.abs(h.start - estimate) < Math.abs(best.start - estimate) ? h : best
    );
  } catch {
    return null;
  }
}

/**
 * Estimate when a specific word is sung within its line. LRC lyrics only
 * timestamp lines, so we place the word proportionally by its position —
 * crude, but close enough to catch the word in a one-beat loop.
 */
function estimateWordTime(
  lyrics: LyricLine[],
  lineTime: number,
  lineText: string,
  word: string
): number {
  const end = lineEnd(lyrics, lineTime);
  const words = lineText.split(/\s+/).filter(Boolean);
  const target = word.toLowerCase();
  const wIdx = words.findIndex((w) =>
    w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "").startsWith(target)
  );
  if (wIdx < 0) return lineTime;
  // vocals typically start right at the line timestamp; spread words evenly
  return lineTime + (wIdx / words.length) * (end - lineTime) * 0.9;
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
  const [throwMode, setThrowMode] = useState(false);
  const [exporting, setExporting] = useState<number | null>(null);
  const [exportMsg, setExportMsg] = useState("");
  const playState = useRef({ idx: -1, fired: false });

  useEffect(() => {
    const id = setInterval(() => setPosition(getEngine().position()), 100);
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
        body: JSON.stringify({
          title: t.title,
          lines: seedLyrics,
          famousStart: seedLoaded.meta.famousStart,
        }),
      });
      if (!chainRes.ok) throw new Error("chain failed — ANTHROPIC_API_KEY?");
      const { chain: picks } = (await chainRes.json()) as {
        chain: { query: string; sharedWord: string | null; connection: string }[];
      };

      setStatus("finding + loading every song and its lyrics…");
      const candidates = await Promise.all(
        picks.map(async (pick) => {
          try {
            // "official audio" uploads have no cinematic intro, so lrclib
            // timestamps actually line up with the audio we play
            const results = await searchTracks(`${pick.query} official audio`)
              .catch(() => [])
              .then((r) => (r.length ? r : searchTracks(pick.query).catch(() => [])));
            const found = results[0];
            if (!found) return null;
            const [loaded, lyrics] = await Promise.all([
              loadTrack(found.id),
              fetchLyrics(found),
            ]);
            return lyrics.length
              ? { track: found, loaded, lyrics, preferWord: pick.sharedWord }
              : null;
          } catch {
            return null; // skip unloadable songs
          }
        })
      );
      const stops: {
        track: Track;
        loaded: LoadedTrack;
        lyrics: LyricLine[];
        preferWord?: string | null;
      }[] = [
        { track: t, loaded: seedLoaded, lyrics: seedLyrics },
        ...candidates.filter((c): c is NonNullable<typeof c> => c !== null),
      ];
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
              bFamous: next.loaded.meta.famousStart,
              // prefer handoff words sung in A's hook — that's the part
              // people recognize and sing along to
              aFamous: stop.loaded.meta.famousStart,
              // the chain AI picked this song FOR this word — try it first
              preferWord: next.preferWord ?? null,
            }),
          });
          if (!res.ok) return null;
          return res.json();
        })
      );

      // Whisper pass: replace proportional estimates with the REAL sung
      // transients of every handoff word (both songs, in parallel)
      setStatus("Whisper-aligning the exact words in the audio…");
      const handoffs = await Promise.all(
        matches.map(async (m, i) => {
          if (!m) return null;
          const stop = stops[i];
          const nxt = stops[i + 1];
          const base = {
            outTime: m.aTime,
            outLineEnd: lineEnd(stop.lyrics, m.aTime),
            outLine: m.aLine,
            inTime: m.bTime,
            inLine: m.bLine,
            sharedWord: m.sharedWord ?? null,
            reasoning: m.reasoning,
          };
          if (!m.sharedWord) {
            return {
              ...base,
              aWordTime: m.aTime,
              aWordEnd: m.aTime + 0.5,
              bWordTime: m.bTime,
              aligned: false,
            };
          }
          const aEst = estimateWordTime(stop.lyrics, m.aTime, m.aLine, m.sharedWord);
          const bEst = estimateWordTime(nxt.lyrics, m.bTime, m.bLine, m.sharedWord);
          const [aHit, bHit] = await Promise.all([
            alignWord(
              stop.track.id,
              m.aTime,
              lineEnd(stop.lyrics, m.aTime),
              m.sharedWord,
              aEst
            ),
            alignWord(
              nxt.track.id,
              m.bTime,
              lineEnd(nxt.lyrics, m.bTime),
              m.sharedWord,
              bEst
            ),
          ]);
          return {
            ...base,
            aWordTime: aHit?.start ?? aEst,
            aWordEnd: aHit?.end ?? aEst + 0.45,
            bWordTime: bHit?.start ?? bEst,
            aligned: !!(aHit && bHit),
          };
        })
      );

      setChain(
        stops.map((stop, i) => ({
          ...stop,
          handoff: handoffs[i] ?? null,
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

  // Watch the playhead and fire each pre-computed handoff.
  // Exact shared word → DJ word edit: the word stutters in a beat-synced loop
  // (music looping with it), echo rising, then B drops ON its own word.
  // Semantic match → A's line plays out fully into a fast crossfade.
  useEffect(() => {
    const ps = playState.current;
    if (ps.idx < 0 || ps.fired) return;
    const stop = chain[ps.idx];
    const next = chain[ps.idx + 1];
    if (!stop?.handoff || !next) return;
    const h = stop.handoff;

    const advance = () => {
      playState.current = { idx: ps.idx + 1, fired: false };
      setPlayingIdx(ps.idx + 1);
      setStatus("");
    };

    if (h.sharedWord) {
      if (position >= h.aWordTime - 0.05) {
        ps.fired = true;
        getEngine().onTransitionEnd = advance;
        if (throwMode) {
          // vocal-throw: B cuts in and A's word echoes over its intro
          const wordBuffer = sliceAudioBuffer(
            getEngine().ctx,
            stop.loaded.buffer,
            h.aWordTime,
            Math.min(1.2, Math.max(0.35, h.aWordEnd - h.aWordTime + 0.35))
          );
          setStatus(`✨ throwing “${h.sharedWord}” over the drop…`);
          getEngine().vocalThrow(next.loaded.buffer, {
            wordBuffer,
            inPoint: h.bWordTime,
            analyses: { from: stop.loaded.analysis, to: next.loaded.analysis },
            quantizeBeats: 16,
          });
        } else {
          // loop the WORD itself: its real duration snapped up to the nearest
          // beat subdivision so the stutter stays in the groove
          const beat = 60 / Math.max(stop.loaded.analysis.bpm, 60);
          const wordDur = Math.max(0.12, h.aWordEnd - h.aWordTime);
          const loopLen =
            [beat / 4, beat / 2, beat, beat * 2].find((d) => d >= wordDur * 0.85) ??
            beat * 2;
          setStatus(
            `✨ looping “${h.sharedWord}” ×4${h.aligned ? " (whisper-aligned)" : ""}…`
          );
          getEngine().stutterTransition(next.loaded.buffer, {
            loopStart: h.aWordTime,
            loopLen: Math.min(loopLen, 0.9),
            repeats: 4,
            inPoint: h.bWordTime,
          });
        }
      }
    } else {
      const FADE = 0.8;
      if (position >= h.outLineEnd - FADE - 0.1) {
        ps.fired = true;
        getEngine().onTransitionEnd = advance;
        getEngine().transition(next.loaded.buffer, {
          style: "crossfade",
          outPoint: position,
          inPoint: Math.max(0, h.inTime - FADE),
          duration: FADE,
          beatMatch: false,
          reasoning: h.reasoning,
        });
      }
    }
  }, [position, chain, throwMode]);

  /**
   * Export a single handoff as a standalone shareable clip (the "50 Cent →
   * Usher Shorty" format): A leads into the word, it stutters, B drops on the
   * same word — rendered to a vertical mp4 with the trigger word captioned.
   */
  async function exportHandoff(i: number) {
    const stop = chain[i];
    const next = chain[i + 1];
    const h = stop?.handoff;
    if (!next || !h || !h.sharedWord) return;
    setExporting(i);
    setExportMsg("rendering the edit…");
    try {
      const buf = await renderWordplayClip(
        { buffer: stop.loaded.buffer, bpm: stop.loaded.analysis.bpm },
        { buffer: next.loaded.buffer, bpm: next.loaded.analysis.bpm },
        { aWordTime: h.aWordTime, aWordEnd: h.aWordEnd, bWordTime: h.bWordTime }
      );
      const wav = audioBufferToWav(buf);
      setExportMsg("building the vertical video…");
      const meta = {
        clips: [
          { image: stop.track.thumbnail, duration: buf.duration * 0.62 },
          { image: next.track.thumbnail, duration: buf.duration * 0.45 },
        ],
        caption: h.sharedWord,
      };
      const res = await fetch(
        `/api/video?meta=${encodeURIComponent(JSON.stringify(meta))}`,
        { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav }
      );
      const a = document.createElement("a");
      if (res.ok) {
        a.href = URL.createObjectURL(await res.blob());
        a.download = `wordplay-${h.sharedWord}.mp4`;
      } else {
        a.href = URL.createObjectURL(wav);
        a.download = `wordplay-${h.sharedWord}.wav`;
        setExportMsg("video failed — downloaded audio instead");
      }
      a.click();
      setExportMsg("");
    } catch (e) {
      setExportMsg(e instanceof Error ? e.message : "export failed");
    } finally {
      setExporting(null);
    }
  }

  const active = chain[playingIdx];
  const currentLine =
    active?.lyrics.findLast?.((l) => l.time <= position) ?? null;

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Lyric DJ</h1>
        <p className="text-sm text-zinc-400">
          Pick a seed song. The AI builds a whole setlist where each song hands
          an <b>exact sung word</b> to the next — all computed before a single
          note plays.
        </p>
      </header>

      {!chain.length && <SearchPicker placeholder="Seed song…" onPick={build} />}
      {seed && building && (
        <p className="animate-pulse text-sm text-amber-400">{status}</p>
      )}
      {!building && status && (
        <p
          className={`text-sm ${
            playingIdx >= 0 ? "font-semibold text-fuchsia-300" : "text-red-400"
          }`}
        >
          {status}
        </p>
      )}

      {chain.length > 0 && (
        <>
          <ol className="space-y-3">
            {chain.map((stop, i) => (
              <li key={`${stop.track.id}-${i}`}>
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
                      {stop.handoff.sharedWord ? (
                        <>
                          hands off the word{" "}
                          <span className="rounded bg-fuchsia-900/60 px-1 font-bold text-fuchsia-200">
                            {stop.handoff.sharedWord}
                          </span>
                          {stop.handoff.aligned && (
                            <span
                              className="ml-1 text-emerald-400"
                              title="word position verified in the audio by Whisper"
                            >
                              ✓
                            </span>
                          )}{" "}
                          —{" "}
                        </>
                      ) : null}
                      <span className="text-fuchsia-300">
                        “{stop.handoff.outLine}”
                      </span>{" "}
                      →{" "}
                      <span className="text-fuchsia-300">
                        “{stop.handoff.inLine}”
                      </span>
                    </p>
                  )}
                  {stop.handoff?.sharedWord && (
                    <button
                      onClick={() => exportHandoff(i)}
                      disabled={exporting !== null}
                      className="mt-2 rounded-lg border border-emerald-700 px-3 py-1 text-xs text-emerald-300 hover:bg-emerald-950/40 disabled:opacity-40"
                    >
                      {exporting === i ? "rendering…" : "🎬 Export this edit"}
                    </button>
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
            <label
              className="flex items-center gap-2 text-sm text-zinc-300"
              title="Throw the word over the drop (echoed) instead of stuttering it"
            >
              <input
                type="checkbox"
                checked={throwMode}
                onChange={(e) => setThrowMode(e.target.checked)}
              />
              🎤 Vocal-throw
            </label>
          </div>
          {exportMsg && (
            <p className="animate-pulse text-xs text-amber-400">{exportMsg}</p>
          )}
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
