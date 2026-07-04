import {
  AudioContext,
  AudioBuffer,
  AudioBufferSourceNode,
  BiquadFilterNode,
  DelayNode,
  GainNode,
  AudioParam,
} from "react-native-audio-api";
import type { TrackAnalysis, TransitionPlan } from "../types";

/**
 * Dual-deck DJ engine — port of the web lib/audio/engine.ts onto
 * react-native-audio-api (same Web Audio graph, native render thread).
 *
 * Graph per deck:
 *   BufferSource -> low/mid/high EQ (biquads) -> deck gain -> trim -> master
 * Plus a shared feedback-delay send used by the echo_out transition.
 *
 * Home-feature subset: recording, mashup, stems and lyric-stutter paths from
 * the web engine are intentionally not ported.
 */

class Deck {
  buffer: AudioBuffer | null = null;
  source: AudioBufferSourceNode | null = null;
  readonly low: BiquadFilterNode;
  readonly mid: BiquadFilterNode;
  readonly high: BiquadFilterNode;
  readonly gain: GainNode;
  /** Static per-track level trim (loudness normalization). */
  readonly trim: GainNode;
  readonly echoSend: GainNode;
  /** ctx.currentTime when playback started, minus the track offset. */
  private startedAt = 0;
  playing = false;

  constructor(private ctx: AudioContext, master: GainNode, echoBus: DelayNode) {
    this.low = ctx.createBiquadFilter();
    this.low.type = "lowshelf";
    this.low.frequency.value = 250;
    this.mid = ctx.createBiquadFilter();
    this.mid.type = "peaking";
    this.mid.frequency.value = 1200;
    this.mid.Q.value = 0.8;
    this.high = ctx.createBiquadFilter();
    this.high.type = "highshelf";
    this.high.frequency.value = 4000;
    this.gain = ctx.createGain();
    this.trim = ctx.createGain();
    this.trim.gain.value = 1;
    this.echoSend = ctx.createGain();
    this.echoSend.gain.value = 0;

    // low→mid→high→gain (fades, 0..1) → trim (level-match) → master
    this.low.connect(this.mid);
    this.mid.connect(this.high);
    this.high.connect(this.gain);
    this.gain.connect(this.trim);
    this.trim.connect(master);
    this.trim.connect(this.echoSend);
    this.echoSend.connect(echoBus);
  }

  /** Set the loudness-normalization trim for this track (smoothed). */
  setTrim(v: number) {
    this.trim.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  /** Start playback at context time `when`, from `offset` seconds into the track. */
  play(when: number, offset: number, rate = 1) {
    if (!this.buffer) throw new Error("deck has no buffer");
    this.stopSource();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = rate;
    src.connect(this.low);
    src.start(when, offset);
    this.source = src;
    this.startedAt = when - offset / rate;
    this.playing = true;
    src.onEnded = () => {
      if (this.source === src) this.playing = false;
    };
  }

  position(): number {
    if (!this.playing || !this.source) return 0;
    const rate = this.source.playbackRate.value;
    return (this.ctx.currentTime - this.startedAt) * rate;
  }

  rate(): number {
    return this.source?.playbackRate.value ?? 1;
  }

  /** Exact AudioContext time at which the playhead reaches `trackPos`. */
  ctxTimeAt(trackPos: number): number {
    return this.startedAt + trackPos / this.rate();
  }

  /** Track position at AudioContext time `t`. */
  posAt(t: number): number {
    return (t - this.startedAt) * this.rate();
  }

  stopSource(when = 0) {
    try {
      this.source?.stop(when);
    } catch {
      /* already stopped */
    }
    this.source = null;
    this.playing = false;
  }

  resetFx(at: number) {
    for (const p of [this.low.gain, this.mid.gain, this.high.gain]) {
      p.cancelScheduledValues(at);
      p.setValueAtTime(0, at);
    }
    this.echoSend.gain.cancelScheduledValues(at);
    this.echoSend.gain.setValueAtTime(0, at);
  }
}

export class DJEngine {
  readonly ctx: AudioContext;
  private master: GainNode;
  private decks: [Deck, Deck];
  private active = 0;
  /** True while the user has deliberately paused - blocks passive auto-resume. */
  private userPaused = false;
  /** Called when a transition completes, with the new active deck index. */
  onTransitionEnd: (() => void) | null = null;

  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);

    // shared echo bus: delay with feedback, into master
    const delay = this.ctx.createDelay(2);
    delay.delayTime.value = 0.375;
    const feedback = this.ctx.createGain();
    feedback.gain.value = 0.45;
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(this.master);

    this.decks = [
      new Deck(this.ctx, this.master, delay),
      new Deck(this.ctx, this.master, delay),
    ];
    this.decks[1].gain.gain.value = 0;
  }

  get activeDeck() {
    return this.decks[this.active];
  }
  get nextDeck() {
    return this.decks[1 - this.active];
  }

  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.ctx.decodeAudioData(data);
  }

  /** Explicit resume (user action or startup) - clears the pause flag. */
  async resume() {
    this.userPaused = false;
    if (this.ctx.state !== "running") await this.ctx.resume();
  }

  /**
   * Passive/incidental resume - interruption recovery, app foregrounding.
   * Does nothing if the user deliberately paused.
   */
  async autoResume() {
    if (this.userPaused || this.ctx.state === "running") return;
    await this.ctx.resume();
  }

  /** Freeze the whole mix in place (suspends the AudioContext clock). */
  async pause() {
    this.userPaused = true;
    if (this.ctx.state === "running") await this.ctx.suspend();
  }

  /** Load + immediately play a track on the active deck. */
  startTrack(buffer: AudioBuffer, offset = 0, analysis?: TrackAnalysis) {
    const deck = this.activeDeck;
    deck.buffer = buffer;
    deck.resetFx(this.ctx.currentTime);
    deck.trim.gain.setValueAtTime(
      trimGainFromLoudness(analysis?.loudness),
      this.ctx.currentTime
    );
    deck.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    deck.gain.gain.setValueAtTime(1, this.ctx.currentTime);
    this.nextDeck.gain.gain.setValueAtTime(0, this.ctx.currentTime);
    deck.play(this.ctx.currentTime + 0.05, offset);
  }

  position(): number {
    return this.activeDeck.position();
  }

  stop() {
    this.decks.forEach((d) => d.stopSource());
  }

  /**
   * Seek within the active deck's track with a vinyl-scratch transition:
   * a short slice of the record "rubs" with a fast rate sweep, then playback
   * slams in at the target position. Returns the clamped seek position.
   */
  scratchSeek(sec: number): number {
    const deck = this.activeDeck;
    const buf = deck.buffer;
    if (!buf) return 0;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const from = deck.position();
    const target = Math.min(Math.max(0, sec), Math.max(0, buf.duration - 0.5));
    const rubLen = 0.18;

    // the rub: a slice of the track at the CURRENT playhead, direction-aware
    const back = target < from;
    const sliceStart = back
      ? Math.max(0, from - rubLen)
      : Math.min(from, buf.duration - rubLen);
    const rub = ctx.createBufferSource();
    rub.buffer = back ? this.reversedSlice(buf, sliceStart, rubLen) : buf;
    // sweep the rate up like a hand dragging the platter
    rub.playbackRate.setValueAtTime(1, now);
    rub.playbackRate.exponentialRampToValueAtTime(2.4, now + rubLen);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, now);
    g.gain.linearRampToValueAtTime(0, now + rubLen);
    rub.connect(g);
    g.connect(this.master);
    if (back) rub.start(now);
    else rub.start(now, sliceStart);
    rub.stop(now + rubLen + 0.02);
    setTimeout(() => {
      try {
        g.disconnect();
      } catch {
        /* already gone */
      }
    }, (rubLen + 0.5) * 1000);

    // deck ducks through the rub, then slams back in at the target
    const dg = deck.gain.gain;
    dg.cancelScheduledValues(now);
    dg.setValueAtTime(dg.value, now);
    dg.linearRampToValueAtTime(0, now + 0.04);
    dg.setValueAtTime(1, now + rubLen);
    deck.play(now + rubLen, target);
    return target;
  }

  /**
   * AudioContext time of the next phrase boundary on the ACTIVE deck's beat
   * grid, at least `minLead` seconds away - the moment a drop should land.
   */
  nextGridTime(from: TrackAnalysis, quantBeats: number, minLead = 0.08): number {
    const A = this.activeDeck;
    if (!A.playing || from.bpm <= 0) return this.ctx.currentTime + minLead;
    const anchor = from.downbeatOffset ?? from.beatOffset;
    const beatLen = 60 / from.bpm;
    const phrase = beatLen * Math.max(quantBeats, 1);
    const minPos = A.posAt(this.ctx.currentTime + minLead);
    const k = Math.ceil((minPos - anchor) / phrase);
    return A.ctxTimeAt(anchor + k * phrase);
  }

  /** Seconds until the next quantized drop (for UI countdowns). */
  timeToDrop(from: TrackAnalysis, quantBeats: number, minLead = 0.08): number {
    return this.nextGridTime(from, quantBeats, minLead) - this.ctx.currentTime;
  }

  private noiseBuffer: AudioBuffer | null = null;
  private getNoise(): AudioBuffer {
    if (!this.noiseBuffer) {
      const sr = this.ctx.sampleRate;
      const buf = this.ctx.createBuffer(1, sr * 2, sr);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      // copyToChannel makes sure the native buffer sees the writes
      buf.copyToChannel(d, 0);
      this.noiseBuffer = buf;
    }
    return this.noiseBuffer;
  }

  /** A short sub-bass thump one-shot - punctuates silence_drop. */
  private impact(at: number) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource();
    s.buffer = this.getNoise();
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(180, at);
    lp.frequency.exponentialRampToValueAtTime(55, at + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.3);
    s.connect(lp);
    lp.connect(g);
    g.connect(this.master);
    s.start(at);
    s.stop(at + 0.35);
  }

  /**
   * Build a reversed AudioBuffer of `lenSec` starting at `startSec`.
   * copyFromChannel, NOT getChannelData: the latter materializes the WHOLE
   * channel as a JS-heap-visible Float32Array (~50MB per channel of a full
   * track), which OOM'd the Hermes heap when a seek fired near its limit.
   */
  private reversedSlice(buf: AudioBuffer, startSec: number, lenSec: number): AudioBuffer {
    const sr = buf.sampleRate;
    const start = Math.min(Math.max(0, Math.floor(startSec * sr)), Math.max(0, buf.length - 1));
    const len = Math.max(1, Math.min(Math.floor(lenSec * sr), buf.length - start));
    const out = this.ctx.createBuffer(buf.numberOfChannels, len, sr);
    const fwd = new Float32Array(len);
    const rev = new Float32Array(len);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      buf.copyFromChannel(fwd, ch, start);
      for (let i = 0; i < len; i++) rev[i] = fwd[len - 1 - i];
      out.copyToChannel(rev, ch);
    }
    return out;
  }

  /**
   * Execute a transition from the active deck to `nextBuffer` per the plan.
   *
   * Everything is scheduled on the AudioContext clock against a single anchor
   * `t0` - the moment B enters. With `quantizeBeats` set, t0 snaps to A's
   * beat grid and pre-roll effects (loop roll, brake, riser) are scheduled
   * BEFORE it so the drop lands on the phrase. B's inPoint additionally snaps
   * to B's own beat grid. Returns the context time the transition completes.
   */
  transition(
    nextBuffer: AudioBuffer,
    plan: TransitionPlan,
    analyses?: { from: TrackAnalysis; to: TrackAnalysis },
    opts?: {
      /** Snap the drop to A's grid: phrase length in beats (e.g. 16). */
      quantizeBeats?: number;
    }
  ): number {
    const ctx = this.ctx;
    const A = this.activeDeck;
    const B = this.nextDeck;
    const dur = Math.max(0.05, plan.duration);

    // no stems on mobile: degrade the stem-flavored styles before scheduling
    if (plan.style === "stem_acapella") plan.style = "echo_out";

    const aRate = A.rate();
    const aBeat = analyses?.from.bpm ? 60 / analyses.from.bpm : 0.5;
    const beatCtx = aBeat / aRate; // one A-beat in wall-clock seconds

    // pre-roll: how long the trick needs BEFORE B enters
    const preRoll =
      plan.style === "loop_roll" ||
      plan.style === "riser" ||
      plan.style === "gate"
        ? 4 * beatCtx
        : plan.style === "backspin"
          ? 2 * beatCtx
          : plan.style === "brake"
            ? 1.5 * beatCtx
            : plan.style === "tape_stop" || plan.style === "silence_drop"
              ? 1 * beatCtx
              : 0;

    // anchor: B's entry, snapped to A's beat grid when quantizing
    const t0 =
      opts?.quantizeBeats && analyses?.from && A.playing
        ? this.nextGridTime(analyses.from, opts.quantizeBeats, preRoll + 0.08)
        : ctx.currentTime + preRoll + 0.08;
    const end = t0 + dur;

    B.buffer = nextBuffer;
    B.resetFx(ctx.currentTime);
    B.trim.gain.setValueAtTime(
      trimGainFromLoudness(analyses?.to.loudness),
      ctx.currentTime
    );

    // beat-match: play B at A's tempo, then glide to native tempo
    let rate = 1;
    if (plan.beatMatch && analyses && analyses.to.bpm > 0) {
      rate = analyses.from.bpm / analyses.to.bpm;
      if (rate < 0.92 || rate > 1.08) rate = 1;
    }

    // snap B's entry onto B's own beat grid (anchored on its downbeat)
    let inPoint = Math.max(0, plan.inPoint);
    if (analyses && analyses.to.bpm > 0) {
      const bAnchor = analyses.to.downbeatOffset ?? analyses.to.beatOffset;
      const bBeat = 60 / analyses.to.bpm;
      inPoint = Math.max(
        0,
        bAnchor + Math.round((inPoint - bAnchor) / bBeat) * bBeat
      );
    }

    B.play(t0, inPoint, rate);
    if (rate !== 1 && B.source) {
      B.source.playbackRate.setValueAtTime(rate, end);
      B.source.playbackRate.linearRampToValueAtTime(1, end + 4);
    }

    const aGain = A.gain.gain;
    const bGain = B.gain.gain;
    const now = ctx.currentTime;
    aGain.cancelScheduledValues(now);
    bGain.cancelScheduledValues(now);
    aGain.setValueAtTime(aGain.value, now);
    bGain.setValueAtTime(0, now);

    let aStopAt = end + 3;

    switch (plan.style) {
      // vocal_throw needs a word buffer (stems); forced here it degrades to a cut
      case "vocal_throw":
      case "cut": {
        aGain.setValueAtTime(aGain.value, t0 - 0.01);
        aGain.linearRampToValueAtTime(0, t0 + 0.02);
        bGain.setValueAtTime(1, t0);
        aStopAt = t0 + 0.3;
        break;
      }
      case "crossfade": {
        equalPowerFade(aGain, bGain, t0, dur);
        break;
      }
      case "bass_swap": {
        B.low.gain.setValueAtTime(-24, t0);
        equalPowerFade(aGain, bGain, t0, dur);
        // swap the low end exactly on a beat near the midpoint
        const mid = t0 + Math.max(1, Math.round(dur / 2 / beatCtx)) * beatCtx;
        A.low.gain.setValueAtTime(0, mid);
        A.low.gain.linearRampToValueAtTime(-24, mid + 0.12);
        B.low.gain.setValueAtTime(-24, mid);
        B.low.gain.linearRampToValueAtTime(0, mid + 0.12);
        break;
      }
      case "filter_sweep": {
        A.low.gain.setValueAtTime(0, t0);
        A.low.gain.linearRampToValueAtTime(-30, end);
        A.mid.gain.setValueAtTime(0, t0);
        A.mid.gain.linearRampToValueAtTime(-18, end);
        equalPowerFade(aGain, bGain, t0, dur);
        break;
      }
      case "echo_out": {
        A.echoSend.gain.setValueAtTime(0, t0);
        A.echoSend.gain.linearRampToValueAtTime(0.9, t0 + dur * 0.3);
        aGain.setValueAtTime(aGain.value, t0);
        aGain.linearRampToValueAtTime(0, t0 + dur * 0.45);
        bGain.setValueAtTime(0, t0);
        bGain.linearRampToValueAtTime(1, t0 + dur * 0.5);
        break;
      }
      case "loop_roll": {
        // classic roll: 1-beat loop ×2, half-beat ×2, quarter-beat ×4 - then slam
        const rollStart = t0 - 4 * beatCtx;
        const p = A.posAt(rollStart);
        if (A.buffer && p > 0) {
          A.stopSource(rollStart);
          const seg = (loopLen: number, from: number, until: number) => {
            const s = ctx.createBufferSource();
            s.buffer = A.buffer!;
            s.loop = true;
            s.loopStart = p;
            s.loopEnd = p + loopLen;
            s.playbackRate.value = aRate;
            s.connect(A.low);
            s.start(from, p);
            s.stop(until);
            return s;
          };
          seg(aBeat, rollStart, rollStart + 2 * beatCtx);
          seg(aBeat / 2, rollStart + 2 * beatCtx, rollStart + 3 * beatCtx);
          A.source = seg(aBeat / 4, rollStart + 3 * beatCtx, t0 + 0.02);
          A.echoSend.gain.setValueAtTime(0.1, rollStart);
          A.echoSend.gain.linearRampToValueAtTime(0.55, t0);
          A.echoSend.gain.setTargetAtTime(0, t0 + 0.05, 0.15);
        }
        aGain.setValueAtTime(aGain.value, t0 - 0.01);
        aGain.linearRampToValueAtTime(0, t0 + 0.03);
        bGain.setValueAtTime(1, t0);
        aStopAt = t0 + 0.3;
        break;
      }
      case "brake": {
        // vinyl brake: the record grinds to a halt, then the drop slams
        const brakeStart = t0 - 1.5 * beatCtx;
        if (A.source) {
          A.source.playbackRate.cancelScheduledValues(now);
          A.source.playbackRate.setValueAtTime(aRate, brakeStart);
          A.source.playbackRate.exponentialRampToValueAtTime(0.02, t0);
        }
        A.echoSend.gain.setValueAtTime(0.1, brakeStart);
        A.echoSend.gain.linearRampToValueAtTime(0.4, t0);
        A.echoSend.gain.setTargetAtTime(0, t0 + 0.05, 0.2);
        aGain.setValueAtTime(aGain.value, t0 - 0.05);
        aGain.linearRampToValueAtTime(0, t0 + 0.02);
        bGain.setValueAtTime(1, t0);
        aStopAt = t0 + 0.3;
        break;
      }
      case "riser": {
        // white-noise sweep + bass pull-out building 4 beats into a hard drop
        const riseStart = t0 - 4 * beatCtx;
        const noise = ctx.createBufferSource();
        noise.buffer = this.getNoise();
        noise.loop = true;
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.Q.value = 1.2;
        bp.frequency.setValueAtTime(350, riseStart);
        bp.frequency.exponentialRampToValueAtTime(5500, t0);
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(0.0001, riseStart);
        ng.gain.exponentialRampToValueAtTime(0.4, t0 - 0.02);
        ng.gain.setValueAtTime(0, t0);
        noise.connect(bp);
        bp.connect(ng);
        ng.connect(this.master);
        noise.start(riseStart);
        noise.stop(t0 + 0.05);
        // bass drains out of A through the rise - the floor falls away
        A.low.gain.setValueAtTime(0, riseStart);
        A.low.gain.linearRampToValueAtTime(-26, t0);
        aGain.setValueAtTime(aGain.value, t0 - 0.01);
        aGain.linearRampToValueAtTime(0, t0 + 0.02);
        bGain.setValueAtTime(1, t0);
        aStopAt = t0 + 0.3;
        break;
      }
      case "double_drop": {
        // both hooks slam together for 8 beats, then A bows out
        bGain.setValueAtTime(1, t0);
        A.low.gain.setValueAtTime(-8, t0); // make room for B's low end
        const out = t0 + 8 * beatCtx;
        aGain.setValueAtTime(aGain.value, out);
        aGain.linearRampToValueAtTime(0, out + beatCtx);
        aStopAt = out + beatCtx + 0.3;
        break;
      }
      case "silence_drop": {
        // cut everything for the last beat (dead air), then B slams on the 1
        const cutAt = t0 - 1 * beatCtx;
        aGain.setValueAtTime(aGain.value, cutAt - 0.02);
        aGain.linearRampToValueAtTime(0, cutAt);
        bGain.setValueAtTime(1, t0);
        this.impact(t0); // sub-thump so the silence→slam hits harder
        aStopAt = t0 + 0.1;
        break;
      }
      case "backspin": {
        // vinyl rewind: play A's last 2 beats reversed and accelerating, B slams
        const spinStart = t0 - 2 * beatCtx;
        const p = A.posAt(spinStart);
        if (A.buffer && p - 2 * aBeat > 0) {
          A.stopSource(spinStart);
          const rev = this.reversedSlice(A.buffer, p - 2 * aBeat, 2 * aBeat);
          const s = ctx.createBufferSource();
          s.buffer = rev;
          s.playbackRate.setValueAtTime(aRate, spinStart);
          s.playbackRate.exponentialRampToValueAtTime(aRate * 2.6, t0);
          s.connect(A.low);
          s.start(spinStart);
          s.stop(t0 + 0.02);
          A.source = s;
          A.echoSend.gain.setValueAtTime(0.2, spinStart);
          A.echoSend.gain.linearRampToValueAtTime(0.6, t0);
          A.echoSend.gain.setTargetAtTime(0, t0 + 0.05, 0.15);
        }
        aGain.setValueAtTime(aGain.value, t0 - 0.01);
        aGain.linearRampToValueAtTime(0, t0 + 0.02);
        bGain.setValueAtTime(1, t0);
        aStopAt = t0 + 0.2;
        break;
      }
      case "tape_stop": {
        // power-cut: A pitch-drops to a halt over ~1 beat, top end closing
        const stopStart = t0 - 1 * beatCtx;
        if (A.source) {
          A.source.playbackRate.cancelScheduledValues(now);
          A.source.playbackRate.setValueAtTime(aRate, stopStart);
          A.source.playbackRate.exponentialRampToValueAtTime(0.02, t0);
        }
        A.high.gain.setValueAtTime(0, stopStart);
        A.high.gain.linearRampToValueAtTime(-40, t0);
        A.mid.gain.setValueAtTime(0, stopStart);
        A.mid.gain.linearRampToValueAtTime(-20, t0);
        aGain.setValueAtTime(aGain.value, t0 - 0.02);
        aGain.linearRampToValueAtTime(0, t0 + 0.01);
        bGain.setValueAtTime(1, t0);
        aStopAt = t0 + 0.2;
        break;
      }
      case "gate": {
        // rhythmic strobe-gate on A for a bar while B fades up underneath
        const gateStart = t0 - 4 * beatCtx;
        const eighth = beatCtx / 2;
        const lvl = aGain.value;
        let step = 0;
        for (let tt = gateStart; tt < t0 - 1e-3; tt += eighth) {
          aGain.setValueAtTime(step % 2 === 0 ? lvl : 0, tt);
          step++;
        }
        aGain.setValueAtTime(0, t0);
        bGain.setValueAtTime(0, gateStart);
        bGain.linearRampToValueAtTime(1, t0);
        aStopAt = t0 + 0.1;
        break;
      }
    }

    A.stopSource(aStopAt);
    this.active = 1 - this.active;

    const timeLeft = (end - ctx.currentTime) * 1000;
    setTimeout(() => this.onTransitionEnd?.(), timeLeft + 50);
    return end;
  }

  /**
   * Tension build for press-and-hold gestures: while on, the active deck's
   * lows drain away and the echo bus swells - release into a transition.
   */
  tension(on: boolean, rampSec = 1.5) {
    const A = this.activeDeck;
    const now = this.ctx.currentTime;
    const low = A.low.gain;
    const echo = A.echoSend.gain;
    low.cancelScheduledValues(now);
    echo.cancelScheduledValues(now);
    if (on) {
      low.setTargetAtTime(-26, now, rampSec);
      echo.setTargetAtTime(0.5, now, rampSec * 1.5);
    } else {
      low.setTargetAtTime(0, now, 0.15);
      echo.setTargetAtTime(0, now, 0.3);
    }
  }

  setMasterVolume(v: number) {
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }
}

/**
 * Map a track's integrated loudness (linear RMS) to a level-match trim gain,
 * referenced to a typical mastered level and clamped so a quiet or hot track
 * can't blow the mix out. Unknown loudness → unity.
 */
function trimGainFromLoudness(loudness?: number): number {
  if (!loudness || loudness <= 0) return 1;
  const REF = 0.09; // target RMS - roughly a commercial master
  return Math.min(2.2, Math.max(0.5, REF / loudness));
}

function equalPowerFade(a: AudioParam, b: AudioParam, start: number, dur: number) {
  const steps = 20;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const time = start + t * dur;
    a.setValueAtTime(Math.cos((t * Math.PI) / 2) * a.value, time);
    b.setValueAtTime(Math.sin((t * Math.PI) / 2), time);
  }
}
