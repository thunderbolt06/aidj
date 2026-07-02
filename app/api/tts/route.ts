import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Lightning v3.1 , smallest.ai's fastest TTS model (sub-100ms), sync REST API.
const SMALLEST_URL = "https://api.smallest.ai/waves/v1/tts";
const VOICE_ID = "Edward";
const MODEL = "lightning_v3.1";

export async function POST(req: NextRequest) {
  const { text } = await req.json();
  if (!text) return NextResponse.json({ error: "missing text" }, { status: 400 });
  if (!process.env.SMALLEST_API_KEY)
    return NextResponse.json({ error: "SMALLEST_API_KEY not set" }, { status: 503 });

  const res = await fetch(SMALLEST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SMALLEST_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      voice_id: VOICE_ID,
      model: MODEL,
      sample_rate: 24000,
      output_format: "mp3",
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `smallest.ai tts failed (${res.status}): ${detail.slice(0, 300)}` },
      { status: 502 }
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return new NextResponse(new Uint8Array(buf), {
    headers: { "Content-Type": "audio/mpeg" },
  });
}
