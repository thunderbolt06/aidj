import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { text } = await req.json();
  if (!text) return NextResponse.json({ error: "missing text" }, { status: 400 });
  const openai = new OpenAI();
  const speech = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "ash",
    input: text,
    instructions:
      "You're a real late-night radio DJ live on air, NOT a voice assistant. " +
      "Loose and conversational — vary your pace, throw in small natural pauses, " +
      "drop word endings casually, react like you're vibing to the track behind you. " +
      "Slightly raspy, warm, never announcer-perfect. Occasionally trail off or chuckle.",
    response_format: "mp3",
  });
  const buf = Buffer.from(await speech.arrayBuffer());
  return new NextResponse(new Uint8Array(buf), {
    headers: { "Content-Type": "audio/mpeg" },
  });
}
