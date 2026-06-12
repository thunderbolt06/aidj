"use client";

import { useRef, useState } from "react";
import type { Track } from "@/lib/types";
import { getEngine, searchTracks } from "@/lib/client/dj";
import { useAutoMix } from "@/lib/client/useAutoMix";
import { SearchPicker } from "@/components/SearchPicker";
import { HeatmapBar } from "@/components/HeatmapBar";

type SR = {
  new (): {
    lang: string;
    interimResults: boolean;
    onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
    onend: () => void;
    start(): void;
  };
};

export default function TalkingDjPage() {
  const mix = useAutoMix();
  const [transcript, setTranscript] = useState<{ who: "you" | "dj"; text: string }[]>([]);
  const [busy, setBusy] = useState("");
  const [listening, setListening] = useState(false);
  const speaking = useRef(false);

  async function djSpeak(userSaid?: string) {
    if (speaking.current) return;
    speaking.current = true;
    setBusy("DJ is thinking…");
    try {
      const res = await fetch("/api/ai/dj", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          now: mix.now?.meta.title ?? null,
          next: mix.queue[(mix.nowIdx + 1) % Math.max(mix.queue.length, 1)]?.title ?? null,
          userSaid,
        }),
      });
      if (!res.ok) throw new Error("DJ brain offline — ANTHROPIC_API_KEY?");
      const { speech, action } = await res.json();
      setTranscript((t) => [...t, { who: "dj", text: speech }]);

      setBusy("DJ grabbing the mic…");
      const ttsRes = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: speech }),
      });
      if (ttsRes.ok) {
        const blob = await ttsRes.blob();
        const audio = new Audio(URL.createObjectURL(blob));
        audio.onloadedmetadata = () => {
          if (mix.running) getEngine().duck(0.2, audio.duration + 0.3);
        };
        await audio.play();
      } else {
        setTranscript((t) => [
          ...t,
          { who: "dj", text: "(voice offline — OPENAI_API_KEY missing, text only)" },
        ]);
      }

      if (action?.type === "vibe_change" && action.prompt) {
        setBusy(`changing vibe → ${action.prompt}`);
        const intentRes = await fetch("/api/ai/intent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: action.prompt }),
        });
        if (intentRes.ok) {
          const plan = await intentRes.json();
          const found = await Promise.all(
            (plan.queries as string[]).map((q) =>
              searchTracks(q).then((r) => r[0] ?? null).catch(() => null)
            )
          );
          const tracks = found.filter((t): t is Track => !!t);
          if (tracks.length) {
            mix.setQueue(tracks);
            if (mix.running) await mix.transitionTo(tracks[0]);
          }
        }
      }
      setBusy("");
    } catch (e) {
      setBusy(e instanceof Error ? e.message : "failed");
    } finally {
      speaking.current = false;
    }
  }

  function listen() {
    const w = window as unknown as { SpeechRecognition?: SR; webkitSpeechRecognition?: SR };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return setBusy("Speech recognition not supported here");
    const rec = new Ctor();
    rec.lang = "en-IN";
    rec.interimResults = false;
    rec.onresult = (e) => {
      const text = e.results[0][0].transcript;
      setTranscript((t) => [...t, { who: "you", text }]);
      djSpeak(text);
    };
    rec.onend = () => setListening(false);
    setListening(true);
    rec.start();
  }

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Talking DJ</h1>
        <p className="text-sm text-zinc-400">
          MC Fable spins your queue, talks between songs (music ducks under the
          voice), and listens when you talk back — ask for a vibe change
          mid-set.
        </p>
      </header>

      <SearchPicker
        placeholder="Queue songs for the DJ…"
        onPick={(t) => mix.setQueue((q) => [...q, t])}
      />

      <div className="flex flex-wrap items-center gap-3">
        {!mix.running ? (
          <button
            onClick={async () => {
              await mix.start({ clipLen: 60, useAi: true });
              djSpeak();
            }}
            disabled={mix.queue.length < 2}
            className="rounded-lg bg-zinc-100 px-5 py-2 font-semibold text-zinc-900 disabled:opacity-40"
          >
            ▶ Go live ({mix.queue.length} queued)
          </button>
        ) : (
          <>
            <button
              onClick={() => djSpeak()}
              className="rounded-lg bg-fuchsia-600 px-4 py-2 text-sm font-medium"
            >
              🎤 DJ, say something
            </button>
            <button
              onClick={listen}
              className={`rounded-lg border px-4 py-2 text-sm ${
                listening ? "animate-pulse border-red-500 text-red-400" : "border-zinc-700"
              }`}
            >
              🎙 Talk to the DJ
            </button>
            <button
              onClick={() => mix.stop()}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm"
            >
              Stop
            </button>
          </>
        )}
      </div>

      {(busy || mix.status) && (
        <p className="animate-pulse text-sm text-amber-400">{busy || mix.status}</p>
      )}

      {mix.now && (
        <div className="rounded-xl border border-zinc-800 p-4 space-y-2">
          <p className="truncate font-semibold">{mix.now.meta.title}</p>
          <HeatmapBar meta={mix.now.meta} position={mix.position} />
        </div>
      )}

      {transcript.length > 0 && (
        <div className="space-y-2 text-sm">
          {transcript.slice(-8).map((m, i) => (
            <p key={i} className={m.who === "dj" ? "text-fuchsia-300" : "text-zinc-300"}>
              <b>{m.who === "dj" ? "MC Fable" : "You"}:</b> {m.text}
            </p>
          ))}
        </div>
      )}
    </main>
  );
}
