"use client";

import { useMemo, useState } from "react";
import type { Track } from "@/lib/types";
import { searchTracks } from "@/lib/client/dj";
import { useAutoMix } from "@/lib/client/useAutoMix";
import { getSelectedLanguageLabels } from "@/lib/client/langPrefs";
import { getSongSource } from "@/lib/client/sourcePrefs";
import { listenerHistory } from "@/lib/client/history";
import { ARC_SHAPES, arcEnergyAt, type ArcShape } from "@/lib/audio/arc";
import { HeatmapBar } from "@/components/HeatmapBar";
import { Cover } from "@/components/Cover";
import { TransitionRating } from "@/components/TransitionRating";

const DURATIONS = [10, 20, 30, 45];

/** Sample the arc into an SVG path so the user sees the journey before it plays. */
function ArcCurve({
  shape,
  progress,
  energy,
}: {
  shape: ArcShape;
  progress: number;
  energy: number;
}) {
  const W = 600;
  const H = 140;
  const path = useMemo(() => {
    const pts = Array.from({ length: 81 }, (_, i) => {
      const p = i / 80;
      const e = arcEnergyAt(shape, p);
      return `${(p * W).toFixed(1)},${(H - e * H).toFixed(1)}`;
    });
    return `M${pts.join(" L")}`;
  }, [shape]);
  const px = progress * W;
  const py = H - energy * H;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id="arcfill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgb(217 70 239 / 0.35)" />
          <stop offset="100%" stopColor="rgb(217 70 239 / 0)" />
        </linearGradient>
      </defs>
      {/* phase bands */}
      {[0.38, 0.62, 0.82].map((y) => (
        <line
          key={y}
          x1={0}
          x2={W}
          y1={H - y * H}
          y2={H - y * H}
          stroke="rgb(63 63 70 / 0.5)"
          strokeDasharray="4 4"
        />
      ))}
      <path d={`${path} L${W},${H} L0,${H} Z`} fill="url(#arcfill)" />
      <path d={path} fill="none" stroke="rgb(217 70 239)" strokeWidth={2} />
      {/* playhead */}
      <line x1={px} x2={px} y1={0} y2={H} stroke="rgb(244 244 245 / 0.4)" />
      <circle cx={px} cy={py} r={5} fill="rgb(244 244 245)" />
    </svg>
  );
}

export default function ArcPage() {
  const mix = useAutoMix();
  const [shape, setShape] = useState<ArcShape>("peak_release");
  const [durationMin, setDurationMin] = useState(20);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState("");

  const arc = mix.arcInfo;
  const energy = arc?.energy ?? arcEnergyAt(shape, 0);
  const progress = arc?.progress ?? 0;

  async function startJourney() {
    const text = prompt.trim() || "an all-night DJ set, crowd-pleasers";
    setBusy("AI is planning the journey…");
    try {
      const res = await fetch("/api/ai/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: `${text} (energy arc: ${shape})`,
          languages: getSelectedLanguageLabels(),
          songSource: getSongSource(),
          ...listenerHistory(),
        }),
      });
      if (!res.ok) throw new Error("intent failed - is ANTHROPIC_API_KEY set?");
      const plan: { queries: string[]; vibes?: string[] } = await res.json();
      setBusy("finding the opening songs…");
      const found = await Promise.all(
        plan.queries.map((q) =>
          searchTracks(q)
            .then((r) => r[0] ?? null)
            .catch(() => null)
        )
      );
      const tracks = found.filter((t): t is Track => !!t);
      if (tracks.length < 2) throw new Error("couldn't find enough songs");
      mix.setQueue(tracks);
      setBusy("");
      await mix.start({
        clipLen: "ai",
        useAi: true,
        quantize: true,
        endless: true,
        keyLock: true,
        arc: { shape, durationMin },
        vibes: plan.vibes,
      });
      mix.prefetch();
    } catch (e) {
      setBusy(e instanceof Error ? e.message : "failed");
    }
  }

  const phaseColor: Record<string, string> = {
    chill: "text-sky-300",
    groovy: "text-emerald-300",
    hype: "text-amber-300",
    peak: "text-cyan-300",
  };

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <TransitionRating hop={mix.lastHop} onRate={mix.rateHop} />
      <header>
        <h1 className="text-2xl font-bold">Energy-Arc Director</h1>
        <p className="text-sm text-zinc-400">
          Set a journey - chill → peak → cool-down - over a chosen length. The AI
          paces BPM, energy, transition intensity, and song picks across the
          whole set, not just the next hop.
        </p>
      </header>

      {!mix.running && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {ARC_SHAPES.map((s) => (
              <button
                key={s.id}
                onClick={() => setShape(s.id)}
                className={`rounded-lg border p-3 text-left text-sm ${
                  shape === s.id
                    ? "border-cyan-600 bg-cyan-950/30"
                    : "border-zinc-800 hover:border-zinc-700"
                }`}
              >
                <div className="font-semibold">{s.label}</div>
                <div className="text-xs text-zinc-500">{s.blurb}</div>
              </button>
            ))}
          </div>

          <div className="rounded-xl border border-zinc-800 p-3">
            <ArcCurve shape={shape} progress={0} energy={arcEnergyAt(shape, 0)} />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-zinc-400">Length:</span>
            {DURATIONS.map((d) => (
              <button
                key={d}
                onClick={() => setDurationMin(d)}
                className={`rounded-lg px-4 py-2 text-sm ${
                  durationMin === d
                    ? "bg-cyan-600"
                    : "border border-zinc-700 text-zinc-300"
                }`}
              >
                {d} min
              </button>
            ))}
          </div>

          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && startJourney()}
            placeholder='Seed vibe - e.g. "house party", "bollywood night", "gym session"'
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 outline-none focus:border-cyan-500"
          />
          <button
            onClick={startJourney}
            className="rounded-lg bg-cyan-600 px-5 py-2 font-semibold hover:bg-cyan-500"
          >
            ▶ Start the journey
          </button>
        </>
      )}

      {busy && <p className="animate-pulse text-sm text-amber-400">{busy}</p>}
      {mix.status && (
        <p className="animate-pulse text-xs text-amber-400">{mix.status}</p>
      )}

      {mix.running && (
        <div className="space-y-3 rounded-xl border border-zinc-800 p-4">
          <ArcCurve shape={shape} progress={progress} energy={energy} />
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              phase:{" "}
              <span className={`font-bold ${phaseColor[arc?.phase ?? "groovy"]}`}>
                {arc?.phase ?? ","}
              </span>
            </span>
            <span className="text-zinc-400">
              energy {(energy * 100).toFixed(0)}% · target {arc?.bpm[0]}–
              {arc?.bpm[1]} BPM
            </span>
            <span className="text-zinc-500">
              {Math.round(progress * 100)}% through {durationMin}min
            </span>
          </div>
          {mix.now && (
            <>
              <div className="flex items-center gap-3">
                <Cover src={mix.now.meta.thumbnail} className="h-14 w-14 rounded-lg" />
                <p className="font-semibold">{mix.now.meta.title}</p>
              </div>
              <HeatmapBar meta={mix.now.meta} position={mix.position} />
              <p className="text-xs text-zinc-500">
                {mix.now.analysis.bpm} BPM
                {mix.now.analysis.camelot && (
                  <span className="ml-1 text-violet-400">
                    · {mix.now.analysis.camelot}
                  </span>
                )}
              </p>
            </>
          )}
          {mix.lastPlan && (
            <p className="text-xs text-cyan-300">
              last hop: {mix.lastPlan.style} - {mix.lastPlan.reasoning}
            </p>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => mix.hopNow()}
              className="rounded border border-zinc-700 px-3 py-1 text-xs"
            >
              skip →
            </button>
            <button
              onClick={() => mix.stop()}
              className="rounded border border-zinc-700 px-3 py-1 text-xs"
            >
              stop
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
