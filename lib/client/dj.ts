"use client";

import { DJEngine } from "@/lib/audio/engine";
import { analyzeTrack } from "@/lib/audio/analysis";
import type {
  Track,
  TrackAnalysis,
  TrackMeta,
  TransitionPlan,
} from "@/lib/types";

let engine: DJEngine | null = null;
export function getEngine(): DJEngine {
  if (!engine) engine = new DJEngine();
  return engine;
}

export interface LoadedTrack {
  meta: TrackMeta;
  buffer: AudioBuffer;
  analysis: TrackAnalysis;
}

const cache = new Map<string, Promise<LoadedTrack>>();

/** Fetch meta + audio + run analysis; cached per video id. */
export function loadTrack(
  id: string,
  onStatus?: (s: string) => void
): Promise<LoadedTrack> {
  const hit = cache.get(id);
  if (hit) return hit;
  const p = (async () => {
    onStatus?.("fetching metadata…");
    const metaRes = await fetch(`/api/meta/${id}`);
    if (!metaRes.ok) throw new Error("metadata failed");
    const meta: TrackMeta = await metaRes.json();

    onStatus?.("extracting audio…");
    const audioRes = await fetch(`/api/audio/${id}`);
    if (!audioRes.ok) throw new Error("audio extraction failed");
    const data = await audioRes.arrayBuffer();

    onStatus?.("decoding…");
    const buffer = await getEngine().decode(data);

    onStatus?.("analyzing beats…");
    const analysis = await analyzeTrack(buffer);
    onStatus?.("");
    return { meta, buffer, analysis };
  })();
  p.catch(() => cache.delete(id));
  cache.set(id, p);
  return p;
}

export async function searchTracks(q: string): Promise<Track[]> {
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error("search failed");
  return (await res.json()).tracks;
}

/** Downsample energy array so prompts stay small. */
function sparseEnergy(energy: number[], buckets = 40): number[] {
  if (energy.length <= buckets) return energy;
  const step = energy.length / buckets;
  return Array.from({ length: buckets }, (_, i) =>
    +(energy[Math.floor(i * step)] ?? 0).toFixed(2)
  );
}

export async function planTransition(
  from: LoadedTrack,
  to: LoadedTrack,
  position: number,
  opts?: { timeoutMs?: number }
): Promise<TransitionPlan> {
  const res = await fetch("/api/ai/transition", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: opts?.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    body: JSON.stringify({
      trackA: {
        title: `${from.meta.title} — ${from.meta.artist}`,
        bpm: from.analysis.bpm,
        duration: Math.round(from.analysis.duration),
        energy: sparseEnergy(from.analysis.energy),
        position: Math.round(position),
        famousStart: from.meta.famousStart,
      },
      trackB: {
        title: `${to.meta.title} — ${to.meta.artist}`,
        bpm: to.analysis.bpm,
        duration: Math.round(to.analysis.duration),
        energy: sparseEnergy(to.analysis.energy),
        famousStart: to.meta.famousStart,
      },
    }),
  });
  if (!res.ok) throw new Error("transition planning failed");
  return res.json();
}

/** Fallback plan when the AI is unavailable: crossfade into the famous part. */
export function heuristicPlan(
  to: LoadedTrack,
  position: number
): TransitionPlan {
  const famous = to.meta.famousStart ?? 45;
  return {
    style: "crossfade",
    outPoint: position,
    inPoint: Math.max(0, famous - 8),
    duration: 8,
    beatMatch: false,
    reasoning: "Heuristic fallback: smooth crossfade into the hook.",
  };
}
