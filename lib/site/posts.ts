export interface Post {
  slug: string;
  title: string;
  description: string;
  /** ISO date. */
  date: string;
  readMins: number;
  tag: string;
  /** Tiny markdown: ## / ### headings, - and 1. lists, > quotes, **bold**, `code`, [text](/path). */
  body: string;
}

export const POSTS: Post[] = [
  {
    slug: "how-an-ai-dj-works",
    title: "How an AI DJ actually works (and what it can't do)",
    description:
      "An AI DJ is not one model. It is analysis, a planner and an audio engine. Here is each piece, and where the AI really matters.",
    date: "2026-10-12",
    readMins: 6,
    tag: "Explainer",
    body: `
When people hear "AI DJ" they picture a model that listens to two songs and mixes them. That is not how it works, and the real design is more interesting.

An AI DJ is three layers: **analysis**, a **planner** and an **engine**. Only one of them needs a language model.

## Layer 1: analysis

Before a song can be mixed, the system needs facts about it. These come from signal processing, not AI:

- **Tempo and beat grid.** Where every beat and every bar's first beat falls.
- **Key.** Usually expressed on the Camelot wheel, so two songs can be checked for harmonic compatibility.
- **Energy over time.** How loud and dense the song is at each second.
- **Cue points.** Where the intro ends and where the outro begins.
- **The hook.** The section that is both loud and repeated.

Everplay does this once per song, ahead of time, and stores the result with the track. Nothing is analysed while you listen.

## Layer 2: the planner

The planner decides what to do with a pair of songs: which exit, which entry, which transition, how long. A good planner is mostly rules: do not blend songs in clashing keys, do not beat-match across a 30 percent tempo gap, prefer a cut over a bad blend.

This is where a language model helps. It can read the facts about both songs and choose among the moves with a reason attached, and it can map a loose request such as "singable road trip" onto a known vibe. Heuristic fallbacks matter just as much: when the model is slow or unavailable, a rule-based planner takes over so the music never stops.

## Layer 3: the engine

The engine plays the audio. It runs two decks and schedules every change on the audio clock rather than with timers, because timers drift and a drop that is 40 milliseconds late sounds wrong. A transition is a handful of scheduled gain, filter and echo changes at exact beats.

## What an AI DJ cannot do

- It cannot fix a bad pair. If two songs have nothing in common, the best move is a clean cut.
- It cannot hear the room. A human DJ watches the crowd. Software only knows what you tell it.
- It is limited by its catalogue. Analysis has to exist before a song can be mixed.

## The one rule that matters

The magic of a mix dies with latency. If the system visibly thinks at the moment of the transition, the illusion breaks. So the design rule is: prepare everything ahead, and let the user's action only execute a decision already made.

Want to hear the result? [Open Everplay](/login), or read about [how it works](/how-it-works).
`,
  },
  {
    slug: "camelot-wheel-harmonic-mixing-guide",
    title: "The Camelot wheel: a five-minute guide to harmonic mixing",
    description:
      "Why songs in the wrong key clash even when the beats line up, and how the Camelot wheel makes key-matching a matter of counting to one.",
    date: "2026-10-10",
    readMins: 5,
    tag: "Guide",
    body: `
Two songs can have identical tempos and still sound terrible together. The reason is key. Harmonic mixing is the practice of blending songs whose keys are compatible, and the Camelot wheel is the tool that makes it easy.

## What the wheel is

The Camelot system, created by Mark Davis of Mixed In Key, labels the 24 musical keys with a number from 1 to 12 and a letter. **A** is a minor key, **B** is a major key. A song in A minor is **8A**; its relative major, C major, is **8B**.

The numbers are arranged like a clock because they follow the circle of fifths: each step clockwise is up a fifth.

## The rule

From the key you are on, these moves sound good:

1. **Same key.** 8A to 8A. Always safe.
2. **One step clockwise or anticlockwise.** 8A to 9A or 7A. A fifth apart, closely related.
3. **Switch the letter.** 8A to 8B. The relative major or minor, with the same notes.

That is the whole system. Count to one, or swap the letter.

## Energy boosts

Two moves are used for effect rather than smoothness:

- **+2 steps** (8A to 10A) lifts the energy noticeably.
- **+7 steps** (8A to 3A) is a semitone up, a classic lift for a final chorus.

## Doing it in practice

1. Find each song's Camelot key. Our free [BPM and key detector](/tools/bpm-key-detector) reads it from a file in your browser.
2. Pick your next song from the neighbours on the wheel.
3. Match tempo. A gap of a few percent is fine; bigger gaps need a tempo change, which shifts pitch unless key lock is on.
4. Mix over a phrase, usually 8 or 16 bars, so the overlap is long enough to be heard as a blend.

Try the [interactive Camelot wheel](/tools/camelot-wheel) to see the compatible keys light up.

## When to break the rule

Harmonic mixing is a guide, not a law. A short echo-out or a hard cut hides key clashes because the songs barely overlap. Percussive intros and outros mix with anything. And a lot of popular music is ambiguous about its key anyway, which is why Everplay stores a confidence score and only gates the moves that expose both songs when it is sure.
`,
  },
  {
    slug: "ten-dj-transitions-explained",
    title: "Ten DJ transitions explained, with when to use each",
    description:
      "Crossfade, bass swap, filter sweep, echo out, loop roll, brake, riser, double drop, cut and vocal handoff: what each does and when it works.",
    date: "2026-10-08",
    readMins: 7,
    tag: "Guide",
    body: `
A crossfade is the transition everyone has heard. It is also the least interesting one. Here are ten, in rough order of how much they ask of the songs.

## 1. Crossfade
One fader goes down while the other goes up. It works when the tempos and keys are close. Use it when you have no reason to do anything else.

## 2. Bass swap
Two songs play together, but only one at a time has its low end. At a downbeat the bass swaps from the old song to the new. It avoids the muddy sound of two basslines fighting, and is the backbone of club mixing.

## 3. Filter sweep
Sweep a low-pass filter down on the old song while the new one opens up. Good for moving between different textures, because the filter hides the old song's detail as it leaves.

## 4. Echo out
Throw the last word or beat of the old song into a delay and cut the dry signal. The tail rings over the first bar of the new song. It is the safest way to leave a song whose key does not suit the next.

## 5. Loop roll
Loop the last beat, then halve the loop - one beat, half a beat, a quarter - and slam into the next song. The stutter builds tension and the slam releases it.

## 6. Brake
Slow the old song down as if you stopped the record, then drop the new song at full speed. A joke and a showstopper at once. Use sparingly.

## 7. Riser
A noise sweep rises over several bars while the bass pulls out, and everything lands on the downbeat. It is how drops are built in dance music.

## 8. Double drop
Both songs' big moments play together for eight bars. It needs matched tempo and compatible keys, and it is the most rewarding when it works.

## 9. Cut
A hard switch on the one. When both songs have strong downbeats and similar energy, a cut feels deliberate and punchy.

## 10. Vocal handoff
The new song's beat arrives while the old song's singer finishes the line, then the new singer enters. See [our deeper write-up](/blog/vocal-handoff-transition-explained).

## How to choose

Ask three questions: are the keys compatible, are the tempos within about six percent, and does the old song end on a line or an instrumental? Yes to all three opens up the blends. No to any of them points to an echo out, a filter sweep or a cut.

Everplay's planner asks exactly these questions for every pair, and tells you which move it chose and why. See it in [AI transitions](/features/ai-transitions).
`,
  },
  {
    slug: "why-spotify-crossfade-sounds-off",
    title: "Why a streaming-app crossfade never sounds like a DJ mix",
    description:
      "Crossfade is a volume ramp. A DJ mix is a decision about tempo, key, bass and phrase. Here is the gap.",
    date: "2026-10-06",
    readMins: 5,
    tag: "Opinion",
    body: `
Almost every streaming app has a crossfade setting. Turn it on and the end of one song overlaps with the start of the next. It is better than silence. It still does not sound like a DJ set, and the reasons are specific.

## A crossfade is a volume ramp

The setting changes the volume of two files over a few seconds. It knows nothing about the music inside them. That leaves four problems.

### 1. Tempo
If the old song is at 96 BPM and the new one at 124, the overlap has two pulses fighting. A DJ matches the tempos first, or avoids the overlap.

### 2. Key
Overlapping two harmonies in clashing keys produces a sour second or two. A DJ checks the keys, or uses a move that hides the overlap.

### 3. Bass
Two kicks and two basslines together are mud. DJs give the low end to one song at a time.

### 4. Position
A song's last ten seconds are not always its outro. A fixed overlap can cut across a final chorus or a sung line. A DJ leaves at the end of a phrase.

## What fixes it

Everything above is analysable ahead of time: tempo, beat grid, key, cue points and where the lines end. Once you have those, a transition becomes a plan - which exit, which entry, which move - rather than a fixed ramp.

That is the whole idea of Everplay. It analyses every song once, plans the transition for each pair while the previous one plays, and schedules it on the beat.

## The honest trade-off

A crossfade works on any song in any catalogue. A planned transition needs analysis, so it works on the songs that have been analysed. Everplay chooses depth over breadth: a smaller library where every song is ready to be mixed.

Curious how it compares? See [Everplay vs Spotify](/compare/spotify).
`,
  },
  {
    slug: "vocal-handoff-transition-explained",
    title: "The vocal handoff: how to change the beat first and the singer later",
    description:
      "A transition borrowed from stem-era DJing, how it works step by step, and why it only fits some pairs of songs.",
    date: "2026-10-18",
    readMins: 5,
    tag: "Deep dive",
    body: `
Most transitions swap everything at once. The vocal handoff does it in two stages, which is why it feels so smooth when it works.

## The idea

1. The **beat** of the incoming song arrives under the outgoing song's last line.
2. The outgoing singer finishes the line.
3. The incoming **singer** enters on a phrase boundary.

The listener hears the groove change before they hear the voice change, and the brain accepts both as one gesture.

## How DJs do it

With stem separation, a DJ can mute the drums and bass of the old song while keeping its vocal, then bring in the new song's instrumental underneath. On the phrase, the vocals swap. DJ guides for modern software describe it as holding the outgoing vocal over the incoming beat.

The main warning in those guides is key. A held vocal over a different key produces a clash, so the keys need to be compatible.

## How Everplay does it without stems

Stems for every song are expensive to store and to make. Instead:

- The incoming song starts **two to four bars before** one of its sung entries. The intro of most songs is already instrumental, so it works as the "beat".
- The outgoing vocal is held with a focused filter: a centre-channel emphasis, a high-pass and a boost around 3 kHz, with the top end rolled off.
- The bass swaps at the start, the old band fades over two beats, and an echo throw leads into the handoff bar.

## Why it is a special move

It needs several things to line up:

- The outgoing song must have a clean sung line to leave on.
- The incoming song must have a sung entry with a clean instrumental ahead of it.
- The tempos must be within about six percent and the keys compatible.

In testing, the large majority of songs have a usable entry, but a random pair passes the tempo and key gate only a few percent of the time. So Everplay only uses the handoff when the pair really fits, and falls back to a bass swap or an echo out, saying so, when not.

## Try it

[Open Everplay](/login) and let Auto-DJ run. When a pair qualifies, the reasoning panel will tell you a handoff was chosen.
`,
  },
  {
    slug: "bpm-ranges-for-every-activity",
    title: "The right BPM for every activity: workout, study, party and more",
    description:
      "A practical BPM cheat sheet for running, lifting, studying, cooking and dancing, and why tempo changes how a playlist feels.",
    date: "2026-10-04",
    readMins: 4,
    tag: "Cheat sheet",
    body: `
Tempo is the quickest way to change how a playlist feels. These ranges are rules of thumb, not laws, but they give you a starting point.

## Ranges by activity

- **Deep focus and study:** 60-90 BPM, mostly instrumental
- **Cooking, cleaning, easy mornings:** 90-110 BPM
- **Walking and commuting:** 100-120 BPM
- **Dinner party and background:** 85-115 BPM
- **House party, warm-up:** 110-124 BPM
- **Dance floor:** 120-130 BPM
- **Running:** 150-180 BPM, matched to your cadence
- **Lifting:** 120-150 BPM for working sets, slower between sets
- **Yoga and stretching:** 50-80 BPM

## Half-time and double-time

A 140 BPM track can feel like 70, and a 70 can feel like 140. If a song seems to sit between two ranges, check whether it is half- or double-time. Our [tap tempo tool](/tools/tap-tempo) shows both.

## Keep the energy moving

A set is not a flat line. A good party playlist rises and falls: start around 100-110, climb to 120-128 over the first hour, and give people a breather every 20-30 minutes. See our [BPM cheat sheet tool](/tools/bpm-cheat-sheet) for genre ranges.

## Let software do it

Everplay reads the tempo of every song and orders a set by it, so a "gym workout time" vibe stays in the right band while a "late night chill" stays low. If the tempos of two neighbours differ, the transition planner bridges the gap with a tempo glide or a transition that does not overlap.
`,
  },
  {
    slug: "build-a-party-playlist-that-never-dies",
    title: "How to build a party playlist that never loses the room",
    description:
      "Energy arcs, hook-first selection and graceful dips: six rules for a party set, whether you mix it yourself or let software do it.",
    date: "2026-10-02",
    readMins: 5,
    tag: "Guide",
    body: `
A party playlist fails in a specific way: someone skips a song, the energy dips, and the room goes quiet. Six rules help.

## 1. Think in arcs, not lists

Plan a shape. Open warm, climb for 30-40 minutes, peak, take a short dip, then climb again. A flat 125 BPM line tires people out.

## 2. Hooks first

People recognise the famous part of a song. Start songs there when you can; most of a track's intro is for the album, not the room.

## 3. Respect keys and tempos

Neighbouring songs within about six percent of tempo and a step apart on the [Camelot wheel](/tools/camelot-wheel) blend invisibly. Bigger jumps want a break, an echo out or a cut.

## 4. Leave on the end of a phrase

Cutting a song in the middle of a sung line is the thing guests notice. Leave at the end of a line or at a bar boundary.

## 5. Put the biggest songs in the second half

Save the songs everyone knows for when the room is warm. Open with songs people like; close with songs they sing.

## 6. Never run out

Queue more than you need. The worst moment at a party is silence. Auto-refilling queues exist for exactly this reason.

## Or say a vibe

Everplay's "background for a house party" and "pre-game hype" vibes build the arc for you: playlists people already made for that mood, ordered by tempo, key and energy, with transitions planned between each pair. Try it by [opening the app](/login).
`,
  },
  {
    slug: "why-only-the-famous-part-matters",
    title: "Why we only play the famous part of a song",
    description:
      "The idea behind Everplay: the hook is the product, the rest is filler, and a set made only of hooks is more engaging than any single track.",
    date: "2026-10-14",
    readMins: 4,
    tag: "Product",
    body: `
Streaming changed what we own, but not how we listen: press play and hear a song from beginning to end. Three observations led us somewhere else.

## 1. Only a small part of a song is famous

Ask anyone to hum a song and you will get the same eight seconds. That is the part that carries the song. The rest is verse, bridge and build.

## 2. People get bored after the hook

Our bet is that attention drifts once the known part has passed. A listening experience built around the known parts - stitched together - avoids that. It is a bet, and the app is built to test it.

## 3. The magic dies with latency

Any visible "thinking" at the moment of a transition breaks the illusion. So everything is prepared ahead.

## What we built

Everplay analyses each song once for tempo, key and a hook estimate: the first section that is both loud and recurring. It plays that part, then hops to the next song with a transition planned for the pair. A set never ends, because the queue refills itself.

## What it is not

It is not a replacement for listening to a full album. If you want the whole song, nothing stops you playing it in full. Famous-part mode is a different mode, the way a radio edit is different from an album track.

If that sounds like your kind of listening, [open the app](/login) and try a vibe.
`,
  },
];

export function getPost(slug: string) {
  return POSTS.find((p) => p.slug === slug);
}

export function sortedPosts() {
  return [...POSTS].sort((a, b) => b.date.localeCompare(a.date));
}
