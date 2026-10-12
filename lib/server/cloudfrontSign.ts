import { createSign } from "node:crypto";

/**
 * CloudFront signed URLs. When the distribution is restricted to a trusted
 * key group, nothing is served without a signature - so an audio link is only
 * ever obtainable from this app, behind its login.
 *
 * Needs CLOUDFRONT_KEY_PAIR_ID and CLOUDFRONT_PRIVATE_KEY_B64 (the PEM,
 * base64-encoded so it survives as a one-line env var). Without them URLs
 * are returned unsigned, which is right for a public distribution.
 */
const KEY_PAIR_ID = process.env.CLOUDFRONT_KEY_PAIR_ID || "";
const PRIVATE_KEY = process.env.CLOUDFRONT_PRIVATE_KEY_B64
  ? Buffer.from(process.env.CLOUDFRONT_PRIVATE_KEY_B64, "base64").toString("utf8")
  : "";

export const signingEnabled = !!(KEY_PAIR_ID && PRIVATE_KEY);

const HOUR = 3600;

/**
 * Sign `url` until the end of the current `windowHours` block (plus one more
 * block of slack). Rounding the expiry means the same URL is produced for the
 * whole window, so browsers can still cache covers and audio.
 */
export function signUrl(url: string, windowHours = 12): string {
  if (!signingEnabled) return url;
  const window = windowHours * HOUR;
  const expires = (Math.floor(Date.now() / 1000 / window) + 2) * window;
  const policy = JSON.stringify({
    Statement: [{ Resource: url, Condition: { DateLessThan: { "AWS:EpochTime": expires } } }],
  });
  const signature = createSign("RSA-SHA1")
    .update(policy)
    .sign(PRIVATE_KEY, "base64")
    .replace(/\+/g, "-")
    .replace(/=/g, "_")
    .replace(/\//g, "~");
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}Expires=${expires}&Signature=${signature}&Key-Pair-Id=${KEY_PAIR_ID}`;
}
