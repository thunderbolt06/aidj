import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export const dynamic = "force-dynamic";

const SYSTEM = `You design 2-song mashups for an AI DJ app. The user gives an intent — a prompt,
a singer, a year/era, or a theme. Pick TWO real, popular songs that will mash well together:
similar BPM (within ~10%), compatible keys/energy, and a reason the combination is delicious
(shared theme, contrast, nostalgia collision).

Decide the roles:
- "bed": the song providing groove/instrumental body
- "topper": the song providing the melody/vocal hook
And the structure:
- "layer": both play simultaneously (bed under topper)
- "alternate": hooks ping-pong every 8 bars (better when both are vocal-heavy)

Respond ONLY with JSON:
{"title": "catchy mashup name", "bed": "artist - song", "topper": "artist - song",
 "structure": "layer" | "alternate", "reasoning": "one fun sentence"}`;

export async function POST(req: NextRequest) {
  const { prompt } = await req.json();
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 400,
    system: SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });
  const text = msg.content[0].type === "text" ? msg.content[0].text : "{}";
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return NextResponse.json(JSON.parse(json));
  } catch {
    return NextResponse.json({ error: "invalid", raw: text }, { status: 502 });
  }
}
