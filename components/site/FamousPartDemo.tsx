"use client";

import { useEffect, useRef, useState } from "react";

const N = 72;
const HOOK = [26, 40]; // bars that make up the hook
const SECTIONS = [
  { label: "Intro", from: 0, to: 9 },
  { label: "Verse", from: 9, to: 25 },
  { label: "Chorus", from: 25, to: 41 },
  { label: "Verse", from: 41, to: 56 },
  { label: "Chorus", from: 56, to: 72 },
];

function hh(i: number) {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  const r = x - Math.floor(x);
  const inChorus = (i >= 25 && i < 41) || i >= 56;
  const base = i < 9 ? 0.25 : inChorus ? 0.78 : 0.5;
  return Math.round((base * (0.65 + 0.35 * r)) * 100);
}

/** A song laid out as bars; scrolling it into view lights up the part Everplay plays. */
export function FamousPartDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [lit, setLit] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      setInView(true);
      setTimeout(() => setLit(true), 1100);
    }, { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className="rounded-3xl border border-white/10 bg-white/[0.03] p-5 sm:p-8">
      <div className="mb-4 flex items-center justify-between text-xs text-[#8aa0ab]">
        <span className="font-[family-name:var(--font-geist-mono)] uppercase tracking-widest">One song, 3:40</span>
        <span className={`ep-chip transition-all duration-500 ${lit ? "!border-cyan-400/60 !text-cyan-200" : "opacity-40"}`}>
          ▶ Everplay plays this part
        </span>
      </div>
      <div className={`ep-wave ${inView ? "is-in" : ""} ${lit ? "lit" : ""}`} aria-hidden>
        {Array.from({ length: N }, (_, i) => (
          <i
            key={i}
            className={i >= HOOK[0] && i < HOOK[1] ? "hook" : ""}
            style={{ ["--h" as string]: `${hh(i)}%`, ["--i" as string]: i }}
          />
        ))}
      </div>
      <div className="relative mt-3 flex text-[0.7rem] text-[#8aa0ab]" aria-hidden>
        {SECTIONS.map((s) => (
          <span key={s.from} className="border-l border-white/10 pl-1.5" style={{ width: `${((s.to - s.from) / N) * 100}%` }}>
            {s.label}
          </span>
        ))}
      </div>
      <p className="sr-only">
        A song waveform with intro, verses and choruses. Everplay plays the first chorus, the section that is both loud and repeated.
      </p>
    </div>
  );
}
