"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import type { LyricLine, Track } from "@/lib/types";
import {
  getEngine,
  loadStem,
  loadTrack,
  searchTracks,
  type LoadedTrack,
} from "@/lib/client/dj";
import { getSelectedLanguageLabels } from "@/lib/client/langPrefs";

/**
 * Sing-It: 2-team party game.
 *
 * A vibe prompt builds a singable playlist ordered easy → hard. Each turn the
 * INSTRUMENTAL of a mystery song plays - the team must sing the actual lyrics.
 * The mic listens and auto-detects a correct sing-along (manual ✓ backup).
 * Miss for 30s and the song is thrown to the other team for half a point
 * (15s), else it skips. First to the points cap wins. The further ahead a
 * team is, the harder its next song.
 */

type TeamIdx = 0 | 1;
type Phase =
  | "setup"
  | "building" // AI playlist + search
  | "prep" // loading audio + stripping vocals for the round
  | "guess" // primary team singing (30s)
  | "steal" // other team singing (15s, half point)
  | "won" // round solved, song playing on, waiting for Next
  | "skipped" // nobody got it, waiting for Next
  | "over"; // game over

interface GameSong {
  track: Track;
  difficulty: number;
  played: boolean;
}

interface Round {
  songIdx: number;
  primary: TeamIdx;
  loaded: LoadedTrack;
  inst: AudioBuffer;
  lyrics: LyricLine[];
  synced: boolean;
  winner: TeamIdx | null;
  stealPoints: boolean; // won during steal → half point
}

// minimal Web Speech typing (same approach as the vibe page)
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: {
    resultIndex: number;
    results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>;
  }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => Recognition;

function getRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function normalizeWords(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/** Did the room sing this lyric line? ≥60% of its real words heard. */
function lineMatches(line: string, heardWords: Set<string>): boolean {
  const lw = normalizeWords(line);
  if (lw.length < 3) return false;
  const hit = lw.filter((w) => heardWords.has(w)).length;
  return hit / lw.length >= 0.6;
}

async function fetchLyrics(t: Track): Promise<{ lines: LyricLine[]; synced: boolean }> {
  const clean = t.title.replace(/[([].*?[)\]]/g, "").trim();
  const res = await fetch(
    `/api/lyrics?track=${encodeURIComponent(clean)}&artist=${encodeURIComponent(t.artist)}&duration=${t.duration}`
  );
  if (!res.ok) return { lines: [], synced: false };
  return res.json();
}

let sayAudio: HTMLAudioElement | null = null;

/** Announce via smallest.ai (Lightning v3.1, "Edward"); browser TTS fallback. */
async function say(text: string) {
  getEngine().duck(0.2, 3);
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error("tts unavailable");
    const url = URL.createObjectURL(await res.blob());
    sayAudio?.pause();
    sayAudio = new Audio(url);
    sayAudio.onended = () => URL.revokeObjectURL(url);
    await sayAudio.play();
  } catch {
    // no SMALLEST_API_KEY / offline → browser speech synthesis
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch {
      /* the on-screen banner still says it */
    }
  }
}

/** Victory chime / game-over fanfare straight through the engine's context. */
function chime(kind: "win" | "fanfare") {
  const ctx = getEngine().ctx;
  const notes =
    kind === "win"
      ? [523.25, 659.25, 783.99, 1046.5]
      : [523.25, 523.25, 659.25, 783.99, 1046.5, 1318.51, 1046.5, 1567.98];
  notes.forEach((f, i) => {
    const t = ctx.currentTime + i * 0.13;
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.6);
  });
}

/**
 * Pick the next unplayed song for a team with `score`: map the score onto the
 * easy→hard playlist so leaders get harder songs, then take the first
 * unplayed song at or past that difficulty.
 */
function pickSongFor(score: number, songs: GameSong[], maxPoints: number): number {
  const unplayed = songs.map((s, i) => ({ s, i })).filter((x) => !x.s.played);
  if (!unplayed.length) return -1;
  const target = Math.min(
    songs.length - 1,
    Math.round((score / Math.max(1, maxPoints)) * (songs.length - 1))
  );
  const atOrAfter = unplayed.find((x) => x.i >= target);
  return (atOrAfter ?? unplayed[unplayed.length - 1]).i;
}

/** Primary team's guess window, every round. */
const GUESS_SEC = 60;
const STEAL_SEC = 15;
/** How many rounds ahead to warm audio + demucs stems for. */
const PREFETCH_DEPTH = 3;
/** Cap simultaneous stem-separation jobs - demucs is slow, don't flood it. */
const PREFETCH_MAX = 6;

export default function GamePage() {
  const [, force] = useReducer((x: number) => x + 1, 0);
  // all game state lives in a ref: timers + speech callbacks mutate it and
  // call force() - no stale-closure hazards
  const g = useRef({
    phase: "setup" as Phase,
    teams: ["Team A", "Team B"],
    scores: [0, 0] as [number, number],
    songs: [] as GameSong[],
    gameName: "",
    round: null as Round | null,
    roundNo: 0,
    deadline: 0, // Date.now() ms when the current guess/steal window closes
    heard: [] as { t: number; text: string }[],
    matchedLine: "",
    banner: "",
    prepMsg: "",
    micAvailable: true,
    settings: {
      maxPoints: 5,
      autoDetect: true,
      fullSongAfterWin: true, // off → keep the instrumental after a win
    },
  }).current;
  const mic = useRef<Recognition | null>(null);
  const [prompt, setPrompt] = useState("");
  const [timeLeft, setTimeLeft] = useState(0);

  // heartbeat: countdowns + deadline enforcement
  useEffect(() => {
    const id = setInterval(() => {
      if (g.phase === "guess" || g.phase === "steal") {
        const left = Math.max(0, (g.deadline - Date.now()) / 1000);
        setTimeLeft(left);
        if (left <= 0) onTimeUp();
      }
    }, 250);
    return () => {
      clearInterval(id);
      stopMic();
      getEngine().stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── mic ────────────────────────────────────────────────────────────────────

  function stopMic() {
    const m = mic.current;
    mic.current = null;
    try {
      if (m) {
        m.onend = null;
        m.stop();
      }
    } catch {
      /* already stopped */
    }
  }

  function startMic() {
    stopMic();
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      g.micAvailable = false;
      force();
      return;
    }
    const rec = new Ctor();
    rec.lang = "en-IN";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let text = "";
      for (let i = e.resultIndex; i < e.results.length; i++)
        text += ` ${e.results[i][0].transcript}`;
      if (text.trim()) {
        g.heard.push({ t: Date.now(), text });
        g.heard = g.heard.filter((h) => Date.now() - h.t < 15_000);
        checkForMatch();
        force();
      }
    };
    // recognition dies on its own regularly - keep it alive during a round
    rec.onend = () => {
      if ((g.phase === "guess" || g.phase === "steal") && mic.current === rec) {
        try {
          rec.start();
        } catch {
          /* will retry on next round */
        }
      }
    };
    try {
      rec.start();
      mic.current = rec;
    } catch {
      g.micAvailable = false;
      force();
    }
  }

  function checkForMatch() {
    const r = g.round;
    if (!r || !g.settings.autoDetect || !r.lyrics.length) return;
    if (g.phase !== "guess" && g.phase !== "steal") return;
    const heardWords = new Set(
      normalizeWords(g.heard.map((h) => h.text).join(" "))
    );
    const pos = getEngine().position();
    // synced lyrics: only lines near the playhead count (they must sing ALONG)
    const candidates = r.synced
      ? r.lyrics.filter((l) => l.time >= pos - 25 && l.time <= pos + 8)
      : r.lyrics;
    const match = candidates.find((l) => lineMatches(l.text, heardWords));
    if (match) {
      g.matchedLine = match.text;
      succeed();
    }
  }

  // ── round flow ─────────────────────────────────────────────────────────────

  async function buildGame() {
    g.phase = "building";
    g.banner = "🤖 building the setlist…";
    force();
    try {
      const res = await fetch("/api/ai/game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, languages: getSelectedLanguageLabels() }),
      });
      if (!res.ok) throw new Error("game planning failed - is ANTHROPIC_API_KEY set?");
      const plan = (await res.json()) as {
        gameName?: string;
        songs?: { query: string; difficulty: number }[];
      };
      g.gameName = plan.gameName ?? "Sing-It";
      g.banner = "🔎 finding the songs…";
      force();
      const found = await Promise.all(
        (plan.songs ?? []).map(async (s) => {
          const r = await searchTracks(s.query).catch(() => []);
          return r[0] ? { track: r[0], difficulty: s.difficulty, played: false } : null;
        })
      );
      const songs = found.filter((s): s is GameSong => !!s);
      // dedupe (two queries can land on the same video)
      g.songs = songs.filter(
        (s, i) => songs.findIndex((x) => x.track.id === s.track.id) === i
      );
      if (g.songs.length < 4) throw new Error("couldn't find enough songs - try another vibe");
      g.scores = [0, 0];
      g.roundNo = 0;
      g.banner = "";
      await startRound(0);
    } catch (e) {
      g.phase = "setup";
      g.banner = `⚠ ${e instanceof Error ? e.message : e}`;
      force();
    }
  }

  /**
   * Which songs are likely to come up over the next `PREFETCH_DEPTH` rounds.
   * The primary team always alternates regardless of who wins (see
   * `nextRound`), so that part is deterministic - only the SCORE driving
   * difficulty is uncertain. Branch each round on the three outcomes (primary
   * wins, other team steals, nobody gets it) and collect the song each
   * resulting state would pick, closest rounds first.
   */
  function collectPrefetchIndices(depth: number): number[] {
    const hypothetical = g.songs.map((s) => ({ ...s }));
    if (g.round) hypothetical[g.round.songIdx].played = true;

    type State = { scores: [number, number]; primary: TeamIdx };
    let states: State[] = [
      {
        scores: [...g.scores] as [number, number],
        primary: (g.round ? 1 - g.round.primary : 0) as TeamIdx,
      },
    ];
    const seen = new Set<number>();
    const order: number[] = [];

    for (let d = 0; d < depth && order.length < PREFETCH_MAX; d++) {
      const nextStates: State[] = [];
      for (const st of states) {
        const idx = pickSongFor(st.scores[st.primary], hypothetical, g.settings.maxPoints);
        if (idx >= 0) {
          if (!seen.has(idx)) {
            seen.add(idx);
            order.push(idx);
          }
          hypothetical[idx].played = true; // don't re-pick the same song for a sibling branch
        }
        const other = (1 - st.primary) as TeamIdx;
        const outcomes: [TeamIdx | null, number][] = [
          [st.primary, 1], // primary wins outright
          [other, 0.5], // other team steals
          [null, 0], // nobody gets it
        ];
        for (const [winner, amt] of outcomes) {
          const scores = [...st.scores] as [number, number];
          if (winner !== null) scores[winner] += amt;
          nextStates.push({ scores, primary: other });
        }
      }
      states = nextStates;
    }
    return order.slice(0, PREFETCH_MAX);
  }

  /** Warm audio + stems for songs likely to come up over the next few rounds. */
  function prefetchUpcoming() {
    const targets = collectPrefetchIndices(PREFETCH_DEPTH);
    // stem separation is slow (1-4 min) - stagger so we don't fire a pile of
    // concurrent demucs jobs; the closest rounds (front of the list) go first
    targets.forEach((idx, i) => {
      const id = g.songs[idx].track.id;
      setTimeout(() => {
        loadTrack(id).catch(() => {});
        loadStem(id, "instrumental").catch(() => {});
        loadStem(id, "vocals").catch(() => {});
      }, i * 3000);
    });
  }

  async function startRound(primary: TeamIdx) {
    const idx = pickSongFor(g.scores[primary], g.songs, g.settings.maxPoints);
    if (idx < 0) {
      endGame(); // playlist exhausted - highest score wins
      return;
    }
    const song = g.songs[idx];
    song.played = true;
    g.phase = "prep";
    g.round = null;
    g.heard = [];
    g.matchedLine = "";
    g.banner = "";
    g.prepMsg = "🎛 preparing the mystery song… (vocal stripping can take 1–4 min the first time)";
    force();
    prefetchUpcoming();
    try {
      const [loaded, inst, ly] = await Promise.all([
        loadTrack(song.track.id),
        loadStem(song.track.id, "instrumental"),
        fetchLyrics(song.track),
      ]);
      g.round = {
        songIdx: idx,
        primary,
        loaded,
        inst,
        lyrics: ly.lines,
        synced: ly.synced,
        winner: null,
        stealPoints: false,
      };
      g.roundNo += 1;
      g.prepMsg = "";
      const start = Math.max(0, (loaded.meta.famousStart ?? 40) - 5);
      await getEngine().resume();
      getEngine().startTrack(inst, start, loaded.analysis);
      g.phase = "guess";
      g.deadline = Date.now() + GUESS_SEC * 1000;
      setTimeLeft(GUESS_SEC);
      say(`${g.teams[primary]}, sing it!`);
      if (g.settings.autoDetect && ly.lines.length) startMic();
      if (!ly.lines.length)
        g.banner = "⚠ no lyrics found for this one - use the ✓ button when they nail it";
      force();
    } catch (e) {
      // stem/audio failed (missing REPLICATE_API_TOKEN, extraction error…):
      // fail loud and move on rather than stalling the party
      g.banner = `⚠ song unavailable (${e instanceof Error ? e.message : e}) - skipping`;
      force();
      await startRound(primary);
    }
  }

  function onTimeUp() {
    const r = g.round;
    if (!r) return;
    if (g.phase === "guess") {
      // throw to the other team for half a point
      const other = (1 - r.primary) as TeamIdx;
      g.phase = "steal";
      g.deadline = Date.now() + STEAL_SEC * 1000;
      setTimeLeft(STEAL_SEC);
      g.heard = [];
      say(`${g.teams[other]}'s turn to complete it!`);
      force();
    } else if (g.phase === "steal") {
      stopMic();
      getEngine().stop();
      g.phase = "skipped";
      g.banner = `nobody got it - it was “${r.loaded.meta.title}”`;
      force();
      prefetchUpcoming(); // re-aim now that the round is settled
    }
  }

  function succeed() {
    const r = g.round;
    if (!r || (g.phase !== "guess" && g.phase !== "steal")) return;
    const winner = (g.phase === "guess" ? r.primary : 1 - r.primary) as TeamIdx;
    const points = g.phase === "steal" ? 0.5 : 1;
    r.winner = winner;
    r.stealPoints = g.phase === "steal";
    g.scores[winner] += points;
    g.phase = "won";
    stopMic();
    chime("win");
    // reveal: full song takes over (or the instrumental rides on, per setting)
    if (g.settings.fullSongAfterWin) {
      const pos = getEngine().position();
      getEngine().startTrack(r.loaded.buffer, pos, r.loaded.analysis);
    }
    if (g.scores[winner] >= g.settings.maxPoints) {
      setTimeout(() => endGame(), 400);
      return;
    }
    force();
    prefetchUpcoming(); // scores just changed - re-aim the lookahead
  }

  function endGame() {
    stopMic();
    g.phase = "over";
    const [a, b] = g.scores;
    g.banner =
      a === b
        ? "It's a tie!"
        : `🏆 ${g.teams[a > b ? 0 : 1]} wins ${Math.max(a, b)}–${Math.min(a, b)}!`;
    chime("fanfare");
    say(g.banner.replace(/[🏆–]/gu, " "));
    force();
  }

  function nextRound() {
    const r = g.round;
    getEngine().stop();
    const nextPrimary = (r ? 1 - r.primary : 0) as TeamIdx;
    startRound(nextPrimary);
  }

  function resetGame() {
    stopMic();
    getEngine().stop();
    g.phase = "setup";
    g.songs = [];
    g.round = null;
    g.scores = [0, 0];
    g.banner = "";
    force();
  }

  // ── render ─────────────────────────────────────────────────────────────────

  const r = g.round;
  const activeTeam: TeamIdx | null =
    g.phase === "guess" ? (r?.primary ?? null)
    : g.phase === "steal" ? ((1 - (r?.primary ?? 0)) as TeamIdx)
    : null;

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">
          Sing-It <span className="text-cyan-500">Showdown</span>
          {g.gameName && g.phase !== "setup" && (
            <span className="ml-2 text-base font-normal text-zinc-400">· {g.gameName}</span>
          )}
        </h1>
        <p className="text-sm text-zinc-400">
          The instrumental plays - your team sings the words. Nail a line and
          the full song drops in. 60s or it flips to the other team for half a
          point. Leaders get harder songs.
        </p>
      </header>

      {g.phase === "setup" && (
        <div className="space-y-4 rounded-xl border border-zinc-800 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {[0, 1].map((i) => (
              <input
                key={i}
                value={g.teams[i]}
                onChange={(e) => {
                  g.teams[i] = e.target.value;
                  force();
                }}
                placeholder={`Team ${i === 0 ? "A" : "B"}`}
                className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-cyan-500"
              />
            ))}
          </div>
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && buildGame()}
            placeholder='Vibe for tonight - e.g. "2010s bollywood sangeet", "pop anthems"'
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 outline-none focus:border-cyan-500"
          />
          <div className="flex flex-wrap items-center gap-4 text-sm text-zinc-300">
            <label className="flex items-center gap-2">
              Points to win
              <input
                type="number"
                min={1}
                max={20}
                value={g.settings.maxPoints}
                onChange={(e) => {
                  g.settings.maxPoints = Math.max(1, Number(e.target.value) || 5);
                  force();
                }}
                className="w-16 rounded border border-zinc-700 bg-zinc-900 px-2 py-1"
              />
            </label>
            <label
              className="flex items-center gap-2"
              title="The mic listens and awards the point automatically when the team sings a correct lyric line. Turn off if detection misfires - the ✓ button always works."
            >
              <input
                type="checkbox"
                checked={g.settings.autoDetect}
                onChange={(e) => {
                  g.settings.autoDetect = e.target.checked;
                  force();
                }}
              />
              🎙 Auto-detect singing
            </label>
            <label
              className="flex items-center gap-2"
              title="After a correct guess: play the real song with vocals (on) or keep the instrumental running for pure karaoke (off)"
            >
              <input
                type="checkbox"
                checked={g.settings.fullSongAfterWin}
                onChange={(e) => {
                  g.settings.fullSongAfterWin = e.target.checked;
                  force();
                }}
              />
              🎵 Full song after a win
            </label>
          </div>
          <button
            onClick={buildGame}
            className="rounded-lg bg-cyan-600 px-5 py-2 font-semibold hover:bg-cyan-500"
          >
            ▶ Start game
          </button>
        </div>
      )}

      {g.phase !== "setup" && (
        <>
          {/* scoreboard */}
          <div className="grid grid-cols-2 gap-3">
            {([0, 1] as TeamIdx[]).map((i) => (
              <div
                key={i}
                className={`rounded-xl border p-4 text-center transition ${
                  activeTeam === i
                    ? "border-cyan-500 bg-cyan-950/40"
                    : "border-zinc-800"
                }`}
              >
                <p className="truncate text-sm text-zinc-400">{g.teams[i]}</p>
                <p className="text-3xl font-bold tabular-nums">{g.scores[i]}</p>
                {activeTeam === i && (
                  <p className="animate-pulse text-xs text-cyan-300">
                    {g.phase === "steal" ? "steal it! (½ point)" : "singing…"}
                  </p>
                )}
              </div>
            ))}
          </div>

          {g.banner && (
            <p className="rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-sm text-amber-300">
              {g.banner}
            </p>
          )}

          {g.phase === "building" && (
            <p className="animate-pulse text-sm text-amber-400">{g.banner || "…"} </p>
          )}
          {g.phase === "prep" && (
            <p className="animate-pulse text-sm text-amber-400">{g.prepMsg}</p>
          )}

          {(g.phase === "guess" || g.phase === "steal") && r && (
            <div className="space-y-4 rounded-xl border border-zinc-800 p-5 text-center">
              <p className="text-sm uppercase tracking-widest text-zinc-500">
                round {g.roundNo} · difficulty {g.songs[r.songIdx].difficulty}/10
              </p>
              <p className="text-4xl font-bold">🎵 ??? 🎵</p>
              <p
                className={`text-5xl font-bold tabular-nums ${
                  timeLeft <= 5 ? "animate-pulse text-red-400" : "text-cyan-300"
                }`}
              >
                {Math.ceil(timeLeft)}
              </p>
              {!g.micAvailable && (
                <p className="text-xs text-amber-400">
                  ⚠ speech recognition unavailable in this browser - award with ✓
                </p>
              )}
              {g.heard.length > 0 && (
                <p className="truncate text-xs text-zinc-500">
                  heard: “…{g.heard.at(-1)?.text.trim().slice(-60)}”
                </p>
              )}
              <div className="flex flex-wrap justify-center gap-3">
                <button
                  onClick={succeed}
                  className="rounded-lg bg-emerald-600 px-5 py-2 font-semibold hover:bg-emerald-500"
                  title="Manual award - for when the mic didn't catch a clearly-correct sing-along"
                >
                  ✓ They got it!
                </button>
                <button
                  onClick={nextRound}
                  className="rounded-lg border border-zinc-700 px-4 py-2 text-sm"
                  title="Host skip: no points, next song"
                >
                  skip →
                </button>
              </div>
            </div>
          )}

          {(g.phase === "won" || g.phase === "skipped") && r && (
            <div className="space-y-3 rounded-xl border border-zinc-800 p-5 text-center">
              {g.phase === "won" && (
                <p className="text-lg font-semibold text-emerald-400">
                  🎉 {g.teams[r.winner!]} takes {r.stealPoints ? "½" : "1"} point!
                </p>
              )}
              <p className="text-xl font-bold">{r.loaded.meta.title}</p>
              <p className="text-sm text-zinc-400">{r.loaded.meta.artist}</p>
              {g.matchedLine && (
                <p className="text-sm text-cyan-300">“{g.matchedLine}”</p>
              )}
              <button
                onClick={nextRound}
                className="rounded-lg bg-cyan-600 px-6 py-2 font-semibold hover:bg-cyan-500"
              >
                Next song → ({g.teams[(1 - r.primary) as TeamIdx]} is up)
              </button>
            </div>
          )}

          {g.phase === "over" && (
            <div className="space-y-4 rounded-xl border border-cyan-800 bg-cyan-950/20 p-6 text-center">
              <p className="text-2xl font-bold">{g.banner}</p>
              <button
                onClick={resetGame}
                className="rounded-lg bg-zinc-100 px-5 py-2 font-semibold text-zinc-900"
              >
                Play again
              </button>
            </div>
          )}

          {/* in-game settings */}
          {g.phase !== "over" && g.phase !== "building" && (
            <div className="flex flex-wrap items-center gap-4 text-xs text-zinc-400">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={g.settings.autoDetect}
                  onChange={(e) => {
                    g.settings.autoDetect = e.target.checked;
                    if (!e.target.checked) stopMic();
                    else if (g.phase === "guess" || g.phase === "steal") startMic();
                    force();
                  }}
                />
                🎙 auto-detect
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={g.settings.fullSongAfterWin}
                  onChange={(e) => {
                    g.settings.fullSongAfterWin = e.target.checked;
                    force();
                  }}
                />
                🎵 full song after win
              </label>
              <span>
                first to <b className="text-zinc-200">{g.settings.maxPoints}</b> wins
              </span>
              <button onClick={resetGame} className="underline hover:text-zinc-200">
                end game
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
