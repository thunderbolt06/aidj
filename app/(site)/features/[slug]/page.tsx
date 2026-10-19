import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FEATURES, getFeature } from "@/lib/site/features";
import { PageHero } from "@/components/site/PageHero";
import { Reveal } from "@/components/site/Reveal";
import { CtaBand } from "@/components/site/CtaBand";

export function generateStaticParams() {
  return FEATURES.map((f) => ({ slug: f.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const f = getFeature((await params).slug);
  if (!f) return {};
  return { title: f.title, description: f.description, alternates: { canonical: `/features/${f.slug}` } };
}

export default async function FeaturePage({ params }: { params: Promise<{ slug: string }> }) {
  const f = getFeature((await params).slug);
  if (!f) notFound();
  const others = FEATURES.filter((x) => x.slug !== f.slug).slice(0, 3);

  return (
    <>
      <PageHero eyebrow={`Feature · ${f.short}`} title={f.title} lede={f.tagline}>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/login" className="ep-btn ep-btn-primary">Try it in Everplay</Link>
          <Link href="/features" className="ep-btn ep-btn-ghost">All features</Link>
        </div>
      </PageHero>
      <section className="ep-section">
        <div className="ep-wrap grid gap-12 lg:grid-cols-[1.3fr_1fr]">
          <Reveal>
            <div className="ep-prose">
              {f.body.map((p, i) => <p key={i}>{p}</p>)}
              <h2>What you get</h2>
              <ul>{f.points.map((p) => <li key={p}>{p}</li>)}</ul>
            </div>
          </Reveal>
          <Reveal delay={100}>
            <h2 className="ep-eyebrow">How it works</h2>
            <ol className="mt-5 space-y-4">
              {f.steps.map((s, i) => (
                <li key={s.title} className="flex gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                  <span className="ep-big text-2xl" style={{ color: f.accent === "a" ? "#22d3ee" : "#ffb454" }}>{i + 1}</span>
                  <div>
                    <h3 className="font-semibold">{s.title}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-[#8aa0ab]">{s.text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Reveal>
        </div>
      </section>
      <section className="ep-section border-t border-white/10 bg-white/[0.015] !py-14">
        <div className="ep-wrap">
          <h2 className="text-xl font-semibold">More features</h2>
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {others.map((o) => (
              <Link key={o.slug} href={`/features/${o.slug}`} className="ep-card">
                <span className="ep-chip">{o.short}</span>
                <p className="mt-3 font-medium">{o.tagline}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>
      <CtaBand />
    </>
  );
}
