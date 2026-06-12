import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export const dynamic = "force-dynamic";

const SYSTEM = `You design multi-song mashups for an AI DJ app. The user gives an intent — a
prompt, a singer, a year/era, or a theme. Pick real, popular songs that mash well together:
similar BPM range (within ~10% of each other), compatible energy, recognizable hooks.

The first song is the BED (groove/instrumental body), the second is the first TOPPER
(melody/vocal hook). The rest are rotation candidates that will take turns layering in,
ordered for flow. If the intent names one artist (e.g. "Taylor Swift"), every song is by
that artist.

Also choose the structure:
- "layer": songs play simultaneously, layers rotating (default)
- "alternate": hooks ping-pong every 8 bars

Respond ONLY with JSON:
{"title": "catchy mashup name", "structure": "layer" | "alternate",
 "songs": ["artist - song" x6-8, bed first, first topper second],
 "reasoning": "one fun sentence"}`;

export async function POST(req: NextRequest) {
  const { prompt, exclude } = (await req.json()) as {
    prompt: string;
    exclude?: string[];
  };
  try {
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 600,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: exclude?.length
            ? `${prompt}\n\nAlready used (pick different songs): ${exclude.join(", ")}`
            : prompt,
        },
      ],
    });
    const text = msg.content[0].type === "text" ? msg.content[0].text : "{}";
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    return NextResponse.json(JSON.parse(json));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "design failed" },
      { status: 502 }
    );
  }
}
