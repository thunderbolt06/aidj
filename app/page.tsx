"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Track } from "@/lib/types";
import { getEngine, loadTrack, searchTracks } from "@/lib/client/dj";
import { useAutoMix } from "@/lib/client/useAutoMix";
import {
  TOP_LANGUAGES,
  MORE_LANGUAGES,
  getSelectedLanguageLabels,
  useLanguagePrefs,
} from "@/lib/client/langPrefs";
import { MIN_PLAY_RANGE, useMinPlaySec } from "@/lib/client/playerPrefs";
import { SearchPicker } from "@/components/SearchPicker";
import { HeatmapBar } from "@/components/HeatmapBar";
import { BeatTapButton } from "@/components/BeatTapPulse";
import { PauseIcon, PlayIcon, ShuffleIcon, SkipForwardIcon } from "@/components/icons";

/**
 * Home = the Compilation deck. A streaming-app shell (bottom player dock,
 * queue sheet) rebuilt around a different listening contract than
 * Spotify/YT Music: songs don't play out, the DJ hops when a song has given
 * its best moment, and YOU steer it physically:
 *   - tap spacebar / the clap button on the beat = "keep it going" (+15s per tap)
 *   - NEXT: quick tap skips; press & hold builds tension, release drops
 *   - 9-grid = pick the next door instead of a linear queue
 * The seekbar is the replay heatmap: you see WHERE the famous part is, and
 * click/drag on it scrubs with a vinyl-scratch transition.
 */

interface Suggestion {
  track: Track;
  tag: "safe" | "shift" | "wild";
}

// every situation someone reaches for audio - shuffled a chunk at a time so
// the hero doesn't turn into a wall of pills; "🔀 more" resamples the pool.
// Not just songs: genres, game/movie scores, and spoken-word all work too -
// the AI picks real, findable content matching whatever the chip asks for.
const VIBE_CHIP_POOL = [
  "singable road trip",
  "study focus session",
  "high session",
  "background for a house party",
  "chill music while we chat",
  "fashion store playlist",
  "jam session with friends",
  "sangeet bangers",
  "2010s pop anthems",
  "late night chill",
  "love time, slow and romantic",
  "movie dialogues mashup",
  "reels time - short viral hooks",
  "meme time - funny songs",
  "bhajan time",
  "gym workout time",
  "sad boi hours",
  "breakup healing",
  "rainy day mood",
  "morning routine energizer",
  "cooking in the kitchen",
  "pre-game hype",
  "long night drive",
  "coffee shop acoustic",
  "yoga and meditation",
  "cleaning the house",
  "shower singing",
  "exam stress relief",
  "airport lounge / traveling",
  "garba and dandiya night",
  "diwali party",
  "holi splash",
  "office lo-fi background",
  "birthday party bangers",
  "late night coding",
  "wedding baraat",
  "anime opening hype",
  "retro 90s bollywood",
  "k-drama feels",
  "poolside chill",
  // genres
  "afrobeats",
  "techno",
  "EDM festival set",
  "deep house",
  "trance journey",
  "drum and bass",
  "dubstep bass drops",
  "reggae and dancehall",
  "funk and disco",
  "city pop",
  "flamenco",
  "sufi and qawwali",
  "carnatic classical",
  "old school hip hop",
  "trap bangers",
  "synthwave",
  "ambient soundscapes",
  // non-song audio
  "motivational speeches",
  "true crime podcast",
  "comedy podcast clips",
  "famous game soundtracks",
  "movie score iconic themes",
  "TED talk highlights",
  "standup comedy clips",
  "ASMR and rain sounds",
  "white noise for sleep",
  "nature and forest sounds",
];

// how many chips show on the hero at once before you have to hit "more"
const CHIP_DISPLAY_COUNT = 16;

function sampleChips(n: number): string[] {
  const copy = [...VIBE_CHIP_POOL];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

const HOLD_MS = 350; // press shorter than this = tap, longer = hold

// the app's default button: hero chips, top-bar actions and settings entries
// all share it so every screen reads as one design system
const PILL =
  "rounded-full border border-zinc-700 bg-zinc-900/70 text-zinc-300 backdrop-blur transition hover:border-cyan-600 hover:text-cyan-300 active:scale-95";

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * One row of the queue sheet: drag the ⠿ handle to reorder (desktop),
 * swipe left to delete (touch) - the row slides to reveal a trash icon and
 * animates out past the threshold.
 */
function QueueRow({
  index,
  title,
  isNow,
  onDelete,
  onDragStart,
  onDrop,
}: {
  index: number;
  title: string;
  isNow: boolean;
  onDelete: () => void;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const [dx, setDx] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [swiping, setSwiping] = useState(false);
  const touch = useRef<{ x: number; y: number; swiping: boolean } | null>(null);
  // live swipe distance - state can lag a fast flick (events batch in a frame)
  const dxRef = useRef(0);

  return (
    <li
      className="relative overflow-hidden rounded"
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      {/* trash affordance sits under the row, revealed as it slides left */}
      <div className="absolute inset-0 flex items-center justify-end rounded bg-red-600/90 pr-4">
        🗑
      </div>
      <div
        className={`relative flex items-center justify-between gap-2 rounded px-3 py-2 ${
          isNow ? "bg-cyan-950 text-cyan-300" : "bg-zinc-900"
        }`}
        style={{
          transform: leaving ? "translateX(-110%)" : `translateX(${dx}px)`,
          transition: swiping ? "none" : "transform 0.2s ease",
          touchAction: "pan-y",
        }}
        onTouchStart={(e) => {
          const t = e.touches[0];
          touch.current = { x: t.clientX, y: t.clientY, swiping: false };
        }}
        onTouchMove={(e) => {
          const s = touch.current;
          if (!s) return;
          const t = e.touches[0];
          const mx = t.clientX - s.x;
          const my = t.clientY - s.y;
          // only claim the gesture once it's clearly horizontal (else scroll)
          if (!s.swiping && Math.abs(mx) > 8 && Math.abs(mx) > Math.abs(my)) {
            s.swiping = true;
            setSwiping(true);
          }
          if (s.swiping) {
            dxRef.current = Math.min(0, mx);
            setDx(dxRef.current);
          }
        }}
        onTouchEnd={() => {
          const s = touch.current;
          touch.current = null;
          setSwiping(false);
          if (s?.swiping && dxRef.current < -72) {
            setLeaving(true);
            setTimeout(onDelete, 180); // let the slide-out play first
          } else {
            dxRef.current = 0;
            setDx(0);
          }
        }}
      >
        <span className="truncate">{title}</span>
        <span
          className="cursor-grab select-none text-zinc-600 active:cursor-grabbing"
          title="Drag to reorder"
        >
          ⠿
        </span>
      </div>
    </li>
  );
}

export default function HomePage() {
  const mix = useAutoMix();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState("");
  const [grid, setGrid] = useState<Suggestion[]>([]);
  const [tapToExtend, setTapToExtend] = useState(true);
  const [holding, setHolding] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [moreLangOpen, setMoreLangOpen] = useState(false);
  // mid-set "home": logo tap brings the hero back while the dock keeps playing
  const [homeView, setHomeView] = useState(false);
  // 9-grid tile whose transition is loading (spinner overlay until the hop)
  const [pendingTile, setPendingTile] = useState<string | null>(null);
  const { selected: langSelected, toggle: toggleLang } = useLanguagePrefs();
  const { minPlaySec, setMinPlaySec } = useMinPlaySec();
  // deterministic on first paint (matches SSR), reshuffled client-side after
  // mount so refreshing/tapping shuffle surfaces different situations
  const [vibeChips, setVibeChips] = useState(() =>
    VIBE_CHIP_POOL.slice(0, CHIP_DISPLAY_COUNT)
  );
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdingRef = useRef(false);
  const dragFrom = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  // swipe on the player row: left = next song, right = previous (both hop
  // through a real DJ transition, never a hard cut)
  const [playerDx, setPlayerDx] = useState(0);
  const playerTouch = useRef<{ x: number; y: number; swiping: boolean } | null>(null);
  const playerDxRef = useRef(0);

  useEffect(() => {
    setVibeChips(sampleChips(CHIP_DISPLAY_COUNT));
  }, []);

  // settings dropdown closes when you click anywhere else
  useEffect(() => {
    if (!settingsOpen) return;
    const close = (e: PointerEvent) => {
      if (!settingsRef.current?.contains(e.target as Node)) setSettingsOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [settingsOpen]);

  // spacebar: quick tap extends interest, hold+release transitions
  useEffect(() => {
    if (!mix.running) return;
    const isTyping = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    };
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || isTyping(e)) return;
      e.preventDefault();
      holdTimer.current = setTimeout(() => {
        holdingRef.current = true;
        setHolding(true);
        getEngine().tension(true);
      }, HOLD_MS);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTyping(e)) return;
      e.preventDefault();
      if (holdTimer.current) clearTimeout(holdTimer.current);
      if (holdingRef.current) {
        holdingRef.current = false;
        setHolding(false);
        mix.hopNow(); // transition resets the tension FX
      } else if (tapToExtend) {
        mix.tapInterest();
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      if (holdTimer.current) clearTimeout(holdTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mix.running, tapToExtend]);

  // hardware/OS media keys (headphones, keyboard, lock screen, car stereo):
  // play/pause → our pause toggle, next → NEXT's plain-skip tap, and — since
  // there's no "previous song" here (it's a one-way DJ set) — back → the clap
  // button, so the physical back button becomes "keep this one going".
  const mixRef = useRef(mix);
  mixRef.current = mix;
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    if (!mix.running) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler("play", () => mixRef.current.togglePause());
    ms.setActionHandler("pause", () => mixRef.current.togglePause());
    ms.setActionHandler("nexttrack", () => mixRef.current.hopNow());
    ms.setActionHandler("previoustrack", () => mixRef.current.tapInterest());
    return () => {
      ms.setActionHandler("play", null);
      ms.setActionHandler("pause", null);
      ms.setActionHandler("nexttrack", null);
      ms.setActionHandler("previoustrack", null);
    };
  }, [mix.running]);

  // keep the OS-level playback state and now-playing card in sync
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = !mix.running
      ? "none"
      : mix.paused
        ? "paused"
        : "playing";
  }, [mix.running, mix.paused]);
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    if (!mix.now) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: mix.now.meta.title,
      artist: mix.now.meta.artist,
      artwork: mix.now.meta.thumbnail
        ? [{ src: mix.now.meta.thumbnail, sizes: "512x512", type: "image/jpeg" }]
        : [],
    });
  }, [mix.now]);

  // NEXT button: quick tap = skip now; press & hold = tension builds,
  // release = drop (same contract as spacebar-hold).
  function nextDown() {
    if (!mix.running) return;
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => {
      holdingRef.current = true;
      setHolding(true);
      getEngine().tension(true);
    }, HOLD_MS);
  }
  function nextUp(inside: boolean) {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (holdingRef.current) {
      holdingRef.current = false;
      setHolding(false);
      if (inside) mix.hopNow(); // release on the button = drop
      else getEngine().tension(false); // dragged off = cancel
    } else if (inside) {
      mix.hopNow(); // quick tap = plain skip
    }
  }

  async function refreshGrid(current: Track) {
    try {
      const res = await fetch("/api/ai/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current: `${current.title} - ${current.artist}`,
          languages: getSelectedLanguageLabels(),
        }),
      });
      if (!res.ok) return;
      const { suggestions } = (await res.json()) as {
        suggestions: { query: string; tag: Suggestion["tag"] }[];
      };
      const found = await Promise.all(
        suggestions.map(async (s) => {
          const r = await searchTracks(s.query).catch(() => []);
          return r[0] ? { track: r[0], tag: s.tag } : null;
        })
      );
      // enforce the 5 safe / 3 shift / 1 wild spread even if the model drifts,
      // backfilling from whatever is left when a bucket comes up short
      const ok = found.filter((s): s is Suggestion => !!s);
      const bucket = (tag: Suggestion["tag"], n: number) =>
        ok.filter((s) => s.tag === tag).slice(0, n);
      const picked = [...bucket("safe", 5), ...bucket("shift", 3), ...bucket("wild", 1)];
      const rest = ok.filter((s) => !picked.includes(s));
      const tiles = [...picked, ...rest].slice(0, 9);
      setGrid(tiles);
      // warm the first few tiles so taps are near-instant (stagger extractions)
      tiles.slice(0, 3).forEach((s, i) => {
        setTimeout(() => loadTrack(s.track.id).catch(() => {}), i * 4000);
      });
    } catch {
      /* suggestions are best-effort */
    }
  }

  async function buildVibe(text: string) {
    if (!text.trim()) return;
    setPrompt(text);
    setBusy("AI is reading the vibe…");
    try {
      const res = await fetch("/api/ai/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text, languages: getSelectedLanguageLabels() }),
      });
      if (!res.ok) throw new Error("intent failed - is ANTHROPIC_API_KEY set?");
      const plan = (await res.json()) as { queries: string[] };
      setBusy("finding the songs…");
      const found = await Promise.all(
        plan.queries.map((q) =>
          searchTracks(q)
            .then((r) => r[0] ?? null)
            .catch(() => null)
        )
      );
      const tracks = found.filter((t): t is Track => !!t);
      if (!tracks.length) throw new Error("no songs found - try another vibe");
      setBusy("");
      setHomeView(false);
      if (mix.running) {
        mix.setQueue((q) => [...q, ...tracks]);
        await mix.transitionTo(tracks[0]);
      } else {
        mix.setQueue(tracks);
        await mix.start({
          clipLen: "ai",
          useAi: true,
          quantize: true,
          endless: true,
          minPlaySec,
          onHop: ({ track }) => track && refreshGrid(track),
        });
        mix.prefetch();
        refreshGrid(tracks[0]);
      }
    } catch (e) {
      setBusy(e instanceof Error ? e.message : "failed");
    }
  }

  async function tapTile(s: Suggestion) {
    if (pendingTile) return; // one transition at a time
    setPendingTile(s.track.id);
    try {
      mix.setQueue((q) => [...q, s.track]);
      await mix.transitionTo(s.track);
      refreshGrid(s.track);
    } finally {
      setPendingTile(null);
    }
  }

  const upNext = mix.queue[(mix.nowIdx + 1) % Math.max(1, mix.queue.length)];
  const duration = mix.now?.analysis.duration ?? 0;

  // the hero already carries the big center logo - the corner one only shows
  // on the deck, where tapping it goes "home" (dock keeps playing below)
  const showHero = !mix.running || homeView;

  // top bar shared by both layouts: square logo left + song search (deck
  // only), settings icon right. Results/settings drop over the content.
  const cornerNav = (
    <div className="fixed inset-x-4 top-4 z-30 flex items-start justify-between gap-2">
      {showHero ? (
        <span />
      ) : (
        <button
          onClick={() => {
            setHomeView(true);
            setQueueOpen(false);
          }}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-zinc-700 bg-zinc-900/70 backdrop-blur transition hover:border-cyan-600 active:scale-95"
          title="Home"
        >
          <span className="text-2xl leading-none text-cyan-400 [text-shadow:0_0_12px_rgba(34,211,238,0.8)]">
            ∞
          </span>
        </button>
      )}
      {!showHero && (
        <div className="mx-auto w-full min-w-0 max-w-xl flex-1">
          <SearchPicker
            variant="bar"
            placeholder="Add a song to the playlist…"
            onPick={(t) => mix.addNext(t)}
          />
        </div>
      )}
      <div className="relative shrink-0" ref={settingsRef}>
          <button
            onClick={() => setSettingsOpen((o) => !o)}
            className={`${PILL} flex h-10 w-10 items-center justify-center text-base`}
            title="Settings"
          >
            ⚙
          </button>
          {settingsOpen && (
            <div className="fixed inset-x-3 top-16 z-40 max-h-[70vh] space-y-4 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950/95 p-4 text-sm text-zinc-300 shadow-xl backdrop-blur animate-[drop-in_150ms_ease] sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:max-h-none sm:w-80">
              <p className="text-xs text-zinc-500">
                space: tap = keep · hold = drop
              </p>

              <div className="space-y-2 border-t border-zinc-800 pt-3">
                <p
                  className="text-xs font-semibold uppercase tracking-wide text-zinc-500"
                  title="A song must play at least this long before the DJ may hop off it"
                >
                  ⏱ Min play time · {minPlaySec}s
                </p>
                <input
                  type="range"
                  min={MIN_PLAY_RANGE.min}
                  max={MIN_PLAY_RANGE.max}
                  step={MIN_PLAY_RANGE.step}
                  value={minPlaySec}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setMinPlaySec(v);
                    mix.setOptions({ minPlaySec: v }); // applies live mid-set
                  }}
                  className="w-full accent-cyan-500"
                />
                <p className="text-[11px] text-zinc-600">
                  every song plays at least {minPlaySec}s before the DJ hops
                </p>
              </div>

              <div className="space-y-2 border-t border-zinc-800 pt-3">
                <p
                  className="text-xs font-semibold uppercase tracking-wide text-zinc-500"
                  title="Biases every AI song pick (vibe prompts, 9-grid, Sing-It Showdown) toward these languages. None selected = no constraint."
                >
                  🌐 Song languages
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {TOP_LANGUAGES.map((l) => (
                    <button
                      key={l.code}
                      onClick={() => toggleLang(l.code)}
                      className={`rounded-full border px-2.5 py-1 text-xs transition ${
                        langSelected.includes(l.code)
                          ? "border-cyan-500 bg-cyan-600/20 text-cyan-300"
                          : "border-zinc-700 text-zinc-400 hover:border-cyan-700"
                      }`}
                    >
                      {l.label}
                    </button>
                  ))}
                  <button
                    onClick={() => setMoreLangOpen((o) => !o)}
                    className="rounded-full border border-dashed border-zinc-700 px-2.5 py-1 text-xs text-zinc-500 hover:border-cyan-700 hover:text-cyan-300"
                  >
                    {moreLangOpen ? "− less" : "+ more"}
                  </button>
                </div>
                {moreLangOpen && (
                  <div className="flex flex-wrap gap-1.5 border-t border-zinc-900 pt-2">
                    {MORE_LANGUAGES.map((l) => (
                      <button
                        key={l.code}
                        onClick={() => toggleLang(l.code)}
                        className={`rounded-full border px-2.5 py-1 text-xs transition ${
                          langSelected.includes(l.code)
                            ? "border-cyan-500 bg-cyan-600/20 text-cyan-300"
                            : "border-zinc-700 text-zinc-400 hover:border-cyan-700"
                        }`}
                      >
                        {l.label}
                      </button>
                    ))}
                  </div>
                )}
                {langSelected.length === 0 && (
                  <p className="text-[11px] text-zinc-600">none selected - mixes everything</p>
                )}
              </div>

              <div className="border-t border-zinc-800 pt-3">
                <Link
                  href="/features"
                  onClick={() => setSettingsOpen(false)}
                  className="flex items-center justify-between rounded-lg border border-zinc-800 px-3 py-2 transition hover:border-cyan-600 hover:text-cyan-300"
                >
                  <span>⚗ Features</span>
                  <span aria-hidden className="text-zinc-600">
                    →
                  </span>
                </Link>
                <p className="mt-1.5 text-[11px] text-zinc-600">
                  experiments: karaoke, mashups, music videos & more
                </p>
              </div>
            </div>
          )}
      </div>
    </div>
  );

  // hero: prompt-first home. Shown when idle AND when the logo is tapped
  // mid-set (the dock keeps playing underneath in that case).
  const hero = (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-6 text-center">
          <div>
            <p className="text-6xl leading-none text-cyan-400 [text-shadow:0_0_28px_rgba(34,211,238,0.9)]">
              ∞
            </p>
            <h1 className="mt-2 text-4xl font-bold">
              Ever<span className="text-cyan-400">play</span>
            </h1>
            <p className="mt-2 max-w-md text-sm text-zinc-400">
              Tell it a vibe. It plays only the famous parts, transitions like
              a DJ, and never stops. Clap along to keep a song;
            </p>
          </div>
          <div className="flex w-full max-w-xl gap-2">
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && buildVibe(prompt)}
              placeholder="What are we in the mood for?"
              className="flex-1 rounded-full border border-zinc-700 bg-zinc-900 px-5 py-3 outline-none focus:border-cyan-500"
            />
            <button
              onClick={() => buildVibe(prompt)}
              disabled={!!busy}
              className="rounded-full bg-cyan-600 px-6 py-3 font-semibold shadow-[0_0_20px_rgba(34,211,238,0.35)] transition hover:bg-cyan-500 disabled:opacity-50 disabled:shadow-none"
            >
              {busy ? "…" : "Mix it"}
            </button>
          </div>
          <div className="flex max-w-2xl flex-col items-center gap-3">
            <div className="flex flex-wrap justify-center gap-2">
              {vibeChips.map((c) => (
                <button
                  key={c}
                  onClick={() => buildVibe(c)}
                  className={`${PILL} px-4 py-1.5 text-sm`}
                >
                  {c}
                </button>
              ))}
            </div>
            {/* deliberately NOT styled like the chips above - it's a utility
                action (reshuffle the whole set), not a vibe you can pick */}
            <button
              onClick={() => setVibeChips(sampleChips(CHIP_DISPLAY_COUNT))}
              title="Swap in a different set of suggestions"
              className="flex items-center gap-1.5 rounded-full border border-white/40 px-3.5 py-1.5 text-xs text-white transition hover:border-white active:scale-95"
            >
              <ShuffleIcon size={14} /> Shuffle suggestions
            </button>
          </div>
          {busy && <p className="animate-pulse text-sm text-amber-400">{busy}</p>}
    </div>
  );

  if (!mix.running) {
    return (
      <main className="mx-auto max-w-3xl px-6 pb-6 pt-16">
        {cornerNav}
        {hero}
      </main>
    );
  }

  // live deck: the whole viewport is pinned (no page scroll) - the top area
  // shrinks to fit above the dock via flexbox, and the 9-grid fills whatever
  // space is left via a real grid-template (pure CSS, reflows on any resize).
  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden">
      {cornerNav}

      {homeView ? (
        // logo tap mid-set: back to the hero, the dock keeps playing below
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-16">{hero}</div>
      ) : (
      <div className="mx-auto flex w-full max-w-3xl min-h-0 flex-1 flex-col gap-3 overflow-hidden px-4 pb-3 pt-16 sm:px-6">
        {(busy || mix.status) && (
          <p className="animate-pulse text-sm text-amber-400">{busy || mix.status}</p>
        )}

        {/* 9-grid next songs (5 safe / 3 shift / 1 wild) - vibe prompting
            lives on the hero (tap the logo); the top bar covers song search */}
        <div className="flex min-h-0 flex-1 flex-col items-center pt-2">
          {grid.length > 0 ? (
            <div className="grid min-h-0 w-full max-w-lg flex-1 grid-cols-3 grid-rows-3 gap-1.5">
              {grid.map((s, i) => (
                <button
                  key={`${s.track.id}-${i}`}
                  onClick={() => tapTile(s)}
                  className={`group relative h-full w-full min-h-0 min-w-0 overflow-hidden rounded-xl transition ${
                    pendingTile && pendingTile !== s.track.id
                      ? "opacity-40"
                      : "active:scale-[0.97]"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={s.track.thumbnail}
                    alt=""
                    className="h-full w-full object-cover transition group-hover:scale-105"
                  />
                  <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black via-black/70 to-transparent px-2 pb-1.5 pt-8 text-xs font-bold leading-tight text-white line-clamp-2">
                    {s.track.title}
                  </span>
                  {/* the hop takes a moment - show it's coming right away */}
                  {pendingTile === s.track.id && (
                    <span className="absolute inset-0 z-10 flex items-center justify-center bg-black/60">
                      <span className="h-8 w-8 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
                    </span>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-zinc-600">
              suggestions load after the first song…
            </p>
          )}
        </div>
      </div>
      )}

      {/* bottom dock: seek row + player, queue bar at the very bottom */}
      <div className="shrink-0 border-t border-zinc-800 bg-zinc-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
        <div className="mx-auto max-w-3xl px-4">
          {/* seek row: the replay heatmap IS the transport - click or drag
              to scrub (vinyl-scratch transition in the engine) */}
          <div className="space-y-1 pt-2">
            {mix.now && (
              <HeatmapBar
                meta={mix.now.meta}
                position={mix.position}
                onSeek={(sec) => mix.seekTo(sec)}
              />
            )}
            <div className="flex justify-between text-[10px] tabular-nums text-zinc-500">
              <span>{fmt(mix.position)}</span>
              {mix.interestUntil > mix.position && (
                <span className="text-emerald-400">
                  claimed to {fmt(mix.interestUntil)}
                </span>
              )}
              <span>{fmt(duration)}</span>
            </div>
          </div>

          {/* player row - swipe left/right to hop to the next/previous song */}
          <div
            className="flex items-center gap-3 py-2.5"
            style={{
              touchAction: "pan-y",
              transform: `translateX(${playerDx}px)`,
              transition: playerTouch.current?.swiping ? "none" : "transform 0.2s ease",
            }}
            onTouchStart={(e) => {
              const t = e.touches[0];
              playerTouch.current = { x: t.clientX, y: t.clientY, swiping: false };
            }}
            onTouchMove={(e) => {
              const s = playerTouch.current;
              if (!s) return;
              const t = e.touches[0];
              const mx = t.clientX - s.x;
              const my = t.clientY - s.y;
              // only claim the gesture once it's clearly horizontal
              if (!s.swiping && Math.abs(mx) > 12 && Math.abs(mx) > Math.abs(my)) {
                s.swiping = true;
              }
              if (s.swiping) {
                playerDxRef.current = mx;
                setPlayerDx(mx);
              }
            }}
            onTouchEnd={() => {
              const s = playerTouch.current;
              playerTouch.current = null;
              const dx = playerDxRef.current;
              playerDxRef.current = 0;
              setPlayerDx(0);
              if (!s?.swiping) return;
              if (dx < -64) {
                mix.hopNow(); // swipe left = next song (transition)
              } else if (dx > 64) {
                const prev = mix.queue[mix.nowIdx - 1];
                if (prev) mix.transitionTo(prev); // swipe right = previous song
              }
            }}
          >
            {/* now-playing info: on the home view, tapping it reopens the deck */}
            <button
              onClick={() => setHomeView(false)}
              disabled={!homeView}
              title={homeView ? "Back to the deck" : undefined}
              className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default"
            >
              {mix.now && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={mix.now.meta.thumbnail}
                  alt=""
                  className="h-11 w-11 shrink-0 rounded-lg object-cover"
                />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">
                  {mix.now?.meta.title ?? "…"}
                </span>
                <span className="block truncate text-xs text-zinc-500">
                  {mix.now?.meta.artist}
                </span>
              </span>
            </button>
            <div className="flex shrink-0 items-center gap-2">
              {/* TAP: on the beat = keep this song going (+15s per tap) */}
              {tapToExtend && (
                <BeatTapButton
                  analysis={mix.now?.analysis ?? null}
                  onTap={() => mix.tapInterest()}
                  active={mix.running}
                />
              )}
              {/* PAUSE: freezes the mix in place; tap again to resume */}
              <button
                onClick={() => mix.togglePause()}
                className="flex h-11 w-11 items-center justify-center rounded-full border border-white/70 text-white transition hover:border-white active:scale-95"
                title={mix.paused ? "Resume" : "Pause"}
              >
                {mix.paused ? <PlayIcon /> : <PauseIcon />}
              </button>
              {/* NEXT: tap = skip · hold = tension builds · release = drop */}
              <span className="relative">
                {holding && (
                  <span className="absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] text-cyan-400">
                    release to drop
                  </span>
                )}
                <button
                  style={{ touchAction: "none" }}
                  onPointerDown={nextDown}
                  onPointerUp={() => nextUp(true)}
                  onPointerLeave={() => nextUp(false)}
                  className={`flex h-11 min-w-11 select-none items-center justify-center rounded-full border px-4 text-sm font-bold transition ${
                    holding
                      ? "animate-pulse border-cyan-400 text-cyan-300 shadow-[0_0_28px_rgba(34,211,238,0.7)]"
                      : "border-white/70 text-white hover:border-white"
                  }`}
                  title="Tap to skip - or hold to build tension and release to drop"
                >
                  {holding ? "RELEASE" : <SkipForwardIcon />}
                </button>
              </span>
            </div>
          </div>

          {/* queue sheet opens ABOVE its bar (which sits at the very bottom) */}
          {queueOpen && (
            <div className="max-h-56 space-y-2 overflow-y-auto border-t border-zinc-900 py-3 animate-[rise-in_200ms_ease]">
              <ul className="space-y-1 text-sm">
                {mix.queue.map((t, i) => (
                  <QueueRow
                    key={`${t.id}-${i}`}
                    index={i}
                    title={t.title}
                    isNow={i === mix.nowIdx}
                    onDragStart={() => (dragFrom.current = i)}
                    onDrop={() => {
                      if (dragFrom.current !== null)
                        mix.moveInQueue(dragFrom.current, i);
                      dragFrom.current = null;
                    }}
                    onDelete={() =>
                      mix.setQueue((q) => q.filter((_, j) => j !== i))
                    }
                  />
                ))}
              </ul>
            </div>
          )}

          {/* queue bar - bottom line of the app; click or swipe up to open */}
          <button
            className="flex w-full items-center justify-center border-t border-zinc-900 py-2.5 text-xs text-zinc-400"
            style={{ touchAction: "pan-x" }}
            onClick={() => setQueueOpen((o) => !o)}
            onTouchStart={(e) => (touchStartY.current = e.touches[0]?.clientY ?? null)}
            onTouchEnd={(e) => {
              const y0 = touchStartY.current;
              touchStartY.current = null;
              const y1 = e.changedTouches[0]?.clientY;
              if (y0 !== null && y1 !== undefined && y0 - y1 > 40) setQueueOpen(true);
            }}
          >
            <span className="max-w-full truncate px-6">
              queue: {upNext?.title ?? "…"}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
