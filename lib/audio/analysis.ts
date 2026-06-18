import type { TrackAnalysis } from "@/lib/types";

/**
 * Full offline analysis of a decoded track:
 *  - BPM (lowpass → peak-interval voting) + a confidence score
 *  - first-beat offset and an estimated downbeat (bar-1) phase
 *  - per-second normalized energy
 *  - integrated loudness (for level-matching trim in the engine)
 *  - musical key via chromagram → Krumhansl-Schmuckler → Camelot code
 */
export async function analyzeTrack(buffer: AudioBuffer): Promise<TrackAnalysis> {
  const lowpassed = await renderLowpassed(buffer);
  const data = lowpassed.getChannelData(0);
  const sr = lowpassed.sampleRate;

  const peaks = findPeaks(data, sr);
  const { bpm, confidence } = tempoFromPeaks(peaks, sr);
  const beatOffset = peaks.length ? peaks[0] / sr : 0;
  const downbeatOffset = estimateDownbeat(data, sr, bpm, beatOffset);

  const key = detectKey(buffer);

  return {
    bpm,
    beatOffset,
    downbeatOffset,
    bpmConfidence: confidence,
    energy: energyPerSecond(buffer),
    loudness: integratedLoudness(buffer),
    duration: buffer.duration,
    camelot: key.camelot,
    keyName: key.keyName,
    keyConfidence: key.keyConfidence,
  };
}

/**
 * Seconds until the next phrase boundary from `position`, on a grid anchored
 * at the estimated downbeat (falls back to the first beat). Pop/dance phrases
 * are 4 or 8 bars; 16 beats (4 bars) keeps the wait tolerable (max ~8s at 120 BPM).
 */
export function timeToNextPhrase(
  analysis: { bpm: number; beatOffset: number; downbeatOffset?: number },
  position: number,
  beatsPerPhrase = 16
): number {
  if (analysis.bpm <= 0) return 0;
  const anchor = analysis.downbeatOffset ?? analysis.beatOffset;
  const beatLen = 60 / analysis.bpm;
  const phraseLen = beatLen * beatsPerPhrase;
  const sincePhrase = (position - anchor) % phraseLen;
  const wait = (phraseLen - sincePhrase) % phraseLen;
  // if the boundary is closer than a beat, take the following one so the
  // transition has time to schedule cleanly
  return wait < beatLen ? wait + phraseLen : wait;
}

async function renderLowpassed(buffer: AudioBuffer): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(1, buffer.length, buffer.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 150;
  lp.Q.value = 1;
  src.connect(lp).connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

function findPeaks(data: Float32Array, sr: number): number[] {
  // threshold at 90th percentile of |amplitude|, sampled
  const sampled: number[] = [];
  for (let i = 0; i < data.length; i += 997) sampled.push(Math.abs(data[i]));
  sampled.sort((a, b) => a - b);
  const threshold = sampled[Math.floor(sampled.length * 0.9)] ?? 0.3;

  const peaks: number[] = [];
  const minGap = Math.floor(sr * 0.25); // max 240 BPM
  let i = 0;
  while (i < data.length) {
    if (Math.abs(data[i]) > threshold) {
      // local max within the gap window
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

function tempoFromPeaks(
  peaks: number[],
  sr: number
): { bpm: number; confidence: number } {
  const votes = new Map<number, number>();
  let total = 0;
  for (let i = 0; i < peaks.length; i++) {
    for (let j = i + 1; j < Math.min(i + 10, peaks.length); j++) {
      let bpm = 60 / ((peaks[j] - peaks[i]) / sr);
      while (bpm < 70) bpm *= 2;
      while (bpm > 180) bpm /= 2;
      const rounded = Math.round(bpm);
      votes.set(rounded, (votes.get(rounded) ?? 0) + 1);
      total++;
    }
  }
  // pool ±1 BPM neighbours so a smeared peak doesn't split the vote
  let best = 120;
  let bestVotes = 0;
  for (const [bpm] of votes) {
    const v =
      (votes.get(bpm) ?? 0) +
      (votes.get(bpm - 1) ?? 0) +
      (votes.get(bpm + 1) ?? 0);
    if (v > bestVotes) {
      best = bpm;
      bestVotes = v;
    }
  }
  return { bpm: best, confidence: total > 0 ? +(bestVotes / total).toFixed(3) : 0 };
}

/**
 * Estimate which of the 4 beats in a bar is the downbeat by measuring which
 * beat-phase carries the most low-frequency (kick) energy across the track.
 * Returns the offset of that phase so phrase quantization snaps to bar 1.
 */
function estimateDownbeat(
  data: Float32Array,
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
      if (idx + win >= data.length) break;
      let e = 0;
      for (let i = 0; i < win; i++) e += Math.abs(data[idx + i]);
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

function energyPerSecond(buffer: AudioBuffer): number[] {
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const seconds = Math.floor(buffer.duration);
  const energy: number[] = [];
  let max = 0;
  for (let s = 0; s < seconds; s++) {
    let sum = 0;
    const start = s * sr;
    const end = Math.min(start + sr, data.length);
    for (let i = start; i < end; i += 7) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / ((end - start) / 7));
    energy.push(rms);
    if (rms > max) max = rms;
  }
  return energy.map((e) => (max > 0 ? +(e / max).toFixed(3) : 0));
}

/** Integrated loudness as a single linear RMS over the whole track. */
function integratedLoudness(buffer: AudioBuffer): number {
  const data = buffer.getChannelData(0);
  let sum = 0;
  let n = 0;
  // decimate heavily — we only need a stable average level
  for (let i = 0; i < data.length; i += 257) {
    sum += data[i] * data[i];
    n++;
  }
  return n > 0 ? +Math.sqrt(sum / n).toFixed(5) : 0;
}

// ── Key detection ──────────────────────────────────────────────────────────

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
// Camelot wheel numbers indexed by tonic pitch class (C=0).
const MAJ_CAMELOT = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const MIN_CAMELOT = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
// Krumhansl-Schmuckler key profiles.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/**
 * Detect musical key with a Goertzel-filter chromagram correlated against the
 * 24 Krumhansl-Schmuckler major/minor profiles. Pure JS, no FFT dependency.
 */
function detectKey(buffer: AudioBuffer): {
  camelot: string | null;
  keyName: string | null;
  keyConfidence: number;
} {
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const frameSize = 4096;

  // Goertzel coefficient per semitone, C2 (MIDI 36) .. B5 (MIDI 83) — 4 octaves.
  const notes: { pc: number; coeff: number }[] = [];
  for (let m = 36; m < 84; m++) {
    const f = 440 * Math.pow(2, (m - 69) / 12);
    const w = (2 * Math.PI * f) / sr;
    notes.push({ pc: m % 12, coeff: 2 * Math.cos(w) });
  }

  const chroma = new Array(12).fill(0);
  const totalFrames = Math.floor(data.length / frameSize);
  if (totalFrames < 4) return { camelot: null, keyName: null, keyConfidence: 0 };
  const stride = Math.max(1, Math.floor(totalFrames / 240)); // ≤240 frames

  for (let fr = 0; fr + frameSize <= data.length; fr += frameSize * stride) {
    for (const note of notes) {
      let s1 = 0;
      let s2 = 0;
      for (let i = 0; i < frameSize; i++) {
        const s = data[fr + i] + note.coeff * s1 - s2;
        s2 = s1;
        s1 = s;
      }
      const power = s1 * s1 + s2 * s2 - note.coeff * s1 * s2;
      if (power > 0) chroma[note.pc] += Math.sqrt(power);
    }
  }

  let max = 0;
  for (const v of chroma) max = Math.max(max, v);
  if (max <= 0) return { camelot: null, keyName: null, keyConfidence: 0 };
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
    keyConfidence: +Math.max(0, best.score).toFixed(3),
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

/**
 * Harmonic compatibility on the Camelot wheel: same code, relative
 * major/minor (same number, swapped letter), or ±1 around the wheel.
 */
export function camelotCompatible(a: string | null, b: string | null): boolean {
  if (!a || !b) return true; // unknown key → don't block
  const pa = parseCamelot(a);
  const pb = parseCamelot(b);
  if (!pa || !pb) return true;
  if (pa.letter === pb.letter) {
    const diff = wheelDiff(pa.num, pb.num);
    return diff <= 1;
  }
  // relative major/minor only when the numbers match
  return pa.num === pb.num;
}

/** 0 = identical/relative, higher = more dissonant; used to rank picks. */
export function camelotDistance(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const pa = parseCamelot(a);
  const pb = parseCamelot(b);
  if (!pa || !pb) return 0;
  const numDiff = wheelDiff(pa.num, pb.num);
  const letterDiff = pa.letter === pb.letter ? 0 : 1;
  return numDiff + (numDiff === 0 ? 0 : letterDiff);
}

function parseCamelot(c: string): { num: number; letter: string } | null {
  const m = /^(\d{1,2})([AB])$/.exec(c.trim().toUpperCase());
  if (!m) return null;
  return { num: parseInt(m[1], 10), letter: m[2] };
}

function wheelDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 12;
  return Math.min(d, 12 - d);
}
