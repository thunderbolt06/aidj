"use client";

import { useState } from "react";
import type { Track } from "@/lib/types";
import { loadTrack, type LoadedTrack } from "@/lib/client/dj";
import { audioBufferToWav, renderReel } from "@/lib/audio/render";
import { SearchPicker } from "@/components/SearchPicker";

/**
 * Export Reel: pick 2-3 songs, offline-render their famous parts into one
 * ≤60s mix, and download it as WAV or a vertical mp4 ready for
 * Instagram Reels / YouTube Shorts.
 */
export default function ExportPage() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [clipSec, setClipSec] = useState(18);
  const [status, setStatus] = useState("");
  const [wavUrl, setWavUrl] = useState("");
  const [mp4Url, setMp4Url] = useState("");
  const [rendering, setRendering] = useState(false);

  const totalSec = Math.round(
    tracks.length * clipSec - Math.max(0, tracks.length - 1) * 1.5
  );

  async function render() {
    if (tracks.length < 2) return;
    setRendering(true);
    setWavUrl("");
    setMp4Url("");
    try {
      setStatus("loading songs…");
      const loaded: LoadedTrack[] = [];
      for (const t of tracks) loaded.push(await loadTrack(t.id, setStatus));

      setStatus("rendering the mix (faster than realtime)…");
      const buffer = await renderReel(loaded, clipSec);
      const wav = audioBufferToWav(buffer);
      setWavUrl(URL.createObjectURL(wav));

      setStatus("building the vertical video (ffmpeg)…");
      const meta = {
        clips: tracks.map((t, i) => ({
          image: t.thumbnail,
          duration: i === tracks.length - 1 ? clipSec : clipSec - 1.5,
        })),
      };
      const res = await fetch(
        `/api/video?meta=${encodeURIComponent(JSON.stringify(meta))}`,
        { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav }
      );
      if (res.ok) {
        setMp4Url(URL.createObjectURL(await res.blob()));
        setStatus("");
      } else {
        const err = await res.json().catch(() => null);
        setStatus(
          `video failed (${err?.error ?? res.status}) - WAV is still ready below`
        );
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "render failed");
    } finally {
      setRendering(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Export Reel</h1>
        <p className="text-sm text-zinc-400">
          2-3 songs → one ≤60s mega-mix of just the famous parts → download as
          audio or a vertical video for Reels/Shorts. Post it, check the vibe.
        </p>
      </header>

      <SearchPicker
        placeholder="Add songs (2-3 works best)…"
        onPick={(t) =>
          setTracks((cur) => (cur.length < 3 ? [...cur, t] : cur))
        }
      />

      {tracks.length > 0 && (
        <ul className="space-y-1 text-sm">
          {tracks.map((t, i) => (
            <li
              key={`${t.id}-${i}`}
              className="flex items-center justify-between rounded bg-zinc-900 px-3 py-1.5"
            >
              <span className="truncate">
                {i + 1}. {t.title}
              </span>
              <button
                onClick={() => setTracks((cur) => cur.filter((_, j) => j !== i))}
                className="ml-2 text-zinc-500 hover:text-red-400"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {[12, 18, 25].map((s) => (
          <button
            key={s}
            onClick={() => setClipSec(s)}
            className={`rounded-lg px-4 py-2 text-sm ${
              clipSec === s
                ? "bg-cyan-600"
                : "border border-zinc-700 text-zinc-300"
            }`}
          >
            {s}s / song
          </button>
        ))}
        <span className="text-sm text-zinc-500">total ≈ {totalSec}s</span>
        <button
          onClick={render}
          disabled={tracks.length < 2 || rendering}
          className="rounded-lg bg-cyan-600 px-5 py-2 font-semibold hover:bg-cyan-500 disabled:opacity-40"
        >
          {rendering ? "rendering…" : "🎬 Render reel"}
        </button>
      </div>

      {status && <p className="animate-pulse text-sm text-amber-400">{status}</p>}

      {(wavUrl || mp4Url) && (
        <div className="flex flex-wrap gap-3">
          {mp4Url && (
            <a
              href={mp4Url}
              download="aidj-reel.mp4"
              className="rounded-lg bg-emerald-600 px-5 py-2 font-semibold hover:bg-emerald-500"
            >
              ⬇ Download video (.mp4)
            </a>
          )}
          {wavUrl && (
            <a
              href={wavUrl}
              download="aidj-reel.wav"
              className="rounded-lg border border-zinc-600 px-5 py-2 font-semibold"
            >
              ⬇ Audio only (.wav)
            </a>
          )}
        </div>
      )}
      {mp4Url && (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video src={mp4Url} controls className="max-h-96 rounded-xl" />
      )}
    </main>
  );
}
