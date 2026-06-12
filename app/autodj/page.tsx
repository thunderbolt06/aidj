"use client";

import { useState } from "react";
import { useAutoMix } from "@/lib/client/useAutoMix";
import { SearchPicker } from "@/components/SearchPicker";
import { HeatmapBar } from "@/components/HeatmapBar";

export default function AutoDjPage() {
  const mix = useAutoMix();
  const [clipLen, setClipLen] = useState(60);
  const [useAi, setUseAi] = useState(true);
  const [quantize, setQuantize] = useState(true);

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Auto-DJ</h1>
        <p className="text-sm text-zinc-400">
          Only the famous part of every song — auto-transition every {clipLen}s.
          With quantize on, drops wait for the next 4-bar phrase boundary
          instead of firing mid-bar.
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
        {[30, 60].map((len) => (
          <button
            key={len}
            onClick={() => setClipLen(len)}
            className={`rounded-lg px-4 py-2 text-sm ${
              clipLen === len
                ? "bg-fuchsia-600"
                : "border border-zinc-700 text-zinc-300"
            }`}
          >
            {len}s clips
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
          Quantize to phrase
        </label>
        {!mix.running ? (
          <button
            onClick={() => {
              mix.start({ clipLen, useAi, quantize });
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
