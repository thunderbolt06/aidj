import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * User preferences — port of the web langPrefs/playerPrefs, backed by
 * AsyncStorage. Storage is async, so everything loads once into memory at
 * app start (initPrefs) and every read after that is synchronous, matching
 * the web modules' call sites (e.g. useAutoMix reads languages mid-set).
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

const LANG_KEY = "everplay:languages";
const MIN_PLAY_KEY = "everplay:minPlaySec";

export const DEFAULT_MIN_PLAY_SEC = 25;
export const MIN_PLAY_RANGE = { min: 10, max: 90, step: 5 } as const;

let langSelected: string[] = [];
let minPlaySec = DEFAULT_MIN_PLAY_SEC;

/** Hydrate the in-memory cache; call once at app start. */
export async function initPrefs(): Promise<void> {
  try {
    const [lang, minPlay] = await AsyncStorage.multiGet([LANG_KEY, MIN_PLAY_KEY]);
    if (lang[1]) langSelected = JSON.parse(lang[1]) as string[];
    const v = Number(minPlay[1]);
    if (Number.isFinite(v) && v >= MIN_PLAY_RANGE.min && v <= MIN_PLAY_RANGE.max)
      minPlaySec = v;
  } catch {
    /* defaults stand */
  }
  notify();
}

let listeners: Array<() => void> = [];
function notify() {
  listeners.forEach((fn) => fn());
}

/** Non-reactive reads for call sites that aren't components (useAutoMix). */
export function getSelectedLanguages(): string[] {
  return langSelected;
}

/** Human labels for the currently selected languages, for AI prompts. */
export function getSelectedLanguageLabels(): string[] {
  const codes = new Set(langSelected);
  return ALL_LANGUAGES.filter((l) => codes.has(l.code)).map((l) => l.label);
}

export function getMinPlaySec(): number {
  return minPlaySec;
}

/** Reactive language selection, shared across mounts. */
export function useLanguagePrefs() {
  const [selected, setSelected] = useState<string[]>(langSelected);

  useEffect(() => {
    const onChange = () => setSelected([...langSelected]);
    listeners.push(onChange);
    return () => {
      listeners = listeners.filter((fn) => fn !== onChange);
    };
  }, []);

  function toggle(code: string) {
    langSelected = langSelected.includes(code)
      ? langSelected.filter((c) => c !== code)
      : [...langSelected, code];
    AsyncStorage.setItem(LANG_KEY, JSON.stringify(langSelected)).catch(() => {});
    notify();
  }

  return { selected, toggle };
}

/** Reactive minimum-play floor. */
export function useMinPlaySec() {
  const [value, setValue] = useState(minPlaySec);

  useEffect(() => {
    const onChange = () => setValue(minPlaySec);
    listeners.push(onChange);
    return () => {
      listeners = listeners.filter((fn) => fn !== onChange);
    };
  }, []);

  function setMinPlaySec(v: number) {
    minPlaySec = v;
    AsyncStorage.setItem(MIN_PLAY_KEY, String(v)).catch(() => {});
    notify();
  }

  return { minPlaySec: value, setMinPlaySec };
}
