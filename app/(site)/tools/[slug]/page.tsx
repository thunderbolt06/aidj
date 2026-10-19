import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TOOLS, getTool } from "@/lib/site/tools";
import { SITE_URL } from "@/lib/site/config";
import { ToolFor, TOOL_SLUGS } from "@/components/site/tools/registry";
import { PageHero } from "@/components/site/PageHero";
import { Reveal } from "@/components/site/Reveal";
import { JsonLd } from "@/components/site/JsonLd";
import { CtaBand } from "@/components/site/CtaBand";

export function generateStaticParams() {
  return TOOLS.map((t) => ({ slug: t.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const t = getTool((await params).slug);
  if (!t) return {};
  return { title: t.title, description: t.description, alternates: { canonical: `/tools/${t.slug}` } };
}

export default async function ToolPage({ params }: { params: Promise<{ slug: string }> }) {
  const t = getTool((await params).slug);
  if (!t || !TOOL_SLUGS.includes(t.slug)) notFound();
  const others = TOOLS.filter((x) => x.slug !== t.slug).slice(0, 3);

  return (
    <>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [
            { "@type": "WebApplication", name: t.title, description: t.description, url: `${SITE_URL}/tools/${t.slug}`, applicationCategory: "MultimediaApplication", operatingSystem: "Any", offers: { "@type": "Offer", price: "0", priceCurrency: "USD" } },
            { "@type": "FAQPage", mainEntity: t.faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) },
          ],
        }}
      />
      <PageHero eyebrow="Free tool" title={t.title} lede={t.intro} />
      <section className="ep-section !pb-10">
        <div className="ep-wrap">
          <Reveal className="rounded-[2rem] border border-white/10 bg-[#0b111b] p-5 sm:p-9">
            <ToolFor slug={t.slug} />
          </Reveal>
        </div>
      </section>
      <section className="ep-section !pt-6">
        <div className="ep-narrow ep-prose">
          {t.notes.map((n) => (
            <div key={n.h}>
              <h2>{n.h}</h2>
              <p>{n.p}</p>
            </div>
          ))}
          <h2>Questions</h2>
          {t.faq.map((f) => (
            <details key={f.q} className="ep-faq not-prose">
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </section>
      <section className="border-t border-white/10 bg-white/[0.015] py-14">
        <div className="ep-wrap">
          <h2 className="text-xl font-semibold">More free tools</h2>
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {others.map((o) => (
              <Link key={o.slug} href={`/tools/${o.slug}`} className="ep-card">
                <p className="font-semibold">{o.title}</p>
                <p className="mt-1 text-sm text-[#8aa0ab]">{o.short}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>
      <CtaBand title="Skip the manual mixing." text="Everplay applies tempo, key and phrase rules to every transition for you." />
    </>
  );
}
