"use client";

import { useEffect, useRef, useState } from "react";
import type { Track, TrackAnalysis } from "@/lib/types";
import { getEngine, loadElement, searchTracks } from "@/lib/client/dj";

/**
 * FX pad: every effect and beat loop in the library as a tappable tile.
 * Buffers are decoded up front, so a tap is sample-accurate - no fetch, no
 * "loading". Loops are tempo-matched to the playing track and start on its
 * next bar; tap again to stop. Pass the current track's analysis to sync.
 */
export function FxPad({ analysis }: { analysis?: TrackAnalysis | null }) {
  const [fx, setFx] = useState<Track[]>([]);
  const [loops, setLoops] = useState<Track[]>([]);
  const [ready, setReady] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const stops = useRef(
    new Map<string, { stop: () => void; setRate: (r: number) => void; bpm?: number }>()
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [a, b] = await Promise.all([
          searchTracks("", { kind: "sfx", limit: 60 }),
          searchTracks("", { kind: "loop", limit: 60 }),
        ]);
        if (!alive) return;
        setFx(a);
        setLoops(b);
        for (const t of [...a, ...b])
          loadElement(t.id)
            .then(() => alive && setReady((r) => new Set(r).add(t.id)))
            .catch(() => {});
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "FX unavailable");
      }
    })();
    const running = stops.current;
    return () => {
      alive = false;
      running.forEach((h) => h.stop());
      running.clear();
    };
  }, []);

  // the set moved to a track with a different tempo: running loops follow it
  const trackBpm = analysis?.bpm ?? 0;
  useEffect(() => {
    if (trackBpm <= 0) return;
    stops.current.forEach((h) => h.bpm && h.setRate(trackBpm / h.bpm));
  }, [trackBpm]);

  async function fire(t: Track) {
    const engine = getEngine();
    await engine.resume();
    engine.playElement(await loadElement(t.id), { gain: 0.9 });
  }

  async function toggleLoop(t: Track) {
    const running = stops.current.get(t.id);
    if (running) {
      running.stop();
      stops.current.delete(t.id);
      setActive((s) => {
        const n = new Set(s);
        n.delete(t.id);
        return n;
      });
      return;
    }
    const engine = getEngine();
    await engine.resume();
    const buffer = await loadElement(t.id);
    // stretch the loop onto the track's tempo and land it on the next bar
    const synced = !!analysis && !!t.bpm && analysis.bpm > 0;
    const handle = engine.playElement(buffer, {
      loop: true,
      gain: 0.7,
      rate: synced ? analysis!.bpm / t.bpm! : 1,
      when: synced ? engine.nextGridTime(analysis!, 4) : 0,
    });
    stops.current.set(t.id, { ...handle, bpm: t.bpm });
    setActive((s) => new Set(s).add(t.id));
  }

  if (error) return <p className="text-xs text-red-400">{error}</p>;
  if (!fx.length && !loops.length)
    return (
      <p className="text-xs text-zinc-500">
        No FX in the library yet - run <code>npm run library:kit</code> then{" "}
        <code>npm run library:ingest</code>.
      </p>
    );

  // nearest tempos first, so the loops that need the least stretching lead
  const sortedLoops = analysis
    ? [...loops].sort(
        (a, b) =>
          Math.abs((a.bpm ?? 0) - analysis.bpm) - Math.abs((b.bpm ?? 0) - analysis.bpm)
      )
    : loops;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="mb-2 text-[10px] uppercase tracking-widest text-zinc-500">
          One-shots
        </h3>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {fx.map((t) => (
            <button
              key={t.id}
              onPointerDown={() => fire(t)}
              disabled={!ready.has(t.id)}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-3 text-xs transition active:scale-95 active:border-cyan-500 active:bg-cyan-950/50 disabled:opacity-40"
            >
              {t.title}
            </button>
          ))}
        </div>
      </div>
      <div>
        <h3 className="mb-2 text-[10px] uppercase tracking-widest text-zinc-500">
          Beat loops{analysis ? ` - synced to ${Math.round(analysis.bpm)} BPM` : ""}
        </h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {sortedLoops.map((t) => (
            <button
              key={t.id}
              onClick={() => toggleLoop(t)}
              disabled={!ready.has(t.id)}
              className={`rounded-lg border px-2 py-3 text-xs transition active:scale-95 disabled:opacity-40 ${
                active.has(t.id)
                  ? "animate-pulse border-emerald-500 bg-emerald-950/50 text-emerald-200"
                  : "border-zinc-700 bg-zinc-900"
              }`}
            >
              {t.title}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
