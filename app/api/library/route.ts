import { NextResponse } from "next/server";
import { libraryStats } from "@/lib/server/library";

export const dynamic = "force-dynamic";

/** Library size + genre / tag / licence facets, for browse UIs. */
export async function GET() {
  try {
    return NextResponse.json(await libraryStats());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "library unavailable" },
      { status: 503 }
    );
  }
}
