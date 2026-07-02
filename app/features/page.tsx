import Link from "next/link";

const experiments = [
  {
    href: "/",
    title: "Compilation · Home",
    desc: "The main deck: vibe prompt, clap-to-extend, hold-to-drop, 9-grid, reorderable queue.",
    status: "home",
  },
  {
    href: "/mix",
    title: "2-Song Mix",
    desc: "Pick two songs, AI plans and renders the DJ transition live.",
    status: "ready",
  },
  {
    href: "/autodj",
    title: "Auto-DJ (30s / 1min)",
    desc: "Plays only the famous part of each song, auto-transitions.",
    status: "ready",
  },
  {
    href: "/vibe",
    title: "Vibe Prompt",
    desc: "Type or speak an intent , 'singable road trip' , AI builds the mix.",
    status: "ready",
  },
  {
    href: "/arc",
    title: "Energy-Arc Director",
    desc: "Set a journey , chill → peak → cool-down , over 20 min. AI paces the whole set.",
    status: "ready",
  },
  {
    href: "/grid",
    title: "9-Grid Next Song",
    desc: "Tap one of 9 suggested songs to transition into it.",
    status: "ready",
  },
  {
    href: "/gestures",
    title: "Gestures",
    desc: "Press-and-hold to loop, release to transition. Swipe up to auto-mix.",
    status: "ready",
  },
  {
    href: "/karaoke",
    title: "Karaoke",
    desc: "Vocals stripped off, synced lyrics on screen , you are the singer.",
    status: "ready",
  },
  {
    href: "/game",
    title: "Sing-It Showdown",
    desc: "2 teams, instrumental plays, sing the words to score. Mic auto-detects.",
    status: "ready",
  },
  {
    href: "/lyricdj",
    title: "Lyric DJ",
    desc: "A whole setlist chained by connecting lyric lines , computed before playback.",
    status: "ready",
  },
  {
    href: "/talkingdj",
    title: "Talking DJ",
    desc: "An AI DJ that talks between songs and listens to your replies.",
    status: "ready",
  },
  {
    href: "/mashup",
    title: "Mashup Generator",
    desc: "Two songs layered and beat-aligned into one.",
    status: "ready",
  },
  {
    href: "/reels",
    title: "Reels Feed",
    desc: "Vertical swipe feed of famous parts , the swipe IS the transition.",
    status: "ready",
  },
  {
    href: "/musicvideo",
    title: "Music Video Lab",
    desc: "Real-time, beat & chord-reactive visuals , pick a framework or let AI code one from a prompt.",
    status: "ready",
  },
  {
    href: "/bridge",
    title: "Generated Bridge",
    desc: "MusicGen composes a custom bridge clip between two songs.",
    status: "ready",
  },
  {
    href: "/export",
    title: "Export Reel",
    desc: "Render a ≤60s famous-parts mega-mix as a vertical video for Reels/Shorts.",
    status: "ready",
  },
];

export default function FeaturesPage() {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-3xl font-bold">
        Ever<span className="text-fuchsia-500">play</span> Lab
      </h1>
      <p className="mt-1 text-zinc-400">
        Every card is an experiment , try them all, keep what slaps.
      </p>
      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {experiments.map((e) => (
          <Link
            key={e.href}
            href={e.href}
            className="group rounded-xl border border-zinc-800 p-4 transition hover:border-fuchsia-600"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-semibold group-hover:text-fuchsia-400">
                {e.title}
              </h2>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                  e.status === "home"
                    ? "bg-fuchsia-900/60 text-fuchsia-300"
                    : e.status === "ready"
                      ? "bg-emerald-900/60 text-emerald-300"
                      : "bg-zinc-800 text-zinc-400"
                }`}
              >
                {e.status}
              </span>
            </div>
            <p className="mt-1 text-sm text-zinc-400">{e.desc}</p>
          </Link>
        ))}
      </div>
    </main>
  );
}
