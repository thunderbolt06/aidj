import type { TransitionStyle } from "@/lib/types";

/**
 * Energy-arc director (set pacing).
 *
 * A real DJ paces a whole set, not just the next hop: warm the room, build,
 * peak, release. This module turns a chosen arc shape + set duration into a
 * target ENERGY (0..1) at any progress point, and maps that energy onto the
 * knobs the rest of the app already has , BPM target, clip length, and a bias
 * over transition tricks. The director in useAutoMix samples it continuously.
 */

export type ArcShape =
  | "warmup"
  | "build"
  | "peak_release"
  | "wave"
  | "winddown"
  | "flat";

export const ARC_SHAPES: { id: ArcShape; label: string; blurb: string }[] = [
  { id: "warmup", label: "Warm-up", blurb: "ease in, settle at a steady groove" },
  { id: "build", label: "Build", blurb: "slow climb that peaks at the very end" },
  { id: "peak_release", label: "Peak & release", blurb: "classic set: rise → peak → cool down" },
  { id: "wave", label: "Waves", blurb: "ride up and down , keeps it dynamic" },
  { id: "winddown", label: "Wind-down", blurb: "start hot, bring it home soft" },
  { id: "flat", label: "Flat", blurb: "hold one steady vibe throughout" },
];

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeIn = (t: number) => t * t;
const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** Target energy (0..1) at set progress `p` (0..1). */
export function arcEnergyAt(shape: ArcShape, p: number): number {
  p = clamp01(p);
  switch (shape) {
    case "warmup":
      return lerp(0.35, 0.82, easeOut(p));
    case "build":
      return lerp(0.25, 1, easeIn(p));
    case "peak_release":
      return p < 0.65
        ? lerp(0.3, 1, easeInOut(p / 0.65))
        : lerp(1, 0.5, (p - 0.65) / 0.35);
    case "wave":
      // 1.5 cycles, starting low
      return clamp01(0.58 + 0.34 * Math.sin(p * Math.PI * 3 - Math.PI / 2));
    case "winddown":
      return lerp(0.9, 0.3, easeInOut(p));
    case "flat":
    default:
      return 0.6;
  }
}

export type ArcPhase = "chill" | "groovy" | "hype" | "peak";

export function arcPhase(energy: number): ArcPhase {
  if (energy < 0.38) return "chill";
  if (energy < 0.62) return "groovy";
  if (energy < 0.82) return "hype";
  return "peak";
}

/** Rough BPM target window for a given energy. */
export function bpmTargetForEnergy(energy: number): [number, number] {
  const center = Math.round(72 + clamp01(energy) * 64); // 72..136
  return [center - 4, center + 6];
}

/** Lower energy → longer clips (let it breathe); peak → rapid-fire hooks. */
export function clipLenForEnergy(energy: number): number {
  return Math.round(lerp(56, 26, clamp01(energy)));
}

/**
 * Transition tricks that fit the current energy , a bias, not a hard rule.
 * Each phase offers several distinct options so the planner can keep varying
 * (and never lock onto one signature move across a whole stretch of the set).
 * Ordered loosely from "safest blend" to "boldest" within the phase.
 */
export function styleBiasForEnergy(energy: number): TransitionStyle[] {
  const phase = arcPhase(energy);
  switch (phase) {
    case "chill":
      // ease the room: smooth blends with a touch of texture, nothing jarring
      return ["crossfade", "echo_out", "filter_sweep", "gate"];
    case "groovy":
      // the pocket: club-standard moves that keep bodies moving
      return ["bass_swap", "filter_sweep", "gate", "loop_roll", "crossfade"];
    case "hype":
      // lifting off: tension builds and rolls into bigger entrances
      return ["filter_sweep", "loop_roll", "riser", "backspin", "bass_swap"];
    case "peak":
      // full send: the spectacular, high-impact drops
      return ["double_drop", "loop_roll", "riser", "silence_drop", "backspin", "cut"];
  }
}

export interface ArcTarget {
  /** 0..1 through the set. */
  progress: number;
  /** 0..1 target energy right now. */
  energy: number;
  phase: ArcPhase;
  bpm: [number, number];
  clipLen: number;
  styleBias: TransitionStyle[];
}

export function arcTargetAt(shape: ArcShape, progress: number): ArcTarget {
  const energy = arcEnergyAt(shape, progress);
  return {
    progress: clamp01(progress),
    energy,
    phase: arcPhase(energy),
    bpm: bpmTargetForEnergy(energy),
    clipLen: clipLenForEnergy(energy),
    styleBias: styleBiasForEnergy(energy),
  };
}
