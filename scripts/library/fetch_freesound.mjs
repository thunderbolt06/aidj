#!/usr/bin/env node
/**
 * Pull CC0 (public-domain) DJ elements from Freesound into
 * library/incoming/freesound/: transition FX one-shots and drum loops.
 *
 * Needs a free API key: https://freesound.org/apiv2/apply → FREESOUND_API_KEY
 * in .env.local. Only CC0 sounds are requested, so nothing here carries an
 * attribution or non-commercial condition. Downloads the HQ mp3 preview
 * (full-length for short sounds; originals need OAuth).
 *
 * Usage: npm run library:freesound [-- --per-query 25]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIBRARY = process.env.LIBRARY_DIR || path.join(ROOT, "library");
const OUT = path.join(LIBRARY, "incoming", "freesound");

function envKey() {
  if (process.env.FREESOUND_API_KEY) return process.env.FREESOUND_API_KEY;
  try {
    const m = /^FREESOUND_API_KEY=(.+)$/m.exec(readFileSync(path.join(ROOT, ".env.local"), "utf8"));
    return m?.[1].trim() ?? "";
  } catch {
    return "";
  }
}
const KEY = envKey();
if (!KEY) {
  console.error("FREESOUND_API_KEY is not set (free key: https://freesound.org/apiv2/apply)");
  process.exit(1);
}

const i = process.argv.indexOf("--per-query");
const PER_QUERY = i >= 0 ? Number(process.argv[i + 1]) : 25;

// [search text, kind, max seconds]
const QUERIES = [
  ["riser", "sfx", 12], ["uplifter", "sfx", 12], ["downlifter", "sfx", 10],
  ["impact hit", "sfx", 6], ["sub drop", "sfx", 6], ["air horn", "sfx", 5],
  ["vinyl scratch", "sfx", 5], ["record rewind", "sfx", 5], ["laser zap", "sfx", 3],
  ["crowd cheer", "sfx", 10], ["white noise sweep", "sfx", 10], ["snare roll", "sfx", 10],
  ["reverse cymbal", "sfx", 6], ["siren", "sfx", 6], ["vocal chop", "sfx", 4],
  ["drum loop", "loop", 20], ["house drum loop", "loop", 20], ["hip hop drum loop", "loop", 20],
  ["breakbeat loop", "loop", 20], ["percussion loop", "loop", 20], ["hi hat loop", "loop", 20],
];

mkdirSync(OUT, { recursive: true });
let saved = 0;
for (const [query, kind, maxDur] of QUERIES) {
  const params = new URLSearchParams({
    query,
    filter: `license:"Creative Commons 0" duration:[0.2 TO ${maxDur}]`,
    sort: "downloads_desc",
    fields: "id,name,username,tags,duration,previews,url",
    page_size: String(PER_QUERY),
    token: KEY,
  });
  const res = await fetch(`https://freesound.org/apiv2/search/text/?${params}`);
  if (!res.ok) {
    console.error(`  ${query}: search failed (${res.status})`);
    continue;
  }
  for (const s of (await res.json()).results ?? []) {
    const id = `fs-${s.id}`;
    const file = path.join(OUT, `${id}.mp3`);
    if (existsSync(file) || existsSync(path.join(LIBRARY, "meta", `${id}.json`))) continue;
    const url = s.previews?.["preview-hq-mp3"];
    if (!url) continue;
    const audio = await fetch(url);
    if (!audio.ok) continue;
    // loops tagged like "120bpm" tell us their tempo exactly
    const bpmTag = (s.tags ?? []).map((t) => /^(\d{2,3})\s?bpm$/i.exec(t)?.[1]).find(Boolean);
    writeFileSync(
      path.join(OUT, `${id}.json`),
      JSON.stringify({
        id,
        kind,
        title: s.name.replace(/\.(wav|mp3|aiff?|flac|ogg)$/i, ""),
        artist: s.username,
        genres: [kind === "loop" ? "Drum loop" : "FX"],
        tags: (s.tags ?? []).slice(0, 12),
        instrumental: true,
        popularity: 0,
        license: {
          name: "CC0 1.0 Universal",
          url: "https://creativecommons.org/publicdomain/zero/1.0/",
          commercialUse: true,
          derivatives: true,
        },
        source: "freesound",
        sourceUrl: s.url,
        ...(kind === "loop" && bpmTag ? { bpmHint: Number(bpmTag) } : {}),
      })
    );
    writeFileSync(file, Buffer.from(await audio.arrayBuffer()));
    saved++;
  }
  console.log(`  ${query}: ok (${saved} saved so far)`);
}
console.log(`done → ${OUT}\nnext: npm run library:ingest`);
