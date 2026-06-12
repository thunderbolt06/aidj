import type { TrackAnalysis, TransitionPlan } from "@/lib/types";

/**
 * Dual-deck DJ engine on Web Audio.
 *
 * Graph per deck:
 *   BufferSource -> low/mid/high EQ (biquads) -> deck gain -> master
 * Plus a shared feedback-delay send used by the echo_out transition.
 */

class Deck {
  buffer: AudioBuffer | null = null;
  source: AudioBufferSourceNode | null = null;
  readonly low: BiquadFilterNode;
  readonly mid: BiquadFilterNode;
  readonly high: BiquadFilterNode;
  readonly gain: GainNode;
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
    this.echoSend = ctx.createGain();
    this.echoSend.gain.value = 0;

    this.low.connect(this.mid).connect(this.high).connect(this.gain).connect(master);
    this.gain.connect(this.echoSend).connect(echoBus);
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
    src.onended = () => {
      if (this.source === src) this.playing = false;
    };
  }

  position(): number {
    if (!this.playing || !this.source) return 0;
    const rate = this.source.playbackRate.value;
    return (this.ctx.currentTime - this.startedAt) * rate;
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
    delay.connect(feedback).connect(delay);
    delay.connect(this.master);

    this.decks = [new Deck(this.ctx, this.master, delay), new Deck(this.ctx, this.master, delay)];
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

  async resume() {
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  /** Load + immediately play a track on the active deck. */
  startTrack(buffer: AudioBuffer, offset = 0) {
    const deck = this.activeDeck;
    deck.buffer = buffer;
    deck.resetFx(this.ctx.currentTime);
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
   * Execute a transition from the active deck to `nextBuffer` per the plan.
   * Returns the context time at which the transition completes.
   */
  transition(
    nextBuffer: AudioBuffer,
    plan: TransitionPlan,
    analyses?: { from: TrackAnalysis; to: TrackAnalysis }
  ): number {
    const ctx = this.ctx;
    const A = this.activeDeck;
    const B = this.nextDeck;
    const now = ctx.currentTime;
    const dur = Math.max(0.05, plan.duration);
    const end = now + dur;

    B.buffer = nextBuffer;
    B.resetFx(now);

    // beat-match: play B at A's tempo, then glide to native tempo
    let rate = 1;
    if (plan.beatMatch && analyses && analyses.to.bpm > 0) {
      rate = analyses.from.bpm / analyses.to.bpm;
      if (rate < 0.92 || rate > 1.08) rate = 1; // too far apart to sound good
    }
    B.play(now + 0.02, plan.inPoint, rate);
    if (rate !== 1 && B.source) {
      B.source.playbackRate.setValueAtTime(rate, end);
      B.source.playbackRate.linearRampToValueAtTime(1, end + 4);
    }

    const aGain = A.gain.gain;
    const bGain = B.gain.gain;
    aGain.cancelScheduledValues(now);
    bGain.cancelScheduledValues(now);
    aGain.setValueAtTime(aGain.value, now);
    bGain.setValueAtTime(0, now);

    switch (plan.style) {
      case "cut": {
        aGain.setValueAtTime(0, now + 0.02);
        bGain.setValueAtTime(1, now + 0.02);
        break;
      }
      case "crossfade": {
        equalPowerFade(aGain, bGain, now, dur);
        break;
      }
      case "bass_swap": {
        // kill B's bass, crossfade, swap bass at midpoint
        B.low.gain.setValueAtTime(-24, now);
        equalPowerFade(aGain, bGain, now, dur);
        const mid = now + dur / 2;
        A.low.gain.setValueAtTime(0, mid);
        A.low.gain.linearRampToValueAtTime(-24, mid + 0.15);
        B.low.gain.setValueAtTime(-24, mid);
        B.low.gain.linearRampToValueAtTime(0, mid + 0.15);
        break;
      }
      case "filter_sweep": {
        // A's lows and mids sweep away while B fades in underneath
        A.low.gain.setValueAtTime(0, now);
        A.low.gain.linearRampToValueAtTime(-30, end);
        A.mid.gain.setValueAtTime(0, now);
        A.mid.gain.linearRampToValueAtTime(-18, end);
        equalPowerFade(aGain, bGain, now, dur);
        break;
      }
      case "echo_out": {
        // A drops into the echo bus and cuts early; tail rings into B
        A.echoSend.gain.setValueAtTime(0, now);
        A.echoSend.gain.linearRampToValueAtTime(0.9, now + dur * 0.3);
        aGain.setValueAtTime(aGain.value, now);
        aGain.linearRampToValueAtTime(0, now + dur * 0.45);
        bGain.setValueAtTime(0, now + dur * 0.25);
        bGain.linearRampToValueAtTime(1, end);
        break;
      }
    }

    A.stopSource(end + 3);
    this.active = 1 - this.active;

    const timeLeft = (end - ctx.currentTime) * 1000;
    setTimeout(() => this.onTransitionEnd?.(), timeLeft + 50);
    return end;
  }

  setMasterVolume(v: number) {
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /** Duck music under speech (talking DJ), then restore. */
  duck(level = 0.25, holdSec = 3) {
    const g = this.master.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(level, now, 0.2);
    g.setTargetAtTime(1, now + holdSec, 0.4);
  }
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
