"use client";

import { useState } from "react";
import { compatible, keyName, RELATION_TEXT, type Relation } from "@/lib/site/camelot";

const R = { A: 92, B: 148 }; // ring radii
const S = 190;

const TONE: Record<Relation, { fill: string; text: string }> = {
  same: { fill: "#22d3ee", text: "#04141a" },
  step: { fill: "#34d399", text: "#04140c" },
  relative: { fill: "#34d399", text: "#04140c" },
  boost2: { fill: "#ffb454", text: "#1a1004" },
  semitone: { fill: "#ffb454", text: "#1a1004" },
};

function pos(n: number, ring: "A" | "B") {
  const ang = ((n - 3) * 30 * Math.PI) / 180; // 12 at the top
  // rounded: server and browser trig differ in the last digits, which would break hydration
  return { x: +(S + Math.cos(ang) * R[ring]).toFixed(2), y: +(S + Math.sin(ang) * R[ring]).toFixed(2) };
}

export function CamelotWheel() {
  const [sel, setSel] = useState("8A");
  const rel = compatible(sel);
  const list = Object.entries(rel);

  return (
    <div className="grid items-center gap-8 lg:grid-cols-[1.1fr_1fr]">
      <svg viewBox={`0 0 ${S * 2} ${S * 2}`} className="mx-auto w-full max-w-md" role="group" aria-label="Camelot wheel">
        <circle cx={S} cy={S} r={R.B + 28} fill="rgba(232,244,248,0.03)" stroke="rgba(232,244,248,0.1)" />
        <circle cx={S} cy={S} r={R.A - 30} fill="#05080f" stroke="rgba(232,244,248,0.1)" />
        {(["B", "A"] as const).flatMap((ring) =>
          Array.from({ length: 12 }, (_, k) => {
            const n = k + 1;
            const code = `${n}${ring}`;
            const { x, y } = pos(n, ring);
            const r = rel[code];
            const tone = r ? TONE[r] : null;
            return (
              <g key={code} onClick={() => setSel(code)} className="cursor-pointer" role="button" tabIndex={0} aria-label={`${code}, ${keyName(code)}`}
                 onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setSel(code))}>
                <circle cx={x} cy={y} r={(ring === "A" ? 21 : 25) + (code === sel ? 3 : 0)} fill={tone ? tone.fill : "rgba(232,244,248,0.06)"} stroke={tone ? "none" : "rgba(232,244,248,0.14)"}
                        style={{ transition: "all .25s ease" }} />
                <text x={x} y={y + 5} textAnchor="middle" fontSize={ring === "A" ? 13 : 15} fontWeight="700" fill={tone ? tone.text : "#cfdfe6"} style={{ pointerEvents: "none" }}>{code}</text>
              </g>
            );
          })
        )}
        <text x={S} y={S - 4} textAnchor="middle" fontSize="12" fill="#8aa0ab">outer = major (B)</text>
        <text x={S} y={S + 14} textAnchor="middle" fontSize="12" fill="#8aa0ab">inner = minor (A)</text>
      </svg>
      <div>
        <div className="ep-eyebrow">Selected</div>
        <div className="ep-big text-6xl">{sel}</div>
        <div className="mt-1 text-lg text-[#cfdfe6]">{keyName(sel)}</div>
        <ul className="mt-6 space-y-2">
          {list.map(([code, r]) => (
            <li key={code}>
              <button onClick={() => setSel(code)} className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-left transition-colors hover:border-cyan-400/50">
                <span className="grid h-9 w-12 place-items-center rounded-lg text-sm font-bold" style={{ background: TONE[r].fill, color: TONE[r].text }}>{code}</span>
                <span className="flex-1">
                  <span className="block text-sm">{RELATION_TEXT[r]}</span>
                  <span className="block text-xs text-[#8aa0ab]">{keyName(code)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
