"use client";

import { useRef, useState } from "react";
import type { Track } from "@/lib/types";
import { searchTracks } from "@/lib/client/dj";
import { useAutoMix } from "@/lib/client/useAutoMix";
import { getSelectedLanguageLabels } from "@/lib/client/langPrefs";
import { getSongSource } from "@/lib/client/sourcePrefs";
import { listenerHistory } from "@/lib/client/history";
import { HeatmapBar } from "@/components/HeatmapBar";
import { Cover } from "@/components/Cover";
import { TransitionRating } from "@/components/TransitionRating";

interface VibePlan {
  vibe: string;
  energyArc: string;
  transitionStyleHint: string;
  queries: string[];
  vibes?: string[];
}

// Web Speech API (Chrome/Safari)
type SR = {
  new (): {
    lang: string;
    interimResults: boolean;
    onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
    onend: () => void;
    start(): void;
    stop(): void;
  };
};

export default function VibePage() {
  const mix = useAutoMix();
  const [prompt, setPrompt] = useState("");
  const [plan, setPlan] = useState<VibePlan | null>(null);
  const [busy, setBusy] = useState("");
  const [listening, setListening] = useState(false);
  const history = useRef<string[]>([]);

  async function buildVibe(text: string) {
    if (!text.trim()) return;
    setBusy("AI is reading the vibe…");
    try {
      const res = await fetch("/api/ai/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: text,
          history: history.current.join(" → ") || undefined,
          languages: getSelectedLanguageLabels(),
          songSource: getSongSource(),
          ...listenerHistory(),
        }),
      });
      if (!res.ok) throw new Error("intent failed - is ANTHROPIC_API_KEY set?");
      const p: VibePlan = await res.json();
      setPlan(p);
      history.current.push(p.vibe);

      setBusy("finding the songs…");
      const found = await Promise.all(
        p.queries.map((q) =>
          searchTracks(q)
            .then((r) => r[0] ?? null)
            .catch(() => null)
        )
      );
      const tracks = found.filter((t): t is Track => !!t);
      const wasRunning = mix.running;
      mix.setQueue(tracks);
      setBusy("");
      if (!wasRunning) {
        await mix.start({ clipLen: "ai", useAi: true, quantize: true, endless: true, vibes: p.vibes });
      } else {
        mix.setOptions({ vibes: p.vibes });
        // vibe change mid-set: hop into the new queue immediately
        await mix.transitionTo(tracks[0]);
      }
      mix.prefetch();
    } catch (e) {
      setBusy(e instanceof Error ? e.message : "failed");
    }
  }

  function listen() {
    const Ctor = (
      window as unknown as { webkitSpeechRecognition?: SR; SpeechRecognition?: SR }
    ).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: SR }).webkitSpeechRecognition;
    if (!Ctor) {
      setBusy("Speech recognition not supported in this browser");
      return;
    }
    const rec = new Ctor();
    rec.lang = "en-IN";
    rec.interimResults = false;
    rec.onresult = (e) => {
      const text = e.results[0][0].transcript;
      setPrompt(text);
      buildVibe(text);
    };
    rec.onend = () => setListening(false);
    setListening(true);
    rec.start();
  }

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-6">
      <TransitionRating hop={mix.lastHop} onRate={mix.rateHop} />
      <header>
        <h1 className="text-2xl font-bold">Vibe Prompt</h1>
        <p className="text-sm text-zinc-400">
          Tell the DJ what you want - typed or spoken. Change the vibe mid-set
          and it transitions over.
        </p>
      </header>

      <div className="flex gap-2">
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && buildVibe(prompt)}
          placeholder='e.g. "singable road trip", "sangeet bangers", "high"'
          className="flex-1 rounded-lg bg-zinc-900 border border-zinc-700 px-3 py-2 outline-none focus:border-cyan-500"
        />
        <button
          onClick={() => buildVibe(prompt)}
          className="rounded-lg bg-cyan-600 px-4 py-2 font-medium hover:bg-cyan-500"
        >
          Mix it
        </button>
        <button
          onClick={listen}
          className={`rounded-lg border px-4 py-2 ${
            listening
              ? "animate-pulse border-red-500 text-red-400"
              : "border-zinc-700"
          }`}
          title="Speak the vibe"
        >
          🎙
        </button>
      </div>

      {busy && <p className="animate-pulse text-sm text-amber-400">{busy}</p>}
      {mix.status && (
        <p className="animate-pulse text-xs text-amber-400">{mix.status}</p>
      )}

      {plan && (
        <div className="rounded-xl border border-cyan-900/50 bg-cyan-950/20 p-4 text-sm">
          <p>
            <span className="font-semibold text-cyan-300">{plan.vibe}</span>{" "}
            · arc: {plan.energyArc} · style: {plan.transitionStyleHint}
          </p>
        </div>
      )}

      {mix.queue.length > 0 && (
        <ul className="space-y-1 text-sm">
          {mix.queue.map((t, i) => (
            <li
              key={`${t.id}-${i}`}
              className={`flex items-center gap-2 rounded px-3 py-1.5 ${
                i === mix.nowIdx
                  ? "bg-cyan-950/40 text-cyan-300"
                  : "bg-zinc-900"
              }`}
            >
              <Cover src={t.thumbnail} lazy className="h-8 w-8 rounded" />
              <span className="truncate">
                {i + 1}. {t.title}
              </span>
            </li>
          ))}
        </ul>
      )}

      {mix.now && (
        <div className="rounded-xl border border-zinc-800 p-4 space-y-2">
          <div className="flex items-center gap-3">
            <Cover src={mix.now.meta.thumbnail} className="h-14 w-14 rounded-lg" />
            <p className="font-semibold">{mix.now.meta.title}</p>
          </div>
          <HeatmapBar meta={mix.now.meta} position={mix.position} />
          {mix.lastPlan && (
            <p className="text-xs text-cyan-300">
              {mix.lastPlan.style} - {mix.lastPlan.reasoning}
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
