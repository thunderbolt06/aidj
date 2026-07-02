import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { extractJson } from "@/lib/server/extractJson";
import type { LyricLine } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Find the lyric handoff between song A and song B.
 *
 * Exact-word matches are computed deterministically here (the "sing the same
 * word into the next song" effect must actually be exact - an LLM guessing
 * lines defeats the point). Claude is only the fallback when the two songs
 * genuinely share no usable words, where a semantic/rhyme match is better
 * than nothing.
 */

const STOP = new Set(
  `the a an and or but if so as at by to of in on for with from that this is are was were be been am it its do don't did not no yes oh ooh woah whoa yeah hey la na mm hmm i you he she we they me my your his her our them him us it's i'm you're we're they're ain't gonna wanna gotta got get just like can can't will won't all what when where who why how now then there here out up down over under again about let's okay come came make say said well much too very really still only even one two know going make`
    .split(/\s+/)
);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

interface Match {
  aIdx: number;
  bIdx: number;
  shared: string;
  score: number;
}

function exactMatch(
  aLines: LyricLine[],
  bLines: LyricLine[],
  bFamous: number | null,
  aFamous: number | null,
  preferWord: string | null
): Match | null {
  // word frequency across both songs - rare words make better hooks
  const freq = new Map<string, number>();
  const aTokens = aLines.map((l) => tokenize(l.text));
  const bTokens = bLines.map((l) => tokenize(l.text));
  for (const toks of [...aTokens, ...bTokens])
    for (const w of toks) freq.set(w, (freq.get(w) ?? 0) + 1);

  const bIndex = new Map<string, number[]>();
  bTokens.forEach((toks, i) => {
    for (const w of new Set(toks)) {
      const arr = bIndex.get(w) ?? [];
      arr.push(i);
      bIndex.set(w, arr);
    }
  });

  const aDur = aLines[aLines.length - 1]?.time ?? 0;
  // accumulator object: TS can't narrow a `let` captured by the closures below
  const acc: { best: Match | null } = { best: null };

  aTokens.forEach((toks, aIdx) => {
    const aT = aLines[aIdx].time;
    // leave from the middle/late part of A, but not the very last line
    let aPosScore =
      aT > aDur * 0.25 && aT < aDur * 0.9 ? 2 : aT >= aDur * 0.9 ? -2 : 0;
    // HOOK BIAS: a word sung inside A's famous section resonates hardest,
    // the crowd is already singing along when the stutter grabs it
    if (aFamous != null && aT >= aFamous - 3 && aT <= aFamous + 40)
      aPosScore += 5;
    for (const w of new Set(toks)) {
      for (const bIdx of bIndex.get(w) ?? []) {
        const bT = bLines[bIdx].time;
        if (bT < 8) continue; // don't land on a cold intro line
        let score = 4 / Math.sqrt(freq.get(w) ?? 1) + Math.min(w.length, 9) * 0.3 + aPosScore;
        // the chain AI suggested this word as the link - trust it first
        if (preferWord && w === preferWord) score += 6;
        // land B near its hook when we know where that is
        if (bFamous != null)
          score += Math.max(0, 3 - Math.abs(bT - bFamous) / 12);
        // bigram bonus: two consecutive shared words = a shared phrase
        const aSet = toks;
        const bSet = bTokens[bIdx];
        for (let i = 0; i < aSet.length - 1; i++) {
          for (let j = 0; j < bSet.length - 1; j++) {
            if (aSet[i] === bSet[j] && aSet[i + 1] === bSet[j + 1]) score += 6;
          }
        }
        if (!acc.best || score > acc.best.score)
          acc.best = { aIdx, bIdx, shared: w, score };
      }
    }
  });

  return acc.best && acc.best.score >= 4 ? acc.best : null;
}

export async function POST(req: NextRequest) {
  const { a, b, bFamous, aFamous, preferWord } = (await req.json()) as {
    a: { title: string; lines: LyricLine[] };
    b: { title: string; lines: LyricLine[] };
    bFamous?: number | null;
    aFamous?: number | null;
    preferWord?: string | null;
  };

  const exact = exactMatch(
    a.lines,
    b.lines,
    bFamous ?? null,
    aFamous ?? null,
    preferWord?.toLowerCase().trim() ?? null
  );
  if (exact) {
    const aLine = a.lines[exact.aIdx];
    const bLine = b.lines[exact.bIdx];
    return NextResponse.json({
      aTime: aLine.time,
      aLine: aLine.text,
      bTime: bLine.time,
      bLine: bLine.text,
      sharedWord: exact.shared,
      exact: true,
      reasoning: `Both songs sing “${exact.shared}” - A hands the word straight to B.`,
    });
  }

  // No exact shared word: let Claude pick a semantic connection - but it must
  // answer with line INDICES only. Asking it to quote lyric lines trips the
  // API content filter ("Output blocked by content filtering policy").
  try {
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 300,
      system: `You connect two songs for a DJ transition using their numbered lyric lines.
Pick the single best pair - one line index from A (mid-to-late, never the final line), one
from B (near the hook, not the first seconds) - that connect by meaning, emotion, rhyme,
or pun. The transition plays A's line fully, then lands on B's line.

Respond ONLY with JSON (indices only - NEVER quote any lyric text):
{"aIdx": n, "bIdx": n, "reasoning": "one short sentence, no lyric quotes"}`,
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            songA: { title: a.title, lines: a.lines.map((l, i) => ({ i, text: l.text })) },
            songB: { title: b.title, lines: b.lines.map((l, i) => ({ i, text: l.text })) },
          }),
        },
      ],
    });
    const text = msg.content[0].type === "text" ? msg.content[0].text : "{}";
         const { aIdx, bIdx, reasoning } = extractJson(text) as {
      aIdx: number;
      bIdx: number;
      reasoning: string;
    };
    const aLine = a.lines[aIdx] ?? a.lines[Math.floor(a.lines.length / 2)];
    const bLine = b.lines[bIdx] ?? b.lines[Math.floor(b.lines.length / 3)];
    return NextResponse.json({
      aTime: aLine.time,
      aLine: aLine.text,
      bTime: bLine.time,
      bLine: bLine.text,
      sharedWord: null,
      exact: false,
      reasoning,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "match failed" },
      { status: 502 }
    );
  }
}
