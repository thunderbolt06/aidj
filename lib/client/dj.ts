"use client";

import { DJEngine } from "@/lib/audio/engine";
import { installAudioUnlock } from "@/lib/audio/unlock";
import { analyzeTrack, camelotCompatible } from "@/lib/audio/analysis";
import type {
  Track,
  TrackAnalysis,
  TrackMeta,
  TransitionPlan,
} from "@/lib/types";

let engine: DJEngine | null = null;
export function getEngine(): DJEngine {
  if (!engine) {
    engine = new DJEngine();
    // iPhone: resume-on-gesture + mute-switch workaround (no-op elsewhere)
    installAudioUnlock(() => getEngine().ctx);
  }
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
    if (!audioRes.ok) {
      // surface the real reason (yt-dlp stderr) instead of a generic message
      const detail = await audioRes
        .clone()
        .json()
        .then((j) => j?.error)
        .catch(() => null);
      throw new Error(`audio extraction failed: ${detail || `HTTP ${audioRes.status}`}`);
    }
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
  opts?: {
    timeoutMs?: number;
    stemsAvailable?: boolean;
    arc?: { energy: number; phase: string; styleBias: string[] } | null;
    recentStyles?: string[];
  }
): Promise<TransitionPlan> {
  const res = await fetch("/api/ai/transition", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: opts?.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    body: JSON.stringify({
      trackA: {
        title: `${from.meta.title} - ${from.meta.artist}`,
        bpm: from.analysis.bpm,
        bpmConfidence: from.analysis.bpmConfidence,
        camelot: from.analysis.camelot,
        key: from.analysis.keyName,
        duration: Math.round(from.analysis.duration),
        energy: sparseEnergy(from.analysis.energy),
        position: Math.round(position),
        famousStart: from.meta.famousStart,
      },
      trackB: {
        title: `${to.meta.title} - ${to.meta.artist}`,
        bpm: to.analysis.bpm,
        bpmConfidence: to.analysis.bpmConfidence,
        camelot: to.analysis.camelot,
        key: to.analysis.keyName,
        duration: Math.round(to.analysis.duration),
        energy: sparseEnergy(to.analysis.energy),
        famousStart: to.meta.famousStart,
      },
      harmonic: camelotCompatible(from.analysis.camelot, to.analysis.camelot),
      stemsAvailable: opts?.stemsAvailable ?? false,
      arc: opts?.arc
        ? {
            energy: opts.arc.energy,
            phase: opts.arc.phase,
            styleBias: opts.arc.styleBias,
          }
        : undefined,
      recentStyles: opts?.recentStyles ?? [],
    }),
  });
  if (!res.ok) throw new Error("transition planning failed");
  return res.json();
}

const stemCache = new Map<string, Promise<AudioBuffer>>();

/** Fetch + decode a demucs stem (vocals|instrumental), cached per id+stem. */
export function loadStem(
  id: string,
  stem: "vocals" | "instrumental"
): Promise<AudioBuffer> {
  const key = `${id}-${stem}`;
  const hit = stemCache.get(key);
  if (hit) return hit;
  const p = (async () => {
    const res = await fetch(`/api/stems/${id}?stem=${stem}`);
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error ?? `stem ${stem} failed`);
    }
    return getEngine().decode(await res.arrayBuffer());
  })();
  p.catch(() => stemCache.delete(key));
  stemCache.set(key, p);
  return p;
}

/** True once a stem is cached and resolved (non-blocking readiness check). */
export function stemReady(id: string, stem: "vocals" | "instrumental"): boolean {
  return stemCache.has(`${id}-${stem}`);
}

/**
 * Fallback plan when the AI is unavailable. Crossfades into the famous part,
 * but on a harmonic key clash it reaches for echo_out - a feedback tail masks
 * dissonance where a blend would sound sour.
 */
export function heuristicPlan(
  to: LoadedTrack,
  position: number,
  from?: LoadedTrack
): TransitionPlan {
  const famous = to.meta.famousStart ?? 45;
  const clash =
    !!from && !camelotCompatible(from.analysis.camelot, to.analysis.camelot);
  return {
    style: clash ? "echo_out" : "crossfade",
    outPoint: position,
    inPoint: Math.max(0, famous - 8),
    duration: clash ? 7 : 8,
    beatMatch: false,
    reasoning: clash
      ? `Heuristic: keys clash (${from!.analysis.camelot}→${to.analysis.camelot}), echoing out to mask it.`
      : "Heuristic fallback: smooth crossfade into the hook.",
  };
}
