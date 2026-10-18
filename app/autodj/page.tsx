"use client";

import { useEffect, useState } from "react";
import type { TransitionStyle } from "@/lib/types";
import { useAutoMix } from "@/lib/client/useAutoMix";
import { SearchPicker } from "@/components/SearchPicker";
import { Cover } from "@/components/Cover";
import { HeatmapBar } from "@/components/HeatmapBar";
import { MusicVisualizer } from "@/components/MusicVisualizer";
import { BeatTapPulse } from "@/components/BeatTapPulse";
import { TransitionRating } from "@/components/TransitionRating";

const TRICKS: { value: TransitionStyle | ""; label: string }[] = [
  { value: "", label: "🤖 AI picks the trick" },
  { value: "loop_roll", label: "🔂 Loop roll (stutter → slam)" },
  { value: "brake", label: "🛑 Vinyl brake" },
  { value: "riser", label: "🚀 Noise riser → drop" },
  { value: "double_drop", label: "💥 Double drop" },
  { value: "bass_swap", label: "🎚 Bass swap" },
  { value: "filter_sweep", label: "🌀 Filter sweep" },
  { value: "echo_out", label: "🔊 Echo out" },
  { value: "crossfade", label: "🌊 Crossfade" },
  { value: "cut", label: "✂️ Cut" },
  { value: "silence_drop", label: "🤫 Silence drop (dead air → slam)" },
  { value: "backspin", label: "⏪ Backspin" },
  { value: "tape_stop", label: "📼 Tape stop" },
  { value: "gate", label: "🔲 Gate / strobe" },
  { value: "stem_acapella", label: "🎤 Acapella-in (stems)" },
  { value: "vocal_handoff", label: "🎙️ Vocal handoff (beat first, singer later)" },
];

export default function AutoDjPage() {
  const mix = useAutoMix();
  const [clipLen, setClipLen] = useState<number | "ai">("ai");
  const [minPlaySec, setMinPlaySec] = useState(25);
  const [useAi, setUseAi] = useState(true);
  const [quantize, setQuantize] = useState(true);
  const [endless, setEndless] = useState(true);
  const [keyLock, setKeyLock] = useState(true);
  const [stems, setStems] = useState(false);
  const [trick, setTrick] = useState<TransitionStyle | "">("");
  const [musicVideo, setMusicVideo] = useState(false);
  const [tapToExtend, setTapToExtend] = useState(true);

  // spacebar = interest tap (skip when typing in an input/select)
  useEffect(() => {
    if (!mix.running || !tapToExtend) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.code !== "Space" || e.repeat) return;
      e.preventDefault();
      mix.tapInterest();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mix.running, tapToExtend]);

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-6">
      <TransitionRating hop={mix.lastHop} onRate={mix.rateHop} />
      <header>
        <h1 className="text-2xl font-bold">Auto-DJ</h1>
        <p className="text-sm text-zinc-400">
          Only the famous part of every song. In <b>AI timing</b> mode the
          transition plan decides when each song has given its best moment;
          quantize keeps drops on 4-bar phrase boundaries. Endless mode
          refills the queue so the set never stops.
        </p>
      </header>

      <SearchPicker
        placeholder="Add songs to the queue…"
        onPick={(t) => mix.addNext(t)}
      />

      {mix.queue.length > 0 && (
        <ul className="space-y-1 text-sm">
          {mix.queue.map((t, i) => (
            <li
              key={`${t.id}-${i}`}
              className={`flex items-center justify-between rounded px-3 py-1.5 ${
                i === mix.nowIdx
                  ? "bg-cyan-950/40 text-cyan-300"
                  : "bg-zinc-900"
              }`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Cover src={t.thumbnail} lazy className="h-8 w-8 rounded" />
                <span className="truncate">
                  {i + 1}. {t.title}
                </span>
              </span>
              <button
                onClick={() =>
                  mix.setQueue((q) => q.filter((_, j) => j !== i))
                }
                className="ml-2 text-zinc-500 hover:text-red-400"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {([
          ["ai", "🤖 AI timing"],
          [30, "30s"],
          [60, "60s"],
        ] as const).map(([len, label]) => (
          <button
            key={String(len)}
            onClick={() => setClipLen(len)}
            className={`rounded-lg px-4 py-2 text-sm ${
              clipLen === len
                ? "bg-cyan-600"
                : "border border-zinc-700 text-zinc-300"
            }`}
          >
            {label}
          </button>
        ))}
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={useAi}
            onChange={(e) => setUseAi(e.target.checked)}
          />
          AI plans transitions
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={quantize}
            onChange={(e) => setQuantize(e.target.checked)}
          />
          Quantize
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={endless}
            onChange={(e) => setEndless(e.target.checked)}
          />
          Endless
        </label>
        <label
          className="flex items-center gap-2 text-sm text-zinc-300"
          title="Pitch-preserve tempo changes when beat-matching (master tempo)"
        >
          <input
            type="checkbox"
            checked={keyLock}
            onChange={(e) => {
              setKeyLock(e.target.checked);
              mix.setOptions({ keyLock: e.target.checked });
            }}
          />
          🔑 Key-lock
        </label>
        <label
          className="flex items-center gap-2 text-sm text-zinc-300"
          title="Stem-aware acapella-in transitions (needs Replicate; pre-warms demucs vocals)"
        >
          <input
            type="checkbox"
            checked={stems}
            onChange={(e) => {
              setStems(e.target.checked);
              mix.setOptions({ stems: e.target.checked });
            }}
          />
          🎤 Stems
        </label>
        <label
          className="flex items-center gap-2 text-sm text-zinc-300"
          title="Tap spacebar (or the pad) on the beat to keep a song you like playing - each tap guarantees 15 more seconds. Turn off for smooth hands-free listening."
        >
          <input
            type="checkbox"
            checked={tapToExtend}
            onChange={(e) => setTapToExtend(e.target.checked)}
          />
          👏 Tap to extend
        </label>
        <label
          className="flex items-center gap-2 text-sm text-zinc-300"
          title="Real-time, beat & chord-reactive music video - coded, not pre-rendered"
        >
          <input
            type="checkbox"
            checked={musicVideo}
            onChange={(e) => setMusicVideo(e.target.checked)}
          />
          🎬 Music video
        </label>
        <select
          value={trick}
          onChange={(e) => {
            const v = e.target.value as TransitionStyle | "";
            setTrick(v);
            mix.setOptions({ styleHint: v || undefined }); // applies live mid-set
          }}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
        >
          {TRICKS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        {!mix.running ? (
          <button
            onClick={() => {
              mix.start({
                clipLen,
                minPlaySec,
                useAi,
                quantize,
                endless,
                keyLock,
                stems,
                styleHint: trick || undefined,
              });
            }}
            disabled={mix.queue.length < 1}
            className="rounded-lg bg-zinc-100 px-5 py-2 font-semibold text-zinc-900 disabled:opacity-40"
          >
            ▶ Start set
          </button>
        ) : (
          <>
            <button
              onClick={() => mix.hopNow()}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm"
            >
              skip →
            </button>
            {!mix.recording ? (
              <button
                onClick={() => mix.startRecording()}
                className="rounded-lg border border-red-700 px-4 py-2 text-sm text-red-300 hover:bg-red-950/40"
              >
                ● Record
              </button>
            ) : (
              <button
                onClick={() => mix.stopRecording()}
                className="animate-pulse rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold"
              >
                ◼ Stop recording
              </button>
            )}
            <button
              onClick={() => mix.stop()}
              className="rounded-lg border border-zinc-700 px-5 py-2 font-semibold"
            >
              ◼ Stop
            </button>
          </>
        )}
      </div>

      {clipLen === "ai" && (
        <div className="flex items-center gap-3 text-sm text-zinc-300">
          <label
            htmlFor="minPlay"
            className="shrink-0"
            title="In AI timing mode, every song plays at least this long before the AI is allowed to transition out of it."
          >
            ⏱ Min play <span className="text-zinc-500">(AI timing)</span>
          </label>
          <input
            id="minPlay"
            type="range"
            min={5}
            max={120}
            step={5}
            value={minPlaySec}
            onChange={(e) => {
              const v = Number(e.target.value);
              setMinPlaySec(v);
              mix.setOptions({ minPlaySec: v }); // applies live mid-set
            }}
            className="grow accent-cyan-600"
          />
          <span className="w-12 shrink-0 text-right tabular-nums text-zinc-100">
            {minPlaySec}s
          </span>
        </div>
      )}

      {mix.status && (
        <p className="animate-pulse text-xs text-amber-400">{mix.status}</p>
      )}

      {tapToExtend && (
        <BeatTapPulse
          analysis={mix.now?.analysis ?? null}
          interestUntil={mix.interestUntil}
          onTap={() => mix.tapInterest()}
          active={mix.running}
        />
      )}

      {mix.now && (
        <div className="rounded-xl border border-zinc-800 p-4 space-y-2">
          <div className="flex items-center gap-3">
            <Cover
              key={mix.now.meta.id}
              src={mix.now.meta.thumbnail}
              className="h-14 w-14 rounded-lg"
            />
            <p className="font-semibold">{mix.now.meta.title}</p>
          </div>
          <HeatmapBar meta={mix.now.meta} position={mix.position} />
          <p className="text-xs text-zinc-500">
            {mix.now.analysis.bpm} BPM
            {mix.now.analysis.camelot && (
              <span className="ml-1 text-violet-400">· {mix.now.analysis.camelot}</span>
            )}
            {mix.now.analysis.keyName && (
              <span className="ml-1">({mix.now.analysis.keyName})</span>
            )}
            {" · "}famous @ {mix.now.meta.famousStart ?? "?"}s
            {mix.now.analysis.bpmConfidence < 0.15 && (
              <span className="ml-2 text-amber-400" title="low tempo confidence - quantize off">
                · ⚠ shaky BPM
              </span>
            )}
            {mix.nextReady && (
              <span className="ml-2 text-emerald-400">· next hop prepared ✓</span>
            )}
          </p>
          {mix.lastPlan && (
            <p className="text-xs text-cyan-300">
              last hop: {mix.lastPlan.style}
              {mix.lastPlan.beatMatch ? " (beat-matched)" : ""} ,{" "}
              {mix.lastPlan.reasoning}
            </p>
          )}
        </div>
      )}

      {musicVideo && (
        <MusicVisualizer
          analysis={mix.now?.analysis ?? null}
          track={
            mix.now ? { title: mix.now.meta.title, artist: mix.now.meta.artist } : null
          }
          arc={mix.arcInfo ? { energy: mix.arcInfo.energy, phase: mix.arcInfo.phase } : null}
          active={mix.running}
        />
      )}

      {mix.mix && (
        <div className="space-y-3 rounded-xl border border-emerald-800 bg-emerald-950/20 p-4">
          <p className="font-semibold text-emerald-300">
            🎚 Mixtape recorded · {Math.round(mix.mix.durationSec)}s
          </p>
          <audio src={mix.mix.url} controls className="w-full" />
          <div className="flex flex-wrap items-center gap-3">
            <a
              href={mix.mix.url}
              download="aidj-mixtape.webm"
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold hover:bg-emerald-500"
            >
              ⬇ Download mixtape
            </a>
            <button
              onClick={() => {
                const lines = mix.setLog
                  .map(
                    (e, i) =>
                      `${i + 1}. ${e.title} - ${e.artist}${
                        i === 0 ? "" : `  (${e.style})`
                      }`
                  )
                  .join("\n");
                navigator.clipboard?.writeText(lines);
              }}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm"
            >
              📋 Copy setlist
            </button>
          </div>
        </div>
      )}

      {mix.setLog.length > 0 && (
        <div className="rounded-xl border border-zinc-800 p-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Setlist · {mix.setLog.length} tracks
          </p>
          <ol className="space-y-1 text-sm">
            {mix.setLog.map((e, i) => (
              <li
                key={`${e.index}-${i}`}
                className={`flex items-center justify-between gap-2 ${
                  i === mix.setLog.length - 1 ? "text-cyan-300" : "text-zinc-300"
                }`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Cover src={e.thumbnail} lazy className="h-7 w-7 rounded" />
                  <span className="truncate">
                    {i + 1}. {e.title}{" "}
                    <span className="text-zinc-500">, {e.artist}</span>
                  </span>
                </span>
                {i > 0 && (
                  <span className="shrink-0 text-xs text-zinc-500">{e.style}</span>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </main>
  );
}
