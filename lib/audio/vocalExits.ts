/**
 * Vocal-aware exits. Sung songs breathe in a pattern: a verse or chorus is
 * sung, then the band carries on alone for a few bars before the next line.
 * That pause is where a DJ brings the next record in - nobody's word gets cut
 * off and two singers never overlap. The library stores where each song is
 * sung (`vocals`, from Demucs - scripts/library/vocal_map.py); this turns
 * those stretches into ranked exit points on the beat grid.
 *
 * Dense pop and rap barely pause at all, so the end of any sung line (a
 * breath of a third of a second) is the fallback: still no word cut in half.
 *
 * No imports so the mobile app can carry an identical copy.
 */

/** Sung stretches in seconds, [start, end], sorted. */
export type VocalSegments = [number, number][];

export interface VocalExit {
  /** Track position where the sung line has ended (snapped to the grid). */
  at: number;
  /** Seconds of no singing from `at` until the next line starts. */
  room: number;
  /** How long the stretch of singing that ends here ran ("the para"). */
  para: number;
  /** 0..1: how much quieter the music gets after the line (the "low tone"). */
  dip: number;
  /** 0..1 overall quality - every "break" outranks every "line". */
  score: number;
  /** "break": the band plays alone for a bar or more; "line": only a breath. */
  kind: "break" | "line";
}

interface Grid {
  bpm: number;
  beatOffset: number;
  downbeatOffset?: number;
  energy: number[];
  duration: number;
}

/** A pause shorter than this is a breath between lines, not a break. */
const MIN_ROOM = 2.5;
/** The shortest breath that still separates two lines. */
const LINE_GAP = 0.3;
/** A sung stretch shorter than this is an ad-lib or a chopped syllable. */
const MIN_LINE = 1;

export function vocalExits(vocals: VocalSegments | undefined, grid: Grid): VocalExit[] {
  if (!vocals?.length) return [];
  const beat = grid.bpm > 0 ? 60 / grid.bpm : 0;
  const bar = beat * 4;
  const anchor = grid.downbeatOffset ?? grid.beatOffset ?? 0;
  // a pause must also span most of a bar, or a slow song's breath qualifies
  const minRoom = Math.max(MIN_ROOM, bar * 0.9);

  const exits: VocalExit[] = [];
  let paraStart = vocals[0][0];
  for (let i = 0; i < vocals.length; i++) {
    const end = vocals[i][1];
    const next = i + 1 < vocals.length ? vocals[i + 1][0] : grid.duration;
    if (next - end < minRoom) {
      // still inside the para - but a finished line is a fallback exit
      if (next - end >= LINE_GAP && end - vocals[i][0] >= MIN_LINE) {
        const onBeat = beat > 0 ? anchor + Math.ceil((end - 0.05 - anchor) / beat) * beat : end;
        const at = next - onBeat >= 0.2 ? onBeat : end;
        const room = next - at;
        exits.push({
          at: round(at),
          room: round(room),
          para: round(end - paraStart),
          dip: 0,
          score: round(0.1 + (0.15 * Math.min(room, 1.5)) / 1.5),
          kind: "line",
        });
      }
      continue;
    }

    // land on the next bar line if it still leaves room, else the next beat:
    // a line often ends just after the 1 it resolves on, so allow a little back
    let at = end;
    if (beat > 0) {
      const onBar = anchor + Math.ceil((end - 0.15 - anchor) / bar) * bar;
      const onBeat = anchor + Math.ceil((end - 0.1 - anchor) / beat) * beat;
      if (next - onBar >= minRoom * 0.8) at = onBar;
      else if (next - onBeat >= minRoom * 0.8) at = onBeat;
    }
    const room = next - at;
    const para = end - paraStart;
    const dip = energyDip(grid.energy, paraStart, end, at, Math.min(room, 8));
    const quality = (0.45 * Math.min(room, 8)) / 8 + 0.3 * dip + (0.25 * Math.min(para, 12)) / 12;
    exits.push({
      at: round(at),
      room: round(room),
      para: round(para),
      dip: round(dip),
      score: round(0.5 + 0.5 * quality),
      kind: "break",
    });
    if (i + 1 < vocals.length) paraStart = vocals[i + 1][0];
  }
  return exits;
}

/**
 * The best exit near `desired`: never before `floor`, at most `late` seconds
 * after `desired`, a little earlier only when the floor allows it. Quality
 * wins, but every second away from the desired moment costs a bit.
 */
export function pickVocalExit(
  exits: VocalExit[],
  desired: number,
  floor: number,
  late = 20,
  early = 8
): VocalExit | null {
  let best: VocalExit | null = null;
  let bestScore = -Infinity;
  for (const e of exits) {
    if (e.at < floor || e.at < desired - early || e.at > desired + late) continue;
    const s = e.score - 0.015 * Math.abs(e.at - desired);
    if (s > bestScore) {
      bestScore = s;
      best = e;
    }
  }
  return best;
}

function energyDip(energy: number[], paraStart: number, paraEnd: number, at: number, len: number): number {
  const before = mean(energy, paraStart, paraEnd);
  const after = mean(energy, at, at + Math.max(1, len));
  if (before <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - after / before));
}

function mean(a: number[], from: number, to: number): number {
  const i0 = Math.max(0, Math.floor(from));
  const i1 = Math.min(a.length, Math.ceil(to));
  let s = 0;
  for (let i = i0; i < i1; i++) s += a[i];
  return i1 > i0 ? s / (i1 - i0) : 0;
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
