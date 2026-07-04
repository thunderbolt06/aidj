import { DJEngine } from "./engine";
import { analyzeTrack, camelotCompatible } from "./analysis";
import { apiUrl } from "../config";
import type { AudioBuffer } from "react-native-audio-api";
import type { Track, TrackAnalysis, TrackMeta, TransitionPlan } from "../types";

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

/**
 * Every decoded track registers its full PCM size (~1MB per 3s of stereo
 * audio, so 70-100MB a song) as external memory pressure on the Hermes heap.
 * Unbounded, the cache OOMs the JS runtime after a dozen loads (endless mode
 * warms 3 grid tiles per hop) — GCBase::oom SIGSEGVs. LRU keeps the playing
 * track, the prepared next and the warmed tiles; older entries drop and
 * reload on demand. The decks hold their own buffer refs, so evicting the
 * playing track's entry never interrupts audio.
 */
const MAX_CACHED_TRACKS = 4;
const cache = new Map<string, Promise<LoadedTrack>>();

/**
 * Force a full Hermes GC after each decode+analyze. Decoded buffers credit
 * their PCM size as external memory on the JS heap, but Hermes only debits
 * it when the wrapper object is FINALIZED — and full collections don't run
 * often enough on their own: the credit from evicted tracks piled up to the
 * 3GB heap limit (GCBase::oom SIGSEGV) even though the real heap was tiny.
 */
function collectAudioGarbage() {
  const g = globalThis as unknown as {
    gc?: () => void;
    HermesInternal?: { getInstrumentedStats?: () => Record<string, unknown> };
  };
  g.gc?.();
  const stats = g.HermesInternal?.getInstrumentedStats?.();
  if (stats) {
    const mb = (k: string) =>
      typeof stats[k] === "number" ? `${Math.round((stats[k] as number) / 1048576)}MB` : "?";
    console.log(
      `[mem] cache=${cache.size} gc=${typeof g.gc} heap=${mb("js_heapSize")} alloc=${mb("js_allocatedBytes")} external=${mb("js_externalBytes")}`
    );
  }
}

/** Re-insert `id` as most-recent and evict the oldest entries over the cap. */
function touchCache(id: string, p: Promise<LoadedTrack>) {
  cache.delete(id);
  cache.set(id, p);
  while (cache.size > MAX_CACHED_TRACKS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Serialize native decode + analysis work. Several tracks load concurrently
 * (prepare-ahead, prefetch, grid warming); running multiple native decodes /
 * offline renders in parallel crashed react-native-audio-api on iOS
 * (over-release on a GCD queue). Network fetches stay parallel — only the
 * native-heavy section goes through this gate.
 */
let nativeChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = nativeChain.then(fn, fn);
  nativeChain = run.catch(() => {});
  return run;
}

/** Fetch meta + audio + run analysis; cached per video id. */
export function loadTrack(
  id: string,
  onStatus?: (s: string) => void
): Promise<LoadedTrack> {
  const hit = cache.get(id);
  if (hit) {
    touchCache(id, hit);
    return hit;
  }
  const p = (async () => {
    onStatus?.("fetching metadata…");
    const metaRes = await fetch(apiUrl(`/api/meta/${id}`));
    if (!metaRes.ok) throw new Error("metadata failed");
    const meta: TrackMeta = await metaRes.json();

    onStatus?.("extracting audio…");
    const audioRes = await fetch(apiUrl(`/api/audio/${id}`));
    if (!audioRes.ok) {
      let detail: string | null = null;
      try {
        detail = ((await audioRes.json()) as { error?: string })?.error ?? null;
      } catch {
        /* non-JSON error body */
      }
      throw new Error(`audio extraction failed: ${detail || `HTTP ${audioRes.status}`}`);
    }
    const data = await audioRes.arrayBuffer();

    const { buffer, analysis } = await serialized(async () => {
      onStatus?.("decoding…");
      console.log(`[load ${id}] decoding ${data.byteLength} bytes`);
      const buf = await getEngine().decode(data);
      console.log(`[load ${id}] decoded ${buf.duration.toFixed(1)}s, analyzing`);
      onStatus?.("analyzing beats…");
      const an = await analyzeTrack(buf);
      console.log(`[load ${id}] analyzed bpm=${an.bpm} key=${an.camelot}`);
      collectAudioGarbage();
      return { buffer: buf, analysis: an };
    });
    onStatus?.("");
    return { meta, buffer, analysis };
  })();
  p.catch(() => cache.delete(id));
  touchCache(id, p);
  return p;
}

export async function searchTracks(q: string): Promise<Track[]> {
  const res = await fetch(apiUrl(`/api/search?q=${encodeURIComponent(q)}`));
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
    recentStyles?: string[];
  }
): Promise<TransitionPlan> {
  const controller = new AbortController();
  const timer = opts?.timeoutMs
    ? setTimeout(() => controller.abort(), opts.timeoutMs)
    : null;
  try {
    const res = await fetch(apiUrl("/api/ai/transition"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
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
        stemsAvailable: false,
        recentStyles: opts?.recentStyles ?? [],
      }),
    });
    if (!res.ok) throw new Error("transition planning failed");
    return res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
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
