"use client";

import { useEffect, useState } from "react";
import { ALL_LANGUAGES } from "@/lib/languages";

export { ALL_LANGUAGES, MORE_LANGUAGES, TOP_LANGUAGES, type Language } from "@/lib/languages";

/**
 * Song-language preference, shared across every song-picker (vibe intent,
 * 9-grid suggestions, search, Sing-It Showdown playlists, arc/reels/talking-DJ).
 * No selection = no constraint (today's default: mix everything).
 */

const STORAGE_KEY = "everplay:languages";

function readStored(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

/** Non-reactive read for call sites that aren't components (e.g. useAutoMix). */
export function getSelectedLanguages(): string[] {
  return readStored();
}

/** Human labels for the currently selected languages, for AI prompts. */
export function getSelectedLanguageLabels(): string[] {
  const codes = new Set(readStored());
  return ALL_LANGUAGES.filter((l) => codes.has(l.code)).map((l) => l.label);
}

let listeners: Array<() => void> = [];
function notify() {
  listeners.forEach((fn) => fn());
}

/** Reactive language-selection state, persisted to localStorage and shared across mounts. */
export function useLanguagePrefs() {
  const [selected, setSelected] = useState<string[]>(() => readStored());

  useEffect(() => {
    const onChange = () => setSelected(readStored());
    listeners.push(onChange);
    return () => {
      listeners = listeners.filter((fn) => fn !== onChange);
    };
  }, []);

  function save(next: string[]) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setSelected(next);
    notify();
  }

  function toggle(code: string) {
    save(selected.includes(code) ? selected.filter((c) => c !== code) : [...selected, code]);
  }

  /** Back to "any language". */
  function clear() {
    save([]);
  }

  return { selected, toggle, clear };
}
