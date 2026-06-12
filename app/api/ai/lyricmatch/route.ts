import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export const dynamic = "force-dynamic";

const SYSTEM = `You connect two songs through their lyrics for a DJ transition.
You get synced lyrics (time in seconds + text) for song A and song B. Find the single best
pair of lines — one in A (prefer later in the song), one in B (prefer near B's hook) — that
connect: shared words, mirrored meaning, answered question, same emotion, or a clever pun.
The transition will start at A's line and land on B's line.

Respond ONLY with JSON:
{"aTime": n, "aLine": "...", "bTime": n, "bLine": "...", "reasoning": "one fun sentence on why these lines connect"}`;

export async function POST(req: NextRequest) {
  const { a, b } = await req.json(); // each: {title, lines: [{time, text}]}
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 500,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: JSON.stringify({ songA: a, songB: b }),
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
