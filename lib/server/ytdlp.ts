import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HeatmapPoint, Track, TrackMeta } from "@/lib/types";

const exec = promisify(execFile);

const CACHE_DIR = path.join(process.cwd(), ".cache");
const AUDIO_DIR = path.join(CACHE_DIR, "audio");
const META_DIR = path.join(CACHE_DIR, "meta");

const YTDLP = process.env.YTDLP_PATH || "yt-dlp";

/**
 * Force IPv4. Many networks advertise IPv6 but have a broken/blackholed route
 * to Google/YouTube - yt-dlp then tries IPv6 first on every connection and
 * stalls ~per-request until it times out and falls back to IPv4. Those stalls
 * stack across the search + per-result fetches into 80–160s hangs that blow
 * past our exec timeouts. `-4` skips IPv6 entirely (search drops to ~1s).
 */
const YTDLP_BASE = ["-4", "--no-warnings"];

/**
 * When set, the heavy yt-dlp/ffmpeg work runs on the remote extractor service
 * (Railway) instead of locally - Vercel serverless can't run native binaries.
 * Unset (e.g. local dev with yt-dlp installed) → use the local binary.
 */
export const EXTRACTOR = (process.env.EXTRACTOR_URL || "").replace(/\/+$/, "");
const EXTRACTOR_TOKEN = process.env.EXTRACTOR_TOKEN || "";

/** Public, browser-facing audio URL on the extractor (Vercel redirects here). */
export function extractorAudioUrl(id: string): string {
  return `${EXTRACTOR}/audio/${id}`;
}

function extractorFetch(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`${EXTRACTOR}${pathname}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(EXTRACTOR_TOKEN ? { Authorization: `Bearer ${EXTRACTOR_TOKEN}` } : {}),
    },
  });
}

async function ensureDirs() {
  await mkdir(AUDIO_DIR, { recursive: true });
  await mkdir(META_DIR, { recursive: true });
}

export async function searchYouTube(query: string, limit = 8): Promise<Track[]> {
  if (EXTRACTOR) {
    const res = await extractorFetch(
      `/search?q=${encodeURIComponent(query)}&limit=${limit}`
    );
    if (!res.ok) throw new Error(`extractor search failed (${res.status})`);
    return (await res.json()).tracks as Track[];
  }
  const { stdout } = await exec(
    YTDLP,
    [
      ...YTDLP_BASE,
      `ytsearch${limit}:${query}`,
      "--dump-json",
      "--flat-playlist",
    ],
    { maxBuffer: 32 * 1024 * 1024, timeout: 30_000 }
  );
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const j = JSON.parse(line);
      return {
        id: j.id,
        title: j.title ?? "Unknown",
        artist: j.channel ?? j.uploader ?? "Unknown",
        duration: Math.round(j.duration ?? 0),
        thumbnail:
          j.thumbnails?.at(-1)?.url ??
          `https://i.ytimg.com/vi/${j.id}/hqdefault.jpg`,
      } satisfies Track;
    })
    // music videos only-ish: drop livestreams / >12min
    .filter((t) => t.duration > 30 && t.duration < 720);
}

/** Most-replayed peak, ignoring the first 10s (intros always spike). */
function famousStartFromHeatmap(heatmap: HeatmapPoint[]): number | null {
  const candidates = heatmap.filter((p) => p.start > 10);
  if (!candidates.length) return null;
  const peak = candidates.reduce((a, b) => (b.value > a.value ? b : a));
  return Math.round(peak.start);
}

export async function getTrackMeta(id: string): Promise<TrackMeta> {
  if (EXTRACTOR) {
    const res = await extractorFetch(`/meta/${id}`);
    if (!res.ok) throw new Error(`extractor meta failed (${res.status})`);
    return (await res.json()) as TrackMeta;
  }
  await ensureDirs();
  const metaPath = path.join(META_DIR, `${id}.json`);
  try {
    return JSON.parse(await readFile(metaPath, "utf8"));
  } catch {
    /* not cached */
  }

  const { stdout } = await exec(
    YTDLP,
    [...YTDLP_BASE, `https://www.youtube.com/watch?v=${id}`, "--dump-json"],
    { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }
  );
  const j = JSON.parse(stdout);
  const heatmap: HeatmapPoint[] = (j.heatmap ?? []).map(
    (p: { start_time: number; end_time: number; value: number }) => ({
      start: p.start_time,
      end: p.end_time,
      value: p.value,
    })
  );
  const meta: TrackMeta = {
    id,
    title: j.title ?? "Unknown",
    artist: j.artist ?? j.channel ?? j.uploader ?? "Unknown",
    duration: Math.round(j.duration ?? 0),
    thumbnail: j.thumbnail ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    heatmap,
    famousStart: famousStartFromHeatmap(heatmap),
  };
  await writeFile(metaPath, JSON.stringify(meta));
  return meta;
}

/** Download bestaudio as m4a (browser-decodable) and return the file path. */
export async function getAudioFile(id: string): Promise<string> {
  await ensureDirs();
  const existing = (await readdir(AUDIO_DIR)).find((f) =>
    f.startsWith(`${id}.`)
  );
  if (existing) return path.join(AUDIO_DIR, existing);

  try {
    await exec(
      YTDLP,
      [
        ...YTDLP_BASE,
        `https://www.youtube.com/watch?v=${id}`,
        "-f",
        "bestaudio[ext=m4a]/bestaudio",
        "-x",
        "--audio-format",
        "m4a",
        "-o",
        path.join(AUDIO_DIR, "%(id)s.%(ext)s"),
      ],
      { maxBuffer: 8 * 1024 * 1024, timeout: 180_000 }
    );
  } catch (e) {
    // yt-dlp breaks often (YouTube changes, missing deno for JS challenges,
    // PATH issues) - surface its stderr so the failure is diagnosable.
    const err = e as { stderr?: string; message?: string; code?: string };
    const reason =
      err.code === "ENOENT"
        ? `'${YTDLP}' not found on PATH (set YTDLP_PATH)`
        : (err.stderr || err.message || "yt-dlp failed").split("\n").filter(Boolean).slice(-2).join(" ");
    throw new Error(reason);
  }

  const file = (await readdir(AUDIO_DIR)).find((f) => f.startsWith(`${id}.`));
  if (!file) throw new Error(`extraction produced no file for ${id}`);
  return path.join(AUDIO_DIR, file);
}

/**
 * Audio bytes for `id`, regardless of mode - fetched from the extractor when
 * remote, read off local disk otherwise. Used by the stems route (which feeds
 * the audio to Replicate).
 */
export async function getAudioBytes(id: string): Promise<Buffer> {
  if (EXTRACTOR) {
    const res = await extractorFetch(`/audio/${id}`);
    if (!res.ok) throw new Error(`extractor audio failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
  return readFile(await getAudioFile(id));
}
