# AIDJ Lab — Feature & Enhancement Roadmap

A living backlog of features, enhancements, and new DJ tricks for AIDJ Lab.
Every item is grounded in the current architecture so it can be picked up and built directly.

**Guiding principles** (from user-test findings):
1. **Latency kills the magic** — nothing loads or thinks at the moment of transition. Prepare-ahead everywhere.
2. **Endless DJs** — the set should never have to end.
3. **Louder failures** — degraded/heuristic modes must be *visible*, not silent.
4. **Heatmap = the famous part** — people want ~1 minute of most songs.

---

## 0. Architecture baseline (what exists today)

| Layer | File | Capability |
|---|---|---|
| Audio engine | [lib/audio/engine.ts](../lib/audio/engine.ts) | Dual-deck Web Audio, 3-band EQ per deck, shared feedback-delay bus, sample-accurate phrase quantization, mashup layering, word-stutter, tension/duck |
| Analysis | [lib/audio/analysis.ts](../lib/audio/analysis.ts) | In-browser BPM (lowpass→peak→tempo vote), beatOffset, per-second energy |
| Source | [lib/server/ytdlp.ts](../lib/server/ytdlp.ts) | yt-dlp search, audio extraction, "most replayed" heatmap → famousStart |
| Orchestration | [lib/client/useAutoMix.ts](../lib/client/useAutoMix.ts) | Prepare-ahead loop, endless refill, beat-grid quantize, instant hops |
| AI | `app/api/ai/*` | Transition planning, intent→queue, 9-grid suggest, MC banter, lyric match/chain, mashup design, MusicGen bridge |
| Stems | [app/api/stems/[id]/route.ts](../app/api/stems/[id]/route.ts) | Replicate demucs (vocals/instrumental), cached |
| Alignment | `app/api/align/route.ts` | Whisper word-level timestamps |
| TTS | `app/api/tts/route.ts` | OpenAI TTS for MC Fable |

**Existing transition styles** (`TransitionStyle` in [lib/types.ts](../lib/types.ts)): `crossfade`, `bass_swap`, `filter_sweep`, `echo_out`, `cut`, `loop_roll`, `brake`, `riser`, `double_drop`.

**Engine scheduling model** (important for every new trick): everything is scheduled on the `AudioContext` clock against a single anchor `t0` (the moment B enters). `t0` snaps to A's beat grid when quantizing; pre-roll effects are scheduled *before* it. `beatCtx` = one A-beat in wall-clock seconds. New tricks should follow this same `t0`/`beatCtx`/`preRoll` pattern so drops stay sample-accurate.

---

## 1. Core enhancements (highest leverage)

### 1.1 Harmonic mixing (key detection) — **top priority** — ✅ DONE
Today we mix on BPM + energy but ignore musical **key**, so a `bass_swap` or `double_drop` between songs a semitone apart sounds sour, and the AI planner can't even know.

- Add chromagram → 24-state Krumhansl-Schmuckler key detection to [analysis.ts](../lib/audio/analysis.ts), offline-rendered like the existing lowpass pass.
- Extend `TrackAnalysis` with `key` (e.g. `"8A"` Camelot, `"F#min"`).
- Feed `key`/`camelot` into the transition prompt ([transition/route.ts](../app/api/ai/transition/route.ts)) so Claude prefers compatible moves and reaches for `echo_out`/`cut` on key clashes.
- UI: show Camelot codes; warn on incompatible manual picks (9-grid, reels).

### 1.2 Loudness normalization — **cheap, very audible** — ✅ DONE
Nothing normalizes levels, so volume jumps between songs (the #1 amateur tell).
- Compute integrated loudness (or RMS/peak) during analysis.
- Apply per-deck trim gain in the engine on `startTrack`/`transition`.

### 1.3 Downbeat-aware beat detection — ✅ DONE (BPM confidence + downbeat phase; half/double-time disambiguation still open)
Phrase quantization trusts `beatOffset`, but it's just `peaks[0]/sr` — the first peak, not a true **downbeat**. "Drop on the 4-bar phrase" can land on the wrong beat-1.
- Add a BPM confidence score; disambiguate half/double-time.
- Estimate the downbeat (spectral-flux onsets + bar-level autocorrelation).
- When confidence is low, fall back to non-quantized transitions instead of confidently mis-snapping.

### 1.4 Key-lock / master tempo (pitch-preserved beatmatch) — ✅ DONE (offline OLA pre-stretch; realtime worklet still open)
`beatMatch` glides `playbackRate`, which also shifts **pitch** — fighting harmonic mixing.
- Add an optional pitch-preserving time-stretch (granular or WSOLA worklet, or `phaze`-style AudioWorklet) so tempo can move without detuning.

### 1.5 Stem-aware transitions (stems exist, only `/mashup` uses them) — ✅ DONE (acapella-in; vocal-clash duck + drums-only outro still open)
- **Acapella-in / instrumental-out**: drop B's vocal over A's instrumental for a few bars before the full swap (classic radio move).
- **Vocal-clash avoidance**: duck the *outgoing vocal stem* instead of the whole track.
- **Drums-only outro**: strip A to its drum stem under B's intro.
- Pre-warm stems during prepare-ahead so they're cached before the hop.

---

## 2. New transition styles (the fun part)

All follow the engine's `t0` / `beatCtx` / `preRoll` scheduling pattern. Add each to the `TransitionStyle` union and the `switch` in `transition()`.

### 2.1 Backspin / spinback — ✅ DONE
Vinyl rewind: A's playhead accelerates *backwards* over 1–2 beats, then B slams on the `1`.
- Schedule `A.source.playbackRate` ramp negative isn't supported natively → emulate by swapping to a reversed buffer slice of A's last ~2 beats and ramping rate up, or pre-render a reversed tail. Echo swell on `echoSend`, hard gate A at `t0`.

### 2.2 Tape stop — ✅ DONE
Like `brake` but faster and pitch-dropping — power-cut feel. `exponentialRampToValueAtTime(0.02)` over ~0.5 beat, low-pass closing simultaneously, then B drops.

### 2.3 Reverse-cymbal / reverb-freeze swell — ✅ DONE (delay-feedback wash; convolver version still open)
Capture A's last beat into a freeze (long-tail convolution or held delay with feedback→1.0), swell it over 4 beats while A's dry signal pulls out, release into B. Reuses the `echoSend` bus; add a convolver for a lush version.

### 2.4 Beat juggle / chop swap
Alternate 1-beat (then ½, then ¼) slices of A and B on the grid for 2 bars — A/B/A/B/AB — then settle on B. Generalizes `loop_roll` to two sources; schedule alternating `BufferSource` segments on both decks.

### 2.5 Gate / strobe (rhythmic tremolo) — ✅ DONE
Hard-gate A's gain on 8th or 16th notes for a bar (square-wave amplitude via stepped `setValueAtTime`), crossfading the gate density toward B. Pure scheduling, no new nodes.

### 2.6 Sidechain pump
Pump A's gain to B's kick pattern (ducking on each beat) for the blend window, so the two lock into one groove. Drive the ducking envelope from B's detected `beatOffset`/BPM.

### 2.7 Half-time / double-time flip
Drop A to half-time (or push to double-time) for a bar before the swap — huge tension change. Combine a `playbackRate` halving on a looped slice with the gate trick.

### 2.8 Silence drop ("build → cut → slam") — ✅ DONE (incl. impact one-shot)
At the phrase boundary, cut *everything* for a beat (dead air), then slam B on the next `1`. The pause makes the drop hit harder. Trivial gain scheduling; add a tiny impact one-shot for polish.

### 2.9 Bitcrush / lo-fi degrade
Degrade A (sample-rate/bit reduction via a `WaveShaper` + downsampler worklet, or a steep resonant LPF as a fake) over 4 beats into a clean B drop. "Falling apart then rebuilt."

### 2.10 Phaser / flanger sweep
Sweep a flanger (short modulated delay) across A as it fades — psychedelic riser alternative to `filter_sweep`. Add a modulated `DelayNode` + LFO `OscillatorNode`.

### 2.11 Scratch / transformer cut (advanced)
Short scratch of A's last beat (forward/back slices) gated in transformer rhythm, then drop. Hardest to make musical — gate a reversed/forward slice pair on 16ths.

### 2.12 Vocal-throw (stem-powered)
Throw an echoed one-shot of A's last vocal word (from the demucs vocal stem + Whisper word timing) over B's intro. Ties together stems (§1.5), alignment, and the existing word-stutter machinery.

### 2.13 FX one-shots / sampler layer
A small bank of riser/impact/airhorn/vinyl-crackle samples that can be triggered manually or auto-layered under any transition for "produced" polish.

---

## 3. New AI & intelligence features

### 3.1 Genre-aware transition profiles — ✅ DONE (planner-side; explicit genre tag/fingerprint still open)
Detect/tag genre (audio fingerprint or AI from title/artist) and bias the planner: EDM → `riser`/`double_drop`, hip-hop → `cut`/`backspin`, ballads → `crossfade`/`reverb-freeze`. Answers an open README question ("which transition per genre?").

### 3.2 Energy-arc director
Let the user set an arc (warm-up → peak → cool-down) and have the AI pace BPM, energy, and transition intensity across the *whole set*, not just the next hop. Extends the `energyArc` field already in [intent/route.ts](../app/api/ai/intent/route.ts).

### 3.3 BPM-ramp sets
Gradually raise tempo across the set (e.g. 120→128) like a real club build, using key-lock so it stays musical.

### 3.4 Drop detector
For EDM/build-heavy tracks, detect the actual drop (energy derivative spike after a break) instead of relying on the heatmap, and time `riser`/`double_drop` to it.

### 3.5 AI plan + queue caching
Cache transition plans by `(trackA.id, trackB.id, positionBucket)` and intent queues by prompt. Recomputing every hop wastes latency budget — aligns with "prepare-ahead everywhere."

### 3.6 Request / co-pilot mode
Audience (or user) types a request mid-set; the AI slots it in at the next musically sensible point and announces it via MC Fable.

### 3.7 Two-AI battle / B2B mode
Two AI DJ personas trade every N songs, each trying to one-up the other's energy — narrated banter between them.

---

## 4. Live performance & control

### 4.1 Hot cues & live loops
Tap to set cue points on the active deck; loop a region live (½/1/2/4 bar) as a performance effect — the engine's looped `BufferSource` plumbing already exists in `loop_roll`/`stutterTransition`.

### 4.2 Manual FX pads
Expose echo, filter, gate, and the new FX as momentary touch pads over the now-playing screen (great on mobile / `/gestures`).

### 4.3 Tempo & crossfader nudge
Manual pitch-bend nudge and a real crossfader for hands-on mixing alongside the auto-pilot.

### 4.4 Mic / voice control everywhere
`/talkingdj` has mic vibe-changes; generalize voice commands ("take it down", "drop it", "skip") across all modes.

### 4.5 Crowd-reactive mode
Use the device mic to gauge room energy (or a "hype" button) and feed it into the energy-arc director.

---

## 5. Product, persistence & social

### 5.1 Recordable mixtapes — **viral loop** — ✅ DONE (live capture + setlist; shareable link needs §5.2)
Wire the engine's master output through `MediaRecorder` to capture a real mix. Save setlist + transition log; produce a shareable link. The [/export page](../app/export/page.tsx) is the natural home.

### 5.2 Persisted sets & history
Save queues, replay past sets, "continue where I left off." Currently nothing persists.

### 5.3 Waveform + heatmap timeline
[HeatmapBar.tsx](../components/HeatmapBar.tsx) exists — extend to a scrubbable waveform showing the upcoming drop point, the armed transition style, and a "drop now" override.

### 5.4 Unified player shell
The 11 lab routes are disconnected. Put them behind one player with a mode switcher so it feels like a product, not a demo grid.

### 5.5 Collaborative queue
Multiple people add to one live queue (shared room); AI orders for flow.

### 5.6 AI-generated reactive visuals
Beat/energy-synced visuals (or AI art per song) for the `/reels` and big-screen modes.

---

## 6. Infrastructure & reliability

### 6.1 Deployable source layer
yt-dlp can't run on Vercel serverless. Stand up a small self-hosted extractor (Fly/Railway + residential proxy) behind `YTDLP_PATH` so the deployed site actually works, not just a UI preview.

### 6.2 Visible degraded mode ("louder failures") — 🟡 PARTIAL (shaky-BPM badge + "stems not ready → echo_out" surfaced; AI-unavailable + no-quantize states still silent)
Surface "AI unavailable → heuristic crossfade" and "low BPM confidence → no quantize" in the UI instead of silently falling back.

### 6.3 Analysis web worker
Move BPM/energy/key analysis to a Web Worker so decode+analyze never jank the main thread during prepare-ahead.

### 6.4 Persistent server cache
Cache `.cache/` analysis (BPM/key/loudness) keyed by video id server-side so repeat loads skip re-analysis.

### 6.5 Robustness
Retry/backoff on yt-dlp, graceful handling of region-blocked/age-gated videos, and dead-track auto-skip (partially handled in `hopNow`).

---

## 7. Suggested build order

| Priority | Item | Why | Effort | Status |
|---|---|---|---|---|
| P0 | 1.1 Key detection | Unlocks correct harmonic mixing everywhere | M | ✅ shipped |
| P0 | 1.2 Loudness normalization | Cheapest, most audible quality win | S | ✅ shipped |
| P1 | 1.3 Downbeat detection | Fixes the foundation quantization stands on | M | ✅ shipped |
| P1 | 5.1 Recordable mixtapes | Product/viral hook | M | ✅ shipped |
| P1 | 2.8 / 2.1 / 2.3 Silence drop, backspin, reverb-freeze | High-impact, low-dependency new tricks | S–M | ✅ shipped (+ tape_stop, gate) |
| P2 | 1.5 Stem-aware transitions | Differentiated "real DJ" moves; stems already exist | M | ✅ shipped (acapella-in) |
| P2 | 3.1 Genre-aware profiles | Answers an open research question | S | ✅ shipped (planner-side) |
| P2 | 1.4 Key-lock / master tempo | Enables BPM-ramp + clean harmonic beatmatch | L | ✅ shipped (pre-stretch) |
| P3 | 4.x Live FX / hot cues | Hands-on performance layer | M | — |
| P3 | 6.1 Deployable extractor | Makes the hosted site fully functional | M | — |

**Recommended first PR:** §1.1 + §1.2 together — both live in [analysis.ts](../lib/audio/analysis.ts), are self-contained, and reinforce every existing transition.

### Shipped in this pass (2026-06-18)
- **§1.1 Key detection** — Goertzel chromagram → Krumhansl-Schmuckler → Camelot in [analysis.ts](../lib/audio/analysis.ts); `camelot`/`keyName`/`keyConfidence` on `TrackAnalysis`; `camelotCompatible`/`camelotDistance` helpers. Camelot shown in `/autodj` and `/mix`; fed to the planner with a `harmonic` flag; heuristic plan now echoes out on key clashes.
- **§1.2 Loudness normalization** — integrated RMS in analysis → per-deck `trim` gain node in the engine, applied on `startTrack` and every `transition`.
- **§1.3 Downbeat detection** — kick-energy beat-phase estimate → `downbeatOffset`; phrase quantization (both A's grid and B's entry snap) now anchors on it. `bpmConfidence` added and surfaced ("⚠ shaky BPM").
- **New tricks** — `silence_drop`, `backspin`, `tape_stop`, `reverb_freeze`, `gate` in the engine + `TransitionStyle` union, AI prompt, and the `/autodj` trick picker.
- **§3.1 Genre-aware + harmonic planning** — transition prompt now biases by inferred genre, key compatibility, and BPM confidence.

### Shipped in pass 2 (2026-06-18)
- **§5.1 Recordable mixtapes** — engine taps master → `MediaStreamDestination` → `MediaRecorder` (`startRecording`/`stopRecording`). `useAutoMix` exposes `recording`, `mix` (blob URL + duration) and a `setLog` tracklist accumulated per hop. `/autodj` gets a ● Record button, an inline player, a download link, and a copyable setlist. (Shareable *links* still need the persistence/storage layer — §5.2.)
- **§1.5 Stem-aware transitions** — new `stem_acapella` style: `DJEngine.stemSwap()` rides B's demucs **vocal stem** over A's groove for 8 beats (A's mids/highs ducked), then drops B's full mix on the phrase and swaps the low end. `loadStem`/`stemReady` in [dj.ts](../lib/client/dj.ts) cache stems; `useAutoMix` pre-warms B's vocal during prepare-ahead and falls back **loudly** to `echo_out` if the stem isn't ready at hop time. Planner may pick it only when `stemsAvailable` is true.
- **§1.4 Key-lock / master tempo** — [timestretch.ts](../lib/audio/timestretch.ts) does a pitch-preserving OLA time-stretch. With key-lock on, `useAutoMix` pre-stretches B (during prepare-ahead) so playing it at rate 1 lands it at A's tempo *in its own key* — no detune from `playbackRate`. Mild factors only (engages within the ±8% beat-match window). Toggle in `/autodj`.
