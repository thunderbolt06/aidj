#!/usr/bin/env node
/**
 * Genre + mood labels for library songs, from Claude.
 *
 * The chart songs arrive with no genres at all (Billboard lists name a title
 * and an artist, nothing else) and nobody has moods, so the pickers had
 * nothing to tell "sad" from "party" by except the vibe playlists - and most
 * of the older chart songs are in none. Famous songs are well known to the
 * model, so it labels them from title / artist / year, from a fixed list:
 *
 *   genres  only for songs that have none (the Hindi / Punjabi collections
 *           already carry theirs)
 *   moods   for every song
 *
 * Writes into library/meta/<id>.json (`moods`, `genres`, `labeledBy`), then
 * rebuilds catalog.json. Resumable: labelled songs are skipped.
 *
 *   npm run library:label [-- --limit 120] [--dry-run]
 *
 * Never sends lyrics - only names. Needs ANTHROPIC_API_KEY (env or .env.local).
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIBRARY = process.env.LIBRARY_DIR || path.join(ROOT, "library");
const META = path.join(LIBRARY, "meta");
const MODEL = "claude-opus-5-5";
const BATCH = 60;
const PARALLEL = 4;

export const GENRES = [
  "Pop", "Dance Pop", "Synth-Pop", "Electropop", "Teen Pop", "Indie Pop", "Pop Rock",
  "Rock", "Classic Rock", "Soft Rock", "Hard Rock", "Alternative Rock", "Indie Rock",
  "Punk", "Pop Punk", "Metal", "Grunge", "New Wave", "Folk", "Indie Folk", "Country",
  "Country Pop", "Singer-Songwriter", "Acoustic", "Hip-Hop", "Rap", "Trap", "R&B",
  "Soul", "Funk", "Disco", "Motown", "Gospel", "Blues", "Jazz", "Reggae", "Reggaeton",
  "Latin Pop", "Afrobeats", "K-Pop", "EDM", "House", "Electronic", "Dance", "Lo-Fi",
  "Ambient", "Soundtrack",
  // the Indian collections' own genres, for the odd song that lacks one
  "Bollywood", "Indian Pop", "Punjabi Pop", "Punjabi Hip-Hop", "Desi Hip-Hop", "Bhangra",
  "Punjabi Folk", "Sufi", "Ghazal", "Devotional", "Retro",
];
export const MOODS = [
  "happy", "feel-good", "upbeat", "party", "hype", "energetic", "confident",
  "empowering", "motivational", "romantic", "sensual", "sad", "heartbreak",
  "melancholic", "emotional", "nostalgic", "chill", "mellow", "dreamy", "calm", "dark",
  "angry", "epic", "playful", "groovy", "summery", "late-night",
];

const SYSTEM = `You label songs for a DJ app's music library. For each numbered song (artist - title,
year, language) give its genres and moods, choosing ONLY from these lists:

Genres: ${GENRES.join(", ")}
Moods: ${MOODS.join(", ")}

- genres: 1-3, most defining first. When a song line already says "genres: given", write "-".
- moods: 2-4, how the song FEELS to a listener (a breakup ballad is sad/heartbreak/emotional even
  if mid-tempo; a club banger is party/hype/energetic).
- Use what you know of the song; if you don't know it, judge from the artist and era.

Answer one line per song, nothing else:
<number>|<genres, comma separated or ->|<moods, comma separated>`;

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

function loadEnvKey() {
  if (process.env.ANTHROPIC_API_KEY) return;
  const file = path.join(ROOT, ".env.local");
  if (!existsSync(file)) return;
  const line = readFileSync(file, "utf8")
    .split("\n")
    .find((l) => l.startsWith("ANTHROPIC_API_KEY="));
  if (line) process.env.ANTHROPIC_API_KEY = line.slice("ANTHROPIC_API_KEY=".length).trim();
}

const pick = (list, raw) => {
  const lower = new Map(list.map((x) => [x.toLowerCase(), x]));
  return [...new Set(raw.split(",").map((x) => lower.get(x.trim().toLowerCase())).filter(Boolean))];
};

const LANG = { en: "English", hi: "Hindi", pa: "Punjabi" };

async function labelBatch(client, songs) {
  const lines = songs.map(
    (m, i) =>
      `${i + 1}. ${m.artist} - ${m.title} | ${m.year ?? "year unknown"} | ${LANG[m.language] ?? m.language ?? "?"}` +
      (m.genres?.length ? " | genres: given" : "")
  );
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    // a classification pass over names: the least thinking that does the job
    output_config: { effort: "low" },
    // a refusal is rerouted to a model that answers instead of losing the batch
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [{ role: "user", content: lines.join("\n") }],
  });
  if (res.stop_reason === "refusal") throw new Error(`refused: ${res.stop_details?.category ?? "?"}`);
  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const out = new Map();
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s*\|([^|]*)\|(.*)$/.exec(line);
    if (!m) continue;
    const song = songs[Number(m[1]) - 1];
    if (!song) continue;
    out.set(song.id, { genres: m[2].trim() === "-" ? [] : pick(GENRES, m[2]), moods: pick(MOODS, m[3]) });
  }
  return { out, usage: res.usage };
}

async function save(id, labels) {
  const file = path.join(META, `${id}.json`);
  const meta = JSON.parse(await readFile(file, "utf8"));
  meta.moods = labels.moods;
  if (!meta.genres?.length && labels.genres.length) meta.genres = labels.genres;
  meta.labeledBy = MODEL;
  // atomic: an ingest may be reading meta/ at the same moment
  await writeFile(`${file}.tmp`, JSON.stringify(meta));
  await rename(`${file}.tmp`, file);
}

function run(cmd, cmdArgs) {
  return new Promise((resolve) => spawn(cmd, cmdArgs, { stdio: "inherit" }).on("close", resolve));
}

async function main() {
  loadEnvKey();
  const todo = [];
  for (const f of await readdir(META)) {
    if (!f.endsWith(".json")) continue;
    const m = JSON.parse(await readFile(path.join(META, f), "utf8"));
    if (m.kind === "song" && !m.labeledBy) todo.push(m);
  }
  const limit = Number(opt("limit", 0));
  const songs = limit ? todo.slice(0, limit) : todo;
  console.log(`${todo.length} songs unlabelled, labelling ${songs.length}`);
  if (flag("dry-run") || !songs.length) return;
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");

  const client = new Anthropic({ maxRetries: 5 });
  const batches = [];
  for (let i = 0; i < songs.length; i += BATCH) batches.push(songs.slice(i, i + BATCH));
  const totals = { labelled: 0, missed: 0, failed: 0, input: 0, output: 0 };
  let next = 0;
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: PARALLEL }, async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        try {
          const { out, usage } = await labelBatch(client, batch);
          totals.input += usage.input_tokens;
          totals.output += usage.output_tokens;
          for (const m of batch) {
            const l = out.get(m.id);
            // a line the model skipped stays unlabelled; the next run retries it
            if (l?.moods.length) {
              await save(m.id, l);
              totals.labelled++;
            } else totals.missed++;
          }
        } catch (e) {
          totals.failed += batch.length;
          console.error(`  batch failed: ${e.message}`);
        }
        const done = totals.labelled + totals.missed + totals.failed;
        console.log(
          `  ${done}/${songs.length} ${JSON.stringify(totals)} ${((Date.now() - t0) / 1000).toFixed(0)}s`
        );
      }
    })
  );
  // the catalog is what the app reads
  await run(process.execPath, [
    "--experimental-strip-types",
    "--no-warnings",
    path.join(ROOT, "scripts/library/ingest.mjs"),
    "--index-only",
  ]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
