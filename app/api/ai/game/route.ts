import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { extractJson } from "@/lib/server/extractJson";

export const dynamic = "force-dynamic";

const SYSTEM = `You pick songs for a 2-team party game: the instrumental plays and a team must SING
the lyrics to prove they know the song. The user gives a vibe prompt (possibly Hinglish).

Rules for your picks:
- Singable, popular PARTY songs fitting the vibe , songs where a room full of people
  plausibly knows the chorus words.
- Order them EASY → HARD. Easy = mega-famous, everyone can sing the hook instantly.
  Hard = still known, but only real fans can produce the lyrics.
- Mix global and Indian music when the prompt suggests it.

Respond with ONLY JSON:
{
  "gameName": "short playful name for this game round",
  "songs": [
    { "query": "artist + song name (a youtube search query for the real song)", "difficulty": 1 }
  ]
}
Return 14-18 songs, difficulty as integers 1 (easiest) to 10 (hardest), sorted ascending.`;

export async function POST(req: NextRequest) {
  const { prompt } = await req.json();
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1200,
    system: SYSTEM,
    messages: [{ role: "user", content: prompt || "singable party songs" }],
  });
  const text = msg.content[0].type === "text" ? msg.content[0].text : "{}";
  try {
    return NextResponse.json(extractJson(text));
  } catch {
    return NextResponse.json({ error: "invalid game plan", raw: text }, { status: 502 });
  }
}
