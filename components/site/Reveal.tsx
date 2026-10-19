"use client";

import { useEffect, useRef, type ElementType, type ReactNode, type CSSProperties } from "react";

/**
 * Fades and lifts its children in the first time they scroll into view.
 * Without JS the site layout's <noscript> style keeps everything visible.
 */
export function Reveal({
  children,
  delay = 0,
  as: Tag = "div",
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  as?: ElementType;
  className?: string;
}) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      el.classList.add("is-in");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries)
          // also anything already scrolled past (an anchor jump or a fast fling)
          if (e.isIntersecting || e.boundingClientRect.top < 0) {
            e.target.classList.add("is-in");
            io.unobserve(e.target);
          }
      },
      { threshold: 0.12, rootMargin: "0px 0px -6% 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Tag
      ref={ref}
      className={`ep-reveal ${className}`}
      style={{ "--d": `${delay}ms` } as CSSProperties}
    >
      {children}
    </Tag>
  );
}
