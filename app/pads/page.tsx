"use client";

import { useAutoMix } from "@/lib/client/useAutoMix";
import { SearchPicker } from "@/components/SearchPicker";
import { HeatmapBar } from "@/components/HeatmapBar";
import { FxPad } from "@/components/FxPad";

/**
 * FX pad deck: an endless auto-mixed set with the library's effects and beat
 * loops under your fingers - risers, impacts, horns, and drum loops that lock
 * to whatever is playing.
 */
export default function PadsPage() {
  const mix = useAutoMix();

  async function startSet() {
    await mix.start({
      clipLen: 0,
      useAi: true,
      quantize: true,
      quantizeBeats: 16,
      endless: true,
    });
    mix.prefetch(2);
  }

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-bold">FX Pad</h1>
        <p className="text-sm text-zinc-400">
          Play the set like an instrument: fire one-shots over the mix, layer a
          beat loop that snaps to the track&apos;s tempo and bar.
        </p>
      </header>

      <SearchPicker placeholder="Queue songs…" onPick={(t) => mix.addNext(t)} />

      {mix.queue.length > 0 && !mix.running && (
        <button
          onClick={startSet}
          className="rounded-lg bg-zinc-100 px-5 py-2 font-semibold text-zinc-900"
        >
          ▶ Start ({mix.queue.length} queued)
        </button>
      )}
      {mix.status && <p className="animate-pulse text-xs text-amber-400">{mix.status}</p>}

      {mix.running && mix.now && (
        <section className="space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <p className="min-w-0 truncate text-sm">
              <span className="font-semibold">{mix.now.meta.title}</span>
              <span className="text-zinc-400"> · {mix.now.meta.artist}</span>
            </p>
            <p className="shrink-0 text-xs text-cyan-400">
              {Math.round(mix.now.analysis.bpm)} BPM · {mix.now.analysis.camelot}
            </p>
          </div>
          <HeatmapBar meta={mix.now.meta} position={mix.position} />
          <div className="flex gap-2 text-xs">
            <button onClick={() => mix.hopNow()} className="rounded border border-zinc-700 px-3 py-1">
              next ⏭
            </button>
            <button onClick={() => mix.stop()} className="rounded border border-zinc-700 px-3 py-1">
              stop
            </button>
          </div>
        </section>
      )}

      <FxPad analysis={mix.now?.analysis ?? null} />
    </main>
  );
}
