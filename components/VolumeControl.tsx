"use client";

import { useEffect, useState } from "react";
import { getEngine } from "@/lib/client/dj";
import { VolumeIcon } from "@/components/icons";

const STORAGE_KEY = "everplay:volume";

function readStored(): { volume: number; muted: boolean } {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if (raw && typeof raw.volume === "number" && raw.volume >= 0 && raw.volume <= 1)
      return { volume: raw.volume, muted: !!raw.muted };
  } catch {
    /* fall through to the default */
  }
  return { volume: 1, muted: false };
}

/**
 * Dock volume: click = mute/unmute, hover (or keyboard focus) = a slider pops
 * up above the button. Drives the engine's master bus and is remembered.
 */
export function VolumeControl() {
  // only rendered on the live deck (never server-side), so storage is safe here
  const [volume, setVolume] = useState(() => readStored().volume);
  const [muted, setMuted] = useState(() => readStored().muted);

  useEffect(() => {
    getEngine().setMasterVolume(muted ? 0 : volume);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ volume, muted }));
    } catch {
      /* private mode: just don't remember */
    }
  }, [volume, muted]);

  const level = muted || volume === 0 ? 0 : volume < 0.5 ? 1 : 2;

  return (
    <span className="group relative">
      {/* pb-2 bridges the gap so the pointer can travel up to the slider */}
      <span className="pointer-events-none absolute bottom-full left-1/2 z-20 -translate-x-1/2 pb-2 opacity-0 transition group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
        <span className="flex items-center rounded-full border border-zinc-700 bg-zinc-950/95 px-3 py-2 shadow-xl backdrop-blur">
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            onChange={(e) => {
              setVolume(Number(e.target.value));
              setMuted(false);
            }}
            aria-label="Volume"
            className="w-28 accent-cyan-500"
          />
        </span>
      </span>
      <button
        onClick={() => {
          // unmuting from a dragged-to-zero slider brings back a usable level
          if (muted || volume === 0) {
            if (volume === 0) setVolume(0.5);
            setMuted(false);
          } else {
            setMuted(true);
          }
        }}
        className="flex h-11 w-11 items-center justify-center rounded-full border border-white/70 text-white transition hover:border-white active:scale-95"
        title={level === 0 ? "Unmute" : "Mute"}
      >
        <VolumeIcon level={level} />
      </button>
    </span>
  );
}
