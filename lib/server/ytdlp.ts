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

async function ensureDirs() {
  await mkdir(AUDIO_DIR, { recursive: true });
  await mkdir(META_DIR, { recursive: true });
}

export async function searchYouTube(query: string, limit = 8): Promise<Track[]> {
  const { stdout } = await exec(
    YTDLP,
    [
      `ytsearch${limit}:${query}`,
      "--dump-json",
      "--flat-playlist",
      "--no-warnings",
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
  await ensureDirs();
  const metaPath = path.join(META_DIR, `${id}.json`);
  try {
    return JSON.parse(await readFile(metaPath, "utf8"));
  } catch {
    /* not cached */
  }

  const { stdout } = await exec(
    YTDLP,
    [`https://www.youtube.com/watch?v=${id}`, "--dump-json", "--no-warnings"],
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

  await exec(
    YTDLP,
    [
      `https://www.youtube.com/watch?v=${id}`,
      "-f",
      "bestaudio[ext=m4a]/bestaudio",
      "-x",
      "--audio-format",
      "m4a",
      "-o",
      path.join(AUDIO_DIR, "%(id)s.%(ext)s"),
      "--no-warnings",
    ],
    { maxBuffer: 8 * 1024 * 1024, timeout: 180_000 }
  );

  const file = (await readdir(AUDIO_DIR)).find((f) => f.startsWith(`${id}.`));
  if (!file) throw new Error(`extraction produced no file for ${id}`);
  return path.join(AUDIO_DIR, file);
}
