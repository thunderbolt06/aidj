import { NextResponse } from "next/server";
import { open } from "node:fs/promises";
import { coverFile, hasTrack, remoteCoverUrl } from "@/lib/server/library";

/**
 * Cover art (local mode; remote mode links the static host directly, and this
 * route only redirects stale links there). Covers get replaced - a frame
 * grabbed from YouTube is later upgraded to album art - so they are not
 * immutable: a short max-age, then a cheap conditional request (ETag from
 * size + mtime, answered with 304 from a stat alone).
 */
const CACHE = "public, max-age=300";

// 8x8 flat grey (the app's zinc-800) JPEG: stands in for a known song whose
// cover file is missing, so a reel render or lock screen still gets an image.
const PLACEHOLDER = Buffer.from(
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMQD/2wBDAAgKCgsKCw0NDQ0NDRAPEBAQEBAQEBAQEBASEhIVFRUSEhIQEBISFBQVFRcXFxUVFRUXFxkZGR4eHBwjIyQrKzP/xABMAAEBAAAAAAAAAAAAAAAAAAAABwEBAQAAAAAAAAAAAAAAAAAAAAEQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAIAAgDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCTgKP/2Q==",
  "base64"
);

/** True when an If-None-Match list (weak comparison) names `etag`. */
function etagMatches(header: string, etag: string): boolean {
  return header.split(",").some((t) => {
    const v = t.trim().replace(/^W\//, "");
    return v === "*" || v === etag;
  });
}

async function missing(id: string) {
  // unknown ids are a plain 404; a catalog song whose art has not landed yet
  // gets the neutral tile, kept on a short leash so the real cover shows soon
  if (!(await hasTrack(id).catch(() => false))) return new NextResponse(null, { status: 404 });
  return new NextResponse(new Uint8Array(PLACEHOLDER), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=60",
      "X-Cover-Fallback": "1",
    },
  });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!/^[\w-]+$/.test(id)) return new NextResponse(null, { status: 400 });

  const remote = remoteCoverUrl(id);
  if (remote)
    return NextResponse.redirect(remote, {
      status: 302,
      headers: { "Cache-Control": "private, max-age=3600" },
    });

  try {
    const file = await open(coverFile(id));
    try {
      const st = await file.stat();
      const etag = `"${st.size.toString(16)}-${Math.trunc(st.mtimeMs).toString(36)}"`;
      const headers = {
        ETag: etag,
        "Last-Modified": st.mtime.toUTCString(),
        "Cache-Control": CACHE,
      };
      const inm = req.headers.get("if-none-match");
      const ims = req.headers.get("if-modified-since");
      // If-None-Match wins over If-Modified-Since (RFC 9110)
      const notModified = inm
        ? etagMatches(inm, etag)
        : !!ims && Math.floor(st.mtimeMs / 1000) <= Math.floor(Date.parse(ims) / 1000);
      if (notModified) return new NextResponse(null, { status: 304, headers });

      const buf = await file.readFile();
      return new NextResponse(new Uint8Array(buf), {
        headers: { ...headers, "Content-Type": "image/jpeg", "Content-Length": String(buf.length) },
      });
    } finally {
      await file.close();
    }
  } catch {
    return missing(id);
  }
}
