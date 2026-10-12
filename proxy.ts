import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, gateEnabled, validSession } from "@/lib/server/session";

/**
 * Private-deployment gate: with APP_PASSWORD set, every page and API route
 * needs a valid session cookie. Pages bounce to /login; API calls get a 401
 * so a signed-out client can never obtain an audio link.
 */
export async function proxy(req: NextRequest) {
  if (!gateEnabled()) {
    // Signed library links without a login would hand private audio to
    // anyone who opens the site - refuse to serve until a password is set.
    if (process.env.CLOUDFRONT_KEY_PAIR_ID)
      return NextResponse.json(
        { error: "private library configured but APP_PASSWORD is not set" },
        { status: 503 }
      );
    return NextResponse.next();
  }
  const { pathname } = req.nextUrl;
  if (pathname === "/login" || pathname === "/api/login") return NextResponse.next();
  if (await validSession(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  if (pathname.startsWith("/api/"))
    return NextResponse.json({ error: "sign in required" }, { status: 401 });
  const login = req.nextUrl.clone();
  login.pathname = "/login";
  login.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(login);
}

export const config = {
  // everything except Next's own static assets and the generated icons
  matcher: ["/((?!_next/static|_next/image|icon|apple-icon|opengraph-image).*)"],
};
