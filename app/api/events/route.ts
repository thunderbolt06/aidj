import { NextRequest, NextResponse } from "next/server";
import { cleanEvent, recordEvents, type ListenEvent } from "@/lib/server/events";

export const dynamic = "force-dynamic";

/**
 * Listening events from the player (lib/client/telemetry.ts), in batches.
 * Sent with sendBeacon on page leave, so the body may arrive as text/plain.
 * Losing a batch only blurs the stats - never fail the listener over it.
 */
export async function POST(req: NextRequest) {
  let body: { events?: unknown };
  try {
    body = JSON.parse(await req.text());
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const now = Date.now();
  const events = (Array.isArray(body.events) ? body.events : [])
    .slice(0, 100)
    .map((e) => cleanEvent(e, now))
    .filter((e): e is ListenEvent => !!e);
  try {
    await recordEvents(events);
  } catch (e) {
    console.error("events:", e instanceof Error ? e.message : e);
    return NextResponse.json({ ok: false }, { status: 503 });
  }
  return NextResponse.json({ ok: true, stored: events.length });
}
