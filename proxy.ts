import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, gateEnabled, validSession } from "@/lib/server/session";
import { isPublicPath } from "@/lib/site/config";

/** A same-site path to go to after sign-in, or "/". */
function safeNext(req: NextRequest): string {
  const next = req.nextUrl.searchParams.get("next");
  // a backslash is read as a slash by URL parsing, so "/\\evil.com" would leave the site
  return next && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : "/";
}

/**
 * Private-deployment gate: with APP_PASSWORD set, every page and API route
 * needs a valid session cookie. Pages bounce to /login; API calls get a 401
 * so a signed-out client can never obtain an audio link.
 *
 * The marketing site (lib/site/config.ts PUBLIC_PREFIXES) stays open so it can
 * be crawled, and "/" shows the landing page to signed-out visitors.
 */
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (!gateEnabled()) {
    // Signed library links without a login would hand private audio to
    // anyone who opens the site - refuse to serve until a password is set.
    if (process.env.CLOUDFRONT_KEY_PAIR_ID)
      return NextResponse.json(
        { error: "private library configured but APP_PASSWORD is not set" },
        { status: 503 }
      );
    // nothing to sign in to: the sign-in page would be a dead end
    if (pathname === "/login") return NextResponse.redirect(new URL(safeNext(req), req.url));
    return NextResponse.next();
  }
  if (pathname === "/api/login" || pathname === "/api/health") return NextResponse.next();
  const signedIn = await validSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (pathname === "/login" && signedIn) return NextResponse.redirect(new URL(safeNext(req), req.url));
  if (signedIn) return NextResponse.next();
  if (pathname === "/login" || isPublicPath(pathname)) return NextResponse.next();
  if (pathname === "/") return NextResponse.rewrite(new URL("/welcome", req.url));
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
