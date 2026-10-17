"use client";

import { useEffect, useState } from "react";
import { DEFAULT_SONG_SOURCE, parseSongSource, type SongSource } from "@/lib/songSource";

export { SONG_SOURCES, type SongSource } from "@/lib/songSource";

/**
 * Song-source preference: open-licence songs, commercial songs or both. Sent
 * with every request that picks songs, next to the language setting.
 */

const STORAGE_KEY = "everplay:songSource";

function readStored(): SongSource {
  if (typeof window === "undefined") return DEFAULT_SONG_SOURCE;
  try {
    return parseSongSource(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_SONG_SOURCE;
  }
}

/** Non-reactive read for call sites that aren't components (e.g. useAutoMix). */
export function getSongSource(): SongSource {
  return readStored();
}

let listeners: Array<() => void> = [];
function notify() {
  listeners.forEach((fn) => fn());
}

/** Reactive song-source state, persisted to localStorage and shared across mounts. */
export function useSongSourcePrefs() {
  // the stored value is read after mount so server and client markup match
  const [source, setSource] = useState<SongSource>(DEFAULT_SONG_SOURCE);

  useEffect(() => {
    const sync = () => setSource(readStored());
    sync();
    listeners.push(sync);
    return () => {
      listeners = listeners.filter((fn) => fn !== sync);
    };
  }, []);

  function choose(next: SongSource) {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {}
    setSource(next);
    notify();
  }

  return { source, choose };
}
