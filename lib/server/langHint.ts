/** User-facing instruction line for song-selection prompts, when languages are pinned. */
export function languageHint(languages?: string[]): string {
  if (!languages?.length) return "";
  return `\nSong language preference: only pick songs primarily sung in ${languages.join(
    ", "
  )}. If a genuinely fitting song doesn't exist in these languages for part of the request, prefer an instrumental or the closest available match rather than breaking language.`;
}
