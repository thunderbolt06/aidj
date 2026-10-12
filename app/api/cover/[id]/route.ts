import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { coverFile } from "@/lib/server/library";

/** Generated cover art (local mode; remote mode links the static host directly). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!/^[\w-]+$/.test(id)) return new NextResponse(null, { status: 400 });
  try {
    const buf = await readFile(coverFile(id));
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=604800, immutable",
      },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
