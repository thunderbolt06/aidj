"use client";

import { useEffect, useRef, useState } from "react";
import type { Track, TransitionPlan } from "@/lib/types";
import {
  getEngine,
  heuristicPlan,
  loadStem,
  loadTrack,
  planTransition,
  searchTracks,
  vocalStart,
  type LoadedTrack,
} from "@/lib/client/dj";
import { camelotCompatible } from "@/lib/audio/analysis";
import { getSelectedLanguageLabels } from "@/lib/client/langPrefs";
import { getSongSource } from "@/lib/client/sourcePrefs";
import { listenerHistory, notePlayed, noteSkipped, SKIP_SEC } from "@/lib/client/history";
import { flushEvents, logEvent, newSetId } from "@/lib/client/telemetry";
import type { HopTrigger, PlayEnd } from "@/lib/server/events";
import { timeStretchBuffer } from "@/lib/audio/timestretch";
import {
  arcEnergyAt,
  arcTargetAt,
  clipLenForEnergy,
  type ArcShape,
  type ArcTarget,
} from "@/lib/audio/arc";
import type { TrackAnalysis } from "@/lib/types";
import { HOOK_PLAYOUT, hookEnd, pickVocalExit, vocalExits } from "@/lib/audio/vocalExits";
import { handoffEntry, handoffExits, handoffTempoOk, type HandoffEntry } from "@/lib/audio/handoff";

export interface AutoMixOptions {
  /**
   * Seconds per song before auto-hop. "ai" lets the transition plan's
   * outPoint decide when to leave each song. 0 = no auto-hop (user-driven).
   */
  clipLen?: number | "ai";
  useAi?: boolean;
  /**
   * Minimum seconds a song must play before an AI-timed transition may fire.
   * The plan still decides the exact exit, but never before this floor has
   * elapsed. Only applies in "ai" timing mode. Defaults to 25.
   */
  minPlaySec?: number;
  styleHint?: TransitionPlan["style"];
  /** Wait for the next phrase boundary before executing transitions. */
  quantize?: boolean;
  /** Phrase length in beats (16 = 4 bars; 8 feels snappier). */
  quantizeBeats?: number;
  /** Auto-refill the queue with AI suggestions so the set never ends. */
  endless?: boolean;
  /**
   * The playlist vibes the set was built from (the intent plan's `vibes`):
   * endless refills stay inside them instead of drifting by tempo alone.
   */
  vibes?: string[];
  /** Cap transition length (snappy UIs like reels want ≤4s). */
  maxTransitionDur?: number;
  /**
   * Key-lock / master tempo: when beat-matching, pitch-preserve the tempo
   * change (pre-stretch B) instead of detuning it with playbackRate.
   */
  keyLock?: boolean;
  /**
   * Allow stem-aware transitions (acapella-in). Pre-warms demucs vocal stems
   * during prepare-ahead; needs Replicate credit. Falls back loudly if a stem
   * isn't ready at hop time.
   */
  stems?: boolean;
  /**
   * Energy-arc director: pace the WHOLE set along a curve (warm-up → peak →
   * cool-down) over `durationMin` minutes. Biases transition intensity, clip
   * length, and endless-refill song selection toward the current target.
   */
  arc?: { shape: ArcShape; durationMin: number };
  /** Called after every completed hop. */
  onHop?: (info: { track: Track; plan: TransitionPlan; index: number }) => void;
}

interface Prepared {
  trackId: string;
  next: LoadedTrack;
  plan: TransitionPlan;
  /** Key-locked, pitch-preserved buffer + its remapped analysis (if prepared). */
  matched?: { buffer: AudioBuffer; analysis: TrackAnalysis; inPoint: number };
  /** Vocal handoff: where B's instrumental starts and its singer arrives. */
  handoff?: Handoff;
}

interface Handoff {
  entry: HandoffEntry;
  /** B's singer's pickup before the handoff bar, in A seconds. */
  pickupA: number;
}

/**
 * Can B's beat come in under A's singer? Only when A's voice suits B's music
 * - harmonic keys (with some confidence) and a tight tempo match - and B has a
 * clean instrumental run into one of its sung entries. Null otherwise.
 */
function handoffFor(from: LoadedTrack, to: LoadedTrack): Handoff | null {
  const a = from.analysis;
  const b = to.analysis;
  if (!from.meta.vocals?.length || from.meta.instrumental) return null;
  if (!handoffTempoOk(a.bpm, b.bpm)) return null;
  if (!a.camelot || !b.camelot || !camelotCompatible(a.camelot, b.camelot)) return null;
  if (Math.min(a.keyConfidence ?? 0, b.keyConfidence ?? 0) < 0.3) return null;
  const entry = handoffEntry(to.meta.vocals, b, to.meta.famousStart);
  if (!entry) return null;
  return { entry, pickupA: (entry.pickup * b.bpm) / a.bpm };
}

/**
 * Fit a vocal_handoff plan to the pair: B starts where its instrumental run
 * begins and stays tempo-locked, or - when the pair can't hand off - the plan
 * falls back to the blend the handoff starts with (and says so).
 */
function applyHandoff(plan: TransitionPlan, from: LoadedTrack, to: LoadedTrack): Handoff | undefined {
  if (plan.style !== "vocal_handoff") return undefined;
  const h = handoffFor(from, to);
  if (!h) {
    const clash = !camelotCompatible(from.analysis.camelot, to.analysis.camelot);
    plan.style = clash ? "echo_out" : "bass_swap";
    plan.reasoning = `${plan.reasoning} (No clean vocal handoff for this pair - ${plan.style.replace("_", " ")} instead.)`;
    return undefined;
  }
  plan.inPoint = h.entry.inPoint;
  plan.beatMatch = true;
  plan.duration = (h.entry.bars * 4 * 60) / from.analysis.bpm;
  return h;
}

export interface HopLogEntry {
  title: string;
  artist: string;
  style: TransitionPlan["style"];
  index: number;
  /** Cover art, kept here so the recap still has it after the song leaves the queue. */
  thumbnail?: string;
}

/**
 * One transition, as the like / dislike popup (components/TransitionRating)
 * and the stats page see it: which songs, where in each, which style.
 */
export interface HopInfo {
  hopId: string;
  from: { id: string; title: string; artist: string };
  to: { id: string; title: string; artist: string; thumbnail?: string };
  style: TransitionPlan["style"];
  /** where A was left and B came in (seconds into each song) */
  outSec: number;
  inSec: number;
  durSec: number;
  trigger: HopTrigger;
  /** wall-clock ms when the blend should be over - the popup waits for it */
  doneAt: number;
  rating: "up" | "down" | null;
}

/**
 * Key-lock: pre-stretch B (pitch preserved) so playing it at rate 1 lands it
 * at A's tempo IN ITS OWN KEY. Only engages for the mild tempo gaps where
 * beat-matching already kicks in. Returns null if no stretch is warranted.
 */
function buildMatched(
  ctx: BaseAudioContext,
  bBuffer: AudioBuffer,
  from: TrackAnalysis,
  to: TrackAnalysis,
  inPoint: number
): { buffer: AudioBuffer; analysis: TrackAnalysis; inPoint: number } | null {
  if (!from.bpm || !to.bpm) return null;
  const rate = from.bpm / to.bpm;
  if (rate < 0.92 || rate > 1.08 || Math.abs(rate - 1) < 0.01) return null;
  const factor = 1 / rate; // stretch B's duration so its tempo becomes A's
  const buffer = timeStretchBuffer(ctx, bBuffer, factor);
  const analysis: TrackAnalysis = {
    ...to,
    bpm: from.bpm,
    duration: to.duration * factor,
    beatOffset: to.beatOffset * factor,
    downbeatOffset: to.downbeatOffset * factor,
  };
  return { buffer, analysis, inPoint: inPoint * factor };
}

/** Margin between the auto-hop timer firing and the planned drop. */
const VOCAL_GAP_MARGIN = 2.5;

/**
 * Aim an auto-hop at a vocal gap: the first moment near `desired` where A's
 * sung line has ended and the band plays alone, so B comes in without cutting
 * a word off or stacking two singers. Null when A has no vocal map or no gap
 * fits - the caller then hops at `desired` as before.
 */
function aimAtVocalGap(
  current: LoadedTrack,
  plan: TransitionPlan,
  pos: number,
  desired: number,
  floor: number,
  handoff?: Handoff
): { waitSec: number; dropAt: number; room: number; kind: "break" | "line" } | null {
  const a = current.analysis;
  const beat = a.bpm > 0 ? 60 / a.bpm : 0.5;
  if (plan.style === "vocal_handoff" && handoff) {
    // B's beat comes in `bars` before A's line ends, so A's last line rides
    // it: aim the drop (not the line end) near the desired moment
    const exits = handoffExits(
      vocalExits(current.meta.vocals, a),
      current.meta.vocals,
      a,
      handoff.entry.bars,
      handoff.pickupA
    ).filter((e) => e.dropAt >= pos + VOCAL_GAP_MARGIN + 0.5);
    const byDrop = exits.map((e) => ({ ...e, at: e.dropAt }));
    const pick = pickVocalExit(byDrop, desired, floor);
    const exit = pick ? exits[byDrop.indexOf(pick as (typeof byDrop)[number])] : null;
    if (!exit || exit.at > a.duration - 8) return null;
    return {
      waitSec: Math.max(0, exit.dropAt - VOCAL_GAP_MARGIN - pos),
      dropAt: exit.dropAt,
      room: exit.room,
      kind: exit.kind,
    };
  }
  // an acapella-in plays B's vocal for 8 beats BEFORE the drop: that lead-in
  // must sit in the gap too, so it needs a longer one and the drop moves later
  const stem = plan.style === "stem_acapella";
  const lead = stem ? 8 * beat : 0;
  const preRoll = stem ? 8 * beat : 4 * beat; // longest pre-roll per engine path
  let exits = vocalExits(current.meta.vocals, a);
  if (stem) exits = exits.filter((e) => e.room >= lead * 0.9);
  const hardFloor = pos + preRoll + VOCAL_GAP_MARGIN + 0.5;
  const exit = pickVocalExit(exits, desired, Math.max(floor, hardFloor));
  if (!exit || exit.at > a.duration - 8) return null;
  const dropAt = exit.at + lead;
  return {
    waitSec: Math.max(0, dropAt - preRoll - VOCAL_GAP_MARGIN - pos),
    dropAt,
    room: exit.room - lead,
    kind: exit.kind,
  };
}

/**
 * Beat detectors routinely lock onto half- or double-time, so a 128 BPM track
 * can read as 64 or 256. Fold a detected BPM into the same octave as the arc's
 * target center before comparing, so an octave error doesn't wreck the match.
 */
function foldBpm(bpm: number, center: number): number {
  if (!bpm || bpm <= 0 || center <= 0) return center;
  let b = bpm;
  while (b < center * 0.72) b *= 2;
  while (b > center * 1.4) b /= 2;
  return b;
}

interface ArcScoreCtx {
  /** Target BPM center for the arc at the (look-ahead) play time. */
  center: number;
  /** Currently-playing track's BPM (for tempo-direction reasoning). */
  curBpm: number;
  /** Currently-playing track's Camelot key (for harmonic continuity). */
  curCamelot: string | null;
  /**
   * Energy slope of the arc right now: >0 climbing (want faster), <0 cooling
   * (want slower), ~0 holding (just match the center).
   */
  trend: number;
}

/**
 * Score a candidate's analysis against the arc target. Higher is better.
 * Combines three things a DJ weighs when picking the next record:
 *  1. tempo proximity to where the arc wants to be (octave-folded),
 *  2. moving the tempo in the RIGHT DIRECTION - up while building, down while
 *     winding down (so it works for every arc shape, rising or falling),
 *  3. harmonic continuity with the current track.
 */
function scoreCandidateForArc(a: TrackAnalysis, ctx: ArcScoreCtx): number {
  const b = foldBpm(a.bpm, ctx.center);
  // 1. closeness to target center, normalized (0 = bullseye, negative = off)
  let score = -Math.abs(b - ctx.center) / ctx.center;

  // 2. tempo direction relative to the current track
  const rel = (b - ctx.curBpm) / Math.max(ctx.curBpm, 1);
  if (ctx.trend > 0.02) {
    // building: reward a step up, penalize dropping the tempo
    score += rel >= 0 ? Math.min(rel, 0.1) : rel * 0.5;
  } else if (ctx.trend < -0.02) {
    // winding down: reward a step down, penalize speeding up
    score += rel <= 0 ? Math.min(-rel, 0.1) : -rel * 0.5;
  }

  // 3. harmonic continuity bonus
  if (ctx.curCamelot && camelotCompatible(ctx.curCamelot, a.camelot)) score += 0.15;
  return score;
}

/**
 * Shared auto-mix loop, prepare-ahead edition.
 *
 * Core principle (user feedback): NOTHING loads or thinks at the moment of
 * transition. While a song plays, the next track is fetched, decoded,
 * analyzed and the transition fully planned. User actions only execute.
 */
export function useAutoMix() {
  const [queue, setQueueState] = useState<Track[]>([]);
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [nowIdx, setNowIdx] = useState(-1);
  const [now, setNow] = useState<LoadedTrack | null>(null);
  const [status, setStatus] = useState("");
  const [lastPlan, setLastPlan] = useState<TransitionPlan | null>(null);
  const [position, setPosition] = useState(0);
  const [nextReady, setNextReady] = useState(false);
  const [setLog, setSetLog] = useState<HopLogEntry[]>([]);
  const [recording, setRecording] = useState(false);
  const [mix, setMix] = useState<{ url: string; durationSec: number } | null>(null);
  const [arcInfo, setArcInfo] = useState<ArcTarget | null>(null);
  /** Track position (sec) the user has "claimed" via interest taps. */
  const [interestUntil, setInterestUntil] = useState(0);
  /** There is a song to go BACK to. */
  const [canGoBack, setCanGoBack] = useState(false);
  const [lastHop, setLastHop] = useState<HopInfo | null>(null);

  const st = useRef({
    queue: [] as Track[],
    running: false,
    paused: false,
    nowIdx: -1,
    current: null as LoadedTrack | null,
    opts: { clipLen: "ai", useAi: true } as AutoMixOptions,
    prepared: null as Prepared | null,
    preparing: null as Promise<Prepared | null> | null,
    prepToken: null as object | null,
    refilling: false,
    hopping: false,
    setLog: [] as HopLogEntry[],
    /** Songs hopped away from, newest last, with where each was left (sec). */
    history: [] as { track: Track; at: number }[],
    arcStartedAt: 0,
    /** Interest taps: floor (track position, sec) before which no auto-hop may fire. */
    interestUntil: 0,
    /** Track position the armed auto-hop timer is aiming at. */
    hopTargetPos: 0,
    /** The vocal gap the armed auto-hop lands in (A position + pause length). */
    vocalGap: null as { dropAt: number; room: number; kind: "break" | "line" } | null,
    /** Stats (lib/client/telemetry): the set, and the song playing in it. */
    setId: "",
    playing: null as { id: string; startPos: number; setId: string; vibes: string[] } | null,
    /** The vibe changed mid-set: how the song playing now will be logged as ending. */
    endOverride: null as PlayEnd | null,
  });

  /** Stats: a set starts (also when the vibe changes mid-set). */
  function beginSet() {
    const s = st.current;
    s.setId = newSetId();
    logEvent({ type: "set", setId: s.setId, vibes: s.opts.vibes ?? [], page: location.pathname });
  }

  /** Stats: a song starts playing `startPos` seconds in. */
  function beginPlay(id: string, startPos: number) {
    const s = st.current;
    s.playing = { id, startPos, setId: s.setId, vibes: s.opts.vibes ?? [] };
  }

  /** Stats: the song playing now ends, `pos` seconds in. */
  function endPlay(end: PlayEnd, pos = getEngine().position()) {
    const s = st.current;
    const p = s.playing;
    if (!p) return;
    s.playing = null;
    const playedSec = Math.max(0, pos - p.startPos);
    logEvent({
      type: "play",
      setId: p.setId,
      vibes: p.vibes,
      page: location.pathname,
      track: p.id,
      playedSec,
      end: s.endOverride ?? end,
    });
    // a quick skip is the clearest "not this" a listener gives: the next refill hears it
    if (!s.endOverride && end === "skip" && playedSec < SKIP_SEC) noteSkipped(p.id);
    s.endOverride = null;
  }

  /** Sample the energy-arc director at the current set time (null if no arc). */
  function currentArc(): ArcTarget | null {
    const { arc } = st.current.opts;
    if (!arc || !st.current.arcStartedAt) return null;
    const elapsedMin = (Date.now() - st.current.arcStartedAt) / 60000;
    return arcTargetAt(arc.shape, elapsedMin / Math.max(1, arc.durationMin));
  }

  /**
   * Arc-aware song selection. Without this, the queue plays strictly FIFO and
   * the actual BPM of the next track is whatever the suggester/search happened
   * to land on - so a "build" set could hop to a slower song. Here we look at
   * the next few unplayed candidates, ANALYZE them (cached/prefetched), score
   * each against where the arc is headed - including the tempo DIRECTION, so it
   * climbs on a build and eases off on a wind-down - and pull the best fit to
   * the front of the upcoming queue. Tracks that don't fit now stay in the
   * queue for a phase where they will. No-op when no arc is running.
   */
  async function reorderNextForArc(): Promise<void> {
    const s = st.current;
    const arc = s.opts.arc;
    if (!arc || !s.arcStartedAt || !s.current) return;
    const startIdx = s.nowIdx + 1;
    const window = s.queue.slice(startIdx, startIdx + 4);
    if (window.length < 2) return; // nothing to choose between

    // Sample the arc a little AHEAD - at roughly when this hop will land - so a
    // moving target (build/wind-down) is matched to the future, not the present.
    const elapsedMin = (Date.now() - s.arcStartedAt) / 60000;
    const dur = Math.max(1, arc.durationMin);
    const aheadMin = 0.75;
    const p = (elapsedMin + aheadMin) / dur;
    const target = arcTargetAt(arc.shape, p);
    const trend = arcEnergyAt(arc.shape, Math.min(1, p + 0.05)) - arcEnergyAt(arc.shape, p);
    const ctx: ArcScoreCtx = {
      center: (target.bpm[0] + target.bpm[1]) / 2,
      curBpm: s.current.analysis.bpm,
      curCamelot: s.current.analysis.camelot,
      trend,
    };

    // Load+analyze candidates (cached/prefetched); cap the wait so prepare-ahead
    // never stalls on a slow download - unresolved candidates are simply skipped.
    const loaded = await Promise.all(
      window.map((t) =>
        Promise.race([
          loadTrack(t.id)
            .then((lt) => ({ track: t, analysis: lt.analysis }))
            .catch(() => null),
          new Promise<null>((r) => setTimeout(() => r(null), 4000)),
        ])
      )
    );
    const scored = loaded
      .filter((x): x is { track: Track; analysis: TrackAnalysis } => !!x)
      .map((x) => ({ track: x.track, score: scoreCandidateForArc(x.analysis, ctx) }));
    if (scored.length < 2) return;

    scored.sort((a, b) => b.score - a.score);
    const bestId = scored[0].track.id;
    const bestIdx = st.current.queue.findIndex((t) => t.id === bestId);
    if (bestIdx > startIdx) {
      setQueue((q) => {
        const copy = q.slice();
        const [item] = copy.splice(bestIdx, 1);
        copy.splice(startIdx, 0, item);
        return copy;
      });
    }
  }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      setPosition(getEngine().position());
      if (st.current.opts.arc && st.current.running) setArcInfo(currentArc());
    }, 250);
    return () => clearInterval(id);
  }, []);
  useEffect(() => () => stop(), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // the song ran out before the hop timer fired (it was waiting on a vocal
    // gap, an interest tap, a slow prepare...) - never sit in silence waiting
    // for the planned moment: bring the next song in right now
    const engine = getEngine();
    const onEnd = () => {
      const s = st.current;
      if (!s.running || s.paused) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      hopNow("auto");
    };
    engine.onTrackEnd = onEnd;
    return () => {
      if (engine.onTrackEnd === onEnd) engine.onTrackEnd = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // tab closed mid-song: log it before the page is gone
    const onHide = () => {
      endPlay("left");
      flushEvents();
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  /**
   * The song after the one playing. A plain queue loops back to its start; an
   * endless set never does - replaying its opening songs is what a listener
   * hears as "it keeps playing the same songs". It waits for the refill instead.
   */
  function upcoming(): Track | undefined {
    const s = st.current;
    const i = s.nowIdx + 1;
    if (i < s.queue.length) return s.queue[i];
    return s.opts.endless ? undefined : s.queue[i % s.queue.length];
  }

  function setQueue(q: Track[] | ((prev: Track[]) => Track[])) {
    // st.current.queue must update synchronously - pages call start()
    // right after setQueue, before React flushes state
    const next = typeof q === "function" ? q(st.current.queue) : q;
    st.current.queue = next;
    setQueueState(next);
  }

  /**
   * Add a track as the very next song (right after the one playing now),
   * not tacked onto the end - searching for a song mid-set means "play this
   * next", not "queue it for eventually". Before a set has started there's no
   * "next" yet, so it just appends in search order like before.
   */
  function addNext(track: Track) {
    const s = st.current;
    if (!s.running || s.nowIdx < 0) {
      setQueue((q) => [...q, track]);
      return;
    }
    setQueue((q) => {
      const copy = q.slice();
      copy.splice(s.nowIdx + 1, 0, track);
      return copy;
    });
    // whatever was prepared as "next" is now one slot further out - re-target
    // prepare-ahead (and the auto-hop timer) at the newly-inserted track
    s.prepared = null;
    prepareNext();
  }

  function stop() {
    endPlay("stop");
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    getEngine().stop();
    st.current.running = false;
    st.current.paused = false;
    setLastHop(null);
    st.current.current = null;
    st.current.prepared = null;
    st.current.preparing = null;
    st.current.interestUntil = 0;
    st.current.vocalGap = null;
    st.current.history = [];
    setCanGoBack(false);
    setInterestUntil(0);
    setRunning(false);
    setPaused(false);
    setNowIdx(-1);
    setNow(null);
    setNextReady(false);
  }

  /**
   * Pause/resume the whole mix in place (freezes the AudioContext clock, so
   * the playhead genuinely stops rather than the set tearing down). The
   * auto-hop timer is wall-clock based, so it's cleared on pause and re-armed
   * for its exact remaining wait on resume (the playhead hasn't moved).
   */
  async function togglePause() {
    const s = st.current;
    if (!s.running) return;
    if (s.paused) {
      s.paused = false;
      setPaused(false);
      await getEngine().resume();
      // re-arm fresh rather than trust a remembered target: prepareNext()
      // may have resolved while paused and skipped arming (see armTimer)
      if (!timer.current) armTimer(s.prepared);
    } else {
      s.paused = true;
      setPaused(true);
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      await getEngine().pause();
    }
  }

  async function start(opts: AutoMixOptions = {}) {
    const q = st.current.queue;
    if (!q.length) return;
    endPlay("stop");
    st.current.opts = { clipLen: "ai", useAi: true, ...opts };
    beginSet();
    await getEngine().resume();
    st.current.running = true;
    setRunning(true);
    st.current.setLog = [];
    st.current.history = [];
    setCanGoBack(false);
    setSetLog([]);
    st.current.arcStartedAt = Date.now();
    setArcInfo(currentArc());
    const first = await loadTrack(q[0].id, setStatus);
    if (!st.current.running) return;
    st.current.current = first;
    st.current.nowIdx = 0;
    setNow(first);
    setNowIdx(0);
    notePlayed(q[0].id);
    st.current.setLog.push({
      title: first.meta.title,
      artist: first.meta.artist,
      style: "crossfade",
      index: 0,
      thumbnail: first.meta.thumbnail,
    });
    setSetLog([...st.current.setLog]);
    const famous = first.meta.famousStart ?? 40;
    // open just before a sung line near the hook, not halfway through one
    const startAt = vocalStart(first, Math.max(0, famous - 5), 2);
    getEngine().startTrack(first.buffer, startAt, first.analysis);
    beginPlay(q[0].id, startAt);
    setStatus("");
    prepareNext();
    maybeRefill();
  }

  /**
   * Load + analyze + plan the hop to `track` (or the next in queue) while
   * the current song plays. Arms the auto-hop timer once the plan is known.
   */
  function prepareNext(track?: Track): Promise<Prepared | null> {
    if (!st.current.current || st.current.queue.length < 1)
      return Promise.resolve(null);

    const token = {};
    st.current.prepToken = token;
    const job = (async (): Promise<Prepared | null> => {
      try {
        // arc-aware selection: pull the best-fitting upcoming track to the
        // front of the queue before we lock onto a target (auto-advance only ,
        // an explicit user pick is honored as-is).
        if (!track) await reorderNextForArc();
        if (st.current.prepToken !== token) return st.current.prepared; // superseded

        // re-read state AFTER the reorder, which may have spliced the queue
        const s = st.current;
        const current = s.current;
        if (!current) return null;
        const target = track ?? upcoming();
        if (!target) return null;
        // already prepared & armed for this target - leave it (and nextReady) be
        if (s.prepared?.trackId === target.id) return s.prepared;

        setNextReady(false);
        const next = await loadTrack(target.id);
        let plan: TransitionPlan;
        if (st.current.opts.useAi) {
          try {
            // capped: a slow AI must never make a user gesture wait
            plan = await planTransition(current, next, getEngine().position(), {
              timeoutMs: 5000,
              stemsAvailable: st.current.opts.stems,
              handoffAvailable: !!handoffFor(current, next),
              arc: currentArc(),
              recentStyles: st.current.setLog
                .slice(-3)
                .map((e) => e.style)
                .reverse(),
            });
          } catch {
            plan = heuristicPlan(next, getEngine().position(), current);
          }
        } else {
          plan = heuristicPlan(next, getEngine().position(), current);
        }
        // forced style overrides whatever the planner chose
        if (st.current.opts.styleHint) plan.style = st.current.opts.styleHint;
        plan.beatMatch =
          Math.abs(current.analysis.bpm - next.analysis.bpm) /
            Math.max(current.analysis.bpm, 1) <
          0.08;
        const handoff = applyHandoff(plan, current, next);
        const prepared: Prepared = { trackId: target.id, next, plan, handoff };

        // key-lock: pre-stretch B (pitch-preserved) to A's tempo so beat-match
        // doesn't detune it - done now, during prepare-ahead, never at hop time.
        // A handoff always key-locks: A's singer is in key with B only if B
        // keeps its pitch
        if ((st.current.opts.keyLock || handoff) && plan.beatMatch) {
          const m = buildMatched(
            getEngine().ctx,
            next.buffer,
            current.analysis,
            next.analysis,
            plan.inPoint
          );
          if (m) prepared.matched = m;
        }

        // stems: pre-warm B's vocal stem so an acapella-in is ready at the hop
        if (st.current.opts.stems && plan.style === "stem_acapella") {
          loadStem(target.id, "vocals").catch(() => {});
        }

        if (st.current.prepToken === token) {
          st.current.prepared = prepared;
          setNextReady(true);
          armTimer(prepared);
        }
        return prepared;
      } catch {
        return null;
      }
    })();
    st.current.preparing = job;
    return job;
  }

  /** Arm the auto-hop timer. In "ai" mode the plan's outPoint decides. */
  function armTimer(prepared?: Prepared | null) {
    if (timer.current) clearTimeout(timer.current);
    st.current.vocalGap = null;
    // never schedule a hop while paused - prepareNext() can resolve after
    // the user paused; togglePause() re-arms fresh on resume instead
    if (st.current.paused) return;
    const { clipLen } = st.current.opts;
    if (!clipLen) return;
    const pos = getEngine().position();
    let waitSec: number;
    if (clipLen === "ai") {
      if (!prepared) return; // armed when preparation finishes
      const cur = st.current.current;
      // the banger must play out: never exit before the famous section has
      // landed - until its sung para ends when the vocal map shows where,
      // else the flat hook + a phrase (35s)
      const hook = cur
        ? hookEnd(cur.meta.vocals, cur.analysis, cur.meta.famousStart)
        : { at: 40 + HOOK_PLAYOUT, fromVocals: false };
      const famousEnd = hook.at;
      // user-set floor: a song must play at least this long before we leave it
      const minPlay = st.current.opts.minPlaySec ?? 25;
      // the song's own structure beats the planner's guess; without it, the
      // planner may aim far past the hook (a long outro looks tempting) and
      // half a minute after it is as long as a song is worth waiting on
      const planned = hook.fromVocals ? famousEnd : Math.min(prepared.plan.outPoint, famousEnd + 30);
      let target = Math.max(planned, famousEnd, minPlay);
      // don't run off the end of the track
      const dur = cur?.analysis.duration ?? Infinity;
      target = Math.min(target, dur - 12);
      // cap 150s so the set keeps moving; floor at the remaining time to minPlay
      waitSec = Math.min(Math.max(target - pos, minPlay - pos, 20), 150);
      // arc director: peak sections hop faster (rapid-fire hooks), chill
      // sections linger - pace the clip length to the current target energy
      const arc = currentArc();
      if (arc) {
        const arcClip = clipLenForEnergy(arc.energy);
        waitSec = Math.min(waitSec, Math.max(arcClip, famousEnd - pos));
        // never undercut the user's minimum-play floor
        waitSec = Math.max(waitSec, minPlay - pos, 0);
      }
    } else {
      waitSec = clipLen;
    }
    // interest taps: the user claimed more of this song - never hop inside it
    waitSec = Math.max(waitSec, st.current.interestUntil - pos);
    const cur = st.current.current;
    if (clipLen === "ai" && prepared && cur) {
      // leave when a sung line ends, not in the middle of one; the hook
      // play-out may give a few seconds if that is where the singer stops
      const famousEnd = hookEnd(cur.meta.vocals, cur.analysis, cur.meta.famousStart).at;
      const desired = pos + waitSec;
      const floor = Math.max(
        st.current.opts.minPlaySec ?? 25,
        st.current.interestUntil,
        Math.min(desired, famousEnd) - 4
      );
      const gap = aimAtVocalGap(cur, prepared.plan, pos, desired, floor, prepared.handoff);
      if (gap) {
        waitSec = gap.waitSec;
        st.current.vocalGap = { dropAt: gap.dropAt, room: gap.room, kind: gap.kind };
      }
    }
    // never wait past the end of the song: the floors above (20s, min-play,
    // interest taps, a vocal gap) can all land after it, and the blend has to
    // start while A still has audio left to mix out of
    const songDur = cur?.analysis.duration;
    if (songDur) {
      const blend = (prepared?.plan.duration ?? 4) + 1;
      const latest = Math.max(0, songDur - pos - blend);
      if (waitSec > latest) {
        waitSec = latest;
        st.current.vocalGap = null;
      }
    }
    st.current.hopTargetPos = st.current.vocalGap?.dropAt ?? pos + waitSec;
    timer.current = setTimeout(() => hopNow("auto"), waitSec * 1000);
  }

  /**
   * "I like this one" tap (spacebar/button): guarantee at least `minMoreSec`
   * more of the current song. Tapping at 5s extends the floor to 20s, at 10s
   * to 25s, and so on - an armed auto-hop inside the window is pushed back.
   */
  function tapInterest(minMoreSec = 15) {
    const s = st.current;
    if (!s.running || !s.current) return;
    const pos = getEngine().position();
    const until = Math.max(s.interestUntil, pos + minMoreSec);
    s.interestUntil = until;
    setInterestUntil(until);
    if (timer.current && s.hopTargetPos < until) {
      if (s.opts.clipLen === "ai" && s.prepared) {
        armTimer(s.prepared); // re-aims past the claim, at a vocal gap if one fits
        return;
      }
      clearTimeout(timer.current);
      s.vocalGap = null;
      s.hopTargetPos = until;
      timer.current = setTimeout(() => hopNow("auto"), (until - pos) * 1000);
    }
  }

  /**
   * Execute the prepared hop instantly. Never loads at hop time. Called bare
   * it is the listener's skip; the auto-hop timer and a held-NEXT drop say so.
   */
  async function hopNow(reason: "skip" | "drop" | "auto" = "skip") {
    const s = st.current;
    if (!s.running || s.hopping) return;
    s.hopping = true;
    try {
      let prepared = s.prepared;
      if (!prepared && s.preparing) {
        // wait briefly for in-flight prep (usually just the tail of the audio
        // download) but never hang a user gesture on it
        setStatus("next song still loading…");
        prepared = await Promise.race([
          s.preparing,
          new Promise<null>((r) => setTimeout(() => r(null), 8000)),
        ]);
      }
      if (!prepared) {
        // last resort: heuristic, no AI, still no blocking UI fetch beyond audio
        const target = upcoming();
        if (!target) {
          // an endless set ran dry (refill still in flight): fetch, don't replay
          setStatus("finding the next song…");
          maybeRefill();
          return;
        }
        const next = await loadTrack(target.id, setStatus);
        prepared = {
          trackId: target.id,
          next,
          plan: heuristicPlan(next, getEngine().position(), s.current ?? undefined),
        };
      }
      await executeHop(prepared, reason);
    } catch (e) {
      setStatus(`hop failed: ${e instanceof Error ? e.message : e} - skipping`);
      // never stall the set: drop the bad track and prepare the following one
      const s2 = st.current;
      const badIdx = s2.opts.endless ? s2.nowIdx + 1 : (s2.nowIdx + 1) % s2.queue.length;
      setQueue((q) => q.filter((_, i) => i !== badIdx));
      s2.prepared = null;
      prepareNext();
    } finally {
      st.current.hopping = false;
    }
  }

  /**
   * Transition to a specific track. Instant if it was prepared. `resumeAt`
   * brings it in at that position instead of its planned entry point.
   */
  async function transitionTo(track: Track, resumeAt?: number) {
    const s = st.current;
    if (!s.current || !s.running || s.hopping) return;
    s.hopping = true;
    try {
      let prepared =
        resumeAt == null && s.prepared?.trackId === track.id ? s.prepared : null;
      if (!prepared) {
        // not prepared: heuristic plan, zero AI latency at click time
        const next = await loadTrack(track.id, setStatus);
        const plan = heuristicPlan(next, getEngine().position(), s.current);
        if (s.opts.styleHint) plan.style = s.opts.styleHint;
        plan.beatMatch =
          Math.abs(s.current.analysis.bpm - next.analysis.bpm) /
            Math.max(s.current.analysis.bpm, 1) <
          0.08;
        // resuming a song where it was left: no handoff (it would move B's entry)
        const handoff = resumeAt == null ? applyHandoff(plan, s.current, next) : undefined;
        if (resumeAt != null) {
          if (plan.style === "vocal_handoff") plan.style = "bass_swap";
          plan.inPoint = resumeAt;
        }
        prepared = { trackId: track.id, next, plan, handoff };
        // no time to key-lock at click time: hand off only when B needs no stretch
        if (handoff && Math.abs(s.current.analysis.bpm / next.analysis.bpm - 1) > 0.01) {
          prepared.handoff = undefined;
          plan.style = "bass_swap";
        }
      }
      await executeHop(prepared, "pick", resumeAt != null);
    } catch (e) {
      setStatus(`transition failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      st.current.hopping = false;
    }
  }

  /**
   * BACK: transition to the song played before this one, picking it up where
   * it was left. Walks further back on each press.
   */
  async function goBack() {
    const s = st.current;
    if (!s.running || s.hopping) return;
    const prev = s.history.pop();
    if (!prev) return;
    setCanGoBack(s.history.length > 0);
    await transitionTo(prev.track, prev.at);
    // the song came back on purpose: give it a full min-play from here
    if (st.current.current?.meta.id === prev.track.id) {
      const until = prev.at + (s.opts.minPlaySec ?? 25);
      st.current.interestUntil = until;
      setInterestUntil(until);
      armTimer(st.current.prepared);
    }
  }

  async function executeHop(prepared: Prepared, end: Exclude<HopTrigger, "back">, back = false) {
    const s = st.current;
    const current = s.current;
    if (!current || !s.running) return;
    const { next, plan } = prepared;
    const engine = getEngine();

    // beat-grid quantization is handled INSIDE the engine now - every ramp
    // and source start is scheduled on the AudioContext clock against the
    // next phrase boundary, so drops land sample-accurate (no timer drift)
    const quantizeBeats =
      s.opts.quantize && engine.isPlaying() ? (s.opts.quantizeBeats ?? 16) : undefined;
    if (quantizeBeats) {
      const wait = engine.timeToDrop(current.analysis, quantizeBeats);
      if (wait > 1) setStatus(`dropping on the phrase in ${wait.toFixed(1)}s…`);
    }

    // A already played out: there is nothing left to blend, phrase-snap or
    // pre-roll against - start B now instead of performing a trick on silence
    const ranOut = !engine.isPlaying();
    if (ranOut) {
      plan.style = "cut";
      plan.reasoning = `${plan.reasoning} ⏭ Song ended before the mix point - next song straight in.`;
    }
    // stem-aware acapella-in: needs B's vocal stem ready - never block the hop
    let stemVocal: AudioBuffer | undefined;
    if (plan.style === "stem_acapella" && s.opts.stems) {
      try {
        stemVocal = await Promise.race([
          loadStem(prepared.trackId, "vocals"),
          new Promise<undefined>((r) => setTimeout(() => r(undefined), 1500)),
        ]);
      } catch {
        stemVocal = undefined;
      }
      if (!stemVocal) {
        // fail loud (design principle): say what degraded, don't fake it
        plan.style = "echo_out";
        setStatus("⚠ stems not ready → echo_out");
      }
    }

    if (s.opts.maxTransitionDur && plan.style !== "cut" && plan.style !== "vocal_handoff")
      plan.duration = Math.min(plan.duration, s.opts.maxTransitionDur);
    // auto-hop aimed at a vocal gap: B enters as A's line ends, and A is gone
    // before its singer comes back
    const gap = end === "auto" ? s.vocalGap : null;
    s.vocalGap = null;
    const dropAt = gap && gap.dropAt > engine.position() ? gap.dropAt : undefined;
    if (gap && dropAt != null && plan.style === "vocal_handoff") {
      plan.reasoning = `${plan.reasoning} 🎤 B's beat under A's last line, B's singer on the next bar.`;
    } else if (gap && dropAt != null) {
      // after a mere breath (dense pop) the blend has to be quick
      plan.duration = Math.min(plan.duration, Math.max(1.5, gap.room + 1));
      plan.reasoning = `${plan.reasoning} 🎤 ${
        gap.kind === "break" ? "Timed to the break after the vocal line." : "Timed to the end of a vocal line."
      }`;
    }
    // interest taps apply to the song they were tapped on - reset for the next
    s.interestUntil = 0;
    setInterestUntil(0);
    plan.outPoint = ranOut ? current.analysis.duration : engine.position();
    // stats: the transition itself, so its like / dislike can be read against
    // the songs, the cue points and the style that made it
    const lead = dropAt != null ? dropAt - engine.position() : quantizeBeats && !ranOut ? engine.timeToDrop(current.analysis, quantizeBeats) : 0;
    const hop: HopInfo = {
      hopId: newSetId(),
      from: { id: current.meta.id, title: current.meta.title, artist: current.meta.artist },
      to: { id: next.meta.id, title: next.meta.title, artist: next.meta.artist, thumbnail: next.meta.thumbnail },
      style: plan.style,
      outSec: plan.outPoint,
      inSec: plan.inPoint,
      durSec: plan.duration,
      trigger: back ? "back" : end,
      doneAt: Date.now() + (Math.max(0, lead) + Math.max(1, plan.duration)) * 1000,
      rating: null,
    };
    logEvent({
      type: "hop",
      hopId: hop.hopId,
      setId: s.setId,
      vibes: s.opts.vibes ?? [],
      page: location.pathname,
      from: hop.from.id,
      fromTitle: hop.from.title,
      fromArtist: hop.from.artist,
      to: hop.to.id,
      toTitle: hop.to.title,
      toArtist: hop.to.artist,
      style: plan.style,
      outSec: hop.outSec,
      inSec: hop.inSec,
      durSec: hop.durSec,
      trigger: hop.trigger,
      ranOut,
      beatMatch: plan.beatMatch || !!prepared.matched,
      keyLock: !!prepared.matched,
      vocal:
        plan.style === "vocal_handoff" && prepared.handoff ? "handoff" : gap && dropAt != null ? gap.kind : "",
      bpmFrom: current.analysis.bpm,
      bpmTo: next.analysis.bpm,
      keyFrom: current.analysis.camelot ?? "",
      keyTo: next.analysis.camelot ?? "",
    });
    setLastHop(hop);
    // remember where this song was left, so BACK can return to it (going back
    // itself doesn't, or BACK would bounce between the same two songs)
    const leaving = s.queue[s.nowIdx];
    if (!back && leaving && !ranOut) {
      s.history.push({ track: leaving, at: plan.outPoint });
      if (s.history.length > 50) s.history.shift();
      setCanGoBack(true);
    }
    endPlay(end, plan.outPoint);
    beginPlay(prepared.trackId, prepared.matched ? prepared.matched.inPoint : plan.inPoint);
    setLastPlan(plan);
    s.current = next;
    s.prepared = null;
    s.preparing = null;
    const idxInQueue = s.queue.findIndex((t) => t.id === prepared.trackId);
    s.nowIdx = idxInQueue >= 0 ? idxInQueue : (s.nowIdx + 1) % s.queue.length;
    setNow(next);
    setNowIdx(s.nowIdx);
    setNextReady(false);

    if (plan.style === "vocal_handoff" && prepared.handoff) {
      const m = prepared.matched;
      engine.vocalHandoff(m ? m.buffer : next.buffer, {
        inPoint: m ? m.inPoint : plan.inPoint,
        bars: prepared.handoff.entry.bars,
        analyses: { from: current.analysis, to: m ? m.analysis : next.analysis },
        quantizeBeats,
        dropAt,
      });
    } else if (plan.style === "stem_acapella" && stemVocal) {
      engine.stemSwap(next.buffer, {
        bVocal: stemVocal,
        inPoint: plan.inPoint,
        analyses: { from: current.analysis, to: next.analysis },
        quantizeBeats,
        dropAt,
      });
    } else if (prepared.matched) {
      // key-locked: play the pre-stretched buffer at rate 1 (pitch preserved)
      engine.transition(
        prepared.matched.buffer,
        { ...plan, beatMatch: false, inPoint: prepared.matched.inPoint },
        { from: current.analysis, to: prepared.matched.analysis },
        { quantizeBeats, dropAt }
      );
    } else {
      engine.transition(
        next.buffer,
        plan,
        { from: current.analysis, to: next.analysis },
        { quantizeBeats, dropAt }
      );
    }
    if (s.opts.keyLock && prepared.matched) setStatus("🔑 key-locked");
    else if (plan.style !== "stem_acapella") setStatus("");

    const hopTrack = s.queue[s.nowIdx];
    if (hopTrack) {
      notePlayed(hopTrack.id);
      s.setLog.push({
        title: hopTrack.title,
        artist: hopTrack.artist,
        style: plan.style,
        index: s.nowIdx,
        thumbnail: hopTrack.thumbnail,
      });
      setSetLog([...s.setLog]);
    }
    s.opts.onHop?.({ track: hopTrack, plan, index: s.nowIdx });
    prepareNext();
    maybeRefill();
  }

  /** The listener's like / dislike for a transition (the popup after it). */
  function rateHop(hopId: string, rating: "up" | "down") {
    logEvent({ type: "rate", hopId, setId: st.current.setId, rating });
    setLastHop((h) => (h && h.hopId === hopId ? { ...h, rating } : h));
  }

  /** Endless mode: keep ≥4 unplayed tracks ahead by asking the AI for more. */
  async function maybeRefill() {
    const s = st.current;
    if (!s.opts.endless || s.refilling) return;
    const remaining = s.queue.length - 1 - s.nowIdx;
    if (remaining >= 4) return;
    // 1-song start: with nothing else queued, prepare-ahead locked onto the
    // current song itself - remember so we can re-aim it at the fresh tracks
    const wasStarved = remaining <= 0;
    s.refilling = true;
    try {
      const currentTrack = s.queue[s.nowIdx];
      if (!currentTrack) return;
      // arc director: refill with songs that match where the curve is HEADED,
      // looking a little ahead so the next batch lands at the right energy
      const arc = s.opts.arc
        ? arcTargetAt(
            s.opts.arc.shape,
            ((Date.now() - s.arcStartedAt) / 60000 + 2) /
              Math.max(1, s.opts.arc.durationMin)
          )
        : null;
      const res = await fetch("/api/ai/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current: `${currentTrack.title} - ${currentTrack.artist}`,
          arc: arc
            ? { energy: +arc.energy.toFixed(2), phase: arc.phase, bpm: arc.bpm }
            : undefined,
          languages: getSelectedLanguageLabels(),
          songSource: getSongSource(),
          vibes: s.opts.vibes,
          ...listenerHistory(),
          // everything already queued, so a refill only brings new songs
          exclude: s.queue.slice(-150).map((t) => t.id),
        }),
      });
      if (!res.ok) return;
      const { suggestions } = await res.json();
      const found = await Promise.all(
        (suggestions as { query: string }[]).slice(0, 6).map((sg) =>
          searchTracks(sg.query).then((r) => r[0] ?? null).catch(() => null)
        )
      );
      const fresh = found.filter(
        (t): t is Track => !!t && !st.current.queue.some((q) => q.id === t.id)
      );
      if (fresh.length) {
        setQueue((q) => [...q, ...fresh]);
        if (wasStarved) {
          st.current.prepared = null;
          prepareNext();
        } else if (!st.current.prepared && !st.current.preparing) {
          // skipped to the end while this refill was in flight: aim at the new songs
          prepareNext();
        }
      }
    } catch {
      /* refill is best-effort */
    } finally {
      s.refilling = false;
    }
  }

  /**
   * Seek within the current song (vinyl-scratch transition in the engine),
   * then re-arm the auto-hop timer from the new position.
   */
  function seekTo(sec: number) {
    const s = st.current;
    if (!s.running || !s.current) return;
    getEngine().scratchSeek(sec);
    setPosition(getEngine().position());
    armTimer(s.prepared);
  }

  /**
   * Reorder the queue (drag-to-reorder UIs). Keeps `nowIdx` pointing at the
   * playing track and re-aims prepare-ahead if the upcoming song changed.
   */
  function moveInQueue(from: number, to: number) {
    const s = st.current;
    const len = s.queue.length;
    if (from === to || from < 0 || to < 0 || from >= len || to >= len) return;
    const curId = s.queue[s.nowIdx]?.id;
    setQueue((q) => {
      const copy = q.slice();
      const [item] = copy.splice(from, 1);
      copy.splice(to, 0, item);
      return copy;
    });
    if (curId) {
      const idx = st.current.queue.findIndex((t) => t.id === curId);
      if (idx >= 0) {
        s.nowIdx = idx;
        setNowIdx(idx);
      }
    }
    if (s.running) prepareNext(); // no-op if the next target didn't change
  }

  /** Update options mid-set (e.g. switching the forced trick live). */
  function setOptions(partial: Partial<AutoMixOptions>) {
    const revibe =
      st.current.running &&
      !!partial.vibes &&
      JSON.stringify(partial.vibes) !== JSON.stringify(st.current.opts.vibes ?? []);
    st.current.opts = { ...st.current.opts, ...partial };
    if (revibe) {
      // a new vibe mid-set is a new set; the song playing now ends because of it
      st.current.endOverride = "revibe";
      beginSet();
    }
    // a prepared plan may carry the old style; re-apply the hint
    if (partial.styleHint && st.current.prepared)
      st.current.prepared.plan.style = partial.styleHint;
  }

  /** Preload upcoming tracks' audio (no planning). */
  function prefetch(count = 2) {
    const { queue, nowIdx } = st.current;
    for (let k = 1; k <= count; k++) {
      const t = queue[(nowIdx + k) % queue.length];
      if (t) loadTrack(t.id).catch(() => {});
    }
  }

  /** Start capturing the live set to a recordable mixtape. */
  function startRecording(): boolean {
    if (mix) {
      URL.revokeObjectURL(mix.url);
      setMix(null);
    }
    const ok = getEngine().startRecording();
    if (ok) setRecording(true);
    return ok;
  }

  /** Stop recording; returns the captured mix (also exposed as `mix`). */
  async function stopRecording(): Promise<{ url: string; durationSec: number } | null> {
    if (!getEngine().recording) return null;
    try {
      const { blob, durationSec } = await getEngine().stopRecording();
      const out = { url: URL.createObjectURL(blob), durationSec };
      setMix(out);
      return out;
    } catch {
      return null;
    } finally {
      setRecording(false);
    }
  }

  return {
    queue,
    setQueue,
    addNext,
    running,
    paused,
    nowIdx,
    now,
    status,
    lastPlan,
    position,
    nextReady,
    setLog,
    recording,
    mix,
    arcInfo,
    interestUntil,
    start,
    stop,
    togglePause,
    hopNow,
    transitionTo,
    goBack,
    canGoBack,
    lastHop,
    rateHop,
    prepareNext,
    prefetch,
    setOptions,
    tapInterest,
    seekTo,
    moveInQueue,
    startRecording,
    stopRecording,
  };
}
