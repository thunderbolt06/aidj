"use client";

import { useEffect, useRef, useState } from "react";
import type { Track } from "@/lib/types";
import { getEngine, loadTrack, type LoadedTrack } from "@/lib/client/dj";
import { analyzeTrack } from "@/lib/audio/analysis";
import { SearchPicker } from "@/components/SearchPicker";
import { HeatmapBar } from "@/components/HeatmapBar";

/**
 * Generated-bridge mode: instead of blending A into B, an AI-composed clip
 * (Claude prompt → MusicGen) is inserted between them — starts in A's world,
 * ends in B's. Generation takes ~30-90s, so it renders while A plays.
 */
export default function BridgePage() {
  const [a, setA] = useState<LoadedTrack | null>(null);
  const [b, setB] = useState<LoadedTrack | null>(null);
  const [status, setStatus] = useState("");
  const [fallback, setFallback] = useState(""); // loud failure banner
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<"idle" | "A" | "bridge" | "B">("idle");
  const [position, setPosition] = useState(0);
  const bridgeBuf = useRef<AudioBuffer | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const id = setInterval(() => setPosition(getEngine().position()), 250);
    return () => {
      clearInterval(id);
      timers.current.forEach(clearTimeout);
      getEngine().stop();
    };
  }, []);

  async function pick(which: "A" | "B", t: Track) {
    const set = which === "A" ? setA : setB;
    set(null);
    try {
      set(await loadTrack(t.id, setStatus));
    } catch (e) {
      setStatus(`load failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function go() {
    if (!a || !b) return;
    await getEngine().resume();
    timers.current.forEach(clearTimeout);
    timers.current = [];
    bridgeBuf.current = null;
    setPrompt("");
    setFallback("");

    // start A right away; the bridge generates while it plays
    const famousA = Math.max(0, (a.meta.famousStart ?? 40) - 10);
    getEngine().startTrack(a.buffer, famousA);
    setPhase("A");
    setStatus("AI composing the bridge (30-90s) while A plays…");

    let bridge: AudioBuffer;
    try {
      const res = await fetch("/api/ai/bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          a: { title: a.meta.title, bpm: a.analysis.bpm },
          b: { title: b.meta.title, bpm: b.analysis.bpm },
          duration: 10,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error ?? `bridge failed (${res.status})`);
      }
      setPrompt(decodeURIComponent(res.headers.get("X-Bridge-Prompt") ?? ""));
      bridge = await getEngine().decode(await res.arrayBuffer());
      bridgeBuf.current = bridge;
    } catch (e) {
      // LOUD failure — the user must know no bridge was generated
      setFallback(
        `NO BRIDGE GENERATED: ${e instanceof Error ? e.message : "unknown error"}. ` +
          `Playing a plain crossfade instead.`
      );
      setStatus("");
      transitionToB(3);
      return;
    }

    setStatus("bridge ready — dropping it in…");
    const bridgeAnalysis = await analyzeTrack(bridge);
    getEngine().onTransitionEnd = null;
    // fast 1.2s entry so nearly the whole generated clip is heard in the clear
    getEngine().transition(
      bridge,
      {
        style: "filter_sweep",
        outPoint: getEngine().position(),
        inPoint: 0,
        duration: 1.2,
        beatMatch: false,
        reasoning: "into the generated bridge",
      },
      { from: a.analysis, to: bridgeAnalysis }
    );
    setPhase("bridge");
    setStatus("");

    // exit near the very end of the bridge so it plays out fully
    const exitMs = Math.max(0, (bridge.duration - 1.5) * 1000);
    timers.current.push(setTimeout(() => transitionToB(1.5), exitMs));
  }

  function transitionToB(dur: number) {
    if (!b) return;
    getEngine().onTransitionEnd = null;
    getEngine().transition(b.buffer, {
      style: "crossfade",
      outPoint: getEngine().position(),
      inPoint: Math.max(0, (b.meta.famousStart ?? 40) - dur),
      duration: dur,
      beatMatch: false,
      reasoning: "landing on B's hook",
    });
    setPhase("B");
    setStatus("");
  }

  const nowMeta = phase === "B" ? b?.meta : phase === "A" ? a?.meta : null;

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Generated Bridge</h1>
        <p className="text-sm text-zinc-400">
          Claude writes the brief, MusicGen composes a ~10s bridge that starts
          in song A&apos;s world and ends in song B&apos;s. It generates while A plays.
          Needs <code>REPLICATE_API_TOKEN</code>.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="mb-1 text-xs uppercase text-zinc-500">Song A</p>
          <SearchPicker onPick={(t) => pick("A", t)} />
          {a && (
            <p className="mt-1 truncate text-sm">
              {a.meta.title} <span className="text-zinc-500">· {a.analysis.bpm} BPM</span>
            </p>
          )}
        </div>
        <div>
          <p className="mb-1 text-xs uppercase text-zinc-500">Song B</p>
          <SearchPicker onPick={(t) => pick("B", t)} />
          {b && (
            <p className="mt-1 truncate text-sm">
              {b.meta.title} <span className="text-zinc-500">· {b.analysis.bpm} BPM</span>
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <button
          onClick={go}
          disabled={!a || !b || phase === "A" || phase === "bridge"}
          className="rounded-lg bg-fuchsia-600 px-5 py-2 font-semibold hover:bg-fuchsia-500 disabled:opacity-40"
        >
          🌉 Play A → bridge → B
        </button>
        <button
          onClick={() => {
            timers.current.forEach(clearTimeout);
            getEngine().stop();
            setPhase("idle");
          }}
          className="rounded-lg border border-zinc-700 px-4 py-2 text-sm"
        >
          Stop
        </button>
        {phase !== "idle" && (
          <span className="self-center text-sm text-zinc-400">
            phase: <b className="text-fuchsia-300">{phase}</b>
          </span>
        )}
      </div>

      {status && <p className="animate-pulse text-sm text-amber-400">{status}</p>}
      {fallback && (
        <div className="rounded-xl border-2 border-red-600 bg-red-950/40 p-4 text-sm font-semibold text-red-300">
          ⚠ {fallback}
          {fallback.includes("credit") && (
            <p className="mt-1 font-normal text-red-200">
              Add credit at replicate.com → Account → Billing, then try again.
            </p>
          )}
        </div>
      )}
      {phase === "bridge" && (
        <div className="animate-pulse rounded-xl border-2 border-fuchsia-500 bg-fuchsia-950/40 p-4 text-center text-lg font-bold text-fuchsia-200">
          🌉 GENERATED BRIDGE PLAYING
        </div>
      )}

      {prompt && (
        <div className="rounded-xl border border-fuchsia-900/50 bg-fuchsia-950/20 p-4 text-sm">
          <p className="text-xs uppercase text-zinc-500">bridge brief</p>
          <p className="text-zinc-300">{prompt}</p>
        </div>
      )}

      {nowMeta && (
        <div className="rounded-xl border border-zinc-800 p-4 space-y-2">
          <p className="truncate font-semibold">{nowMeta.title}</p>
          <HeatmapBar meta={nowMeta} position={position} />
        </div>
      )}
    </main>
  );
}
