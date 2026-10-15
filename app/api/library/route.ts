import { NextResponse } from "next/server";
import { libraryStats } from "@/lib/server/library";

export const dynamic = "force-dynamic";

/** Library size + genre / tag / licence facets, for browse UIs. */
export async function GET() {
  try {
    // the catalog only changes on ingest, so let the CDN answer repeat visits
    // instead of every cold instance re-downloading and indexing it
    return NextResponse.json(await libraryStats(), {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "library unavailable" },
      { status: 503 }
    );
  }
}
