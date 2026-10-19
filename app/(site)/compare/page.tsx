import type { Metadata } from "next";
import Link from "next/link";
import { COMPARISONS, COMPARE_NOTE } from "@/lib/site/compare";
import { PageHero } from "@/components/site/PageHero";
import { Reveal } from "@/components/site/Reveal";
import { SpotlightGrid } from "@/components/site/SpotlightGrid";
import { CtaBand } from "@/components/site/CtaBand";

export const metadata: Metadata = {
  title: "Compare Everplay",
  description: "How Everplay compares with Spotify, Apple Music, djay Pro and VirtualDJ: transitions, set building, catalogue and who each is for.",
  alternates: { canonical: "/compare" },
};

export default function CompareIndex() {
  return (
    <>
      <PageHero eyebrow="Compare" title={<>Where Everplay fits <span className="ep-grad">and where it doesn&apos;t.</span></>} lede="Honest comparisons, including what the other product does better." />
      <section className="ep-section">
        <div className="ep-wrap">
          <SpotlightGrid className="grid gap-4 md:grid-cols-2">
            {COMPARISONS.map((c, i) => (
              <Reveal key={c.slug} delay={(i % 2) * 90}>
                <Link href={`/compare/${c.slug}`} className="ep-card h-full !p-7">
                  <div className="flex items-center gap-3 text-sm">
                    <span className="font-semibold text-cyan-300">Everplay</span>
                    <span className="text-[#8aa0ab]">vs</span>
                    <span className="font-semibold text-[#ffb454]">{c.name}</span>
                    <span className="ep-chip ml-auto">{c.kind}</span>
                  </div>
                  <h2 className="mt-5 text-lg font-semibold leading-snug">{c.title}</h2>
                  <p className="mt-2 text-sm leading-relaxed text-[#8aa0ab]">{c.summary}</p>
                </Link>
              </Reveal>
            ))}
          </SpotlightGrid>
          <p className="mt-8 max-w-2xl text-sm text-[#8aa0ab]">{COMPARE_NOTE}</p>
        </div>
      </section>
      <CtaBand />
    </>
  );
}
