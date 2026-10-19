import type { Metadata } from "next";
import { PageHero } from "@/components/site/PageHero";
import { Reveal } from "@/components/site/Reveal";
import { CtaBand } from "@/components/site/CtaBand";

export const metadata: Metadata = {
  title: "About",
  description: "Why Everplay exists: music listening hasn't changed in fifteen years, and the part of a song that matters is small.",
  alternates: { canonical: "/about" },
};

const BELIEFS = [
  ["Prepare everything ahead.", "The user's action should only execute a decision already made. Any visible thinking at the moment of a transition breaks the illusion."],
  ["Work in beats, not seconds.", "Timers drift and miss beats. Everything is scheduled on the audio clock against the beat grid."],
  ["Lean on the hook.", "People relate to the part they already know. Transitions, clips and landings gravitate to it."],
  ["Fail loud, never silent.", "If a fancy move was impossible and a plain one played instead, the app says so."],
  ["Endless by default.", "Queues refill. A failed track is skipped rather than stalling the set."],
];

export default function About() {
  return (
    <>
      <PageHero eyebrow="About" title={<>Music, <span className="ep-grad">the way a DJ plays it.</span></>} lede="Everplay started as a lab of experiments to find the one music experience that feels magical enough to share." />
      <section className="ep-section">
        <div className="ep-narrow ep-prose">
          <p>Streaming replaced ownership, but the unit of listening is still &quot;play a song from the start to the end&quot;. Remixes, mashups, DJ transitions and the famous part of a song are what people actually enjoy, and none of them has been turned into something everyone can use.</p>
          <p>So we build each idea thoroughly, test it with real listeners, and keep the ones that work. Every page in the app is an experiment: a two-song mix, an auto-DJ, a vibe prompt, a nine-song grid, a vertical reels feed, a talking host. The best ones become the product.</p>
          <h2>The test we hold ourselves to</h2>
          <blockquote>A friend hears a mix, can&apos;t tell it was made by software, asks what it is, and makes one themselves within the minute.</blockquote>
        </div>
      </section>
      <section className="ep-section border-t border-white/10 bg-white/[0.015]">
        <div className="ep-wrap">
          <Reveal><h2 className="ep-h2">What we learned from testing</h2></Reveal>
          <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {BELIEFS.map(([t, d], i) => (
              <Reveal key={t} delay={(i % 3) * 80} className="rounded-3xl border border-white/10 bg-white/[0.03] p-7">
                <h3 className="text-lg font-semibold">{t}</h3>
                <p className="mt-2 text-sm leading-relaxed text-[#8aa0ab]">{d}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>
      <CtaBand />
    </>
  );
}
