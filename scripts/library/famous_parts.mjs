/**
 * Re-derive every song's famous part with famous_start()'s current rule
 * (fetch_youtube.py). Big hits' YouTube "most replayed" graphs often just
 * decay from 0:00, so the highest point after 10 s is the tail of the intro
 * spike - verse 1, not the chorus (Can't Stop the Feeling at 0:11, Shake It
 * Off at 0:12) - and the DJ then leaves before the first chorus. A flat
 * graph's maximum is noise too, and a peak in the last quarter (often the
 * final chorus) leaves too little song to play out.
 *
 * A graph with a real peak before the last quarter keeps (or moves to) that
 * peak. Every other song gets the audio hook detector instead (energy x
 * repetition, searched from SONG_HOOK_FROM), which agrees with a clear replay
 * peak - or a repeat of that section - on 69% of 200 English hits.
 *
 *   npm run library:famous [-- --dry | --ids a,b | --force | --workers 6]
 *
 * Writes famousStart (+ famousBy: "audio" when it came from the audio) into
 * meta/<id>.json; heatmap is kept. Prod needs `library:push -- --all --only
 * meta` plus a CloudFront /meta/* invalidation afterwards (meta is cached
 * immutable).
 */
import { spawn } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeMono, pickHook, SONG_HOOK_FROM } from "../../lib/audio/analysisCore.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIBRARY = process.env.LIBRARY_DIR || path.join(ROOT, "library");
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const SR = 22050;

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

/**
 * A YouTube graph, not the audio interest curve ingest stores when YouTube
 * had none (that one is rounded to 3 decimals and was never the source).
 */
export function youtubeGraph(heatmap) {
  return heatmap.some((p) => Math.abs(p.value * 1000 - Math.round(p.value * 1000)) > 1e-6);
}

/**
 * The graph's real most-replayed peak (seconds), or null. Same rule as
 * famous_start() in fetch_youtube.py: searched after the intro and before the
 * last quarter, it must stand 15% above the median and rise at least 10%
 * above the dip that separates it from higher ground - not a ripple on the
 * slope off the intro spike.
 */
export function heatmapPeak(heatmap) {
  const end = heatmap.length ? heatmap[heatmap.length - 1].end : 0;
  const late = heatmap.map((p, i) => [i, p]).filter(([, p]) => p.start > 10 && p.start <= end * 0.75);
  if (!late.length) return null;
  let [i, peak] = late[0];
  for (const [j, p] of late) if (p.value > peak.value) [i, peak] = [j, p];
  const values = late.map(([, p]) => p.value).sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)];
  if (peak.value < median * 1.15) return null;
  if (prominence(heatmap.map((p) => p.value), i) < 0.1) return null;
  return roundHalfEven(peak.start);
}

/** Python's round(): famous_start() wrote most of these, so match it to the second. */
function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Topographic prominence of peak i, as a share of its height. */
function prominence(values, i) {
  const pk = values[i];
  if (pk <= 0) return 0;
  const base = (step) => {
    let low = pk;
    for (let j = i + step; j >= 0 && j < values.length && values[j] < pk; j += step) low = Math.min(low, values[j]);
    return low;
  };
  return (pk - Math.max(base(-1), base(1))) / pk;
}

function decodeMono(file) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"]);
    const chunks = [];
    let err = "";
    p.stdout.on("data", (c) => chunks.push(c));
    p.stderr.on("data", (c) => (err += c));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${err.trim()}`));
      const raw = Buffer.concat(chunks);
      // copy into an aligned buffer - a pooled Buffer's byteOffset may not be /4
      const out = new Float32Array(Math.floor(raw.length / 4));
      Buffer.from(out.buffer).set(raw.subarray(0, out.length * 4));
      resolve(out);
    });
  });
}

/** Rewrite one meta file, re-read first: another tool may have written it meanwhile. */
async function update(file, patch) {
  const { famousBy, ...fresh } = JSON.parse(await readFile(file, "utf8")); // eslint-disable-line @typescript-eslint/no-unused-vars
  await writeFile(file, JSON.stringify({ ...fresh, ...patch }));
}

async function main() {
  const metaDir = path.join(LIBRARY, "meta");
  const only = opt("ids", "") ? new Set(opt("ids", "").split(",")) : null;
  const files = (await readdir(metaDir)).filter((f) => f.startsWith("yt-") && f.endsWith(".json"));
  const fromGraph = [];
  const fromAudio = [];
  for (const f of files) {
    const id = f.slice(0, -5);
    if (only && !only.has(id)) continue;
    const meta = JSON.parse(await readFile(path.join(metaDir, f), "utf8"));
    if (meta.kind !== "song" || !meta.heatmap?.length || !youtubeGraph(meta.heatmap)) continue;
    const peak = heatmapPeak(meta.heatmap);
    if (peak != null) {
      if (peak !== meta.famousStart || meta.famousBy) fromGraph.push([meta, peak]);
    } else if (meta.famousBy !== "audio" || flag("force")) fromAudio.push(meta);
  }
  console.log(
    `${fromGraph.length} songs move to their replay peak, ${fromAudio.length} need the audio hook (of ${files.length} yt songs)`
  );
  if (flag("dry")) return;

  const moved = [];
  for (const [meta, peak] of fromGraph) {
    moved.push(peak - (meta.famousStart ?? peak));
    await update(path.join(metaDir, `${meta.id}.json`), { famousStart: peak });
  }

  let next = 0;
  let done = 0;
  let failed = 0;
  const worker = async () => {
    while (next < fromAudio.length) {
      const meta = fromAudio[next++];
      try {
        const a = analyzeMono(await decodeMono(path.join(LIBRARY, "audio", meta.file)), SR);
        const hook = pickHook(a.interest, { bpm: a.bpm, anchor: a.downbeatOffset }, SONG_HOOK_FROM);
        if (hook != null) {
          moved.push(hook - (meta.famousStart ?? hook));
          await update(path.join(metaDir, `${meta.id}.json`), { famousStart: hook, famousBy: "audio" });
        }
      } catch (e) {
        failed++;
        console.warn(`${meta.id}: ${e.message}`);
      }
      if (++done % 100 === 0) console.log(`${done}/${fromAudio.length}`);
    }
  };
  await Promise.all(Array.from({ length: Number(opt("workers", "6")) }, worker));
  moved.sort((x, y) => x - y);
  const med = moved.length ? moved[Math.floor(moved.length / 2)] : 0;
  console.log(`updated ${moved.length}, failed ${failed}; famous part moved by a median ${med}s`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
