/**
 * Which crate of songs a listener plays from. "open" is the Creative-Commons
 * crate (Free Music Archive and the like), "commercial" the well-known chart
 * songs, "both" mixes them. Shared by the settings UI and the library pickers.
 */
export type SongSource = "open" | "commercial" | "both";

export interface SongSourceOption {
  code: SongSource;
  label: string;
  hint: string;
}

export const SONG_SOURCES: SongSourceOption[] = [
  { code: "commercial", label: "Hits", hint: "well-known commercial songs" },
  { code: "open", label: "Open licence", hint: "Creative Commons music" },
  { code: "both", label: "Both", hint: "a mix of the two" },
];

/** What a request that says nothing gets: the crate listeners knew before this setting. */
export const DEFAULT_SONG_SOURCE: SongSource = "commercial";

/** Library `source` values that are openly licensed; everything else is a commercial song. */
const OPEN_SOURCES = new Set(["fma", "freesound"]);

export function isOpenSource(source: string): boolean {
  return OPEN_SOURCES.has(source);
}

export function parseSongSource(value: unknown): SongSource {
  return value === "open" || value === "commercial" || value === "both"
    ? value
    : DEFAULT_SONG_SOURCE;
}
