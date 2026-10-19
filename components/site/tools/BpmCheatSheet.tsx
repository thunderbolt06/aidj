"use client";

import { useMemo, useState } from "react";

const ROWS: { name: string; kind: "Genre" | "Activity"; lo: number; hi: number }[] = [
  { name: "Ambient / downtempo", kind: "Genre", lo: 60, hi: 100 },
  { name: "Lo-fi hip hop", kind: "Genre", lo: 70, hi: 90 },
  { name: "Reggae", kind: "Genre", lo: 60, hi: 90 },
  { name: "Hip hop", kind: "Genre", lo: 80, hi: 100 },
  { name: "R&B", kind: "Genre", lo: 60, hi: 100 },
  { name: "Trap", kind: "Genre", lo: 130, hi: 170 },
  { name: "Pop", kind: "Genre", lo: 100, hi: 130 },
  { name: "Bollywood dance", kind: "Genre", lo: 100, hi: 130 },
  { name: "Bhangra", kind: "Genre", lo: 100, hi: 120 },
  { name: "Disco", kind: "Genre", lo: 110, hi: 130 },
  { name: "Funk", kind: "Genre", lo: 95, hi: 125 },
  { name: "Deep house", kind: "Genre", lo: 118, hi: 125 },
  { name: "House", kind: "Genre", lo: 120, hi: 130 },
  { name: "Afrobeats", kind: "Genre", lo: 95, hi: 115 },
  { name: "Reggaeton", kind: "Genre", lo: 90, hi: 100 },
  { name: "Techno", kind: "Genre", lo: 125, hi: 150 },
  { name: "Trance", kind: "Genre", lo: 130, hi: 145 },
  { name: "Drum and bass", kind: "Genre", lo: 160, hi: 180 },
  { name: "Dubstep", kind: "Genre", lo: 138, hi: 142 },
  { name: "Punk / rock", kind: "Genre", lo: 140, hi: 190 },
  { name: "Jazz", kind: "Genre", lo: 90, hi: 200 },
  { name: "Yoga and stretching", kind: "Activity", lo: 50, hi: 80 },
  { name: "Studying / deep focus", kind: "Activity", lo: 60, hi: 90 },
  { name: "Dinner / background", kind: "Activity", lo: 85, hi: 115 },
  { name: "Cooking and cleaning", kind: "Activity", lo: 90, hi: 110 },
  { name: "Walking / commute", kind: "Activity", lo: 100, hi: 120 },
  { name: "Party warm-up", kind: "Activity", lo: 110, hi: 124 },
  { name: "Dance floor", kind: "Activity", lo: 120, hi: 130 },
  { name: "Lifting", kind: "Activity", lo: 120, hi: 150 },
  { name: "Running", kind: "Activity", lo: 150, hi: 180 },
];

export function BpmCheatSheet() {
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<string | null>(null);
  const rows = useMemo(() => ROWS.filter((r) => r.name.toLowerCase().includes(q.toLowerCase())), [q]);

  return (
    <div>
      <label htmlFor="q" className="ep-label">Search genres and activities</label>
      <input id="q" className="ep-input max-w-sm" placeholder="house, running, study…" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="mt-6 space-y-2">
        {rows.map((r) => {
          const on = pick === r.name;
          return (
            <li key={r.name}>
              <button onClick={() => setPick(on ? null : r.name)} className={`w-full rounded-2xl border p-4 text-left transition-colors ${on ? "border-cyan-400/60 bg-cyan-400/10" : "border-white/10 bg-white/[0.03] hover:border-white/25"}`} aria-pressed={on}>
                <div className="flex items-baseline justify-between gap-4">
                  <span className="font-medium">{r.name} <span className="ml-2 text-xs text-[#8aa0ab]">{r.kind}</span></span>
                  <span className="ep-big text-lg">{r.lo}–{r.hi}</span>
                </div>
                <div className="relative mt-3 h-2 rounded-full bg-white/10" aria-hidden>
                  <div className="absolute inset-y-0 rounded-full bg-gradient-to-r from-cyan-400 to-[#ffb454]" style={{ left: `${((r.lo - 40) / 160) * 100}%`, width: `${((r.hi - r.lo) / 160) * 100}%`, minWidth: 6 }} />
                </div>
                {on && <p className="mt-3 text-sm text-[#8aa0ab]">Half-time feels like {Math.round(r.lo / 2)}–{Math.round(r.hi / 2)} BPM. Look for songs in this band, then check neighbours on the Camelot wheel.</p>}
              </button>
            </li>
          );
        })}
        {rows.length === 0 && <li className="text-[#8aa0ab]">Nothing matches. Try another word.</li>}
      </ul>
      <div className="mt-2 flex justify-between text-xs text-[#8aa0ab]"><span>Scale: 40 BPM</span><span>200 BPM</span></div>
    </div>
  );
}
