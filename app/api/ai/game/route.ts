import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { extractJson } from "@/lib/server/extractJson";
import { knownSongs } from "@/lib/server/library";

export const dynamic = "force-dynamic";

const SYSTEM = `You pick songs for a 2-team party game: the instrumental plays and a team must SING
the lyrics to prove they know the song. The user gives a vibe prompt (possibly Hinglish).

Rules for your picks:
- Singable, popular PARTY songs fitting the vibe - songs where a room full of people
  plausibly knows the chorus words.
- Order them EASY → HARD. Easy = mega-famous, everyone can sing the hook instantly.
  Hard = still known, but only real fans can produce the lyrics.
- You are given the numbered list of songs the app actually has. Pick ONLY from that list,
  by number - a song that is not on it cannot be played.

Respond with ONLY JSON:
{
  "gameName": "short playful name for this game round",
  "songs": [
    { "n": <number from the list>, "difficulty": 1 }
  ]
}
Return 14-18 songs, difficulty as integers 1 (easiest) to 10 (hardest), sorted ascending.`;

export async function POST(req: NextRequest) {
  const { prompt, languages } = await req.json();
  try {
    const songs = await knownSongs(500, languages);
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1200,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content:
            `Available songs:\n${songs.map((r, i) => `${i + 1}. ${r.artist} - ${r.title}`).join("\n")}` +
            `\n\nVibe: ${prompt || "singable party songs"}`,
        },
      ],
    });
    const text = msg.content[0].type === "text" ? msg.content[0].text : "{}";
    const plan = extractJson(text) as {
      gameName?: string;
      songs?: { n: number; difficulty: number }[];
    };
    return NextResponse.json({
      gameName: plan.gameName ?? "Sing-It Showdown",
      // exact `id:` lookups - the page resolves each through search as before
      songs: (plan.songs ?? [])
        .filter((p) => songs[p.n - 1])
        .map((p) => ({ query: `id:${songs[p.n - 1].id}`, difficulty: p.difficulty })),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "invalid game plan" },
      { status: 502 }
    );
  }
}
