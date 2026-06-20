import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { extractJson } from "@/lib/server/extractJson";
import Replicate from "replicate";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MUSICGEN =
  "meta/musicgen:671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837eedcfb";

const SYSTEM = `You write prompts for MusicGen (text-to-music) to create a short DJ bridge clip
that connects two songs. You get both songs' titles and BPMs. Describe instrumentation, genre
blend, energy, and tempo so the clip starts in song A's world and ends in song B's world.
One paragraph, concrete musical language, no song or artist names (MusicGen doesn't know them).
Respond ONLY with JSON: {"prompt": "...", "bpm": n}`;

export async function POST(req: NextRequest) {
  if (!process.env.REPLICATE_API_TOKEN) {
    return NextResponse.json(
      { error: "REPLICATE_API_TOKEN not set" },
      { status: 503 }
    );
  }
  const { a, b, duration = 10 } = await req.json();

  const claude = new Anthropic();
  const msg = await claude.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 300,
    system: SYSTEM,
    messages: [{ role: "user", content: JSON.stringify({ songA: a, songB: b }) }],
  });
  const text = msg.content[0].type === "text" ? msg.content[0].text : "{}";
  let prompt: string;
  let bpm: number;
  try {
    const j = extractJson(text) as { prompt: string; bpm?: number };
    prompt = j.prompt;
    bpm = j.bpm ?? a?.bpm ?? 120;
  } catch {
    prompt = `energetic DJ transition bridge, ${a?.bpm ?? 120} bpm, builds tension and releases`;
    bpm = a?.bpm ?? 120;
  }

  const replicate = new Replicate();
  let output: unknown;
  try {
    output = await replicate.run(MUSICGEN, {
      input: {
        prompt: `${prompt} ${bpm} bpm.`,
        duration: Math.min(Math.max(duration, 5), 20),
        model_version: "stereo-large",
        output_format: "mp3",
        normalization_strategy: "loudness",
      },
    });
  } catch (e) {
    // surface the real reason (e.g. "Insufficient credit") instead of a bare 500
    const msg = e instanceof Error ? e.message : "MusicGen call failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // replicate returns a URL (or FileOutput with .url())
  const url =
    typeof output === "string"
      ? output
      : (output as { url?: () => URL }).url?.().toString() ?? String(output);

  const audio = await fetch(url);
  if (!audio.ok) {
    return NextResponse.json({ error: "bridge fetch failed", url }, { status: 502 });
  }
  const buf = Buffer.from(await audio.arrayBuffer());
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "audio/mpeg",
      "X-Bridge-Prompt": encodeURIComponent(prompt),
    },
  });
}
