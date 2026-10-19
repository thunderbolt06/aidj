"use client";

import { useState } from "react";
import { keyName, wrap } from "@/lib/site/camelot";

type From = "bpm" | "pct" | "semi";

export function PitchTempoCalculator() {
  const [orig, setOrig] = useState("120");
  const [vals, setVals] = useState({ bpm: "126", pct: "5", semi: "" });
  const [from, setFrom] = useState<From>("bpm");
  const [key, setKey] = useState("8A");

  const o = parseFloat(orig);
  const ok = Number.isFinite(o) && o > 0;
  let ratio = NaN;
  if (ok) {
    if (from === "bpm") ratio = parseFloat(vals.bpm) / o;
    if (from === "pct") ratio = 1 + parseFloat(vals.pct) / 100;
    if (from === "semi") ratio = Math.pow(2, parseFloat(vals.semi) / 12);
  }
  const valid = ok && Number.isFinite(ratio) && ratio > 0.2 && ratio < 5;
  const bpm = valid ? o * ratio : null;
  const pct = valid ? (ratio - 1) * 100 : null;
  const semi = valid ? 12 * Math.log2(ratio) : null;
  const m = /^(\d{1,2})([AB])$/.exec(key);
  const shifted = valid && m ? `${wrap(parseInt(m[1], 10) + Math.round(semi!) * 7)}${m[2]}` : null;

  const set = (k: From) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setFrom(k);
    setVals((v) => ({ ...v, [k]: e.target.value }));
  };
  const shown = (k: From, n: number | null, d: number) => (from === k ? vals[k] : n === null ? "" : n.toFixed(d));

  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <div className="space-y-4">
        <div>
          <label htmlFor="orig" className="ep-label">Original tempo (BPM)</label>
          <input id="orig" inputMode="decimal" className="ep-input ep-big" value={orig} onChange={(e) => setOrig(e.target.value)} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label htmlFor="nb" className="ep-label">New BPM</label>
            <input id="nb" inputMode="decimal" className="ep-input ep-big" value={shown("bpm", bpm, 2)} onChange={set("bpm")} />
          </div>
          <div>
            <label htmlFor="pc" className="ep-label">Pitch fader %</label>
            <input id="pc" inputMode="decimal" className="ep-input ep-big" value={shown("pct", pct, 2)} onChange={set("pct")} />
          </div>
          <div>
            <label htmlFor="st" className="ep-label">Semitones</label>
            <input id="st" inputMode="decimal" className="ep-input ep-big" value={shown("semi", semi, 2)} onChange={set("semi")} />
          </div>
        </div>
        <p className="text-sm text-[#8aa0ab]">Type in any of the three. The others follow.</p>
      </div>
      <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-6">
        <div className="ep-eyebrow">Without key lock</div>
        <label htmlFor="ck" className="ep-label mt-3">Original Camelot key</label>
        <select id="ck" value={key} onChange={(e) => setKey(e.target.value)} className="ep-input">
          {Array.from({ length: 24 }, (_, i) => `${(i % 12) + 1}${i < 12 ? "A" : "B"}`).map((c) => (
            <option key={c} value={c}>{c} · {keyName(c)}</option>
          ))}
        </select>
        <div className="mt-5 text-[#8aa0ab]">The song would sound in</div>
        <div className="ep-big text-5xl">{shifted ?? "--"}</div>
        <div className="mt-1 text-[#cfdfe6]">{shifted ? keyName(shifted) : ""}</div>
        <p className="mt-4 text-xs leading-relaxed text-[#8aa0ab]">
          Shift is rounded to whole semitones. Under about 3% the key barely moves, which is why small tempo nudges still blend. Turn on key lock to change tempo without changing pitch.
        </p>
      </div>
    </div>
  );
}
