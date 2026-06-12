"use client";

import { useState } from "react";
import type { Track } from "@/lib/types";
import { searchTracks } from "@/lib/client/dj";

export function SearchPicker({
  placeholder = "Search a song…",
  onPick,
}: {
  placeholder?: string;
  onPick: (t: Track) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Track[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function go() {
    if (!q.trim()) return;
    setBusy(true);
    setError("");
    try {
      setResults(await searchTracks(q));
    } catch {
      setError("Search failed — is yt-dlp installed and reachable?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full">
      <div className="flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
          placeholder={placeholder}
          className="flex-1 rounded-lg bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm outline-none focus:border-fuchsia-500"
        />
        <button
          onClick={go}
          disabled={busy}
          className="rounded-lg bg-fuchsia-600 hover:bg-fuchsia-500 disabled:opacity-50 px-4 py-2 text-sm font-medium"
        >
          {busy ? "…" : "Search"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      {results.length > 0 && (
        <ul className="mt-2 max-h-72 overflow-y-auto rounded-lg border border-zinc-800 divide-y divide-zinc-800">
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
