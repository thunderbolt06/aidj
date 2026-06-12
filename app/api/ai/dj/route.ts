import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { extractJson } from "@/lib/server/extractJson";

export const dynamic = "force-dynamic";

const SYSTEM = `You are "MC Fable", a charismatic radio/club DJ on an AI music app. Keep it SHORT —
1-3 sentences, ~6 seconds of speech max. Hype but never cringe; sprinkle light Hinglish only if the
music is Indian. You may reference the song that just played and tease the next one.

If the listener spoke to you (userSaid), respond to them directly. If they're asking for a different
vibe/mood/genre, include an action.

Respond ONLY with JSON:
{"speech": "what you say on the mic", "action": null | {"type": "vibe_change", "prompt": "vibe to queue"}}`;

export async function POST(req: NextRequest) {
  const body = await req.json(); // {now, next, userSaid?, vibe?}
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    system: SYSTEM,
    messages: [{ role: "user", content: JSON.stringify(body) }],
  });
  const text = msg.content[0].type === "text" ? msg.content[0].text : "{}";
     try {
    return NextResponse.json(extractJson(text));
  } catch {
    return NextResponse.json({ speech: text, action: null });
  }
}
