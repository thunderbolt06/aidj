import { TapTempo } from "./TapTempo";
import { BpmKeyDetector } from "./BpmKeyDetector";
import { CamelotWheel } from "./CamelotWheel";
import { DelayCalculator } from "./DelayCalculator";
import { PitchTempoCalculator } from "./PitchTempoCalculator";
import { TransitionLengthCalculator } from "./TransitionLengthCalculator";
import { BpmCheatSheet } from "./BpmCheatSheet";

export const TOOL_SLUGS = [
  "tap-tempo",
  "bpm-key-detector",
  "camelot-wheel",
  "delay-time-calculator",
  "pitch-tempo-calculator",
  "transition-length-calculator",
  "bpm-cheat-sheet",
];

/** The interactive part of a tool page, by slug. */
export function ToolFor({ slug }: { slug: string }) {
  switch (slug) {
    case "tap-tempo": return <TapTempo />;
    case "bpm-key-detector": return <BpmKeyDetector />;
    case "camelot-wheel": return <CamelotWheel />;
    case "delay-time-calculator": return <DelayCalculator />;
    case "pitch-tempo-calculator": return <PitchTempoCalculator />;
    case "transition-length-calculator": return <TransitionLengthCalculator />;
    case "bpm-cheat-sheet": return <BpmCheatSheet />;
    default: return null;
  }
}
