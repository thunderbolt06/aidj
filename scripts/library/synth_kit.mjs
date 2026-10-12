#!/usr/bin/env node
/**
 * Built-in DJ element kit, synthesized locally with ffmpeg (no downloads, no
 * licences): transition FX one-shots and plain drum loops at common tempos.
 * It guarantees the FX pad works on a fresh checkout; real recorded sounds
 * come from `npm run library:freesound` or by dropping files in
 * library/inbox/sfx and library/inbox/loops.
 *
 * Writes library/incoming/synth/<id>.wav + sidecar; then run library:ingest.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(process.env.LIBRARY_DIR || path.join(ROOT, "library"), "incoming", "synth");
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
mkdirSync(OUT, { recursive: true });

const TAU = "2*PI";
/** aevalsrc expression → mono 44.1k wav. `post` is an optional filter chain. */
function render(id, title, kind, tags, expr, dur, post = "", extra = {}) {
  const chain = [`aevalsrc='${expr}':s=44100:d=${dur}`, post, "alimiter=limit=0.9"]
    .filter(Boolean)
    .join(",");
  execFileSync(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", chain, path.join(OUT, `${id}.wav`)]);
  writeFileSync(
    path.join(OUT, `${id}.json`),
    JSON.stringify({
      id,
      kind,
      title,
      artist: "Everplay synth kit",
      genres: [kind === "loop" ? "Drum loop" : "FX"],
      tags,
      instrumental: true,
      popularity: 0,
      license: { name: "Generated locally (no rights reserved)", url: null, commercialUse: true, derivatives: true },
      source: "synth",
      sourceUrl: null,
      ...extra,
    })
  );
  console.log(`  ${id}`);
}

// ── transition FX ──────────────────────────────────────────────────────────
// noise riser: hiss swelling in, with a tone climbing two octaves underneath
for (const bars of [2, 4]) {
  const d = bars * 2; // seconds at ~120 BPM
  render(
    `syn-riser-${bars}bar`, `Riser (${bars} bars)`, "sfx", ["riser", "build", "sweep"],
    `0.5*pow(t/${d},2)*(2*random(0)-1) + 0.25*pow(t/${d},1.5)*sin(${TAU}*(220*t + (660/(2*${d}))*t*t))`,
    d, "highpass=f=600"
  );
}
render(
  "syn-downlifter", "Downlifter", "sfx", ["downlifter", "release", "sweep"],
  `0.5*pow(1-t/3,2)*(2*random(0)-1) + 0.25*pow(1-t/3,1.5)*sin(${TAU}*(880*t - (700/6)*t*t))`,
  3, "highpass=f=300"
);
render(
  "syn-impact", "Impact", "sfx", ["impact", "hit", "drop"],
  `0.9*sin(${TAU}*(40*t + 30*(1-exp(-12*t))/12*12))*exp(-3*t) + 0.6*(2*random(0)-1)*exp(-14*t)`,
  2.5
);
render(
  "syn-subdrop", "Sub drop", "sfx", ["sub", "drop", "bass"],
  `0.9*sin(${TAU}*(32*t + 30*(1-exp(-3*t))))*exp(-1.2*t)`,
  3
);
render(
  "syn-laser", "Laser zap", "sfx", ["laser", "zap"],
  `0.6*sin(${TAU}*(200*t + 350*(1-exp(-8*t))))*exp(-5*t)`,
  0.8
);
render(
  "syn-siren", "Siren", "sfx", ["siren", "alarm", "hype"],
  `0.45*sin(${TAU}*(700*t - (250/(${TAU}*1.5))*cos(${TAU}*1.5*t)))*min(1,(3-t)*4)`,
  3
);
// three stacked detuned tones, gated into the classic triple blast
render(
  "syn-horn", "Air horn", "sfx", ["horn", "airhorn", "hype"],
  `0.28*(lt(mod(t,0.42),0.3))*(sin(${TAU}*466*t)+0.7*sin(${TAU}*932*t)+0.5*sin(${TAU}*1398*t)+sin(${TAU}*587*t)+0.6*sin(${TAU}*1174*t)+sin(${TAU}*698*t))*min(1,mod(t,0.42)*60)`,
  1.26, "lowpass=f=5000"
);
// snare roll that doubles in speed every bar - the pre-drop build
render(
  "syn-snare-roll", "Snare roll build", "sfx", ["snare", "roll", "build"],
  `0.7*(2*random(0)-1)*exp(-28*mod(t, if(lt(t,2),0.25, if(lt(t,3),0.125,0.0625))))*(0.4+0.6*t/4)`,
  4, "highpass=f=180"
);
render(
  "syn-vinyl-stop", "Record stop", "sfx", ["vinyl", "stop", "brake"],
  `0.5*sin(${TAU}*(300*t - 140*t*t))*(1-t)`,
  1
);

// ── drum loops (4 bars, loop cleanly) ──────────────────────────────────────
for (const bpm of [90, 100, 110, 120, 128, 140]) {
  const beat = 60 / bpm;
  const d = (beat * 16).toFixed(5);
  const kick = `0.9*sin(${TAU}*(48*mod(t,${beat}) + 5*(1-exp(-30*mod(t,${beat})))))*exp(-7*mod(t,${beat}))`;
  const hat = `0.18*(2*random(0)-1)*exp(-60*mod(t+${beat / 2},${beat}))`;
  const clap = `0.35*(2*random(1)-1)*exp(-22*mod(t+${beat},${2 * beat}))`;
  render(`syn-loop-kick-${bpm}`, `Four-on-the-floor ${bpm}`, "loop", ["kick", "house", `${bpm}bpm`], `${kick}+${hat}`, d, "", { bpmHint: bpm });
  render(`syn-loop-beat-${bpm}`, `Kick + clap ${bpm}`, "loop", ["kick", "clap", `${bpm}bpm`], `${kick}+${hat}+${clap}`, d, "", { bpmHint: bpm });
}
console.log(`done → ${OUT}\nnext: npm run library:ingest`);
