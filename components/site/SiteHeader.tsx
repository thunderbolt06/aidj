"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { NAV } from "@/lib/site/config";
import { Logo } from "./Logo";

export function SiteHeader() {
  const pathname = usePathname();
  // the menu is open for one page only, so navigating closes it
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === pathname;
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 12);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);

  return (
    <header
      className={`sticky top-0 z-50 transition-colors duration-300 ${
        scrolled || open ? "border-b border-white/10 bg-[#05080f]/85 backdrop-blur-xl" : "border-b border-transparent"
      }`}
    >
      <div className="ep-wrap flex h-16 items-center justify-between gap-6">
        <Logo className="text-xl" />
        <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
          {NAV.map((n) => {
            const on = pathname === n.href || pathname.startsWith(n.href + "/");
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={on ? "page" : undefined}
                className={`ep-link rounded-full px-3.5 py-2 text-sm transition-colors ${
                  on ? "bg-white/10 text-white" : "text-[#8aa0ab] hover:text-white"
                }`}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-2">
          <Link href="/login" className="ep-btn ep-btn-primary !min-h-10 !px-4 !text-sm">
            Open Everplay
          </Link>
          <button
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            onClick={() => setOpenAt(open ? null : pathname)}
            className="grid h-10 w-10 place-items-center rounded-full border border-white/10 md:hidden"
          >
            <span className="relative block h-3 w-4">
              <span className={`absolute left-0 h-0.5 w-4 bg-white transition-all ${open ? "top-1/2 rotate-45" : "top-0"}`} />
              <span className={`absolute left-0 top-1/2 h-0.5 w-4 bg-white transition-opacity ${open ? "opacity-0" : ""}`} />
              <span className={`absolute left-0 h-0.5 w-4 bg-white transition-all ${open ? "top-1/2 -rotate-45" : "bottom-0"}`} />
            </span>
          </button>
        </div>
      </div>
      {open && (
        <nav aria-label="Mobile" className="ep-wrap flex flex-col pb-4 md:hidden">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="border-t border-white/10 py-3 text-lg">
              {n.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}
