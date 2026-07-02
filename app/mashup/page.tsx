"use client";

import { useEffect, useRef, useState } from "react";
import { getEngine, loadTrack, searchTracks, type LoadedTrack } from "@/lib/client/dj";
import { SearchPicker } from "@/components/SearchPicker";

interface Design {
  title: string;
  songs: string[];
  reasoning: string;
}

const MODES = [
  { key: "prompt", label: "✍️ Prompt", placeholder: "e.g. 'sad bollywood vocals over french house'", template: (v: string) => v },
  { key: "singer", label: "🎤 Singer", placeholder: "e.g. 'Taylor Swift'", template: (v: string) => `An endless mashup of ${v} songs - all songs by ${v}.` },
  { key: "year", label: "📅 Year", placeholder: "e.g. '2014'", template: (v: string) => `A nostalgia mashup of famous songs from around ${v}.` },
  { key: "theme", label: "🎭 Theme", placeholder: "e.g. 'rain', 'heartbreak', 'driving at night'", template: (v: string) => `A mashup of songs about: ${v}.` },
] as const;

const ROTATE_BARS = 8;

/**
 * Mashup v3 (user feedback: two vocal tracks layered = mud).
 * Only ONE vocal plays at any moment:
 *  - Hook Rotation (default): every song's hook, beat-matched to ONE anchor
 *    tempo, bass-swapped every 8 bars. Feels like one continuous track.
 *  - Stems Layer: real demucs separation - one song's instrumental as the bed,
 *    the OTHER song's isolated vocal on top, vocals rotating song to song.
 */
export default function MashupPage() {
  const [mode, setMode] = useState<(typeof MODES)[number]["key"]>("prompt");
  const [mashMode, setMashMode] = useState<"rotation" | "stems">("rotation");
  const [input, setInput] = useState("");
  const [design, setDesign] = useState<Design | null>(null);
  const [status, setStatus] = useState("");
  const [stemError, setStemError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [nowTitle, setNowTitle] = useState("");
  const [bedTitle, setBedTitle] = useState("");

  const rt = useRef({
    prompt: "",
    pool: [] as string[],
    preloaded: [] as LoadedTrack[],
    used: [] as string[],
    current: null as LoadedTrack | null,
    anchorBpm: 120,
    timer: null as ReturnType<typeof setTimeout> | null,
    refilling: false,
    active: false,
    // stems mode
    bed: null as LoadedTrack | null,
    vocalBuffers: new Map<string, AudioBuffer>(),
  });

  useEffect(
    () => () => stopAll(),
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  function stopAll() {
    const r = rt.current;
    if (r.timer) clearTimeout(r.timer);
    r.active = false;
    getEngine().stop();
    setPlaying(false);
  }

  async function findAndLoad(query: string): Promise<LoadedTrack | null> {
    try {
      const hits = await searchTracks(query);
      return hits[0] ? await loadTrack(hits[0].id) : null;
    } catch {
      return null;
    }
  }

  async function aiDesign() {
    const m = MODES.find((x) => x.key === mode)!;
    if (!input.trim()) return;
    setStatus("AI picking the songs…");
    setDesign(null);
    setStemError("");
    try {
      const prompt = m.template(input);
      const r = rt.current;
      r.prompt = prompt;
      const res = await fetch("/api/ai/mashup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      if (!res.ok) throw new Error("design failed - ANTHROPIC_API_KEY?");
      const d = (await res.json()) as Design & { structure?: string };
      if (!d.songs || d.songs.length < 2) throw new Error("AI returned too few songs");
      setDesign(d);
      r.pool = [...d.songs];
      r.used = [...d.songs];
      r.preloaded = [];
      setStatus("loading the first songs…");
      await topUpPreloaded(2);
      setStatus("");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "failed");
    }
  }

  /** Keep N rotation songs fully loaded; ask the AI for more when low. */
  async function topUpPreloaded(n = 2) {
    const r = rt.current;
    while (r.preloaded.length < n && r.pool.length > 0) {
      const q = r.pool.shift()!;
      const loaded = await findAndLoad(q);
      if (loaded) r.preloaded.push(loaded);
    }
    if (r.pool.length + r.preloaded.length < 3 && !r.refilling && r.prompt) {
      r.refilling = true;
      fetch("/api/ai/mashup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: r.prompt, exclude: r.used }),
      })
        .then(async (res) => {
          if (!res.ok) return;
          const d = (await res.json()) as Design;
          const fresh = (d.songs ?? []).filter((s) => !r.used.includes(s));
          r.pool.push(...fresh);
          r.used.push(...fresh);
        })
        .catch(() => {})
        .finally(() => {
          r.refilling = false;
        });
    }
  }

  async function play() {
    const r = rt.current;
    if (!r.preloaded.length) return;
    await getEngine().resume();
    stopAll();
    await getEngine().resume();
    r.active = true;

    if (mashMode === "stems") {
      const ok = await playStems();
      if (!ok) return;
    } else {
      const first = r.preloaded.shift()!;
      r.current = first;
      r.anchorBpm = first.analysis.bpm;
      setNowTitle(first.meta.title);
      getEngine().startTrack(
        first.buffer,
        Math.max(0, (first.meta.famousStart ?? 40) - 2)
      );
      scheduleHookRotation();
      topUpPreloaded();
    }
    setPlaying(true);
  }

  /** One vocal at a time: 8 anchor-tempo bars per hook, bass-swap to the next. */
  function scheduleHookRotation() {
    const r = rt.current;
    const barSec = (60 / r.anchorBpm) * 4;
    const tick = () => {
      r.timer = setTimeout(async () => {
        if (!r.active) return;
        const next = r.preloaded.shift();
        topUpPreloaded();
        if (next && r.current) {
          getEngine().transition(
            next.buffer,
            {
              style: "bass_swap",
              outPoint: getEngine().position(),
              inPoint: Math.max(0, (next.meta.famousStart ?? 40) - 2),
              duration: 1.5,
              beatMatch: true,
              reasoning: "hook rotation",
            },
            // anchor: pretend the outgoing track runs at the anchor BPM so the
            // incoming hook stretches onto the same grid and STAYS there
            { from: { ...r.current.analysis, bpm: r.anchorBpm }, to: next.analysis },
            { holdRate: true }
          );
          r.current = next;
          setNowTitle(next.meta.title);
        }
        tick();
      }, barSec * ROTATE_BARS * 1000);
    };
    tick();
  }

  /** Stems: bed = instrumental of song 1; isolated vocals rotate on top. */
  async function playStems(): Promise<boolean> {
    const r = rt.current;
    try {
      const bed = r.preloaded[0];
      const firstVox = r.preloaded[1] ?? r.preloaded[0];
      setStatus("separating stems (1-4 min per song first time)…");
      const [instr, vox] = await Promise.all([
        fetchStem(bed, "instrumental"),
        fetchStem(firstVox, "vocals"),
      ]);
      r.bed = bed;
      r.preloaded = r.preloaded.slice(2);
      r.anchorBpm = bed.analysis.bpm;
      setBedTitle(bed.meta.title);
      setNowTitle(firstVox.meta.title);
      setStatus("");
      let rate = bed.analysis.bpm / Math.max(firstVox.analysis.bpm, 1);
      if (rate < 0.85 || rate > 1.18) rate = 1;
      getEngine().playMashup(instr, vox, {
        bedOffset: Math.max(0, (bed.meta.famousStart ?? 40) - 16),
        topperOffset: Math.max(0, (firstVox.meta.famousStart ?? 40) - 2),
        rate,
        topperGain: 1.1,
        carve: false, // real stems - no EQ fakery needed
      });
      scheduleVocalRotation();
      topUpPreloaded();
      return true;
    } catch (e) {
      setStemError(
        `STEMS FAILED: ${e instanceof Error ? e.message : "unknown"}. ` +
          `Likely missing Replicate credit - falling back to Hook Rotation.`
      );
      setMashMode("rotation");
      setStatus("");
      return rt.current.preloaded.length ? (await play(), false) : false;
    }
  }

  async function fetchStem(
    t: LoadedTrack,
    stem: "vocals" | "instrumental"
  ): Promise<AudioBuffer> {
    const r = rt.current;
    const key = `${t.meta.id}-${stem}`;
    const hit = r.vocalBuffers.get(key);
    if (hit) return hit;
    const res = await fetch(`/api/stems/${t.meta.id}?stem=${stem}`);
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error ?? `stem ${stem} failed`);
    }
    const buf = await getEngine().decode(await res.arrayBuffer());
    r.vocalBuffers.set(key, buf);
    return buf;
  }

  /** Swap the vocal stem to the next song every 8 bars of the bed. */
  function scheduleVocalRotation() {
    const r = rt.current;
    const barSec = (60 / r.anchorBpm) * 4;
    const tick = () => {
      r.timer = setTimeout(async () => {
        if (!r.active) return;
        const next = r.preloaded.shift();
        topUpPreloaded();
        if (next) {
          try {
            setStatus(`separating vocals of "${next.meta.title}"…`);
            const vox = await fetchStem(next, "vocals");
            setStatus("");
            if (!r.active) return;
            let rate = r.anchorBpm / Math.max(next.analysis.bpm, 1);
            if (rate < 0.85 || rate > 1.18) rate = 1;
            getEngine().swapMashupLayer("topper", vox, {
              offset: Math.max(0, (next.meta.famousStart ?? 40) - 2),
              rate,
            });
            setNowTitle(next.meta.title);
          } catch {
            setStatus("vocal stem failed - keeping current vocal");
          }
        }
        tick();
      }, barSec * ROTATE_BARS * 1000);
    };
    tick();
  }

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Mashup Generator</h1>
        <p className="text-sm text-zinc-400">
          One vocal at a time, always. <b>Hook Rotation</b> beat-locks every
          song&apos;s hook to a single tempo and swaps every {ROTATE_BARS} bars.{" "}
          <b>Stems Layer</b> puts isolated vocals over another song&apos;s real
          instrumental (needs Replicate credit).
        </p>
      </header>

      <div className="flex flex-wrap gap-2">
        {MODES.map((m) => (
          <button
            key={m.key}
            onClick={() => setMode(m.key)}
            className={`rounded-lg px-3 py-1.5 text-sm ${
              mode === m.key ? "bg-cyan-600" : "border border-zinc-700 text-zinc-300"
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
          className="flex-1 rounded-lg bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm outline-none focus:border-cyan-500"
        />
        <button
          onClick={aiDesign}
          className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium hover:bg-cyan-500"
        >
          Design
        </button>
      </div>

      {design && (
        <div className="rounded-xl border border-cyan-900/50 bg-cyan-950/20 p-4 text-sm">
          <p className="font-semibold text-cyan-300">“{design.title}”</p>
          <p className="mt-1 text-xs text-zinc-400">{design.reasoning}</p>
          <p className="mt-1 text-xs text-zinc-500">
            {design.songs.length} songs queued · endless
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {(
          [
            ["rotation", "🔁 Hook Rotation"],
            ["stems", "🎚 Stems Layer"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setMashMode(k)}
            className={`rounded-lg px-4 py-2 text-sm ${
              mashMode === k ? "bg-cyan-600" : "border border-zinc-700 text-zinc-300"
            }`}
          >
            {label}
          </button>
        ))}
        <button
          onClick={play}
          disabled={!design || playing}
          className="rounded-lg bg-zinc-100 px-5 py-2 font-semibold text-zinc-900 disabled:opacity-40"
        >
          🌀 Mash
        </button>
        {playing && (
          <button
            onClick={stopAll}
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm"
          >
            Stop
          </button>
        )}
      </div>

      {status && <p className="animate-pulse text-sm text-amber-400">{status}</p>}
      {stemError && (
        <div className="rounded-xl border-2 border-red-600 bg-red-950/40 p-4 text-sm font-semibold text-red-300">
          ⚠ {stemError}
        </div>
      )}

      {playing && (
        <div className="grid gap-3 sm:grid-cols-2">
          {mashMode === "stems" && (
            <div className="rounded-xl border border-zinc-800 p-3 text-sm">
              <p className="text-xs uppercase text-zinc-500">instrumental bed</p>
              <p className="truncate font-semibold">{bedTitle}</p>
            </div>
          )}
          <div className="rounded-xl border border-cyan-900 p-3 text-sm">
            <p className="text-xs uppercase text-zinc-500">
              {mashMode === "stems" ? "vocal on top" : "now playing"}
            </p>
            <p className="truncate font-semibold text-cyan-300">{nowTitle}</p>
          </div>
        </div>
      )}
    </main>
  );
}
