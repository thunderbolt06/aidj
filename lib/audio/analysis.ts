import type { TrackAnalysis } from "@/lib/types";

/**
 * BPM detection: lowpass the signal to isolate kick energy, pick peaks,
 * histogram the intervals between them, and vote for the dominant tempo
 * folded into the 70–180 BPM range.
 */
export async function analyzeTrack(buffer: AudioBuffer): Promise<TrackAnalysis> {
  const lowpassed = await renderLowpassed(buffer);
  const data = lowpassed.getChannelData(0);
  const sr = lowpassed.sampleRate;

  const peaks = findPeaks(data, sr);
  const bpm = tempoFromPeaks(peaks, sr);
  const beatOffset = peaks.length ? peaks[0] / sr : 0;

  return {
    bpm,
    beatOffset,
    energy: energyPerSecond(buffer),
    duration: buffer.duration,
  };
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

function tempoFromPeaks(peaks: number[], sr: number): number {
  const votes = new Map<number, number>();
  for (let i = 0; i < peaks.length; i++) {
    for (let j = i + 1; j < Math.min(i + 10, peaks.length); j++) {
      let bpm = 60 / ((peaks[j] - peaks[i]) / sr);
      while (bpm < 70) bpm *= 2;
      while (bpm > 180) bpm /= 2;
      const rounded = Math.round(bpm);
      votes.set(rounded, (votes.get(rounded) ?? 0) + 1);
    }
  }
  let best = 120;
  let bestVotes = 0;
  for (const [bpm, v] of votes) {
    if (v > bestVotes) {
      best = bpm;
      bestVotes = v;
    }
  }
  return best;
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
