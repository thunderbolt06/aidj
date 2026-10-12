import { NextResponse } from "next/server";
import { libraryStats } from "@/lib/server/library";

export const dynamic = "force-dynamic";

/**
 * Counts only - no titles, no links. Reachable without signing in so a
 * deployment can be checked from outside ("is the library actually loaded?").
 */
export async function GET() {
  try {
    const { songs, loops, sfx } = await libraryStats();
    return NextResponse.json({ ok: songs > 0, songs, loops, sfx });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "library unavailable" },
      { status: 503 }
    );
  }
}
