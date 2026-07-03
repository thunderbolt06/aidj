"use client";

import { useEffect, useRef, useState } from "react";
import type { TrackAnalysis } from "@/lib/types";
import { getEngine } from "@/lib/client/dj";
import { HandIcon } from "@/components/icons";

/**
 * Compact "clap along" button for player docks: pulses on every beat of the
 * playing track (rAF off the engine playhead, so it locks to the audio) and
 * flashes on tap. Each tap claims +15s via useAutoMix.tapInterest.
 */
export function BeatTapButton({
  analysis,
  onTap,
  active,
}: {
  analysis: TrackAnalysis | null;
  onTap: () => void;
  active: boolean;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [flash, setFlash] = useState(0);

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const tick = () => {
      const el = btnRef.current;
      if (el && analysis && analysis.bpm > 0) {
        const beatLen = 60 / analysis.bpm;
        const anchor = analysis.downbeatOffset ?? analysis.beatOffset;
        const pos = getEngine().position();
        const phase =
          (((pos - anchor) % beatLen) + beatLen) % beatLen / beatLen;
        const punch = Math.pow(1 - phase, 3);
        el.style.transform = `scale(${1 + punch * 0.12})`;
        el.style.boxShadow = `0 0 ${4 + punch * 22}px rgba(255,255,255,${
          0.15 + punch * 0.4
        })`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, analysis]);

  if (!active) return null;

  return (
    <span className="relative inline-flex">
      <button
        ref={btnRef}
        type="button"
        onClick={() => {
          onTap();
          setFlash(Date.now());
        }}
        className="flex h-11 w-11 select-none items-center justify-center rounded-full border border-white/70 text-white transition hover:border-white active:scale-95"
        title="Tap on the beat (or spacebar) - each tap keeps the song going 15s longer"
      >
        <HandIcon />
      </button>
      {flash > 0 && (
        <span
          key={flash}
          className="pointer-events-none absolute inset-0 animate-ping rounded-full border-2 border-white"
        />
      )}
    </span>
  );
}

/**
 * "Clap along" pad: a ring that pulses on every beat of the playing track,
 * inviting the user to tap (spacebar or touch) on the beat. Each tap claims
 * +15s of the current song via useAutoMix.tapInterest - stop tapping and the
 * auto-DJ knows you've lost interest.
 *
 * Beat phase is derived from the engine playhead + track analysis on rAF, so
 * the pulse locks to the actual audio, not a UI timer.
 */
export function BeatTapPulse({
  analysis,
  interestUntil,
  onTap,
  active,
}: {
  analysis: TrackAnalysis | null;
  /** Track position (sec) guaranteed by taps so far (0 = none). */
  interestUntil: number;
  onTap: () => void;
  active: boolean;
}) {
  const dotRef = useRef<HTMLDivElement>(null);
  const [claimedLeft, setClaimedLeft] = useState(0);
  const [flash, setFlash] = useState(0);

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const tick = () => {
      const pos = getEngine().position();
      setClaimedLeft(Math.max(0, interestUntil - pos));
      const el = dotRef.current;
      if (el && analysis && analysis.bpm > 0) {
        const beatLen = 60 / analysis.bpm;
        const anchor = analysis.downbeatOffset ?? analysis.beatOffset;
        const phase =
          (((pos - anchor) % beatLen) + beatLen) % beatLen / beatLen;
        // sharp attack on the beat, quick decay - feels like a clap cue
        const punch = Math.pow(1 - phase, 3);
        el.style.transform = `scale(${1 + punch * 0.35})`;
        el.style.boxShadow = `0 0 ${8 + punch * 40}px rgba(34,211,238,${
          0.25 + punch * 0.55
        })`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, analysis, interestUntil]);

  if (!active) return null;

  return (
    <button
      type="button"
      onClick={() => {
        onTap();
        setFlash(Date.now());
      }}
      className="relative flex w-full select-none flex-col items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-900/60 py-6 outline-none transition hover:border-cyan-800 focus-visible:border-cyan-500"
      title="Tap on the beat (or hit spacebar) - each tap keeps the song going 15s longer"
    >
      <div
        ref={dotRef}
        className="flex h-24 w-24 items-center justify-center rounded-full bg-cyan-600/90 text-2xl"
      >
        👏
      </div>
      {/* expanding ring acknowledging the tap */}
      {flash > 0 && (
        <span
          key={flash}
          className="pointer-events-none absolute top-6 h-24 w-24 animate-ping rounded-full border-2 border-cyan-400"
        />
      )}
      <p className="text-xs uppercase tracking-widest text-zinc-500">
        tap the beat · spacebar
      </p>
      <p className="text-sm">
        {claimedLeft > 0 ? (
          <span className="font-semibold text-emerald-400">
            +{Math.ceil(claimedLeft)}s claimed - keep clapping to extend
          </span>
        ) : (
          <span className="text-zinc-400">
            like it? tap to keep it playing (+15s per tap)
          </span>
        )}
      </p>
    </button>
  );
}
