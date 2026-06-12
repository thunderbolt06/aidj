"use client";

import { useEffect, useRef, useState } from "react";
import type { Track } from "@/lib/types";
import { getEngine, loadTrack, searchTracks, type LoadedTrack } from "@/lib/client/dj";
import { SearchPicker } from "@/components/SearchPicker";

interface Design {
  title: string;
  bed: string;
  topper: string;
  structure: "layer" | "alternate";
  reasoning: string;
}

const MODES = [
  { key: "prompt", label: "✍️ Prompt", placeholder: "e.g. 'sad bollywood vocals over french house'", template: (v: string) => v },
  { key: "singer", label: "🎤 Singer", placeholder: "e.g. 'Arijit Singh'", template: (v: string) => `A mashup featuring ${v} — one of their songs against a song from a different genre/artist that pairs unexpectedly well.` },
  { key: "year", label: "📅 Year", placeholder: "e.g. '2014'", template: (v: string) => `A nostalgia mashup of two famous songs from around ${v}.` },
  { key: "theme", label: "🎭 Theme", placeholder: "e.g. 'rain', 'heartbreak', 'driving at night'", template: (v: string) => `A mashup of two songs about: ${v}.` },
] as const;

export default function MashupPage() {
  const [mode, setMode] = useState<(typeof MODES)[number]["key"]>("prompt");
  const [input, setInput] = useState("");
  const [design, setDesign] = useState<Design | null>(null);
  const [a, setA] = useState<LoadedTrack | null>(null); // bed
  const [b, setB] = useState<LoadedTrack | null>(null); // topper
  const [status, setStatus] = useState("");
  const [playing, setPlaying] = useState(false);
  const [useStems, setUseStems] = useState(false);
  const [stemsState, setStemsState] = useState("");
  const [topperGain, setTopperGain] = useState(0.9);
  const stems = useRef<{ bed: AudioBuffer | null; topper: AudioBuffer | null }>({
    bed: null,
    topper: null,
  });
  const altTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (altTimer.current) clearTimeout(altTimer.current);
      getEngine().stop();
    },
    []
  );

  async function aiDesign() {
    const m = MODES.find((x) => x.key === mode)!;
    if (!input.trim()) return;
    setStatus("AI designing the mashup…");
    setDesign(null);
    setA(null);
    setB(null);
    stems.current = { bed: null, topper: null };
    try {
      const res = await fetch("/api/ai/mashup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: m.template(input) }),
      });
      if (!res.ok) throw new Error("design failed — ANTHROPIC_API_KEY?");
      const d: Design = await res.json();
      setDesign(d);
      setStatus("finding + loading both songs…");
      const [bedHits, topHits] = await Promise.all([
        searchTracks(d.bed).catch(() => []),
        searchTracks(d.topper).catch(() => []),
      ]);
      if (!bedHits[0] || !topHits[0]) throw new Error("couldn't find the songs");
      const [bed, top] = await Promise.all([
        loadTrack(bedHits[0].id, setStatus),
        loadTrack(topHits[0].id, setStatus),
      ]);
      setA(bed);
      setB(top);
      setStatus("");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "failed");
    }
  }

  async function pickManual(which: "A" | "B", t: Track) {
    const set = which === "A" ? setA : setB;
    set(null);
    stems.current = { bed: null, topper: null };
    try {
      set(await loadTrack(t.id, setStatus));
      setStatus("");
    } catch (e) {
      setStatus(`load failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Fetch demucs stems for both songs (topper vocals + bed instrumental). */
  async function loadStems(): Promise<boolean> {
    if (!a || !b) return false;
    if (stems.current.bed && stems.current.topper) return true;
    setStemsState("separating stems (1-4 min first time, needs Replicate credit)…");
    try {
      const [bedRes, topRes] = await Promise.all([
        fetch(`/api/stems/${a.meta.id}?stem=instrumental`),
        fetch(`/api/stems/${b.meta.id}?stem=vocals`),
      ]);
      if (!bedRes.ok || !topRes.ok) {
        const err = !bedRes.ok
          ? await bedRes.json().catch(() => null)
          : await topRes.json().catch(() => null);
        throw new Error(err?.error ?? "stem separation failed");
      }
      const eng = getEngine();
      [stems.current.bed, stems.current.topper] = await Promise.all([
        eng.decode(await bedRes.arrayBuffer()),
        eng.decode(await topRes.arrayBuffer()),
      ]);
      setStemsState("stems ready ✓");
      return true;
    } catch (e) {
      setStemsState(`⚠ ${e instanceof Error ? e.message : "stems failed"} — using EQ mode`);
      return false;
    }
  }

  const rate = a && b ? a.analysis.bpm / b.analysis.bpm : 1;
  const rateOk = rate > 0.85 && rate < 1.18;

  async function play() {
    if (!a || !b) return;
    await getEngine().resume();
    if (altTimer.current) clearTimeout(altTimer.current);

    const structure = design?.structure ?? "layer";
    let bedBuf = a.buffer;
    let topBuf = b.buffer;
    let carve = true;
    if (useStems && (await loadStems())) {
      bedBuf = stems.current.bed!;
      topBuf = stems.current.topper!;
      carve = false;
    }

    if (structure === "alternate") {
      runAlternate();
    } else {
      getEngine().playMashup(bedBuf, topBuf, {
        bedOffset: Math.max(0, (a.meta.famousStart ?? 40) - 8),
        topperOffset: Math.max(0, (b.meta.famousStart ?? 40) - 8),
        rate: rateOk ? rate : 1,
        topperGain,
        carve,
      });
    }
    setPlaying(true);
  }

  /** Hook ping-pong: 8 bars of A's hook, bass-swap into B's hook, repeat. */
  function runAlternate() {
    if (!a || !b) return;
    const eng = getEngine();
    const stops = [a, b];
    let turn = 0;
    const famous = (t: LoadedTrack) => Math.max(0, (t.meta.famousStart ?? 40) - 2);
    eng.startTrack(stops[0].buffer, famous(stops[0]));

    const hop = () => {
      const cur = stops[turn % 2];
      const nxt = stops[(turn + 1) % 2];
      const barsSec = (60 / Math.max(cur.analysis.bpm, 1)) * 4 * 8; // 8 bars
      altTimer.current = setTimeout(() => {
        eng.transition(
          nxt.buffer,
          {
            style: "bass_swap",
            outPoint: eng.position(),
            inPoint: famous(nxt),
            duration: 2,
            beatMatch: true,
            reasoning: "hook swap",
          },
          { from: cur.analysis, to: nxt.analysis }
        );
        turn++;
        hop();
      }, barsSec * 1000);
    };
    hop();
  }

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Mashup Generator</h1>
        <p className="text-sm text-zinc-400">
          Let the AI design it — by prompt, singer, year, or theme — or pick
          songs manually. Stems mode does real vocal/instrumental separation.
        </p>
      </header>

      <div className="flex flex-wrap gap-2">
        {MODES.map((m) => (
          <button
            key={m.key}
            onClick={() => setMode(m.key)}
            className={`rounded-lg px-3 py-1.5 text-sm ${
              mode === m.key ? "bg-fuchsia-600" : "border border-zinc-700 text-zinc-300"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && aiDesign()}
          placeholder={MODES.find((m) => m.key === mode)!.placeholder}
          className="flex-1 rounded-lg bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm outline-none focus:border-fuchsia-500"
        />
        <button
          onClick={aiDesign}
          className="rounded-lg bg-fuchsia-600 px-4 py-2 text-sm font-medium hover:bg-fuchsia-500"
        >
          Design
        </button>
      </div>

      {design && (
        <div className="rounded-xl border border-fuchsia-900/50 bg-fuchsia-950/20 p-4 text-sm">
          <p className="font-semibold text-fuchsia-300">
            “{design.title}” · {design.structure}
          </p>
          <p className="text-zinc-300">
            bed: {design.bed} · topper: {design.topper}
          </p>
          <p className="mt-1 text-xs text-zinc-400">{design.reasoning}</p>
        </div>
      )}

      <details className="rounded-xl border border-zinc-800 p-4">
        <summary className="cursor-pointer text-sm text-zinc-400">
          manual song pick
        </summary>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-xs uppercase text-zinc-500">Bed</p>
            <SearchPicker onPick={(t) => pickManual("A", t)} />
          </div>
          <div>
            <p className="mb-1 text-xs uppercase text-zinc-500">Topper</p>
            <SearchPicker onPick={(t) => pickManual("B", t)} />
          </div>
        </div>
      </details>

      {a && b && (
        <p className="text-sm">
          <span className="text-zinc-300">{a.meta.title}</span>
          <span className="text-zinc-500"> ({a.analysis.bpm} BPM)</span> +{" "}
          <span className="text-zinc-300">{b.meta.title}</span>
          <span className="text-zinc-500"> ({b.analysis.bpm} BPM)</span> · ×
          {rate.toFixed(3)}{" "}
          {rateOk ? (
            <span className="text-emerald-400">tempo-matchable</span>
          ) : (
            <span className="text-amber-400">far apart — playing natural</span>
          )}
        </p>
      )}

      {status && <p className="animate-pulse text-sm text-amber-400">{status}</p>}
      {stemsState && <p className="text-sm text-zinc-400">{stemsState}</p>}

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={useStems}
            onChange={(e) => setUseStems(e.target.checked)}
          />
          Real stems (Replicate demucs)
        </label>
        <button
          onClick={play}
          disabled={!a || !b}
          className="rounded-lg bg-fuchsia-600 px-5 py-2 font-semibold hover:bg-fuchsia-500 disabled:opacity-40"
        >
          🌀 Mash
        </button>
        {playing && (
          <>
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              topper
              <input
                type="range"
                min={0}
                max={1.2}
                step={0.05}
                value={topperGain}
                onChange={(e) => {
                  const v = +e.target.value;
                  setTopperGain(v);
                  getEngine().setTopperGain(v);
                }}
              />
            </label>
            <button
              onClick={() => {
                if (altTimer.current) clearTimeout(altTimer.current);
                getEngine().stop();
                setPlaying(false);
              }}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm"
            >
              Stop
            </button>
          </>
        )}
      </div>
    </main>
  );
}
