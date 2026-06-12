import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { extractJson } from "@/lib/server/extractJson";
import type { LyricLine } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Suggest a chain of songs that share exact sung words with the seed.
 *
 * IMPORTANT: never send full lyrics to the model or ask it to quote them —
 * the API's content filter blocks copyrighted lyric reproduction ("Output
 * blocked by content filtering policy"). We distill the lyrics to a bank of
 * distinctive words; the model only ever sees and returns single words.
 */

const STOP = new Set(
  `the a an and or but if so as at by to of in on for with from that this is are was were be been am it its do don't did not no yes oh ooh woah whoa yeah hey la na mm hmm i you he she we they me my your his her our them him us it's i'm you're we're they're ain't gonna wanna gotta got get just like can can't will won't all what when where who why how now then there here out up down over under again love baby night time heart feel know way`
    .split(/\s+/)
);

function wordBank(lines: LyricLine[], max = 60): string[] {
  const freq = new Map<string, number>();
  for (const l of lines) {
    for (const w of l.text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}' ]+/gu, " ")
      .split(/\s+/)) {
      if (w.length >= 3 && !STOP.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  // distinctive first: words the song actually leans on, longest/rarest up top
  return [...freq.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, max)
    .map(([w]) => w);
}

/** Words sung inside the famous section — the ones the crowd knows. */
function hookBank(lines: LyricLine[], famousStart: number | null): string[] {
  if (famousStart == null) return [];
  const hookLines = lines.filter(
    (l) => l.time >= famousStart - 3 && l.time <= famousStart + 40
  );
  return wordBank(hookLines, 25);
}

const SYSTEM = `You build a "lyric chain" DJ setlist. You get a seed song title and two word
banks from its lyrics: hookWords (sung in the song's MOST FAMOUS part — the part everyone
knows and sings along to) and otherWords. Pick 4 real, popular, singable songs where each
song's lyrics contain at least one EXACT word from the banks (the DJ cuts between songs on
that shared sung word).

STRONGLY prefer hookWords — a wordplay cut on a line the crowd is already singing hits far
harder than one on a deep-cut verse. Ideally the shared word also appears in the NEXT song's
chorus/hook. Prefer distinctive words over generic ones. Well-known songs only — synced
lyrics must plausibly exist on lrclib. Keep language consistent with the seed.

Respond ONLY with JSON (single words only, never lyric lines):
{"chain": [{"query": "artist - song title", "sharedWord": "the exact word from the bank"} x4]}`;

export async function POST(req: NextRequest) {
  const { title, lines, famousStart } = (await req.json()) as {
    title: string;
    lines: LyricLine[];
    famousStart?: number | null;
  };
  try {
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            seed: title,
            hookWords: hookBank(lines, famousStart ?? null),
            otherWords: wordBank(lines),
          }),
        },
      ],
    });
    const text = msg.content[0].type === "text" ? msg.content[0].text : "{}";
         const parsed = extractJson(text) as {
      chain: { query: string; sharedWord?: string }[];
    };
    return NextResponse.json({
      chain: parsed.chain.map((c) => ({
        query: c.query,
        sharedWord: c.sharedWord ?? null,
        connection: c.sharedWord ? `shares the word “${c.sharedWord}”` : "",
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "chain failed" },
      { status: 502 }
    );
  }
}
