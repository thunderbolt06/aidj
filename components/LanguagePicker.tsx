"use client";

import { useEffect, useState } from "react";
import { ALL_LANGUAGES, useLanguagePrefs, type Language } from "@/lib/client/langPrefs";

// one request per page load, shared by every picker on screen
let available: Promise<Language[]> | null = null;
function loadAvailable(): Promise<Language[]> {
  available ??= fetch("/api/library")
    .then((r) => (r.ok ? r.json() : { languages: [] }))
    .then((stats: { languages?: { code: string }[] }) =>
      (stats.languages ?? [])
        .map((l) => ALL_LANGUAGES.find((known) => known.iso === l.code))
        .filter((l): l is Language => !!l)
    )
    .catch(() => {
      available = null; // let the next mount retry
      return [];
    });
  return available;
}

/**
 * Song-language switch: "All" or any mix of the languages the library
 * actually has songs in. Renders nothing while there is only one to pick.
 */
export function LanguagePicker({
  label,
  onChange,
  className = "",
}: {
  label?: string;
  /** Fires after the selection is saved (e.g. to refresh picks mid-set). */
  onChange?: () => void;
  className?: string;
}) {
  const { selected, toggle, clear } = useLanguagePrefs();
  const [languages, setLanguages] = useState<Language[]>([]);

  useEffect(() => {
    let alive = true;
    loadAvailable().then((l) => alive && setLanguages(l));
    return () => {
      alive = false;
    };
  }, []);

  if (languages.length < 2) return null;
  const active = selected.filter((c) => languages.some((l) => l.code === c));
  const pill = (on: boolean) =>
    `rounded-full border px-3 py-1 text-xs transition active:scale-95 ${
      on
        ? "border-cyan-500 bg-cyan-950/60 text-cyan-300"
        : "border-zinc-700 bg-zinc-900/70 text-zinc-400 hover:border-cyan-600 hover:text-cyan-300"
    }`;

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      {label && <span className="mr-1 text-xs text-zinc-500">{label}</span>}
      <button
        onClick={() => {
          clear();
          onChange?.();
        }}
        aria-pressed={active.length === 0}
        className={pill(active.length === 0)}
      >
        All
      </button>
      {languages.map((l) => (
        <button
          key={l.code}
          onClick={() => {
            toggle(l.code);
            onChange?.();
          }}
          aria-pressed={active.includes(l.code)}
          className={pill(active.includes(l.code))}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}
