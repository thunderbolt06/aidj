import type { Metadata } from "next";
import { SiteHeader } from "@/components/site/SiteHeader";
import { SiteFooter } from "@/components/site/SiteFooter";
import { SITE_TAGLINE } from "@/lib/site/config";
import "./site.css";

export const metadata: Metadata = {
  title: { default: "Everplay - the AI DJ that never stops", template: "%s | Everplay" },
  description: SITE_TAGLINE,
};

/** Public marketing pages. The app itself lives behind the sign-in gate. */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="ep font-sans">
      <noscript>
        <style>{`.ep-reveal{opacity:1!important;transform:none!important}.ep-wave i{height:var(--h)!important}`}</style>
      </noscript>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-cyan-400 focus:px-4 focus:py-2 focus:text-black">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main">{children}</main>
      <SiteFooter />
    </div>
  );
}
