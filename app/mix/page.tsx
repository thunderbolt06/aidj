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

type Slot = {
  track: Track | null;
  loaded: LoadedTrack | null;
  status: string;
};

const emptySlot: Slot = { track: null, loaded: null, status: "" };

export default function MixPage() {
  const [a, setA] = useState<Slot>(emptySlot);
  const [b, setB] = useState<Slot>(emptySlot);
  const [playing, setPlaying] = useState<"none" | "A" | "transitioning" | "B">(
    "none"
  );
  const [position, setPosition] = useState(0);
  const [plan, setPlan] = useState<TransitionPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const raf = useRef(0);

  useEffect(() => {
    const tick = () => {
      setPosition(getEngine().position());
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, []);

  function pick(which: "A" | "B", t: Track) {
    const set = which === "A" ? setA : setB;
    set({ track: t, loaded: null, status: "queued…" });
    loadTrack(t.id, (s) => set((p) => ({ ...p, status: s })))
      .then((loaded) => set((p) => ({ ...p, loaded, status: "" })))
      .catch((e) => set((p) => ({ ...p, status: `failed: ${e.message}` })));
  }

  async function playA() {
    if (!a.loaded) return;
    await getEngine().resume();
    const start = Math.max(0, (a.loaded.meta.famousStart ?? 30) - 15);
    getEngine().startTrack(a.loaded.buffer, start);
    setPlaying("A");
  }

  async function doTransition() {
    if (!a.loaded || !b.loaded || playing !== "A") return;
    setPlanning(true);
    const pos = getEngine().position();
    let p: TransitionPlan;
    try {
      p = await planTransition(a.loaded, b.loaded, pos);
    } catch {
      p = heuristicPlan(b.loaded, pos);
    }
    setPlan(p);
    setPlanning(false);
    setPlaying("transitioning");
    getEngine().onTransitionEnd = () => setPlaying("B");
    getEngine().transition(b.loaded.buffer, p, {
      from: a.loaded.analysis,
      to: b.loaded.analysis,
    });
  }

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">2-Song Mix</h1>
        <p className="text-sm text-zinc-400">
          Pick two songs. Play A, then hit <b>AI Transition</b> — Claude reads
          both tracks&apos; BPM, energy and famous-part data and renders the blend
          live in your browser.
        </p>
      </header>

      <div className="grid gap-6 sm:grid-cols-2">
        {([
          ["A", a, pick.bind(null, "A")],
          ["B", b, pick.bind(null, "B")],
        ] as const).map(([label, slot, onPick]) => (
          <section
            key={label}
            className="rounded-xl border border-zinc-800 p-4 space-y-3"
          >
            <h2 className="font-semibold text-fuchsia-400">Deck {label}</h2>
            <SearchPicker onPick={onPick} />
            {slot.track && (
              <div className="text-sm">
                <p className="truncate font-medium">{slot.track.title}</p>
                <p className="truncate text-zinc-400">{slot.track.artist}</p>
                {slot.status && (
                  <p className="mt-1 animate-pulse text-xs text-amber-400">
                    {slot.status}
                  </p>
                )}
                {slot.loaded && (
                  <div className="mt-2 space-y-1">
                    <HeatmapBar
                      meta={slot.loaded.meta}
                      position={
                        (label === "A" && (playing === "A" || playing === "transitioning")) ||
                        (label === "B" && playing === "B")
                          ? position
                          : undefined
                      }
                    />
                    <p className="text-xs text-zinc-500">
                      {slot.loaded.analysis.bpm} BPM · famous part @{" "}
                      {slot.loaded.meta.famousStart ?? "?"}s
                    </p>
                  </div>
                )}
              </div>
            )}
          </section>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={playA}
          disabled={!a.loaded}
          className="rounded-lg bg-zinc-100 px-5 py-2.5 font-semibold text-zinc-900 disabled:opacity-40"
        >
          ▶ Play A
        </button>
        <button
          onClick={doTransition}
          disabled={!b.loaded || playing !== "A" || planning}
          className="rounded-lg bg-fuchsia-600 px-5 py-2.5 font-semibold hover:bg-fuchsia-500 disabled:opacity-40"
        >
          {planning ? "AI planning…" : "⚡ AI Transition → B"}
        </button>
        <button
          onClick={() => {
            getEngine().stop();
            setPlaying("none");
          }}
          className="rounded-lg border border-zinc-700 px-4 py-2.5 text-sm"
        >
          Stop
        </button>
        <span className="text-sm text-zinc-400">
          {playing !== "none" && `${playing} · ${position.toFixed(0)}s`}
        </span>
      </div>

      {plan && (
        <div className="rounded-xl border border-fuchsia-900/50 bg-fuchsia-950/20 p-4 text-sm">
          <p className="font-semibold text-fuchsia-300">
            {plan.style} · {plan.duration}s
            {plan.beatMatch ? " · beat-matched" : ""}
          </p>
          <p className="text-zinc-300">{plan.reasoning}</p>
          <p className="mt-1 text-xs text-zinc-500">
            out @ {plan.outPoint}s → in @ {plan.inPoint}s
          </p>
        </div>
      )}
    </main>
  );
}
