"use client";

import { useEffect, useState } from "react";

const PROMPTS = [
  "singable road trip",
  "late night chill",
  "gym workout time",
  "shaadi dance floor",
  "rainy day mood",
  "bhangra dance floor",
];
const KEYS = ["8A", "9A", "8B", "10A", "7B", "9B"];

function h(s: string, i: number) {
  let x = 7 + i * 31;
  for (let k = 0; k < s.length; k++) x = (x * 33 + s.charCodeAt(k)) % 9973;
  return x;
}

/** A prompt box that types example vibes and fills a queue under it. Illustrative only. */
export function VibeTyper() {
  const [p, setP] = useState(0);
  const [n, setN] = useState(0);
  const [done, setDone] = useState(false);
  const text = PROMPTS[p];

  useEffect(() => {
    let id: ReturnType<typeof setTimeout>;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      id = setTimeout(() => {
        setN(text.length);
        setDone(true);
      }, 0);
      return () => clearTimeout(id);
    }
    if (!done && n < text.length) id = setTimeout(() => setN(n + 1), 55 + (n % 3) * 18);
    else if (!done) id = setTimeout(() => setDone(true), 350);
    else
      id = setTimeout(() => {
        setDone(false);
        setN(0);
        setP((p + 1) % PROMPTS.length);
      }, 3600);
    return () => clearTimeout(id);
  }, [n, done, text, p]);

  const bpmBase = 84 + (h(text, 0) % 60);

  return (
    <div className="mx-auto w-full max-w-xl">
      <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3.5 shadow-[0_0_60px_-20px_rgba(34,211,238,0.5)]">
        <span aria-hidden className="text-cyan-300">✦</span>
        <span className="min-h-6 flex-1 text-left text-lg text-white" aria-live="off">
          {text.slice(0, n)}
          <span className="ml-0.5 inline-block h-5 w-0.5 translate-y-1 animate-pulse bg-cyan-300" />
        </span>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${done ? "bg-cyan-400 text-[#04141a]" : "bg-white/10 text-[#8aa0ab]"}`}>
          {done ? "Playing" : "Vibe"}
        </span>
      </div>
      <ul className="mt-3 grid grid-cols-4 gap-2" aria-label="Example queue (illustration)">
        {[0, 1, 2, 3].map((i) => (
          <li
            key={`${p}-${i}`}
            className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5 text-left transition-all duration-500"
            style={{ opacity: done ? 1 : 0.18, transform: done ? "none" : "translateY(8px)", transitionDelay: done ? `${i * 110}ms` : "0ms" }}
          >
            <div className="flex h-6 items-end gap-0.5" aria-hidden>
              {Array.from({ length: 9 }, (_, k) => (
                <i key={k} className="flex-1 rounded-sm bg-cyan-300/80" style={{ height: `${20 + (h(text, i * 9 + k) % 80)}%` }} />
              ))}
            </div>
            <div className="mt-1.5 font-[family-name:var(--font-geist-mono)] text-[0.65rem] text-[#8aa0ab]">
              {bpmBase + ((i * 3) % 7)} · {KEYS[(h(text, i) + i) % KEYS.length]}
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[0.7rem] text-[#8aa0ab]">Illustration: tempo and key shown are examples.</p>
    </div>
  );
}
