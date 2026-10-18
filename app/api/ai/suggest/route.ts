import { NextRequest, NextResponse } from "next/server";
import { pickNext, toTrack } from "@/lib/server/library";

export const dynamic = "force-dynamic";

/**
 * 9 next-song picks from the library: 5 safe, 3 energy shifts, 1 wildcard.
 *
 * This used to be an LLM call naming famous songs to search for. With a
 * pre-analyzed library the picks come from the vibe playlists (what the
 * set's `vibes` claim, what shares playlists with `current`) and tempo / key
 * / intensity, so the answer is instant and every pick is guaranteed
 * playable. `recent` (played ids, newest first) keeps sets from repeating;
 * `skipped` (ids the listener skipped) keeps those out and steers away from them.
 * `query` is an exact `id:` lookup - existing callers that resolve picks via
 * search keep working unchanged; `track` saves them the round-trip.
 */
export async function POST(req: NextRequest) {
  const { current, arc, exclude, languages, songSource, vibes, recent, skipped } = await req.json();
  try {
    const picks = await pickNext({
      current,
      arc,
      exclude,
      languages,
      source: songSource,
      vibes,
      recent,
      skipped,
    });
    return NextResponse.json({
      suggestions: picks.map((p) => ({
        query: `id:${p.row.id}`,
        tag: p.tag,
        track: toTrack(p.row, req.nextUrl.origin),
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "suggest failed" },
      { status: 503 }
    );
  }
}
