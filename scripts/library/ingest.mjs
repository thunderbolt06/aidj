#!/usr/bin/env node
/**
 * Library ingest: turn raw downloads into DJ-ready library entries.
 *
 *   library/incoming/<source>/<id>.<ext> (+ <id>.json sidecar from a fetcher)
 *   library/inbox/**                     (your own files - no sidecar needed)
 *        │  decode (ffmpeg) → analyze (BPM, key, energy, hook, cues, intensity)
 *        ▼
 *   library/audio/<id>.<ext>   the playable file
 *   library/meta/<id>.json     full metadata + analysis the app serves as-is
 *   library/covers/<id>.jpg    placeholder cover (gradient, hue = musical key) until
 *                              fetch_covers.py swaps in the song's real album art
 *   library/catalog.json       compact index for search / next-track picking
 *
 * Everything the browser used to compute after "extracting audio…" happens
 * here, once, offline - the app only fetches and plays.
 *
 * Usage: npm run library:ingest [-- --jobs 6] [--force] [--index-only]
 *        npm run library:ingest -- --reanalyze   (recompute attributes for
 *        everything already in the library, e.g. after improving analysis)
 * (Run via `node --experimental-strip-types` - it imports the TS analysis.)
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeMono } from "../../lib/audio/analysisCore.ts";
import { ALL_LANGUAGES } from "../../lib/languages.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIBRARY = process.env.LIBRARY_DIR || path.join(ROOT, "library");
const DIRS = {
  incoming: path.join(LIBRARY, "incoming"),
  inbox: path.join(LIBRARY, "inbox"),
  audio: path.join(LIBRARY, "audio"),
  meta: path.join(LIBRARY, "meta"),
  covers: path.join(LIBRARY, "covers"),
};
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const AUDIO_EXT = new Set(["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus", "aif", "aiff", "wma"]);
/** Formats every target (Chrome, Safari, iOS, react-native-audio-api) decodes. */
const PLAYABLE = new Set(["mp3", "m4a"]);
const ANALYSIS_SR = 22050;

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

function run(cmd, cmdArgs, { collect = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs, { stdio: ["ignore", collect ? "pipe" : "ignore", "pipe"] });
    const chunks = [];
    let err = "";
    if (collect) p.stdout.on("data", (c) => chunks.push(c));
    p.stderr.on("data", (c) => (err += c));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0
        ? resolve(collect ? Buffer.concat(chunks) : null)
        : reject(new Error(`${cmd} exited ${code}: ${err.trim().split("\n").pop()}`))
    );
  });
}

async function decodeMono(file) {
  const raw = await run(
    FFMPEG,
    ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(ANALYSIS_SR), "-f", "f32le", "-"],
    { collect: true }
  );
  // copy into an aligned buffer - a pooled Buffer's byteOffset may not be /4
  const out = new Float32Array(Math.floor(raw.length / 4));
  Buffer.from(out.buffer).set(raw.subarray(0, out.length * 4));
  return out;
}

async function probeTags(file) {
  try {
    const raw = await run(
      FFPROBE,
      ["-v", "error", "-show_entries", "format_tags=title,artist,album,genre", "-of", "json", file],
      { collect: true }
    );
    const tags = JSON.parse(raw.toString()).format?.tags ?? {};
    return Object.fromEntries(Object.entries(tags).map(([k, v]) => [k.toLowerCase(), v]));
  } catch {
    return {};
  }
}

async function walk(dir) {
  const out = [];
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else if (AUDIO_EXT.has(e.name.split(".").pop().toLowerCase())) out.push(full);
  }
  return out;
}

/** Fetcher downloads carry a sidecar; inbox files get metadata from tags. */
async function describe(file, fromInbox) {
  const ext = file.split(".").pop().toLowerCase();
  const base = file.slice(0, -ext.length - 1);
  if (!fromInbox) {
    // no sidecar yet = a fetcher is still writing this one; next run gets it
    if (!existsSync(`${base}.json`)) return null;
    return { ...JSON.parse(await readFile(`${base}.json`, "utf8")), sidecar: `${base}.json` };
  }
  const st = await stat(file);
  const hash = createHash("sha1").update(`${path.basename(file)}:${st.size}`).digest("hex");
  const tags = await probeTags(file);
  const name = path.basename(base);
  const dash = name.split(" - ");
  const rel = path.relative(DIRS.inbox, file).toLowerCase();
  return {
    id: `loc-${hash.slice(0, 12)}`,
    // inbox/sfx/** and inbox/loops/** are filed as elements, the rest as songs
    kind: rel.startsWith("sfx") ? "sfx" : rel.startsWith("loop") ? "loop" : "song",
    title: tags.title || (dash.length > 1 ? dash.slice(1).join(" - ") : name),
    artist: tags.artist || (dash.length > 1 ? dash[0] : "Unknown"),
    album: tags.album || null,
    genres: tags.genre ? [tags.genre] : [],
    tags: [],
    language: null,
    instrumental: false,
    popularity: 0,
    license: { name: "Your own file", url: null, commercialUse: null, derivatives: null },
    source: "local",
    sourceUrl: null,
  };
}

function hsl(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, "0");
  };
  return `0x${f(0)}${f(8)}${f(4)}`;
}

/**
 * Ids whose cover is real album art (decided by fetch_covers.py, logged in its
 * manifest). Re-ingesting or re-analysing a song must never swap that art back
 * for a gradient.
 */
let realCovers = null;
async function hasRealCover(id) {
  if (!realCovers) {
    realCovers = new Set();
    let text = "";
    try {
      text = await readFile(path.join(LIBRARY, "sources", "covers", "manifest.jsonl"), "utf8");
    } catch {
      /* no manifest yet: every cover is still a gradient */
    }
    for (const line of text.split("\n")) {
      try {
        const row = JSON.parse(line); // the last row of an id wins
        if (row.status === "itunes" || row.status === "ytmusic" || row.status === "youtube") realCovers.add(row.id);
        else realCovers.delete(row.id);
      } catch {
        /* blank or torn line */
      }
    }
  }
  return realCovers.has(id);
}

/** Gradient cover: hue = Camelot number, so tracks that mix well look alike. */
async function makeCover(id, analysis) {
  if (existsSync(path.join(DIRS.covers, `${id}.jpg`)) && (await hasRealCover(id))) return;
  const m = /^(\d+)([AB])$/.exec(analysis.camelot ?? "");
  const hue = m ? (parseInt(m[1], 10) - 1) * 30 : parseInt(createHash("md5").update(id).digest("hex").slice(0, 3), 16) % 360;
  const minor = m?.[2] === "A";
  const c0 = hsl(hue, 0.75, minor ? 0.3 : 0.45);
  const c1 = hsl((hue + 40 + analysis.intensity * 60) % 360, 0.8, 0.12 + analysis.intensity * 0.2);
  await run(FFMPEG, [
    "-v", "error", "-y", "-f", "lavfi",
    "-i", `gradients=s=480x270:c0=${c0}:c1=${c1}:x0=0:y0=0:x1=480:y1=270:d=1`,
    "-frames:v", "1", "-q:v", "4", path.join(DIRS.covers, `${id}.jpg`),
  ]);
}

function heatmapFrom(interest, duration) {
  const segments = Math.min(100, interest.length);
  if (!segments) return [];
  const step = interest.length / segments;
  const secPer = duration / segments;
  return Array.from({ length: segments }, (_, i) => {
    let v = 0;
    for (let s = Math.floor(i * step); s < Math.floor((i + 1) * step); s++) v = Math.max(v, interest[s] ?? 0);
    return { start: +(i * secPer).toFixed(2), end: +((i + 1) * secPer).toFixed(2), value: +v.toFixed(3) };
  });
}

/** Decode + analyze, shaped into the fields a meta file stores. */
async function analyzeFile(file, kind) {
  const pcm = await decodeMono(file);
  if (pcm.length < ANALYSIS_SR / 4) throw new Error("audio too short / undecodable");
  const { hookStart, interest, cueIn, cueOut, intensity, ...analysis } = analyzeMono(pcm, ANALYSIS_SR);
  const isSong = kind === "song";
  return {
    duration: Math.round(analysis.duration),
    heatmap: isSong ? heatmapFrom(interest, analysis.duration) : [],
    famousStart: isSong ? hookStart : null,
    cueIn: isSong ? cueIn : 0,
    cueOut: isSong ? cueOut : analysis.duration,
    intensity,
    analysis,
  };
}

/** --reanalyze: recompute attributes for an entry already in the library. */
async function reanalyzeOne(metaFile) {
  const metaPath = path.join(DIRS.meta, metaFile);
  const meta = JSON.parse(await readFile(metaPath, "utf8"));
  const computed = await analyzeFile(path.join(DIRS.audio, meta.file), meta.kind);
  await makeCover(meta.id, { camelot: computed.analysis.camelot, intensity: computed.intensity });
  await writeFile(metaPath, JSON.stringify({ ...meta, ...computed, ingestedAt: new Date().toISOString() }));
  return "ok";
}

async function ingestOne(file, fromInbox) {
  const info = await describe(file, fromInbox);
  if (!info) return "skip";
  const metaPath = path.join(DIRS.meta, `${info.id}.json`);
  if (existsSync(metaPath) && !flag("force")) return "skip";

  const computed = await analyzeFile(file, info.kind);
  if (info.heatmap?.length) {
    // a real "most replayed" curve beats the computed hook estimate
    computed.heatmap = info.heatmap;
    computed.famousStart = info.famousStart ?? computed.famousStart;
  }

  if (info.bpmHint) {
    // generated loops know their tempo exactly and start on the 1
    Object.assign(computed.analysis, {
      bpm: info.bpmHint,
      bpmConfidence: 1,
      beatOffset: 0,
      downbeatOffset: 0,
    });
  }

  const ext = file.split(".").pop().toLowerCase();
  // loops and one-shots stay WAV: lossy codecs pad the ends, which gaps a loop
  const keep = PLAYABLE.has(ext) || (ext === "wav" && info.kind !== "song");
  const outExt = keep ? ext : "m4a";
  const outFile = path.join(DIRS.audio, `${info.id}.${outExt}`);
  if (outExt !== ext) {
    await run(FFMPEG, ["-v", "error", "-y", "-i", file, "-vn", "-c:a", "aac", "-b:a", "192k", outFile]);
    if (!fromInbox) await unlink(file);
  } else if (fromInbox) {
    await copyFile(file, outFile); // never move the user's originals
  } else {
    await rename(file, outFile);
  }

  await makeCover(info.id, { camelot: computed.analysis.camelot, intensity: computed.intensity });
  // eslint-disable-next-line no-unused-vars
  const { sidecar, bpmHint, ...rest } = info;
  const meta = {
    ...rest,
    file: `${info.id}.${outExt}`,
    ...computed,
    ingestedAt: new Date().toISOString(),
  };
  await writeFile(metaPath, JSON.stringify(meta));
  if (sidecar) await unlink(sidecar).catch(() => {});
  return "ok";
}

const sane = (y) => Number.isInteger(y) && y >= 1900 && y <= new Date().getFullYear() + 1;

/**
 * Release year, as well as it is known: the cross-checked original year from
 * label_years.mjs, else the download's own metadata (a YouTube date - often an
 * upload or reissue), else a chart-year tag ("2018"), else the middle of a
 * decade tag ("2010s", "90s"). Impossible values (a stray 8460) are dropped.
 */
function yearOf(m) {
  if (sane(m.releaseYear)) return m.releaseYear;
  if (sane(m.year)) return m.year;
  const tags = m.tags ?? [];
  const exact = tags.find((t) => /^(19|20)\d\d$/.test(t) && sane(Number(t)));
  if (exact) return Number(exact);
  for (const t of tags) {
    const d = /^((?:19|20)?\d0)s$/.exec(t);
    if (d) {
      const n = Number(d[1]);
      return (n < 100 ? (n >= 30 ? 1900 : 2000) + n : n) + 5;
    }
  }
  return null;
}

/**
 * check_songs.mjs verdicts (id -> { language, instrumental, notSong }), kept
 * out of meta/ because the vocal-map batch rewrites those files.
 */
async function readChecks() {
  const file = path.join(LIBRARY, "sources", "checks", "songs.jsonl");
  const out = new Map();
  if (!existsSync(file)) return out;
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    try {
      const v = line.trim() && JSON.parse(line);
      if (v?.id) out.set(v.id, v);
    } catch {
      /* a half-written line from an interrupted run */
    }
  }
  return out;
}

/**
 * A checked language only replaces the collection's when it is one listeners
 * can pick: Haryanvi and Sanskrit hymns stay in the Hindi pool (the "haryanvi
 * dance" and devotional vibes live there), a Chopin nocturne stays English
 * rather than becoming "other".
 */
const PICKABLE = new Set(ALL_LANGUAGES.map((l) => l.iso));

/** Compact one-row-per-entry index: what search and next-track picking read. */
async function buildCatalog() {
  const files = (await readdir(DIRS.meta)).filter((f) => f.endsWith(".json"));
  const checks = await readChecks();
  const rows = [];
  let hidden = 0;
  for (const f of files) {
    const m = JSON.parse(await readFile(path.join(DIRS.meta, f), "utf8"));
    const check = checks.get(m.id);
    // a jingle or a jukebox the search landed on: its files stay, it just never plays
    if (check?.notSong) {
      hidden++;
      continue;
    }
    rows.push({
      id: m.id,
      kind: m.kind,
      title: m.title,
      artist: m.artist,
      duration: m.duration,
      bpm: m.analysis.bpm,
      bpmConfidence: m.analysis.bpmConfidence,
      camelot: m.analysis.camelot,
      intensity: m.intensity,
      genres: m.genres ?? [],
      moods: m.moods ?? [],
      tags: m.tags ?? [],
      language: (PICKABLE.has(check?.language) ? check.language : m.language) ?? null,
      year: yearOf(m),
      instrumental: check ? !!check.instrumental : !!m.instrumental,
      popularity: m.popularity ?? 0,
      license: m.license?.name ?? null,
      licenseUrl: m.license?.url ?? null,
      source: m.source,
      sourceUrl: m.sourceUrl ?? null,
      file: m.file,
    });
  }
  rows.sort((a, b) => b.popularity - a.popularity);
  const write = (name, tracks) =>
    writeFile(
      path.join(LIBRARY, name),
      JSON.stringify({ version: 1, builtAt: new Date().toISOString(), count: tracks.length, tracks })
    );
  await write("catalog.json", rows);
  // what gets hosted publicly: everything except all-rights-reserved YouTube rips
  await write("catalog.public.json", rows.filter((r) => r.source !== "youtube"));
  const by = (k) => rows.filter((r) => r.kind === k).length;
  console.log(
    `catalog: ${rows.length} entries (${by("song")} songs, ${by("loop")} loops, ${by("sfx")} sfx)` +
      (hidden ? `, ${hidden} not-songs left out` : "")
  );
}

async function worker(shard, shards) {
  const jobs = (
    flag("reanalyze")
      ? (await readdir(DIRS.meta)).filter((f) => f.endsWith(".json")).map((f) => [f, false])
      : [
          ...(await walk(DIRS.incoming)).map((f) => [f, false]),
          ...(await walk(DIRS.inbox)).map((f) => [f, true]),
        ]
  ).filter(([f]) => parseInt(createHash("md5").update(f).digest("hex").slice(0, 6), 16) % shards === shard);
  const counts = { ok: 0, skip: 0, error: 0 };
  for (const [file, fromInbox] of jobs) {
    try {
      counts[await (flag("reanalyze") ? reanalyzeOne(file) : ingestOne(file, fromInbox))]++;
    } catch (e) {
      counts.error++;
      console.error(`  ✗ ${path.basename(file)}: ${e.message}`);
    }
    const done = counts.ok + counts.skip + counts.error;
    if (done % 20 === 0) console.log(`  [${shard + 1}/${shards}] ${done}/${jobs.length}`);
  }
  console.log(`  [${shard + 1}/${shards}] done ${JSON.stringify(counts)}`);
}

async function main() {
  for (const d of Object.values(DIRS)) await mkdir(d, { recursive: true });
  const shardArg = opt("shard", null);
  if (shardArg) {
    const [k, n] = shardArg.split("/").map(Number);
    return worker(k, n);
  }
  if (!flag("index-only")) {
    // analysis is CPU-bound JS: fan out across processes, one shard each
    const jobs = Math.max(1, Number(opt("jobs", Math.min(8, Math.max(1, os.cpus().length - 2)))));
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: jobs }, (_, k) =>
        new Promise((resolve) => {
          const p = spawn(
            process.execPath,
            [...process.execArgv, fileURLToPath(import.meta.url), ...args, "--shard", `${k}/${jobs}`],
            { stdio: "inherit" }
          );
          p.on("close", resolve);
        })
      )
    );
    console.log(`ingest finished in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  await buildCatalog();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
