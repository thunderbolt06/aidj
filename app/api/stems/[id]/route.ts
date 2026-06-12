import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import Replicate from "replicate";
import { getAudioFile } from "@/lib/server/ytdlp";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

const STEMS_DIR = path.join(process.cwd(), ".cache", "stems");

/**
 * Real stem separation via Replicate demucs (htdemucs, two-stem mode).
 * ?stem=vocals returns the vocal stem, ?stem=instrumental the rest.
 * Slow (1-4 min uncached) and needs Replicate credit — results are cached.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const stem = req.nextUrl.searchParams.get("stem") ?? "vocals";
  if (!["vocals", "instrumental"].includes(stem))
    return NextResponse.json({ error: "stem must be vocals|instrumental" }, { status: 400 });
  if (!process.env.REPLICATE_API_TOKEN)
    return NextResponse.json({ error: "REPLICATE_API_TOKEN not set" }, { status: 503 });

  await mkdir(STEMS_DIR, { recursive: true });
  const cachePath = path.join(STEMS_DIR, `${id}-${stem}.mp3`);
  try {
    const cached = await readFile(cachePath);
    return audioResponse(cached);
  } catch {
    /* not cached */
  }

  try {
    const file = await getAudioFile(id);
    const audio = await readFile(file);
    const replicate = new Replicate();

    // resolve latest version of the demucs model at call time
    const model = (await replicate.models.get("ryan5453", "demucs")) as {
      latest_version?: { id: string };
    };
    const version = model.latest_version?.id;
    if (!version) throw new Error("could not resolve demucs version");

    const output = (await replicate.run(
      `ryan5453/demucs:${version}` as `${string}/${string}:${string}`,
      {
        input: {
          audio: new Blob([new Uint8Array(audio)], { type: "audio/mp4" }),
          stem: "vocals", // two-stem mode: vocals + accompaniment
          output_format: "mp3",
        },
      }
    )) as Record<string, unknown>;

    // demucs two-stem output: { vocals: url, no_vocals/other: url }
    const pickUrl = (o: unknown): string | null => {
      if (typeof o === "string") return o;
      if (o && typeof (o as { url?: () => URL }).url === "function")
        return (o as { url: () => URL }).url().toString();
      return null;
    };
    // one demucs run yields BOTH stems — cache both so the sibling request
    // (e.g. instrumental after vocals) is free
    const instKey =
      ["no_vocals", "accompaniment", "other", "instrumental"].find(
        (k) => output[k]
      ) ?? "no_vocals";
    const urls = {
      vocals: pickUrl(output["vocals"]),
      instrumental: pickUrl(output[instKey]),
    };
    if (!urls[stem as "vocals" | "instrumental"])
      throw new Error(`no ${stem} stem in output: ${Object.keys(output)}`);

    let wanted: Buffer | null = null;
    for (const [name, url] of Object.entries(urls)) {
      if (!url) continue;
      const res = await fetch(url);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(path.join(STEMS_DIR, `${id}-${name}.mp3`), buf);
      if (name === stem) wanted = buf;
    }
    if (!wanted) throw new Error("stem download failed");
    return audioResponse(wanted);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "stem separation failed" },
      { status: 502 }
    );
  }
}

function audioResponse(buf: Buffer) {
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "public, max-age=604800",
    },
  });
}
