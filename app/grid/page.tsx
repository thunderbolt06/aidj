"use client";

import { useState } from "react";
import type { Track } from "@/lib/types";
import { loadTrack, searchTracks } from "@/lib/client/dj";
import { useAutoMix } from "@/lib/client/useAutoMix";
import { getSelectedLanguageLabels } from "@/lib/client/langPrefs";
import { getSongSource } from "@/lib/client/sourcePrefs";
import { SearchPicker } from "@/components/SearchPicker";
import { HeatmapBar } from "@/components/HeatmapBar";
import { Cover } from "@/components/Cover";

interface Suggestion {
  track: Track;
  tag: "safe" | "shift" | "wild";
}

const tagColor = {
  safe: "border-emerald-700",
  shift: "border-amber-600",
  wild: "border-cyan-600",
};

export default function GridPage() {
  const mix = useAutoMix();
  const [grid, setGrid] = useState<Suggestion[]>([]);
  const [busy, setBusy] = useState("");

  async function refreshGrid(current: Track) {
    setBusy("AI picking 9 next songs…");
    try {
      const res = await fetch("/api/ai/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current: `${current.title} - ${current.artist}`,
          languages: getSelectedLanguageLabels(),
          songSource: getSongSource(),
        }),
      });
      if (!res.ok) throw new Error("suggest failed - is ANTHROPIC_API_KEY set?");
      const { suggestions } = (await res.json()) as {
        suggestions: { query: string; tag: Suggestion["tag"] }[];
      };
      const found = await Promise.all(
        suggestions.map(async (s) => {
          const r = await searchTracks(s.query).catch(() => []);
          return r[0] ? { track: r[0], tag: s.tag } : null;
        })
      );
      const tiles = found.filter((s): s is Suggestion => !!s).slice(0, 9);
      setGrid(tiles);
      setBusy("");
      // preload every tile's audio in the background so taps are instant;
      // stagger so nine decodes don't land on the main thread at once
      tiles.forEach((s, i) => {
        setTimeout(() => loadTrack(s.track.id).catch(() => {}), i * 4000);
      });
    } catch (e) {
      setBusy(e instanceof Error ? e.message : "failed");
    }
  }

  async function startWith(t: Track) {
    mix.setQueue([t]);
    // user drives via the grid; quantize to 2 bars so taps drop on-beat fast
    await mix.start({ clipLen: 0, useAi: false, quantize: true, quantizeBeats: 8 });
    refreshGrid(t);
  }

  async function tap(s: Suggestion) {
    mix.setQueue((q) => [...q, s.track]);
    await mix.transitionTo(s.track);
    refreshGrid(s.track);
  }

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">9-Grid Next Song</h1>
        <p className="text-sm text-zinc-400">
          One song plays; nine doors out. Tap a tile to transition into it,
          green = safe, amber = energy shift, pink = wildcard.
        </p>
      </header>

      {!mix.now && <SearchPicker placeholder="Start with…" onPick={startWith} />}

      {mix.now && (
        <div className="rounded-xl border border-zinc-800 p-4 space-y-2">
          <div className="flex items-center gap-3">
            <Cover src={mix.now.meta.thumbnail} className="h-14 w-14 rounded-lg" />
            <p className="truncate font-semibold">{mix.now.meta.title}</p>
          </div>
          <HeatmapBar meta={mix.now.meta} position={mix.position} />
          {mix.lastPlan && (
            <p className="text-xs text-cyan-300">
              {mix.lastPlan.style} - {mix.lastPlan.reasoning}
            </p>
          )}
          <button
            onClick={() => {
              mix.stop();
              setGrid([]);
            }}
            className="rounded border border-zinc-700 px-3 py-1 text-xs"
          >
            stop
          </button>
        </div>
      )}

      {(busy || mix.status) && (
        <p className="animate-pulse text-sm text-amber-400">{busy || mix.status}</p>
      )}

      {grid.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {grid.map((s, i) => (
            <button
              key={`${s.track.id}-${i}`}
              onClick={() => tap(s)}
              className={`group relative aspect-square overflow-hidden rounded-lg border-2 ${tagColor[s.tag]}`}
            >
              <Cover
                src={s.track.thumbnail}
                className="h-full w-full transition group-hover:scale-105 group-hover:opacity-60"
              />
              <span className="absolute inset-x-0 bottom-0 bg-black/70 p-1 text-[10px] leading-tight line-clamp-2">
                {s.track.title}
              </span>
            </button>
          ))}
        </div>
      )}
    </main>
  );
}
