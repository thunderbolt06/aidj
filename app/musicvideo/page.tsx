"use client";

import { useState } from "react";
import { useAutoMix } from "@/lib/client/useAutoMix";
import { SearchPicker } from "@/components/SearchPicker";
import { MusicVisualizer } from "@/components/MusicVisualizer";

/**
 * Immersive music-video mode: queue songs, hit play, and watch a real-time,
 * beat & chord-reactive visual painted from the live audio. Same Auto-DJ engine
 * underneath (famous parts, AI transitions, endless refill) , here the picture
 * is the point. Pick a built-in framework, let the AI compose one from a prompt,
 * or paste your own.
 */
export default function MusicVideoPage() {
  const mix = useAutoMix();
  const [started, setStarted] = useState(false);

  return (
    <main className="mx-auto max-w-4xl space-y-5 p-6">
      <header>
        <h1 className="text-2xl font-bold">
          🎬 Music Video <span className="text-fuchsia-500">Lab</span>
        </h1>
        <p className="text-sm text-zinc-400">
          Real-time animation coded to the beats and chords of the music , like
          the old Windows Media Player visualizers, but context-aware and
          AI-directed. Nothing is pre-rendered; every frame reacts to what&apos;s
          playing. Double-click the canvas for fullscreen.
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
                i === mix.nowIdx ? "bg-fuchsia-950/40 text-fuchsia-300" : "bg-zinc-900"
              }`}
            >
              <span className="truncate">
                {i + 1}. {t.title}
              </span>
              <button
                onClick={() => mix.setQueue((q) => q.filter((_, j) => j !== i))}
                className="ml-2 text-zinc-500 hover:text-red-400"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {!mix.running ? (
          <button
            onClick={() => {
              setStarted(true);
              mix.start({ clipLen: "ai", useAi: true, quantize: true, endless: true, keyLock: true });
            }}
            disabled={mix.queue.length < 1}
            className="rounded-lg bg-zinc-100 px-5 py-2 font-semibold text-zinc-900 disabled:opacity-40"
          >
            ▶ Play
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
        {mix.now && (
          <span className="text-xs text-zinc-400">
            {mix.now.meta.title}
            {mix.now.analysis.camelot && (
              <span className="ml-1 text-sky-400">· {mix.now.analysis.camelot}</span>
            )}{" "}
            · {mix.now.analysis.bpm} BPM
          </span>
        )}
      </div>

      {mix.status && <p className="animate-pulse text-xs text-amber-400">{mix.status}</p>}

      {(started || mix.running) && (
        <MusicVisualizer
          analysis={mix.now?.analysis ?? null}
          track={mix.now ? { title: mix.now.meta.title, artist: mix.now.meta.artist } : null}
          arc={mix.arcInfo ? { energy: mix.arcInfo.energy, phase: mix.arcInfo.phase } : null}
          active={mix.running}
          defaultTemplate="stairs"
        />
      )}
    </main>
  );
}
