import { useEffect, useRef, useState } from "react";
import type { Track, TransitionPlan } from "../types";
import {
  getEngine,
  heuristicPlan,
  loadTrack,
  planTransition,
  searchTracks,
  type LoadedTrack,
} from "./dj";
import { apiUrl } from "../config";
import { getSelectedLanguageLabels, getSongSource } from "../prefs";
import { listenerHistory, notePlayed, noteSkipped, SKIP_SEC } from "../history";
import { pickVocalExit, vocalExits } from "./vocalExits";

/** Margin between the auto-hop timer firing and the planned drop. */
const VOCAL_GAP_MARGIN = 2.5;

/**
 * Aim an auto-hop at a vocal gap: the first moment near `desired` where A's
 * sung line has ended and the band plays alone, so B comes in without cutting
 * a word off or stacking two singers. Null when A has no vocal map or no gap
 * fits - the caller then hops at `desired` as before. (Web twin in
 * lib/client/useAutoMix.ts; no stems here, so no acapella lead-in.)
 */
function aimAtVocalGap(
  current: LoadedTrack,
  pos: number,
  desired: number,
  floor: number
): { waitSec: number; dropAt: number; room: number; kind: "break" | "line" } | null {
  const a = current.analysis;
  const preRoll = 4 * (a.bpm > 0 ? 60 / a.bpm : 0.5); // longest engine pre-roll
  const hardFloor = pos + preRoll + VOCAL_GAP_MARGIN + 0.5;
  const exit = pickVocalExit(vocalExits(current.meta.vocals, a), desired, Math.max(floor, hardFloor));
  if (!exit || exit.at > a.duration - 8) return null;
  return {
    waitSec: Math.max(0, exit.at - preRoll - VOCAL_GAP_MARGIN - pos),
    dropAt: exit.at,
    room: exit.room,
    kind: exit.kind,
  };
}

/**
 * Shared auto-mix loop, prepare-ahead edition — port of the web
 * lib/client/useAutoMix.ts, home-feature subset (no key-lock, stems,
 * energy-arc or recording paths).
 *
 * Core principle (user feedback): NOTHING loads or thinks at the moment of
 * transition. While a song plays, the next track is fetched, decoded,
 * analyzed and the transition fully planned. User actions only execute.
 */

export interface AutoMixOptions {
  /**
   * Seconds per song before auto-hop. "ai" lets the transition plan's
   * outPoint decide when to leave each song. 0 = no auto-hop (user-driven).
   */
  clipLen?: number | "ai";
  useAi?: boolean;
  /**
   * Minimum seconds a song must play before an AI-timed transition may fire.
   * Only applies in "ai" timing mode. Defaults to 25.
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
   * sent with every refill so the queue keeps to the vibe.
   */
  vibes?: string[];
  /** Cap transition length (snappy UIs want ≤4s). */
  maxTransitionDur?: number;
  /** Called after every completed hop. */
  onHop?: (info: { track: Track; plan: TransitionPlan; index: number }) => void;
}

interface Prepared {
  trackId: string;
  next: LoadedTrack;
  plan: TransitionPlan;
}

export interface HopLogEntry {
  title: string;
  artist: string;
  style: TransitionPlan["style"];
  index: number;
}

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
  /** Track position (sec) the user has "claimed" via interest taps. */
  const [interestUntil, setInterestUntil] = useState(0);

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
    /** Interest taps: floor (track position, sec) before which no auto-hop may fire. */
    interestUntil: 0,
    /** Track position the armed auto-hop timer is aiming at. */
    hopTargetPos: 0,
    /** The vocal gap the armed auto-hop lands in (A position + pause length). */
    vocalGap: null as { dropAt: number; room: number; kind: "break" | "line" } | null,
    /** Track position the song playing now started at (to tell a quick skip). */
    startPos: 0,
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      setPosition(getEngine().position());
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

  function setQueue(q: Track[] | ((prev: Track[]) => Track[])) {
    // st.current.queue must update synchronously - callers invoke start()
    // right after setQueue, before React flushes state
    const next = typeof q === "function" ? q(st.current.queue) : q;
    st.current.queue = next;
    setQueueState(next);
  }

  /**
   * Add a track as the very next song (right after the one playing now) -
   * searching for a song mid-set means "play this next". Before a set has
   * started there's no "next" yet, so it appends in search order.
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
    s.prepared = null;
    prepareNext();
  }

  function stop() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    getEngine().stop();
    st.current.running = false;
    st.current.paused = false;
    st.current.current = null;
    st.current.prepared = null;
    st.current.preparing = null;
    st.current.interestUntil = 0;
    st.current.vocalGap = null;
    setInterestUntil(0);
    setRunning(false);
    setPaused(false);
    setNowIdx(-1);
    setNow(null);
    setNextReady(false);
  }

  /**
   * Pause/resume the whole mix in place (freezes the AudioContext clock).
   * The auto-hop timer is wall-clock based, so it's cleared on pause and
   * re-armed on resume (the playhead hasn't moved).
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
    st.current.opts = { clipLen: "ai", useAi: true, ...opts };
    await getEngine().resume();
    st.current.running = true;
    setRunning(true);
    st.current.setLog = [];
    setSetLog([]);
    const first = await loadTrack(q[0].id, setStatus);
    if (!st.current.running) return;
    st.current.current = first;
    st.current.nowIdx = 0;
    setNow(first);
    setNowIdx(0);
    st.current.setLog.push({
      title: first.meta.title,
      artist: first.meta.artist,
      style: "crossfade",
      index: 0,
    });
    setSetLog([...st.current.setLog]);
    const famous = first.meta.famousStart ?? 40;
    getEngine().startTrack(first.buffer, Math.max(0, famous - 5), first.analysis);
    st.current.startPos = Math.max(0, famous - 5);
    notePlayed(q[0].id);
    setStatus("");
    prepareNext();
    maybeRefill();
  }

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
        const prepared: Prepared = { trackId: target.id, next, plan };

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
      // the banger must play out: never exit before the famous section
      // (hook + a phrase ≈ 35s) has fully landed
      const famousEnd = (cur?.meta.famousStart ?? 40) + 35;
      // user-set floor: a song must play at least this long before we leave it
      const minPlay = st.current.opts.minPlaySec ?? 25;
      let target = Math.max(prepared.plan.outPoint, famousEnd, minPlay);
      // don't run off the end of the track
      const dur = cur?.analysis.duration ?? Infinity;
      target = Math.min(target, dur - 12);
      // cap 150s so the set keeps moving; floor at the remaining time to minPlay
      waitSec = Math.min(Math.max(target - pos, minPlay - pos, 20), 150);
    } else {
      waitSec = clipLen;
    }
    // interest taps: the user claimed more of this song - never hop inside it
    waitSec = Math.max(waitSec, st.current.interestUntil - pos);
    const cur = st.current.current;
    if (clipLen === "ai" && prepared && cur) {
      // leave when a sung line ends, not in the middle of one; the hook
      // play-out may give a few seconds if that is where the singer stops
      const famousEnd = (cur.meta.famousStart ?? 40) + 35;
      const desired = pos + waitSec;
      const floor = Math.max(
        st.current.opts.minPlaySec ?? 25,
        st.current.interestUntil,
        Math.min(desired, famousEnd) - 4
      );
      const gap = aimAtVocalGap(cur, pos, desired, floor);
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
   * "I like this one" tap: guarantee at least `minMoreSec` more of the
   * current song - an armed auto-hop inside the window is pushed back.
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
   * it is the listener's skip; the auto-hop timer passes "auto".
   */
  async function hopNow(reason?: "auto" | "drop") {
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
      // a quick tap past a song is the clearest "not this" a listener gives
      const playing = s.queue[s.nowIdx];
      if (!reason && playing && getEngine().position() - s.startPos < SKIP_SEC) noteSkipped(playing.id);
      await executeHop(prepared, reason === "auto");
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

  /** Transition to a specific track. Instant if it was prepared. */
  async function transitionTo(track: Track) {
    const s = st.current;
    if (!s.current || !s.running || s.hopping) return;
    s.hopping = true;
    try {
      let prepared = s.prepared?.trackId === track.id ? s.prepared : null;
      if (!prepared) {
        // not prepared: heuristic plan, zero AI latency at tap time
        const next = await loadTrack(track.id, setStatus);
        const plan = heuristicPlan(next, getEngine().position(), s.current);
        if (s.opts.styleHint) plan.style = s.opts.styleHint;
        plan.beatMatch =
          Math.abs(s.current.analysis.bpm - next.analysis.bpm) /
            Math.max(s.current.analysis.bpm, 1) <
          0.08;
        prepared = { trackId: track.id, next, plan };
      }
      await executeHop(prepared);
    } catch (e) {
      setStatus(`transition failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      st.current.hopping = false;
    }
  }

  async function executeHop(prepared: Prepared, auto = false) {
    const s = st.current;
    const current = s.current;
    if (!current || !s.running) return;
    const { next, plan } = prepared;
    const engine = getEngine();

    // beat-grid quantization is handled INSIDE the engine - every ramp and
    // source start is scheduled on the AudioContext clock against the next
    // phrase boundary, so drops land sample-accurate (no timer drift)
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

    if (s.opts.maxTransitionDur && plan.style !== "cut")
      plan.duration = Math.min(plan.duration, s.opts.maxTransitionDur);
    // auto-hop aimed at a vocal gap: B enters as A's line ends, and A is gone
    // before its singer comes back
    const gap = auto ? s.vocalGap : null;
    s.vocalGap = null;
    const dropAt = gap && gap.dropAt > engine.position() ? gap.dropAt : undefined;
    if (gap && dropAt != null) {
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
    setLastPlan(plan);
    s.current = next;
    s.prepared = null;
    s.preparing = null;
    const idxInQueue = s.queue.findIndex((t) => t.id === prepared.trackId);
    s.nowIdx = idxInQueue >= 0 ? idxInQueue : (s.nowIdx + 1) % s.queue.length;
    setNow(next);
    setNowIdx(s.nowIdx);
    setNextReady(false);

    engine.transition(
      next.buffer,
      plan,
      { from: current.analysis, to: next.analysis },
      { quantizeBeats, dropAt }
    );
    setStatus("");

    s.startPos = plan.inPoint;
    const hopTrack = s.queue[s.nowIdx];
    if (hopTrack) {
      notePlayed(hopTrack.id);
      s.setLog.push({
        title: hopTrack.title,
        artist: hopTrack.artist,
        style: plan.style,
        index: s.nowIdx,
      });
      setSetLog([...s.setLog]);
    }
    s.opts.onHop?.({ track: hopTrack, plan, index: s.nowIdx });
    prepareNext();
    maybeRefill();
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
      const res = await fetch(apiUrl("/api/ai/suggest"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current: `${currentTrack.title} - ${currentTrack.artist}`,
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

  /** Update options mid-set. */
  function setOptions(partial: Partial<AutoMixOptions>) {
    st.current.opts = { ...st.current.opts, ...partial };
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
    interestUntil,
    start,
    stop,
    togglePause,
    hopNow,
    transitionTo,
    prepareNext,
    prefetch,
    setOptions,
    tapInterest,
    seekTo,
    moveInQueue,
  };
}
