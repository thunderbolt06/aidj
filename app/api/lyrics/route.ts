import { NextRequest, NextResponse } from "next/server";
import type { LyricLine } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Synced lyrics via lrclib.net (free, no key).
 *
 * YouTube metadata is hostile to lyric lookup: `artist` is usually a channel
 * ("T-Series", "Latin City", "...VEVO") and titles carry junk ("(Official
 * Video)", "Full Video Song", en-dashes). So this route cleans aggressively,
 * tries several query strategies, and picks the best candidate , preferring
 * synced lyrics and matching the track duration when the client provides it.
 */

interface LrcHit {
  trackName?: string;
  artistName?: string;
  duration?: number;
  syncedLyrics?: string;
  plainLyrics?: string;
  instrumental?: boolean;
}

const memCache = new Map<string, { lines: LyricLine[]; synced: boolean }>();

const TITLE_JUNK =
  /\b(official|video|lyric(s|al)?|audio|visualizer|visualiser|hd|hq|4k|mv|m\/v|full\s+(video\s+)?song|remaster(ed)?(\s+\d{4})?|color\s+coded|cc|sub(s|titles)?|english|hindi|live|cover\s+art|music)\b/gi;
const CHANNEL_JUNK =
  /vevo|records|music|official|t-series|tips|series|entertainment|films|productions|channel|topic|sony|zee|saregama|label|city|vibe|nation|cloud|player|hits/i;

function cleanTitle(raw: string): string {
  return raw
    .replace(/[([{].*?[)\]}]/g, " ") // bracketed segments
    .replace(/[|/].*$/, " ") // everything after a pipe/slash
    .replace(/\b(ft\.?|feat\.?|featuring)\b.*$/i, " ") // featuring clause
    .replace(TITLE_JUNK, " ")
    .replace(/[–,]/g, "-") // normalize dashes
    .replace(/\s+/g, " ")
    .trim();
}

/** Try "Artist - Title" split from the video title itself. */
function splitTitle(clean: string): { artist: string; title: string } | null {
  const m = clean.match(/^(.{2,40}?)\s*-\s*(.{2,60})$/);
  if (!m) return null;
  return { artist: m[1].trim(), title: m[2].trim() };
}

async function lrclib(params: URLSearchParams): Promise<LrcHit[]> {
  try {
    const res = await fetch(`https://lrclib.net/api/search?${params}`, {
      headers: { "User-Agent": "AIDJ-experiments/0.1 (https://github.com)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    return (await res.json()) as LrcHit[];
  } catch {
    return [];
  }
}

function pickBest(hits: LrcHit[], wantDuration: number | null): LrcHit | null {
  const usable = hits.filter((h) => !h.instrumental && (h.syncedLyrics || h.plainLyrics));
  if (!usable.length) return null;
  const scored = usable.map((h) => {
    let score = h.syncedLyrics ? 100 : 0;
    if (wantDuration && h.duration) {
      const diff = Math.abs(h.duration - wantDuration);
      if (diff <= 5) score += 50;
      else if (diff <= 20) score += 25;
      else score -= 30;
    }
    return { h, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].h;
}

function parseSynced(synced: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const line of synced.split("\n")) {
    const m = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/);
    if (m) {
      const text = m[3].trim();
      if (text) lines.push({ time: +m[1] * 60 + +m[2], text });
    }
  }
  return lines;
}

export async function GET(req: NextRequest) {
  const rawTrack = req.nextUrl.searchParams.get("track");
  const rawArtist = req.nextUrl.searchParams.get("artist") ?? "";
  const duration = Number(req.nextUrl.searchParams.get("duration")) || null;
  if (!rawTrack) return NextResponse.json({ error: "missing track" }, { status: 400 });

  const cacheKey = `${rawTrack}|${rawArtist}|${duration ?? ""}`;
  const cached = memCache.get(cacheKey);
  if (cached) return NextResponse.json(cached);

  const clean = cleanTitle(rawTrack);
  const fromTitle = splitTitle(clean);
  const artistLooksReal = rawArtist && !CHANNEL_JUNK.test(rawArtist);

  // Query strategies, most precise first. Stop at the first synced hit.
  const attempts: URLSearchParams[] = [];
  if (fromTitle) {
    attempts.push(
      new URLSearchParams({ track_name: fromTitle.title, artist_name: fromTitle.artist })
    );
  }
  if (artistLooksReal) {
    attempts.push(
      new URLSearchParams({ track_name: clean.replace(/-/g, " "), artist_name: rawArtist })
    );
    attempts.push(new URLSearchParams({ q: `${clean} ${rawArtist}` }));
  }
  attempts.push(new URLSearchParams({ q: clean }));
  if (fromTitle) attempts.push(new URLSearchParams({ q: fromTitle.title }));

  let best: LrcHit | null = null;
  for (const params of attempts) {
    const hit = pickBest(await lrclib(params), duration);
    if (hit?.syncedLyrics) {
      best = hit;
      break;
    }
    best ??= hit; // remember a plain-lyrics fallback
  }

  let payload: { lines: LyricLine[]; synced: boolean };
  if (best?.syncedLyrics) {
    payload = { lines: parseSynced(best.syncedLyrics), synced: true };
  } else if (best?.plainLyrics) {
    payload = {
      lines: best.plainLyrics
        .split("\n")
        .filter(Boolean)
        .map((text, i) => ({ time: i * 4, text })),
      synced: false,
    };
  } else {
    payload = { lines: [], synced: false };
  }
  if (payload.lines.length) memCache.set(cacheKey, payload);
  return NextResponse.json(payload);
}
