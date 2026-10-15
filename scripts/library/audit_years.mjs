#!/usr/bin/env node
/**
 * Do the release years survive an independent check? Looks up a sample of
 * songs on MusicBrainz and counts how often each kind of year is CONTRADICTED:
 * later than a release MusicBrainz documents. An original cannot postdate any
 * release of the same recording, so a later year is certainly wrong (or a
 * mismatched recording).
 *
 * That is the only direction MusicBrainz can judge. Its first-release date is
 * often a remaster's or re-recording's - "Jet" by Wings is dated 1995 there -
 * so a year EARLIER than MusicBrainz's is usually right, and how much earlier
 * says nothing about accuracy. Those columns are shown for information. Only
 * strictly matched songs count (clean titles, well-known artists), so this
 * says little about obscure uploads, which MusicBrainz mostly cannot match.
 *
 *   node scripts/library/audit_years.mjs --sample 300 [--seed 7] [--lang hi,pa] [--worst 25]
 *
 * "old" is the catalog's year before label_years.mjs ran (library/sources/
 * years/catalog-before.json), "a" / "b" / "c" the models' opinions ("c" only
 * exists for songs they disagreed on). The verdict stored in meta is not
 * scored: MusicBrainz's cap feeds into it, so it would pass by construction.
 * Same --sample/--seed/--lang as label_years.mjs picks the same songs.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSongs, loadVotes, pickScope } from "./label_years.mjs";
import { loadCache, lookupCached, saveCache } from "./musicbrainz.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIBRARY = process.env.LIBRARY_DIR || path.join(ROOT, "library");
const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const beforeFile = path.join(LIBRARY, "sources", "years", "catalog-before.json");
const before = new Map(
  existsSync(beforeFile) ? JSON.parse(readFileSync(beforeFile, "utf8")).tracks.map((r) => [r.id, r.year]) : []
);

const songs = await pickScope(await loadSongs());
const votes = loadVotes();
const cache = loadCache();
console.log(`${songs.length} songs in scope; MusicBrainz lookups run at one a second`);
let n = 0;
let unreachable = 0;
for (const m of songs) {
  const cached = m.id in cache;
  try {
    await lookupCached(cache, m);
  } catch {
    unreachable++; // not cached: asked again on the next run
  }
  if (!cached && ++n % 25 === 0) {
    saveCache(cache);
    console.log(`  ${n} looked up`);
  }
}
saveCache(cache);
if (unreachable) console.log(`  ${unreachable} lookups failed (MusicBrainz unreachable) - rerun to retry them`);

const kinds = {
  old: (m) => before.get(m.id) ?? null,
  a: (m) => votes.get(m.id)?.a?.y ?? null,
  b: (m) => votes.get(m.id)?.b?.y ?? null,
  c: (m) => votes.get(m.id)?.c?.y ?? null,
};
const pct = (x, d) => (d ? `${((100 * x) / d).toFixed(0)}%`.padStart(4) : "   -");

for (const lang of [...new Set(songs.map((m) => m.language))].sort()) {
  const group = songs.filter((m) => m.language === lang);
  const hits = group.filter((m) => cache[m.id]);
  const asked = group.filter((m) => m.id in cache);
  console.log(`\n${lang}: ${hits.length} of ${asked.length} looked-up songs matched by MusicBrainz (${pct(hits.length, asked.length).trim()})`);
  console.log("        songs   contradicted(>MB+1)   within +-1   earlier by 2-9   earlier by 10+");
  for (const [name, get] of Object.entries(kinds)) {
    const rows = hits.map((m) => get(m) != null && [get(m), cache[m.id].year]).filter(Boolean);
    if (!rows.length) continue;
    const d = rows.map(([y, t]) => y - t);
    const count = (f) => d.filter(f).length;
    console.log(
      `  ${name.padEnd(6)} ${String(rows.length).padStart(4)}        ${pct(count((x) => x > 1), rows.length)}              ${pct(count((x) => Math.abs(x) <= 1), rows.length)}          ${pct(count((x) => x <= -2 && x > -10), rows.length)}              ${pct(count((x) => x <= -10), rows.length)}`
    );
  }
}

const worst = Number(opt("worst", 0));
if (worst) {
  const rows = songs
    .filter((m) => cache[m.id] && m.releaseYear != null)
    .map((m) => ({ m, err: m.releaseYear - cache[m.id].year }))
    .filter((r) => r.err > 1)
    .sort((x, y) => y.err - x.err)
    .slice(0, worst);
  console.log(`\nverdicts later than MusicBrainz's first release (contradicted):`);
  for (const { m, err } of rows)
    console.log(
      `  +${String(err).padStart(2)}  final ${m.releaseYear} (${m.yearBy}/${m.yearConfidence}) mb ${cache[m.id].year}  ${m.artist.slice(0, 28)} - ${m.title.slice(0, 50)}`
    );
}
