/**
 * Real-time music-video visualizer framework.
 *
 * A *template* is a coded, real-time animation (Canvas2D draw function or a
 * GLSL fragment shader) that reacts to the audio. Every frame the VizDriver
 * hands the template a `VizFrame` snapshot of the music - band energies, beat
 * grid phase, transient onsets, a 12-bin chroma ("chord"), and a key-derived
 * color - and the template paints. Nothing is pre-rendered.
 */

import type { TrackAnalysis } from "@/lib/types";

/** Beat-grid clock derived from the track analysis + the audio playhead. */
export interface BeatInfo {
  bpm: number;
  /** 0..1 confidence in the grid (low → don't trust beat snapping). */
  confidence: number;
  /** Integer beats elapsed since the first detected beat. */
  beat: number;
  /** 0..1 position within the current beat. */
  beatPhase: number;
  /** Integer bars (4 beats) elapsed since the estimated downbeat. */
  bar: number;
  /** 0..1 position within the current 4-beat bar. */
  barPhase: number;
  /** 0..1 pulse that snaps to 1 on each beat and eases down - for flashes. */
  beatPulse: number;
  /**
   * 0..1 combined beat "hit" the visuals should actually flash on. When the BPM
   * grid is trusted it follows `beatPulse`; when the grid is shaky it follows
   * the live audio (onset + low-end kicks) so beats track the real, variable
   * timing instead of a drifting grid. Use this, not `beatPulse`, for flashes.
   */
  hit: number;
  /** True on the frame a new beat just started. */
  beatHit: boolean;
  /** True on the frame a new bar (downbeat) just started. */
  barHit: boolean;
}

/** Tunable look/feel knobs - set by the user or the AI director. */
export interface VizParams {
  /** Base hue 0..360. Overrides the key-derived hue when set. */
  hue: number;
  /** Hue spread across the palette, degrees. */
  hueRange: number;
  /** 0..2 reactivity / motion multiplier. */
  intensity: number;
  /** 0..2 time/speed multiplier. */
  speed: number;
  /** 0..1 detail / busyness. */
  complexity: number;
  /** 0..1 bloom / trails. */
  glow: number;
  /** Optional explicit palette (hex strings) from the AI director. */
  palette?: string[];
}

export const DEFAULT_PARAMS: VizParams = {
  hue: 280,
  hueRange: 120,
  intensity: 1,
  speed: 1,
  complexity: 0.6,
  glow: 0.6,
};

/** Per-frame snapshot of the music handed to a template's draw call. */
export interface VizFrame {
  /** Audio playhead, seconds. */
  t: number;
  /** Seconds since the previous frame. */
  dt: number;
  /** Monotonic wall-clock seconds since the driver started (for idle motion). */
  clock: number;
  w: number;
  h: number;
  dpr: number;

  /** Smoothed 0..1 band energies. */
  low: number;
  mid: number;
  high: number;
  /** Smoothed 0..1 overall level. */
  level: number;
  /** 0..1 transient/kick detector (spectral-flux based). */
  onset: number;

  beat: BeatInfo;

  /** Raw FFT magnitudes 0..255. */
  spectrum: Uint8Array;
  /** Time-domain waveform 0..255 (128 = silence). */
  waveform: Uint8Array;
  /** 12 pitch-class energies 0..1 - the live "chord". */
  chroma: number[];
  /** Index 0..11 of the strongest pitch class. */
  chromaRoot: number;

  /** Color anchor derived from the track's musical key. */
  key: { camelot: string | null; keyName: string | null; hue: number };
  /** Energy-arc context, when an arc set is running. */
  arc: { energy: number; phase: string } | null;
  track: { title: string; artist: string } | null;

  params: VizParams;
}

export interface CanvasTemplate {
  id: string;
  name: string;
  blurb: string;
  kind: "canvas2d";
  /** Whether the driver should clear the canvas before each draw. Feedback
   * templates (nebula) set false and fade themselves for trails. */
  clearEachFrame?: boolean;
  init?: (w: number, h: number) => unknown;
  draw: (ctx: CanvasRenderingContext2D, f: VizFrame, state: unknown) => void;
  /** Marks user-authored templates (persisted to localStorage). */
  custom?: boolean;
  /** Source body for custom canvas templates (so they can be re-edited). */
  source?: string;
}

export interface ShaderTemplate {
  id: string;
  name: string;
  blurb: string;
  kind: "shader";
  /** GLSL ES 1.00 body defining `void mainImage(out vec4, in vec2)`. */
  fragment: string;
  custom?: boolean;
}

export type VizTemplate = CanvasTemplate | ShaderTemplate;

/** The data the driver needs each frame, supplied by the host component. */
export interface VizInputs {
  analysis: TrackAnalysis | null;
  position: number;
  arc: { energy: number; phase: string } | null;
  track: { title: string; artist: string } | null;
  params: VizParams;
}
