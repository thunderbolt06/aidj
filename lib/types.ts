// Shared types across experiments

/** What a library entry is for: a full song, a one-shot effect, or a beat loop. */
export type TrackKind = "song" | "sfx" | "loop";

export interface Track {
  id: string; // library id, e.g. "yt-dQw4w9WgXcQ"
  title: string;
  artist: string;
  duration: number; // seconds
  /**
   * Cover image URL. Songs have square album art (512x512 JPEG); `syn-` FX
   * and loops keep a 480x270 gradient. Can fail to load - hide, don't break.
   */
  thumbnail: string;
  // precomputed at ingest - present on everything the library serves
  kind?: TrackKind;
  bpm?: number;
  camelot?: string | null;
  /** 0 (ambient) .. 1 (peak-time banger). */
  intensity?: number;
  genres?: string[];
  /** Licence name + links, for attribution wherever a track is listed. */
  license?: string | null;
  licenseUrl?: string | null;
  sourceUrl?: string | null;
}

export interface HeatmapPoint {
  start: number; // seconds
  end: number;
  value: number; // 0..1 hook-likeness (loud AND repeated)
}

export interface TrackLicense {
  name: string;
  url: string | null;
  commercialUse: boolean | null;
  derivatives: boolean | null;
}

export interface TrackMeta extends Track {
  heatmap: HeatmapPoint[];
  /** Start of the hook ("famous part"), in seconds - computed from the audio. */
  famousStart: number | null;
  /** Full analysis computed at ingest; when present the client skips its own. */
  analysis?: TrackAnalysis;
  /** Where the intro ends / the outro starts - clean mix-in and mix-out points. */
  cueIn?: number;
  cueOut?: number;
  tags?: string[];
  album?: string | null;
  instrumental?: boolean;
  licenseInfo?: TrackLicense;
  source?: string;
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
  | "bass_swap" // swap low ends on a beat
  | "filter_sweep" // highpass sweep out, sweep in
  | "echo_out" // feedback delay tail into next track
  | "cut" // hard cut on the beat
  | "loop_roll" // 1→½→¼ beat stutter roll, then slam (classic buildup)
  | "brake" // vinyl brake: record grinds to a halt, drop slams
  | "riser" // white-noise sweep + bass pull-out into a hard drop
  | "double_drop" // both hooks hit together for 8 beats, then A exits
  | "silence_drop" // cut everything for a beat (dead air), then slam B on the 1
  | "backspin" // vinyl rewind: A's last 2 beats reverse-accelerate, B slams
  | "tape_stop" // power-cut: A pitch-drops to a halt over ~1 beat, then B drops
  | "gate" // rhythmic strobe-gate on A for a bar while B fades up underneath
  | "stem_acapella" // B's isolated vocal rides over A, then B's full mix drops in
  | "vocal_throw"; // A's last sung word is thrown (echoed) over B's intro

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
