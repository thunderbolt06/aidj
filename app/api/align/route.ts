import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import OpenAI from "openai";
import { EXTRACTOR, getAudioFile } from "@/lib/server/ytdlp";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const exec = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const EXTRACTOR_TOKEN = process.env.EXTRACTOR_TOKEN || "";

/**
 * Produce a 16kHz mono mp3 window for Whisper , from the extractor's /clip
 * endpoint when remote (no ffmpeg on Vercel), or local ffmpeg otherwise.
 */
async function makeClip(
  id: string,
  windowStart: number,
  windowDur: number,
  out: string
): Promise<void> {
  if (EXTRACTOR) {
    const res = await fetch(
      `${EXTRACTOR}/clip?id=${id}&start=${Math.max(0, windowStart)}&dur=${windowDur}`,
      EXTRACTOR_TOKEN
        ? { headers: { Authorization: `Bearer ${EXTRACTOR_TOKEN}` } }
        : undefined
    );
    if (!res.ok) throw new Error(`extractor clip failed (${res.status})`);
    await writeFile(out, Buffer.from(await res.arrayBuffer()));
    return;
  }
  const file = await getAudioFile(id);
  await exec(
    FFMPEG,
    ["-y", "-ss", String(Math.max(0, windowStart)), "-t", String(windowDur),
     "-i", file, "-ac", "1", "-ar", "16000", "-b:a", "48k", out],
    { timeout: 30_000 }
  );
}

interface WordHit {
  word: string;
  start: number; // absolute seconds in the track
  end: number;
}

const memCache = new Map<string, WordHit[]>();

/**
 * Word-level audio alignment via Whisper: slice the window around a lyric
 * line out of the cached audio, transcribe with word timestamps, and return
 * every occurrence of the target word at its REAL sung position. This is
 * what lets Lyric DJ cut on the word's actual transient instead of guessing.
 */
export async function POST(req: NextRequest) {
  const { id, windowStart, windowDur, word } = (await req.json()) as {
    id: string;
    windowStart: number;
    windowDur: number;
    word: string;
  };
  if (!id || !word || windowDur > 60)
    return NextResponse.json({ error: "bad request" }, { status: 400 });

  const cacheKey = `${id}|${Math.round(windowStart)}|${word.toLowerCase()}`;
  const cached = memCache.get(cacheKey);
  if (cached) return NextResponse.json({ hits: cached });

  const slice = path.join(tmpdir(), `align-${id}-${Date.now()}.mp3`);
  try {
    await makeClip(id, windowStart, windowDur, slice);

    const openai = new OpenAI();
    const tr = (await openai.audio.transcriptions.create({
      file: createReadStream(slice),
      model: "whisper-1",
      response_format: "verbose_json",
      timestamp_granularities: ["word"],
    })) as unknown as { words?: { word: string; start: number; end: number }[] };

    const target = word.toLowerCase();
    const hits: WordHit[] = (tr.words ?? [])
      .filter((w) => {
        const norm = w.word.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
        return norm === target || norm.startsWith(target) || target.startsWith(norm);
      })
      .map((w) => ({
        word: w.word.trim(),
        start: windowStart + w.start,
        end: windowStart + w.end,
      }));

    memCache.set(cacheKey, hits);
    return NextResponse.json({ hits });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "alignment failed" },
      { status: 502 }
    );
  } finally {
    unlink(slice).catch(() => {});
  }
}
