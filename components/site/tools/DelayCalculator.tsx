"use client";

import { useState } from "react";

const DIVS: [string, number][] = [["1/1", 4], ["1/2", 2], ["1/4", 1], ["1/8", 0.5], ["1/16", 0.25], ["1/32", 0.125]];

export function DelayCalculator() {
  const [bpm, setBpm] = useState("124");
  const [copied, setCopied] = useState("");
  const b = parseFloat(bpm);
  const ok = Number.isFinite(b) && b >= 20 && b <= 400;
  const q = ok ? 60000 / b : 0;

  const copy = (ms: number) => {
    navigator.clipboard?.writeText(ms.toFixed(2)).then(() => {
      setCopied(ms.toFixed(2));
      setTimeout(() => setCopied(""), 1200);
    }).catch(() => {});
  };

  return (
    <div>
      <div className="max-w-xs">
        <label htmlFor="bpm" className="ep-label">Tempo (BPM)</label>
        <input id="bpm" inputMode="decimal" className="ep-input ep-big !text-2xl" value={bpm} onChange={(e) => setBpm(e.target.value)} />
        {!ok && <p className="mt-2 text-sm text-red-300">Enter a tempo between 20 and 400.</p>}
      </div>
      <div className="mt-6 overflow-x-auto rounded-2xl border border-white/10">
        <table className="ep-table">
          <thead>
            <tr><th>Note</th><th>Straight</th><th>Dotted</th><th>Triplet</th></tr>
          </thead>
          <tbody>
            {DIVS.map(([name, mult]) => (
              <tr key={name}>
                <th scope="row">{name}</th>
                {[1, 1.5, 2 / 3].map((f) => {
                  const ms = q * mult * f;
                  return (
                    <td key={f}>
                      <button disabled={!ok} onClick={() => copy(ms)} className="ep-big text-left hover:text-cyan-300 disabled:opacity-40" title="Click to copy milliseconds">
                        {ok ? ms.toFixed(2) : "--"}<span className="ml-1 text-xs font-normal text-[#8aa0ab]">ms</span>
                      </button>
                      <div className="text-xs text-[#8aa0ab]">{ok ? (1000 / ms).toFixed(2) : "--"} Hz</div>
                      {copied === ms.toFixed(2) && ok && <span className="text-xs text-cyan-300">Copied</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
