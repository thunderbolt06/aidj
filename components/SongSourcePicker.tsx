"use client";

import { useEffect, useSyncExternalStore } from "react";
import { SONG_SOURCES, useSongSourcePrefs } from "@/lib/client/sourcePrefs";

// one request per page load, shared by every picker on screen
let requested = false;

// Same trick as the language picker: the last answer is kept in the browser so
// the control paints at once, and the fetch below just refreshes it.
const CACHE_KEY = "everplay:has-both-sources";

const subscribers = new Set<() => void>();
const subscribe = (cb: () => void) => {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
};

function readCached(): boolean {
  try {
    return window.localStorage.getItem(CACHE_KEY) === "1";
  } catch {
    return false;
  }
}

function refresh() {
  if (requested) return;
  requested = true;
  fetch("/api/library")
    .then((r) => (r.ok ? r.json() : null))
    .then((stats: { sources?: { open: number; commercial: number } } | null) => {
      if (!stats?.sources) throw new Error("no source counts");
      const both = stats.sources.open > 0 && stats.sources.commercial > 0;
      try {
        window.localStorage.setItem(CACHE_KEY, both ? "1" : "0");
      } catch {}
      subscribers.forEach((cb) => cb());
    })
    .catch(() => {
      requested = false; // let the next mount retry
    });
}

/** Whether the library holds both open-licence and commercial songs (the only time there is a choice). */
function useHasBothSources(): boolean {
  // the cached answer is read on the client only, so server and client markup match
  const both = useSyncExternalStore(subscribe, readCached, () => false);
  useEffect(refresh, []);
  return both;
}

/**
 * Song-source switch: open-licence songs, commercial songs, or both. Renders
 * nothing while the library only has one kind.
 */
export function SongSourcePicker({
  label,
  onChange,
  className = "",
}: {
  label?: string;
  /** Fires after the choice is saved (e.g. to refresh picks mid-set). */
  onChange?: () => void;
  className?: string;
}) {
  const { source, choose } = useSongSourcePrefs();
  const both = useHasBothSources();
  if (!both) return null;

  const active = SONG_SOURCES.find((o) => o.code === source);
  return (
    <div className={`space-y-1.5 ${className}`}>
      {label && <span className="text-xs text-zinc-500">{label}</span>}
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
        {SONG_SOURCES.map((o) => {
          const on = o.code === source;
          return (
            <button
              key={o.code}
              role="radio"
              aria-checked={on}
              onClick={() => {
                if (on) return;
                choose(o.code);
                onChange?.();
              }}
              className={`rounded-full border px-3 py-1 text-xs transition active:scale-95 ${
                on
                  ? "border-cyan-500 bg-cyan-950/60 text-cyan-300"
                  : "border-zinc-700 bg-zinc-900/70 text-zinc-400 hover:border-cyan-600 hover:text-cyan-300"
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {active && <p className="text-[11px] text-zinc-600">{active.hint}</p>}
    </div>
  );
}
