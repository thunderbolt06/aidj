#!/usr/bin/env node
/**
 * Claude checks the vibes before the pickers trust them.
 *
 *   playlists  A vibe is the YouTube playlists a search found for it, and a
 *              search for "bollywood party" also returns "Bollywood 90s Hits",
 *              "A. R. Rahman Collection" and "Self Love Songs Hindi" - so
 *              party sets played heartbreak ballads. Every harvested playlist
 *              is shown to Claude with its title, channel and a sample of its
 *              tracks, and kept only if it was made for that vibe. Verdicts:
 *              library/sources/vibes/judge/playlists.json (per vibe, language
 *              and playlist, so next month only judges new playlists).
 *              harvest_vibes.py leaves dropped playlists out of `wanted` and
 *              `index`.
 *
 *   profiles   What each vibe should feel like, from the library's mood list:
 *              the moods it wants, the moods that contradict it (a party has
 *              no room for "sad"), and its energy band. Written into
 *              lib/vibes.json `profiles`; the pickers gate on it.
 *
 *   node scripts/library/judge_vibes.mjs playlists [--only "bollywood party"] [--again]
 *   node scripts/library/judge_vibes.mjs profiles [--again]
 *
 * Never sends audio or lyrics - only names. Needs ANTHROPIC_API_KEY (env or .env.local).
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { GENRES, MOODS } from "./label_songs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIBRARY = process.env.LIBRARY_DIR || path.join(ROOT, "library");
const SRC = path.join(LIBRARY, "sources", "vibes");
const VERDICTS = path.join(SRC, "judge", "playlists.json");
const VIBES_FILE = path.join(ROOT, "lib", "vibes.json");
const MODEL = "claude-opus-5-5";
const SAMPLE = 30;
const PARALLEL = 4;
const LANG = { en: "English", hi: "Hindi", pa: "Punjabi" };

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const only = args.filter((a, i) => args[i - 1] === "--only");

function loadEnvKey() {
  if (process.env.ANTHROPIC_API_KEY) return;
  const file = path.join(ROOT, ".env.local");
  if (!existsSync(file)) return;
  const line = readFileSync(file, "utf8")
    .split("\n")
    .find((l) => l.startsWith("ANTHROPIC_API_KEY="));
  if (line) process.env.ANTHROPIC_API_KEY = line.slice("ANTHROPIC_API_KEY=".length).trim();
}

async function ask(client, system, content, effort = "medium") {
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    messages: [{ role: "user", content }],
  });
  if (res.stop_reason === "refusal") throw new Error(`refused: ${res.stop_details?.category ?? "?"}`);
  return res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(data, null, 1));
  await rename(`${file}.tmp`, file);
}

// ── playlists ──────────────────────────────────────────────────────────────

const PLAYLIST_SYSTEM = `You vet YouTube playlists for a DJ app. Each vibe chip ("road trip", "bollywood party",
"late night chill") draws its songs from public playlists a search found for it. A search returns
plenty of playlists that are NOT that vibe: generic hit lists ("Top Hindi Songs 2023", "Bollywood 90s
Hits"), one artist's or composer's collection, a different mood ("Self Love Songs" for a party), a
different genre ("Chill Country" for late night chill when the listener asked for another language),
devotional or kids' playlists, compilations of one label's uploads.

For each numbered playlist you get its title, channel and a sample of its tracks. Keep it only if
a listener who tapped the vibe would be happy with what this playlist mostly holds: the songs, not
just the title, have to fit the vibe's mood and energy, and be in the language asked for. A decade
or "hits" playlist is kept only when the vibe itself is about that decade or about hits.

Answer one line per playlist, nothing else:
<number>|keep or drop|<five to ten words why>`;

/** The month's search results: { label, lang, playlists }, newest month per vibe. */
async function searches() {
  const months = (await readdir(SRC)).filter((d) => /^\d{4}-\d{2}$/.test(d)).sort();
  const out = new Map();
  for (const m of months) {
    const dir = path.join(SRC, m, "search");
    if (!existsSync(dir)) continue;
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      const s = JSON.parse(await readFile(path.join(dir, f), "utf8"));
      out.set(`${s.label}|${s.lang}`, { ...s, month: m });
    }
  }
  return [...out.values()];
}

async function judgePlaylists(client) {
  const verdicts = existsSync(VERDICTS) ? JSON.parse(await readFile(VERDICTS, "utf8")) : {};
  const jobs = (await searches()).filter((s) => !only.length || only.includes(s.label));
  let next = 0;
  let kept = 0;
  let dropped = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const s = jobs[next++];
      const todo = [];
      for (const pid of s.playlists) {
        const key = `${s.label}|${s.lang}|${pid}`;
        if (verdicts[key] && !flag("again")) continue;
        const file = path.join(SRC, s.month, "playlists", `${pid}.json`);
        if (!existsSync(file)) continue;
        todo.push({ key, pl: JSON.parse(await readFile(file, "utf8")) });
      }
      if (!todo.length) continue;
      const blocks = todo.map(({ pl }, i) => {
        const tracks = pl.entries.slice(0, SAMPLE).map((e) => `   - ${e.title}`);
        return `${i + 1}. "${pl.title}" by ${pl.channel || "?"} (${pl.entries.length} tracks)\n${tracks.join("\n")}`;
      });
      try {
        const text = await ask(
          client,
          PLAYLIST_SYSTEM,
          `Vibe: "${s.label}"\nLanguage asked for: ${LANG[s.lang] ?? s.lang}\n\n${blocks.join("\n\n")}`
        );
        for (const line of text.split("\n")) {
          const m = /^\s*(\d+)\s*\|\s*(keep|drop)\s*\|(.*)$/i.exec(line);
          const job = m && todo[Number(m[1]) - 1];
          if (!job) continue;
          const keep = m[2].toLowerCase() === "keep";
          verdicts[job.key] = { keep, why: m[3].trim(), title: job.pl.title };
          if (keep) kept++;
          else dropped++;
        }
        await writeJson(VERDICTS, verdicts);
        process.stdout.write(`\r${next}/${jobs.length} vibes judged (${kept} kept, ${dropped} dropped)   `);
      } catch (e) {
        // a vibe the judge could not answer keeps all its playlists until the next run
        console.warn(`\n${s.label} (${s.lang}): ${e instanceof Error ? e.message : e}`);
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  console.log(`\nplaylists: ${kept} kept, ${dropped} dropped this run -> ${VERDICTS}`);
  // the vibes the cut leaves thin, for the next harvest to search wider
  const thin = [];
  for (const s of jobs) {
    const left = s.playlists.filter((pid) => verdicts[`${s.label}|${s.lang}|${pid}`]?.keep !== false);
    if (left.length < 4) thin.push(`${s.label} (${s.lang}): ${left.length}/${s.playlists.length}`);
  }
  if (thin.length) console.log(`thin after the cut (<4 playlists):\n  ${thin.join("\n  ")}`);
}

// ── profiles ───────────────────────────────────────────────────────────────

const PROFILE_SYSTEM = `You set the rules for a DJ app's vibe chips. Every song in the library carries 2-4
moods from this list: ${MOODS.join(", ")}
and 1-3 genres from this list: ${GENRES.join(", ")}.

For each vibe give:
- want: 3-6 moods a song for this vibe usually has
- avoid: moods that CONTRADICT the vibe - a song carrying any of them should almost never play in it
  (a party avoids sad / heartbreak / melancholic; a sleep or study vibe avoids hype / angry / party).
  Only list moods that are truly wrong for the vibe; a mood that is merely unusual is not "avoid".
  An empty list is fine for broad genre vibes ("pop", "indie rock").
- energy: [low, high] on 0..1, where 0 is the calmest song in the library and 1 the most intense;
  the library's middle half sits between 0.25 and 0.75. Keep the band at least 0.3 wide.
- vocals: "none" only when the vibe means music without singing (instrumental, focus, sleep,
  meditation, lo-fi beats, background music for videos); otherwise "any".
- genres: 1-4 genres from the list when the vibe is defined by its genre or style ("punjabi folk
  classics", "sufi night", "desi hip hop", "jazz", "coffee shop acoustic"), else "-".
- era: the release years the vibe is about ("70s evergreen" 1965-1984, "90s nostalgia"), else "-".

Answer one line per vibe, nothing else:
<number>|<want, comma separated>|<avoid, comma separated or ->|<low>-<high>|<any or none>|<genres or ->|<from-to or ->`;

async function writeProfiles(client) {
  const vibes = JSON.parse(await readFile(VIBES_FILE, "utf8"));
  const labels = [...new Set([...vibes.general, ...vibes.hindi, ...vibes.punjabi])];
  const profiles = flag("again") ? {} : { ...(vibes.profiles ?? {}) };
  const todo = labels.filter((l) => !profiles[l]);
  if (!todo.length) return console.log("profiles: every vibe has one (--again to redo)");
  const lower = new Map(MOODS.map((m) => [m.toLowerCase(), m]));
  const lowerGenre = new Map(GENRES.map((g) => [g.toLowerCase(), g]));
  const pickGenre = (raw) =>
    raw.trim() === "-" ? [] : [...new Set(raw.split(",").map((x) => lowerGenre.get(x.trim().toLowerCase())).filter(Boolean))];
  const moods = (raw) =>
    raw.trim() === "-" ? [] : [...new Set(raw.split(",").map((x) => lower.get(x.trim().toLowerCase())).filter(Boolean))];
  const text = await ask(
    client,
    PROFILE_SYSTEM,
    todo.map((l, i) => `${i + 1}. ${l}${vibes.hindi.includes(l) ? " (Hindi)" : vibes.punjabi.includes(l) ? " (Punjabi)" : ""}`).join("\n"),
    "high"
  );
  for (const line of text.split("\n")) {
    const m =
      /^\s*(\d+)\s*\|([^|]*)\|([^|]*)\|\s*([\d.]+)\s*-\s*([\d.]+)\s*(?:\|\s*(any|none)\s*)?(?:\|([^|]*))?(?:\|\s*(\d{4})\s*-\s*(\d{4}))?/i.exec(
        line
      );
    const label = m && todo[Number(m[1]) - 1];
    if (!label) continue;
    const lo = Math.max(0, Math.min(1, Number(m[4])));
    const hi = Math.max(lo, Math.min(1, Number(m[5])));
    profiles[label] = { want: moods(m[2]), avoid: moods(m[3]), energy: [lo, hi] };
    if (m[6]?.toLowerCase() === "none") profiles[label].instrumental = true;
    const genres = m[7] ? pickGenre(m[7]) : [];
    if (genres.length) profiles[label].genres = genres;
    if (m[8] && m[9]) profiles[label].era = [Number(m[8]), Number(m[9])];
  }
  // keep the file's key order; profiles go last, labels in chip order
  const ordered = Object.fromEntries(labels.filter((l) => profiles[l]).map((l) => [l, profiles[l]]));
  const doc =
    "profiles = per vibe, the moods its songs usually have (want), moods that contradict it (avoid: a song carrying one almost never plays in that vibe), its energy band on the library's 0..1 intensity percentile, instrumental: true when it wants no singing, genres when the vibe is a genre or style, and era when it is about certain years. Written by scripts/library/judge_vibes.mjs profiles; hand edits are kept (it only fills vibes without one unless --again).";
  const out = { ...vibes, _doc: vibes._doc.includes("profiles =") ? vibes._doc : `${vibes._doc} ${doc}`, profiles: ordered };
  await writeFile(VIBES_FILE, JSON.stringify(out, null, 2) + "\n");
  console.log(`profiles: ${Object.keys(ordered).length}/${labels.length} vibes -> lib/vibes.json`);
}

async function main() {
  const cmd = args[0];
  if (cmd !== "playlists" && cmd !== "profiles") {
    console.error("usage: judge_vibes.mjs playlists|profiles [--only LABEL] [--again]");
    process.exit(2);
  }
  loadEnvKey();
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY missing");
  const client = new Anthropic({ maxRetries: 5 });
  if (cmd === "playlists") await judgePlaylists(client);
  else await writeProfiles(client);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
