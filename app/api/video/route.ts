import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const exec = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

/**
 * Mux a rendered reel into a vertical 1080x1920 mp4 for Insta/YouTube Shorts.
 * Body: raw WAV audio. Query `meta`: JSON {clips: [{image, duration}]}.
 */
export async function POST(req: NextRequest) {
  const metaRaw = req.nextUrl.searchParams.get("meta");
  if (!metaRaw) return NextResponse.json({ error: "missing meta" }, { status: 400 });
  const meta = JSON.parse(metaRaw) as {
    clips: { image: string; duration: number }[];
  };
  const wav = Buffer.from(await req.arrayBuffer());
  if (!wav.length) return NextResponse.json({ error: "missing audio" }, { status: 400 });

  const dir = await mkdtemp(path.join(tmpdir(), "aidj-reel-"));
  try {
    const wavPath = path.join(dir, "mix.wav");
    await writeFile(wavPath, wav);

    // download thumbnails
    const imgPaths: string[] = [];
    for (let i = 0; i < meta.clips.length; i++) {
      const res = await fetch(meta.clips[i].image);
      if (!res.ok) throw new Error(`thumbnail ${i} failed`);
      const p = path.join(dir, `img${i}.jpg`);
      await writeFile(p, Buffer.from(await res.arrayBuffer()));
      imgPaths.push(p);
    }

    // one looping input per image + audio; scale/crop each to 1080x1920, concat
    const args: string[] = ["-y"];
    meta.clips.forEach((c, i) => {
      args.push("-loop", "1", "-t", String(Math.max(c.duration, 1)), "-i", imgPaths[i]);
    });
    args.push("-i", wavPath);
    const filters = meta.clips
      .map(
        (_, i) =>
          `[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,` +
          `crop=1080:1920,setsar=1,fps=30[v${i}]`
      )
      .join(";");
    const concat =
      meta.clips.map((_, i) => `[v${i}]`).join("") +
      `concat=n=${meta.clips.length}:v=1:a=0[vout]`;
    const out = path.join(dir, "reel.mp4");
    args.push(
      "-filter_complex",
      `${filters};${concat}`,
      "-map",
      "[vout]",
      "-map",
      `${meta.clips.length}:a`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      out
    );
    await exec(FFMPEG, args, { timeout: 240_000, maxBuffer: 16 * 1024 * 1024 });

    const mp4 = await readFile(out);
    return new NextResponse(new Uint8Array(mp4), {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": 'attachment; filename="aidj-reel.mp4"',
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "video render failed" },
      { status: 500 }
    );
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
