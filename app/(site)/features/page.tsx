import type { Metadata } from "next";
import Link from "next/link";
import { FEATURES } from "@/lib/site/features";
import { PageHero } from "@/components/site/PageHero";
import { Reveal } from "@/components/site/Reveal";
import { SpotlightGrid } from "@/components/site/SpotlightGrid";
import { TransitionLab } from "@/components/site/TransitionLab";
import { CtaBand } from "@/components/site/CtaBand";

export const metadata: Metadata = {
  title: "Features",
  description: "Famous-part playback, ten AI-planned DJ transitions, vibe prompts, vocal handoff, karaoke, a talking DJ, reels and more.",
  alternates: { canonical: "/features" },
};

export default function FeaturesPage() {
  return (
    <>
      <PageHero eyebrow="Features" title={<>Everything a DJ does, <span className="ep-grad">without the DJ.</span></>} lede="Everplay analyses songs ahead of time, plans each transition, and plays it on the beat. Here is what that gives you." />
      <section className="ep-section">
        <div className="ep-wrap">
          <SpotlightGrid className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f, i) => (
              <Reveal key={f.slug} delay={(i % 3) * 80}>
                <Link href={`/features/${f.slug}`} className="ep-card h-full">
                  <span className="ep-chip" style={{ color: f.accent === "a" ? "#67e8f9" : "#ffcf94" }}>{f.short}</span>
                  <h2 className="mt-4 text-lg font-semibold leading-snug">{f.title}</h2>
                  <p className="mt-2 text-sm leading-relaxed text-[#8aa0ab]">{f.tagline}</p>
                </Link>
              </Reveal>
            ))}
          </SpotlightGrid>
        </div>
      </section>
      <section className="ep-section border-t border-white/10 bg-white/[0.015]">
        <div className="ep-wrap">
          <Reveal className="max-w-2xl">
            <h2 className="ep-h2">The transition arsenal</h2>
            <p className="ep-lede mt-3">Every move the engine can make, drawn as volume over time.</p>
          </Reveal>
          <div className="mt-10"><TransitionLab /></div>
        </div>
      </section>
      <CtaBand />
    </>
  );
}
