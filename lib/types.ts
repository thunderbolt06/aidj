// Shared types across experiments

export interface Track {
  id: string; // YouTube video id
  title: string;
  artist: string; // channel/uploader
  duration: number; // seconds
  thumbnail: string;
}

export interface HeatmapPoint {
  start: number; // seconds
  end: number;
  value: number; // 0..1 replay intensity
}

export interface TrackMeta extends Track {
  heatmap: HeatmapPoint[];
  /** Start of the most-replayed ("famous") section, in seconds. */
  famousStart: number | null;
}

export interface TrackAnalysis {
  bpm: number;
  /** Offset in seconds of the first detected beat. */
  beatOffset: number;
  /** Per-second RMS energy, normalized 0..1. */
  energy: number[];
  duration: number;
}

export type TransitionStyle =
  | "crossfade"
  | "bass_swap" // swap low ends on a beat
  | "filter_sweep" // highpass sweep out, sweep in
  | "echo_out" // feedback delay tail into next track
  | "cut"; // hard cut on the beat

export interface TransitionPlan {
  style: TransitionStyle;
  /** When to start transition in track A (seconds). */
  outPoint: number;
  /** Where to start playing track B (seconds). */
  inPoint: number;
  /** Transition length in seconds. */
  duration: number;
  /** Whether to tempo-match B to A during the blend. */
  beatMatch: boolean;
  /** One-liner the AI gives about why, displayed in UI. */
  reasoning: string;
}

export interface LyricLine {
  time: number; // seconds
  text: string;
}
