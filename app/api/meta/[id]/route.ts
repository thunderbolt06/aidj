import { NextRequest, NextResponse } from "next/server";
import { getTrackMeta } from "@/lib/server/library";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    return NextResponse.json(await getTrackMeta(id, req.nextUrl.origin), {
      // analysis is immutable once ingested
      headers: { "Cache-Control": "public, max-age=3600" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "meta failed" },
      { status: 404 }
    );
  }
}
