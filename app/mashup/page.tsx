"use client";

import { useEffect, useRef, useState } from "react";
import type { Track } from "@/lib/types";
import { getEngine, loadTrack, searchTracks, type LoadedTrack } from "@/lib/client/dj";
import { SearchPicker } from "@/components/SearchPicker";

interface Design {
  title: string;
  structure: "layer" | "alternate";
  songs: string[];
  reasoning: string;
}

const MODES = [
  { key: "prompt", label: "✍️ Prompt", placeholder: "e.g. 'sad bollywood vocals over french house'", template: (v: string) => v },
  { key: "singer", label: "🎤 Singer", placeholder: "e.g. 'Taylor Swift'", template: (v: string) => `An endless mashup of ${v} songs — all songs by ${v}.` },
  { key: "year", label: "📅 Year", placeholder: "e.g. '2014'", template: (v: string) => `A nostalgia mashup of famous songs from around ${v}.` },
  { key: "theme", label: "🎭 Theme", placeholder: "e.g. 'rain', 'heartbreak', 'driving at night'", template: (v: string) => `A mashup of songs about: ${v}.` },
] as const;

const ROTATE_SEC = 22;

export default function MashupPage() {
  const [mode, setMode] = useState<(typeof MODES)[number]["key"]>("prompt");
  const [input, setInput] = useState("");
  const [design, setDesign] = useState<Design | null>(null);
  const [a, setA] = useState<LoadedTrack | null>(null); // bed
  const [b, setB] = useState<LoadedTrack | null>(null); // topper
  const [status, setStatus] = useState("");
  const [playing, setPlaying] = useState(false);
  const [infinite, setInfinite] = useState(true);
  const [topperGain, setTopperGain] = useState(0.9);
  const [layers, setLayers] = useState<{ bed: string; topper: string }>({
    bed: "",
    topper: "",
  });

  // rotation machinery (refs so timers see fresh values)
  const rot = useRef({
    prompt: "",
    pool: [] as string[], // queries not yet loaded
    preloaded: [] as LoadedTrack[], // ready to swap in
    used: [] as string[],
    anchorBpm: 120,
    turn: 0,
    timer: null as ReturnType<typeof setTimeout> | null,
    refilling: false,
    active: false,
  });
  const altTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      stopAll();
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  function stopAll() {
    if (rot.current.timer) clearTimeout(rot.current.timer);
    if (altTimer.current) clearTimeout(altTimer.current);
    rot.current.active = false;
    getEngine().stop();
    setPlaying(false);
  }

  async function aiDesign() {
    const m = MODES.find((x) => x.key === mode)!;
    if (!input.trim()) return;
    setStatus("AI designing the mashup…");
    setDesign(null);
    setA(null);
    setB(null);
    try {
      const prompt = m.template(input);
      rot.current.prompt = prompt;
      const res = await fetch("/api/ai/mashup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      if (!res.ok) throw new Error("design failed — ANTHROPIC_API_KEY?");
      const d: Design = await res.json();
      if (!d.songs || d.songs.length < 2) throw new Error("AI returned too few songs");
      setDesign(d);
      rot.current.pool = d.songs.slice(2);
      rot.current.used = d.songs.slice(0, 2);
      rot.current.preloaded = [];

      setStatus(`loading "${d.songs[0]}" + "${d.songs[1]}"…`);
      const [bed, top] = await Promise.all([
        findAndLoad(d.songs[0]),
        findAndLoad(d.songs[1]),
      ]);
      if (!bed || !top) throw new Error("couldn't load the first two songs");
      setA(bed);
      setB(top);
      setStatus("");
      prefetchPool(); // start warming rotation songs immediately
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "failed");
    }
  }

  async function findAndLoad(query: string): Promise<LoadedTrack | null> {
    try {
      const hits = await searchTracks(query);
      if (!hits[0]) return null;
      return await loadTrack(hits[0].id);
    } catch {
      return null;
    }
  }

  async function pickManual(which: "A" | "B", t: Track) {
    const set = which === "A" ? setA : setB;
    set(null);
    setDesign(null); // manual pair = no rotation pool
    try {
      set(await loadTrack(t.id, setStatus));
      setStatus("");
    } catch (e) {
      setStatus(`load failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Keep ≥2 rotation songs loaded; refill the pool from the AI when low. */
  async function prefetchPool() {
    const r = rot.current;
    while (r.preloaded.length < 2 && r.pool.length > 0) {
      const q = r.pool.shift()!;
      const loaded = await findAndLoad(q);
      if (loaded) {
        r.preloaded.push(loaded);
        r.used.push(q);
      }
    }
    if (r.pool.length + r.preloaded.length < 2 && !r.refilling && r.prompt) {
      r.refilling = true;
      try {
        const res = await fetch("/api/ai/mashup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: r.prompt, exclude: r.used }),
        });
        if (res.ok) {
          const d: Design = await res.json();
          r.pool.push(...(d.songs ?? []));
        }
      } catch {
        /* best effort */
      } finally {
        r.refilling = false;
      }
    }
  }

  const rate = a && b ? a.analysis.bpm / b.analysis.bpm : 1;
  const rateOk = rate > 0.85 && rate < 1.18;

  async function play() {
    if (!a || !b) return;
    await getEngine().resume();
    stopAll();
    await getEngine().resume();

    const structure = design?.structure ?? "layer";
    rot.current.anchorBpm = a.analysis.bpm;
    setLayers({ bed: a.meta.title, topper: b.meta.title });

    if (structure === "alternate" && !infinite) {
      runAlternate();
    } else {
      getEngine().playMashup(a.buffer, b.buffer, {
        bedOffset: Math.max(0, (a.meta.famousStart ?? 40) - 8),
        topperOffset: Math.max(0, (b.meta.famousStart ?? 40) - 8),
        rate: rateOk ? rate : 1,
        topperGain,
        carve: true,
      });
      if (infinite && design) scheduleRotation();
    }
    setPlaying(true);
  }

  /** Every ROTATE_SEC, swap the topper (then bed, alternating) to a new song. */
  function scheduleRotation() {
    const r = rot.current;
    r.active = true;
    const tick = () => {
      r.timer = setTimeout(async () => {
        if (!r.active) return;
        const next = r.preloaded.shift();
        prefetchPool();
        if (next) {
          const which = r.turn % 2 === 0 ? "topper" : "bed";
          r.turn++;
          let swapRate = r.anchorBpm / Math.max(next.analysis.bpm, 1);
          if (swapRate < 0.85 || swapRate > 1.18) swapRate = 1;
          getEngine().swapMashupLayer(which, next.buffer, {
            offset: Math.max(0, (next.meta.famousStart ?? 40) - 6),
            rate: swapRate,
          });
          setLayers((l) => ({ ...l, [which]: next.meta.title }));
        }
        tick();
      }, ROTATE_SEC * 1000);
    };
    tick();
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
      const barsSec = (60 / Math.max(cur.analysis.bpm, 1)) * 4 * 8;
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
          Say a prompt, singer, year, or theme — the AI builds an{" "}
          <b>endless rotating mashup</b>: while one layer grooves, the other
          keeps swapping to a new song. &quot;Taylor Swift&quot; = Taylor all night.
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
          <p className="font-semibold text-fuchsia-300">“{design.title}”</p>
          <p className="mt-1 text-xs text-zinc-400">{design.reasoning}</p>
          <p className="mt-1 text-xs text-zinc-500">
            pool: {design.songs.length} songs · {design.structure}
            {infinite ? " · endless" : ""}
          </p>
        </div>
      )}

      <details className="rounded-xl border border-zinc-800 p-4">
        <summary className="cursor-pointer text-sm text-zinc-400">
          manual song pick (single pair, no rotation)
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

      {a && b && !playing && (
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

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={infinite}
            onChange={(e) => setInfinite(e.target.checked)}
            disabled={!design}
          />
          Endless rotation
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
              onClick={stopAll}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm"
            >
              Stop
            </button>
          </>
        )}
      </div>

      {playing && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-zinc-800 p-3 text-sm">
            <p className="text-xs uppercase text-zinc-500">bed (groove)</p>
            <p className="truncate font-semibold">{layers.bed}</p>
          </div>
          <div className="rounded-xl border border-fuchsia-900 p-3 text-sm">
            <p className="text-xs uppercase text-zinc-500">topper (hook)</p>
            <p className="truncate font-semibold text-fuchsia-300">{layers.topper}</p>
          </div>
        </div>
      )}
    </main>
  );
}
