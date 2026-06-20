import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { EXTRACTOR, extractorAudioUrl, getAudioFile } from "@/lib/server/ytdlp";

export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  webm: "audio/webm",
  opus: "audio/ogg",
  mp3: "audio/mpeg",
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // remote mode: hand the browser straight to the extractor so the (multi-MB)
  // audio never round-trips through the Vercel function
  if (EXTRACTOR) return NextResponse.redirect(extractorAudioUrl(id), 302);
  try {
    const file = await getAudioFile(id);
    const ext = file.split(".").pop() ?? "m4a";
    const buf = await readFile(file);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": MIME[ext] ?? "audio/mp4",
        "Content-Length": String(buf.length),
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "audio failed" },
      { status: 500 }
    );
  }
}
