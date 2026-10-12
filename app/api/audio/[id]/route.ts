import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { getAudioFile, remoteAudioUrl } from "@/lib/server/library";

export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    // remote mode: hand the browser straight to the static host so the
    // (multi-MB) audio never round-trips through the serverless function
    const remote = await remoteAudioUrl(id);
    if (remote) return NextResponse.redirect(remote, 302);
    const file = await getAudioFile(id);
    const ext = file.split(".").pop() ?? "mp3";
    const buf = await readFile(file);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": MIME[ext] ?? "audio/mpeg",
        "Content-Length": String(buf.length),
        "Cache-Control": "public, max-age=604800, immutable",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "audio failed" },
      { status: 404 }
    );
  }
}
