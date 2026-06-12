import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export const dynamic = "force-dynamic";

const SYSTEM = `You build a "lyric chain" DJ setlist. Given a seed song (title + lyrics),
pick 4 real, popular songs to follow it, where EACH consecutive pair shares a strong lyrical
connection — a common word/phrase, mirrored meaning, answered question, or same vivid image.
Strong, singable, well-known songs only (synced lyrics must plausibly exist). Keep language
consistent with the seed (Hindi seed → mostly Hindi chain is fine).

Respond ONLY with JSON:
{"chain": [{"query": "artist - song title", "connection": "what lyrically links it to the previous song"} x4]}`;

export async function POST(req: NextRequest) {
  const { title, lines } = await req.json();
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 700,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: JSON.stringify({ seed: title, lyrics: lines }),
      },
    ],
  });
  const text = msg.content[0].type === "text" ? msg.content[0].text : "{}";
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return NextResponse.json(JSON.parse(json));
  } catch {
    return NextResponse.json({ error: "invalid", raw: text }, { status: 502 });
  }
}
