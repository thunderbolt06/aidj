import type { Metadata } from "next";
import Link from "next/link";
import { PageHero } from "@/components/site/PageHero";
import { Reveal } from "@/components/site/Reveal";
import { FamousPartDemo } from "@/components/site/FamousPartDemo";
import { CtaBand } from "@/components/site/CtaBand";

export const metadata: Metadata = {
  title: "How it works",
  description: "How Everplay analyses songs, picks what plays next, plans each DJ transition and lands it on the beat, all prepared ahead of time.",
  alternates: { canonical: "/how-it-works" },
};

const STAGES = [
  {
    k: "1", t: "Analyse once, ahead of time",
    p: "Each song in the library is analysed before you ever listen: tempo and beat grid, downbeats, key (as a Camelot code), per-second energy, loudness, an intensity score, intro and outro cue points, and the hook. The results ship with the track, so your browser only downloads and decodes.",
  },
  {
    k: "2", t: "Find the famous part",
    p: "The hook is the section that is both loud and recurs. It is found by comparing the harmony across the song with itself and taking the first occurrence of the strongest repeat. The seekbar heatmap in the player is that same curve.",
  },
  {
    k: "3", t: "Choose what plays next",
    p: "Vibe playlists first, then tempo, key and intensity. It is instant and every pick is guaranteed playable. Each month the public playlists behind every vibe chip are re-read: a song in many of a vibe's playlists is that vibe. A set draws from its vibe at random, weighted by agreement, with a lean toward recent releases and your recently played songs pushed down.",
  },
  {
    k: "4", t: "Plan the transition",
    p: "A planner reads both songs - tempo gap, key compatibility, energy at the exit and entry, how the outgoing song ends - and picks one of ten styles. Heuristic fallbacks mean a failed AI call never stops the music.",
  },
  {
    k: "5", t: "Land it on the audio clock",
    p: "A dual-deck Web Audio engine schedules every gain, filter and echo change against the beat grid on the audio clock, not with timers. Drops land sample-accurate. Beat-matching glides the incoming song's tempo.",
  },
  {
    k: "6", t: "Keep going",
    p: "The next song is loaded, analysed and planned while the current one plays. The queue refills itself inside the vibe. If a track fails, it is skipped rather than stalling the set.",
  },
];

export default function HowItWorks() {
  return (
    <>
      <PageHero eyebrow="How it works" title={<>Prepared ahead. <span className="ep-grad">Executed on the beat.</span></>} lede="The magic of a mix dies with latency. So everything that can be computed is computed before you press play." />
      <section className="ep-section">
        <div className="ep-wrap">
          <FamousPartDemo />
        </div>
      </section>
      <section className="ep-section !pt-0">
        <ol className="ep-wrap relative space-y-5 before:absolute before:bottom-4 before:left-[2.1rem] before:top-4 before:hidden before:w-px before:bg-white/10 sm:before:block">
          {STAGES.map((s, i) => (
            <Reveal as="li" key={s.k} delay={(i % 2) * 80} className="relative flex gap-5 rounded-3xl border border-white/10 bg-white/[0.03] p-6 sm:p-8">
              <span className="ep-big grid h-12 w-12 shrink-0 place-items-center rounded-full border border-cyan-400/50 bg-[#05080f] text-lg text-cyan-300">{s.k}</span>
              <div>
                <h2 className="text-xl font-semibold">{s.t}</h2>
                <p className="mt-2 max-w-3xl leading-relaxed text-[#8aa0ab]">{s.p}</p>
              </div>
            </Reveal>
          ))}
        </ol>
        <Reveal className="ep-wrap mt-10">
          <p className="text-[#8aa0ab]">
            Want the details on one piece? Read <Link href="/blog/how-an-ai-dj-works" className="text-cyan-300 underline underline-offset-4">how an AI DJ works</Link>, the <Link href="/blog/ten-dj-transitions-explained" className="text-cyan-300 underline underline-offset-4">ten transitions explained</Link>, or the <Link href="/blog/camelot-wheel-harmonic-mixing-guide" className="text-cyan-300 underline underline-offset-4">Camelot wheel guide</Link>.
          </p>
        </Reveal>
      </section>
      <CtaBand />
    </>
  );
}
