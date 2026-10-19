"use client";

import { useEffect, useState } from "react";
import { TRANSITIONS } from "@/lib/site/features";

const W = 480;
const H = 170;
const PAD = 14;

function path(points: readonly (readonly number[])[]) {
  return points
    .map(([x, y], i) => `${i ? "L" : "M"}${(PAD + x * (W - PAD * 2)).toFixed(1)},${(PAD + (1 - y) * (H - PAD * 2)).toFixed(1)}`)
    .join(" ");
}

/** Pick a transition and watch its volume curves draw. Cycles by itself until you click. */
export function TransitionLab() {
  const [i, setI] = useState(1);
  const [auto, setAuto] = useState(true);
  const t = TRANSITIONS[i];

  useEffect(() => {
    if (!auto || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setI((x) => (x + 1) % TRANSITIONS.length), 5200);
    return () => clearInterval(id);
  }, [auto]);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1.15fr]">
      <div role="tablist" aria-label="Transition styles" className="flex flex-wrap content-start gap-2">
        {TRANSITIONS.map((x, k) => (
          <button
            key={x.id}
            role="tab"
            aria-selected={k === i}
            onClick={() => {
              setAuto(false);
              setI(k);
            }}
            className={`rounded-full border px-4 py-2 text-sm transition-all ${
              k === i
                ? "border-cyan-400 bg-cyan-400/15 text-cyan-100 shadow-[0_0_24px_-6px_rgba(34,211,238,0.8)]"
                : "border-white/10 text-[#8aa0ab] hover:border-white/30 hover:text-white"
            }`}
          >
            {x.name}
          </button>
        ))}
      </div>
      <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-5">
        <div className="flex items-baseline justify-between gap-4">
          <h3 className="text-xl font-semibold">{t.name}</h3>
          <span className="font-[family-name:var(--font-geist-mono)] text-xs text-[#8aa0ab]">{i + 1}/{TRANSITIONS.length}</span>
        </div>
        <p className="mt-1.5 min-h-[3.2rem] text-sm leading-relaxed text-[#8aa0ab]">{t.text}</p>
        <svg key={t.id} viewBox={`0 0 ${W} ${H}`} className="mt-3 w-full" role="img" aria-label={`Volume curves for the ${t.name} transition`}>
          {[0.25, 0.5, 0.75].map((g) => (
            <line key={g} x1={PAD} x2={W - PAD} y1={PAD + g * (H - PAD * 2)} y2={PAD + g * (H - PAD * 2)} stroke="rgba(232,244,248,0.08)" />
          ))}
          <path pathLength={1} d={path(t.c)} className="ep-curve c" stroke="rgba(232,244,248,0.55)" strokeDasharray="0.02 0.02" />
          <path pathLength={1} d={path(t.a)} className="ep-curve" stroke="#22d3ee" />
          <path pathLength={1} d={path(t.b)} className="ep-curve b" stroke="#ffb454" />
        </svg>
        <div className="mt-2 flex flex-wrap gap-4 text-xs text-[#8aa0ab]">
          <span><i className="mr-1.5 inline-block h-0.5 w-4 bg-[#22d3ee] align-middle" />Song A</span>
          <span><i className="mr-1.5 inline-block h-0.5 w-4 bg-[#ffb454] align-middle" />Song B</span>
          <span><i className="mr-1.5 inline-block h-0.5 w-4 border-t border-dashed border-white/60 align-middle" />Effect / low end</span>
        </div>
      </div>
    </div>
  );
}
