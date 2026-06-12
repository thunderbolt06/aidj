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
import { SearchPicker } from "@/components/SearchPicker";
import { HeatmapBar } from "@/components/HeatmapBar";

const STYLES: TransitionPlan["style"][] = [
  "bass_swap",
  "filter_sweep",
  "crossfade",
  "echo_out",
];

export default function AutoDjPage() {
  const [queue, setQueue] = useState<Track[]>([]);
  const [clipLen, setClipLen] = useState(60);
  const [useAi, setUseAi] = useState(true);
  const [running, setRunning] = useState(false);
  const [nowIdx, setNowIdx] = useState(-1);
  const [now, setNow] = useState<LoadedTrack | null>(null);
  const [status, setStatus] = useState("");
  const [lastPlan, setLastPlan] = useState<TransitionPlan | null>(null);
  const [position, setPosition] = useState(0);

  // refs so the scheduling loop sees fresh values
  const st = useRef({ queue, clipLen, useAi, running, nowIdx });
  st.current = { queue, clipLen, useAi, running, nowIdx };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const id = setInterval(() => setPosition(getEngine().position()), 250);
    return () => clearInterval(id);
  }, []);
  useEffect(() => () => stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  function stop() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    getEngine().stop();
    setRunning(false);
    setNowIdx(-1);
    setNow(null);
  }

  async function start() {
    if (queue.length === 0) return;
    await getEngine().resume();
    setRunning(true);
    st.current.running = true;
    const first = await loadTrack(queue[0].id, setStatus);
    setNow(first);
    setNowIdx(0);
    const famous = first.meta.famousStart ?? 40;
    getEngine().startTrack(first.buffer, Math.max(0, famous - 5));
    scheduleHop(first, 0);
  }

  /** While the current clip plays, preload the next track and plan the hop. */
  function scheduleHop(current: LoadedTrack, idx: number) {
    const { queue, clipLen } = st.current;
    const nextIdx = (idx + 1) % queue.length;
    if (queue.length < 2) return;

    const hopInMs = clipLen * 1000;
    const prep = (async () => {
      const next = await loadTrack(queue[nextIdx].id, setStatus);
      let plan: TransitionPlan;
      if (st.current.useAi) {
        try {
          plan = await planTransition(current, next, 0);
        } catch {
          plan = heuristicPlan(next, 0);
        }
      } else {
        plan = heuristicPlan(next, 0);
        plan.style = STYLES[idx % STYLES.length];
        plan.beatMatch =
          Math.abs(current.analysis.bpm - next.analysis.bpm) /
            current.analysis.bpm <
          0.08;
      }
      return { next, plan };
    })();

    timer.current = setTimeout(async () => {
      if (!st.current.running) return;
      try {
        const { next, plan } = await prep;
        plan.outPoint = getEngine().position();
        setLastPlan(plan);
        setNow(next);
        setNowIdx(nextIdx);
        getEngine().transition(next.buffer, plan, {
          from: current.analysis,
          to: next.analysis,
        });
        scheduleHop(next, nextIdx);
      } catch (e) {
        setStatus(`hop failed: ${e instanceof Error ? e.message : e}`);
        stop();
      }
    }, hopInMs);
  }

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Auto-DJ</h1>
        <p className="text-sm text-zinc-400">
          Only the famous part of every song — auto-transition every{" "}
          {clipLen}s. Built on the YouTube &quot;most replayed&quot; heatmap.
        </p>
      </header>

      <SearchPicker
        placeholder="Add songs to the queue…"
        onPick={(t) => setQueue((q) => [...q, t])}
      />

      {queue.length > 0 && (
        <ul className="space-y-1 text-sm">
          {queue.map((t, i) => (
            <li
              key={`${t.id}-${i}`}
              className={`flex items-center justify-between rounded px-3 py-1.5 ${
                i === nowIdx ? "bg-fuchsia-950/40 text-fuchsia-300" : "bg-zinc-900"
              }`}
            >
              <span className="truncate">
                {i + 1}. {t.title}
              </span>
              <button
                onClick={() => setQueue((q) => q.filter((_, j) => j !== i))}
                className="ml-2 text-zinc-500 hover:text-red-400"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {[30, 60].map((len) => (
          <button
            key={len}
            onClick={() => setClipLen(len)}
            className={`rounded-lg px-4 py-2 text-sm ${
              clipLen === len
                ? "bg-fuchsia-600"
                : "border border-zinc-700 text-zinc-300"
            }`}
          >
            {len}s clips
          </button>
        ))}
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={useAi}
            onChange={(e) => setUseAi(e.target.checked)}
          />
          AI plans each transition
        </label>
        {!running ? (
          <button
            onClick={start}
            disabled={queue.length < 2}
            className="rounded-lg bg-zinc-100 px-5 py-2 font-semibold text-zinc-900 disabled:opacity-40"
          >
            ▶ Start set
          </button>
        ) : (
          <button
            onClick={stop}
            className="rounded-lg border border-zinc-700 px-5 py-2 font-semibold"
          >
            ◼ Stop
          </button>
        )}
      </div>

      {status && <p className="animate-pulse text-xs text-amber-400">{status}</p>}

      {now && (
        <div className="rounded-xl border border-zinc-800 p-4 space-y-2">
          <p className="font-semibold">{now.meta.title}</p>
          <HeatmapBar meta={now.meta} position={position} />
          <p className="text-xs text-zinc-500">
            {now.analysis.bpm} BPM · famous @ {now.meta.famousStart ?? "?"}s
          </p>
          {lastPlan && (
            <p className="text-xs text-fuchsia-300">
              last hop: {lastPlan.style}
              {lastPlan.beatMatch ? " (beat-matched)" : ""} — {lastPlan.reasoning}
            </p>
          )}
        </div>
      )}
    </main>
  );
}
