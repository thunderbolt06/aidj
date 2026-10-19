import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site/config";
import { FEATURES } from "@/lib/site/features";
import { POSTS } from "@/lib/site/posts";
import { COMPARISONS } from "@/lib/site/compare";
import { TOOLS } from "@/lib/site/tools";

export default function sitemap(): MetadataRoute.Sitemap {
  const at = (path: string, priority: number, lastModified?: string) => ({
    url: `${SITE_URL}${path}`,
    priority,
    ...(lastModified ? { lastModified: new Date(lastModified) } : {}),
  });
  return [
    at("/", 1),
    at("/features", 0.9),
    at("/how-it-works", 0.8),
    at("/compare", 0.8),
    at("/tools", 0.8),
    at("/blog", 0.8),
    at("/faq", 0.6),
    at("/about", 0.5),
    at("/privacy", 0.3),
    ...FEATURES.map((f) => at(`/features/${f.slug}`, 0.7)),
    ...COMPARISONS.map((c) => at(`/compare/${c.slug}`, 0.7)),
    ...TOOLS.map((t) => at(`/tools/${t.slug}`, 0.8)),
    ...POSTS.map((p) => at(`/blog/${p.slug}`, 0.7, p.date)),
  ];
}
