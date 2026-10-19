import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { COMPARISONS, COMPARE_NOTE, getComparison } from "@/lib/site/compare";
import { PageHero } from "@/components/site/PageHero";
import { Reveal } from "@/components/site/Reveal";
import { CtaBand } from "@/components/site/CtaBand";

export function generateStaticParams() {
  return COMPARISONS.map((c) => ({ slug: c.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const c = getComparison((await params).slug);
  if (!c) return {};
  return { title: c.title, description: c.description, alternates: { canonical: `/compare/${c.slug}` } };
}

export default async function ComparePage({ params }: { params: Promise<{ slug: string }> }) {
  const c = getComparison((await params).slug);
  if (!c) notFound();
  const others = COMPARISONS.filter((x) => x.slug !== c.slug);

  return (
    <>
      <PageHero eyebrow={`Compare · ${c.kind}`} title={<>Everplay vs <span className="text-[#ffb454]">{c.name}</span></>} lede={c.summary} />
      <section className="ep-section">
        <div className="ep-wrap">
          <Reveal>
            <div className="overflow-x-auto rounded-3xl border border-white/10 bg-[#0b111b]">
              <table className="ep-table min-w-[40rem]">
                <thead>
                  <tr><th>&nbsp;</th><th className="!text-cyan-300">Everplay</th><th className="!text-[#ffb454]">{c.name}</th></tr>
                </thead>
                <tbody>
                  {c.rows.map((r) => (
                    <tr key={r.label}><th scope="row">{r.label}</th><td className="us">{r.us}</td><td>{r.them}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Reveal>

          <div className="mt-10 grid gap-5 md:grid-cols-2">
            <Reveal className="rounded-3xl border border-[#ffb454]/25 bg-[#ffb454]/[0.05] p-7">
              <h2 className="text-lg font-semibold text-[#ffcf94]">Choose {c.name} if you want</h2>
              <ul className="mt-4 space-y-2.5 text-[#cfdfe6]">
                {c.theyWin.map((t) => <li key={t} className="flex gap-3"><span aria-hidden className="text-[#ffb454]">●</span>{t}</li>)}
              </ul>
            </Reveal>
            <Reveal delay={100} className="rounded-3xl border border-cyan-400/25 bg-cyan-400/[0.05] p-7">
              <h2 className="text-lg font-semibold text-cyan-200">Choose Everplay if you want</h2>
              <ul className="mt-4 space-y-2.5 text-[#cfdfe6]">
                {c.weWin.map((t) => <li key={t} className="flex gap-3"><span aria-hidden className="text-cyan-300">●</span>{t}</li>)}
              </ul>
            </Reveal>
          </div>

          <Reveal className="mt-10 max-w-3xl">
            <h2 className="text-2xl font-bold tracking-tight">The short version</h2>
            <p className="mt-3 text-lg leading-relaxed text-[#cfdfe6]">{c.verdict}</p>
            <p className="mt-6 text-sm text-[#8aa0ab]">{COMPARE_NOTE}</p>
          </Reveal>
        </div>
      </section>
      <section className="border-t border-white/10 bg-white/[0.015] py-14">
        <div className="ep-wrap">
          <h2 className="text-xl font-semibold">More comparisons</h2>
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {others.map((o) => (
              <Link key={o.slug} href={`/compare/${o.slug}`} className="ep-card">
                <span className="ep-chip">{o.kind}</span>
                <p className="mt-3 font-semibold">Everplay vs {o.name}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>
      <CtaBand />
    </>
  );
}
