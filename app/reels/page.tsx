"use client";

import { useEffect, useRef, useState } from "react";
import type { Track } from "@/lib/types";
import { loadTrack, searchTracks } from "@/lib/client/dj";
import { useAutoMix } from "@/lib/client/useAutoMix";
import { getSelectedLanguageLabels } from "@/lib/client/langPrefs";
import { recentlyPlayed } from "@/lib/client/history";
import { HeatmapBar } from "@/components/HeatmapBar";

/**
 * Reels for music: every card is a song's famous part. Swiping to the next
 * card IS the DJ transition (quantized to the phrase). Feed refills itself
 * with AI suggestions based on what you're vibing with.
 */
export default function ReelsPage() {
  const mix = useAutoMix();
  const [seed, setSeed] = useState("");
  const [feed, setFeed] = useState<Track[]>([]);
  const [busy, setBusy] = useState("");
  const [started, setStarted] = useState(false);
  const refillLock = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeId = useRef<string | null>(null);
  // the playlist vibes the feed came from, so refills keep to them
  const vibesRef = useRef<string[]>([]);

  async function buildFeed() {
    if (!seed.trim()) return;
    setBusy("building your feed…");
    try {
      const res = await fetch("/api/ai/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: seed,
          languages: getSelectedLanguageLabels(),
          recent: recentlyPlayed(),
        }),
      });
      if (!res.ok) throw new Error("intent failed - ANTHROPIC_API_KEY?");
      const plan = await res.json();
      vibesRef.current = plan.vibes ?? [];
      const found = await Promise.all(
        (plan.queries as string[]).map((q) =>
          searchTracks(q).then((r) => r[0] ?? null).catch(() => null)
        )
      );
      const tracks = found.filter((t): t is Track => !!t);
      setFeed(tracks);
      mix.setQueue(tracks);
      setBusy("");
      // warm the first few cards before the user even hits start
      tracks.slice(0, 3).forEach((t, i) => {
        setTimeout(() => loadTrack(t.id).catch(() => {}), i * 3000);
      });
    } catch (e) {
      setBusy(e instanceof Error ? e.message : "failed");
    }
  }

  async function refill(current: Track) {
    if (refillLock.current) return;
    refillLock.current = true;
    try {
      const res = await fetch("/api/ai/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current: `${current.title} - ${current.artist}`,
          vibes: vibesRef.current,
          recent: recentlyPlayed(),
          exclude: feed.map((t) => t.id),
          languages: getSelectedLanguageLabels(),
        }),
      });
      if (!res.ok) return;
      const { suggestions } = await res.json();
      const found = await Promise.all(
        (suggestions as { query: string }[]).map((s) =>
          searchTracks(s.query).then((r) => r[0] ?? null).catch(() => null)
        )
      );
      const fresh = found.filter(
        (t): t is Track =>
          !!t && !feedRef.current.some((f) => f.id === t.id)
      );
      setFeed((f) => [...f, ...fresh]);
      mix.setQueue((q) => [...q, ...fresh]);
    } finally {
      refillLock.current = false;
    }
  }

  // keep a ref of feed for the observer + refill dedup
  const feedRef = useRef<Track[]>([]);
  feedRef.current = feed;

  async function activateCard(track: Track, index: number) {
    if (activeId.current === track.id) return;
    activeId.current = track.id;
    if (!started) return; // first play happens via the start button
    await mix.transitionTo(track);
    mix.prefetch(3);
    if (index >= feedRef.current.length - 3) refill(track);
  }

  useEffect(() => {
    if (!started || !containerRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && e.intersectionRatio > 0.6) {
            const idx = Number((e.target as HTMLElement).dataset.idx);
            const track = feedRef.current[idx];
            if (track) activateCard(track, idx);
          }
        }
      },
      { root: containerRef.current, threshold: 0.6 }
    );
    containerRef.current
      .querySelectorAll("[data-idx]")
      .forEach((el) => observer.observe(el));
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, feed.length]);

  async function startFeed() {
    if (!feed.length) return;
    setStarted(true);
    activeId.current = feed[0].id;
    // snappy: 1-bar quantize, ≤3s blends, no AI roundtrips at swipe time
    await mix.start({
      clipLen: 0,
      useAi: false,
      quantize: true,
      quantizeBeats: 4,
      maxTransitionDur: 3,
    });
    mix.prefetch(3);
  }

  if (!started) {
    return (
      <main className="mx-auto max-w-xl p-6 space-y-6">
        <header>
          <h1 className="text-2xl font-bold">Reels Feed</h1>
          <p className="text-sm text-zinc-400">
            A vertical feed of famous parts. Swiping to the next card is the
            transition. Tell it a vibe to start.
          </p>
        </header>
        <div className="flex gap-2">
          <input
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && buildFeed()}
            placeholder='e.g. "2010s party anthems"'
            className="flex-1 rounded-lg bg-zinc-900 border border-zinc-700 px-3 py-2 outline-none focus:border-cyan-500"
          />
          <button
            onClick={buildFeed}
            className="rounded-lg bg-cyan-600 px-4 py-2 font-medium"
          >
            Build feed
          </button>
        </div>
        {busy && <p className="animate-pulse text-sm text-amber-400">{busy}</p>}
        {feed.length > 0 && (
          <button
            onClick={startFeed}
            className="w-full rounded-xl bg-zinc-100 py-4 text-lg font-bold text-zinc-900"
          >
            ▶ Start scrolling ({feed.length} songs)
          </button>
        )}
      </main>
    );
  }

  return (
    <div
      ref={containerRef}
      className="h-dvh snap-y snap-mandatory overflow-y-scroll"
    >
      {feed.map((t, i) => {
        const isActive = mix.now?.meta.id === t.id;
        return (
          <section
            key={`${t.id}-${i}`}
            data-idx={i}
            className="relative flex h-dvh snap-start items-end"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={t.thumbnail}
              alt=""
              className={`absolute inset-0 h-full w-full object-cover transition ${
                isActive ? "opacity-60" : "opacity-25"
              }`}
            />
            <div className="relative z-10 w-full bg-gradient-to-t from-black via-black/60 to-transparent p-6 pb-12">
              <p className="text-xl font-bold drop-shadow">{t.title}</p>
              <p className="text-sm text-zinc-300">{t.artist}</p>
              {isActive && mix.now && (
                <div className="mt-3 space-y-1">
                  <HeatmapBar meta={mix.now.meta} position={mix.position} />
                  {mix.lastPlan && (
                    <p className="text-xs text-cyan-300">
                      {mix.lastPlan.style} - {mix.lastPlan.reasoning}
                    </p>
                  )}
                </div>
              )}
              {mix.status && isActive && (
                <p className="mt-1 animate-pulse text-xs text-amber-400">
                  {mix.status}
                </p>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
