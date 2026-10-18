"use client";

import { useEffect, useState } from "react";
import type { HopInfo } from "@/lib/client/useAutoMix";

const SHOW_MS = 12000;
const THANKS_MS = 1200;

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

/**
 * Like / dislike for the transition that just played. Pops up once the blend
 * is over, goes away on its own, and never blocks the deck. Ratings land in
 * the stats (app/stats, Transitions) next to the songs, cue points and style.
 */
export function TransitionRating({
  hop,
  onRate,
}: {
  hop: HopInfo | null;
  onRate: (hopId: string, rating: "up" | "down") => void;
}) {
  const [shown, setShown] = useState<string | null>(null);
  const hopId = hop?.hopId ?? null;
  const doneAt = hop?.doneAt ?? 0;
  const rated = !!hop?.rating;

  // wait for the blend to finish, then show for a while
  useEffect(() => {
    if (!hopId) return;
    const showIn = Math.max(0, doneAt - Date.now());
    const t1 = setTimeout(() => setShown(hopId), showIn);
    const t2 = setTimeout(() => setShown((s) => (s === hopId ? null : s)), showIn + SHOW_MS);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [hopId, doneAt]);

  // a rating: say thanks, then get out of the way
  useEffect(() => {
    if (!rated || !hopId) return;
    const t = setTimeout(() => setShown((s) => (s === hopId ? null : s)), THANKS_MS);
    return () => clearTimeout(t);
  }, [rated, hopId]);

  if (!hop || shown !== hop.hopId) return null;

  return (
    <div
      role="dialog"
      aria-label="Rate this transition"
      className="pointer-events-auto fixed left-1/2 top-16 z-50 w-[min(22rem,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl border border-zinc-700/80 bg-zinc-950/95 p-3 text-sm text-zinc-200 shadow-2xl backdrop-blur animate-[drop-in_150ms_ease]"
    >
      {hop.rating ? (
        <p className="py-1 text-center text-zinc-300">
          {hop.rating === "up" ? "👍" : "👎"} Thanks - noted.
        </p>
      ) : (
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-widest text-zinc-500">How was that mix?</p>
            <p className="truncate text-[13px]">
              <span className="font-semibold text-cyan-300">{hop.style.replace(/_/g, " ")}</span>
              <span className="text-zinc-400">
                {" "}
                · {mmss(hop.outSec)} → {mmss(hop.inSec)}
              </span>
            </p>
            <p className="truncate text-xs text-zinc-500">
              {hop.from.title} → {hop.to.title}
            </p>
          </div>
          <button
            onClick={() => onRate(hop.hopId, "up")}
            aria-label="Liked the transition"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-zinc-700 text-lg hover:border-emerald-400 hover:bg-emerald-950/60"
          >
            👍
          </button>
          <button
            onClick={() => onRate(hop.hopId, "down")}
            aria-label="Disliked the transition"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-zinc-700 text-lg hover:border-red-400 hover:bg-red-950/60"
          >
            👎
          </button>
          <button
            onClick={() => setShown(null)}
            aria-label="Dismiss"
            className="-mr-1 self-start px-1 text-zinc-500 hover:text-zinc-300"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
