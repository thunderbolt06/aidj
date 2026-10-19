"use client";

import { useRef, useState } from "react";
import { analyzeMono, type CoreAnalysis } from "@/lib/audio/analysisCore";
import { compatible, keyName, RELATION_TEXT } from "@/lib/site/camelot";

type State = { s: "idle" } | { s: "busy"; name: string } | { s: "done"; name: string; r: CoreAnalysis; clipFrom: number } | { s: "error"; msg: string };

async function analyse(file: File): Promise<{ r: CoreAnalysis; clipFrom: number }> {
  const AC: typeof AudioContext = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC();
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const sr = buf.sampleRate;
    const dur = buf.duration;
    const from = dur > 115 ? 20 : 0;
    const len = Math.min(Math.floor((dur - from) * sr), 90 * sr);
    const start = Math.floor(from * sr);
    const mono = new Float32Array(len);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += ch[start + i] / buf.numberOfChannels;
    }
    await new Promise((r) => setTimeout(r, 30)); // let the spinner paint before the heavy loop
    const r = analyzeMono(mono, sr);
    return { r: { ...r, duration: dur }, clipFrom: from };
  } finally {
    ctx.close().catch(() => {});
  }
}

export function BpmKeyDetector() {
  const [state, setState] = useState<State>({ s: "idle" });
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function run(file: File | undefined) {
    if (!file) return;
    setState({ s: "busy", name: file.name });
    try {
      const { r, clipFrom } = await analyse(file);
      setState({ s: "done", name: file.name, r, clipFrom });
    } catch {
      setState({ s: "error", msg: "That file could not be decoded. Try an mp3, m4a, wav or ogg file." });
    }
  }

  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

  return (
    <div>
      <label
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); run(e.dataTransfer.files[0]); }}
        className={`flex cursor-pointer flex-col items-center gap-2 rounded-3xl border-2 border-dashed px-6 py-12 text-center transition-colors ${
          over ? "border-cyan-400 bg-cyan-400/10" : "border-white/15 bg-white/[0.02] hover:border-cyan-400/60"
        }`}
      >
        <span aria-hidden className="text-3xl text-cyan-300">♪</span>
        <span className="text-lg font-semibold">Drop an audio file here, or click to choose</span>
        <span className="text-sm text-[#8aa0ab]">Analysed on your device. Nothing is uploaded.</span>
        <input ref={input} type="file" accept="audio/*" className="sr-only" onChange={(e) => run(e.target.files?.[0])} />
      </label>

      <div aria-live="polite" className="mt-6">
        {state.s === "busy" && (
          <p className="flex items-center gap-3 text-[#8aa0ab]">
            <span className="ep-eq text-cyan-300" aria-hidden><i /><i style={{ ["--d" as string]: ".15s" }} /><i style={{ ["--d" as string]: ".3s" }} /></span>
            Listening to {state.name}…
          </p>
        )}
        {state.s === "error" && <p className="text-red-300">{state.msg}</p>}
        {state.s === "done" && (() => {
          const { r } = state;
          const max = Math.max(...r.energy, 0.001);
          const compat = r.camelot ? Object.entries(compatible(r.camelot)) : [];
          return (
            <div className="space-y-5">
              <p className="truncate text-sm text-[#8aa0ab]">{state.name} · {mmss(r.duration)}{state.clipFrom ? ` · analysed from ${mmss(state.clipFrom)}` : ""}</p>
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                  <div className="text-xs text-[#8aa0ab]">Tempo</div>
                  <div className="ep-big mt-1 text-5xl">{r.bpm.toFixed(1)}</div>
                  <div className="mt-1 text-xs text-[#8aa0ab]">BPM · confidence {Math.round(r.bpmConfidence * 100)}% · half {(r.bpm / 2).toFixed(1)} · double {(r.bpm * 2).toFixed(1)}</div>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                  <div className="text-xs text-[#8aa0ab]">Key</div>
                  <div className="ep-big mt-1 text-5xl">{r.camelot ?? "?"}</div>
                  <div className="mt-1 text-xs text-[#8aa0ab]">{r.camelot ? keyName(r.camelot) : "No clear key"} · confidence {Math.round(r.keyConfidence * 100)}%</div>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                  <div className="text-xs text-[#8aa0ab]">Intensity</div>
                  <div className="ep-big mt-1 text-5xl">{Math.round(r.intensity * 100)}</div>
                  <div className="mt-1 text-xs text-[#8aa0ab]">0 ambient, 100 peak-time banger</div>
                </div>
              </div>
              <div>
                <div className="mb-2 text-xs text-[#8aa0ab]">Energy, second by second</div>
                <div className="flex h-20 items-end gap-px">
                  {r.energy.slice(0, 90).map((e, i) => (
                    <i key={i} className="flex-1 rounded-sm bg-cyan-300/80" style={{ height: `${Math.max(4, (e / max) * 100)}%` }} />
                  ))}
                </div>
              </div>
              {compat.length > 0 && (
                <div>
                  <div className="mb-2 text-xs text-[#8aa0ab]">Keys that mix with it</div>
                  <ul className="flex flex-wrap gap-2">
                    {compat.map(([code, rel]) => (
                      <li key={code} className="ep-chip" title={RELATION_TEXT[rel]}>
                        <b className="text-white">{code}</b> {RELATION_TEXT[rel]}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
