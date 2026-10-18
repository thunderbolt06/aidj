import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { extractJson } from "@/lib/server/extractJson";
import type { TransitionPlan } from "@/lib/types";

export const dynamic = "force-dynamic";

const SYSTEM = `You are a world-class club DJ planning a single transition between two songs.
You receive analysis for track A (currently playing) and track B (next up): BPM (+confidence
0-1), musical key as a Camelot code + name, duration, per-second energy (0-1), the hook
("famous section") start detected from the audio, and the current playhead position in A. A top-level
"harmonic" boolean says whether the two keys are compatible on the Camelot wheel.

Pick the transition that will feel best to a casual listener:
- crossfade: safe default, melodic/slow songs
- bass_swap: both tracks rhythmic and BPMs within ~8% - the smooth club move
- filter_sweep: energy is rising into B's hook
- echo_out: big vibe change, tempo mismatch, or dramatic moment
- cut: only when B's hook hits instantly hard
- loop_roll: HIGH-ENERGY signature move - A stutters in a 1→half→quarter beat roll
  for 4 beats then SLAMS into B. Use when both songs are bangers and the crowd is up.
- brake: vinyl brake - A grinds to a halt over 1.5 beats, then B drops. Perfect for
  dramatic genre/era/tempo jumps where blending would sound bad.
- riser: 4-beat white-noise sweep while A's bass drains away, then a hard drop into B.
  Use when B opens with a big drop/hook and you want maximum anticipation.
- double_drop: A and B's hooks slam TOGETHER for 8 beats before A exits. Spectacular
  but risky - ONLY when BPMs are within ~4%, harmonic is true, and both are high-energy.
- silence_drop: cut to DEAD AIR for a beat, then slam B on the 1. The pause makes the drop
  hit harder. Great for a big hook entrance on B; works across keys.
- backspin: vinyl rewind - A's last 2 beats reverse and accelerate, then B slams. Hip-hop /
  high-energy move for a hard cut feel.
- tape_stop: power-cut - A pitch-drops to a halt over a beat, then B drops. Playful, dramatic
  era/tempo jumps; safe on key clashes.
- gate: rhythmic strobe-gate on A for a bar while B fades up - tension build between two
  groovy tracks.
- stem_acapella: B's ISOLATED VOCAL rides in over A's groove for a few bars, then B's full mix
  drops in - the signature "radio" move. ONLY choose this when stemsAvailable is true in the
  input, ideally when B has a strong, recognizable vocal hook.
- vocal_handoff: the beat changes first, the singer later - B's instrumental comes in under A's
  singer, A's last line rides B's groove for 2-4 bars, then A's vocal echoes out and B's own singer
  takes over on the next bar. The smoothest move for two SUNG songs; the in/out timing is computed
  from the vocal maps automatically. ONLY choose this when handoffAvailable is true in the input
  (keys and tempo already checked). Great for pop, Bollywood/Punjabi, hip-hop, R&B.

HARMONIC MIXING: when harmonic is false (keys clash), AVOID bass_swap and double_drop - the
overlapping basslines/chords will sound sour. Prefer echo_out, cut, backspin, tape_stop,
silence_drop or gate, which mask or sidestep the clash. When harmonic is true, blends
(bass_swap, crossfade, filter_sweep, double_drop, stem_acapella, vocal_handoff) are safe and smooth.

GENRE: infer genre from the titles/artists and bias accordingly - EDM/dance → riser, loop_roll,
double_drop, silence_drop; hip-hop/rap → cut, backspin, bass_swap, vocal_handoff; pop → bass_swap, filter_sweep,
stem_acapella, vocal_handoff; ballads/R&B/acoustic → crossfade, echo_out, filter_sweep.

CONFIDENCE: if either bpmConfidence is low (<0.15), avoid tempo-locked blends (bass_swap,
double_drop) and beatMatch - prefer echo_out/crossfade/filter_sweep that don't depend on a
tight grid.

ENERGY ARC: if an "arc" object is present, the set is being paced along an energy curve.
arc.phase is the current target ("chill" | "groovy" | "hype" | "peak") and arc.styleBias lists
several tricks that fit it, roughly ordered safest→boldest. Pick a style FROM arc.styleBias, but
ROTATE through the list - do NOT keep choosing the first/same entry every hop. chill → gentle
blends, peak → big dramatic drops. This makes the whole set feel like a journey, not a string of
unrelated hops.

VARIETY (important): "recentStyles" lists the last few tricks already used, most recent first.
NEVER pick a style that appears in recentStyles unless every other sensible option is ruled out
by harmonic/confidence/genre constraints. A real DJ never repeats the same trick twice in a row,
and rarely reuses one within a handful of hops - actively reach for a fresh move each time.

Rules:
- outPoint: a natural exit in A - never before the current position, and CRITICALLY: let A's
  famous section play out in full before leaving. If A has famousStart, outPoint must be at
  least famousStart + 35 (the hook plus a phrase), unless the current position is already past
  that. Prefer an energy dip or phrase end after the hook lands. A typical good clip runs
  40-70s of A before exiting. trackA.vocalBreaks (when present) lists moments where a sung
  line ends and the band plays alone - the smoothest exits; pick outPoint from that list.
- inPoint: start B slightly BEFORE its famous section so the hook lands right as the transition completes (inPoint ≈ famousStart - duration, min 0). If no famousStart, pick a high-energy point after intro.
- duration: 4-12s for blends. cut/loop_roll/brake/riser/backspin/tape_stop/silence_drop = 0.1
  (the pre-roll happens automatically). double_drop = 4. echo_out = 6-8. gate/stem_acapella = 0.1
  (their builds are scheduled automatically). vocal_handoff: any (its length and inPoint are
  computed from the vocal maps).
- For cut/loop_roll/brake/riser/backspin/tape_stop/silence_drop/gate/stem_acapella:
  B's hook should land EXACTLY at entry - inPoint ≈ famousStart.
- beatMatch true only if BPMs within 8% AND both bpmConfidence ≥ 0.15.

Respond with ONLY a JSON object: {"style": "...", "outPoint": n, "inPoint": n, "duration": n, "beatMatch": bool, "reasoning": "one sentence, fun, DJ-speak"}`;

export async function POST(req: NextRequest) {
  const body = await req.json();
  const client = new Anthropic();

  const msg = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 400,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          trackA: body.trackA, // {title, bpm, bpmConfidence, camelot, key, duration, energy, position, famousStart, vocalBreaks}
          trackB: body.trackB, // {title, bpm, bpmConfidence, camelot, key, duration, energy, famousStart}
          harmonic: body.harmonic, // keys compatible on the Camelot wheel?
          stemsAvailable: body.stemsAvailable ?? false, // may we pick stem_acapella?
          handoffAvailable: body.handoffAvailable ?? false, // may we pick vocal_handoff?
          arc: body.arc, // { energy, phase, styleBias } when an arc set is running
          recentStyles: body.recentStyles ?? [], // tricks just used - avoid repeating
        }),
      },
    ],
  });

  const text = msg.content[0].type === "text" ? msg.content[0].text : "{}";
     try {
    const plan = extractJson<TransitionPlan>(text);
    return NextResponse.json(plan);
  } catch {
    return NextResponse.json(
      { error: "model returned invalid plan", raw: text },
      { status: 502 }
    );
  }
}
