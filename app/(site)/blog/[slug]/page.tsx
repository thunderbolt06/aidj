import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { POSTS, getPost, sortedPosts } from "@/lib/site/posts";
import { SITE_URL } from "@/lib/site/config";
import { Prose } from "@/components/site/Prose";
import { JsonLd } from "@/components/site/JsonLd";
import { CtaBand } from "@/components/site/CtaBand";
import { ReadProgress } from "@/components/site/ReadProgress";

export function generateStaticParams() {
  return POSTS.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const p = getPost((await params).slug);
  if (!p) return {};
  return {
    title: p.title,
    description: p.description,
    alternates: { canonical: `/blog/${p.slug}` },
    openGraph: { type: "article", title: p.title, description: p.description, publishedTime: p.date },
  };
}

const fmt = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

export default async function PostPage({ params }: { params: Promise<{ slug: string }> }) {
  const p = getPost((await params).slug);
  if (!p) notFound();
  const more = sortedPosts().filter((x) => x.slug !== p.slug).slice(0, 2);

  return (
    <>
      <ReadProgress />
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "BlogPosting",
          headline: p.title,
          description: p.description,
          datePublished: p.date,
          author: { "@type": "Organization", name: "Everplay" },
          publisher: { "@type": "Organization", name: "Everplay" },
          mainEntityOfPage: `${SITE_URL}/blog/${p.slug}`,
        }}
      />
      <article>
        <header className="relative overflow-hidden border-b border-white/10">
          <div className="ep-orb ep-orb-a -left-24 -top-32 h-72 w-72 opacity-30" aria-hidden />
          <div className="ep-narrow relative py-14 sm:py-20">
            <Link href="/blog" className="ep-link text-sm text-[#8aa0ab] hover:text-cyan-300">← All posts</Link>
            <div className="mt-6 flex items-center gap-3 text-sm text-[#8aa0ab]">
              <span className="ep-chip">{p.tag}</span>
              <span>{fmt(p.date)} · {p.readMins} min read</span>
            </div>
            <h1 className="mt-4 text-3xl font-bold leading-tight tracking-tight sm:text-5xl">{p.title}</h1>
            <p className="ep-lede mt-4">{p.description}</p>
          </div>
        </header>
        <div className="ep-narrow py-12 sm:py-16">
          <Prose source={p.body} />
        </div>
      </article>
      <section className="border-t border-white/10 bg-white/[0.015] py-14">
        <div className="ep-wrap">
          <h2 className="text-xl font-semibold">Keep reading</h2>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {more.map((m) => (
              <Link key={m.slug} href={`/blog/${m.slug}`} className="ep-card">
                <span className="ep-chip">{m.tag}</span>
                <p className="mt-3 text-lg font-semibold">{m.title}</p>
                <p className="mt-1 text-sm text-[#8aa0ab]">{m.description}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>
      <CtaBand />
    </>
  );
}
