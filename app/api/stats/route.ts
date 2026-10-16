import { NextRequest, NextResponse } from "next/server";
import { overview, vibeDetail } from "@/lib/server/vibeStats";

export const dynamic = "force-dynamic";

/**
 * The stats page's data: ?days=7|30|90 (default 30, 0 = all time) limits the
 * listening numbers; &vibe=<label> returns one vibe's detail instead.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const raw = Number(q.get("days") ?? 30);
  const days = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 3650) : null;
  try {
    const vibe = q.get("vibe");
    if (vibe) {
      const detail = await vibeDetail(vibe, days, req.nextUrl.origin);
      return detail
        ? NextResponse.json(detail)
        : NextResponse.json({ error: "unknown vibe" }, { status: 404 });
    }
    return NextResponse.json(await overview(days));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "stats unavailable" },
      { status: 503 }
    );
  }
}
