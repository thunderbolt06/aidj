"use client";

import { useState } from "react";
import type { TransitionStyle } from "@/lib/types";
import { useAutoMix } from "@/lib/client/useAutoMix";
import { SearchPicker } from "@/components/SearchPicker";
import { HeatmapBar } from "@/components/HeatmapBar";

const TRICKS: { value: TransitionStyle | ""; label: string }[] = [
  { value: "", label: "🤖 AI picks the trick" },
  { value: "loop_roll", label: "🔂 Loop roll (stutter → slam)" },
  { value: "brake", label: "🛑 Vinyl brake" },
  { value: "riser", label: "🚀 Noise riser → drop" },
  { value: "double_drop", label: "💥 Double drop" },
  { value: "bass_swap", label: "🎚 Bass swap" },
  { value: "filter_sweep", label: "🌀 Filter sweep" },
  { value: "echo_out", label: "🔊 Echo out" },
  { value: "crossfade", label: "🌊 Crossfade" },
  { value: "cut", label: "✂️ Cut" },
];

export default function AutoDjPage() {
  const mix = useAutoMix();
  const [clipLen, setClipLen] = useState<number | "ai">("ai");
  const [useAi, setUseAi] = useState(true);
  const [quantize, setQuantize] = useState(true);
  const [endless, setEndless] = useState(true);
  const [trick, setTrick] = useState<TransitionStyle | "">("");

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Auto-DJ</h1>
        <p className="text-sm text-zinc-400">
          Only the famous part of every song. In <b>AI timing</b> mode the
          transition plan decides when each song has given its best moment;
          quantize keeps drops on 4-bar phrase boundaries. Endless mode
          refills the queue so the set never stops.
        </p>
      </header>

      <SearchPicker
        placeholder="Add songs to the queue…"
        onPick={(t) => mix.setQueue((q) => [...q, t])}
      />

      {mix.queue.length > 0 && (
        <ul className="space-y-1 text-sm">
          {mix.queue.map((t, i) => (
            <li
              key={`${t.id}-${i}`}
              className={`flex items-center justify-between rounded px-3 py-1.5 ${
                i === mix.nowIdx
                  ? "bg-fuchsia-950/40 text-fuchsia-300"
                  : "bg-zinc-900"
              }`}
            >
              <span className="truncate">
                {i + 1}. {t.title}
              </span>
              <button
                onClick={() =>
                  mix.setQueue((q) => q.filter((_, j) => j !== i))
                }
                className="ml-2 text-zinc-500 hover:text-red-400"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {([
          ["ai", "🤖 AI timing"],
          [30, "30s"],
          [60, "60s"],
        ] as const).map(([len, label]) => (
          <button
            key={String(len)}
            onClick={() => setClipLen(len)}
            className={`rounded-lg px-4 py-2 text-sm ${
              clipLen === len
                ? "bg-fuchsia-600"
                : "border border-zinc-700 text-zinc-300"
            }`}
          >
            {label}
          </button>
        ))}
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={useAi}
            onChange={(e) => setUseAi(e.target.checked)}
          />
          AI plans transitions
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={quantize}
            onChange={(e) => setQuantize(e.target.checked)}
          />
          Quantize
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={endless}
            onChange={(e) => setEndless(e.target.checked)}
          />
          Endless
        </label>
        <select
          value={trick}
          onChange={(e) => {
            const v = e.target.value as TransitionStyle | "";
            setTrick(v);
            mix.setOptions({ styleHint: v || undefined }); // applies live mid-set
          }}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
        >
          {TRICKS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        {!mix.running ? (
          <button
            onClick={() => {
              mix.start({
                clipLen,
                useAi,
                quantize,
                endless,
                styleHint: trick || undefined,
              });
            }}
            disabled={mix.queue.length < 2}
            className="rounded-lg bg-zinc-100 px-5 py-2 font-semibold text-zinc-900 disabled:opacity-40"
          >
            ▶ Start set
          </button>
        ) : (
          <>
            <button
              onClick={() => mix.hopNow()}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm"
            >
              skip →
            </button>
            <button
              onClick={() => mix.stop()}
              className="rounded-lg border border-zinc-700 px-5 py-2 font-semibold"
            >
              ◼ Stop
            </button>
          </>
        )}
      </div>

      {mix.status && (
        <p className="animate-pulse text-xs text-amber-400">{mix.status}</p>
      )}

      {mix.now && (
        <div className="rounded-xl border border-zinc-800 p-4 space-y-2">
          <p className="font-semibold">{mix.now.meta.title}</p>
          <HeatmapBar meta={mix.now.meta} position={mix.position} />
          <p className="text-xs text-zinc-500">
            {mix.now.analysis.bpm} BPM · famous @ {mix.now.meta.famousStart ?? "?"}s
            {mix.nextReady && (
              <span className="ml-2 text-emerald-400">· next hop prepared ✓</span>
            )}
          </p>
          {mix.lastPlan && (
            <p className="text-xs text-fuchsia-300">
              last hop: {mix.lastPlan.style}
              {mix.lastPlan.beatMatch ? " (beat-matched)" : ""} —{" "}
              {mix.lastPlan.reasoning}
            </p>
          )}
        </div>
      )}
    </main>
  );
}
