"use client";

import { DJEngine } from "@/lib/audio/engine";
import { installAudioUnlock } from "@/lib/audio/unlock";
import { analyzeTrack, camelotCompatible } from "@/lib/audio/analysis";
import { pickVocalEntry, vocalEntries, vocalExits } from "@/lib/audio/vocalExits";
import { getSelectedLanguages } from "@/lib/client/langPrefs";
import { getSongSource } from "@/lib/client/sourcePrefs";
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

/** Phones and tablets: touch-first devices with a tight per-tab memory budget. */
function isTouchDevice(): boolean {
  return typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;
}

/**
 * A decoded song is raw PCM - about 85 MB for a 4-minute track - and mobile
 * Safari reloads the whole tab (dropping the set back to home) once it runs
 * out of memory. So the decode caches keep only the most recently used few;
 * anything playing or prepared stays alive through its own references.
 */
function decodedCacheSize(kind: "track" | "stem"): number {
  if (kind === "stem") return isTouchDevice() ? 2 : 6;
  // phones: the song playing, the next one, and one warm grid tile
  return isTouchDevice() ? 3 : 12;
}

/** Read through an LRU map: a hit becomes the newest entry. */
function lruGet<V>(map: Map<string, V>, key: string): V | undefined {
  const hit = map.get(key);
  if (hit !== undefined) {
    map.delete(key);
    map.set(key, hit);
  }
  return hit;
}

/** Insert as newest and drop the oldest entries past `max`. */
function lruSet<V>(map: Map<string, V>, key: string, value: V, max: number) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as string);
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
  const hit = lruGet(cache, id);
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
  p.catch(() => {
    if (cache.get(id) === p) cache.delete(id);
  });
  lruSet(cache, id, p, decodedCacheSize("track"));
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
  params.set("src", getSongSource());
  const res = await fetch(`/api/search?${params}`);
  if (!res.ok) {
    const detail = await res.json().then((j) => j?.error).catch(() => null);
    throw new Error(detail || "search failed");
  }
  return (await res.json()).tracks;
}

let pendingPlay: Track | null = null;

/**
 * Hand a track to the home player from another page (the library): the page
 * calls this in the click, then navigates home, which starts a set on it.
 */
export function playOnHome(track: Track) {
  pendingPlay = track;
  // still inside the click - unlock audio now, home starts after a navigation
  getEngine().resume().catch(() => {});
}

/** One-shot read of the track handed over by playOnHome(). */
export function takePendingPlay(): Track | null {
  const t = pendingPlay;
  pendingPlay = null;
  return t;
}

/** Downsample energy array so prompts stay small. */
function sparseEnergy(energy: number[], buckets = 40): number[] {
  if (energy.length <= buckets) return energy;
  const step = energy.length / buckets;
  return Array.from({ length: buckets }, (_, i) =>
    +(energy[Math.floor(i * step)] ?? 0).toFixed(2)
  );
}

/** Vocal breaks and section ends 20-60 s after the hook starts - where the chorus can end. */
function vocalBreaksAfterHook(from: LoadedTrack, position: number): number[] {
  const hook = from.meta.famousStart ?? 40;
  return vocalExits(from.meta.vocals, from.analysis)
    .filter((e) => e.kind !== "line" && e.at > position && e.at >= hook + 20 && e.at <= hook + 60)
    .map((e) => Math.round(e.at));
}

export async function planTransition(
  from: LoadedTrack,
  to: LoadedTrack,
  position: number,
  opts?: {
    timeoutMs?: number;
    stemsAvailable?: boolean;
    /** B's beat can come in under A's singer (lib/audio/handoff.ts). */
    handoffAvailable?: boolean;
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
        // where a sung line ends and the band plays alone for a bit - only the
        // ones right after the hook, or the planner picks a far-off outro
        vocalBreaks: vocalBreaksAfterHook(from, position),
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
      handoffAvailable: opts?.handoffAvailable ?? false,
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
  return landOnVocalEntry(await res.json(), to);
}

const stemCache = new Map<string, Promise<AudioBuffer>>();

/** Fetch + decode a demucs stem (vocals|instrumental), cached per id+stem. */
export function loadStem(
  id: string,
  stem: "vocals" | "instrumental"
): Promise<AudioBuffer> {
  const key = `${id}-${stem}`;
  const hit = lruGet(stemCache, key);
  if (hit) return hit;
  const p = (async () => {
    const res = await fetch(`/api/stems/${id}?stem=${stem}`);
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error ?? `stem ${stem} failed`);
    }
    return getEngine().decode(await res.arrayBuffer());
  })();
  p.catch(() => {
    if (stemCache.get(key) === p) stemCache.delete(key);
  });
  lruSet(stemCache, key, p, decodedCacheSize("stem"));
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
  return landOnVocalEntry({
    style: clash ? "echo_out" : "crossfade",
    outPoint: position,
    inPoint: Math.max(0, famous - 8),
    duration: clash ? 7 : 8,
    beatMatch: false,
    reasoning: clash
      ? `Heuristic: keys clash (${from!.analysis.camelot}→${to.analysis.camelot}), echoing out to mask it.`
      : "Heuristic fallback: smooth crossfade into the hook.",
  }, to);
}

/**
 * Where B should start near `desired`: on the beat just before a sung line
 * (ideally a verse that follows band-only music), so the listener never
 * lands in a half-sung sentence. `desired` when B has no vocal map or no
 * line starts close by.
 */
export function vocalStart(to: LoadedTrack, desired: number, lead = 4): number {
  return vocalEntryNear(to, desired, lead)?.at ?? desired;
}

function vocalEntryNear(to: LoadedTrack, desired: number, lead: number) {
  const a = to.analysis;
  const entries = vocalEntries(to.meta.vocals, a, lead).filter((e) => e.at < a.duration - 30);
  return pickVocalEntry(entries, desired);
}

/**
 * Move a plan's in-point to the start of a sung line. The hook detector (and
 * the AI, which aims just before the hook) often lands mid-verse; this keeps
 * the hook close but starts B where its singer starts. An acapella-in times
 * B's vocal stem off the in-point itself, so it is left alone.
 */
export function landOnVocalEntry(plan: TransitionPlan, to: LoadedTrack): TransitionPlan {
  if (plan.style === "stem_acapella") return plan;
  const e = vocalEntryNear(to, plan.inPoint, Math.min(plan.duration, 8));
  if (!e) return plan;
  return {
    ...plan,
    inPoint: e.at,
    reasoning: `${plan.reasoning} 🎙 ${
      e.kind === "verse" ? "B comes in at the top of a verse." : "B comes in at the start of a sung line."
    }`,
  };
}
