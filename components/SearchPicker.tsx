"use client";

import { useEffect, useRef, useState } from "react";
import type { Track } from "@/lib/types";
import { searchTracks } from "@/lib/client/dj";

/**
 * variant="card": inline block, results push content below (queue sheets,
 * setup screens). variant="bar": pill-shaped input for the top bar - results
 * float over the page on a solid panel and close on outside click.
 */
export function SearchPicker({
  placeholder = "Search a song…",
  onPick,
  variant = "card",
}: {
  placeholder?: string;
  onPick: (t: Track) => void;
  variant?: "card" | "bar";
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Track[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const isBar = variant === "bar";

  // bar floats over the page, so stale results must dismiss on outside click
  useEffect(() => {
    if (!isBar || results.length === 0) return;
    const close = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setResults([]);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [isBar, results.length]);

  async function go() {
    if (!q.trim()) return;
    setBusy(true);
    setError("");
    try {
      setResults(await searchTracks(q));
    } catch {
      setError("Search failed - is yt-dlp installed and reachable?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={rootRef} className={isBar ? "relative w-full" : "w-full"}>
      <div className="flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
          placeholder={placeholder}
          className={
            isBar
              ? "h-10 min-w-0 flex-1 rounded-full border border-zinc-700 bg-zinc-900/70 px-4 text-sm outline-none backdrop-blur focus:border-cyan-500"
              : "flex-1 rounded-lg bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm outline-none focus:border-cyan-500"
          }
        />
        <button
          onClick={go}
          disabled={busy}
          title="Search"
          className={
            isBar
              ? "flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900/70 text-sm text-zinc-300 backdrop-blur transition hover:border-cyan-600 hover:text-cyan-300 active:scale-95 disabled:opacity-50"
              : "rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 px-4 py-2 text-sm font-medium"
          }
        >
          {busy ? (
            "…"
          ) : isBar ? (
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          ) : (
            "Search"
          )}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      {results.length > 0 && (
        <ul
          className={`max-h-72 overflow-y-auto rounded-lg border border-zinc-800 divide-y divide-zinc-800 ${
            isBar
              ? "absolute inset-x-0 top-full z-50 mt-2 rounded-xl bg-zinc-950/95 shadow-xl backdrop-blur animate-[drop-in_150ms_ease]"
              : "mt-2"
          }`}
        >
          {results.map((t) => (
            <li key={t.id}>
              <button
                onClick={() => {
                  onPick(t);
                  setResults([]);
                }}
                className="flex w-full items-center gap-3 p-2 text-left hover:bg-zinc-900"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={t.thumbnail}
                  alt=""
                  className="h-10 w-16 rounded object-cover"
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm">{t.title}</span>
                  <span className="block truncate text-xs text-zinc-400">
                    {t.artist} · {Math.floor(t.duration / 60)}:
                    {String(t.duration % 60).padStart(2, "0")}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
