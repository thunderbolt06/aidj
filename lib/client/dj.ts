"use client";

import { DJEngine } from "@/lib/audio/engine";
import { installAudioUnlock } from "@/lib/audio/unlock";
import { analyzeTrack, camelotCompatible } from "@/lib/audio/analysis";
import { getSelectedLanguages } from "@/lib/client/langPrefs";
import type {
  Track,
  TrackAnalysis,
  TrackKind,
  TrackMeta,
  TransitionPlan,
} from "@/lib/types";

let engine: DJEngine | null = null;
export function getEngine(): DJEngine {
  if (!engine) {
    engine = new DJEngine();
    // iPhone: resume-on-gesture + mute-switch workaround (no-op elsewhere)
    installAudioUnlock(() => getEngine());
  }
  return engine;
}

export interface LoadedTrack {
  meta: TrackMeta;
  buffer: AudioBuffer;
  analysis: TrackAnalysis;
}

const cache = new Map<string, Promise<LoadedTrack>>();

/**
 * Fetch meta + audio; cached per track id. Library tracks arrive with their
 * analysis precomputed, so loading is just download + decode - the in-browser
 * analyzer only runs for an entry that somehow lacks one.
 */
export function loadTrack(
  id: string,
  onStatus?: (s: string) => void
): Promise<LoadedTrack> {
  const hit = cache.get(id);
  if (hit) return hit;
  const p = (async () => {
    onStatus?.("loading…");
    // meta and audio are both static reads now - fetch them together
    const [metaRes, audioRes] = await Promise.all([
      fetch(`/api/meta/${id}`),
      fetch(`/api/audio/${id}`),
    ]);
    if (!metaRes.ok) throw new Error("track not in library");
    const meta: TrackMeta = await metaRes.json();
    if (!audioRes.ok) {
      const detail = await audioRes
        .clone()
        .json()
        .then((j) => j?.error)
        .catch(() => null);
      throw new Error(`audio failed: ${detail || `HTTP ${audioRes.status}`}`);
    }
    const buffer = await getEngine().decode(await audioRes.arrayBuffer());
    const analysis = meta.analysis ?? (await analyzeTrack(buffer));
    onStatus?.("");
    return { meta, buffer, analysis };
  })();
  p.catch(() => cache.delete(id));
  cache.set(id, p);
  return p;
}

const elementCache = new Map<string, Promise<AudioBuffer>>();

/** Decode a library element (FX one-shot / loop) once; taps replay the buffer. */
export function loadElement(id: string): Promise<AudioBuffer> {
  const hit = elementCache.get(id);
  if (hit) return hit;
  const p = (async () => {
    const res = await fetch(`/api/audio/${id}`);
    if (!res.ok) throw new Error(`element ${id} failed`);
    return getEngine().decode(await res.arrayBuffer());
  })();
  p.catch(() => elementCache.delete(id));
  elementCache.set(id, p);
  return p;
}

/** Library search; an empty query browses the most popular entries. */
export async function searchTracks(
  q: string,
  opts?: { kind?: TrackKind | "all"; limit?: number }
): Promise<Track[]> {
  const params = new URLSearchParams({ q });
  if (opts?.kind) params.set("kind", opts.kind);
  if (opts?.limit) params.set("limit", String(opts.limit));
  const languages = getSelectedLanguages();
  if (languages.length) params.set("lang", languages.join(","));
  const res = await fetch(`/api/search?${params}`);
  if (!res.ok) {
    const detail = await res.json().then((j) => j?.error).catch(() => null);
    throw new Error(detail || "search failed");
  }
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
