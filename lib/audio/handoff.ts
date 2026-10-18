/**
 * Vocal handoff: the beat changes first, the singer changes later.
 *
 * The stem-era club move (Serato Stems / rekordbox / djay all teach it): B's
 * instrumental comes in under A's singer, so for a few bars A's vocal rides
 * B's groove - then A's line ends, A's vocal echoes out, and B's own singer
 * comes in on the next bar. Two beats never fight for long and two singers
 * never overlap.
 *
 * It needs no stored stems for B: B starts a few bars before one of its sung
 * entries, so what plays under A's vocal IS B's instrumental (B's vocal map,
 * from Demucs at ingest, says where B is silent). For A the engine keeps the
 * vocal with a vocal-focus filter.
 *
 * It only works when A's voice suits B's music, so it is gated on harmonic
 * keys and a tight tempo match (the experts' first warning: an Am vocal over
 * an F# track "sounds painful").
 *
 * Only a type import (vocalExits sits next to it in the mobile app too), so
 * the mobile app can carry an identical copy.
 */

import type { VocalExit, VocalSegments } from "./vocalExits";

interface Grid {
  bpm: number;
  beatOffset: number;
  downbeatOffset?: number;
  duration: number;
}

/** Where B comes in: a stretch of B's music with B's singer arriving at the end. */
export interface HandoffEntry {
  /** B position to start playing - on B's bar grid. */
  inPoint: number;
  /** B position of the bar line where B's singer arrives. */
  entry: number;
  /** Bars of B's instrumental under A's vocal (2-4). */
  bars: number;
  /** Seconds B's singer starts before the `entry` bar line (a pickup), ≥ 0. */
  pickup: number;
}

/** Where A goes out: the bar after a sung line ends, with the hold before it. */
export interface HandoffExit extends VocalExit {
  /** A position where B comes in (B's instrumental starts). */
  dropAt: number;
  /** 0..1: how much of the hold A's singer is actually singing over B's beat. */
  sung: number;
}

const MIN_BARS = 2;
const MAX_BARS = 4;
/** B's singer has to actually arrive: this much singing in the 8 s after the entry. */
const MIN_ENTRY_SINGING = 3;
/** Hold where A sings less than this share of the time is just a bass swap. */
const MIN_SUNG = 0.35;

/** Within ±6% the singer stays on B's beat without audible detune. */
export const HANDOFF_MAX_TEMPO_GAP = 0.06;

export function handoffTempoOk(aBpm: number, bBpm: number): boolean {
  if (!(aBpm > 0) || !(bBpm > 0)) return false;
  return Math.abs(aBpm / bBpm - 1) <= HANDOFF_MAX_TEMPO_GAP;
}

/**
 * The best place for B's instrumental to start: 2-4 clean bars of no singing
 * that end on a bar where B's singer comes in, nearest to B's hook (`target`)
 * so the listener lands in the famous part. Null when B never pauses that long
 * (or has no vocal map).
 */
export function handoffEntry(
  vocals: VocalSegments | undefined,
  grid: Grid,
  target: number | null | undefined
): HandoffEntry | null {
  if (!vocals?.length || !(grid.bpm > 0)) return null;
  const bar = (4 * 60) / grid.bpm;
  const anchor = grid.downbeatOffset ?? grid.beatOffset ?? 0;
  const want = target ?? 45;

  let best: HandoffEntry | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < vocals.length; i++) {
    const start = vocals[i][0];
    if (start > grid.duration - 30) break;
    const prevEnd = i > 0 ? vocals[i - 1][1] : 0;
    if (singing(vocals, start, start + 8) < MIN_ENTRY_SINGING) continue;

    // the bar line the singer arrives on - a pickup of up to half a bar early
    const entry = anchor + Math.ceil((start - anchor - bar / 2) / bar) * bar;
    const pickup = Math.max(0, entry - start);
    // clean bars before the singer: no singing from inPoint until they arrive
    const bars = Math.min(MAX_BARS, Math.floor((entry - prevEnd + 0.15) / bar));
    if (bars < MIN_BARS) continue;
    const inPoint = entry - bars * bar;
    if (inPoint < 0) continue;
    if (singing(vocals, inPoint, start - 0.15) > 0.3) continue;

    // a singer arriving a little before the hook leads into it; arriving after
    // it means the listener missed the famous part
    const off = entry - want;
    const score = (off <= 0 ? off / 30 : -off / 12) + (bars >= MAX_BARS ? 0.15 : 0) - pickup;
    if (score > bestScore) {
      bestScore = score;
      best = { inPoint: round(inPoint), entry: round(entry), bars, pickup: round(pickup) };
    }
  }
  return best;
}

/**
 * A's exits for a handoff of `bars`: the first bar line after each sung line
 * ends (B's singer arrives there), with B coming in `bars` earlier so A's
 * last line rides B's beat. `exits` are A's vocal exits (vocalExits()).
 * `pickup` is how early B's singer starts before that bar - A must be done by then.
 */
export function handoffExits(
  exits: VocalExit[],
  vocals: VocalSegments | undefined,
  grid: Grid,
  bars: number,
  pickup = 0
): HandoffExit[] {
  if (!vocals?.length || !(grid.bpm > 0)) return [];
  const bar = (4 * 60) / grid.bpm;
  const anchor = grid.downbeatOffset ?? grid.beatOffset ?? 0;
  const hold = bars * bar;
  const out: HandoffExit[] = [];
  for (const e of exits) {
    // the bar where B's singer takes over: A's line is over by then (minus B's pickup)
    let at = anchor + Math.ceil((e.at - 0.1 - anchor) / bar) * bar;
    if (at - pickup < e.at - 0.15) at += bar;
    // A's singer must not start a new line before the handoff
    if (e.at + e.room < at - 0.1) continue;
    const dropAt = at - hold;
    if (dropAt < 0) continue;
    const sung = singing(vocals, dropAt, at) / hold;
    if (sung < MIN_SUNG) continue;
    out.push({
      ...e,
      at: round(at),
      room: round(e.at + e.room - at),
      dropAt: round(dropAt),
      sung: round(sung),
      score: round(e.score + 0.3 * sung),
    });
  }
  return out;
}

/** Seconds of singing inside [from, to]. */
function singing(vocals: VocalSegments, from: number, to: number): number {
  let s = 0;
  for (const [a, b] of vocals) {
    if (b <= from) continue;
    if (a >= to) break;
    s += Math.min(b, to) - Math.max(a, from);
  }
  return s;
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
