import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { extractJson } from "@/lib/server/extractJson";
import { languageHint } from "@/lib/server/langHint";

export const dynamic = "force-dynamic";

const SYSTEM = `You are an audio curator AI for an AI-DJ app. The user gives an intent/vibe in plain
language (possibly Hinglish), e.g. "singable road trip", "high energy party", "dirty", "sad boi hours",
"wedding sangeet", "afrobeats", "techno", "motivational speeches", "true crime podcast", "Zelda OST".
Produce a play queue plan. The app plays whatever real audio matches the request - it does NOT have to
be a song.

Content types you can pick, based on what the vibe actually calls for:
- Songs (the default): real, popular, recognizable tracks. Mix global and Indian music when the
  prompt suggests it. Covers genres too - afrobeats, techno, EDM/house/trance, K-pop, reggae, jazz,
  lo-fi, classical, qawwali, etc.
- Game/movie/TV soundtracks: real OST tracks by their actual title (e.g. "Zelda Breath of the Wild -
  Main Theme", "Interstellar - Cornfield Chase").
- Spoken word: motivational speeches, TED talks, famous monologues, comedy specials - use the real
  speaker/creator name + talk title as the query (e.g. "David Goggins - motivational speech",
  "Steve Jobs Stanford commencement speech").
- Podcasts: real, popular podcast clips or highlight segments - use "podcast name + topic/guest" as
  the query, favoring a clip/highlight over a full episode.
Pick queries that best match the vibe's content type; don't force a spoken-word or OST request into
song picks, and vice versa. Every result is capped around 12 minutes, so for speeches/podcasts pick
the famous clip or highlight, not the full-length original.

Respond with ONLY JSON:
{
  "vibe": "short name",
  "energyArc": "flat" | "build" | "peak_and_release" | "wind_down",
  "transitionStyleHint": "crossfade" | "bass_swap" | "filter_sweep" | "echo_out" | "cut",
  "queries": ["youtube search query 1", "... 6-10 queries, each a real findable-on-YouTube result fitting the vibe and its content type, ordered to follow the energy arc"]
}`;

export async function POST(req: NextRequest) {
  const { prompt, history, languages } = await req.json();
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 800,
    system: SYSTEM + languageHint(languages),
    messages: [
      {
        role: "user",
        content: history
          ? `Previous vibe context: ${history}\nNew request: ${prompt}`
          : prompt,
      },
    ],
  });
  const text = msg.content[0].type === "text" ? msg.content[0].text : "{}";
     try {
    return NextResponse.json(extractJson(text));
  } catch {
    return NextResponse.json({ error: "invalid plan", raw: text }, { status: 502 });
  }
}
