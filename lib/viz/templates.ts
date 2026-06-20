import { hsl, pitchClassHue } from "@/lib/viz/driver";
import type {
  CanvasTemplate,
  ShaderTemplate,
  VizFrame,
  VizTemplate,
} from "@/lib/viz/types";

/* ------------------------------------------------------------------ *
 * Helpers shared by canvas templates
 * ------------------------------------------------------------------ */

/** Sample the FFT at a 0..1 fraction across the musically useful range. */
function specAt(f: VizFrame, x: number): number {
  const n = Math.min(f.spectrum.length, 720);
  return f.spectrum[Math.min(f.spectrum.length - 1, Math.floor(x * n))] / 255;
}

/** Combined beat "hit" — grid when trusted, live audio when the BPM is shaky.
 * Computed once in the driver (see BeatInfo.hit) so canvas + shader agree. */
function pulse(f: VizFrame): number {
  return f.beat.hit;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Rounded-rect path (no fill/stroke) — used by the stairs blocks. */
function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
}


/* ------------------------------------------------------------------ *
 * Canvas2D templates
 * ------------------------------------------------------------------ */

interface Spark { x: number; y: number; vx: number; vy: number; life: number; hue: number; r: number }
interface Bokeh { x: number; y: number; r: number; s: number; h: number }
interface StairsState {
  /** per hit step: hue, freshness e(1→0), and impact strength imp(~0.5..1.7). */
  lit: Map<number, { hue: number; e: number; imp: number }>;
  ps: Spark[];
  bok: Bokeh[];
  /** last beat/step the ball landed on (to detect a new beat). */
  lastStep: number;
  /** arc height of the current bounce (scaled by hit strength). */
  height: number;
  /** strength of the current bounce's launch. */
  str: number;
  /** decaying flash envelope, kicked on strong hits. */
  punch: number;
  /** decaying peak onset since the last beat → next bounce's strength. */
  onsetPk: number;
}

const TAU = Math.PI * 2;
// deterministic per-index pseudo-randoms → an organic but stable layout
const h1 = (i: number) => { const x = Math.sin(i * 127.1 + 0.7) * 43758.5; return x - Math.floor(x); };
const h2 = (i: number) => { const x = Math.sin(i * 311.7 + 1.3) * 52718.1; return x - Math.floor(x); };
type StepKind = "slab" | "platform" | "pillar" | "wide";
function stepKind(i: number): StepKind {
  const r = h2(i);
  return r < 0.6 ? "slab" : r < 0.8 ? "platform" : r < 0.93 ? "pillar" : "wide";
}
/** Per-step size factors {width, frontHeight, topDepth} — varied so the
 *  staircase looks hand-placed, not stamped from one mould. */
function stepDims(i: number): { wf: number; hf: number; df: number } {
  const t = stepKind(i);
  const j = 0.85 + h1(i) * 0.35;
  const wf = (t === "platform" ? 1.6 : t === "wide" ? 1.35 : t === "pillar" ? 0.74 : 1) * j;
  const hf = t === "pillar" ? 2.4 : t === "platform" ? 0.7 : 1;
  const df = (t === "platform" ? 1.35 : t === "pillar" ? 0.95 : 1) * j;
  return { wf, hf, df };
}

/**
 * Bouncing ball on glowing piano stairs (the "ball drop on piano stairs" genre).
 *
 * The ball is ALWAYS in flight — a continuous gravity bounce, never paused —
 * and BEAT-SYNCED: its bounce phase is the audio beat phase, so it lands on
 * each beat and advances one block per beat (the block it lands on lights up).
 * Onset strength sets how HARD each bounce launches: a strong hit arcs higher,
 * flashes brighter and throws more sparks. The staircase wanders organically
 * and mixes object types (slabs / platforms / pillars) at varied sizes.
 * Detailing: framed edge-lit blocks with sheen + contact shadows, a glossy
 * spinning ball with env-tint, inner glow, fresnel rim and speculars.
 */
const stairs: CanvasTemplate = {
  id: "stairs",
  name: "Piano Stairs",
  blurb: "a glossy ball bounces down glowing blocks, landing one per beat",
  kind: "canvas2d",
  init: (): StairsState => ({ lit: new Map(), ps: [], bok: [], lastStep: -1, height: 1, str: 1, punch: 0, onsetPk: 0 }),
  draw(ctx, f, state) {
    const st = state as StairsState;
    const { w, h, params } = f;
    const FALLOFF = 0.87;
    const hueOf = (i: number) => f.key.hue + i * (params.hueRange / 16) + pitchClassHue(f.chromaRoot) * 0.5;
    // SMOOTH wander for the continuous camera; the per-step random jitter (h1)
    // is added ONLY at integer step indices — evaluating h1 on a continuous
    // value is high-frequency noise and was what made the whole scene shake.
    const pathSmooth = (t: number) => Math.sin(t * 0.4) * 0.55 + Math.sin(t * 0.17 + 1.1) * 0.33;
    const pathStep = (i: number) => pathSmooth(i) + (h1(i) - 0.5) * 0.6;

    // layout (+ gentle camera sway so the frame breathes)
    const cx = w / 2 + Math.sin(f.clock * 0.27) * w * 0.012;
    const horizon = h * 0.14 + Math.sin(f.clock * 0.19) * h * 0.01;
    const baseY = h * 0.6;
    const spread = w * 0.27;
    const follow = 0.5;
    const baseW = Math.min(w, h) * 0.2;
    const frontH = baseW * 0.46;
    const topD = baseW * 0.46;
    const HOP = h * 0.17;
    const sc = (u: number) => Math.min(1.5, Math.pow(FALLOFF, u));
    const scrAt = (i: number, fi: number, camX: number) => {
      const s = sc(i - fi);
      return { x: cx + (pathStep(i) * spread - camX) * s, y: horizon + (baseY - horizon) * s, s };
    };
    const surfAt = (i: number, fi: number, camX: number) => {
      const p = scrAt(i, fi, camX);
      const D = topD * p.s * stepDims(i).df;
      return { x: p.x + (D * 0.62) / 2, y: p.y - (D * 0.62) / 2, s: p.s };
    };

    // CONTINUOUS PHYSICS: octave-fold the tempo into a natural bounce cadence,
    // then keep the ball in an unbroken chain of parabolas — each flight starts
    // exactly where the last landed, so it never rests. Onset strength sampled
    // at each landing sets that bounce's height, distance and flash.
    st.onsetPk = Math.max(st.onsetPk * 0.9, f.onset); // peak onset since last beat

    // BEAT-SYNCED bounce: the bounce phase IS the audio beat phase, so the ball
    // lands EXACTLY on each beat (continuous parabola — never resting). It
    // advances exactly ONE step (one block) per beat. Falls back to a free-run
    // tempo only when there's no trustworthy grid.
    const hasBeat = f.beat.bpm > 0 && f.beat.confidence >= 0.05;
    const beatsTotal = hasBeat
      ? Math.max(0, f.beat.beat + f.beat.beatPhase)
      : Math.max(0, f.clock * (100 / 60));
    const cur = Math.floor(beatsTotal);
    const phase = beatsTotal - cur;
    const fi = beatsTotal;
    const camX = pathSmooth(fi) * spread * follow;
    const scr = (i: number) => scrAt(i, fi, camX);

    // on each new beat: light ONE block and set this bounce's strength/flash
    if (cur !== st.lastStep) {
      const playing = f.level > 0.06;
      const strength = playing
        ? Math.min(1.7, 0.5 + st.onsetPk * 0.85 + f.low * 0.3)
        : 0.6 + 0.6 * h1(cur); // varied idle demo
      st.lastStep = cur;
      st.str = strength;
      st.height = 0.8 + strength * 0.7;
      st.punch = Math.max(st.punch, strength);
      st.lit.set(cur, { hue: hueOf(cur), e: 1, imp: strength });
      const p = surfAt(cur, fi, camX);
      const n = Math.round((7 + f.level * 12) * strength);
      for (let j = 0; j < n; j++) {
        const ang = -Math.PI / 2 + (Math.random() - 0.5) * 2;
        const spd = (1.4 + Math.random() * 4) * (0.5 + strength * 0.7);
        st.ps.push({ x: p.x, y: p.y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd * 1.7, life: 1, hue: hueOf(cur), r: (2 + Math.random() * 2) * p.s });
      }
      st.onsetPk = 0;
    }
    const arc = 4 * phase * (1 - phase) * st.height; // symmetric parabola = gravity
    st.punch *= 0.9;
    // CONTINUOUS top-surface point for a fractional position. We LERP between
    // the two adjacent steps' surfaces (not snap to the rounded step) so the
    // resting height never jumps as the ball crosses a half-step — that snap
    // was the residual jitter.
    const surfFrac = (fp: number) => {
      const i0 = Math.floor(fp);
      const k = fp - i0;
      const a = surfAt(i0, fi, camX);
      const b = surfAt(i0 + 1, fi, camX);
      return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), s: lerp(a.s, b.s, k) };
    };

    // background + vanishing glow + drifting bokeh
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, hsl(f.key.hue + 200, 55, 10));
    bg.addColorStop(0.5, hsl(f.key.hue + 250, 50, 6));
    bg.addColorStop(1, "#020206");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    const sky = ctx.createRadialGradient(cx, horizon + h * 0.05, 0, cx, horizon + h * 0.05, h * 0.55);
    sky.addColorStop(0, hsl(f.key.hue, 65, 32, 0.28 * (0.5 + f.level)));
    sky.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
    if (st.bok.length < 24) st.bok.push({ x: Math.random() * w, y: Math.random() * h, r: 8 + Math.random() * 40, s: 0.1 + Math.random() * 0.3, h: f.key.hue + Math.random() * 60 });
    ctx.globalCompositeOperation = "lighter";
    for (const b of st.bok) {
      b.y -= b.s * (0.4 + f.level);
      if (b.y < -b.r) {
        b.y = h + b.r;
        b.x = Math.random() * w;
      }
      const bg2 = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
      bg2.addColorStop(0, hsl(b.h, 70, 60, 0.06));
      bg2.addColorStop(1, hsl(b.h, 70, 60, 0));
      ctx.fillStyle = bg2;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, TAU);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
    for (const [k, v] of st.lit) {
      v.e *= 0.9; // quick decay → the block the ball is on lights, short tail
      if (v.e < 0.02 && k < cur - 1) st.lit.delete(k);
    }

    // a detailed, framed, edge-lit 3D block — sized/typed per step
    const block = (i: number) => {
      const lit = st.lit.get(i);
      const e = lit ? lit.e : 0;
      const imp = lit ? lit.imp : 0;
      const hue = lit ? lit.hue : f.key.hue + i * (params.hueRange / 16);
      const p = scr(i);
      if (p.s < 0.02 || p.y < horizon - 4) return;
      const d = stepDims(i);
      const W = baseW * p.s * d.wf;
      const H = frontH * p.s * d.hf;
      const D = topD * p.s * d.df;
      const fog = Math.min(1, Math.max(0, (p.s - 0.05) / 0.5));
      const dx = D * 0.62;
      const dy = -D * 0.62;
      const x = p.x;
      const y = p.y;
      const mx = x + dx / 2;
      const my = y + dy / 2;
      const sat = lit ? 86 : 30;
      const L = (b: number) => (lit ? 22 + e * imp * 52 : 11) * b * fog;
      // soft contact shadow under the block
      ctx.fillStyle = `rgba(0,0,0,${0.28 * fog})`;
      ctx.beginPath();
      ctx.ellipse(x, y + H, W * 0.6, H * 0.28, 0, 0, TAU);
      ctx.fill();
      if (e > 0.02) {
        ctx.shadowBlur = e * imp * 46 * params.glow;
        ctx.shadowColor = hsl(hue, 95, 62);
      }
      // right side (darkest)
      ctx.beginPath();
      ctx.moveTo(x + W / 2, y);
      ctx.lineTo(x + W / 2 + dx, y + dy);
      ctx.lineTo(x + W / 2 + dx, y + dy + H);
      ctx.lineTo(x + W / 2, y + H);
      ctx.closePath();
      ctx.fillStyle = hsl(hue, sat, L(0.5));
      ctx.fill();
      // top (lightest)
      ctx.beginPath();
      ctx.moveTo(x - W / 2, y);
      ctx.lineTo(x + W / 2, y);
      ctx.lineTo(x + W / 2 + dx, y + dy);
      ctx.lineTo(x - W / 2 + dx, y + dy);
      ctx.closePath();
      ctx.fillStyle = hsl(hue, sat, L(1.1));
      ctx.fill();
      ctx.shadowBlur = 0;
      // inset top panel — a framed "key" surface
      const ins = 0.7;
      ctx.beginPath();
      ctx.moveTo(lerp(mx, x - W / 2, ins), lerp(my, y, ins));
      ctx.lineTo(lerp(mx, x + W / 2, ins), lerp(my, y, ins));
      ctx.lineTo(lerp(mx, x + W / 2 + dx, ins), lerp(my, y + dy, ins));
      ctx.lineTo(lerp(mx, x - W / 2 + dx, ins), lerp(my, y + dy, ins));
      ctx.closePath();
      ctx.fillStyle = hsl(hue, sat, L(1.5));
      ctx.fill();
      // front face
      ctx.beginPath();
      rrect(ctx, x - W / 2, y, W, H, Math.min(7, W * 0.1));
      const fg = ctx.createLinearGradient(x, y, x, y + H);
      fg.addColorStop(0, hsl(hue, sat, L(0.95)));
      fg.addColorStop(0.7, hsl(hue, sat, L(0.62)));
      fg.addColorStop(1, hsl(hue, sat, L(0.4)));
      ctx.fillStyle = fg;
      ctx.fill();
      // glossy sheen down the front
      ctx.save();
      ctx.beginPath();
      rrect(ctx, x - W / 2, y, W, H, Math.min(7, W * 0.1));
      ctx.clip();
      const sh = ctx.createLinearGradient(x - W / 2, 0, x - W / 2 + W * 0.5, 0);
      sh.addColorStop(0, `rgba(255,255,255,${0.06 + e * 0.1})`);
      sh.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = sh;
      ctx.fillRect(x - W / 2, y, W * 0.5, H);
      ctx.restore();
      // edge-light the top perimeter (neon, brighter when lit)
      ctx.beginPath();
      ctx.moveTo(x - W / 2, y);
      ctx.lineTo(x + W / 2, y);
      ctx.lineTo(x + W / 2 + dx, y + dy);
      ctx.lineTo(x - W / 2 + dx, y + dy);
      ctx.closePath();
      if (e > 0.05) {
        ctx.shadowBlur = e * 22 * params.glow;
        ctx.shadowColor = hsl(hue, 95, 65);
      }
      ctx.lineWidth = Math.max(0.6, p.s * (lit ? 2 : 1.2));
      ctx.strokeStyle = hsl(hue, 90, lit ? 66 + e * 26 : 30, (lit ? 0.95 : 0.55) * fog);
      ctx.stroke();
      ctx.shadowBlur = 0;
      // impact ring on the top face
      if (e > 0.12) {
        const rad = (1 - e) * W * 1.2 + W * 0.3;
        ctx.beginPath();
        ctx.ellipse(mx, my, rad, rad * 0.5, 0, 0, TAU);
        ctx.strokeStyle = hsl(hue, 95, 72, e * 0.7);
        ctx.lineWidth = e * 3 * p.s;
        ctx.stroke();
      }
    };
    for (let i = cur + 26; i >= cur + 1; i--) block(i); // far → near
    for (let i = cur; i >= cur - 2; i--) block(i);

    // detailed glossy, spinning, env-tinted ball
    const ball = (x: number, y: number, r: number, hue: number, a: number, alpha: number, spin: number) => {
      const sq = Math.min(1, Math.max(0, 1 - a * 2.2)); // squash near contact
      const ry = r * (1 - sq * 0.28);
      const rx = r * (1 + sq * 0.22);
      const envHue = hue + 40;
      ctx.globalAlpha = alpha;
      const halo = ctx.createRadialGradient(x, y, 0, x, y, r * 3.6);
      halo.addColorStop(0, hsl(hue, 95, 66, 0.5));
      halo.addColorStop(1, hsl(hue, 95, 60, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(x, y, r * 3.6, 0, TAU);
      ctx.fill();
      const g = ctx.createRadialGradient(x - rx * 0.35, y - ry * 0.45, r * 0.1, x, y, r * 1.18);
      g.addColorStop(0, hsl(hue, 90, 88));
      g.addColorStop(0.45, hsl(hue, 92, 62));
      g.addColorStop(0.8, hsl(lerp(hue, envHue, 0.4), 85, 46));
      g.addColorStop(1, hsl(envHue, 80, 32));
      ctx.shadowBlur = r * 1.3;
      ctx.shadowColor = hsl(hue, 95, 60);
      ctx.beginPath();
      ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.shadowBlur = 0;
      // spinning stripes (sense of roll) + inner core, clipped to the ball
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
      ctx.clip();
      for (let k = 0; k < 3; k++) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(spin + k * 2.094);
        ctx.beginPath();
        ctx.ellipse(0, 0, rx * 1.25, ry * 0.16, 0, 0, TAU);
        ctx.fillStyle = hsl(hue, 80, 30, 0.16);
        ctx.fill();
        ctx.restore();
      }
      const core = ctx.createRadialGradient(x, y, 0, x, y, r * 0.7);
      core.addColorStop(0, hsl(hue, 90, 92, 0.5));
      core.addColorStop(1, hsl(hue, 90, 80, 0));
      ctx.fillStyle = core;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      ctx.restore();
      // fresnel rim + twin speculars
      ctx.beginPath();
      ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
      ctx.lineWidth = Math.max(1, r * 0.09);
      ctx.strokeStyle = hsl(hue, 75, 82, 0.55);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(x - rx * 0.34, y - ry * 0.42, rx * 0.28, ry * 0.2, -0.5, 0, TAU);
      ctx.fillStyle = `rgba(255,255,255,${0.9 * alpha})`;
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(x + rx * 0.3, y + ry * 0.28, rx * 0.12, ry * 0.09, -0.5, 0, TAU);
      ctx.fillStyle = `rgba(255,255,255,${0.4 * alpha})`;
      ctx.fill();
      ctx.globalAlpha = 1;
    };
    const ballAt = (s: { x: number; y: number; s: number }, r: number, hue: number, a: number, alpha: number, spin: number) => {
      ctx.beginPath();
      ctx.ellipse(s.x, s.y, r * (0.55 + (1 - a) * 0.5), r * 0.3, 0, 0, TAU);
      ctx.fillStyle = `rgba(0,0,0,${0.55 * (1 - a * 0.6)})`;
      ctx.fill();
      ball(s.x, s.y - r * 0.75 - HOP * a, r, hue, a, alpha, spin);
    };

    // the ball — rides the continuous position so it never jumps/jitters
    const spin = fi * 2.4;
    const s0 = surfFrac(fi);
    const r = baseW * 0.27 * s0.s;
    ballAt(s0, r, hueOf(cur), arc, 1, spin);

    // impact sparks (additive)
    ctx.globalCompositeOperation = "lighter";
    for (let i = st.ps.length - 1; i >= 0; i--) {
      const p = st.ps[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.3;
      p.life -= 0.024;
      if (p.life <= 0) {
        st.ps.splice(i, 1);
        continue;
      }
      ctx.fillStyle = hsl(p.hue, 95, 68, p.life);
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1, p.r * p.life), 0, TAU);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";

    // big-hit flash
    if (st.punch > 0.5) {
      ctx.fillStyle = `rgba(255,255,255,${(st.punch - 0.5) * 0.09})`;
      ctx.fillRect(0, 0, w, h);
    }
    // vignette
    const vg = ctx.createRadialGradient(cx, h * 0.5, h * 0.22, cx, h * 0.5, h * 0.9);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,0.5)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
  },
};

/** Beads threaded on undulating strings — the "beads with tune" look. */
const beads: CanvasTemplate = {
  id: "beads",
  name: "Beads on a String",
  blurb: "beads ride wavy strings, bouncing and recoloring to the groove",
  kind: "canvas2d",
  draw(ctx, f) {
    const { w, h, params } = f;
    const STRINGS = 7;
    const BEADS = 22;
    const hit = pulse(f);
    for (let s = 0; s < STRINGS; s++) {
      const y0 = ((s + 1) / (STRINGS + 1)) * h;
      const band = specAt(f, 0.05 + (s / STRINGS) * 0.8);
      const amp = (0.04 + band * 0.22 + f.low * 0.06) * h;
      const k = 2 + s * 0.7;
      const phase = f.t * (0.6 + params.speed * 0.8) + s * 0.9;
      // the string itself
      ctx.beginPath();
      for (let x = 0; x <= w; x += 8) {
        const y = y0 + Math.sin((x / w) * Math.PI * k + phase) * amp;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      const sHue = f.key.hue + (s / STRINGS) * params.hueRange;
      ctx.strokeStyle = hsl(sHue, 70, 22 + band * 25, 0.5);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // beads
      for (let b = 0; b < BEADS; b++) {
        const bx = ((b + 0.5) / BEADS) * w;
        const by = y0 + Math.sin((bx / w) * Math.PI * k + phase) * amp;
        const pc = (b + s) % 12;
        const r = (3 + f.chroma[pc] * 8 + hit * 7 * params.intensity) * (0.8 + band);
        const hue = sHue * 0.4 + pitchClassHue(pc) * 0.6;
        if (params.glow > 0.2) {
          ctx.shadowBlur = 14 * params.glow;
          ctx.shadowColor = hsl(hue, 90, 60, 0.9);
        }
        ctx.beginPath();
        ctx.arc(bx, by, Math.max(1, r), 0, Math.PI * 2);
        ctx.fillStyle = hsl(hue, 85, 58 + hit * 15);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    }
  },
};

/** Windows-Media-Player nebula: zoom/rotate feedback with blooming petals. */
const nebula: CanvasTemplate = {
  id: "nebula",
  name: "Nebula (WMP feedback)",
  blurb: "the old-school trippy fractal — feedback zoom blooms on the beat",
  kind: "canvas2d",
  clearEachFrame: false,
  draw(ctx, f) {
    const { w, h, params } = f;
    const cx = w / 2;
    const cy = h / 2;
    const hit = pulse(f);
    // feedback: redraw the previous frame scaled + rotated, slightly faded
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.translate(cx, cy);
    ctx.rotate(0.004 + hit * 0.03 * params.intensity);
    const z = 1.012 + f.low * 0.03 * params.intensity;
    ctx.scale(z, z);
    ctx.translate(-cx, -cy);
    ctx.drawImage(ctx.canvas, 0, 0, w, h);
    ctx.restore();
    ctx.fillStyle = "rgba(0,0,0,0.06)";
    ctx.fillRect(0, 0, w, h);
    // bloom new petals
    const petals = 6;
    const rad = (0.08 + f.mid * 0.28 + hit * 0.12) * Math.min(w, h);
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < petals; i++) {
      const a = f.t * (0.5 + params.speed) + (i / petals) * Math.PI * 2;
      const x = cx + Math.cos(a) * rad;
      const y = cy + Math.sin(a) * rad;
      const hue = f.key.hue + (i / petals) * params.hueRange + f.t * 20;
      const r = 18 + f.high * 60 + hit * 30;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, hsl(hue, 90, 65, 0.55));
      g.addColorStop(1, hsl(hue, 90, 50, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  },
};

/** Radial spectrum — like the RGB lights on a keyboard, around a ring. */
const radial: CanvasTemplate = {
  id: "radial",
  name: "Radial Spectrum",
  blurb: "frequency bars fan out from the center, each its own color",
  kind: "canvas2d",
  draw(ctx, f) {
    const { w, h, params } = f;
    const cx = w / 2;
    const cy = h / 2;
    const bars = 96;
    const inner = Math.min(w, h) * (0.12 + f.low * 0.06);
    const maxLen = Math.min(w, h) * 0.32;
    const hit = pulse(f);
    ctx.lineWidth = (Math.PI * 2 * inner) / bars * 0.7;
    ctx.lineCap = "round";
    for (let i = 0; i < bars; i++) {
      const frac = i / bars;
      const mag = specAt(f, Math.pow(frac, 1.4));
      const len = inner + mag * maxLen * (1 + hit * params.intensity);
      const a = frac * Math.PI * 2 - Math.PI / 2;
      const x1 = cx + Math.cos(a) * inner;
      const y1 = cy + Math.sin(a) * inner;
      const x2 = cx + Math.cos(a) * len;
      const y2 = cy + Math.sin(a) * len;
      const hue = f.key.hue + frac * params.hueRange;
      if (params.glow > 0.2) {
        ctx.shadowBlur = 12 * params.glow;
        ctx.shadowColor = hsl(hue, 90, 60);
      }
      ctx.strokeStyle = hsl(hue, 85, 45 + mag * 30);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    // pulsing core
    ctx.beginPath();
    ctx.arc(cx, cy, inner * (0.7 + hit * 0.4), 0, Math.PI * 2);
    ctx.fillStyle = hsl(f.key.hue, 80, 55 + hit * 20, 0.9);
    ctx.fill();
  },
};

/** Glowing oscilloscope / Lissajous from the raw waveform. */
const scope: CanvasTemplate = {
  id: "scope",
  name: "Oscilloscope",
  blurb: "the raw waveform as a neon trace, twisting into Lissajous curves",
  kind: "canvas2d",
  draw(ctx, f) {
    const { w, h, params } = f;
    const wave = f.waveform;
    const cy = h / 2;
    const hue = f.key.hue + f.high * params.hueRange;
    ctx.shadowBlur = 16 * params.glow;
    ctx.shadowColor = hsl(hue, 90, 60);
    ctx.strokeStyle = hsl(hue, 90, 62);
    ctx.lineWidth = 2 + pulse(f) * 3;
    ctx.beginPath();
    for (let i = 0; i < wave.length; i += 2) {
      const x = (i / wave.length) * w;
      const y = cy + ((wave[i] - 128) / 128) * (h * 0.34) * (1 + f.level);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // Lissajous overlay when there's treble energy
    if (f.high > 0.15) {
      ctx.globalAlpha = 0.5 + f.high * 0.5;
      ctx.beginPath();
      const n = 256;
      const rot = f.t * params.speed;
      for (let i = 0; i < n; i++) {
        const t = (i / n) * Math.PI * 2;
        const amp = Math.min(w, h) * 0.22 * (0.5 + f.mid);
        const x = w / 2 + Math.cos(t * 3 + rot) * amp;
        const y = cy + Math.sin(t * 2) * amp;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.shadowBlur = 0;
  },
};

interface Particle {
  x: number; y: number; vx: number; vy: number; life: number; hue: number;
}

/** Kick-triggered particle bursts that drift and fade. */
const particles: CanvasTemplate = {
  id: "particles",
  name: "Particle Bursts",
  blurb: "every kick fires a burst of sparks, colored by the chord",
  kind: "canvas2d",
  clearEachFrame: false,
  init: () => ({ ps: [] as Particle[], lastBeat: -1 }),
  draw(ctx, f, state) {
    const s = state as { ps: Particle[]; lastBeat: number };
    const { w, h, params } = f;
    // fade trails
    ctx.fillStyle = `rgba(6,6,12,${0.12 + (1 - params.glow) * 0.2})`;
    ctx.fillRect(0, 0, w, h);
    // spawn on a transient or a fresh beat
    const fire = f.onset > 0.4 || (f.beat.beatHit && f.beat.confidence > 0.2);
    if (fire) {
      const count = Math.round(18 + f.level * 60 * params.intensity);
      const baseHue = f.key.hue + pitchClassHue(f.chromaRoot) * 0.5;
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = (1 + Math.random() * 5) * (1 + f.level * 2);
        s.ps.push({
          x: w / 2, y: h / 2,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          life: 1, hue: baseHue + (Math.random() - 0.5) * params.hueRange,
        });
      }
    }
    if (s.ps.length > 1200) s.ps.splice(0, s.ps.length - 1200);
    ctx.globalCompositeOperation = "lighter";
    for (let i = s.ps.length - 1; i >= 0; i--) {
      const p = s.ps[i];
      p.x += p.vx; p.y += p.vy;
      p.vx *= 0.97; p.vy *= 0.97;
      p.life -= 0.014;
      if (p.life <= 0) { s.ps.splice(i, 1); continue; }
      const r = 2 + p.life * 3;
      ctx.fillStyle = hsl(p.hue, 90, 60, p.life);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  },
};

interface Star { x: number; y: number; z: number; }

/** Starfield warp that surges on the beat. */
const starfield: CanvasTemplate = {
  id: "starfield",
  name: "Starfield Warp",
  blurb: "fly through stars; the beat kicks the warp drive",
  kind: "canvas2d",
  clearEachFrame: false,
  init: () => ({ stars: [] as Star[] }),
  draw(ctx, f, state) {
    const s = state as { stars: Star[] };
    const { w, h, params } = f;
    const cx = w / 2;
    const cy = h / 2;
    if (s.stars.length === 0) {
      for (let i = 0; i < 600; i++) {
        s.stars.push({ x: (Math.random() - 0.5) * w, y: (Math.random() - 0.5) * h, z: Math.random() * w });
      }
    }
    ctx.fillStyle = "rgba(0,0,3,0.35)";
    ctx.fillRect(0, 0, w, h);
    const speed = (2 + f.level * 14 + pulse(f) * 22) * params.speed * params.intensity;
    for (const st of s.stars) {
      const pz = st.z;
      st.z -= speed;
      if (st.z < 1) { st.z = w; st.x = (Math.random() - 0.5) * w; st.y = (Math.random() - 0.5) * h; continue; }
      const sx = cx + (st.x / st.z) * w;
      const sy = cy + (st.y / st.z) * w;
      const px = cx + (st.x / pz) * w;
      const py = cy + (st.y / pz) * w;
      const b = Math.min(1, (w - st.z) / w);
      const hue = f.key.hue + b * params.hueRange;
      ctx.strokeStyle = hsl(hue, 60 + b * 30, 50 + b * 45, b);
      ctx.lineWidth = b * 2.2;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(sx, sy);
      ctx.stroke();
    }
  },
};

/** Synthwave: neon perspective grid + a key-colored sun. */
const synthwave: CanvasTemplate = {
  id: "synthwave",
  name: "Synthwave Grid",
  blurb: "retro neon horizon — grid scrolls with the bass, sun glows by key",
  kind: "canvas2d",
  draw(ctx, f) {
    const { w, h, params } = f;
    const horizon = h * 0.45;
    const hit = pulse(f);
    // sky gradient
    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, hsl(f.key.hue + 200, 60, 6));
    sky.addColorStop(1, hsl(f.key.hue + 280, 70, 14));
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, horizon);
    ctx.fillStyle = "#05030a";
    ctx.fillRect(0, horizon, w, h - horizon);
    // sun with scanline gaps
    const sunR = Math.min(w, h) * (0.16 + f.mid * 0.05 + hit * 0.03);
    const cx = w / 2;
    const sunG = ctx.createLinearGradient(0, horizon - sunR, 0, horizon + sunR);
    sunG.addColorStop(0, hsl(f.key.hue + 40, 95, 65));
    sunG.addColorStop(1, hsl(f.key.hue, 95, 50));
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, horizon, sunR, Math.PI, 0);
    ctx.arc(cx, horizon, sunR, 0, Math.PI);
    ctx.clip();
    ctx.fillStyle = sunG;
    ctx.fillRect(cx - sunR, horizon - sunR, sunR * 2, sunR * 2);
    ctx.fillStyle = "#05030a";
    for (let i = 0; i < 8; i++) {
      const gy = horizon - sunR * 0.1 + i * (sunR * 0.16);
      ctx.fillRect(cx - sunR, gy, sunR * 2, Math.max(1.5, sunR * 0.05 * (1 + i * 0.3)));
    }
    ctx.restore();
    // perspective grid
    const gridHue = f.key.hue + 160;
    ctx.strokeStyle = hsl(gridHue, 90, 55 + hit * 20, 0.7);
    ctx.lineWidth = 1.2;
    const scroll = (f.t * (0.5 + params.speed) + f.low) % 1;
    for (let i = 0; i < 16; i++) {
      const t = (i + scroll) / 16;
      const y = horizon + t * t * (h - horizon);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    for (let i = -10; i <= 10; i++) {
      ctx.beginPath();
      ctx.moveTo(cx + i * (w * 0.04), horizon);
      ctx.lineTo(cx + i * (w * 0.5), h);
      ctx.stroke();
    }
  },
};

/* ------------------------------------------------------------------ *
 * Shader templates (GLSL ES 1.00 — define mainImage; see SHADER_PRELUDE)
 * ------------------------------------------------------------------ */

const plasma: ShaderTemplate = {
  id: "plasma",
  name: "Plasma Warp",
  blurb: "domain-warped plasma that boils harder as the track gets louder",
  kind: "shader",
  fragment: `
void mainImage(out vec4 o, in vec2 fc){
  vec2 uv = (fc - 0.5*iResolution.xy)/iResolution.y;
  float t = iTime*0.4;
  vec2 p = uv*2.0;
  float warp = 0.5 + iLevel*1.6*iIntensity;
  for(int i=0;i<5;i++){
    p += warp*0.38*vec2(sin(p.y*1.5+t+iLow*3.0), cos(p.x*1.5-t+iMid*3.0));
  }
  float v = 0.5+0.5*sin(p.x+p.y+t*2.0);
  float hue = fract(iHue + v*0.25 + iBar*0.1);
  vec3 col = hsv2rgb(vec3(hue, 0.85, 0.35+0.65*v));
  col = mix(col, iKeyColor, 0.25);
  col += iBeatPulse*0.4*iKeyColor;
  o = vec4(col, 1.0);
}`,
};

const tunnel: ShaderTemplate = {
  id: "tunnel",
  name: "Kaleido Tunnel",
  blurb: "fly down a kaleidoscopic tunnel carved out of the spectrum",
  kind: "shader",
  fragment: `
void mainImage(out vec4 o, in vec2 fc){
  vec2 uv = (fc - 0.5*iResolution.xy)/iResolution.y;
  float r = length(uv);
  float a = atan(uv.y, uv.x);
  float seg = 6.0;
  a = abs(mod(a, 6.2831/seg) - 3.1415/seg);
  float depth = 0.3/(r+0.05) + iTime*(0.5+iLow*1.5);
  float spec = fft(fract(depth*0.25));
  float rings = 0.5+0.5*sin(depth*6.2831 + a*4.0);
  float v = rings*(0.35+spec*1.6*iIntensity);
  float hue = fract(iHue + depth*0.05 + a*0.12);
  vec3 col = hsv2rgb(vec3(hue, 0.85, v));
  col = mix(col, iKeyColor*v, 0.3);
  col *= smoothstep(1.15, 0.15, r);
  col += iBeatPulse*0.3;
  o = vec4(col, 1.0);
}`,
};

const aurora: ShaderTemplate = {
  id: "aurora",
  name: "Aurora Ribbons",
  blurb: "flowing ribbons of light that bend with the melody",
  kind: "shader",
  fragment: `
void mainImage(out vec4 o, in vec2 fc){
  vec2 uv = fc/iResolution.xy;
  vec3 col = vec3(0.0);
  float t = iTime*0.3;
  for(int i=0;i<5;i++){
    float fi = float(i);
    float band = fft(uv.x*0.5 + fi*0.08);
    float y = 0.5 + 0.16*sin(uv.x*3.0 + t + fi*1.7) + (band-0.3)*0.45*iIntensity;
    float d = abs(uv.y - y);
    float glow = 0.018/(d+0.02);
    float hue = fract(iHue + fi*0.07 + uv.x*0.12);
    col += hsv2rgb(vec3(hue, 0.7, 1.0))*glow*(0.25+iMid);
  }
  col = mix(col, col + iKeyColor*iBeatPulse*0.6, 0.5);
  col *= 0.55 + 0.45*iLevel;
  o = vec4(col, 1.0);
}`,
};

/* ------------------------------------------------------------------ *
 * Registry + user-custom templates (localStorage)
 * ------------------------------------------------------------------ */

export const CANVAS_TEMPLATES: CanvasTemplate[] = [
  stairs, beads, nebula, radial, scope, particles, starfield, synthwave,
];
export const SHADER_TEMPLATES: ShaderTemplate[] = [plasma, tunnel, aurora];
export const BUILTIN_TEMPLATES: VizTemplate[] = [...CANVAS_TEMPLATES, ...SHADER_TEMPLATES];

const CUSTOM_KEY = "aidj.viz.custom";

interface StoredTemplate {
  id: string;
  name: string;
  blurb?: string;
  kind: "canvas2d" | "shader";
  /** Canvas: the draw-function body. */
  source?: string;
  /** Shader: the GLSL mainImage body. */
  fragment?: string;
}

/**
 * Compile a user canvas-template body into a draw function. The body runs with
 * (ctx, f, state, helpers) in scope. This executes user-authored JS — fine for
 * a local experimentation lab; templates are only ever loaded from this
 * device's localStorage, never from the network.
 */
function compileCanvasSource(source: string): CanvasTemplate["draw"] {
  const fn = new Function("ctx", "f", "state", "helpers", source) as (
    ctx: CanvasRenderingContext2D,
    f: VizFrame,
    state: unknown,
    helpers: { hsl: typeof hsl; pitchClassHue: typeof pitchClassHue; specAt: typeof specAt; pulse: typeof pulse }
  ) => void;
  return (ctx, f, state) => fn(ctx, f, state, { hsl, pitchClassHue, specAt, pulse });
}

function storedToTemplate(s: StoredTemplate): VizTemplate {
  if (s.kind === "shader") {
    return { id: s.id, name: s.name, blurb: s.blurb ?? "custom shader", kind: "shader", fragment: s.fragment ?? "", custom: true };
  }
  return {
    id: s.id,
    name: s.name,
    blurb: s.blurb ?? "custom canvas template",
    kind: "canvas2d",
    custom: true,
    source: s.source,
    clearEachFrame: true,
    init: () => ({}),
    draw: compileCanvasSource(s.source ?? ""),
  };
}

export function loadCustomStored(): StoredTemplate[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_KEY) || "[]") as StoredTemplate[];
  } catch {
    return [];
  }
}

export function loadCustomTemplates(): VizTemplate[] {
  return loadCustomStored().map((s) => {
    try {
      return storedToTemplate(s);
    } catch {
      return null;
    }
  }).filter((t): t is VizTemplate => !!t);
}

export function saveCustomTemplate(s: StoredTemplate) {
  if (typeof window === "undefined") return;
  const all = loadCustomStored().filter((t) => t.id !== s.id);
  all.push(s);
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(all));
}

export function deleteCustomTemplate(id: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(loadCustomStored().filter((t) => t.id !== id)));
}

/** All templates: built-ins plus any the user has saved on this device. */
export function allTemplates(): VizTemplate[] {
  return [...BUILTIN_TEMPLATES, ...loadCustomTemplates()];
}

export function getTemplate(id: string): VizTemplate | undefined {
  return allTemplates().find((t) => t.id === id);
}
