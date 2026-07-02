"use client";

import { useEffect, useState } from "react";

/**
 * Song-language preference, shared across every AI song-picker (vibe intent,
 * 9-grid suggestions, Sing-It Showdown playlists, arc/reels/talking-DJ). No
 * selection = no constraint (today's default: mix everything).
 */

export interface Language {
  code: string;
  label: string;
}

/** Shown by default in the settings panel. */
export const TOP_LANGUAGES: Language[] = [
  { code: "english", label: "English" },
  { code: "hindi", label: "Hindi" },
  { code: "spanish", label: "Spanish" },
  { code: "punjabi", label: "Punjabi" },
  { code: "korean", label: "Korean" },
];

/** Revealed behind "+ more". */
export const MORE_LANGUAGES: Language[] = [
  { code: "tamil", label: "Tamil" },
  { code: "telugu", label: "Telugu" },
  { code: "bengali", label: "Bengali" },
  { code: "marathi", label: "Marathi" },
  { code: "gujarati", label: "Gujarati" },
  { code: "kannada", label: "Kannada" },
  { code: "malayalam", label: "Malayalam" },
  { code: "bhojpuri", label: "Bhojpuri" },
  { code: "urdu", label: "Urdu" },
  { code: "french", label: "French" },
  { code: "arabic", label: "Arabic" },
  { code: "portuguese", label: "Portuguese" },
  { code: "japanese", label: "Japanese" },
  { code: "mandarin", label: "Mandarin" },
  { code: "german", label: "German" },
];

export const ALL_LANGUAGES: Language[] = [...TOP_LANGUAGES, ...MORE_LANGUAGES];

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

  function toggle(code: string) {
    const next = selected.includes(code)
      ? selected.filter((c) => c !== code)
      : [...selected, code];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setSelected(next);
    notify();
  }

  return { selected, toggle };
}
