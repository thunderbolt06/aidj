import { NextResponse } from "next/server";
import { getTrackMeta } from "@/lib/server/ytdlp";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    return NextResponse.json(await getTrackMeta(id));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "meta failed" },
      { status: 500 }
    );
  }
}
