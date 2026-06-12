"use client";

import { useState } from "react";
import type { Track } from "@/lib/types";
import { getEngine, loadTrack, type LoadedTrack } from "@/lib/client/dj";
import { SearchPicker } from "@/components/SearchPicker";

/**
 * Mashup = song A's famous section as the low-end bed + song B's famous
 * section band-passed on top, tempo-matched to A. No stem separation —
 * EQ carving only, so results vary from "magic" to "soup". That's the experiment.
 */
export default function MashupPage() {
  const [a, setA] = useState<LoadedTrack | null>(null);
  const [b, setB] = useState<LoadedTrack | null>(null);
  const [status, setStatus] = useState("");
  const [playing, setPlaying] = useState(false);
  const [topperGain, setTopperGain] = useState(0.9);

  async function pick(which: "A" | "B", t: Track) {
    const set = which === "A" ? setA : setB;
    set(null);
    try {
      set(await loadTrack(t.id, setStatus));
    } catch (e) {
      setStatus(`load failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  const rate = a && b ? a.analysis.bpm / b.analysis.bpm : 1;
  const rateOk = rate > 0.85 && rate < 1.18;

  async function play() {
    if (!a || !b) return;
    await getEngine().resume();
    getEngine().playMashup(a.buffer, b.buffer, {
      bedOffset: Math.max(0, (a.meta.famousStart ?? 40) - 8),
      topperOffset: Math.max(0, (b.meta.famousStart ?? 40) - 8),
      rate: rateOk ? rate : 1,
      topperGain,
    });
    setPlaying(true);
  }

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Mashup Generator</h1>
        <p className="text-sm text-zinc-400">
          Song A becomes the bed, song B rides on top — tempo-matched, EQ-carved,
          both starting at their famous parts.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="mb-1 text-xs uppercase text-zinc-500">Bed (groove/bass)</p>
          <SearchPicker onPick={(t) => pick("A", t)} />
          {a && (
            <p className="mt-1 truncate text-sm">
              {a.meta.title}{" "}
              <span className="text-zinc-500">· {a.analysis.bpm} BPM</span>
            </p>
          )}
        </div>
        <div>
          <p className="mb-1 text-xs uppercase text-zinc-500">Topper (melody/vocal)</p>
          <SearchPicker onPick={(t) => pick("B", t)} />
          {b && (
            <p className="mt-1 truncate text-sm">
              {b.meta.title}{" "}
              <span className="text-zinc-500">· {b.analysis.bpm} BPM</span>
            </p>
          )}
        </div>
      </div>

      {a && b && (
        <p className="text-sm">
          tempo match: ×{rate.toFixed(3)}{" "}
          {rateOk ? (
            <span className="text-emerald-400">in range, B will be stretched</span>
          ) : (
            <span className="text-amber-400">
              too far apart — playing both natural (pick closer BPMs for best results)
            </span>
          )}
        </p>
      )}

      {status && <p className="animate-pulse text-sm text-amber-400">{status}</p>}

      <div className="flex flex-wrap items-center gap-4">
        <button
          onClick={play}
          disabled={!a || !b}
          className="rounded-lg bg-fuchsia-600 px-5 py-2 font-semibold hover:bg-fuchsia-500 disabled:opacity-40"
        >
          🌀 Mash
        </button>
        {playing && (
          <>
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              topper
              <input
                type="range"
                min={0}
                max={1.2}
                step={0.05}
                value={topperGain}
                onChange={(e) => {
                  const v = +e.target.value;
                  setTopperGain(v);
                  getEngine().setTopperGain(v);
                }}
              />
            </label>
            <button
              onClick={() => {
                getEngine().stop();
                setPlaying(false);
              }}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm"
            >
              Stop
            </button>
          </>
        )}
      </div>
    </main>
  );
}
