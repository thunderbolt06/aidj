"use client";

import { useEffect, useRef, useState } from "react";
import type { Track, TransitionPlan } from "@/lib/types";
import {
  getEngine,
  heuristicPlan,
  loadTrack,
  planTransition,
  type LoadedTrack,
} from "@/lib/client/dj";
import { timeToNextPhrase } from "@/lib/audio/analysis";

export interface AutoMixOptions {
  clipLen?: number; // seconds per song before auto-hop; 0 = no auto-hop
  useAi?: boolean;
  styleHint?: TransitionPlan["style"];
  /** Wait for the next phrase boundary (4 bars) before executing transitions. */
  quantize?: boolean;
}

/**
 * Shared auto-mix loop: plays the famous part of each queued track and
 * transitions on a timer (or on demand via hopNow / transitionTo).
 */
export function useAutoMix() {
  const [queue, setQueueState] = useState<Track[]>([]);
  const [running, setRunning] = useState(false);
  const [nowIdx, setNowIdx] = useState(-1);
  const [now, setNow] = useState<LoadedTrack | null>(null);
  const [status, setStatus] = useState("");
  const [lastPlan, setLastPlan] = useState<TransitionPlan | null>(null);
  const [position, setPosition] = useState(0);

  const st = useRef({
    queue: [] as Track[],
    running: false,
    nowIdx: -1,
    current: null as LoadedTrack | null,
    opts: { clipLen: 60, useAi: true } as AutoMixOptions,
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const id = setInterval(() => setPosition(getEngine().position()), 250);
    return () => clearInterval(id);
  }, []);
  // stop on unmount
  useEffect(() => () => stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  function setQueue(q: Track[] | ((prev: Track[]) => Track[])) {
    setQueueState((prev) => {
      const next = typeof q === "function" ? q(prev) : q;
      st.current.queue = next;
      return next;
    });
  }

  function stop() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    getEngine().stop();
    st.current.running = false;
    st.current.current = null;
    setRunning(false);
    setNowIdx(-1);
    setNow(null);
  }

  async function start(opts: AutoMixOptions = {}) {
    const queue = st.current.queue;
    if (!queue.length) return;
    st.current.opts = { clipLen: 60, useAi: true, ...opts };
    await getEngine().resume();
    st.current.running = true;
    setRunning(true);
    const first = await loadTrack(queue[0].id, setStatus);
    st.current.current = first;
    st.current.nowIdx = 0;
    setNow(first);
    setNowIdx(0);
    const famous = first.meta.famousStart ?? 40;
    getEngine().startTrack(first.buffer, Math.max(0, famous - 5));
    armTimer();
  }

  function armTimer() {
    if (timer.current) clearTimeout(timer.current);
    const { clipLen } = st.current.opts;
    if (!clipLen) return;
    timer.current = setTimeout(() => hopNow(), clipLen * 1000);
  }

  /** Transition to a specific track (e.g. tapped on the 9-grid). */
  async function transitionTo(track: Track) {
    const current = st.current.current;
    if (!current || !st.current.running) return;
    if (timer.current) clearTimeout(timer.current);
    setStatus("loading next…");
    try {
      const next = await loadTrack(track.id, setStatus);
      let plan: TransitionPlan;
      if (st.current.opts.useAi) {
        try {
          plan = await planTransition(current, next, getEngine().position());
        } catch {
          plan = heuristicPlan(next, getEngine().position());
        }
      } else {
        plan = heuristicPlan(next, getEngine().position());
        if (st.current.opts.styleHint) plan.style = st.current.opts.styleHint;
        plan.beatMatch =
          Math.abs(current.analysis.bpm - next.analysis.bpm) /
            current.analysis.bpm <
          0.08;
      }
      // quantize: hold the drop until the next phrase boundary in A,
      // and snap B's entry onto its own beat grid
      if (st.current.opts.quantize) {
        const wait = timeToNextPhrase(current.analysis, getEngine().position());
        if (wait > 0.05) {
          setStatus(`dropping on the phrase in ${wait.toFixed(1)}s…`);
          await new Promise((r) => setTimeout(r, wait * 1000 - 30));
        }
        const beatLen = 60 / Math.max(next.analysis.bpm, 1);
        plan.inPoint =
          next.analysis.beatOffset +
          Math.round((plan.inPoint - next.analysis.beatOffset) / beatLen) * beatLen;
        if (plan.inPoint < 0) plan.inPoint = 0;
        plan.beatMatch = true;
      }
      if (!st.current.running) return;
      plan.outPoint = getEngine().position();
      setLastPlan(plan);
      st.current.current = next;
      const idxInQueue = st.current.queue.findIndex((t) => t.id === track.id);
      st.current.nowIdx = idxInQueue;
      setNow(next);
      setNowIdx(idxInQueue);
      getEngine().transition(next.buffer, plan, {
        from: current.analysis,
        to: next.analysis,
      });
      setStatus("");
      armTimer();
    } catch (e) {
      setStatus(`hop failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Hop to the next track in the queue. */
  async function hopNow() {
    const { queue, nowIdx, running } = st.current;
    if (!running || queue.length < 2) return;
    const next = queue[(nowIdx + 1) % queue.length];
    await transitionTo(next);
  }

  /** Preload upcoming tracks so hops are instant. */
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
    start,
    stop,
    hopNow,
    transitionTo,
    prefetch,
  };
}
