import type { Metadata } from "next";
import Link from "next/link";
import vibes from "@/lib/vibes.json";
import { FEATURES } from "@/lib/site/features";
import { sortedPosts } from "@/lib/site/posts";
import { TOOLS } from "@/lib/site/tools";
import { FAQ } from "@/lib/site/faq";
import { SITE_TAGLINE, SITE_URL } from "@/lib/site/config";
import { HeroDeck } from "@/components/site/HeroDeck";
import { VibeTyper } from "@/components/site/VibeTyper";
import { Reveal } from "@/components/site/Reveal";
import { SpotlightGrid } from "@/components/site/SpotlightGrid";
import { FamousPartDemo } from "@/components/site/FamousPartDemo";
import { TransitionLab } from "@/components/site/TransitionLab";
import { Counter } from "@/components/site/Counter";
import { CtaBand } from "@/components/site/CtaBand";
import { JsonLd } from "@/components/site/JsonLd";

export const metadata: Metadata = {
  title: { absolute: "Everplay - the AI DJ that never stops" },
  description: SITE_TAGLINE,
  alternates: { canonical: "/" },
};

const STEPS = [
  { n: "01", t: "Say a vibe", d: "Road trip. Late night chill. Shaadi dance floor. Type it, tap a chip, or just say it." },
  { n: "02", t: "We find the famous parts", d: "Every song was analysed ahead of time for tempo, key, energy and its hook. The set is ordered so neighbours belong together." },
  { n: "03", t: "The mix lands on the beat", d: "A planner chooses a transition for each pair and schedules it on the audio clock. When one song ends, the next is already ready." },
];

const MARQUEE_A = (vibes.general as string[]).slice(0, 24);
const MARQUEE_B = [...(vibes.hindi as string[]).slice(0, 8), ...(vibes.punjabi as string[]).slice(0, 8)];

export default function Welcome() {
  const posts = sortedPosts().slice(0, 3);
  const tools = TOOLS.slice(0, 4);

  return (
    <>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [
            { "@type": "Organization", name: "Everplay", url: SITE_URL },
            { "@type": "WebApplication", name: "Everplay", applicationCategory: "MusicApplication", operatingSystem: "Web", description: SITE_TAGLINE, url: SITE_URL },
            { "@type": "FAQPage", mainEntity: FAQ.slice(0, 6).map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) },
          ],
        }}
      />

      {/* ───────── hero ───────── */}
      <section className="relative isolate overflow-hidden">
        <div className="ep-grid-bg" aria-hidden />
        <div className="ep-orb ep-orb-a -left-32 top-0 h-[28rem] w-[28rem]" aria-hidden />
        <div className="ep-orb ep-orb-b -right-32 top-40 h-[24rem] w-[24rem]" aria-hidden />
        <div className="ep-wrap relative pb-20 pt-16 text-center sm:pt-24">
          <Reveal>
            <span className="ep-chip !border-cyan-400/30 !text-cyan-200">
              <span className="ep-eq text-cyan-300" aria-hidden><i /><i style={{ ["--d" as string]: ".2s" }} /><i style={{ ["--d" as string]: ".4s" }} /></span>
              The AI DJ that never stops
            </span>
          </Reveal>
          <Reveal delay={80}>
            <h1 className="ep-h1 mx-auto mt-6 max-w-4xl">
              Tell it a vibe.
              <br />
              <span className="ep-grad">It never stops.</span>
            </h1>
          </Reveal>
          <Reveal delay={160}>
            <p className="ep-lede mx-auto mt-6 max-w-2xl">
              Everplay plays only the famous part of each song and mixes between them like a DJ, with every transition planned to the beat. No queue to build. No skill to learn.
            </p>
          </Reveal>
          <Reveal delay={240} className="mt-9 flex flex-wrap justify-center gap-3">
            <Link href="/login" className="ep-btn ep-btn-primary">Open Everplay</Link>
            <a href="#how" className="ep-btn ep-btn-ghost">See how it works</a>
          </Reveal>
          <Reveal delay={320} className="mt-14">
            <VibeTyper />
          </Reveal>
          <Reveal delay={400} className="mx-auto mt-12 max-w-3xl">
            <HeroDeck />
          </Reveal>
        </div>
      </section>

      {/* ───────── vibe marquee ───────── */}
      <section aria-label="Example vibes" className="border-y border-white/10 bg-white/[0.015] py-6">
        <div className="space-y-3">
          <div className="ep-marquee">
            {[0, 1].map((k) => (
              <div key={k} className="ep-marquee-track" aria-hidden={k === 1}>
                {MARQUEE_A.map((v) => <span key={v} className="ep-chip">{v}</span>)}
              </div>
            ))}
          </div>
          <div className="ep-marquee rev">
            {[0, 1].map((k) => (
              <div key={k} className="ep-marquee-track" aria-hidden={k === 1}>
                {MARQUEE_B.map((v) => <span key={v} className="ep-chip !border-[#ffb454]/30 !text-[#ffcf94]">{v}</span>)}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ───────── the idea ───────── */}
      <section className="ep-section">
        <div className="ep-wrap">
          <Reveal className="max-w-3xl">
            <div className="ep-eyebrow">The idea</div>
            <h2 className="ep-h2 mt-3">Only a small part of a song is famous.</h2>
            <p className="ep-lede mt-4">
              The hook is the part everyone knows. The rest is the way there. Everplay finds the section that is both loud and repeated, plays that, and moves on, so every moment is one you recognise.
            </p>
          </Reveal>
          <Reveal className="mt-10" delay={100}>
            <FamousPartDemo />
          </Reveal>
        </div>
      </section>

      {/* ───────── how it works ───────── */}
      <section id="how" className="ep-section border-t border-white/10 bg-white/[0.015]">
        <div className="ep-wrap">
          <Reveal className="max-w-2xl">
            <div className="ep-eyebrow">How it works</div>
            <h2 className="ep-h2 mt-3">Prepared ahead, so nothing ever waits.</h2>
          </Reveal>
          <ol className="mt-12 grid gap-5 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <Reveal as="li" key={s.n} delay={i * 120} className="relative rounded-3xl border border-white/10 bg-white/[0.03] p-7">
                <span className="ep-big text-5xl text-cyan-300/80">{s.n}</span>
                <h3 className="mt-4 text-xl font-semibold">{s.t}</h3>
                <p className="mt-2 leading-relaxed text-[#8aa0ab]">{s.d}</p>
              </Reveal>
            ))}
          </ol>
          <Reveal className="mt-8">
            <Link href="/how-it-works" className="ep-link text-cyan-300 underline-offset-4 hover:underline">The full pipeline →</Link>
          </Reveal>
        </div>
      </section>

      {/* ───────── transitions ───────── */}
      <section className="ep-section">
        <div className="ep-wrap">
          <Reveal className="max-w-2xl">
            <div className="ep-eyebrow">Transition lab</div>
            <h2 className="ep-h2 mt-3">Ten moves. The right one for each pair.</h2>
            <p className="ep-lede mt-4">A crossfade is the same for every pair of songs. A DJ chooses. Pick a transition to see how the two songs trade places.</p>
          </Reveal>
          <Reveal className="mt-10" delay={100}>
            <TransitionLab />
          </Reveal>
        </div>
      </section>

      {/* ───────── numbers ───────── */}
      <section className="border-y border-white/10 bg-white/[0.015] py-14">
        <dl className="ep-wrap grid gap-8 text-center sm:grid-cols-3">
          {[
            { to: 10, s: "", l: "beat-locked transition styles" },
            { to: 3, s: "", l: "languages with their own vibes" },
            { to: 17, s: "", l: "listening modes to explore" },
          ].map((x, i) => (
            <Reveal key={x.l} delay={i * 100}>
              <dt className="ep-big text-6xl text-white"><Counter to={x.to} suffix={x.s} /></dt>
              <dd className="mt-2 text-[#8aa0ab]">{x.l}</dd>
            </Reveal>
          ))}
        </dl>
      </section>

      {/* ───────── features ───────── */}
      <section className="ep-section">
        <div className="ep-wrap">
          <Reveal className="max-w-2xl">
            <div className="ep-eyebrow">Features</div>
            <h2 className="ep-h2 mt-3">A DJ, a karaoke night and a radio host in one tab.</h2>
          </Reveal>
          <SpotlightGrid className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.slice(0, 9).map((f, i) => (
              <Reveal key={f.slug} delay={(i % 3) * 90}>
                <Link href={`/features/${f.slug}`} className="ep-card h-full">
                  <span className="ep-chip" style={{ color: f.accent === "a" ? "#67e8f9" : "#ffcf94" }}>{f.short}</span>
                  <h3 className="mt-4 text-lg font-semibold leading-snug">{f.tagline}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-[#8aa0ab]">{f.description}</p>
                </Link>
              </Reveal>
            ))}
          </SpotlightGrid>
          <Reveal className="mt-8">
            <Link href="/features" className="ep-link text-cyan-300 underline-offset-4 hover:underline">All features →</Link>
          </Reveal>
        </div>
      </section>

      {/* ───────── compare ───────── */}
      <section className="ep-section border-t border-white/10 bg-white/[0.015]">
        <div className="ep-wrap grid items-center gap-10 lg:grid-cols-2">
          <Reveal>
            <div className="ep-eyebrow">Compare</div>
            <h2 className="ep-h2 mt-3">A crossfade is a volume ramp. This is a plan.</h2>
            <p className="ep-lede mt-4">Streaming apps fade one song out while the next fades in. DJ software gives you the decks. Everplay sits between: the result of a DJ, with none of the skill.</p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link href="/compare" className="ep-btn ep-btn-ghost">See the comparisons</Link>
              <Link href="/blog/why-spotify-crossfade-sounds-off" className="ep-btn ep-btn-ghost">Why crossfade sounds off</Link>
            </div>
          </Reveal>
          <Reveal delay={120}>
            <div className="overflow-x-auto rounded-3xl border border-white/10 bg-[#0b111b]">
              <table className="ep-table">
                <thead>
                  <tr><th>&nbsp;</th><th>Crossfade</th><th className="!text-cyan-300">Everplay</th></tr>
                </thead>
                <tbody>
                  {[
                    ["Tempo-aware", "No", "Yes"],
                    ["Key-aware", "No", "Yes"],
                    ["Leaves on a phrase", "No", "Yes"],
                    ["Different move per pair", "No", "Ten styles"],
                    ["Plays the hook", "No", "Yes"],
                  ].map(([a, b, c]) => (
                    <tr key={a}><th scope="row">{a}</th><td>{b}</td><td className="us">{c}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ───────── free tools ───────── */}
      <section className="ep-section">
        <div className="ep-wrap">
          <Reveal className="flex flex-wrap items-end justify-between gap-4">
            <div className="max-w-2xl">
              <div className="ep-eyebrow">Free tools</div>
              <h2 className="ep-h2 mt-3">Handy for any DJ, free in your browser.</h2>
            </div>
            <Link href="/tools" className="ep-link text-cyan-300 underline-offset-4 hover:underline">All {TOOLS.length} tools →</Link>
          </Reveal>
          <SpotlightGrid className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {tools.map((t, i) => (
              <Reveal key={t.slug} delay={i * 80}>
                <Link href={`/tools/${t.slug}`} className="ep-card h-full">
                  <h3 className="font-semibold">{t.title}</h3>
                  <p className="mt-2 text-sm text-[#8aa0ab]">{t.short}</p>
                </Link>
              </Reveal>
            ))}
          </SpotlightGrid>
        </div>
      </section>

      {/* ───────── blog ───────── */}
      <section className="ep-section border-t border-white/10 bg-white/[0.015]">
        <div className="ep-wrap">
          <Reveal className="flex flex-wrap items-end justify-between gap-4">
            <div className="max-w-2xl">
              <div className="ep-eyebrow">From the blog</div>
              <h2 className="ep-h2 mt-3">How mixing works, in plain words.</h2>
            </div>
            <Link href="/blog" className="ep-link text-cyan-300 underline-offset-4 hover:underline">All posts →</Link>
          </Reveal>
          <SpotlightGrid className="mt-10 grid gap-4 md:grid-cols-3">
            {posts.map((p, i) => (
              <Reveal key={p.slug} delay={i * 90}>
                <Link href={`/blog/${p.slug}`} className="ep-card h-full">
                  <span className="ep-chip">{p.tag} · {p.readMins} min</span>
                  <h3 className="mt-4 text-lg font-semibold leading-snug">{p.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-[#8aa0ab]">{p.description}</p>
                </Link>
              </Reveal>
            ))}
          </SpotlightGrid>
        </div>
      </section>

      {/* ───────── faq ───────── */}
      <section className="ep-section">
        <div className="ep-narrow">
          <Reveal>
            <div className="ep-eyebrow">FAQ</div>
            <h2 className="ep-h2 mt-3">Questions people ask.</h2>
          </Reveal>
          <Reveal className="mt-8" delay={80}>
            {FAQ.slice(0, 6).map((f) => (
              <details key={f.q} className="ep-faq">
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
            <Link href="/faq" className="ep-link mt-6 inline-block text-cyan-300 underline-offset-4 hover:underline">More questions →</Link>
          </Reveal>
        </div>
      </section>

      <CtaBand title="Say a vibe. Hear the mix." text="Open Everplay and let it play. It never stops." />
    </>
  );
}
