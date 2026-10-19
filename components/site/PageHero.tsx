import type { ReactNode } from "react";
import { Reveal } from "./Reveal";

/** Top-of-page block shared by every inner page. */
export function PageHero({ eyebrow, title, lede, children }: { eyebrow: string; title: ReactNode; lede?: ReactNode; children?: ReactNode }) {
  return (
    <section className="relative overflow-hidden border-b border-white/10">
      <div className="ep-orb ep-orb-a -left-24 -top-32 h-80 w-80" aria-hidden />
      <div className="ep-orb ep-orb-b -right-24 -top-20 h-72 w-72" aria-hidden />
      <div className="ep-wrap relative py-16 sm:py-24">
        <Reveal>
          <div className="ep-eyebrow">{eyebrow}</div>
          <h1 className="ep-h1 mt-4 max-w-4xl !text-[clamp(2.2rem,5.5vw,4rem)]">{title}</h1>
          {lede && <p className="ep-lede mt-5 max-w-2xl">{lede}</p>}
          {children}
        </Reveal>
      </div>
    </section>
  );
}
