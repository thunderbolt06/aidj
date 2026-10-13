/**
 * Song languages, shared by the settings UI and the library pickers. `code`
 * is what the browser stores, `iso` is what library entries are tagged with.
 */
export interface Language {
  code: string;
  label: string;
  iso: string;
}

/** Shown by default in the settings panel. */
export const TOP_LANGUAGES: Language[] = [
  { code: "english", label: "English", iso: "en" },
  { code: "hindi", label: "Hindi", iso: "hi" },
  { code: "spanish", label: "Spanish", iso: "es" },
  { code: "punjabi", label: "Punjabi", iso: "pa" },
  { code: "korean", label: "Korean", iso: "ko" },
];

/** Revealed behind "+ more". */
export const MORE_LANGUAGES: Language[] = [
  { code: "tamil", label: "Tamil", iso: "ta" },
  { code: "telugu", label: "Telugu", iso: "te" },
  { code: "bengali", label: "Bengali", iso: "bn" },
  { code: "marathi", label: "Marathi", iso: "mr" },
  { code: "gujarati", label: "Gujarati", iso: "gu" },
  { code: "kannada", label: "Kannada", iso: "kn" },
  { code: "malayalam", label: "Malayalam", iso: "ml" },
  { code: "bhojpuri", label: "Bhojpuri", iso: "bho" },
  { code: "urdu", label: "Urdu", iso: "ur" },
  { code: "french", label: "French", iso: "fr" },
  { code: "arabic", label: "Arabic", iso: "ar" },
  { code: "portuguese", label: "Portuguese", iso: "pt" },
  { code: "japanese", label: "Japanese", iso: "ja" },
  { code: "mandarin", label: "Mandarin", iso: "zh" },
  { code: "german", label: "German", iso: "de" },
];

export const ALL_LANGUAGES: Language[] = [...TOP_LANGUAGES, ...MORE_LANGUAGES];

/** Callers send codes ("hindi"), labels ("Hindi") or ISO codes ("hi"). */
export function toIsoCodes(languages: unknown): string[] {
  if (!Array.isArray(languages)) return [];
  const out = new Set<string>();
  for (const raw of languages) {
    const v = String(raw).trim().toLowerCase();
    const hit = ALL_LANGUAGES.find((l) => l.code === v || l.iso === v);
    if (hit) out.add(hit.iso);
  }
  return [...out];
}
