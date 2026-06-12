"use client";

import { useEffect, useRef, useState } from "react";
import type { Track, TransitionPlan } from "@/lib/types";
import {
  getEngine,
  heuristicPlan,
  loadTrack,
  planTransition,
  searchTracks,
  type LoadedTrack,
} from "@/lib/client/dj";

export interface AutoMixOptions {
  /**
   * Seconds per song before auto-hop. "ai" lets the transition plan's
   * outPoint decide when to leave each song. 0 = no auto-hop (user-driven).
   */
  clipLen?: number | "ai";
  useAi?: boolean;
  styleHint?: TransitionPlan["style"];
  /** Wait for the next phrase boundary before executing transitions. */
  quantize?: boolean;
  /** Phrase length in beats (16 = 4 bars; 8 feels snappier). */
  quantizeBeats?: number;
  /** Auto-refill the queue with AI suggestions so the set never ends. */
  endless?: boolean;
  /** Cap transition length (snappy UIs like reels want ≤4s). */
  maxTransitionDur?: number;
  /** Called after every completed hop. */
  onHop?: (info: { track: Track; plan: TransitionPlan; index: number }) => void;
}

interface Prepared {
  trackId: string;
  next: LoadedTrack;
  plan: TransitionPlan;
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
  const [nowIdx, setNowIdx] = useState(-1);
  const [now, setNow] = useState<LoadedTrack | null>(null);
  const [status, setStatus] = useState("");
  const [lastPlan, setLastPlan] = useState<TransitionPlan | null>(null);
  const [position, setPosition] = useState(0);
  const [nextReady, setNextReady] = useState(false);

  const st = useRef({
    queue: [] as Track[],
    running: false,
    nowIdx: -1,
    current: null as LoadedTrack | null,
    opts: { clipLen: "ai", useAi: true } as AutoMixOptions,
    prepared: null as Prepared | null,
    preparing: null as Promise<Prepared | null> | null,
    prepToken: null as object | null,
    refilling: false,
    hopping: false,
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const id = setInterval(() => setPosition(getEngine().position()), 250);
    return () => clearInterval(id);
  }, []);
  useEffect(() => () => stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  function setQueue(q: Track[] | ((prev: Track[]) => Track[])) {
    // st.current.queue must update synchronously — pages call start()
    // right after setQueue, before React flushes state
    const next = typeof q === "function" ? q(st.current.queue) : q;
    st.current.queue = next;
    setQueueState(next);
  }

  function stop() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    getEngine().stop();
    st.current.running = false;
    st.current.current = null;
    st.current.prepared = null;
    st.current.preparing = null;
    setRunning(false);
    setNowIdx(-1);
    setNow(null);
    setNextReady(false);
  }

  async function start(opts: AutoMixOptions = {}) {
    const q = st.current.queue;
    if (!q.length) return;
    st.current.opts = { clipLen: "ai", useAi: true, ...opts };
    await getEngine().resume();
    st.current.running = true;
    setRunning(true);
    const first = await loadTrack(q[0].id, setStatus);
    if (!st.current.running) return;
    st.current.current = first;
    st.current.nowIdx = 0;
    setNow(first);
    setNowIdx(0);
    const famous = first.meta.famousStart ?? 40;
    getEngine().startTrack(first.buffer, Math.max(0, famous - 5));
    setStatus("");
    prepareNext();
    maybeRefill();
  }

  /**
   * Load + analyze + plan the hop to `track` (or the next in queue) while
   * the current song plays. Arms the auto-hop timer once the plan is known.
   */
  function prepareNext(track?: Track): Promise<Prepared | null> {
    const { queue, nowIdx, current } = st.current;
    const target = track ?? queue[(nowIdx + 1) % queue.length];
    if (!target || !current || queue.length < 1) return Promise.resolve(null);
    if (st.current.prepared?.trackId === target.id)
      return Promise.resolve(st.current.prepared);

    setNextReady(false);
    const token = {};
    st.current.prepToken = token;
    const job = (async (): Promise<Prepared | null> => {
      try {
        const next = await loadTrack(target.id);
        let plan: TransitionPlan;
        if (st.current.opts.useAi) {
          try {
            // capped: a slow AI must never make a user gesture wait
            plan = await planTransition(current, next, getEngine().position(), {
              timeoutMs: 5000,
            });
          } catch {
            plan = heuristicPlan(next, getEngine().position());
          }
        } else {
          plan = heuristicPlan(next, getEngine().position());
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
    const { clipLen } = st.current.opts;
    if (!clipLen) return;
    let waitSec: number;
    if (clipLen === "ai") {
      if (!prepared) return; // armed when preparation finishes
      const cur = st.current.current;
      const pos = getEngine().position();
      // the banger must play out: never exit before the famous section
      // (hook + a phrase ≈ 35s) has fully landed
      const famousEnd = (cur?.meta.famousStart ?? 40) + 35;
      let target = Math.max(prepared.plan.outPoint, famousEnd);
      // don't run off the end of the track
      const dur = cur?.analysis.duration ?? Infinity;
      target = Math.min(target, dur - 12);
      // floor 25s so every song registers, cap 150s so the set keeps moving
      waitSec = Math.min(Math.max(target - pos, 25), 150);
    } else {
      waitSec = clipLen;
    }
    timer.current = setTimeout(() => hopNow(), waitSec * 1000);
  }

  /** Execute the prepared hop instantly. Never loads at hop time. */
  async function hopNow() {
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
        const target = s.queue[(s.nowIdx + 1) % s.queue.length];
        if (!target) return;
        const next = await loadTrack(target.id, setStatus);
        prepared = {
          trackId: target.id,
          next,
          plan: heuristicPlan(next, getEngine().position()),
        };
      }
      await executeHop(prepared);
    } catch (e) {
      setStatus(`hop failed: ${e instanceof Error ? e.message : e} — skipping`);
      // never stall the set: drop the bad track and prepare the following one
      const s2 = st.current;
      const badIdx = (s2.nowIdx + 1) % s2.queue.length;
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
      let prepared =
        s.prepared?.trackId === track.id ? s.prepared : null;
      if (!prepared) {
        // not prepared: heuristic plan, zero AI latency at click time
        const next = await loadTrack(track.id, setStatus);
        const plan = heuristicPlan(next, getEngine().position());
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

  async function executeHop(prepared: Prepared) {
    const s = st.current;
    const current = s.current;
    if (!current || !s.running) return;
    const { next, plan } = prepared;

    // beat-grid quantization is handled INSIDE the engine now — every ramp
    // and source start is scheduled on the AudioContext clock against the
    // next phrase boundary, so drops land sample-accurate (no timer drift)
    const quantizeBeats = s.opts.quantize ? (s.opts.quantizeBeats ?? 16) : undefined;
    if (quantizeBeats) {
      const wait = getEngine().timeToDrop(current.analysis, quantizeBeats);
      if (wait > 1) setStatus(`dropping on the phrase in ${wait.toFixed(1)}s…`);
    }

    if (s.opts.maxTransitionDur && plan.style !== "cut")
      plan.duration = Math.min(plan.duration, s.opts.maxTransitionDur);
    plan.outPoint = getEngine().position();
    setLastPlan(plan);
    s.current = next;
    s.prepared = null;
    s.preparing = null;
    const idxInQueue = s.queue.findIndex((t) => t.id === prepared.trackId);
    s.nowIdx = idxInQueue >= 0 ? idxInQueue : (s.nowIdx + 1) % s.queue.length;
    setNow(next);
    setNowIdx(s.nowIdx);
    setNextReady(false);
    getEngine().transition(
      next.buffer,
      plan,
      { from: current.analysis, to: next.analysis },
      { quantizeBeats }
    );
    setStatus("");
    s.opts.onHop?.({
      track: s.queue[s.nowIdx],
      plan,
      index: s.nowIdx,
    });
    prepareNext();
    maybeRefill();
  }

  /** Endless mode: keep ≥4 unplayed tracks ahead by asking the AI for more. */
  async function maybeRefill() {
    const s = st.current;
    if (!s.opts.endless || s.refilling) return;
    const remaining = s.queue.length - 1 - s.nowIdx;
    if (remaining >= 4) return;
    s.refilling = true;
    try {
      const currentTrack = s.queue[s.nowIdx];
      if (!currentTrack) return;
      const res = await fetch("/api/ai/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current: `${currentTrack.title} — ${currentTrack.artist}`,
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
      if (fresh.length) setQueue((q) => [...q, ...fresh]);
    } catch {
      /* refill is best-effort */
    } finally {
      s.refilling = false;
    }
  }

  /** Update options mid-set (e.g. switching the forced trick live). */
  function setOptions(partial: Partial<AutoMixOptions>) {
    st.current.opts = { ...st.current.opts, ...partial };
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

  return {
    queue,
    setQueue,
    running,
    nowIdx,
    now,
    status,
    lastPlan,
    position,
    nextReady,
    start,
    stop,
    hopNow,
    transitionTo,
    prepareNext,
    prefetch,
    setOptions,
  };
}
