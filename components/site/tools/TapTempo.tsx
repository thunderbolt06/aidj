"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const NAMES: [number, string][] = [[60, "Largo"], [76, "Adagio"], [108, "Andante"], [120, "Moderato"], [156, "Allegro"], [176, "Vivace"], [999, "Presto"]];

export function TapTempo() {
  const taps = useRef<number[]>([]);
  const [bpm, setBpm] = useState<number | null>(null);
  const [count, setCount] = useState(0);
  const pad = useRef<HTMLButtonElement>(null);

  const tap = useCallback(() => {
    const now = performance.now();
    const t = taps.current;
    if (t.length && now - t[t.length - 1] > 2500) t.length = 0; // lost the beat: start over
    t.push(now);
    if (t.length > 12) t.shift();
    setCount(t.length);
    // restart the ring animation without remounting the button (that would drop focus)
    const el = pad.current;
    if (el) {
      el.classList.remove("ep-pulse");
      void el.offsetWidth;
      el.classList.add("ep-pulse");
    }
    if (t.length >= 2) {
      const gaps = t.slice(1).map((x, i) => x - t[i]);
      setBpm(60000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length));
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, button, a") || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (e.key === " ") e.preventDefault();
      tap();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tap]);

  const reset = () => {
    taps.current = [];
    setBpm(null);
    setCount(0);
  };
  const name = bpm ? NAMES.find(([max]) => bpm < max)?.[1] : null;

  return (
    <div className="grid gap-6 sm:grid-cols-[1fr_1.1fr]">
      <button
        ref={pad}
        onClick={tap}
        aria-label="Tap to the beat"
        className={`grid aspect-square w-full max-w-sm place-items-center justify-self-center rounded-full border-2 border-cyan-400/60 bg-cyan-400/10 text-2xl font-bold text-cyan-100 transition-transform active:scale-95`}
      >
        TAP
      </button>
      <div className="flex flex-col justify-center">
        <div className="ep-eyebrow">Tempo</div>
        <div className="ep-big text-7xl sm:text-8xl" aria-live="polite">{bpm ? bpm.toFixed(1) : "--"}</div>
        <div className="mt-1 text-[#8aa0ab]">BPM{name ? ` · ${name}` : ""}</div>
        <dl className="mt-6 grid grid-cols-3 gap-3 text-center">
          {[["Half-time", bpm ? bpm / 2 : null], ["Rounded", bpm ? Math.round(bpm) : null], ["Double-time", bpm ? bpm * 2 : null]].map(([k, v]) => (
            <div key={k as string} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <dt className="text-xs text-[#8aa0ab]">{k}</dt>
              <dd className="ep-big mt-1 text-xl">{v ? (v as number).toFixed(k === "Rounded" ? 0 : 1) : "--"}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-5 flex items-center gap-3">
          <button onClick={reset} className="ep-btn ep-btn-ghost !min-h-10 !px-4 !text-sm">Reset</button>
          <span className="text-sm text-[#8aa0ab]">{count} {count === 1 ? "tap" : "taps"} · keyboard works too</span>
        </div>
      </div>
    </div>
  );
}
