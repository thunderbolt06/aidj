import { NextRequest, NextResponse } from "next/server";
import { searchYouTube } from "@/lib/server/ytdlp";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q");
  if (!q) return NextResponse.json({ error: "missing q" }, { status: 400 });
  try {
    const tracks = await searchYouTube(q);
    return NextResponse.json({ tracks });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "search failed" },
      { status: 500 }
    );
  }
}
