/** Camelot wheel helpers: code <-> musical key, and which codes mix with which. */

const MINOR = ["Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "Db"]; // 1A..12A
const MAJOR = ["B", "F#", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E"]; // 1B..12B

export function keyName(code: string): string {
  const m = /^(\d{1,2})([AB])$/.exec(code);
  if (!m) return "";
  const n = parseInt(m[1], 10);
  return m[2] === "A" ? `${MINOR[n - 1]} minor` : `${MAJOR[n - 1]} major`;
}

export const wrap = (n: number) => ((((n - 1) % 12) + 12) % 12) + 1;

export type Relation = "same" | "step" | "relative" | "boost2" | "semitone";

/** Every code that mixes well with `code`, and why. */
export function compatible(code: string): Record<string, Relation> {
  const m = /^(\d{1,2})([AB])$/.exec(code);
  if (!m) return {};
  const n = parseInt(m[1], 10);
  const l = m[2];
  const other = l === "A" ? "B" : "A";
  return {
    [`${n}${l}`]: "same",
    [`${wrap(n + 1)}${l}`]: "step",
    [`${wrap(n - 1)}${l}`]: "step",
    [`${n}${other}`]: "relative",
    [`${wrap(n + 2)}${l}`]: "boost2",
    [`${wrap(n + 7)}${l}`]: "semitone",
  };
}

export const RELATION_TEXT: Record<Relation, string> = {
  same: "Same key",
  step: "One step on the wheel",
  relative: "Relative major or minor",
  boost2: "Two steps up: an energy lift",
  semitone: "Seven steps: a semitone lift",
};
