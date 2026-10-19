export interface Feature {
  slug: string;
  title: string;
  /** Short name for cards. */
  short: string;
  tagline: string;
  /** Meta description. */
  description: string;
  /** Which app route this feature lives at. */
  route: string;
  accent: "a" | "b";
  /** Body paragraphs (plain text). */
  body: string[];
  points: string[];
  /** "How it works" steps. */
  steps: { title: string; text: string }[];
}

export const FEATURES: Feature[] = [
  {
    slug: "famous-parts",
    title: "Only the famous parts",
    short: "Famous parts",
    tagline: "The hook is the product. The rest is filler.",
    description:
      "Everplay finds the section of each song that is both loud and repeated - the hook - and plays that, so every moment is one you recognise.",
    route: "/autodj",
    accent: "a",
    body: [
      "Most songs spend a minute getting to the part you actually know. Everplay skips that. When a song is added to the library it is analysed once, ahead of time, and the hook is marked - the first section that is both loud and recurs through the song.",
      "Auto-DJ then plays that section, hops on a 30 or 60 second rhythm, and lands the next hook on the beat. The seekbar heatmap in the player shows the same curve, so you can see why a moment was picked.",
    ],
    points: [
      "Hook detected from the audio itself: loudness plus self-similarity of the harmony",
      "Intro and outro cue points, so songs start and leave where the music does",
      "A heatmap on the seekbar that shows how hook-like each second is",
      "30 s and 60 s hop modes, or let the set breathe",
    ],
    steps: [
      { title: "Analyse once", text: "Every library track gets a tempo, a beat grid, a key, an energy curve and a hook estimate before you ever press play." },
      { title: "Pick the moment", text: "The hook is the first occurrence of the section that is loud and repeats. That is where the song enters." },
      { title: "Leave cleanly", text: "The exit is chosen at the end of a phrase, so a song never gets cut mid-line." },
    ],
  },
  {
    slug: "ai-transitions",
    title: "DJ transitions, planned by AI",
    short: "AI transitions",
    tagline: "Ten beat-locked moves. The AI picks the right one for each pair.",
    description:
      "Crossfade, bass swap, filter sweep, echo out, loop roll, brake, riser, double drop, vocal handoff. Everplay picks a transition per pair of songs and lands it on the beat.",
    route: "/mix",
    accent: "b",
    body: [
      "A crossfade is the same move for every pair of songs. A DJ chooses. Everplay's engine implements ten transition styles, all scheduled on the audio clock against the beat grid, and a planner chooses one per pair from the tempo gap, the keys, the energy of each side and how the songs end.",
      "You can leave it on auto, or force a style yourself. Either way the transition is planned while the current song plays, so nothing is computed at the moment of the mix.",
    ],
    points: [
      "Crossfade, bass swap, filter sweep, echo out and cut",
      "Loop roll, brake, riser and double drop for bigger moments",
      "Vocal handoff when the pair is in key and tempo",
      "Planned ahead, so the mix itself never waits on anything",
    ],
    steps: [
      { title: "Read both songs", text: "Tempo, key, energy at the exit and entry points, and how each song ends." },
      { title: "Choose a move", text: "A planner picks a style, falling back to simpler ones when a fancy move would clash. The reason is shown." },
      { title: "Land on the beat", text: "Both decks are scheduled on the audio clock, so the drop is sample-accurate rather than timer-accurate." },
    ],
  },
  {
    slug: "vibe-prompt",
    title: "Say a vibe, get a set",
    short: "Vibe prompt",
    tagline: "No library, no search, no queue building.",
    description:
      "Type or say what you are doing - road trip, gym, rainy day - and Everplay builds a set from vibe playlists and keeps it going.",
    route: "/vibe",
    accent: "a",
    body: [
      "Pick a chip like road trip or late night chill, or type your own phrase. Everplay maps it onto a known vibe and draws songs from playlists that people have already built for that mood, weighted by how many of them agree on a song.",
      "Every set opens differently: picks are random within the vibe, nudged toward newer releases, and songs you heard recently are pushed far down. Change the vibe mid-set, by text or by voice, and the next songs follow.",
    ],
    points: [
      "Chips for activities, moods and genres, plus free text",
      "Voice steering: say 'something Hindi now' or 'slow it down'",
      "Songs you just heard are pushed down so sets do not repeat",
      "Refills itself, so the set does not stall",
    ],
    steps: [
      { title: "Say it", text: "Tap a chip, type a phrase, or speak." },
      { title: "Map it", text: "Free text is matched onto the closest known vibe." },
      { title: "Build it", text: "Songs come from that vibe's playlists, then tempo, key and energy order them." },
    ],
  },
  {
    slug: "vocal-handoff",
    title: "Vocal handoff",
    short: "Vocal handoff",
    tagline: "The beat changes first. The singer follows later.",
    description:
      "The incoming song's beat plays under the outgoing song's last line, then its singer takes over. A real stem-era DJ move, without needing stems.",
    route: "/mix",
    accent: "b",
    body: [
      "DJs with stem separation keep the outgoing vocal over the incoming beat, then swap the vocal on a phrase. Everplay does a version of it with no stems: the incoming song starts a few clean bars before its first sung entry, so its intro is already instrumental, and the outgoing vocal is held with a focused filter.",
      "It is a special move, not a default. Random pairs rarely qualify because the tempos and keys have to line up, so Everplay only reaches for it when the pair really fits.",
    ],
    points: [
      "Beat swaps first, vocals swap on a phrase boundary",
      "Gated on tempo (within 6 percent) and compatible keys",
      "Uses vocal-activity maps so a line is never cut off",
      "Falls back to a simpler transition and says so",
    ],
    steps: [
      { title: "Find the exit", text: "The outgoing song is left at the end of a sung line." },
      { title: "Find the entry", text: "The incoming song enters 2-4 bars before one of its vocal entries." },
      { title: "Swap on the phrase", text: "Bass swaps first, the old band fades, the old voice is held, then the new singer arrives." },
    ],
  },
  {
    slug: "harmonic-mixing",
    title: "Harmonic mixing",
    short: "Key and tempo",
    tagline: "Smooth, not clashing.",
    description:
      "Everplay detects the key and tempo of every song and uses the Camelot wheel and BPM matching so songs blend instead of fight.",
    route: "/mix",
    accent: "a",
    body: [
      "Two songs in clashing keys sound wrong even when the beats line up. Everplay detects each song's key at analysis time and keeps transitions between Camelot-compatible neighbours when the move needs it.",
      "Tempo gaps are bridged with a playback-rate glide, and the key can be locked while the tempo moves. Our free Camelot wheel and BPM tools use the same ideas.",
    ],
    points: [
      "Key detected for every library song, with a confidence score",
      "Camelot compatibility used to gate the moves that expose both songs",
      "Beat-matching by playback-rate glide, with key lock",
      "Free Camelot wheel and BPM detector in the tools section",
    ],
    steps: [
      { title: "Detect", text: "Tempo from onsets, key from the harmony." },
      { title: "Compare", text: "Same key, one step around the wheel, or relative major or minor all count as compatible." },
      { title: "Match", text: "If the tempos differ, the incoming song glides to the outgoing tempo before the drop." },
    ],
  },
  {
    slug: "karaoke",
    title: "Karaoke and Sing-It Showdown",
    short: "Karaoke",
    tagline: "Vocals out, lyrics on screen, you are the singer.",
    description: "Synced lyrics, tap-a-line-to-jump, and a two-team singing game that listens through your mic.",
    route: "/karaoke",
    accent: "b",
    body: [
      "Karaoke mode shows synced lyrics while the song plays. Tap a line to jump to it. Sing-It Showdown turns it into a game: two teams, the instrumental plays, and the microphone checks whether you sang the words.",
    ],
    points: ["Synced lyrics", "Tap any line to jump", "Two-team scoring from the microphone", "Works with the same library as the DJ modes"],
    steps: [
      { title: "Pick a song", text: "From the library or a vibe." },
      { title: "Sing", text: "Lyrics scroll in time." },
      { title: "Score", text: "In Showdown the mic hears you and awards points." },
    ],
  },
  {
    slug: "talking-dj",
    title: "MC Fable, the talking DJ",
    short: "Talking DJ",
    tagline: "An AI host that talks between songs and listens back.",
    description: "An AI DJ writes short banter, speaks it over ducked music, and responds to your voice.",
    route: "/talkingdj",
    accent: "a",
    body: [
      "MC Fable writes a line or two between songs, a text-to-speech voice says it over the music (ducked, so the song stays audible), and you can answer with the microphone to change the vibe.",
      "It is the personality bet: a radio host that knows what just played and what is coming.",
    ],
    points: ["Banter written for the actual songs", "Music ducks under the voice", "Talk back to steer the vibe", "Heuristic fallbacks, so it works when AI is unavailable"],
    steps: [
      { title: "Write", text: "The model sees the last and next song and writes a short link." },
      { title: "Speak", text: "A voice reads it over a ducked mix." },
      { title: "Listen", text: "Your reply can change the vibe." },
    ],
  },
  {
    slug: "reels-feed",
    title: "Reels feed",
    short: "Reels feed",
    tagline: "Swipe up. The swipe is the transition.",
    description: "A vertical feed of famous parts where swiping to the next card is the DJ transition.",
    route: "/reels",
    accent: "b",
    body: [
      "Reels is the short-form take: a vertical feed of hooks. Swiping to the next card quantises the transition to the next phrase boundary, so even a clumsy swipe lands on the beat. The feed refills itself, so there is no end.",
    ],
    points: ["Phrase-quantised swipes", "Endless, self-refilling feed", "Made for one-handed use", "Pairs with Export to make a shareable clip"],
    steps: [
      { title: "Swipe", text: "Up for the next hook." },
      { title: "Quantise", text: "The cut waits for the next 4-bar phrase." },
      { title: "Refill", text: "More hooks are queued ahead of you." },
    ],
  },
  {
    slug: "fx-pads",
    title: "FX pads and live controls",
    short: "FX pads",
    tagline: "Risers, impacts, horns and loops under your fingers.",
    description: "A pad grid of risers, impacts and beat loops locked to the current song's tempo and bar.",
    route: "/pads",
    accent: "a",
    body: [
      "For when you want to play, not just listen. The FX pad adds risers, impacts, horns and beat loops over the running mix, and the loops lock to the current tempo and bar so they never drift.",
      "Gestures mode is the lightest version: hold to build tension, release to drop into the next song.",
    ],
    points: ["Tempo- and bar-locked loops", "Risers, impacts, horns, scratches", "Press-and-hold to build, release to drop", "Everything quantised to the beat grid"],
    steps: [
      { title: "Tap a pad", text: "Hits are queued to the next beat." },
      { title: "Loop", text: "Loops snap to the bar." },
      { title: "Release", text: "Drop into the next song on the one." },
    ],
  },
  {
    slug: "music-video-visualizer",
    title: "Music video visualizer",
    short: "Visualizer",
    tagline: "Visuals that react to beat and chords in real time.",
    description: "Pick a visual framework or describe one and let AI code a visualizer that reacts to the music.",
    route: "/musicvideo",
    accent: "b",
    body: [
      "The visualizer reads the beat and chords of what is playing and drives real-time graphics. Pick a built-in framework, or describe what you want and the AI writes a shader or sketch for it.",
    ],
    points: ["Beat- and chord-reactive", "Built-in frameworks", "Describe one in words and the AI writes it", "Full screen for parties"],
    steps: [
      { title: "Choose", text: "A built-in look, or a prompt." },
      { title: "React", text: "Beat and chord data drive the scene." },
      { title: "Show", text: "Go full screen." },
    ],
  },
  {
    slug: "export-reel",
    title: "Export a reel",
    short: "Export",
    tagline: "Turn a set into a vertical video you can post.",
    description: "Render a mega-mix of famous parts under a minute long as a vertical video for Reels or Shorts.",
    route: "/export",
    accent: "a",
    body: [
      "Export renders a set of famous parts, up to a minute long, as a vertical video with the visuals you chose. It is the shareable artifact of the app: the mix that makes a friend ask what made it.",
    ],
    points: ["Up to 60 seconds", "Vertical format", "Famous parts only", "Uses the same transitions as live playback"],
    steps: [
      { title: "Build a set", text: "Any vibe works." },
      { title: "Render", text: "Mixed offline with the same engine." },
      { title: "Share", text: "Download and post." },
    ],
  },
  {
    slug: "languages",
    title: "English, Hindi and Punjabi",
    short: "Languages",
    tagline: "Vibes that belong to each language, not translated chips.",
    description: "Hindi and Punjabi have their own vibes - shaadi dance floor, bhangra, sufi night - drawn from their own playlists.",
    route: "/",
    accent: "b",
    body: [
      "A Hindi listener does not want an English chip list translated. Each language has its own vibes: bollywood party, sangeet night and sufi night in Hindi; bhangra dance floor and punjabi folk classics in Punjabi. Sets stay inside the language you chose, and the DJ engine works the same.",
    ],
    points: ["Language picker on the home screen", "Language-native vibe chips", "Sets stay in the language", "Same transitions across languages"],
    steps: [
      { title: "Pick a language", text: "English, Hindi or Punjabi." },
      { title: "Pick a vibe", text: "From that language's own chips." },
      { title: "Play", text: "The set stays in-language." },
    ],
  },
];

export function getFeature(slug: string) {
  return FEATURES.find((f) => f.slug === slug);
}

/** The ten beat-locked transition styles in the engine, with the idea of each. */
export const TRANSITIONS = [
  {
    id: "crossfade",
    name: "Crossfade",
    text: "Equal-power blend. The safe default when two songs are close in tempo and key.",
    a: [[0, 1], [0.35, 1], [0.65, 0], [1, 0]],
    b: [[0, 0], [0.35, 0], [0.65, 1], [1, 1]],
    c: [[0, 0.5], [1, 0.5]],
  },
  {
    id: "bass_swap",
    name: "Bass swap",
    text: "Songs overlap, but only one owns the low end. The kick and bassline hand over on a downbeat.",
    a: [[0, 1], [0.5, 1], [0.7, 0.55], [1, 0]],
    b: [[0, 0], [0.3, 0.55], [0.5, 0.75], [1, 1]],
    c: [[0, 1], [0.5, 1], [0.5, 0], [1, 0]],
  },
  {
    id: "filter_sweep",
    name: "Filter sweep",
    text: "The outgoing song is swept into a low-pass filter while the incoming one opens up.",
    a: [[0, 1], [0.4, 0.9], [0.8, 0.3], [1, 0]],
    b: [[0, 0], [0.4, 0.2], [0.8, 0.9], [1, 1]],
    c: [[0, 0.1], [0.45, 0.2], [0.9, 0.95], [1, 1]],
  },
  {
    id: "echo_out",
    name: "Echo out",
    text: "The last word of the old song is thrown into an echo tail while the new one starts clean.",
    a: [[0, 1], [0.45, 1], [0.5, 0.35], [0.75, 0.15], [1, 0]],
    b: [[0, 0], [0.5, 0], [0.55, 0.9], [1, 1]],
    c: [[0, 0], [0.45, 0], [0.55, 0.9], [1, 0.1]],
  },
  {
    id: "loop_roll",
    name: "Loop roll",
    text: "A stutter that halves each time - 1, 1/2, 1/4 beat - then slams into the next song.",
    a: [[0, 1], [0.5, 1], [0.6, 0.2], [0.7, 1], [0.78, 0.2], [0.84, 1], [0.9, 0.2], [0.95, 0.6], [1, 0]],
    b: [[0, 0], [0.9, 0], [0.92, 1], [1, 1]],
    c: [[0, 0], [0.5, 0], [0.9, 0.9], [1, 0]],
  },
  {
    id: "brake",
    name: "Brake",
    text: "A vinyl stop: the old song slows to a halt, then the new one drops in at full speed.",
    a: [[0, 1], [0.4, 1], [0.7, 0.5], [0.85, 0.15], [1, 0]],
    b: [[0, 0], [0.85, 0], [0.88, 1], [1, 1]],
    c: [[0, 1], [0.4, 1], [0.85, 0.1], [1, 0]],
  },
  {
    id: "riser",
    name: "Riser",
    text: "A noise sweep builds tension while the bass pulls out, then everything lands on the downbeat.",
    a: [[0, 1], [0.5, 0.9], [0.85, 0.6], [0.9, 0], [1, 0]],
    b: [[0, 0], [0.9, 0], [0.92, 1], [1, 1]],
    c: [[0, 0], [0.5, 0.25], [0.9, 1], [0.92, 0], [1, 0]],
  },
  {
    id: "double_drop",
    name: "Double drop",
    text: "Two hooks play together for eight bars. It only works when the tempo and key match.",
    a: [[0, 1], [0.3, 1], [0.8, 1], [1, 0]],
    b: [[0, 0], [0.3, 1], [0.8, 1], [1, 1]],
    c: [[0, 0], [0.3, 0.9], [0.8, 0.9], [1, 0.5]],
  },
  {
    id: "vocal_handoff",
    name: "Vocal handoff",
    text: "Beat first, singer later: the new song's instrumental runs under the old vocal, then its voice takes over.",
    a: [[0, 1], [0.3, 0.55], [0.6, 0.45], [0.7, 0], [1, 0]],
    b: [[0, 0], [0.3, 0.65], [0.6, 0.7], [0.7, 1], [1, 1]],
    c: [[0, 0.55], [0.6, 0.55], [0.7, 0], [1, 0]],
  },
  {
    id: "cut",
    name: "Cut",
    text: "A hard switch on the one. Sometimes the best transition is no transition.",
    a: [[0, 1], [0.5, 1], [0.5, 0], [1, 0]],
    b: [[0, 0], [0.5, 0], [0.5, 1], [1, 1]],
    c: [[0, 0], [1, 0]],
  },
] as const;
