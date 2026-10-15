import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { extractJson } from "@/lib/server/extractJson";
import {
  libraryStats,
  pickForIntent,
  toTrack,
  type IntentFilter,
} from "@/lib/server/library";
import { loadVibeIndex, resolveVibes } from "@/lib/server/vibes";
import VIBES from "@/lib/vibes.json";

export const dynamic = "force-dynamic";

const STYLES = ["crossfade", "bass_swap", "filter_sweep", "echo_out", "cut"];

const SYSTEM = `You are the crate-digger for an AI-DJ app with a fixed music library. The user gives a
vibe in plain language ("singable road trip", "late night coding", "gym", "sad boi hours"). You do
NOT name songs - you translate the vibe into a filter over the library, and the app picks the tracks.

You are given the library's genres, moods and most common tags (with counts). Choose ONLY from those lists.
You may also be given a list of known vibes: each is backed by public playlists people made for it,
which know the vibe far better than genre tags do. Pick the 1-3 that best match the request (copy
them exactly), or none if nothing fits. Hindi and Punjabi vibes bring songs in that language: pick
them only when the request or the listener's languages ask for that language.

Respond with ONLY JSON:
{
  "vibe": "short name",
  "vibes": ["known vibes, best fit first"],
  "era": [fromYear, toYear] | null,   // only when the request names a time ("90s", "old school", "new releases")
  "energyArc": "flat" | "build" | "peak_and_release" | "wind_down",
  "transitionStyleHint": "crossfade" | "bass_swap" | "filter_sweep" | "echo_out" | "cut",
  "genres": ["2-6 genres from the list, best fit first"],
  "moods": ["1-4 moods from the list that the vibe should feel like"],
  "keywords": ["0-4 tags from the list that sharpen the vibe"],
  "intensity": [min, max],   // 0 = ambient, 1 = peak-time banger
  "bpm": [min, max] | null,
  "instrumental": true | false | null   // true only if the vibe needs no vocals (focus, study, sleep)
}`;

/** No API key / model hiccup: read the vibe off its keywords. */
function heuristicFilter(prompt: string, genres: string[], moods: string[]): IntentFilter & {
  vibe: string;
  transitionStyleHint: string;
} {
  const p = prompt.toLowerCase();
  const has = (...w: string[]) => w.some((x) => p.includes(x));
  const calm = has("chill", "calm", "relax", "sleep", "study", "focus", "lofi", "lo-fi", "sad", "rain", "night", "coding", "read");
  const hype = has("party", "hype", "gym", "workout", "run", "dance", "energy", "banger", "club", "rave", "pump");
  return {
    vibe: prompt.slice(0, 40),
    energyArc: hype ? "build" : calm ? "flat" : "peak_and_release",
    transitionStyleHint: hype ? "bass_swap" : "crossfade",
    genres: genres.filter((g) => p.includes(g.toLowerCase())),
    moods: moods.filter((m) => p.includes(m.toLowerCase())),
    keywords: p.split(/[^a-z0-9]+/).filter((w) => w.length > 3).slice(0, 4),
    intensity: calm ? [0, 0.5] : hype ? [0.65, 1] : [0.35, 0.8],
    instrumental: has("study", "focus", "coding", "sleep", "instrumental") ? true : null,
  };
}

/** "Known vibes: ..." with the language-specific ones labelled as such. */
function knownVibesLine(labels: string[]): string {
  const have = new Set(labels);
  const group = (name: string, list: string[]) => {
    const hit = list.filter((l) => have.has(l));
    return hit.length ? `${name}: ${hit.join("; ")}` : "";
  };
  return (
    "Known vibes - " +
    [group("any language", VIBES.general), group("Hindi", VIBES.hindi), group("Punjabi", VIBES.punjabi)]
      .filter(Boolean)
      .join(" | ") +
    "\n"
  );
}

export async function POST(req: NextRequest) {
  const { prompt, history, languages, recent, exclude } = await req.json();
  try {
    // facets of the chosen languages only, so the plan is built from genres
    // and tags those songs actually carry
    const [stats, index] = await Promise.all([libraryStats(languages), loadVibeIndex()]);
    const genreNames = stats.genres.map((g) => g.name);
    const moodNames = stats.moods.map((m) => m.name);
    const text = String(prompt ?? "");
    let plan: ReturnType<typeof heuristicFilter> & { vibes?: unknown } = heuristicFilter(text, genreNames, moodNames);
    // a tapped chip already names a vibe the playlists cover: no model call,
    // so the set starts as fast as the songs load
    const chip = index?.labels.includes(text.trim().toLowerCase()) ?? false;

    if (process.env.ANTHROPIC_API_KEY && !chip) {
      try {
        const client = new Anthropic();
        const msg = await client.messages.create({
          model: "claude-haiku-4-5",
          max_tokens: 400,
          system: SYSTEM,
          messages: [
            {
              role: "user",
              content:
                `Genres: ${stats.genres.map((g) => `${g.name} (${g.count})`).join(", ")}\n` +
                (stats.moods.length
                  ? `Moods: ${stats.moods.map((m) => `${m.name} (${m.count})`).join(", ")}\n`
                  : "") +
                `Tags: ${stats.tags.map((t) => t.name).join(", ")}\n` +
                (index?.labels.length ? knownVibesLine(index.labels) : "") +
                `Listener's languages: ${Array.isArray(languages) && languages.length ? languages.join(", ") : "any"}\n` +
                "\n" +
                (history ? `Previous vibe context: ${history}\n` : "") +
                `Vibe: ${prompt}`,
            },
          ],
        });
        const text = msg.content[0].type === "text" ? msg.content[0].text : "{}";
        const ai = extractJson(text) as typeof plan;
        if (Array.isArray(ai.genres)) plan = { ...plan, ...ai };
      } catch {
        /* keep the heuristic plan - a vibe request must never dead-end */
      }
    }

    const vibes = index ? resolveVibes(index, text, plan.vibes) : [];
    const pickOpts = { vibes, recent, exclude: Array.isArray(exclude) ? exclude : [] };
    let rows = await pickForIntent(plan, 10, languages, pickOpts);
    // a filter that matches nothing (tiny library, odd vibe) falls back to energy alone
    if (rows.length < 4)
      rows = await pickForIntent(
        { intensity: plan.intensity, energyArc: plan.energyArc },
        10,
        languages,
        { recent, exclude: pickOpts.exclude }
      );

    return NextResponse.json({
      vibe: plan.vibe,
      energyArc: plan.energyArc ?? "flat",
      transitionStyleHint: STYLES.includes(plan.transitionStyleHint)
        ? plan.transitionStyleHint
        : "crossfade",
      // the playlist vibes this set came from: send them back with refills
      // (/api/ai/suggest) and the queue keeps to the vibe
      vibes: vibes.map((v) => v.label),
      // exact `id:` lookups - callers resolve each through search as before
      queries: rows.map((r) => `id:${r.id}`),
      tracks: rows.map((r) => toTrack(r, req.nextUrl.origin)),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "intent failed" },
      { status: 503 }
    );
  }
}
