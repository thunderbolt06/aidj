import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import type { TransitionPlan } from "@/lib/types";

export const dynamic = "force-dynamic";

const SYSTEM = `You are a world-class club DJ planning a single transition between two songs.
You receive analysis for track A (currently playing) and track B (next up): BPM, duration,
per-second energy (0-1), the YouTube "most replayed" famous section start, and the current
playhead position in A.

Pick the transition that will feel best to a casual listener:
- crossfade: safe default, melodic songs
- bass_swap: both tracks rhythmic and BPMs within ~8%
- filter_sweep: energy is rising into B's hook
- echo_out: big vibe change, tempo mismatch, or dramatic moment
- cut: only when B's hook hits instantly hard

Rules:
- outPoint: a natural exit in A, at or shortly after the current position (never before it), ideally at an energy dip or phrase end (~every 15-30s boundary).
- inPoint: start B slightly BEFORE its famous section so the hook lands right as the transition completes (inPoint ≈ famousStart - duration, min 0). If no famousStart, pick a high-energy point after intro.
- duration: 4-12s. cut = 0.1, echo_out = 6-8.
- beatMatch true only if BPMs within 8%.

Respond with ONLY a JSON object: {"style": "...", "outPoint": n, "inPoint": n, "duration": n, "beatMatch": bool, "reasoning": "one sentence, fun, DJ-speak"}`;

export async function POST(req: NextRequest) {
  const body = await req.json();
  const client = new Anthropic();

  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 400,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          trackA: body.trackA, // {title, bpm, duration, energy (downsampled), position}
          trackB: body.trackB, // {title, bpm, duration, energy, famousStart}
        }),
      },
    ],
  });

  const text = msg.content[0].type === "text" ? msg.content[0].text : "{}";
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    const plan = JSON.parse(json) as TransitionPlan;
    return NextResponse.json(plan);
  } catch {
    return NextResponse.json(
      { error: "model returned invalid plan", raw: text },
      { status: 502 }
    );
  }
}
