import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { extractJson } from "@/lib/server/extractJson";
import {
  libraryStats,
  pickForIntent,
  toTrack,
  type IntentFilter,
} from "@/lib/server/library";

export const dynamic = "force-dynamic";

const STYLES = ["crossfade", "bass_swap", "filter_sweep", "echo_out", "cut"];

const SYSTEM = `You are the crate-digger for an AI-DJ app with a fixed music library. The user gives a
vibe in plain language ("singable road trip", "late night coding", "gym", "sad boi hours"). You do
NOT name songs - you translate the vibe into a filter over the library, and the app picks the tracks.

You are given the library's genres and most common tags (with counts). Choose ONLY from those lists.

Respond with ONLY JSON:
{
  "vibe": "short name",
  "energyArc": "flat" | "build" | "peak_and_release" | "wind_down",
  "transitionStyleHint": "crossfade" | "bass_swap" | "filter_sweep" | "echo_out" | "cut",
  "genres": ["2-6 genres from the list, best fit first"],
  "keywords": ["0-4 tags from the list that sharpen the vibe"],
  "intensity": [min, max],   // 0 = ambient, 1 = peak-time banger
  "bpm": [min, max] | null,
  "instrumental": true | false | null   // true only if the vibe needs no vocals (focus, study, sleep)
}`;

/** No API key / model hiccup: read the vibe off its keywords. */
function heuristicFilter(prompt: string, genres: string[]): IntentFilter & {
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
    keywords: p.split(/[^a-z0-9]+/).filter((w) => w.length > 3).slice(0, 4),
    intensity: calm ? [0, 0.5] : hype ? [0.65, 1] : [0.35, 0.8],
    instrumental: has("study", "focus", "coding", "sleep", "instrumental") ? true : null,
  };
}

export async function POST(req: NextRequest) {
  const { prompt, history, languages } = await req.json();
  try {
    // facets of the chosen languages only, so the plan is built from genres
    // and tags those songs actually carry
    const stats = await libraryStats(languages);
    const genreNames = stats.genres.map((g) => g.name);
    let plan = heuristicFilter(String(prompt ?? ""), genreNames);

    if (process.env.ANTHROPIC_API_KEY) {
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
                `Tags: ${stats.tags.map((t) => t.name).join(", ")}\n\n` +
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

    let rows = await pickForIntent(plan, 10, languages);
    // a filter that matches nothing (tiny library, odd vibe) falls back to energy alone
    if (rows.length < 4)
      rows = await pickForIntent(
        { intensity: plan.intensity, energyArc: plan.energyArc },
        10,
        languages
      );

    return NextResponse.json({
      vibe: plan.vibe,
      energyArc: plan.energyArc ?? "flat",
      transitionStyleHint: STYLES.includes(plan.transitionStyleHint)
        ? plan.transitionStyleHint
        : "crossfade",
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
