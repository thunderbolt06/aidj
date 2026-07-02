# AIDJ Lab , Vision & Roadmap

> Intent-based music with AI-generated DJ transitions. An experiment lab for finding the one music experience that feels magical enough to go viral.

---

## 1. The Objective

**AIDJ Lab turns any two songs on the internet into a seamless, beat-matched, club-quality DJ mix , automatically, in the browser, in real time.**

The user never touches a crossfader, never learns beatmatching, never owns a music library. They express an *intent* , a vibe, a singer, a pair of songs, a swipe , and the app does what a skilled human DJ would do: find the famous part of each song, read its BPM and energy, pick the right transition trick, and drop the next song exactly on the beat.

It is built as a **lab of parallel experiments** rather than a single product, because the core bet is that the winning music experience hasn't been found yet , only by building each idea thoroughly and testing it can we discover which one resonates.

---

## 2. The Goal & Intentions

### The core thesis
Three observations drive the whole project:

1. **Music consumption hasn't fundamentally changed in 15–20 years.** Streaming replaced ownership, but the unit is still "play a song start to finish." Reels-in-music and fully-AI-generated music have both flopped. What *does* work , remixes, mashups, DJ transitions, the "1-minute mark" drop , has never been productized for everyone.
2. **Only a small part of a song is famous, and people get bored after it.** The hook is the product; the rest is filler. An experience built around *only the famous parts*, stitched together, could be more engaging than any single track.
3. **The magic dies with latency.** Any visible "thinking" at the moment of a transition breaks the illusion. Everything must be prepared ahead so the user's action only ever *executes*, never *waits*.

### What we're optimizing for
- **Magic over correctness.** The goal is a moment that makes someone say "how did it *do* that?" , a wordplay cut on a line they're already singing, a drop that lands perfectly on the beat.
- **Zero friction.** No uploads, no library, no DJ knowledge. Type a vibe, or just swipe.
- **Endless by default.** A set should never stall or end , queues auto-refill, DJs play forever.
- **Shareability.** The output should be postable , a vertical reel for Instagram/YouTube that makes people ask what app made it.

### Who it's for
Casual listeners and creators , at a party, on a road trip, in earphones, doing karaoke, or making content. Not DJs. The skill is in the software.

---

## 3. How It Works (Current Architecture)

| Layer | Implementation |
|---|---|
| **Source** | YouTube via `yt-dlp` , search, audio extraction, and the "most replayed" heatmap. Audio cached locally. |
| **Famous-part detection** | Peak of YouTube's replay heatmap , the data-driven "where's the hook" signal. |
| **Analysis** | In-browser BPM detection (lowpass → peak-interval voting), per-second energy, beat-grid offset. |
| **Transition engine** | A dual-deck Web Audio engine. Everything is scheduled on the AudioContext clock against the beat grid, so drops land sample-accurate (no timer drift). |
| **AI brain** | Claude plans transitions, builds queues, writes DJ banter, matches lyrics, designs mashups. OpenAI Whisper aligns words to audio; OpenAI TTS voices the DJ. Replicate runs MusicGen (bridges) and demucs (stems). |
| **Resilience** | Heuristic fallbacks everywhere , the app works without keys (minus the AI flavor), and a failed track is skipped rather than stalling the set. |

### The transition trick arsenal
The engine implements nine beat-locked transition styles: `crossfade`, `bass_swap`, `filter_sweep`, `echo_out`, `cut`, plus the signature moves , `loop_roll` (1→½→¼-beat stutter then slam), `brake` (vinyl halt), `riser` (noise sweep + bass pull-out), and `double_drop` (two hooks together for 8 bars). The AI picks per-transition; the user can also force any trick.

---

## 4. The Experiments (Current Surface)

Each is a route in the app , a distinct bet on what makes music engaging.

| Experiment | The bet it tests |
|---|---|
| **2-Song Mix** | The core engine: can AI pick + render a transition better than a human would bother to? |
| **Auto-DJ** | The "famous parts only" thesis , play the hook, hop on AI-decided timing, forever. |
| **Vibe Prompt** | Natural-language intent ("singable road trip") → a curated, vibe-arced set; spoken vibe changes mid-set. |
| **9-Grid** | Choose-your-adventure listening , tap one of nine AI-suggested next songs (safe / shift / wild). |
| **Gestures** | TikTok-feel tactile control , hold to build tension, release to drop, swipe to skip. |
| **Karaoke** | Synced lyrics, tap-a-line-to-jump sing-along. |
| **Lyric DJ** | The wordplay bet , chain songs that share a *sung word*, stutter-loop it on the beat (Whisper-aligned), drop the next song on the same word in its hook. |
| **Talking DJ** | Personality , an AI DJ (MC Fable) that banters over ducked music and answers back to your voice. |
| **Mashup** | Layered listening , one vocal at a time via hook rotation (tempo-locked) or real demucs stems; infinite by singer/year/theme/prompt. |
| **Reels Feed** | The virality bet , a vertical swipe feed where the swipe *is* the transition, auto-refilling forever. |
| **Generated Bridge** | Creative synthesis , MusicGen composes a custom bridge clip from song A's world into song B's. |
| **Export Reel** | The shareable artifact , render a famous-parts mega-mix to a vertical MP4 for social. |

---

## 5. Design Principles (Learned from Testing)

These are non-negotiable, earned through user feedback:

1. **Prepare-ahead everything.** Load, analyze, and plan the next move *while the current one plays*. The user action only executes a pre-computed result. Nothing fetches or "thinks" at the transition moment.
2. **Work in beats, not seconds.** Wall-clock `setTimeout` drifts and misses beats. Everything is scheduled on the audio clock against the beat grid.
3. **Lean on the hook.** People relate to the part they already know. Wordplay cuts, transition landings, and clip selection all gravitate to the famous section.
4. **Fail loud, never silent.** A silent fallback (e.g. a plain crossfade where a generated bridge was expected) reads as "broken." Surface what happened.
5. **Endless by default.** Auto-refill queues; skip bad tracks instead of stalling.
6. **Exact over approximate.** When a word needs to be cut on, transcribe the actual audio (Whisper) rather than guessing its position.

---

## 6. Future Enhancements & Feature Opportunities

### A. Deepen what exists (highest leverage)
- **Whisper-aligned beat grid, not just BPM.** Detect actual downbeats and phrase boundaries (madmom / beat-this models) so phrase quantization is musical, not arithmetic. Detect bar-1 of choruses for perfect double-drops.
- **Musical key detection + harmonic mixing.** Add key analysis (Camelot wheel) so the AI only blends harmonically compatible songs , the difference between "smooth" and "clashing."
- **Stem-powered transitions everywhere.** Pre-render demucs stems for queued songs so *every* transition can swap vocals/drums independently (acapella-in, drums-out), not just the mashup experiment.
- **Wordplay edit export.** Turn a Lyric DJ handoff into a standalone shareable clip , the "50 Cent → Usher 'Shorty'" format, generated for any song pair. This is the most viral-shaped artifact in the app.
- **Tighter hook windows.** Use the full heatmap curve (not just the peak) to find the exact hook in/out points, and trim intros/outros automatically.

### B. New experiences
- **Mood journey / set arc.** "Take me from chill to peak over 20 minutes" , an energy curve the AI fills and paces, like a real DJ set or a workout ramp.
- **Live crossfade radio.** A never-ending personalized station that learns from skips/holds, blending in your taste in real time.
- **Collaborative / party mode.** Multiple phones contribute to one queue; the crowd votes the 9-grid; a shared room URL.
- **Camera-reactive DJ.** Use device sensors / camera energy to drive transitions at an actual party (drop on the cheer).
- **Genre/era time-machine.** "Same song's DNA across decades" , chain covers, samples, and interpolations of one melody through music history.
- **Duet & mashup challenges.** User picks one song, AI finds the perfect mashup partner; share and let others one-up it.

### C. Intelligence & personalization
- **Taste model.** Learn from holds, skips, replays, and shares to personalize song selection and even *which transition tricks* a user likes.
- **"Why this works" coach mode.** Show the BPM/key/energy reasoning , an educational angle for aspiring DJs and a trust-builder.
- **Real-time vibe steering.** Continuous voice/text steering ("more energy," "something Hindi now," "slow it down") without rebuilding the queue.
- **Smarter DJ persona.** Memory of the listener, callbacks, requests, name drops , MC Fable as a character that knows you.

### D. Production & scale (the hard prerequisite for shipping)
- **Server-side extraction service.** `yt-dlp` can't run on Vercel serverless and YouTube blocks datacenter IPs. A dedicated extractor box (Fly.io/Railway + residential proxy) or a licensed catalog is required for a public launch. *This is the #1 blocker between "lab" and "product."*
- **Licensing strategy.** Long-term, YouTube extraction is legally grey. Options: licensed catalog APIs, user-uploads, or partnership. Must be resolved before scale.
- **Pre-rendered, cached mixes.** Render popular transitions/mixes server-side once and serve them as audio , instant playback, no per-user compute.
- **Cost controls.** AI calls (especially endless mode) and Replicate jobs add up. Cache aggressively, batch, and gate the expensive paths.
- **Mobile-native shell.** The gesture/reels experiences want a real app (haptics, full-screen, offline cache, share sheets).

### E. Distribution
- **One-tap social export** with auto-generated captions and the trigger-word callout baked into the video.
- **Embeddable player / shareable mix links** so a mix is a URL anyone can open.
- **Creator tools** , let creators design and publish their own reusable transition templates.

---

## 7. The North-Star Test

> A friend hears a mix, can't tell it was made by software, asks "what is this?" , and makes one themselves within the minute.

Every experiment is judged against that. The ones that get closest become the product.
