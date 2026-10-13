import { NextRequest, NextResponse } from "next/server";
import { searchLibrary, type SearchOptions } from "@/lib/server/library";

export const dynamic = "force-dynamic";

/** Library search. Empty `q` returns the most popular entries (browse mode). */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const kind = (p.get("kind") ?? "song") as SearchOptions["kind"];
  const limit = Math.min(60, Math.max(1, Number(p.get("limit")) || 12));
  try {
    const languages = (p.get("lang") ?? "").split(",").filter(Boolean);
    const tracks = await searchLibrary(p.get("q") ?? "", req.nextUrl.origin, {
      kind,
      limit,
      languages,
    });
    return NextResponse.json({ tracks });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "search failed" },
      { status: 500 }
    );
  }
}
