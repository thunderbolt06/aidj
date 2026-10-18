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
  /** Static per-track level trim (loudness normalization). */
  readonly trim: GainNode;
  readonly echoSend: GainNode;
  /** ctx.currentTime when playback started, minus the track offset. */
  private startedAt = 0;
  /** Fired when the track plays to the end of its buffer on its own. */
  onRunOut: (() => void) | null = null;
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
    this.low.connect(this.mid).connect(this.high).connect(this.gain).connect(this.trim).connect(master);
    this.trim.connect(this.echoSend).connect(echoBus);
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
    src.onended = () => {
      // still our source = it ran off the end of the buffer (stopSource()
      // clears this.source first, so a planned stop never lands here)
      if (this.source !== src) return;
      this.playing = false;
      this.onRunOut?.();
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
  /**
   * Called when the song on the ACTIVE deck reaches the end of its audio
   * before anything hopped away from it - the cue to bring the next one in now.
   */
  onTrackEnd: (() => void) | null = null;

  // mixtape recording (master tap → MediaRecorder)
  private recorder: MediaRecorder | null = null;
  private recChunks: BlobPart[] = [];
  private recDest: MediaStreamAudioDestinationNode | null = null;

  // visualizer tap (master → AnalyserNode, output left unconnected)
  private analyser: AnalyserNode | null = null;
  private recStartCtxTime = 0;

  constructor() {
    // older iOS Safari only ships the prefixed constructor
    const AC =
      typeof AudioContext !== "undefined"
        ? AudioContext
        : (globalThis as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
    if (!AC) throw new Error("Web Audio not supported in this browser");
    this.ctx = new AC();
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
    for (const d of this.decks)
      d.onRunOut = () => {
        if (d === this.activeDeck) this.onTrackEnd?.();
      };
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

  /** Explicit resume (user action or startup unlock) - clears the pause flag. */
  async resume() {
    this.userPaused = false;
    // iOS also reports a non-standard "interrupted" state - resume for
    // anything that isn't running
    if (this.ctx.state !== "running") await this.ctx.resume();
  }

  /**
   * Passive/incidental resume - iOS gesture unlock, tab visibility changes,
   * interruption recovery. Does nothing if the user deliberately paused, so
   * clicking or pressing a key anywhere else on the page can't silently
   * un-pause the mix out from under the pause button.
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
    deck.trim.gain.setValueAtTime(trimGainFromLoudness(analysis?.loudness), this.ctx.currentTime);
    deck.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    deck.gain.gain.setValueAtTime(1, this.ctx.currentTime);
    this.nextDeck.gain.gain.setValueAtTime(0, this.ctx.currentTime);
    deck.play(this.ctx.currentTime + 0.05, offset);
  }

  position(): number {
    return this.activeDeck.position();
  }

  /** False once the active deck's song has run out (or nothing is loaded). */
  isPlaying(): boolean {
    return this.activeDeck.playing;
  }

  /**
   * Lazily create an FFT analyser tapped off the master bus, for visualizers.
   * The analyser's output is intentionally left unconnected - an AnalyserNode
   * analyzes whatever reaches its input regardless, so this taps the full mix
   * (decks + echo bus) without altering the audible signal path.
   */
  getAnalyser(): AnalyserNode {
    if (!this.analyser) {
      const a = this.ctx.createAnalyser();
      a.fftSize = 2048;
      // low smoothing keeps transients sharp so visualizers can lock to the beat
      a.smoothingTimeConstant = 0.35;
      this.master.connect(a);
      this.analyser = a;
    }
    return this.analyser;
  }

  stop() {
    this.decks.forEach((d) => d.stopSource());
  }

  /**
   * Seek within the active deck's track with a vinyl-scratch transition:
   * a short slice of the record "rubs" (reversed when jumping back, forward
   * when jumping ahead) with a fast rate sweep, then playback slams in at
   * the target position. Returns the clamped position actually seeked to.
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
    const sliceStart = back ? Math.max(0, from - rubLen) : Math.min(from, buf.duration - rubLen);
    const rub = ctx.createBufferSource();
    rub.buffer = back ? this.reversedSlice(buf, sliceStart, rubLen) : buf;
    // sweep the rate up like a hand dragging the platter
    rub.playbackRate.setValueAtTime(1, now);
    rub.playbackRate.exponentialRampToValueAtTime(2.4, now + rubLen);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, now);
    g.gain.linearRampToValueAtTime(0, now + rubLen);
    rub.connect(g).connect(this.master);
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
    // anchor phrases on the estimated downbeat (bar 1), not just the first beat
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

  /**
   * When B enters: at A's track position `dropAt` (a vocal gap the caller
   * picked) if that is still far enough ahead, else the next phrase boundary
   * when quantizing, else right after the pre-roll.
   */
  private entryTime(
    from: TrackAnalysis | undefined,
    preRoll: number,
    opts?: { quantizeBeats?: number; dropAt?: number }
  ): number {
    const A = this.activeDeck;
    const earliest = this.ctx.currentTime + preRoll + 0.08;
    if (opts?.dropAt != null && A.playing) {
      const t = A.ctxTimeAt(opts.dropAt);
      if (t >= earliest) return t;
    }
    return opts?.quantizeBeats && from && A.playing
      ? this.nextGridTime(from, opts.quantizeBeats, preRoll + 0.08)
      : earliest;
  }

  private noiseBuffer: AudioBuffer | null = null;
  private getNoise(): AudioBuffer {
    if (!this.noiseBuffer) {
      const sr = this.ctx.sampleRate;
      const buf = this.ctx.createBuffer(1, sr * 2, sr);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuffer = buf;
    }
    return this.noiseBuffer;
  }

  /** A short sub-bass thump one-shot - punctuates silence_drop / FX layers. */
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
    s.connect(lp).connect(g).connect(this.master);
    s.start(at);
    s.stop(at + 0.35);
  }

  /**
   * Fire a library element - an FX one-shot or a beat loop - straight into the
   * master bus, on top of whatever the decks are doing (so it is recorded and
   * visualized with the mix). The handle fades it out or retunes its speed
   * (a running loop follows the tempo of the next track).
   */
  playElement(
    buffer: AudioBuffer,
    opts: { gain?: number; rate?: number; loop?: boolean; when?: number } = {}
  ): { stop: () => void; setRate: (rate: number) => void } {
    const ctx = this.ctx;
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    s.loop = !!opts.loop;
    s.playbackRate.value = opts.rate ?? 1;
    const g = ctx.createGain();
    g.gain.value = opts.gain ?? 0.8;
    s.connect(g).connect(this.master);
    s.start(Math.max(ctx.currentTime, opts.when ?? 0));
    return {
      stop: () => {
        const now = ctx.currentTime;
        g.gain.setTargetAtTime(0, now, 0.03);
        try {
          s.stop(now + 0.2);
        } catch {
          /* one-shot already ended */
        }
      },
      setRate: (rate) => s.playbackRate.setTargetAtTime(rate, ctx.currentTime, 0.5),
    };
  }

  /** Build a reversed AudioBuffer of `lenSec` starting at `startSec`. */
  private reversedSlice(buf: AudioBuffer, startSec: number, lenSec: number): AudioBuffer {
    const sr = buf.sampleRate;
    const start = Math.max(0, Math.floor(startSec * sr));
    const len = Math.min(Math.floor(lenSec * sr), buf.length - start);
    const out = this.ctx.createBuffer(buf.numberOfChannels, Math.max(1, len), sr);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const src = buf.getChannelData(ch);
      const dst = out.getChannelData(ch);
      for (let i = 0; i < len; i++) dst[i] = src[start + len - 1 - i];
    }
    return out;
  }

  /**
   * Execute a transition from the active deck to `nextBuffer` per the plan.
   *
   * Everything is scheduled on the AudioContext clock against a single anchor
   * `t0` - the moment B enters. With `quantizeBeats` set, t0 snaps to A's
   * beat grid (sample-accurate, no setTimeout drift) and pre-roll effects
   * (loop roll, brake, riser) are scheduled BEFORE it so the drop lands on
   * the phrase. B's inPoint additionally snaps to B's own beat grid.
   * Returns the context time at which the transition completes.
   */
  transition(
    nextBuffer: AudioBuffer,
    plan: TransitionPlan,
    analyses?: { from: TrackAnalysis; to: TrackAnalysis },
    opts?: {
      /** Keep B locked at the matched tempo (tempo-anchored mashups). */
      holdRate?: boolean;
      /** Snap the drop to A's grid: phrase length in beats (e.g. 16). */
      quantizeBeats?: number;
      /** A's track position for B's entry (wins over quantizeBeats). */
      dropAt?: number;
    }
  ): number {
    const ctx = this.ctx;
    const A = this.activeDeck;
    const B = this.nextDeck;
    const dur = Math.max(0.05, plan.duration);

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

    // anchor: B's entry - in a vocal gap, or snapped to A's beat grid
    const t0 = this.entryTime(analyses?.from, preRoll, opts);
    const end = t0 + dur;

    B.buffer = nextBuffer;
    B.resetFx(ctx.currentTime);
    B.trim.gain.setValueAtTime(trimGainFromLoudness(analyses?.to.loudness), ctx.currentTime);

    // beat-match: play B at A's tempo, then glide to native tempo
    let rate = 1;
    if (plan.beatMatch && analyses && analyses.to.bpm > 0) {
      rate = analyses.from.bpm / analyses.to.bpm;
      const [lo, hi] = opts?.holdRate ? [0.85, 1.18] : [0.92, 1.08];
      if (rate < lo || rate > hi) rate = 1;
    }

    // snap B's entry onto B's own beat grid (anchored on its downbeat) so
    // bar 1 lands at t0
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
    if (rate !== 1 && B.source && !opts?.holdRate) {
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
      // vocal_throw has no word buffer here (that path uses vocalThrow());
      // forced via transition() it degrades to a clean cut
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
      // vocal_handoff needs B's entry planned (that path uses vocalHandoff());
      // forced via transition() it degrades to the bass swap it starts with
      case "vocal_handoff":
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
        noise.connect(bp).connect(ng).connect(this.master);
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
   * Mashup: play both decks at once - A as the low-end "bed", B band-passed
   * on top as the "topper", tempo-matched to A. Poor man's stem separation.
   */
  playMashup(
    bed: AudioBuffer,
    topper: AudioBuffer,
    opts: {
      bedOffset: number;
      topperOffset: number;
      rate: number;
      topperGain?: number;
      /** false when using real stems - no EQ carving needed. */
      carve?: boolean;
    }
  ) {
    const now = this.ctx.currentTime;
    const [A, B] = this.decks;
    this.active = 0;
    A.buffer = bed;
    B.buffer = topper;
    A.resetFx(now);
    B.resetFx(now);
    if (opts.carve !== false) {
      // bed keeps its body but makes room on top
      A.high.gain.setValueAtTime(-10, now);
      A.mid.gain.setValueAtTime(-4, now);
      // topper: strip lows so basslines don't fight, lift presence
      B.low.gain.setValueAtTime(-30, now);
      B.mid.gain.setValueAtTime(3, now);
      B.high.gain.setValueAtTime(2, now);
    }
    A.gain.gain.setValueAtTime(1, now);
    B.gain.gain.setValueAtTime(opts.topperGain ?? 0.9, now);
    A.play(now + 0.05, opts.bedOffset, 1);
    B.play(now + 0.05, opts.topperOffset, opts.rate);
  }

  setTopperGain(v: number) {
    this.decks[1].gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /**
   * Infinite mashup: replace one layer with a new song while the other keeps
   * playing - quick dip, swap source, come back. EQ carve on the deck stays.
   */
  swapMashupLayer(
    which: "bed" | "topper",
    buffer: AudioBuffer,
    opts: { offset: number; rate: number }
  ) {
    const deck = this.decks[which === "bed" ? 0 : 1];
    const now = this.ctx.currentTime;
    const g = deck.gain.gain;
    const level = Math.max(g.value, which === "bed" ? 1 : 0.85);
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + 0.25);
    deck.buffer = buffer;
    deck.play(now + 0.3, opts.offset, opts.rate);
    g.setValueAtTime(0, now + 0.3);
    g.linearRampToValueAtTime(level, now + 0.8);
  }

  /**
   * Word-stutter transition (Lyric DJ): loop a short beat-synced slice of the
   * current track (the sung word) N times - echo rising - then drop the next
   * track exactly as the loop releases. Returns the ctx time of the drop.
   */
  stutterTransition(
    nextBuffer: AudioBuffer,
    opts: {
      loopStart: number; // seconds into current track - where the word begins
      loopLen: number; // one repeat length (≈ a beat)
      repeats: number;
      inPoint: number; // where the next track enters
    }
  ): number {
    const ctx = this.ctx;
    const A = this.activeDeck;
    const B = this.nextDeck;
    if (!A.buffer) throw new Error("no active buffer");
    const now = ctx.currentTime + 0.04;
    const dropAt = now + opts.loopLen * opts.repeats;

    // replace A's source with a looping slice of the word
    A.stopSource(now);
    const loop = ctx.createBufferSource();
    loop.buffer = A.buffer;
    loop.loop = true;
    loop.loopStart = opts.loopStart;
    loop.loopEnd = opts.loopStart + opts.loopLen;
    loop.connect(A.low);
    loop.start(now, opts.loopStart);
    loop.stop(dropAt + 0.05);
    A.source = loop;

    // echo swells through the stutter, A ducks out right at the drop
    A.echoSend.gain.cancelScheduledValues(now);
    A.echoSend.gain.setValueAtTime(0.15, now);
    A.echoSend.gain.linearRampToValueAtTime(0.7, dropAt);
    A.echoSend.gain.setTargetAtTime(0, dropAt + 0.1, 0.2);
    const aGain = A.gain.gain;
    aGain.cancelScheduledValues(now);
    aGain.setValueAtTime(aGain.value, now);
    aGain.setValueAtTime(aGain.value, dropAt - 0.02);
    aGain.linearRampToValueAtTime(0, dropAt + 0.08);

    // B drops on its word as the loop releases
    B.buffer = nextBuffer;
    B.resetFx(now);
    const bGain = B.gain.gain;
    bGain.cancelScheduledValues(now);
    bGain.setValueAtTime(0, now);
    bGain.setValueAtTime(0, dropAt - 0.08);
    bGain.linearRampToValueAtTime(1, dropAt + 0.04);
    B.play(dropAt - 0.08, Math.max(0, opts.inPoint - 0.08));

    this.active = 1 - this.active;
    const msLeft = (dropAt - ctx.currentTime) * 1000;
    setTimeout(() => this.onTransitionEnd?.(), msLeft + 60);
    return dropAt;
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

  /** The listener's volume (0..1); ducks come back up to it, not to full. */
  private volume = 1;

  setMasterVolume(v: number) {
    this.volume = v;
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /** Duck music under speech (talking DJ), then restore. */
  duck(level = 0.25, holdSec = 3) {
    const g = this.master.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(level * this.volume, now, 0.2);
    g.setTargetAtTime(this.volume, now + holdSec, 0.4);
  }

  // ── Mixtape recording ─────────────────────────────────────────────────────

  get recording(): boolean {
    return this.recorder?.state === "recording";
  }

  /** Tap the master output into a MediaRecorder to capture the live set. */
  startRecording(): boolean {
    if (this.recording) return true;
    if (typeof MediaRecorder === "undefined") return false;
    if (!this.recDest) {
      this.recDest = this.ctx.createMediaStreamDestination();
      this.master.connect(this.recDest);
    }
    const mime = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/ogg;codecs=opus",
    ].find((m) => MediaRecorder.isTypeSupported?.(m));
    this.recChunks = [];
    this.recorder = new MediaRecorder(
      this.recDest.stream,
      mime ? { mimeType: mime } : undefined
    );
    this.recorder.ondataavailable = (e) => {
      if (e.data.size) this.recChunks.push(e.data);
    };
    this.recStartCtxTime = this.ctx.currentTime;
    this.recorder.start(1000); // gather a chunk per second so a crash loses little
    return true;
  }

  /** Stop recording and resolve the captured mix as a Blob. */
  stopRecording(): Promise<{ blob: Blob; durationSec: number }> {
    return new Promise((resolve, reject) => {
      const r = this.recorder;
      if (!r) {
        reject(new Error("not recording"));
        return;
      }
      const durationSec = this.ctx.currentTime - this.recStartCtxTime;
      r.onstop = () => {
        const blob = new Blob(this.recChunks, {
          type: r.mimeType || "audio/webm",
        });
        this.recorder = null;
        resolve({ blob, durationSec });
      };
      r.stop();
    });
  }

  // ── Stem-aware transition ─────────────────────────────────────────────────

  /**
   * Acapella-in: B's isolated VOCAL stem rides in over A's groove for ~8 beats,
   * then B's full mix drops on the phrase and A bows out - the classic radio
   * blend. `bVocal` is B's demucs vocal stem; `bFull` is B's full track. Grid-
   * quantized like `transition`. Returns the ctx time the swap completes.
   */
  stemSwap(
    bFull: AudioBuffer,
    opts: {
      bVocal: AudioBuffer;
      inPoint: number;
      analyses: { from: TrackAnalysis; to: TrackAnalysis };
      quantizeBeats?: number;
      /** A's track position for B's full-mix drop (wins over quantizeBeats). */
      dropAt?: number;
    }
  ): number {
    const ctx = this.ctx;
    const A = this.activeDeck;
    const B = this.nextDeck;
    const { from, to } = opts.analyses;

    const aRate = A.rate();
    const aBeat = from.bpm ? 60 / from.bpm : 0.5;
    const beatCtx = aBeat / aRate;
    const preBeats = 8;
    const preRoll = preBeats * beatCtx;

    const t0 = this.entryTime(from, preRoll, opts);
    const preStart = t0 - preRoll;

    // tempo-match B to A (same clamp as transition's beatMatch)
    let rate = 1;
    if (to.bpm > 0) {
      rate = from.bpm / to.bpm;
      if (rate < 0.9 || rate > 1.1) rate = 1;
    }

    // snap B's full-mix entry to its downbeat grid so bar 1 lands at t0
    let inPoint = Math.max(0, opts.inPoint);
    if (to.bpm > 0) {
      const bAnchor = to.downbeatOffset ?? to.beatOffset;
      const beat = 60 / to.bpm;
      inPoint = Math.max(0, bAnchor + Math.round((inPoint - bAnchor) / beat) * beat);
    }

    B.buffer = bFull;
    B.resetFx(ctx.currentTime);
    B.trim.gain.setValueAtTime(trimGainFromLoudness(to.loudness), ctx.currentTime);

    // acapella overlay: B's vocal stem, timed so its hook reaches inPoint at t0.
    // The overlay plays at `rate`, so over `preRoll` wall-seconds it advances
    // `preRoll * rate` of B-time - start that far back from inPoint.
    const voxOffset = Math.max(0, inPoint - preRoll * rate);
    const vox = ctx.createBufferSource();
    vox.buffer = opts.bVocal;
    vox.playbackRate.value = rate;
    const voxGain = ctx.createGain();
    voxGain.gain.setValueAtTime(0.0001, preStart);
    voxGain.gain.exponentialRampToValueAtTime(1, preStart + 2 * beatCtx);
    voxGain.gain.setValueAtTime(1, t0 - 0.02);
    voxGain.gain.linearRampToValueAtTime(0, t0 + 0.05); // B-full takes over the vocal
    vox.connect(voxGain).connect(this.master);
    vox.start(preStart, voxOffset);
    vox.stop(t0 + 0.1);

    // duck A's mids/highs so the incoming vocal sits on top, lows stay till t0
    A.high.gain.setValueAtTime(0, preStart);
    A.high.gain.linearRampToValueAtTime(-8, t0 - beatCtx);
    A.mid.gain.setValueAtTime(0, preStart);
    A.mid.gain.linearRampToValueAtTime(-5, t0 - beatCtx);

    // at t0: B full drops, owns the low end; A fades out over 2 beats
    B.play(t0, inPoint, rate);
    if (rate !== 1 && B.source) {
      B.source.playbackRate.setValueAtTime(rate, t0 + 2 * beatCtx);
      B.source.playbackRate.linearRampToValueAtTime(1, t0 + 2 * beatCtx + 4);
    }
    const aGain = A.gain.gain;
    const bGain = B.gain.gain;
    const now = ctx.currentTime;
    aGain.cancelScheduledValues(now);
    bGain.cancelScheduledValues(now);
    aGain.setValueAtTime(aGain.value, now);
    bGain.setValueAtTime(0, now);
    bGain.setValueAtTime(1, t0);
    A.low.gain.setValueAtTime(-24, t0);
    aGain.setValueAtTime(aGain.value, t0);
    aGain.linearRampToValueAtTime(0, t0 + 2 * beatCtx);
    const aStopAt = t0 + 2 * beatCtx + 0.3;

    setTimeout(
      () => {
        try {
          voxGain.disconnect();
        } catch {
          /* already gone */
        }
      },
      Math.max(0, (t0 + 1 - now) * 1000)
    );

    A.stopSource(aStopAt);
    this.active = 1 - this.active;
    const end = t0 + 2 * beatCtx;
    setTimeout(() => this.onTransitionEnd?.(), (end - ctx.currentTime) * 1000 + 50);
    return end;
  }

  /**
   * Vocal handoff - the beat changes first, the singer later. At t0 (a bar)
   * B's instrumental comes in and takes the low end while A's band drains out
   * over two beats, leaving A's VOCAL riding B's groove for `bars` bars. On the
   * handoff bar A's vocal echoes out and B's own singer arrives (the caller
   * picked `inPoint` so B is instrumental until then - lib/audio/handoff.ts).
   *
   * A's vocal is held with a vocal-focus tap of A: the centre channel (most
   * songs pan the lead vocal dead centre, the band wide) with the kick and
   * bass cut and the hi-hats tamed. Returns the ctx time the handoff completes.
   */
  vocalHandoff(
    bFull: AudioBuffer,
    opts: {
      inPoint: number;
      bars: number;
      analyses: { from: TrackAnalysis; to: TrackAnalysis };
      quantizeBeats?: number;
      /** A's track position for B's entry (wins over quantizeBeats). */
      dropAt?: number;
    }
  ): number {
    const ctx = this.ctx;
    const A = this.activeDeck;
    const B = this.nextDeck;
    const { from, to } = opts.analyses;
    const aRate = A.rate();
    const aBeat = from.bpm ? 60 / from.bpm : 0.5;
    const beatCtx = aBeat / aRate;

    // B comes in on a bar (a phrase when quantizing), or exactly at dropAt
    const t0 = this.entryTime(from, 0, {
      dropAt: opts.dropAt,
      quantizeBeats: Math.max(4, opts.quantizeBeats ?? 4),
    });
    const tH = t0 + Math.max(1, opts.bars) * 4 * beatCtx; // the handoff bar
    const end = tH + beatCtx;
    const now = ctx.currentTime;

    // the singer has to sit on B's beat: hold B at A's tempo through the handoff
    let rate = 1;
    if (to.bpm > 0 && from.bpm > 0) {
      rate = (from.bpm / to.bpm) * aRate;
      if (rate < 0.92 || rate > 1.08) rate = 1;
    }
    let inPoint = Math.max(0, opts.inPoint);
    if (to.bpm > 0) {
      const bAnchor = to.downbeatOffset ?? to.beatOffset;
      const beat = 60 / to.bpm;
      inPoint = Math.max(0, bAnchor + Math.round((inPoint - bAnchor) / beat) * beat);
    }

    B.buffer = bFull;
    B.resetFx(now);
    B.trim.gain.setValueAtTime(trimGainFromLoudness(to.loudness), now);
    B.play(t0, inPoint, rate);
    if (rate !== 1 && B.source) {
      B.source.playbackRate.setValueAtTime(rate, end);
      B.source.playbackRate.linearRampToValueAtTime(1, end + 4);
    }

    // B's instrumental: in over a beat, mids dipped a touch so A's voice sits
    // on top, opened back up as B's own singer arrives
    const aGain = A.gain.gain;
    const bGain = B.gain.gain;
    aGain.cancelScheduledValues(now);
    bGain.cancelScheduledValues(now);
    aGain.setValueAtTime(aGain.value, now);
    bGain.setValueAtTime(0, now);
    bGain.setValueAtTime(0, t0);
    bGain.linearRampToValueAtTime(1, t0 + beatCtx);
    B.mid.gain.setValueAtTime(-3, t0);
    B.mid.gain.setValueAtTime(-3, tH - beatCtx);
    B.mid.gain.linearRampToValueAtTime(0, tH);

    // A's band: bass swapped out on the 1, the rest gone over two beats
    A.low.gain.setValueAtTime(0, t0);
    A.low.gain.linearRampToValueAtTime(-30, t0 + 0.1);
    aGain.setValueAtTime(aGain.value, t0);
    aGain.linearRampToValueAtTime(0, t0 + 2 * beatCtx);

    // A's vocal: in as the band goes (complementary, so the voice stays level),
    // echoed through the last beats of the hold, gone on the handoff bar
    const hold = ctx.createGain();
    const level = 1.15; // the focus tap loses the sides
    hold.gain.setValueAtTime(0, now);
    hold.gain.setValueAtTime(0, t0);
    hold.gain.linearRampToValueAtTime(level, t0 + 2 * beatCtx);
    hold.gain.setValueAtTime(level, tH - 0.02);
    hold.gain.linearRampToValueAtTime(0, tH + beatCtx / 4);
    hold.connect(A.trim); // trim → master + echo send
    A.echoSend.gain.cancelScheduledValues(now);
    A.echoSend.gain.setValueAtTime(0, tH - 2 * beatCtx);
    A.echoSend.gain.linearRampToValueAtTime(0.55, tH);
    A.echoSend.gain.setTargetAtTime(0, tH + 0.05, 0.1);

    const nodes: AudioNode[] = [hold];
    const filter = (type: BiquadFilterType, freq: number, gain = 0) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.gain.value = gain;
      nodes.push(f);
      return f;
    };
    if (A.source) {
      // vocal focus: centre channel (L+R mono), 24 dB/oct high-pass under the
      // voice, a little presence, the hi-hats pulled down
      const mono = ctx.createGain();
      mono.channelCount = 1;
      mono.channelCountMode = "explicit";
      mono.channelInterpretation = "speakers";
      nodes.push(mono);
      A.source
        .connect(mono)
        .connect(filter("highpass", 170))
        .connect(filter("highpass", 170))
        .connect(filter("peaking", 3000, 2))
        .connect(filter("highshelf", 8000, -6))
        .connect(hold);
    }

    setTimeout(
      () => {
        for (const n of nodes) {
          try {
            n.disconnect();
          } catch {
            /* already gone */
          }
        }
      },
      Math.max(0, (tH + 3 - now) * 1000)
    );

    A.stopSource(tH + 0.5);
    this.active = 1 - this.active;
    setTimeout(() => this.onTransitionEnd?.(), (end - now) * 1000 + 50);
    return end;
  }

  /**
   * Vocal-throw: B cuts in on the grid while A's last sung WORD is thrown over
   * its intro - a band-passed one-shot fed into a dotted feedback delay so it
   * echoes and tails out across B's opening bar. `wordBuffer` is a short slice
   * of A at the sung word (full mix or, cleaner, A's vocal stem).
   */
  vocalThrow(
    bFull: AudioBuffer,
    opts: {
      wordBuffer: AudioBuffer;
      inPoint: number;
      analyses: { from: TrackAnalysis; to: TrackAnalysis };
      quantizeBeats?: number;
      /** A's track position for B's full-mix drop (wins over quantizeBeats). */
      dropAt?: number;
    }
  ): number {
    const ctx = this.ctx;
    const A = this.activeDeck;
    const B = this.nextDeck;
    const { from, to } = opts.analyses;
    const aRate = A.rate();
    const aBeat = from.bpm ? 60 / from.bpm : 0.5;
    const beatCtx = aBeat / aRate;

    const t0 =
      opts.quantizeBeats && A.playing
        ? this.nextGridTime(from, opts.quantizeBeats, 0.08)
        : ctx.currentTime + 0.12;

    let rate = 1;
    if (to.bpm > 0) {
      rate = from.bpm / to.bpm;
      if (rate < 0.9 || rate > 1.1) rate = 1;
    }
    let inPoint = Math.max(0, opts.inPoint);
    if (to.bpm > 0) {
      const bAnchor = to.downbeatOffset ?? to.beatOffset;
      const beat = 60 / to.bpm;
      inPoint = Math.max(0, bAnchor + Math.round((inPoint - bAnchor) / beat) * beat);
    }

    B.buffer = bFull;
    B.resetFx(ctx.currentTime);
    B.trim.gain.setValueAtTime(trimGainFromLoudness(to.loudness), ctx.currentTime);

    // A cuts out, B slams in on the grid
    const aGain = A.gain.gain;
    const bGain = B.gain.gain;
    const now = ctx.currentTime;
    aGain.cancelScheduledValues(now);
    bGain.cancelScheduledValues(now);
    aGain.setValueAtTime(aGain.value, now);
    aGain.setValueAtTime(aGain.value, t0 - 0.01);
    aGain.linearRampToValueAtTime(0, t0 + 0.02);
    bGain.setValueAtTime(0, now);
    bGain.setValueAtTime(1, t0);
    B.play(t0, inPoint, rate);

    // the throw: band-passed word → dotted-eighth feedback delay → master
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1600;
    bp.Q.value = 0.9;
    const dly = ctx.createDelay(1);
    dly.delayTime.value = beatCtx * 0.75; // dotted eighth - classic dub throw
    const fb = ctx.createGain();
    fb.gain.value = 0.55;
    const wet = ctx.createGain();
    wet.gain.setValueAtTime(0.9, t0);
    wet.gain.setTargetAtTime(0, t0 + 3 * beatCtx, 0.6);
    const dry = ctx.createGain();
    dry.gain.value = 0.9;

    const word = ctx.createBufferSource();
    word.buffer = opts.wordBuffer;
    word.connect(bp);
    bp.connect(dry).connect(this.master);
    bp.connect(dly);
    dly.connect(fb).connect(dly);
    dly.connect(wet).connect(this.master);
    word.start(t0);
    word.stop(t0 + Math.max(0.5, opts.wordBuffer.duration) + 0.1);

    setTimeout(
      () => {
        for (const n of [bp, dly, fb, wet, dry]) {
          try {
            n.disconnect();
          } catch {
            /* already gone */
          }
        }
      },
      Math.max(0, (t0 + 5 - now) * 1000)
    );

    A.stopSource(t0 + 0.3);
    this.active = 1 - this.active;
    setTimeout(() => this.onTransitionEnd?.(), (t0 - now) * 1000 + 80);
    return t0;
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
