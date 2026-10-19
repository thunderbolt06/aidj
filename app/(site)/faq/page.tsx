import type { Metadata } from "next";
import { FAQ } from "@/lib/site/faq";
import { PageHero } from "@/components/site/PageHero";
import { JsonLd } from "@/components/site/JsonLd";
import { CtaBand } from "@/components/site/CtaBand";

export const metadata: Metadata = {
  title: "FAQ",
  description: "Answers about Everplay: what it is, where songs come from, which transitions it uses, languages, privacy and more.",
  alternates: { canonical: "/faq" },
};

export default function FaqPage() {
  return (
    <>
      <JsonLd data={{ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: FAQ.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) }} />
      <PageHero eyebrow="FAQ" title="Questions, answered." />
      <section className="ep-section">
        <div className="ep-narrow">
          {FAQ.map((f) => (
            <details key={f.q} className="ep-faq">
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </section>
      <CtaBand />
    </>
  );
}
