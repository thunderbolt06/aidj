import type { TrackAnalysis } from "@/lib/types";
import type { BeatInfo, VizFrame, VizInputs } from "@/lib/viz/types";

/**
 * Turns an AnalyserNode + the track's beat grid into a per-frame `VizFrame`.
 *
 * Two clocks feed the visuals:
 *  - the FFT (band energies, onset, chroma) reacts to what is actually playing;
 *  - the *beat grid* (bpm, beatOffset, downbeatOffset from analysis) plus the
 *    audio playhead give a smooth, predictive beat/bar phase so animations can
 *    pulse exactly on the beat even between audio frames - like the RGB lights
 *    on a keyboard locking to the groove.
 */
export class VizDriver {
  private freq: Uint8Array<ArrayBuffer>;
  private wave: Uint8Array<ArrayBuffer>;
  private prevLowFlux: Float32Array;
  private fluxAvg = 0;
  private onsetEnv = 0;
  private bands = { low: 0, mid: 0, high: 0, level: 0 };
  private chroma = new Array(12).fill(0);
  private lastClock = 0;
  private startedAt = 0;
  private prevBeat = -1;
  private prevBar = -1;
  private prevAnalysis: TrackAnalysis | null = null;

  constructor(private analyser: AnalyserNode) {
    const bins = analyser.frequencyBinCount;
    this.freq = new Uint8Array(bins);
    this.wave = new Uint8Array(analyser.fftSize);
    this.prevLowFlux = new Float32Array(bins);
  }

  /** binHz = sampleRate / fftSize. */
  private get binHz() {
    return this.analyser.context.sampleRate / this.analyser.fftSize;
  }

  private bandAvg(loHz: number, hiHz: number): number {
    const bh = this.binHz;
    const lo = Math.max(1, Math.floor(loHz / bh));
    const hi = Math.min(this.freq.length - 1, Math.ceil(hiHz / bh));
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += this.freq[i];
    return sum / Math.max(1, hi - lo + 1) / 255;
  }

  /** Asymmetric smoothing: snap up fast, fall slow (feels musical). */
  private static smooth(prev: number, next: number, attack = 0.55, release = 0.12) {
    return prev + (next - prev) * (next > prev ? attack : release);
  }

  private updateOnset() {
    // Spectral flux over the low/low-mid bins (where kicks/snares live).
    const top = Math.min(this.freq.length, Math.floor(4000 / this.binHz));
    let flux = 0;
    for (let i = 1; i < top; i++) {
      const d = this.freq[i] - this.prevLowFlux[i];
      if (d > 0) flux += d;
      this.prevLowFlux[i] = this.freq[i];
    }
    flux /= top * 255;
    this.fluxAvg = this.fluxAvg * 0.93 + flux * 0.07;
    const raw = Math.max(0, (flux - this.fluxAvg * 1.35) / (this.fluxAvg + 0.02));
    this.onsetEnv = Math.max(this.onsetEnv * 0.84, Math.min(1, raw));
  }

  private updateChroma() {
    const bh = this.binHz;
    const acc = new Array(12).fill(0);
    const loBin = Math.max(1, Math.floor(65 / bh));
    const hiBin = Math.min(this.freq.length - 1, Math.floor(5000 / bh));
    for (let i = loBin; i <= hiBin; i++) {
      const mag = this.freq[i] / 255;
      if (mag < 0.04) continue;
      const freq = i * bh;
      const midi = 69 + 12 * Math.log2(freq / 440);
      const pc = (((Math.round(midi) % 12) + 12) % 12);
      acc[pc] += mag * mag;
    }
    const max = Math.max(1e-6, ...acc);
    for (let i = 0; i < 12; i++) {
      this.chroma[i] = VizDriver.smooth(this.chroma[i], acc[i] / max, 0.4, 0.08);
    }
  }

  private beatClock(analysis: TrackAnalysis | null, pos: number): BeatInfo {
    if (!analysis || analysis.bpm <= 0) {
      return {
        bpm: 0, confidence: 0, beat: 0, beatPhase: 0, bar: 0,
        barPhase: 0, beatPulse: 0, hit: 0, beatHit: false, barHit: false,
      };
    }
    const beatLen = 60 / analysis.bpm;
    const beatsTotal = (pos - (analysis.beatOffset ?? 0)) / beatLen;
    const beat = Math.floor(beatsTotal);
    const beatPhase = beatsTotal - beat;
    const barLen = beatLen * 4;
    const barsTotal = (pos - (analysis.downbeatOffset ?? analysis.beatOffset ?? 0)) / barLen;
    const bar = Math.floor(barsTotal);
    const barPhase = barsTotal - bar;
    // reset hit detection when the track (and thus grid) changes
    if (analysis !== this.prevAnalysis) {
      this.prevBeat = beat;
      this.prevBar = bar;
      this.prevAnalysis = analysis;
    }
    const beatHit = beat !== this.prevBeat;
    const barHit = bar !== this.prevBar;
    this.prevBeat = beat;
    this.prevBar = bar;
    return {
      bpm: analysis.bpm,
      confidence: analysis.bpmConfidence ?? 0,
      beat,
      beatPhase: beatPhase < 0 ? 0 : beatPhase,
      bar,
      barPhase: barPhase < 0 ? 0 : barPhase,
      beatPulse: Math.pow(1 - (beatPhase < 0 ? 0 : beatPhase), 1.7),
      hit: 0, // filled in frame() once onset/low are known
      beatHit,
      barHit,
    };
  }

  /**
   * The pulse the visuals should flash on. Trust the predictive grid in
   * proportion to BPM confidence; as confidence falls, fall back to the live
   * audio (transient onset + low-end kicks) so a shaky/drifting grid no longer
   * injects wrong-time flashes and real beats stop going missing.
   */
  private beatHitLevel(beat: BeatInfo, onset: number, low: number): number {
    const grid = beat.beatPulse * beat.confidence;
    // squaring `low` lowers the sustained floor between kicks while keeping the
    // peak, so the fallback still feels like a beat (snap) rather than a throb
    const audioFloor = (1 - beat.confidence) * low * low;
    return Math.min(1, Math.max(grid, onset, audioFloor));
  }

  /** Build the frame. `now` is performance.now() in ms; w/h/dpr from canvas. */
  frame(now: number, w: number, h: number, dpr: number, inp: VizInputs): VizFrame {
    if (!this.startedAt) this.startedAt = now;
    const clock = (now - this.startedAt) / 1000;
    const dt = this.lastClock ? Math.min(0.1, clock - this.lastClock) : 0;
    this.lastClock = clock;

    this.analyser.getByteFrequencyData(this.freq);
    this.analyser.getByteTimeDomainData(this.wave);

    this.bands.low = VizDriver.smooth(this.bands.low, this.bandAvg(30, 250));
    this.bands.mid = VizDriver.smooth(this.bands.mid, this.bandAvg(250, 2500));
    this.bands.high = VizDriver.smooth(this.bands.high, this.bandAvg(2500, 14000));
    this.bands.level = VizDriver.smooth(
      this.bands.level,
      (this.bands.low + this.bands.mid + this.bands.high) / 3,
      0.5,
      0.1
    );
    this.updateOnset();
    this.updateChroma();

    let chromaRoot = 0;
    for (let i = 1; i < 12; i++) if (this.chroma[i] > this.chroma[chromaRoot]) chromaRoot = i;

    const beat = this.beatClock(inp.analysis, inp.position);
    beat.hit = this.beatHitLevel(beat, this.onsetEnv, this.bands.low);

    return {
      t: inp.position,
      dt,
      clock,
      w,
      h,
      dpr,
      low: this.bands.low,
      mid: this.bands.mid,
      high: this.bands.high,
      level: this.bands.level,
      onset: this.onsetEnv,
      beat,
      spectrum: this.freq,
      waveform: this.wave,
      chroma: this.chroma,
      chromaRoot,
      key: {
        camelot: inp.analysis?.camelot ?? null,
        keyName: inp.analysis?.keyName ?? null,
        hue: keyToHue(inp.analysis?.camelot ?? null, inp.params.hue),
      },
      arc: inp.arc,
      track: inp.track,
      params: inp.params,
    };
  }
}

/**
 * Map a Camelot code ("8A" / "11B") to a base hue around the wheel, so each
 * musical key gets its own consistent color. Falls back to the param hue.
 */
export function keyToHue(camelot: string | null, fallback: number): number {
  if (!camelot) return fallback;
  const m = /^(\d{1,2})([AB])$/.exec(camelot.trim());
  if (!m) return fallback;
  const num = parseInt(m[1], 10);
  const minor = m[2] === "A";
  // distribute the 12 wheel positions around the color wheel; minor keys
  // sit a touch cooler than their relative major
  const base = ((num - 1) / 12) * 360;
  return (base + (minor ? 18 : 0)) % 360;
}

/** Convenience: pitch class (0=C..11=B) → hue, for chord-reactive coloring. */
export function pitchClassHue(pc: number): number {
  // circle of fifths spreads neighbouring chords to distinct colors
  const fifths = (pc * 7) % 12;
  return (fifths / 12) * 360;
}

/** HSL → CSS string helper used across canvas templates. */
export function hsl(h: number, s: number, l: number, a = 1): string {
  return `hsla(${((h % 360) + 360) % 360}, ${s}%, ${l}%, ${a})`;
}
