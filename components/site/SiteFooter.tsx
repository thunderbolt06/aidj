import Link from "next/link";
import { FOOTER } from "@/lib/site/config";
import { Logo } from "./Logo";

export function SiteFooter() {
  return (
    <footer className="border-t border-white/10 bg-[#04070c]">
      <div className="ep-wrap grid gap-10 py-14 sm:grid-cols-2 lg:grid-cols-[1.4fr_repeat(4,1fr)]">
        <div className="sm:col-span-2 lg:col-span-1">
          <Logo className="text-xl" />
          <p className="mt-3 max-w-xs text-sm leading-relaxed text-[#8aa0ab]">
            Tell it a vibe. It plays only the famous parts, transitions like a DJ, and never stops.
          </p>
        </div>
        {FOOTER.map((col) => (
          <nav key={col.title} aria-label={col.title}>
            <h2 className="ep-eyebrow !text-[#8aa0ab]">{col.title}</h2>
            <ul className="mt-4 space-y-2.5 text-sm">
              {col.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="ep-link text-[#cfdfe6] transition-colors hover:text-cyan-300">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="border-t border-white/10">
        <div className="ep-wrap flex flex-wrap items-center justify-between gap-3 py-5 text-xs text-[#8aa0ab]">
          <span>© {new Date().getFullYear()} Everplay</span>
          <span>Made for people who never want the music to stop.</span>
        </div>
      </div>
    </footer>
  );
}
