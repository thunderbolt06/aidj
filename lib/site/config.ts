/** Marketing-site constants shared by pages, the sitemap and the request proxy. */

export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://aidj-self.vercel.app").replace(/\/$/, "");
export const SITE_NAME = "Everplay";
export const SITE_TAGLINE = "Tell it a vibe. It plays only the famous parts, transitions like a DJ, and never stops.";

/**
 * Paths a signed-out visitor may open. The app itself (home, /mix, /api...) stays
 * behind the password gate; these are the marketing pages, which must be crawlable.
 */
export const PUBLIC_PREFIXES = [
  "/welcome",
  "/features",
  "/blog",
  "/compare",
  "/tools",
  "/how-it-works",
  "/faq",
  "/about",
  "/privacy",
];
export const PUBLIC_FILES = ["/sitemap.xml", "/robots.txt"];

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_FILES.includes(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export const NAV = [
  { href: "/features", label: "Features" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/compare", label: "Compare" },
  { href: "/tools", label: "Free tools" },
  { href: "/blog", label: "Blog" },
];

export const FOOTER = [
  {
    title: "Product",
    links: [
      { href: "/features", label: "Features" },
      { href: "/how-it-works", label: "How it works" },
      { href: "/faq", label: "FAQ" },
      { href: "/login", label: "Open Everplay" },
    ],
  },
  {
    title: "Compare",
    links: [
      { href: "/compare/spotify", label: "Everplay vs Spotify" },
      { href: "/compare/apple-music", label: "Everplay vs Apple Music" },
      { href: "/compare/djay-pro", label: "Everplay vs djay Pro" },
      { href: "/compare/virtualdj", label: "Everplay vs VirtualDJ" },
    ],
  },
  {
    title: "Free tools",
    links: [
      { href: "/tools/tap-tempo", label: "Tap tempo" },
      { href: "/tools/bpm-key-detector", label: "BPM & key detector" },
      { href: "/tools/camelot-wheel", label: "Camelot wheel" },
      { href: "/tools/delay-time-calculator", label: "Delay time calculator" },
      { href: "/tools", label: "All tools" },
    ],
  },
  {
    title: "Company",
    links: [
      { href: "/about", label: "About" },
      { href: "/blog", label: "Blog" },
      { href: "/privacy", label: "Privacy" },
    ],
  },
];
