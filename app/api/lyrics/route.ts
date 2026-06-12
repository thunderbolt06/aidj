import { NextRequest, NextResponse } from "next/server";
import type { LyricLine } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Synced lyrics via lrclib.net (free, no key). */
export async function GET(req: NextRequest) {
  const track = req.nextUrl.searchParams.get("track");
  const artist = req.nextUrl.searchParams.get("artist") ?? "";
  if (!track) return NextResponse.json({ error: "missing track" }, { status: 400 });

  const url = `https://lrclib.net/api/search?q=${encodeURIComponent(
    `${track} ${artist}`.trim()
  )}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "AIDJ-experiments/0.1 (https://github.com)" },
  });
  if (!res.ok) return NextResponse.json({ lines: [], synced: false });

  const results = (await res.json()) as Array<{
    syncedLyrics?: string;
    plainLyrics?: string;
  }>;
  const hit = results.find((r) => r.syncedLyrics) ?? results[0];
  if (!hit) return NextResponse.json({ lines: [], synced: false });

  if (hit.syncedLyrics) {
    const lines: LyricLine[] = [];
    for (const line of hit.syncedLyrics.split("\n")) {
      const m = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/);
      if (m) {
        const text = m[3].trim();
        if (text) lines.push({ time: +m[1] * 60 + +m[2], text });
      }
    }
    return NextResponse.json({ lines, synced: true });
  }
  const lines: LyricLine[] = (hit.plainLyrics ?? "")
    .split("\n")
    .filter(Boolean)
    .map((text, i) => ({ time: i * 4, text }));
  return NextResponse.json({ lines, synced: false });
}
