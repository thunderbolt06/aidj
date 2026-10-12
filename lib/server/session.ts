/**
 * Single-password gate for a private deployment. Set APP_PASSWORD and the
 * whole app (pages and API) requires a login; leave it unset (local dev) and
 * nothing is gated. The session cookie is an HMAC keyed by the password, so
 * changing the password signs everyone out. Web Crypto only - this runs in
 * the request proxy as well as in route handlers.
 */
export const SESSION_COOKIE = "everplay_session";

export function gateEnabled(): boolean {
  return !!process.env.APP_PASSWORD;
}

async function hmacHex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison (lengths are equal for our hex digests). */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function sessionToken(): Promise<string> {
  return hmacHex(process.env.APP_PASSWORD ?? "", "everplay-session-v1");
}

export async function validSession(cookie: string | undefined): Promise<boolean> {
  if (!gateEnabled()) return true;
  return !!cookie && same(cookie, await sessionToken());
}

export async function passwordMatches(attempt: string): Promise<boolean> {
  // compare digests so timing does not leak how much of the password matched
  const [a, b] = await Promise.all([
    hmacHex("everplay-login", attempt),
    hmacHex("everplay-login", process.env.APP_PASSWORD ?? ""),
  ]);
  return gateEnabled() && same(a, b);
}
