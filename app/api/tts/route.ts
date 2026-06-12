import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { text } = await req.json();
  if (!text) return NextResponse.json({ error: "missing text" }, { status: 400 });
  const openai = new OpenAI();
  const speech = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "verse",
    input: text,
    instructions:
      "Energetic club DJ on a mic, talking over music. Fast, punchy, charismatic.",
    response_format: "mp3",
  });
  const buf = Buffer.from(await speech.arrayBuffer());
  return new NextResponse(new Uint8Array(buf), {
    headers: { "Content-Type": "audio/mpeg" },
  });
}
