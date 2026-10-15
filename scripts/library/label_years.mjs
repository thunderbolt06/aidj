#!/usr/bin/env node
/**
 * Original release years for every song, from Claude, checked before they are
 * believed.
 *
 * The years the library arrived with are unreliable where it matters. Chart
 * songs carry their Billboard year, but about a third of the later downloads
 * carry none, and the Hindi / Punjabi ones carry a store decade ("2010s") or
 * a YouTube date - an upload or reissue date, so a 1976 film song reads 2024
 * and passes for recent. The pickers lean toward recent songs, so reissue
 * dates are exactly what lets old songs in among new ones.
 *
 * Every song gets two independent opinions on the year it was FIRST released:
 *
 *   a  claude-opus-5-5, shown the store / chart dates as clues (an upper bound:
 *      the original is that year or earlier, never later)
 *   b  claude-sonnet-5-5, shown only the names - no clue to anchor on
 *
 * Within TOL years of each other and consistent with the hard clues (see
 * `evidence`), they agree and the year stands. Otherwise
 *
 *   c  claude-opus-5-5 at high effort sees both answers plus the clues and
 *      decides
 *   d  MusicBrainz's first-release date caps what is still unsettled (it is
 *      often a remaster's date, so it can rule a year out but never in)
 *
 * Anything that cannot be settled keeps a best estimate marked low. Votes are
 * appended to library/sources/years/<stage>.jsonl (so a stage never pays twice
 * and the evidence stays inspectable); the verdict lands in library/meta/<id>.json
 * as `releaseYear`, `yearConfidence`, `yearBy`, `yearVotes`, which ingest.mjs
 * reads into the catalog's `year`.
 *
 *   npm run library:years [-- --stage a|b|c|d|resolve|report] [--sample 200 [--seed 7]]
 *                         [--lang hi,pa] [--ids file] [--limit N] [--mb-max 600] [--dry-run]
 *
 * Never sends lyrics - only names. Needs ANTHROPIC_API_KEY (env or .env.local).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { loadCache, lookupCached, saveCache } from "./musicbrainz.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIBRARY = process.env.LIBRARY_DIR || path.join(ROOT, "library");
const META = path.join(LIBRARY, "meta");
const VOTES = path.join(LIBRARY, "sources", "years");
const THIS_YEAR = new Date().getFullYear();
const TOL = 2; // two opinions this close are the same opinion
const BATCH = 60;
const PARALLEL = 5;
const MODELS = {
  a: { model: "claude-opus-5-5", effort: "low", price: [4, 20] },
  b: { model: "claude-sonnet-5-5", effort: "low", price: [2, 10] },
  c: { model: "claude-opus-5-5", effort: "high", price: [4, 20] },
};
const CONF_RANK = { s: 3, l: 2, g: 1 };
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

// ── What the library already says about a song's year ──────────────────────

/**
 * The clues, as bounds. Every date the library carries is a release date of
 * SOME edition - the original is never later - so each one caps the year. They
 * are not equally trustworthy:
 *
 *   hard   a Billboard year-end year, YouTube's release date, MusicBrainz's
 *          first release: a real release record. A year past it is out.
 *   soft   a store decade ("2010s") or a year-like tag: a section label or a
 *          loose match ("Pasoori" carries 2010s and 2020s; "Hookah Bar", a 2012
 *          film song, 2000s). Shown to the models as a clue, but opinions that
 *          agree with each other overrule it.
 *
 * `chart` (a Billboard year-end hit) also says it was recent when it charted.
 */
export function evidence(m, mb = null) {
  const tags = m.tags ?? [];
  // a chart / listing year is one or two tags; a long run of them ("1900, 1920,
  // 1940, ...") is a YouTube tag list, not a date
  let exact = tags.filter((t) => /^(19|20)\d\d$/.test(t)).map(Number);
  if (exact.length > 2 || exact.some((y) => y < 1925 || y > THIS_YEAR)) exact = [];
  const decades = tags
    .map((t) => /^((?:19|20)?\d0)s$/.exec(t)?.[1])
    .filter(Boolean)
    .map((d) => {
      const n = Number(d);
      return n < 100 ? (n >= 30 ? 1900 : 2000) + n : n;
    });
  const yt = Number.isInteger(m.year) && m.year >= 1900 && m.year <= THIS_YEAR ? m.year : null;
  const chart = tags.includes("hits") && exact.length ? Math.min(...exact) : null;
  const hard = [chart, yt, mb?.year ?? null].filter(Boolean);
  const soft = [chart ? null : exact.length ? Math.min(...exact) : null, ...decades.map((d) => d + 9)].filter(Boolean);
  const clues = [];
  if (chart) clues.push(`Billboard year-end ${chart}`);
  else if (exact.length) clues.push(`listed ${Math.min(...exact)}`);
  for (const d of decades) clues.push(`store decade ${d}s`);
  if (yt) clues.push(`YouTube date ${yt}`);
  // (MusicBrainz is never shown to the models: it only caps the year, see decide)
  return {
    hi: hard.length ? Math.min(...hard) : null,
    softHi: soft.length ? Math.min(...soft) : null,
    chart,
    clues: clues.join(", "),
  };
}

/** Is `y` possible at all for a song with these clues? (Only the hard caps count.) */
function possible(y, ev) {
  if (!Number.isInteger(y) || y < 1925 || y > THIS_YEAR) return false;
  return !(ev.hi && y > ev.hi);
}

/**
 * A hit that charted in N was out by N or shortly before; an older year means
 * a re-entry or a wrong pick - worth a second look, not worth believing unchecked.
 */
const chartOk = (y, ev) => !ev.chart || y >= ev.chart - 3;

const fits = (y, ev) => possible(y, ev) && chartOk(y, ev);

// ── Asking ─────────────────────────────────────────────────────────────────

const RULES = `Give the year each song was FIRST released: its original single, album or film
release - never a remaster, reissue, compilation, re-upload, lyric-video or cover date.

Each line is "artist - title | album | language | ..." and the names are often messy: a YouTube
channel as the artist, "(Lyrical)", "Full Video", "HD". Work out which song it really is first.
- Film songs (Hindi, Punjabi, ...): the year the FILM was released.
- A remake or recreated version by a different artist: the year of THIS recording.
- Confidence: s = you know this song and its year; l = sure of the artist and era, year within
  2; g = a guess from the artist, style and clues.
- Always give a year, even a guess.`;

const SYSTEMS = {
  a: `You date songs for a DJ app's music library.

${RULES}
- Clues after the language are dates the library holds: "listed", "store decade" and "YouTube date"
  are release dates of some EDITION, so the original is that year or EARLIER, never later (a
  "YouTube date 2024" on a classic is an upload date). "Billboard year-end N" means it was a hit
  in N, so it came out in N or shortly before.

Answer one line per song, nothing else:
<number>|<year>|<s, l or g>`,
  b: `You date songs for a DJ app's music library.

${RULES}

Answer one line per song, nothing else:
<number>|<year>|<s, l or g>`,
  c: `You date songs for a DJ app's music library. Two earlier opinions on each song disagree, or
conflict with the library's clues; settle it.

${RULES}
- Clues are as above: "listed", "store decade" and "YouTube date" are dates of some EDITION, so the
  original is that year or EARLIER; "Billboard year-end N" means a hit in N, released in N or
  shortly before.
- "A" and "B" are the earlier opinions (year and confidence). Either, both or neither may be right;
  decide from what you know of the song itself.

Answer one line per song, nothing else:
<number>|<year>|<s, l or g>`,
};

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s*\|\s*/g, " / ");

function lineFor(stage, m, i, votes) {
  let line =
    `${i}. ${clip(m.artist ?? "?", 80)} - ${clip(m.title ?? "?", 110)}` +
    ` | ${m.album ? clip(m.album, 60) : "-"} | ${LANG[m.language] ?? m.language ?? "?"}`;
  if (stage === "a" || stage === "c") line += ` | ${evidence(m).clues || "-"}`;
  if (stage === "c") {
    const v = votes.get(m.id) ?? {};
    const show = (x) => (x ? `${x.y} ${x.c}` : "none");
    line += ` | A: ${show(v.a)}, B: ${show(v.b)}`;
  }
  return line;
}

async function askBatch(client, stage, songs, votes) {
  const { model, effort } = MODELS[stage];
  const res = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    output_config: { effort },
    // a refusal is rerouted to a model that answers instead of losing the batch
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEMS[stage],
    messages: [{ role: "user", content: songs.map((m, i) => lineFor(stage, m, i + 1, votes)).join("\n") }],
  });
  if (res.stop_reason === "refusal") throw new Error(`refused: ${res.stop_details?.category ?? "?"}`);
  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const out = new Map();
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s*\|\s*(\d{4})\s*\|\s*([slg])/i.exec(line);
    const song = m && songs[Number(m[1]) - 1];
    if (song) out.set(song.id, { y: Number(m[2]), c: m[3].toLowerCase() });
  }
  return { out, usage: res.usage };
}

// ── Votes on disk ──────────────────────────────────────────────────────────

const voteFile = (stage) => path.join(VOTES, `${stage}.jsonl`);

export function loadVotes() {
  const votes = new Map();
  for (const stage of ["a", "b", "c"]) {
    if (!existsSync(voteFile(stage))) continue;
    for (const line of readFileSync(voteFile(stage), "utf8").split("\n")) {
      if (!line) continue;
      const { id, y, c } = JSON.parse(line);
      if (!votes.has(id)) votes.set(id, {});
      votes.get(id)[stage] = { y, c };
    }
  }
  return votes;
}

async function runStage(client, stage, songs, votes) {
  const todo = songs.filter((m) => !votes.get(m.id)?.[stage]);
  const { model, price } = MODELS[stage];
  console.log(`stage ${stage} (${model}): ${todo.length} of ${songs.length} songs to ask`);
  if (!todo.length || flag("dry-run")) return;
  mkdirSync(VOTES, { recursive: true });
  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  const totals = { asked: 0, answered: 0, failed: 0, input: 0, output: 0 };
  let next = 0;
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: PARALLEL }, async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        try {
          const { out, usage } = await askBatch(client, stage, batch, votes);
          totals.input += usage.input_tokens;
          totals.output += usage.output_tokens;
          for (const m of batch) {
            const v = out.get(m.id);
            if (!v) continue; // a skipped line is asked again next run
            if (!votes.has(m.id)) votes.set(m.id, {});
            votes.get(m.id)[stage] = v;
            appendFileSync(voteFile(stage), `${JSON.stringify({ id: m.id, ...v })}\n`);
            totals.answered++;
          }
          totals.asked += batch.length;
        } catch (e) {
          totals.failed += batch.length;
          console.error(`  batch failed: ${e.message}`);
        }
        const cost = (totals.input * price[0] + totals.output * price[1]) / 1e6;
        console.log(
          `  ${totals.asked + totals.failed}/${todo.length} answered ${totals.answered} failed ${totals.failed}` +
            ` ~$${cost.toFixed(2)} ${((Date.now() - t0) / 1000).toFixed(0)}s`
        );
      }
    })
  );
}

// ── Deciding ───────────────────────────────────────────────────────────────

const byConf = (x, y) => CONF_RANK[y.c] - CONF_RANK[x.c];

/**
 * The verdict for one song from its votes, or { needs: "c" | "d" } when the
 * evidence so far cannot settle it.
 */
export function decide(m, v = {}, mb = undefined) {
  // MusicBrainz's first-release date caps the year like any other date: it is
  // often a remaster's, so it can never say "earlier" - only rule out "later"
  const ev = evidence(m, mb);
  const ok = (x) => x && fits(x.y, ev);
  const near = (x, y) => x && y && Math.abs(x.y - y.y) <= TOL;
  const { a, b, c } = v;

  if (ok(a) && ok(b) && near(a, b)) {
    // equally sure: split the difference; otherwise the surer one
    const y = a.c === b.c ? Math.round((a.y + b.y) / 2) : [a, b].sort(byConf)[0].y;
    return { y, conf: CONF_RANK[a.c] >= 2 && CONF_RANK[b.c] >= 2 ? "high" : "medium", by: "agree" };
  }
  if (!c) return { needs: "c" };
  // a re-entry can legitimately be older than its chart year - if the arbiter is sure
  if (possible(c.y, ev) && (chartOk(c.y, ev) || c.c === "s")) {
    const backed = near(c, a) || near(c, b);
    if (backed || c.c !== "g") return { y: c.y, conf: backed ? "high" : "medium", by: "arbitrated" };
  }
  // unsettled by the models: MusicBrainz's cap gets a say before the estimate
  if (mb === undefined) return { needs: "d" };
  // nothing could settle it: the most plausible of the opinions, marked low
  const left = [a, b, c].filter(ok).sort(byConf);
  if (left.length) return { y: left[0].y, conf: "low", by: "estimate" };
  const cap = Math.min(...[ev.hi, ev.softHi].filter(Boolean), THIS_YEAR);
  if (ev.hi || ev.softHi) return { y: cap, conf: "low", by: mb && ev.hi === mb.year ? "musicbrainz" : "estimate" };
  return { y: null, conf: "low", by: "none" };
}

// ── Songs and meta ─────────────────────────────────────────────────────────

export async function loadSongs() {
  const files = (await readdir(META)).filter((f) => f.endsWith(".json"));
  const songs = [];
  for (let i = 0; i < files.length; i += 200) {
    const chunk = await Promise.all(
      files.slice(i, i + 200).map(async (f) => JSON.parse(await readFile(path.join(META, f), "utf8")))
    );
    for (const m of chunk) if (m.kind === "song") songs.push(m);
  }
  songs.sort((x, y) => (x.id < y.id ? -1 : 1));
  return songs;
}

/** mulberry32: a seeded shuffle, so a sample can be reproduced. */
function shuffled(list, seed) {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export async function pickScope(all) {
  let songs = all;
  const idsFile = opt("ids");
  if (idsFile) {
    const want = new Set(readFileSync(idsFile, "utf8").split(/\s+/).filter(Boolean));
    songs = songs.filter((m) => want.has(m.id));
  }
  const langs = opt("lang")?.split(",");
  if (langs) songs = songs.filter((m) => langs.includes(m.language));
  const sample = Number(opt("sample", 0));
  if (sample) songs = shuffled(songs, Number(opt("seed", 7))).slice(0, sample);
  const limit = Number(opt("limit", 0));
  return limit ? songs.slice(0, limit) : songs;
}

async function save(m, verdict, v) {
  const file = path.join(META, `${m.id}.json`);
  const meta = JSON.parse(await readFile(file, "utf8"));
  if (verdict.y == null) {
    delete meta.releaseYear;
  } else {
    meta.releaseYear = verdict.y;
  }
  meta.yearConfidence = verdict.conf;
  meta.yearBy = verdict.by;
  meta.yearVotes = { ...(v.a && { a: v.a.y }), ...(v.b && { b: v.b.y }), ...(v.c && { c: v.c.y }), ...(verdict.mb && { mb: verdict.mb }) };
  // atomic: an ingest may be reading meta/ at the same moment
  await writeFile(`${file}.tmp`, JSON.stringify(meta));
  await rename(`${file}.tmp`, file);
}

function run(cmd, cmdArgs) {
  return new Promise((resolve) => spawn(cmd, cmdArgs, { stdio: "inherit" }).on("close", resolve));
}

// ── Report: does every song's year hold up? ─────────────────────────────────

/**
 * The validation over everything in scope: each stored year must be possible
 * (a real year, not after any date the library holds for the song) and the
 * run says how each verdict was reached and what moved against the old catalog.
 */
function report(songs) {
  const beforeFile = path.join(VOTES, "catalog-before.json");
  const before = new Map(
    existsSync(beforeFile) ? JSON.parse(readFileSync(beforeFile, "utf8")).tracks.map((r) => [r.id, r.year]) : []
  );
  const by = {};
  const bad = [];
  let missing = 0;
  const moved = { total: 0, older10: 0, newer10: 0, filledIn: 0 };
  const eras = {};
  for (const m of songs) {
    if (m.releaseYear == null) {
      missing++;
      continue;
    }
    const lang = m.language ?? "?";
    const ev = evidence(m);
    // an "estimate" is allowed to break the soft chart bound, never the hard ones
    if (!possible(m.releaseYear, ev)) bad.push(m);
    by[lang] ??= {};
    const key = `${m.yearBy}/${m.yearConfidence}`;
    by[lang][key] = (by[lang][key] ?? 0) + 1;
    const old = before.get(m.id);
    if (old == null) moved.filledIn++;
    else if (old !== m.releaseYear) {
      moved.total++;
      if (old - m.releaseYear >= 10) moved.older10++;
      if (m.releaseYear - old >= 10) moved.newer10++;
    }
    const bucket = m.releaseYear < 1990 ? "<1990" : m.releaseYear < 2000 ? "1990s" : m.releaseYear < 2010 ? "2000s" : m.releaseYear < 2020 ? "2010s" : "2020s";
    eras[lang] ??= {};
    eras[lang][bucket] = (eras[lang][bucket] ?? 0) + 1;
  }
  console.log(`\nsongs without a verdict yet: ${missing} of ${songs.length}`);
  for (const [lang, k] of Object.entries(by)) console.log(`  ${lang} verdicts ${JSON.stringify(k)}`);
  for (const [lang, k] of Object.entries(eras)) console.log(`  ${lang} by era ${JSON.stringify(k)}`);
  console.log(
    `vs the old catalog: ${moved.filledIn} songs gained a year, ${moved.total} changed ` +
      `(${moved.older10} are 10+ years older now - reissue dates undone, ${moved.newer10} 10+ years newer)`
  );
  console.log(`impossible years (outside 1925-${THIS_YEAR} or later than a date the library holds): ${bad.length}`);
  for (const m of bad.slice(0, 15)) console.log(`  ${m.id} ${m.releaseYear} ${m.artist} - ${m.title}`);
  return bad.length;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  loadEnvKey();
  const stage = opt("stage", "all");
  const all = await loadSongs();
  const songs = await pickScope(all);
  console.log(`${all.length} songs in the library, ${songs.length} in scope`);
  const votes = loadVotes();
  const needKey = !flag("dry-run") && (stage === "all" || "abc".includes(stage));
  if (needKey && !process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic({ maxRetries: 5 });
  const wants = (s) => stage === "all" || stage === s;
  if (stage === "report") process.exit(report(songs) ? 1 : 0);

  if (wants("a")) await runStage(client, "a", songs, votes);
  if (wants("b")) await runStage(client, "b", songs, votes);
  if (wants("c")) {
    // MusicBrainz's cap (when it has been asked) can also overturn an agreement
    const cache = loadCache();
    const disputed = songs.filter((m) => {
      const v = votes.get(m.id);
      return v?.a && v.b && decide(m, v, m.id in cache ? cache[m.id] : undefined).needs === "c";
    });
    await runStage(client, "c", disputed, votes);
  }

  const mbCache = loadCache();
  if (wants("d")) {
    // MusicBrainz speaks only for what is still unsettled after the arbitration
    const open = songs.filter((m) => decide(m, votes.get(m.id), undefined).needs === "d");
    const cap = Number(opt("mb-max", 600));
    console.log(`stage d (MusicBrainz): ${open.length} unsettled, looking up ${Math.min(open.length, cap)}`);
    if (!flag("dry-run")) {
      let n = 0;
      for (const m of open.slice(0, cap)) {
        try {
          await lookupCached(mbCache, m);
        } catch (e) {
          console.error(`  ${m.id}: ${e.message}`); // asked again next run
        }
        if (++n % 25 === 0) saveCache(mbCache);
      }
      saveCache(mbCache);
    }
  }

  if (!(stage === "all" || ["c", "d", "resolve"].includes(stage))) return;
  const tally = {};
  let written = 0;
  for (const m of songs) {
    const v = votes.get(m.id);
    if (!v) continue;
    const mb = m.id in mbCache ? mbCache[m.id] : undefined;
    let verdict = decide(m, v, mb);
    // MusicBrainz was not asked (past --mb-max): settle for the estimate now, a
    // later run with a bigger budget upgrades it
    if (verdict.needs === "d") verdict = decide(m, v, null);
    // still waiting on the arbitration, which this run did not do: leave the song as it was
    if (verdict.needs) continue;
    if (mb) verdict = { ...verdict, mb: mb.year };
    const key = `${verdict.by}/${verdict.conf}`;
    tally[key] = (tally[key] ?? 0) + 1;
    if (m.releaseYear === verdict.y && m.yearBy === verdict.by && m.yearConfidence === verdict.conf) continue;
    if (!flag("dry-run")) await save(m, verdict, v);
    written++;
  }
  console.log(`verdicts ${JSON.stringify(tally)}; ${written} meta files ${flag("dry-run") ? "would change" : "updated"}`);
  if (!flag("dry-run") && written)
    // the catalog is what the app reads
    await run(process.execPath, [
      "--experimental-strip-types",
      "--no-warnings",
      path.join(ROOT, "scripts/library/ingest.mjs"),
      "--index-only",
    ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
