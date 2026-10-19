import Link from "next/link";

export function Logo({ className = "" }: { className?: string }) {
  return (
    <Link href="/welcome" aria-label="Everplay home" className={`inline-flex items-center gap-2 font-bold tracking-tight ${className}`}>
      <span aria-hidden className="text-[1.35em] leading-none text-cyan-400 [text-shadow:0_0_16px_rgba(34,211,238,0.8)]">∞</span>
      <span>
        Ever<span className="text-cyan-400">play</span>
      </span>
    </Link>
  );
}
