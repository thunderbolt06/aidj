#!/usr/bin/env node
/**
 * Claude checks each chart song's basic facts: its language, whether it is
 * sung at all, and whether the download is a song in the first place.
 *
 * The YouTube crate's metadata comes from where a song was found, not from
 * the song: Shubh's "Cheques" and Diljit's "Lover" came in through a Hindi
 * collection and carry `hi`, a Hindi film song found by an English vibe
 * carries `en`, BTS is `hi`. No YouTube song is marked instrumental, so
 * "instrumental only" played Post Malone. And a search now and then lands on
 * something that is not a song - an advert jingle, a jukebox, a medley.
 *
 * Verdicts go to library/sources/checks/songs.jsonl (append-only, one per
 * song), never into meta/ (the vocal-map batch rewrites those files). ingest
 * applies them when it builds catalog.json: the language and instrumental
 * flag are corrected, and a download that is not a song leaves the catalog
 * (its files stay, so a wrong verdict is undone by editing the jsonl).
 *
 *   node scripts/library/check_songs.mjs [--limit 120] [--again]
 *
 * Never sends audio or lyrics - only names. Needs ANTHROPIC_API_KEY (env or .env.local).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIBRARY = process.env.LIBRARY_DIR || path.join(ROOT, "library");
export const CHECKS = path.join(LIBRARY, "sources", "checks", "songs.jsonl");
const MODEL = "claude-opus-5-5";
const BATCH = 60;
const PARALLEL = 4;
const LANGS = ["en", "hi", "pa", "ta", "te", "bn", "mr", "gu", "kn", "ml", "bho", "hry", "es", "ko", "ja", "fr", "ar", "pt", "other"];

const SYSTEM = `You check the facts of songs in a DJ app's library. Each line is a downloaded track:
artist - title | year | the language the library has for it | genres.

For each numbered line give:
- language: the language it is SUNG in, as one code: ${LANGS.join(", ")}
  (hry = Haryanvi, bho = Bhojpuri; "other" for anything else). Hindi and Urdu are one language here
  (hi): Pakistani pop and ghazals sung in Urdu are hi. An instrumental takes the language of
  its origin (a Bollywood instrumental is hi). Punjabi pop by Diljit Dosanjh, Shubh, Karan Aujla,
  AP Dhillon, Sidhu Moose Wala, Guru Randhawa is pa even in a Bollywood film unless the lyrics are Hindi.
- vocals: "sung" or "instrumental" (no singing or rapping at all: scores, piano pieces, lo-fi beats,
  karaoke versions)
- kind: "song" or "not-song". not-song is ONLY for a track that is not one piece of music:
  an advert jingle, a jukebox / medley / non-stop mix of several songs, a speech, a podcast, a
  trailer, a ringtone, a tutorial. An obscure or low-quality song is still a song.

Use what you know of the track; judge an unknown one from artist, title and year.
Answer one line per track, nothing else:
<number>|<language>|<sung or instrumental>|<song or not-song>|<three to eight words, only for not-song or a language change>`;

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

/** id -> latest verdict. */
export async function readChecks(file = CHECKS) {
  const out = new Map();
  if (!existsSync(file)) return out;
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v.id) out.set(v.id, v);
    } catch {
      /* a half-written line from an interrupted run */
    }
  }
  return out;
}

async function checkBatch(client, songs) {
  const lines = songs.map(
    (r, i) =>
      `${i + 1}. ${r.artist} - ${r.title} | ${r.year ?? "year unknown"} | ${r.language ?? "?"} | ${r.genres.join(", ") || "-"}`
  );
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "low" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [{ role: "user", content: lines.join("\n") }],
  });
  if (res.stop_reason === "refusal") throw new Error(`refused: ${res.stop_details?.category ?? "?"}`);
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const out = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s*\|\s*([a-z]+)\s*\|\s*(sung|instrumental)\s*\|\s*(song|not-song)\s*(?:\|(.*))?$/i.exec(line);
    const r = m && songs[Number(m[1]) - 1];
    if (!r) continue;
    const language = LANGS.includes(m[2].toLowerCase()) ? m[2].toLowerCase() : "other";
    out.push({
      id: r.id,
      language,
      instrumental: m[3].toLowerCase() === "instrumental",
      notSong: m[4].toLowerCase() === "not-song",
      why: (m[5] ?? "").trim() || undefined,
      was: r.language ?? null,
      at: new Date().toISOString().slice(0, 10),
    });
  }
  return out;
}

async function main() {
  loadEnvKey();
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY missing");
  const cat = JSON.parse(await readFile(path.join(LIBRARY, "catalog.json"), "utf8")).tracks;
  const done = flag("again") ? new Map() : await readChecks();
  // the open crate is tagged by its archive, not by where a search found it
  const todo = cat
    .filter((r) => r.kind === "song" && r.source === "youtube" && !done.has(r.id))
    .slice(0, Number(opt("limit", 1e9)));
  console.log(`checking ${todo.length} songs (${done.size} already checked)`);
  await mkdir(path.dirname(CHECKS), { recursive: true });
  const client = new Anthropic({ maxRetries: 5 });
  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  let next = 0;
  const tally = { checked: 0, language: 0, instrumental: 0, notSong: 0, failed: 0 };
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      try {
        const verdicts = await checkBatch(client, batch);
        if (verdicts.length) await appendFile(CHECKS, verdicts.map((v) => JSON.stringify(v)).join("\n") + "\n");
        for (const v of verdicts) {
          tally.checked++;
          if (v.language !== v.was) tally.language++;
          if (v.instrumental) tally.instrumental++;
          if (v.notSong) tally.notSong++;
        }
      } catch (e) {
        // a failed batch stays unchecked; the next run picks it up
        tally.failed += batch.length;
        console.warn(`\n  batch failed: ${e instanceof Error ? e.message : e}`);
      }
      process.stdout.write(`\r  ${JSON.stringify(tally)}   `);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  console.log(`\nchecks -> ${CHECKS}`);
  if (flag("no-index")) return;
  // catalog.json picks the verdicts up
  await new Promise((resolve, reject) => {
    const p = spawn(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", path.join(ROOT, "scripts/library/ingest.mjs"), "--index-only"],
      { stdio: "inherit", env: process.env }
    );
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ingest exited ${code}`))));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
