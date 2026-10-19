import Link from "next/link";
import { Reveal } from "./Reveal";

export function CtaBand({ title = "Say a vibe. Hear the mix.", text = "Open Everplay and let it play." }: { title?: string; text?: string }) {
  return (
    <section className="relative overflow-hidden border-t border-white/10 py-20 sm:py-28">
      <div className="ep-orb ep-orb-a left-1/4 top-0 h-72 w-72 opacity-30" aria-hidden />
      <div className="ep-orb ep-orb-b right-1/4 bottom-0 h-72 w-72" aria-hidden />
      <Reveal className="ep-narrow relative text-center">
        <span className="ep-eq mx-auto mb-6 !h-8 text-cyan-300" aria-hidden>
          {Array.from({ length: 9 }, (_, i) => <i key={i} style={{ ["--d" as string]: `${(i * 0.13) % 0.9}s`, width: 5 }} />)}
        </span>
        <h2 className="ep-h2">{title}</h2>
        <p className="ep-lede mt-4">{text}</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link href="/login" className="ep-btn ep-btn-primary">Open Everplay</Link>
          <Link href="/how-it-works" className="ep-btn ep-btn-ghost">See how it works</Link>
        </div>
      </Reveal>
    </section>
  );
}
