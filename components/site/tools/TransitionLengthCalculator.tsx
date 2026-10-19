"use client";

import { useState } from "react";

const BARS = [2, 4, 8, 16, 32, 64];

export function TransitionLengthCalculator() {
  const [bpm, setBpm] = useState("124");
  const [bars, setBars] = useState("16");
  const [beats, setBeats] = useState("4");
  const b = parseFloat(bpm);
  const n = parseFloat(bars);
  const k = parseFloat(beats);
  const ok = [b, n, k].every((x) => Number.isFinite(x) && x > 0);
  const secs = ok ? (k * n * 60) / b : 0;
  const mmss = `${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, "0")}`;

  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label htmlFor="b" className="ep-label">Tempo (BPM)</label>
            <input id="b" inputMode="decimal" className="ep-input ep-big" value={bpm} onChange={(e) => setBpm(e.target.value)} />
          </div>
          <div>
            <label htmlFor="n" className="ep-label">Bars</label>
            <input id="n" inputMode="decimal" className="ep-input ep-big" value={bars} onChange={(e) => setBars(e.target.value)} />
          </div>
          <div>
            <label htmlFor="k" className="ep-label">Beats per bar</label>
            <input id="k" inputMode="decimal" className="ep-input ep-big" value={beats} onChange={(e) => setBeats(e.target.value)} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {BARS.map((x) => (
            <button key={x} onClick={() => setBars(String(x))} className={`rounded-full border px-3.5 py-1.5 text-sm ${bars === String(x) ? "border-cyan-400 bg-cyan-400/15 text-cyan-100" : "border-white/10 text-[#8aa0ab] hover:text-white"}`}>
              {x} bars
            </button>
          ))}
        </div>
      </div>
      <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-6">
        <div className="ep-eyebrow">Transition lasts</div>
        <div className="ep-big text-6xl">{ok ? secs.toFixed(1) : "--"}<span className="ml-2 text-2xl text-[#8aa0ab]">s</span></div>
        <div className="mt-1 text-[#8aa0ab]">{ok ? `${mmss} · ${(k * n).toFixed(0)} beats` : ""}</div>
        {ok && (
          <div className="mt-6">
            <div className="h-3 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-[#ffb454] transition-all duration-500" style={{ width: `${Math.min(100, (secs / 90) * 100)}%` }} />
            </div>
            <div className="mt-1 flex justify-between text-xs text-[#8aa0ab]"><span>0 s</span><span>90 s</span></div>
          </div>
        )}
      </div>
    </div>
  );
}
