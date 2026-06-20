import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { extractJson } from "@/lib/server/extractJson";

export const dynamic = "force-dynamic";

const SYSTEM = `You suggest the next song for a live DJ set. Given the currently playing song
(and optionally a vibe), return 9 real, popular songs that would each transition well from it —
a spread: ~3 same-vibe safe picks, ~3 energy shifts (up or down), ~3 wildcard genre/era jumps
that still flow.

If an "arc" is given, the set is being paced along an energy curve and you must steer the WHOLE
batch toward arc.phase and arc.energy (0=ambient, 1=peak-time banger), targeting roughly the
arc.bpm window: "chill" → mellow/downtempo singalongs, "groovy" → mid-tempo movers, "hype" →
high-energy crowd-pleasers, "peak" → festival/club bangers and drops. Bias all 9 picks that way
(keep ~2 wildcards, but still at the target energy).

Respond ONLY with JSON:
{"suggestions": [{"query": "artist - song name", "tag": "safe|shift|wild"} x9]}`;

export async function POST(req: NextRequest) {
  const { current, vibe, arc } = await req.json();
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 700,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `Now playing: ${current}${vibe ? `\nVibe: ${vibe}` : ""}` +
          (arc
            ? `\nArc target: phase=${arc.phase}, energy=${arc.energy}, bpm≈${arc.bpm?.[0]}-${arc.bpm?.[1]}`
            : ""),
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
