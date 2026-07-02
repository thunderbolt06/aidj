"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Back-to-lab link shown on every experiment page (hidden on home). */
export function BackNav() {
  const pathname = usePathname();
  if (!pathname || pathname === "/") return null;
  return (
    <nav className="mx-auto w-full max-w-3xl px-6 pt-4">
      <Link
        href="/"
        className="inline-flex items-center gap-1 rounded-lg border border-zinc-800 px-3 py-1.5 text-sm text-zinc-400 transition hover:border-fuchsia-600 hover:text-fuchsia-300"
      >
        ← Back
      </Link>
    </nav>
  );
}
