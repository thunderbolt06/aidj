"use client";

import { useRef, useState } from "react";
import { getEngine } from "@/lib/client/dj";
import { useAutoMix } from "@/lib/client/useAutoMix";
import { SearchPicker } from "@/components/SearchPicker";

/**
 * Gesture deck:
 *  - press & hold the pad: tension builds (bass drains, echo swells)
 *  - release: transition into the next queued song
 *  - swipe up anywhere on the pad: instant auto-transition
 */
export default function GesturesPage() {
  const mix = useAutoMix();
  const [holding, setHolding] = useState(false);
  const touchStartY = useRef<number | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function startSet() {
    // clipLen 0: user-driven. The hook pre-loads and pre-plans the next hop
    // while you listen, so releasing the pad executes instantly.
    await mix.start({
      clipLen: 0,
      useAi: true,
      quantize: true,
      quantizeBeats: 4,
      endless: true,
      maxTransitionDur: 6,
    });
  }

  function holdStart() {
    if (!mix.running) return;
    setHolding(true);
    getEngine().tension(true);
  }

  function holdEnd(release: "transition" | "cancel") {
    if (!holding) return;
    setHolding(false);
    if (release === "transition") {
      // keep the tension through the drop — the transition resets deck FX
      mix.hopNow();
    } else {
      getEngine().tension(false);
    }
  }

  return (
    <main className="mx-auto max-w-xl p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Gestures</h1>
        <p className="text-sm text-zinc-400">
          Hold the pad — the track tenses up. Let go — it drops into the next
          song. Swipe up for an instant transition.
        </p>
      </header>

      <SearchPicker
        placeholder="Queue songs…"
        onPick={(t) => mix.setQueue((q) => [...q, t])}
      />

      {mix.queue.length > 0 && !mix.running && (
        <button
          onClick={startSet}
          disabled={mix.queue.length < 2}
          className="rounded-lg bg-zinc-100 px-5 py-2 font-semibold text-zinc-900 disabled:opacity-40"
        >
          ▶ Start ({mix.queue.length} queued — need ≥2)
        </button>
      )}
      {mix.status && (
        <p className="animate-pulse text-xs text-amber-400">{mix.status}</p>
      )}

      {mix.running && (
        <>
          <div
            className={`flex h-72 select-none items-center justify-center rounded-2xl border-4 text-center transition-colors ${
              holding
                ? "animate-pulse border-fuchsia-500 bg-fuchsia-950/40"
                : "border-zinc-700 bg-zinc-900"
            }`}
            style={{ touchAction: "none" }}
            onPointerDown={(e) => {
              touchStartY.current = e.clientY;
              // short delay so a quick swipe doesn't trigger tension
              holdTimer.current = setTimeout(holdStart, 120);
            }}
            onPointerMove={(e) => {
              if (
                touchStartY.current !== null &&
                touchStartY.current - e.clientY > 80
              ) {
                // swipe up
                if (holdTimer.current) clearTimeout(holdTimer.current);
                touchStartY.current = null;
                setHolding(false);
                getEngine().tension(false);
                mix.hopNow();
              }
            }}
            onPointerUp={() => {
              if (holdTimer.current) clearTimeout(holdTimer.current);
              touchStartY.current = null;
              holdEnd("transition");
            }}
            onPointerLeave={() => {
              if (holdTimer.current) clearTimeout(holdTimer.current);
              holdEnd("cancel");
            }}
          >
            <div>
              <p className="text-lg font-bold">
                {holding ? "building…" : "HOLD ME"}
              </p>
              <p className="mt-1 px-6 text-xs text-zinc-400">
                {mix.now?.meta.title ?? ""}
              </p>
              <p className="mt-2 text-[10px] uppercase tracking-widest text-zinc-500">
                hold → release to drop · swipe ↑ to skip
              </p>
            </div>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="truncate text-zinc-400">
              next:{" "}
              {mix.queue[(mix.nowIdx + 1) % mix.queue.length]?.title ?? "—"}
            </span>
            <button
              onClick={() => mix.stop()}
              className="rounded border border-zinc-700 px-3 py-1 text-xs"
            >
              stop
            </button>
          </div>
          {mix.lastPlan && (
            <p className="text-xs text-fuchsia-300">
              {mix.lastPlan.style} — {mix.lastPlan.reasoning}
            </p>
          )}
        </>
      )}
    </main>
  );
}
