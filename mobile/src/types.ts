// Shared types — mirrors the web app's lib/types.ts (home-feature subset).

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
  /**
   * Estimated downbeat (bar-1) offset in seconds - the beat to anchor
   * phrase quantization on, not just the first detected beat.
   */
  downbeatOffset: number;
  /** 0..1 confidence in the detected tempo (share of the winning vote). */
  bpmConfidence: number;
  /** Integrated loudness as linear RMS (pre-normalization), for trim gain. */
  loudness: number;
  /** Camelot code, e.g. "8A" / "11B". Null if key detection was inconclusive. */
  camelot: string | null;
  /** Human key name, e.g. "F#min" / "Cmaj". */
  keyName: string | null;
  /** 0..1 confidence in the detected key (Krumhansl correlation). */
  keyConfidence: number;
}

export type TransitionStyle =
  | "crossfade"
  | "bass_swap"
  | "filter_sweep"
  | "echo_out"
  | "cut"
  | "loop_roll"
  | "brake"
  | "riser"
  | "double_drop"
  | "silence_drop"
  | "backspin"
  | "tape_stop"
  | "gate"
  | "stem_acapella" // planner may emit it; engine degrades it (no stems on mobile v1)
  | "vocal_throw"; // planner may emit it; engine degrades it to a cut

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
