"use client";

import { useState } from "react";

/**
 * Player preferences persisted to localStorage. Currently just the
 * minimum-play floor: how many seconds a song must play before the auto-DJ
 * may hop off it (useAutoMix's `minPlaySec`), user-tunable in Settings.
 */

const STORAGE_KEY = "everplay:minPlaySec";

export const DEFAULT_MIN_PLAY_SEC = 25;
export const MIN_PLAY_RANGE = { min: 10, max: 90, step: 5 } as const;

/** Non-reactive read for call sites that aren't components (e.g. start opts). */
export function getMinPlaySec(): number {
  if (typeof window === "undefined") return DEFAULT_MIN_PLAY_SEC;
  const raw = Number(window.localStorage.getItem(STORAGE_KEY));
  return Number.isFinite(raw) && raw >= MIN_PLAY_RANGE.min && raw <= MIN_PLAY_RANGE.max
    ? raw
    : DEFAULT_MIN_PLAY_SEC;
}

export function useMinPlaySec() {
  const [minPlaySec, setState] = useState(() => getMinPlaySec());

  function setMinPlaySec(v: number) {
    setState(v);
    window.localStorage.setItem(STORAGE_KEY, String(v));
  }

  return { minPlaySec, setMinPlaySec };
}
