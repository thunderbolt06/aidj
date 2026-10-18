#!/usr/bin/env node
/**
 * The recommendation eval: does a vibe's set actually fit the vibe?
 *
 * With a handful of listeners, skip rates say nothing yet, so this is the
 * yardstick every picker change is measured against. For each vibe chip it
 * plays a seeded session the way the app does - the intent set of 10, then
 * refills of 6 from pickNext whenever fewer than 4 songs are left - and
 * scores the songs that came out:
 *
 *   fit       Claude judges every song for the vibe: 2 fits, 1 passable,
 *             0 wrong (mood, language, genre, or not the real song). Mean / 2.
 *             Verdicts are cached per (vibe, language, song), so a re-run only
 *             pays for songs it has not judged and before / after compare the
 *             same judge.
 *   off       share of songs the judge called wrong
 *   lang      share in another language than the session's
 *   old       share released before 2000 (era / timeless vibes excepted)
 *   distinct  distinct artists / songs
 *   sad       share of sad / heartbreak songs in a vibe whose profile bans them
 *
 *   npm run library:eval -- --tag before [--only "bollywood party"] [--songs 30] [--no-judge]
 *
 * Writes library/sources/eval/<tag>.json; `--compare before after` prints the
 * two side by side. Needs ANTHROPIC_API_KEY (env or .env.local) to judge.
 */
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import "./ts-hook.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIBRARY = process.env.LIBRARY_DIR || path.join(ROOT, "library");
const OUT = path.join(LIBRARY, "sources", "eval");
const JUDGE_CACHE = path.join(OUT, "judge.jsonl");
const MODEL = "claude-opus-5-5";
const LANG = { en: "English", hi: "Hindi", pa: "Punjabi" };

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

/** mulberry32: the same seed plays the same session, before and after a change. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** The sessions to play: every chip in its own language, the any-language ones in Hindi too. */
function configs(VIBES) {
  const out = [];
  for (const label of VIBES.general) out.push({ label, lang: "en" });
  for (const label of VIBES.anyLanguage ?? []) out.push({ label, lang: "hi" });
  for (const label of VIBES.hindi) out.push({ label, lang: "hi" });
  for (const label of VIBES.punjabi) out.push({ label, lang: "pa" });
  const only = args.filter((a, i) => args[i - 1] === "--only");
  return only.length ? out.filter((c) => only.includes(c.label)) : out;
}

/** The intent route's plan for a tapped chip (no model call): energy window and arc. */
function chipPlan(prompt) {
  const p = prompt.toLowerCase();
  const has = (...w) => w.some((x) => p.includes(x));
  const calm = has("chill", "calm", "relax", "sleep", "study", "focus", "lofi", "lo-fi", "sad", "rain", "night", "coding", "read");
  const hype = has("party", "hype", "gym", "workout", "run", "dance", "energy", "banger", "club", "rave", "pump");
  return {
    energyArc: hype ? "build" : calm ? "flat" : "peak_and_release",
    intensity: calm ? [0, 0.5] : hype ? [0.65, 1] : [0.35, 0.8],
    instrumental: has("study", "focus", "coding", "sleep", "instrumental") ? true : null,
  };
}

/** One session the way useAutoMix plays it. Returns the rows in play order. */
async function playSession(lib, vibesLib, { label, lang }, songs) {
  const index = await vibesLib.loadVibeIndex();
  const vibes = index ? vibesLib.resolveVibes(index, label) : [];
  const languages = [lang];
  const cat = await lib.loadCatalog();
  let queue = await lib.pickForIntent(chipPlan(label), 10, languages, { vibes });
  const played = [];
  const recent = [];
  for (let now = 0; played.length < songs && now < queue.length; now++) {
    const cur = queue[now];
    played.push(cur);
    recent.unshift(cur.id);
    if (queue.length - now - 1 < 4) {
      const picks = await lib.pickNext({
        current: `${cur.title} - ${cur.artist}`,
        languages,
        vibes: vibes.map((v) => v.label),
        recent,
        exclude: queue.slice(-150).map((r) => r.id),
      });
      const have = new Set(queue.map((r) => r.id));
      queue = [...queue, ...picks.slice(0, 6).map((p) => p.row).filter((r) => !have.has(r.id))];
    }
  }
  return { rows: played, vibes: vibes.map((v) => v.label), catSize: cat.tracks.length };
}

const JUDGE_SYSTEM = `You judge a DJ app's song picks. The listener tapped a vibe chip and the app played these songs.
For each numbered song say how well it fits THAT vibe for a listener who asked for songs in the given language:

2 = clearly fits (a good DJ would play it for this vibe)
1 = passable (not wrong, not what you would choose)
0 = wrong: the mood or energy contradicts the vibe (a sad ballad in a party set, a banger in a sleep set),
    the language is wrong, the genre is far off, or it is not a real song (a jukebox, an ad jingle,
    a wrongly matched upload, a devotional track in a party set)

Use what you know of the song; judge an unknown one from artist, title and year.
Answer one line per song, nothing else:
<number>|<0, 1 or 2>|<three to eight words why>`;

async function judge(client, cache, cfg, rows) {
  const key = (r) => `${cfg.label}|${cfg.lang}|${r.id}`;
  const todo = rows.filter((r) => !cache.has(key(r)));
  for (let i = 0; i < todo.length; i += 40) {
    const batch = todo.slice(i, i + 40);
    const lines = batch.map(
      (r, k) => `${k + 1}. ${r.artist} - ${r.title} | ${r.year ?? "year unknown"} | ${LANG[r.language] ?? r.language ?? "?"}`
    );
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: JUDGE_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Vibe: "${cfg.label}"\nLanguage asked for: ${LANG[cfg.lang]}\n\n${lines.join("\n")}`,
        },
      ],
    });
    const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const add = [];
    for (const line of text.split("\n")) {
      const m = /^\s*(\d+)\s*\|\s*([012])\s*\|(.*)$/.exec(line);
      const r = m && batch[Number(m[1]) - 1];
      if (!r) continue;
      const v = { k: key(r), score: Number(m[2]), why: m[3].trim() };
      cache.set(v.k, v);
      add.push(JSON.stringify(v));
    }
    if (add.length) await appendFile(JUDGE_CACHE, add.join("\n") + "\n");
  }
  return rows.map((r) => cache.get(key(r)) ?? null);
}

async function readCache() {
  const cache = new Map();
  if (!existsSync(JUDGE_CACHE)) return cache;
  for (const line of (await readFile(JUDGE_CACHE, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      cache.set(v.k, v);
    } catch {
      /* a half-written line from an interrupted run */
    }
  }
  return cache;
}

const SAD = new Set(["sad", "heartbreak", "melancholic"]);

function metrics(cfg, rows, verdicts, profile, ageless) {
  const n = rows.length || 1;
  const judged = verdicts.filter(Boolean);
  const bans = new Set((profile?.avoid ?? []).map((m) => m.toLowerCase()));
  const sadBanned = [...SAD].some((m) => bans.has(m));
  return {
    songs: rows.length,
    fit: judged.length ? judged.reduce((s, v) => s + v.score, 0) / (2 * judged.length) : null,
    off: judged.length ? judged.filter((v) => v.score === 0).length / judged.length : null,
    lang: rows.filter((r) => r.language !== cfg.lang).length / n,
    old: ageless ? null : rows.filter((r) => r.year && r.year < 2000).length / n,
    distinctArtists: new Set(rows.map((r) => r.artist)).size / n,
    distinctSongs: new Set(rows.map((r) => r.id)).size / n,
    sad: sadBanned ? rows.filter((r) => (r.moods ?? []).some((m) => SAD.has(m))).length / n : null,
  };
}

const mean = (xs) => {
  const v = xs.filter((x) => typeof x === "number");
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const pct = (x) => (x == null ? "  -  " : `${(100 * x).toFixed(0).padStart(3)}%`);

async function compare(a, b) {
  const A = JSON.parse(await readFile(path.join(OUT, `${a}.json`), "utf8"));
  const B = JSON.parse(await readFile(path.join(OUT, `${b}.json`), "utf8"));
  const keys = ["fit", "off", "lang", "old", "sad", "distinctArtists"];
  console.log(`${"vibe".padEnd(34)} ${keys.map((k) => `${k.slice(0, 8).padStart(8)} ${a.slice(0, 3)}>${b.slice(0, 3)}`).join(" ")}`);
  const byKey = new Map(B.sessions.map((s) => [`${s.label}|${s.lang}`, s]));
  const rows = A.sessions
    .map((s) => [s, byKey.get(`${s.label}|${s.lang}`)])
    .filter(([, t]) => t)
    .sort((x, y) => (x[0].m.fit ?? 1) - (y[0].m.fit ?? 1));
  for (const [s, t] of rows)
    console.log(
      `${`${s.label} (${s.lang})`.slice(0, 34).padEnd(34)} ${keys.map((k) => `${pct(s.m[k])} > ${pct(t.m[k])}`.padStart(16)).join(" ")}`
    );
  console.log(
    `${"MEAN".padEnd(34)} ${keys
      .map((k) => `${pct(mean(rows.map(([s]) => s.m[k])))} > ${pct(mean(rows.map(([, t]) => t.m[k])))}`.padStart(16))
      .join(" ")}`
  );
}

async function main() {
  if (flag("compare")) {
    const i = args.indexOf("--compare");
    return compare(args[i + 1], args[i + 2]);
  }
  const tag = opt("tag", "run");
  const songs = Number(opt("songs", 30));
  loadEnvKey();
  const judging = !flag("no-judge") && !!process.env.ANTHROPIC_API_KEY;
  if (!flag("no-judge") && !judging) console.warn("no ANTHROPIC_API_KEY: playing sessions without the judge");
  await mkdir(OUT, { recursive: true });

  const lib = await import("../../lib/server/library.ts");
  const vibesLib = await import("../../lib/server/vibes.ts");
  const VIBES = JSON.parse(await readFile(path.join(ROOT, "lib", "vibes.json"), "utf8"));
  const profiles = VIBES.profiles ?? {};
  const client = judging ? new Anthropic({ maxRetries: 5 }) : null;
  const cache = await readCache();

  const list = configs(VIBES);
  const sessions = [];
  const realRandom = Math.random;
  // sessions are played one at a time (Math.random is seeded per session),
  // then judged six at a time
  const played = [];
  for (const cfg of list) {
    Math.random = seeded(hash(`${cfg.label}|${cfg.lang}`));
    try {
      played.push({ cfg, ...(await playSession(lib, vibesLib, cfg, songs)) });
    } finally {
      Math.random = realRandom;
    }
  }
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < played.length) {
      const { cfg, rows, vibes } = played[next++];
      const verdicts = judging ? await judge(client, cache, cfg, rows) : rows.map(() => null);
      sessions.push({
        ...cfg,
        vibes,
        m: metrics(cfg, rows, verdicts, profiles[cfg.label], lib.ageless(cfg.label)),
        songs: rows.map((r, i) => ({
          id: r.id,
          artist: r.artist,
          title: r.title,
          year: r.year,
          language: r.language,
          moods: r.moods,
          verdict: verdicts[i] ? [verdicts[i].score, verdicts[i].why] : null,
        })),
      });
      process.stdout.write(`\r${++done}/${played.length} sessions judged`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  process.stdout.write("\n");

  const keys = ["fit", "off", "lang", "old", "sad", "distinctArtists"];
  const summary = Object.fromEntries(keys.map((k) => [k, mean(sessions.map((s) => s.m[k]))]));
  await writeFile(path.join(OUT, `${tag}.json`), JSON.stringify({ tag, at: new Date().toISOString(), songs, summary, sessions }, null, 1));
  const worst = [...sessions].sort((a, b) => (a.m.fit ?? 1) - (b.m.fit ?? 1)).slice(0, 12);
  for (const s of worst)
    console.log(`${`${s.label} (${s.lang})`.padEnd(40)} fit ${pct(s.m.fit)} off ${pct(s.m.off)} lang ${pct(s.m.lang)} sad ${pct(s.m.sad)}`);
  console.log(`\n${tag}: ${sessions.length} sessions - ${keys.map((k) => `${k} ${pct(summary[k])}`).join("  ")}`);
  console.log(`-> ${path.join(OUT, `${tag}.json`)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
