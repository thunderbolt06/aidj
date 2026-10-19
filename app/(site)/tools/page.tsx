import type { Metadata } from "next";
import Link from "next/link";
import { TOOLS } from "@/lib/site/tools";
import { PageHero } from "@/components/site/PageHero";
import { Reveal } from "@/components/site/Reveal";
import { SpotlightGrid } from "@/components/site/SpotlightGrid";
import { CtaBand } from "@/components/site/CtaBand";

export const metadata: Metadata = {
  title: "Free DJ and music tools",
  description: "Free tools for DJs and playlist makers: tap tempo, BPM and key detector, Camelot wheel, delay time and pitch calculators. Run in your browser.",
  alternates: { canonical: "/tools" },
};

export default function ToolsIndex() {
  return (
    <>
      <PageHero eyebrow="Free tools" title={<>Small tools, <span className="ep-grad">no sign-up.</span></>} lede="Everything runs in your browser. Your files never leave your device." />
      <section className="ep-section">
        <div className="ep-wrap">
          <SpotlightGrid className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {TOOLS.map((t, i) => (
              <Reveal key={t.slug} delay={(i % 3) * 80}>
                <Link href={`/tools/${t.slug}`} className="ep-card h-full">
                  <span className="ep-chip">Free</span>
                  <h2 className="mt-4 text-lg font-semibold">{t.title}</h2>
                  <p className="mt-2 text-sm leading-relaxed text-[#8aa0ab]">{t.short}</p>
                </Link>
              </Reveal>
            ))}
          </SpotlightGrid>
        </div>
      </section>
      <CtaBand title="Like the tools? Hear them at work." text="Everplay uses the same ideas to mix every set for you." />
    </>
  );
}
