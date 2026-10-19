"use client";

import { useEffect, useRef } from "react";

/** A thin bar under the header that fills as you read an article. */
export function ReadProgress() {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const on = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (bar.current) bar.current.style.transform = `scaleX(${max > 0 ? Math.min(1, window.scrollY / max) : 0})`;
    };
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  return (
    <div aria-hidden className="fixed inset-x-0 top-0 z-[55] h-0.5">
      <div ref={bar} className="h-full origin-left scale-x-0 bg-gradient-to-r from-cyan-400 to-[#ffb454]" />
    </div>
  );
}
