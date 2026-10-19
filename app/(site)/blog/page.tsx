import type { Metadata } from "next";
import Link from "next/link";
import { sortedPosts } from "@/lib/site/posts";
import { PageHero } from "@/components/site/PageHero";
import { Reveal } from "@/components/site/Reveal";
import { SpotlightGrid } from "@/components/site/SpotlightGrid";
import { CtaBand } from "@/components/site/CtaBand";

export const metadata: Metadata = {
  title: "Blog",
  description: "Guides to harmonic mixing, DJ transitions, BPM and building playlists that keep the room moving - from the Everplay team.",
  alternates: { canonical: "/blog" },
};

const fmt = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

export default function BlogIndex() {
  const [first, ...rest] = sortedPosts();
  return (
    <>
      <PageHero eyebrow="Blog" title={<>Mixing, <span className="ep-grad">explained.</span></>} lede="Guides to how DJs make songs flow, and how software can do it for you." />
      <section className="ep-section">
        <div className="ep-wrap">
          <Reveal>
            <Link href={`/blog/${first.slug}`} className="ep-card !p-8 sm:!p-10">
              <span className="ep-chip !text-cyan-200">Latest · {first.tag}</span>
              <h2 className="mt-5 max-w-3xl text-3xl font-bold leading-tight tracking-tight sm:text-4xl">{first.title}</h2>
              <p className="mt-3 max-w-2xl text-[#8aa0ab]">{first.description}</p>
              <p className="mt-5 text-sm text-[#8aa0ab]">{fmt(first.date)} · {first.readMins} min read</p>
            </Link>
          </Reveal>
          <SpotlightGrid className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {rest.map((p, i) => (
              <Reveal key={p.slug} delay={(i % 3) * 80}>
                <Link href={`/blog/${p.slug}`} className="ep-card h-full">
                  <span className="ep-chip">{p.tag}</span>
                  <h2 className="mt-4 text-lg font-semibold leading-snug">{p.title}</h2>
                  <p className="mt-2 text-sm leading-relaxed text-[#8aa0ab]">{p.description}</p>
                  <p className="mt-4 text-xs text-[#8aa0ab]">{fmt(p.date)} · {p.readMins} min</p>
                </Link>
              </Reveal>
            ))}
          </SpotlightGrid>
        </div>
      </section>
      <CtaBand />
    </>
  );
}
