"use client";

import { useEffect, useRef, useState } from "react";

const TRICKS = ["Bass swap", "Filter sweep", "Echo out", "Vocal handoff", "Loop roll", "Double drop"];
const CYCLE = 9; // seconds per transition
const BPM = 124;
const A = "34,211,238";
const B = "255,180,84";

function hash(i: number, seed: number) {
  const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
}
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The hero's two decks: scrolling waveforms for song A and song B, a crossfader
 * that moves through a transition every few seconds, and a label naming the move.
 * Purely illustrative - it does not play audio. Pauses off-screen and under
 * prefers-reduced-motion.
 */
export function HeroDeck() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const knob = useRef<HTMLDivElement>(null);
  const aVol = useRef<HTMLSpanElement>(null);
  const bVol = useRef<HTMLSpanElement>(null);
  const [trick, setTrick] = useState(0);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0;
    let h = 0;
    let raf = 0;
    let visible = true;
    let lastTrick = 0;
    const start = performance.now();

    const resize = () => {
      const r = cv.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = r.width;
      h = r.height;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const row = (cy: number, rowH: number, seed: number, color: string, alpha: number, t: number, density: number) => {
      const bw = 5;
      const gap = 3;
      const step = bw + gap;
      const n = Math.ceil(w / step) + 2;
      const speed = 7; // bars per second
      const off = t * speed;
      const base = Math.floor(off);
      const frac = off - base;
      const playX = w * 0.36;
      const beat = (t * BPM) / 60;
      const pulse = Math.pow(1 - (beat - Math.floor(beat)), 3);
      for (let i = 0; i < n; i++) {
        const idx = base + i;
        const x = i * step - frac * step;
        const env = 0.35 + 0.65 * Math.abs(Math.sin(idx * 0.05 + seed));
        const amp = (0.18 + 0.82 * hash(idx, seed)) * env * density;
        const near = Math.exp(-Math.pow((x - playX) / 90, 2));
        const hh = Math.max(3, amp * rowH * (1 + 0.28 * pulse * near));
        const played = x < playX;
        ctx.fillStyle = `rgba(${color},${(played ? 0.32 : 0.95) * alpha})`;
        ctx.beginPath();
        ctx.roundRect(x, cy - hh / 2, bw, hh, 2);
        ctx.fill();
      }
      // playhead
      ctx.fillStyle = `rgba(232,244,248,${0.7 * alpha})`;
      ctx.fillRect(playX - 1, cy - rowH / 2 - 6, 2, rowH + 12);
    };

    const frame = (now: number) => {
      const t = reduce ? 3.2 : (now - start) / 1000;
      const cycle = Math.floor(t / CYCLE);
      const p = (t % CYCLE) / CYCLE;
      const c = smooth(0.34, 0.66, p);
      const ti = cycle % TRICKS.length;
      if (ti !== lastTrick) {
        lastTrick = ti;
        setTrick(ti);
      }
      ctx.clearRect(0, 0, w, h);
      const rowH = Math.min(86, h * 0.34);
      row(h * 0.27, rowH, 1.3, A, 1 - 0.65 * c, t, 1);
      row(h * 0.73, rowH, 4.1, B, 0.35 + 0.65 * c, t + 20, 1);
      if (knob.current) knob.current.style.transform = `translateX(${c * 100}%)`;
      if (aVol.current) aVol.current.textContent = `${Math.round((1 - c) * 100)}`;
      if (bVol.current) bVol.current.textContent = `${Math.round(c * 100)}`;
      if (!reduce && visible && !document.hidden) raf = requestAnimationFrame(frame);
      else raf = 0;
    };

    const kick = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(cv);
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible) kick();
    });
    io.observe(cv);
    const onVis = () => !document.hidden && kick();
    document.addEventListener("visibilitychange", onVis);
    kick();
    if (reduce) frame(start);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return (
    <div className="ep-glow" role="img" aria-label="Animated illustration of two decks crossfading during a DJ transition">
      <div className="ep-glow-in p-4 sm:p-6">
        <div className="mb-3 flex items-center justify-between font-[family-name:var(--font-geist-mono)] text-[0.7rem] uppercase tracking-widest">
          <span className="text-cyan-300">Deck A · {BPM}<span className="hidden sm:inline"> BPM · 8A</span></span>
          <span className="text-[#ffb454]">Deck B · {BPM + 2}<span className="hidden sm:inline"> BPM · 9A</span></span>
        </div>
        <canvas ref={canvas} className="block h-56 w-full sm:h-64" aria-hidden />
        <div className="mt-4 flex items-center gap-4">
          <span className="w-8 text-right font-[family-name:var(--font-geist-mono)] text-xs text-cyan-300">
            <span ref={aVol}>100</span>
          </span>
          <div className="relative h-2 flex-1 rounded-full bg-white/10">
            <div className="absolute inset-y-0 left-0 right-4">
              <div ref={knob} className="absolute -top-2 h-6 w-4 rounded-md bg-white shadow-[0_0_18px_rgba(255,255,255,0.7)]" />
            </div>
          </div>
          <span className="w-8 font-[family-name:var(--font-geist-mono)] text-xs text-[#ffb454]">
            <span ref={bVol}>0</span>
          </span>
        </div>
        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="ep-eyebrow !text-[#8aa0ab]">Next move</span>
          <span key={trick} className="ep-chip !border-cyan-400/40 !text-cyan-200" style={{ animation: "rise-in .5s ease both" }}>
            <span className="ep-eq text-cyan-300" aria-hidden>
              <i style={{ ["--d" as string]: "0s" }} /><i style={{ ["--d" as string]: ".2s" }} /><i style={{ ["--d" as string]: ".4s" }} />
            </span>
            {TRICKS[trick]}
          </span>
        </div>
      </div>
    </div>
  );
}
