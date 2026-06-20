"use client";

import { useEffect, useRef, useState } from "react";
import type { TrackAnalysis } from "@/lib/types";
import { getEngine } from "@/lib/client/dj";
import { VizDriver } from "@/lib/viz/driver";
import { ShaderRenderer } from "@/lib/viz/shader";
import {
  allTemplates,
  deleteCustomTemplate,
  getTemplate,
  saveCustomTemplate,
} from "@/lib/viz/templates";
import { DEFAULT_PARAMS, type VizParams, type VizTemplate } from "@/lib/viz/types";

interface Props {
  analysis: TrackAnalysis | null;
  track: { title: string; artist: string } | null;
  arc: { energy: number; phase: string } | null;
  /** Whether a set is playing (drives the "live" badge / idle hint). */
  active: boolean;
  /** Initial template id. */
  defaultTemplate?: string;
  className?: string;
}

interface Directive {
  mode: "template" | "shader";
  templateId?: string;
  fragment?: string;
  name?: string;
  params?: Partial<VizParams>;
  reasoning?: string;
}

/**
 * Real-time, code-driven music video. Two stacked canvases (2D + WebGL) share
 * one VizDriver tapping the engine's master FFT; the selected template paints
 * every animation frame. Toggle templates, tweak the look, let the AI compose
 * one from a prompt, or paste your own framework.
 */
export function MusicVisualizer({ analysis, track, arc, active, defaultTemplate = "stairs", className }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const c2dRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<HTMLCanvasElement>(null);

  // localStorage is client-only; this component only ever mounts after a user
  // interaction (toggle / play), so the lazy initializer is safe from SSR.
  const [templates, setTemplates] = useState<VizTemplate[]>(() => allTemplates());
  const [templateId, setTemplateId] = useState(defaultTemplate);
  const [params, setParams] = useState<VizParams>(DEFAULT_PARAMS);
  const [showControls, setShowControls] = useState(true);
  const [shaderError, setShaderError] = useState<string | null>(null);
  const [reasoning, setReasoning] = useState<string | null>(null);

  // AI + editor UI state
  const [prompt, setPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  // refs the rAF loop reads (avoid stale closures)
  const analysisRef = useRef(analysis);
  const trackRef = useRef(track);
  const arcRef = useRef(arc);
  const paramsRef = useRef(params);
  const tmplRef = useRef<VizTemplate | undefined>(undefined);
  const stateRef = useRef<unknown>(undefined);
  const needsClearRef = useRef(true);
  const driverRef = useRef<VizDriver | null>(null);
  const shaderRef = useRef<ShaderRenderer | null>(null);
  const lastDprRef = useRef(0);

  useEffect(() => { analysisRef.current = analysis; }, [analysis]);
  useEffect(() => { trackRef.current = track; }, [track]);
  useEffect(() => { arcRef.current = arc; }, [arc]);
  useEffect(() => { paramsRef.current = params; }, [params]);

  // resolve + prepare the active template whenever the selection changes.
  // setShaderError here surfaces the result of an external system (the WebGL
  // compile) into React — a legitimate effect→setState sync.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const t = getTemplate(templateId);
    tmplRef.current = t;
    needsClearRef.current = true;
    setShaderError(null);
    if (!t) return;
    if (t.kind === "canvas2d") {
      stateRef.current = t.init ? t.init(0, 0) : {};
    } else {
      if (!shaderRef.current && glRef.current) {
        try {
          shaderRef.current = new ShaderRenderer(glRef.current);
        } catch (e) {
          setShaderError(e instanceof Error ? e.message : "WebGL unavailable");
          return;
        }
      }
      const err = shaderRef.current?.setFragment(t.fragment) ?? "no renderer";
      setShaderError(err);
    }
  }, [templateId, templates]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // the render loop
  useEffect(() => {
    let raf = 0;
    if (!driverRef.current) driverRef.current = new VizDriver(getEngine().getAnalyser());

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const wrap = wrapRef.current;
      const t = tmplRef.current;
      const driver = driverRef.current;
      if (!wrap || !t || !driver) return;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (w === 0 || h === 0) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);

      const frame = driver.frame(now, w, h, dpr, {
        analysis: analysisRef.current,
        position: getEngine().position(),
        arc: arcRef.current,
        track: trackRef.current,
        params: paramsRef.current,
      });

      const c2d = c2dRef.current;
      const gl = glRef.current;
      if (t.kind === "shader") {
        if (c2d) c2d.style.display = "none";
        if (gl) gl.style.display = "block";
        shaderRef.current?.render(frame);
      } else {
        if (gl) gl.style.display = "none";
        if (c2d) {
          c2d.style.display = "block";
          const ctx = c2d.getContext("2d");
          if (ctx) {
            const cw = Math.floor(w * dpr);
            const ch = Math.floor(h * dpr);
            if (c2d.width !== cw || c2d.height !== ch) {
              c2d.width = cw;
              c2d.height = ch;
              needsClearRef.current = true;
            }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            if (t.clearEachFrame !== false || needsClearRef.current) {
              ctx.clearRect(0, 0, w, h);
              ctx.fillStyle = "#05050b";
              ctx.fillRect(0, 0, w, h);
              needsClearRef.current = false;
            }
            try {
              t.draw(ctx, frame, stateRef.current);
            } catch {
              /* a broken custom template shouldn't kill the loop */
            }
          }
        }
      }
      lastDprRef.current = dpr;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  function applyDirective(d: Directive) {
    if (d.params) setParams((p) => ({ ...p, ...d.params }));
    if (d.reasoning) setReasoning(d.reasoning);
    if (d.mode === "shader" && d.fragment) {
      const id = `ai-${Date.now().toString(36)}`;
      saveCustomTemplate({
        id,
        name: d.name || (prompt ? `AI · ${prompt.slice(0, 24)}` : "AI shader"),
        blurb: d.reasoning || "AI-generated shader",
        kind: "shader",
        fragment: d.fragment,
      });
      setTemplates(allTemplates());
      setTemplateId(id);
    } else if (d.templateId && getTemplate(d.templateId)) {
      setTemplateId(d.templateId);
    }
  }

  async function generateAI() {
    if (!prompt.trim() && !track) return;
    setAiBusy(true);
    setAiError(null);
    try {
      const res = await fetch("/api/ai/visualizer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          track: track
            ? {
                title: track.title,
                artist: track.artist,
                bpm: analysis?.bpm,
                keyName: analysis?.keyName,
                camelot: analysis?.camelot,
              }
            : null,
          arc,
          templates: allTemplates().map((t) => ({ id: t.id, name: t.name, blurb: t.blurb, kind: t.kind })),
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const d = (await res.json()) as Directive;
      applyDirective(d);
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "generation failed");
    } finally {
      setAiBusy(false);
    }
  }

  function toggleFullscreen() {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen?.();
  }

  const current = getTemplate(templateId);

  return (
    <div className={className}>
      <div
        ref={wrapRef}
        className="relative aspect-video w-full overflow-hidden rounded-xl bg-[#05050b] ring-1 ring-zinc-800"
        onDoubleClick={toggleFullscreen}
      >
        <canvas ref={c2dRef} className="absolute inset-0 h-full w-full" />
        <canvas ref={glRef} className="absolute inset-0 h-full w-full" style={{ display: "none" }} />

        {/* top overlay: name + live badge + buttons */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3">
          <div className="rounded-md bg-black/40 px-2 py-1 text-xs text-zinc-300 backdrop-blur">
            🎬 {current?.name ?? "—"}
            {active && <span className="ml-2 text-emerald-400">● live</span>}
          </div>
          <div className="pointer-events-auto flex gap-1.5">
            <button
              onClick={() => setShowControls((s) => !s)}
              className="rounded-md bg-black/40 px-2 py-1 text-xs text-zinc-300 backdrop-blur hover:text-white"
            >
              {showControls ? "hide" : "controls"}
            </button>
            <button
              onClick={toggleFullscreen}
              className="rounded-md bg-black/40 px-2 py-1 text-xs text-zinc-300 backdrop-blur hover:text-white"
            >
              ⛶
            </button>
          </div>
        </div>

        {shaderError && (
          <div className="absolute inset-x-3 bottom-3 max-h-24 overflow-auto rounded-md bg-red-950/80 p-2 text-[11px] text-red-200 backdrop-blur">
            shader error: {shaderError}
          </div>
        )}
      </div>

      {showControls && (
        <div className="mt-3 space-y-3 rounded-xl border border-zinc-800 p-3">
          {/* template chips */}
          <div className="flex flex-wrap gap-1.5">
            {templates.map((t) => (
              <button
                key={t.id}
                onClick={() => setTemplateId(t.id)}
                title={t.blurb}
                className={`rounded-full px-3 py-1 text-xs ${
                  t.id === templateId
                    ? "bg-fuchsia-600 text-white"
                    : "border border-zinc-700 text-zinc-300 hover:border-fuchsia-600"
                }`}
              >
                {t.kind === "shader" ? "◆" : "●"} {t.name}
                {t.custom && (
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteCustomTemplate(t.id);
                      const list = allTemplates();
                      setTemplates(list);
                      if (t.id === templateId) setTemplateId(list[0]?.id ?? "beads");
                    }}
                    className="ml-1.5 text-zinc-400 hover:text-red-300"
                  >
                    ✕
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* look sliders */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
            <Slider label="Hue" min={0} max={360} value={params.hue} onChange={(v) => setParams((p) => ({ ...p, hue: v }))} />
            <Slider label="Spread" min={0} max={240} value={params.hueRange} onChange={(v) => setParams((p) => ({ ...p, hueRange: v }))} />
            <Slider label="Intensity" min={0} max={2} step={0.05} value={params.intensity} onChange={(v) => setParams((p) => ({ ...p, intensity: v }))} />
            <Slider label="Speed" min={0} max={2} step={0.05} value={params.speed} onChange={(v) => setParams((p) => ({ ...p, speed: v }))} />
            <Slider label="Detail" min={0} max={1} step={0.05} value={params.complexity} onChange={(v) => setParams((p) => ({ ...p, complexity: v }))} />
            <Slider label="Glow" min={0} max={1} step={0.05} value={params.glow} onChange={(v) => setParams((p) => ({ ...p, glow: v }))} />
          </div>

          {/* AI prompt */}
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !aiBusy && generateAI()}
              placeholder="Describe a vibe — 'neon city rain', 'psychedelic 70s', 'deep space'…"
              className="min-w-[200px] flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
            />
            <button
              onClick={generateAI}
              disabled={aiBusy}
              className="rounded-lg bg-fuchsia-600 px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              {aiBusy ? "composing…" : "🎬 Generate"}
            </button>
            <button
              onClick={() => setEditorOpen((o) => !o)}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300"
            >
              + Custom framework
            </button>
          </div>
          {aiError && <p className="text-xs text-red-400">{aiError}</p>}
          {reasoning && <p className="text-xs text-fuchsia-300">{reasoning}</p>}

          {editorOpen && (
            <CustomEditor
              onSaved={(id) => {
                setTemplates(allTemplates());
                setTemplateId(id);
                setEditorOpen(false);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Slider({
  label, min, max, step = 1, value, onChange,
}: {
  label: string; min: number; max: number; step?: number; value: number; onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-zinc-400">
      <span className="w-16 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-fuchsia-500"
      />
    </label>
  );
}

const SHADER_STARTER = `// GLSL ES 1.00 — define mainImage. Uniforms available:
//   iResolution, iTime, iLevel, iLow, iMid, iHigh,
//   iBeat, iBeatPulse, iBar, iOnset, iHue, iKeyColor,
//   iChroma[12], and fft(x)/wave(x) (x in 0..1).
void mainImage(out vec4 o, in vec2 fc){
  vec2 uv = fc / iResolution.xy;
  float v = fft(uv.x) * (0.5 + iBeatPulse);
  vec3 col = hsv2rgb(vec3(fract(iHue + uv.x*0.3), 0.8, step(uv.y, v)));
  o = vec4(col + iKeyColor*iLow*0.4, 1.0);
}`;

const CANVAS_STARTER = `// Canvas2D — 'ctx' (2D context), 'f' (VizFrame), 'state' (your object),
// 'helpers' = { hsl, pitchClassHue, specAt, pulse }. Coords are CSS pixels.
const { hsl } = helpers;
const cx = f.w/2, cy = f.h/2;
const r = Math.min(f.w, f.h) * (0.15 + f.low*0.25 + helpers.pulse(f)*0.2);
ctx.fillStyle = hsl(f.key.hue, 80, 55, 0.9);
ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.fill();`;

function CustomEditor({ onSaved }: { onSaved: (id: string) => void }) {
  const [kind, setKind] = useState<"shader" | "canvas2d">("shader");
  const [name, setName] = useState("");
  const [code, setCode] = useState(SHADER_STARTER);
  const [err, setErr] = useState<string | null>(null);

  function save() {
    const id = `custom-${Date.now().toString(36)}`;
    const nm = name.trim() || (kind === "shader" ? "My shader" : "My canvas");
    if (kind === "shader") {
      const test = new ShaderRenderer(document.createElement("canvas"));
      const e = test.setFragment(code);
      test.dispose();
      if (e) { setErr(e); return; }
      saveCustomTemplate({ id, name: nm, kind: "shader", fragment: code, blurb: "your shader" });
    } else {
      try {
        new Function("ctx", "f", "state", "helpers", code);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "syntax error");
        return;
      }
      saveCustomTemplate({ id, name: nm, kind: "canvas2d", source: code, blurb: "your canvas template" });
    }
    setErr(null);
    onSaved(id);
  }

  return (
    <div className="space-y-2 rounded-lg border border-zinc-700 bg-zinc-950 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={kind}
          onChange={(e) => {
            const k = e.target.value as "shader" | "canvas2d";
            setKind(k);
            setCode(k === "shader" ? SHADER_STARTER : CANVAS_STARTER);
          }}
          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
        >
          <option value="shader">GLSL shader</option>
          <option value="canvas2d">Canvas2D</option>
        </select>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="name"
          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
        />
        <button onClick={save} className="rounded bg-emerald-600 px-3 py-1 text-sm font-semibold">
          Save & use
        </button>
      </div>
      <textarea
        value={code}
        onChange={(e) => setCode(e.target.value)}
        spellCheck={false}
        rows={10}
        className="w-full rounded border border-zinc-700 bg-black p-2 font-mono text-xs text-zinc-200"
      />
      {err && <p className="whitespace-pre-wrap text-xs text-red-400">{err}</p>}
    </div>
  );
}
