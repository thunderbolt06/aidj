import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const exec = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const EXTRACTOR = (process.env.EXTRACTOR_URL || "").replace(/\/+$/, "");
const EXTRACTOR_TOKEN = process.env.EXTRACTOR_TOKEN || "";

const FONT_CANDIDATES = [
  process.env.FONT_PATH,
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/Library/Fonts/Arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
].filter(Boolean) as string[];

/** 1x1 dark PNG standing in for a cover that failed to download. */
const PLACEHOLDER_COVER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQV9cCAADxAHkS5TrzAAAAAElFTkSuQmCC",
  "base64"
);

/** A centered, bold burned-in caption filter - or "" if no usable font. */
function captionFilter(caption?: string): string {
  if (!caption) return "";
  const font = FONT_CANDIDATES.find((f) => existsSync(f));
  if (!font) return "";
  const safe = caption.replace(/[^\p{L}\p{N} '!?-]/gu, "").slice(0, 40);
  if (!safe) return "";
  return (
    `drawtext=fontfile='${font}':text='${safe}':` +
    `fontcolor=white:fontsize=110:borderw=7:bordercolor=black@0.85:` +
    `x=(w-text_w)/2:y=h*0.74`
  );
}

/**
 * Mux a rendered reel into a vertical 1080x1920 mp4 for Insta/YouTube Shorts.
 * Body: raw WAV audio. Query `meta`: JSON {clips: [{image, duration}]}.
 */
export async function POST(req: NextRequest) {
  const metaRaw = req.nextUrl.searchParams.get("meta");
  if (!metaRaw) return NextResponse.json({ error: "missing meta" }, { status: 400 });

  // remote mode: ffmpeg can't run on Vercel - forward to the extractor
  if (EXTRACTOR) {
    const body = await req.arrayBuffer();
    const res = await fetch(
      `${EXTRACTOR}/video?meta=${encodeURIComponent(metaRaw)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "audio/wav",
          ...(EXTRACTOR_TOKEN ? { Authorization: `Bearer ${EXTRACTOR_TOKEN}` } : {}),
        },
        body,
      }
    );
    return new NextResponse(res.body, {
      status: res.status,
      headers: {
        "Content-Type": res.headers.get("Content-Type") ?? "video/mp4",
        "Content-Disposition": 'attachment; filename="aidj-reel.mp4"',
      },
    });
  }

  const meta = JSON.parse(metaRaw) as {
    clips: { image: string; duration: number }[];
    caption?: string;
  };
  const wav = Buffer.from(await req.arrayBuffer());
  if (!wav.length) return NextResponse.json({ error: "missing audio" }, { status: 400 });

  const dir = await mkdtemp(path.join(tmpdir(), "aidj-reel-"));
  try {
    const wavPath = path.join(dir, "mix.wav");
    await writeFile(wavPath, wav);

    // download covers; a missing one becomes a flat placeholder so one 404
    // never costs the whole export
    const imgPaths: string[] = [];
    for (let i = 0; i < meta.clips.length; i++) {
      const res = await fetch(meta.clips[i].image).catch(() => null);
      const p = path.join(dir, `img${i}.jpg`);
      await writeFile(
        p,
        res?.ok ? Buffer.from(await res.arrayBuffer()) : PLACEHOLDER_COVER
      );
      imgPaths.push(p);
    }

    // one looping input per image + audio, concat'ed into 1080x1920. Covers are
    // square, so cropping one to portrait would drop ~44% of the art and blow
    // the rest up 4x: instead the cover sits sharp in the middle of a blurred,
    // darkened fill of itself. (The blur runs on a 1/10-size copy - cheap - and
    // the bicubic upscale finishes it.) Any aspect ratio fits inside the box.
    const args: string[] = ["-y"];
    meta.clips.forEach((c, i) => {
      args.push("-loop", "1", "-t", String(Math.max(c.duration, 1)), "-i", imgPaths[i]);
    });
    args.push("-i", wavPath);
    const filters = meta.clips
      .map(
        (_, i) =>
          `[${i}:v]split=2[bgsrc${i}][fgsrc${i}];` +
          `[bgsrc${i}]scale=108:192:force_original_aspect_ratio=increase,` +
          `crop=108:192,gblur=sigma=3,scale=1080:1920:flags=bicubic,` +
          `eq=brightness=-0.2:saturation=1.1[bg${i}];` +
          `[fgsrc${i}]scale=900:900:force_original_aspect_ratio=decrease[fg${i}];` +
          // a little above centre: clear of the caption and the Reels UI below
          `[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2-80,setsar=1,fps=30[v${i}]`
      )
      .join(";");
    // optional burned-in trigger-word caption (the viral callout)
    const cap = captionFilter(meta.caption);
    const concat =
      meta.clips.map((_, i) => `[v${i}]`).join("") +
      `concat=n=${meta.clips.length}:v=1:a=0` +
      (cap ? `[vbase];[vbase]${cap}[vout]` : `[vout]`);
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
