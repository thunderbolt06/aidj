import { AudioBuffer } from "react-native-audio-api";
import type { TrackAnalysis } from "../types";

/**
 * Full offline analysis of a decoded track — port of the web lib/audio/analysis.ts.
 *
 * Mobile adaptations:
 *  - downsampling to 12 kHz happens in PURE JS via chunked copyFromChannel
 *    reads. It used to run through OfflineAudioContext, but on this library
 *    every OfflineAudioContext spins up a worklet runtime that is never torn
 *    down, and the rendered buffers + the decoded source they pin credit the
 *    JS heap ~180MB per analyzed track that no GC ever reclaims → OOM. The
 *    JS path allocates ~25MB of ordinary arrays that free like any object.
 *  - key detection runs on the 12 kHz mono downmix with a scaled frame size
 *    (highest analyzed note is ~988 Hz, far below the new Nyquist)
 *  - long loops yield to the event loop periodically so the UI thread's JS
 *    (touch handlers, timers) never starves for seconds at a time
 */
export async function analyzeTrack(buffer: AudioBuffer): Promise<TrackAnalysis> {
  const mono12k = await downmixTo12k(buffer);
  const sr = ANALYSIS_SR;
  // beat detection wants only the kick band — same 150 Hz lowpass the old
  // offline render applied, now a streaming biquad over the 12 kHz mono
  const lowpassed = biquadLowpass(mono12k, sr, 150, 1);

  const peaks = await findPeaks(lowpassed, sr);
  const { bpm, confidence } = tempoFromPeaks(peaks, sr);
  const beatOffset = peaks.length ? peaks[0] / sr : 0;
  const downbeatOffset = estimateDownbeat(lowpassed, sr, bpm, beatOffset);

  const key = await detectKey(mono12k, sr);

  return {
    bpm,
    beatOffset,
    downbeatOffset,
    bpmConfidence: confidence,
    energy: energyPerSecond(mono12k, sr, buffer.duration),
    loudness: integratedLoudness(mono12k),
    duration: buffer.duration,
    camelot: key.camelot,
    keyName: key.keyName,
    keyConfidence: key.keyConfidence,
  };
}

const ANALYSIS_SR = 12000;

function yieldToLoop(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/**
 * Mono downmix + box-average decimation to 12 kHz, reading the source in
 * ~5s chunks (copyFromChannel) so the full-rate channels never materialize
 * in JS. The box average doubles as a crude anti-alias filter — plenty for
 * beat energy and sub-1kHz chroma analysis.
 */
async function downmixTo12k(buffer: AudioBuffer): Promise<Float32Array> {
  const sr = buffer.sampleRate;
  const ratio = sr / ANALYSIS_SR;
  const outLen = Math.max(1, Math.floor(buffer.length / ratio));
  const out = new Float32Array(outLen);
  const stereo = buffer.numberOfChannels > 1;

  const CHUNK = Math.min(sr * 5, buffer.length);
  let chunkA = new Float32Array(CHUNK);
  let chunkB = stereo ? new Float32Array(CHUNK) : chunkA;

  let outIdx = 0;
  let acc = 0;
  let accN = 0;
  let nextBoundary = ratio;

  for (let base = 0; base < buffer.length && outIdx < outLen; base += CHUNK) {
    const n = Math.min(CHUNK, buffer.length - base);
    if (n < CHUNK) {
      // exact-size tail: native copyFromChannel copies destination.length
      // samples, so an oversized destination would read past the channel
      chunkA = new Float32Array(n);
      chunkB = stereo ? new Float32Array(n) : chunkA;
    }
    buffer.copyFromChannel(chunkA, 0, base);
    if (stereo) buffer.copyFromChannel(chunkB, 1, base);

    for (let i = 0; i < n && outIdx < outLen; i++) {
      acc += stereo ? (chunkA[i] + chunkB[i]) * 0.5 : chunkA[i];
      accN++;
      if (base + i + 1 >= nextBoundary) {
        out[outIdx++] = acc / accN;
        acc = 0;
        accN = 0;
        nextBoundary += ratio;
      }
    }
    await yieldToLoop();
  }
  return out;
}

/** RBJ-cookbook lowpass biquad, streamed over the whole array (DF2T). */
function biquadLowpass(
  data: Float32Array,
  sr: number,
  fc: number,
  q: number
): Float32Array {
  const w = (2 * Math.PI * fc) / sr;
  const cosw = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = (1 - cosw) / 2 / a0;
  const b1 = (1 - cosw) / a0;
  const b2 = b0;
  const a1 = (-2 * cosw) / a0;
  const a2 = (1 - alpha) / a0;

  const out = new Float32Array(data.length);
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    out[i] = y;
  }
  return out;
}

async function findPeaks(data: Float32Array, sr: number): Promise<number[]> {
  // threshold at 90th percentile of |amplitude|, sampled
  const sampled: number[] = [];
  for (let i = 0; i < data.length; i += 997) sampled.push(Math.abs(data[i]));
  sampled.sort((a, b) => a - b);
  const threshold = sampled[Math.floor(sampled.length * 0.9)] ?? 0.3;

  const peaks: number[] = [];
  const minGap = Math.floor(sr * 0.25); // max 240 BPM
  const chunk = sr * 30; // yield roughly every 30s of audio scanned
  let nextYield = chunk;
  let i = 0;
  while (i < data.length) {
    if (i > nextYield) {
      nextYield += chunk;
      await yieldToLoop();
    }
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

function energyPerSecond(
  data: Float32Array,
  sr: number,
  duration: number
): number[] {
  const seconds = Math.floor(duration);
  const energy: number[] = [];
  let max = 0;
  for (let s = 0; s < seconds; s++) {
    let sum = 0;
    const start = s * sr;
    const end = Math.min(start + sr, data.length);
    if (end <= start) break;
    for (let i = start; i < end; i += 4) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / ((end - start) / 4));
    energy.push(rms);
    if (rms > max) max = rms;
  }
  return energy.map((e) => (max > 0 ? +(e / max).toFixed(3) : 0));
}

/** Integrated loudness as a single linear RMS over the whole track. */
function integratedLoudness(data: Float32Array): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 61) {
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
 * Runs on the 12 kHz downmix; yields between frames to keep the app alive.
 */
async function detectKey(
  data: Float32Array,
  sr: number
): Promise<{
  camelot: string | null;
  keyName: string | null;
  keyConfidence: number;
}> {
  // ~170ms window at 12 kHz — same time-resolution class as 4096 @ 24k+
  const frameSize = 2048;

  // Goertzel coefficient per semitone, C2 (MIDI 36) .. B5 (MIDI 83).
  const notes: { pc: number; coeff: number }[] = [];
  for (let m = 36; m < 84; m++) {
    const f = 440 * Math.pow(2, (m - 69) / 12);
    const w = (2 * Math.PI * f) / sr;
    notes.push({ pc: m % 12, coeff: 2 * Math.cos(w) });
  }

  const chroma = new Array(12).fill(0);
  const totalFrames = Math.floor(data.length / frameSize);
  if (totalFrames < 4) return { camelot: null, keyName: null, keyConfidence: 0 };
  const stride = Math.max(1, Math.floor(totalFrames / 120)); // ≤120 frames

  let processed = 0;
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
    if (++processed % 8 === 0) await yieldToLoop();
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

function parseCamelot(c: string): { num: number; letter: string } | null {
  const m = /^(\d{1,2})([AB])$/.exec(c.trim().toUpperCase());
  if (!m) return null;
  return { num: parseInt(m[1], 10), letter: m[2] };
}

function wheelDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 12;
  return Math.min(d, 12 - d);
}
