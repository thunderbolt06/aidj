/**
 * Offline track analysis on raw mono PCM - the library pipeline's twin of
 * lib/audio/analysis.ts (which needs a browser AudioBuffer). Same BPM / key /
 * energy algorithms, plus the things only worth computing ahead of time:
 * a hook ("famous part") estimate, mix-in / mix-out cues and an intensity
 * score. No imports and only erasable TS syntax, so Node can run it directly
 * (`node --experimental-strip-types`) from scripts/library/ingest.mjs.
 */

export interface CoreAnalysis {
  bpm: number;
  beatOffset: number;
  downbeatOffset: number;
  bpmConfidence: number;
  energy: number[];
  loudness: number;
  duration: number;
  camelot: string | null;
  keyName: string | null;
  keyConfidence: number;
  /** Start of the most hook-like section (loud AND repeated), or null. */
  hookStart: number | null;
  /** Per-second 0..1 "how hook-like is this moment" curve. */
  interest: number[];
  /** Where the intro ends - first bar with real energy. */
  cueIn: number;
  /** Where the outro starts - last bar before the energy tails off. */
  cueOut: number;
  /** 0 (ambient) .. 1 (peak-time banger): loudness + tempo + onset density. */
  intensity: number;
}

export function analyzeMono(data: Float32Array, sr: number): CoreAnalysis {
  const duration = data.length / sr;
  const low = lowpass(data, sr, 150);
  const peaks = findPeaks(low, sr);
  const { bpm, confidence, beatOffset } = tempoFromOnsets(data, low, sr);
  const downbeatOffset = estimateDownbeat(low, sr, bpm, beatOffset);
  const energy = energyPerSecond(data, sr);
  const loudness = integratedLoudness(data);
  const key = detectKey(data, sr);
  const interest = interestCurve(data, sr, energy);
  const grid = { bpm, anchor: downbeatOffset };
  const hook = pickHook(interest, grid);
  const cues = cuePoints(energy, grid, duration);

  const db = loudness > 0 ? 20 * Math.log10(loudness) : -60;
  const onsetRate = duration > 0 ? peaks.length / duration : 0;
  const intensity =
    0.5 * clamp01((db + 28) / 18) +
    0.3 * clamp01((bpm - 70) / 100) +
    0.2 * clamp01(onsetRate / 3);

  return {
    bpm,
    beatOffset: round(beatOffset, 3),
    downbeatOffset: round(downbeatOffset, 3),
    bpmConfidence: confidence,
    energy,
    loudness,
    duration: round(duration, 2),
    camelot: key.camelot,
    keyName: key.keyName,
    keyConfidence: key.keyConfidence,
    hookStart: hook,
    interest,
    cueIn: cues.cueIn,
    cueOut: cues.cueOut,
    intensity: round(intensity, 3),
  };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function round(v: number, places: number): number {
  const m = Math.pow(10, places);
  return Math.round(v * m) / m;
}

/** RBJ biquad lowpass - the JS stand-in for the browser's BiquadFilterNode. */
function lowpass(data: Float32Array, sr: number, freq: number): Float32Array {
  const w0 = (2 * Math.PI * freq) / sr;
  const alpha = Math.sin(w0) / (2 * 1.12);
  const cos = Math.cos(w0);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0;
  const b1 = (1 - cos) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  const out = new Float32Array(data.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

function findPeaks(data: Float32Array, sr: number): number[] {
  // threshold at 90th percentile of |amplitude|, sampled
  const sampled: number[] = [];
  for (let i = 0; i < data.length; i += 499) sampled.push(Math.abs(data[i]));
  sampled.sort((a, b) => a - b);
  const threshold = sampled[Math.floor(sampled.length * 0.9)] ?? 0.3;
  if (threshold <= 0) return [];

  const peaks: number[] = [];
  const minGap = Math.floor(sr * 0.25); // max 240 BPM
  let i = 0;
  while (i < data.length) {
    if (Math.abs(data[i]) > threshold) {
      let maxIdx = i;
      const end = Math.min(i + minGap, data.length);
      for (let j = i; j < end; j++) {
        if (Math.abs(data[j]) > Math.abs(data[maxIdx])) maxIdx = j;
      }
      peaks.push(maxIdx);
      i = maxIdx + minGap;
    } else i++;
  }
  return peaks;
}

const HOP = 256;

/** Onset-strength envelope: positive jumps in log energy, kick band doubled. */
function onsetEnvelope(data: Float32Array, low: Float32Array): Float32Array {
  const frames = Math.floor(data.length / HOP);
  const env = new Float32Array(frames);
  let prevFull = 0;
  let prevLow = 0;
  for (let f = 0; f < frames; f++) {
    let full = 0;
    let lo = 0;
    for (let i = f * HOP; i < (f + 1) * HOP; i++) {
      full += data[i] * data[i];
      lo += low[i] * low[i];
    }
    full = Math.log(1 + 1000 * full);
    lo = Math.log(1 + 1000 * lo);
    env[f] = Math.max(0, full - prevFull) + 2 * Math.max(0, lo - prevLow);
    prevFull = full;
    prevLow = lo;
  }
  // remove the slow-moving level so only transients vote
  const win = 43; // ~0.5s
  const out = new Float32Array(frames);
  let sum = 0;
  for (let f = 0; f < frames; f++) {
    sum += env[f];
    if (f >= win) sum -= env[f - win];
    out[f] = Math.max(0, env[f] - sum / Math.min(f + 1, win));
  }
  return out;
}

/**
 * Tempo by autocorrelating the onset envelope (far steadier than the
 * peak-interval vote the browser uses), refined to 0.1 BPM with a beat comb
 * that also yields the beat phase. Folded into 70-180 BPM like the live path.
 */
function tempoFromOnsets(
  data: Float32Array,
  low: Float32Array,
  sr: number
): { bpm: number; confidence: number; beatOffset: number } {
  const env = onsetEnvelope(data, low);
  const fps = sr / HOP;
  const n = env.length;
  if (n < fps * 8) return { bpm: 120, confidence: 0, beatOffset: 0 };

  const acf = (lag: number) => {
    let s = 0;
    for (let t = 0; t + lag < n; t++) s += env[t] * env[t + lag];
    return s / (n - lag);
  };
  const zero = acf(0);
  if (zero <= 0) return { bpm: 120, confidence: 0, beatOffset: 0 };

  const minLag = Math.floor((fps * 60) / 180);
  const maxLag = Math.ceil((fps * 60) / 70);
  let bestLag = minLag;
  let bestScore = -1;
  let bestRaw = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const raw = acf(lag);
    // a real beat period also correlates at 2× and 4× the lag
    const score =
      (raw + 0.5 * acf(lag * 2) + 0.25 * acf(lag * 4)) *
      Math.exp(-0.5 * Math.pow(Math.log2((fps * 60) / lag / 120) / 0.7, 2));
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
      bestRaw = raw;
    }
  }

  // integer lags are ~3 BPM apart: sweep a comb around the winner for 0.1 BPM
  const at = (pos: number) => {
    const i = Math.floor(pos);
    if (i < 0 || i + 1 >= n) return 0;
    const frac = pos - i;
    return env[i] * (1 - frac) + env[i + 1] * frac;
  };
  const coarse = (fps * 60) / bestLag;
  let bpm = coarse;
  let phase = 0;
  let combBest = -1;
  for (let cand = coarse * 0.965; cand <= coarse * 1.035; cand += 0.1) {
    const period = (fps * 60) / cand;
    const steps = 16;
    for (let p = 0; p < steps; p++) {
      const off = (p / steps) * period;
      let s = 0;
      for (let pos = off; pos < n; pos += period) s += at(pos);
      if (s > combBest) {
        combBest = s;
        bpm = cand;
        phase = off;
      }
    }
  }
  return {
    bpm: round(Math.min(180, Math.max(70, bpm)), 1),
    confidence: round(clamp01((bestRaw / zero) * 1.5), 3),
    beatOffset: phase / fps,
  };
}

/** Which of the 4 beats in a bar carries the most kick energy → bar 1. */
function estimateDownbeat(
  low: Float32Array,
  sr: number,
  bpm: number,
  beatOffset: number
): number {
  if (bpm <= 0) return beatOffset;
  const beatLen = 60 / bpm;
  const win = Math.floor(sr * 0.06);
  const phaseEnergy = [0, 0, 0, 0];
  for (let phase = 0; phase < 4; phase++) {
    let sum = 0;
    let count = 0;
    for (let b = phase; count < 96; b += 4) {
      const idx = Math.floor((beatOffset + b * beatLen) * sr);
      if (idx + win >= low.length) break;
      let e = 0;
      for (let i = 0; i < win; i++) e += Math.abs(low[idx + i]);
      sum += e;
      count++;
    }
    phaseEnergy[phase] = count ? sum / count : 0;
  }
  let bestPhase = 0;
  for (let p = 1; p < 4; p++)
    if (phaseEnergy[p] > phaseEnergy[bestPhase]) bestPhase = p;
  return beatOffset + bestPhase * beatLen;
}

function energyPerSecond(data: Float32Array, sr: number): number[] {
  const seconds = Math.floor(data.length / sr);
  const energy: number[] = [];
  let max = 0;
  for (let s = 0; s < seconds; s++) {
    let sum = 0;
    let n = 0;
    const start = s * sr;
    const end = Math.min(start + sr, data.length);
    for (let i = start; i < end; i += 3) {
      sum += data[i] * data[i];
      n++;
    }
    const rms = n ? Math.sqrt(sum / n) : 0;
    energy.push(rms);
    if (rms > max) max = rms;
  }
  return energy.map((e) => (max > 0 ? round(e / max, 3) : 0));
}

/** Integrated loudness as a single linear RMS over the whole track. */
function integratedLoudness(data: Float32Array): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 127) {
    sum += data[i] * data[i];
    n++;
  }
  return n > 0 ? round(Math.sqrt(sum / n), 5) : 0;
}

// ── Key detection ──────────────────────────────────────────────────────────

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
// Camelot wheel numbers indexed by tonic pitch class (C=0).
const MAJ_CAMELOT = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const MIN_CAMELOT = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
// Krumhansl-Schmuckler key profiles.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** Goertzel coefficients per semitone, C2 (MIDI 36) .. B5 (MIDI 83). */
function noteBank(sr: number): { pc: number; coeff: number }[] {
  const notes: { pc: number; coeff: number }[] = [];
  for (let m = 36; m < 84; m++) {
    const f = 440 * Math.pow(2, (m - 69) / 12);
    notes.push({ pc: m % 12, coeff: 2 * Math.cos((2 * Math.PI * f) / sr) });
  }
  return notes;
}

/** 12-bin chroma of one frame, accumulated into `out`. */
function chromaFrame(
  data: Float32Array,
  start: number,
  size: number,
  notes: { pc: number; coeff: number }[],
  out: number[]
) {
  for (const note of notes) {
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < size; i++) {
      const s = data[start + i] + note.coeff * s1 - s2;
      s2 = s1;
      s1 = s;
    }
    const power = s1 * s1 + s2 * s2 - note.coeff * s1 * s2;
    if (power > 0) out[note.pc] += Math.sqrt(power);
  }
}

function detectKey(
  data: Float32Array,
  sr: number
): { camelot: string | null; keyName: string | null; keyConfidence: number } {
  const none = { camelot: null, keyName: null, keyConfidence: 0 };
  const frameSize = 4096;
  const notes = noteBank(sr);
  const chroma = new Array(12).fill(0);
  const totalFrames = Math.floor(data.length / frameSize);
  if (totalFrames < 4) return none;
  const stride = Math.max(1, Math.floor(totalFrames / 240)); // ≤240 frames
  for (let fr = 0; fr + frameSize <= data.length; fr += frameSize * stride)
    chromaFrame(data, fr, frameSize, notes, chroma);

  let max = 0;
  for (const v of chroma) max = Math.max(max, v);
  if (max <= 0) return none;
  for (let i = 0; i < 12; i++) chroma[i] /= max;

  let best = { score: -2, tonic: 0, minor: false };
  for (let tonic = 0; tonic < 12; tonic++) {
    const maj = MAJOR_PROFILE.map((_, p) => MAJOR_PROFILE[(p - tonic + 12) % 12]);
    const min = MINOR_PROFILE.map((_, p) => MINOR_PROFILE[(p - tonic + 12) % 12]);
    const sMaj = pearson(chroma, maj);
    const sMin = pearson(chroma, min);
    if (sMaj > best.score) best = { score: sMaj, tonic, minor: false };
    if (sMin > best.score) best = { score: sMin, tonic, minor: true };
  }

  const num = best.minor ? MIN_CAMELOT[best.tonic] : MAJ_CAMELOT[best.tonic];
  return {
    camelot: `${num}${best.minor ? "A" : "B"}`,
    keyName: `${NOTE_NAMES[best.tonic]}${best.minor ? "min" : "maj"}`,
    keyConfidence: round(Math.max(0, best.score), 3),
  };
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const den = Math.sqrt(da * db);
  return den > 0 ? num / den : 0;
}

// ── Hook + cues ────────────────────────────────────────────────────────────

const HOOK_WINDOW = 8; // seconds a section must hold up to count

/**
 * Per-second hook-likeness. A chorus is the part that is both loud and comes
 * back: score = sustained energy × how strongly the next 8 seconds of harmony
 * recur elsewhere in the track (chroma self-similarity along the diagonal).
 * This replaces YouTube's "most replayed" heatmap as the famous-part signal.
 */
function interestCurve(data: Float32Array, sr: number, energy: number[]): number[] {
  const n = energy.length;
  if (n < 40) return energy.map(() => 0);

  // one L2-normalized chroma vector per second
  const notes = noteBank(sr);
  const frame = Math.min(4096, sr);
  const chroma: number[][] = [];
  for (let s = 0; s < n; s++) {
    const c = new Array(12).fill(0);
    chromaFrame(data, s * sr, frame, notes, c);
    let norm = 0;
    for (const v of c) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    chroma.push(c.map((v) => v / norm));
  }
  const sim = (i: number, j: number) => {
    let d = 0;
    for (let k = 0; k < 12; k++) d += chroma[i][k] * chroma[j][k];
    return d;
  };

  const L = HOOK_WINDOW;
  const last = n - L;
  const repetition = new Array(n).fill(0);
  for (let i = 0; i < last; i++) {
    // best three recurrences of the window starting at i, ≥16s away
    const top = [0, 0, 0];
    for (let j = 0; j < last; j++) {
      if (Math.abs(i - j) < 16) continue;
      let r = 0;
      for (let k = 0; k < L; k++) r += sim(i + k, j + k);
      r /= L;
      if (r > top[2]) {
        top[2] = r;
        top.sort((a, b) => b - a);
      }
    }
    repetition[i] = (top[0] + top[1] + top[2]) / 3;
  }

  const sustained = new Array(n).fill(0);
  for (let i = 0; i < last; i++) {
    let e = 0;
    for (let k = 0; k < L; k++) e += energy[i + k];
    sustained[i] = e / L;
  }

  const rep = minMax(repetition, 0, last);
  const eng = minMax(sustained, 0, last);
  const score = new Array(n).fill(0);
  for (let i = 0; i < last; i++) score[i] = eng[i] * (0.4 + 0.6 * rep[i]);
  return minMax(score, 0, last).map((v) => round(v, 3));
}

function minMax(a: number[], from: number, to: number): number[] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = from; i < to; i++) {
    lo = Math.min(lo, a[i]);
    hi = Math.max(hi, a[i]);
  }
  const span = hi - lo;
  return a.map((v, i) => (i >= from && i < to && span > 0 ? (v - lo) / span : 0));
}

/** Peak of the interest curve (skipping intro/outro), snapped back to a bar. */
function pickHook(
  interest: number[],
  grid: { bpm: number; anchor: number }
): number | null {
  const n = interest.length;
  if (n < 40) return null;
  let best = -1;
  let bestAt = -1;
  for (let i = 10; i < n - 20; i++) {
    if (interest[i] > best) {
      best = interest[i];
      bestAt = i;
    }
  }
  if (bestAt < 0 || best <= 0) return null;
  // the final chorus is usually the loudest, but the FIRST time the hook
  // lands is the better entry point - take the earliest near-peak moment
  for (let i = 10; i < bestAt; i++) {
    if (interest[i] >= best * 0.85) {
      bestAt = i;
      break;
    }
  }
  return Math.round(snapToBar(bestAt, grid, "before"));
}

function snapToBar(
  t: number,
  grid: { bpm: number; anchor: number },
  dir: "before" | "after"
): number {
  if (grid.bpm <= 0) return t;
  const bar = (60 / grid.bpm) * 4;
  const bars = (t - grid.anchor) / bar;
  const snapped = grid.anchor + (dir === "before" ? Math.floor(bars) : Math.ceil(bars)) * bar;
  return Math.max(0, snapped);
}

function cuePoints(
  energy: number[],
  grid: { bpm: number; anchor: number },
  duration: number
): { cueIn: number; cueOut: number } {
  const sorted = energy.filter((e) => e > 0).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  if (!median) return { cueIn: 0, cueOut: round(duration, 2) };
  let first = 0;
  while (first < energy.length && energy[first] < median * 0.3) first++;
  let lastFull = energy.length - 1;
  while (lastFull > first && avg(energy, lastFull - 3, lastFull + 1) < median * 0.55) lastFull--;
  const cueIn = snapToBar(first, grid, "after");
  const cueOut = snapToBar(lastFull, grid, "before");
  return {
    cueIn: round(cueIn < duration / 2 ? cueIn : 0, 2),
    cueOut: round(cueOut > duration / 2 ? cueOut : duration, 2),
  };
}

function avg(a: number[], from: number, to: number): number {
  let s = 0;
  let n = 0;
  for (let i = Math.max(0, from); i < Math.min(a.length, to); i++) {
    s += a[i];
    n++;
  }
  return n ? s / n : 0;
}
