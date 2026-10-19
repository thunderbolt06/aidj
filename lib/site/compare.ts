export interface Row {
  label: string;
  us: string;
  them: string;
}

export interface Comparison {
  slug: string;
  name: string;
  kind: string;
  title: string;
  description: string;
  summary: string;
  rows: Row[];
  theyWin: string[];
  weWin: string[];
  verdict: string;
}

/**
 * Comparisons are written from each product's publicly documented behaviour
 * and are deliberately general. Products change; the page says so.
 */
export const COMPARE_NOTE =
  "Written from each product's publicly documented features as of October 2026. Products change, so check their own pages for current details.";

export const COMPARISONS: Comparison[] = [
  {
    slug: "spotify",
    name: "Spotify",
    kind: "Streaming service",
    title: "Everplay vs Spotify: crossfade, AI DJ and real transitions",
    description:
      "Spotify has a vast catalogue, crossfade and an AI DJ with voice commentary. Everplay plans beat-matched DJ transitions. How they differ and who each is for.",
    summary:
      "Spotify is a streaming service built around an enormous catalogue and personalised recommendation. Everplay is a listening mode built around the mix: every song is analysed ahead of time so each transition is planned to the beat.",
    rows: [
      { label: "What it is", us: "An endless, DJ-style set built from famous parts", them: "A full-catalogue streaming service with playlists and recommendations" },
      { label: "Transitions", us: "Ten beat-locked styles, chosen per pair of songs", them: "Crossfade with an adjustable length, and some blended transitions in selected playlists" },
      { label: "Tempo and key awareness", us: "Tempo, key and cue points stored for every song and used by the planner", them: "Not exposed to the listener as a control" },
      { label: "Spoken host", us: "MC Fable writes banter and answers your voice", them: "An AI DJ with spoken commentary, where available" },
      { label: "How you start", us: "Say a vibe, or tap a chip", them: "Pick a playlist, a mix or the DJ feature" },
      { label: "Catalogue", us: "A curated, pre-analysed library", them: "Tens of millions of tracks" },
      { label: "Offline and device support", us: "Browser first, with a mobile app in progress", them: "Apps on nearly every device, with offline listening on paid plans" },
    ],
    theyWin: ["Catalogue size, by a wide margin", "Apps on every device, offline listening, social features", "Personalised discovery from years of your listening"],
    weWin: ["Transitions planned to the beat, the key and the phrase", "Hook-first playback and an endless set with no queue-building", "Vibes in Hindi and Punjabi that are native, not translated"],
    verdict:
      "Use Spotify as your library and for discovery. Use Everplay when you want the music to move like a DJ set: parties, drives, workouts, or anywhere you want a mix that never stops without touching your phone.",
  },
  {
    slug: "apple-music",
    name: "Apple Music",
    kind: "Streaming service",
    title: "Everplay vs Apple Music: AutoMix and planned DJ transitions",
    description:
      "Apple Music offers crossfade and AutoMix. Everplay adds a planner that picks from ten DJ transitions per song pair. A fair look at both.",
    summary:
      "Apple Music has a large catalogue and a feature, AutoMix, that blends songs in a continuous mix. Everplay goes a step further into DJ territory, choosing different transition styles per pair and building sets from vibes.",
    rows: [
      { label: "What it is", us: "An endless, DJ-style set built from famous parts", them: "A full-catalogue streaming service" },
      { label: "Automatic mixing", us: "Planner chooses among ten styles per pair; shows its reasoning", them: "AutoMix blends songs in a continuous mix, alongside a crossfade setting" },
      { label: "Famous-part playback", us: "Core mode: the hook of each song, then hop", them: "Not a mode" },
      { label: "Set building", us: "From a vibe in words or by voice", them: "From playlists, stations and search" },
      { label: "Spoken host", us: "Yes, with talk-back", them: "Radio shows with human hosts" },
      { label: "Catalogue", us: "A curated, pre-analysed library", them: "Tens of millions of tracks, lossless and spatial audio on supported devices" },
      { label: "Platforms", us: "Web, with a mobile app in progress", them: "Apple devices, plus Android and web" },
    ],
    theyWin: ["Catalogue and audio quality (lossless, spatial)", "Deep integration with Apple devices", "Your purchased and uploaded library alongside streaming"],
    weWin: ["More kinds of transition, picked per pair", "Vibe-first, hook-first sets", "Karaoke, sing-along games, FX pads and a visualizer in the same app"],
    verdict:
      "Apple Music is the better catalogue and the better everyday player. Everplay is the better party, drive or workout mode, and the better place to experiment with how a mix can sound.",
  },
  {
    slug: "djay-pro",
    name: "djay Pro",
    kind: "DJ software",
    title: "Everplay vs djay Pro: automatic DJ vs full DJ software",
    description:
      "djay Pro is real DJ software with decks, effects and stems. Everplay is an automatic DJ for people who do not want to learn to mix. Which one fits you?",
    summary:
      "djay Pro is software for people who DJ: two decks, effects, controllers and stem tools, with an automatic mode available. Everplay is for people who do not DJ at all and want the result without the skill.",
    rows: [
      { label: "Who it is for", us: "Listeners and creators who do not want to learn mixing", them: "DJs and aspiring DJs who want control" },
      { label: "Control", us: "Gestures, voice and a vibe; override the transition style if you want", them: "Full manual deck control, effects, EQ, hardware controllers" },
      { label: "Automatic mixing", us: "The main mode, with a planner that explains its choices", them: "An automix mode, alongside manual mixing" },
      { label: "Song source", us: "Built-in pre-analysed library, nothing to import", them: "Your own files and supported streaming integrations" },
      { label: "Learning curve", us: "None: say a vibe", them: "Real, and part of the appeal" },
      { label: "Stems", us: "Vocal handoff works without stem files; stems optional elsewhere", them: "Real-time stem separation is a headline feature" },
      { label: "Hardware", us: "Phone or browser", them: "Supports DJ controllers" },
    ],
    theyWin: ["Total manual control and the feel of real decks", "Controller support for live performance", "Use your own files and a wide set of tools"],
    weWin: ["Nothing to learn, nothing to import", "Sets that build and refill themselves", "Sing-along, reels and sharing built in"],
    verdict:
      "If you want to DJ, get djay Pro. If you want a DJ, open Everplay. The two even work together: use Everplay to find out what transitions you like, then try them by hand.",
  },
  {
    slug: "virtualdj",
    name: "VirtualDJ",
    kind: "DJ software",
    title: "Everplay vs VirtualDJ: automix compared with an AI-planned set",
    description:
      "VirtualDJ is long-running DJ software with automix and stems. Everplay is a browser-first automatic DJ with vibes and talking host. See the differences.",
    summary:
      "VirtualDJ is mature desktop DJ software with automix, effects and stems. Everplay trades that depth for a zero-learning-curve experience that lives in the browser and on your phone.",
    rows: [
      { label: "Who it is for", us: "Anyone who wants a mix without mixing", them: "DJs from hobbyists to working professionals" },
      { label: "Automatic mixing", us: "Planner picks from ten styles per pair", them: "Automix with configurable transitions, alongside manual mixing" },
      { label: "Platform", us: "Browser and mobile", them: "Desktop software for Windows and macOS" },
      { label: "Song source", us: "Built-in library", them: "Your files and supported streaming services" },
      { label: "Effects and control", us: "FX pads and gestures", them: "Deep effects, sampler, scripting, controller mappings" },
      { label: "Set building", us: "From vibes and voice", them: "From your own crates and playlists" },
      { label: "Setup", us: "Open the page", them: "Install software, scan files, optionally connect hardware" },
    ],
    theyWin: ["Depth, flexibility and professional features", "Works on your own library offline", "Hardware and scripting support"],
    weWin: ["No install, no library to prepare", "Vibe and voice-driven set building", "Hindi and Punjabi vibes and karaoke modes"],
    verdict:
      "VirtualDJ is a tool for people who DJ. Everplay is a DJ for people who do not. Choose by whether you want to make the mix or hear it.",
  },
];

export function getComparison(slug: string) {
  return COMPARISONS.find((c) => c.slug === slug);
}
