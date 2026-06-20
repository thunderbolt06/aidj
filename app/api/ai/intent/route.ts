import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { extractJson } from "@/lib/server/extractJson";

export const dynamic = "force-dynamic";

const SYSTEM = `You are a music curator AI for an AI-DJ app. The user gives an intent/vibe in plain
language (possibly Hinglish), e.g. "singable road trip", "high energy party", "dirty", "sad boi hours",
"wedding sangeet". Produce a play queue plan.

Respond with ONLY JSON:
{
  "vibe": "short name",
  "energyArc": "flat" | "build" | "peak_and_release" | "wind_down",
  "transitionStyleHint": "crossfade" | "bass_swap" | "filter_sweep" | "echo_out" | "cut",
  "queries": ["youtube search query 1", "... 6-10 queries, each = artist + song name of a real popular song fitting the vibe, ordered to follow the energy arc"]
}
Pick real, popular, recognizable songs. Mix global and Indian music when the prompt suggests it.`;

export async function POST(req: NextRequest) {
  const { prompt, history } = await req.json();
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 800,
    system: SYSTEM,
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
