import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { extractJson } from "@/lib/server/extractJson";

export const dynamic = "force-dynamic";

const SYSTEM = `You suggest the next song for a live DJ set. Given the currently playing song
(and optionally a vibe), return 9 real, popular songs that would each transition well from it —
a spread: ~3 same-vibe safe picks, ~3 energy shifts (up or down), ~3 wildcard genre/era jumps
that still flow. Respond ONLY with JSON:
{"suggestions": [{"query": "artist - song name", "tag": "safe|shift|wild"} x9]}`;

export async function POST(req: NextRequest) {
  const { current, vibe } = await req.json();
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 700,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Now playing: ${current}${vibe ? `\nVibe: ${vibe}` : ""}`,
      },
    ],
  });
  const text = msg.content[0].type === "text" ? msg.content[0].text : "{}";
     try {
    return NextResponse.json(extractJson(text));
  } catch {
    return NextResponse.json({ error: "invalid", raw: text }, { status: 502 });
  }
}
