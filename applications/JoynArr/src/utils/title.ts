/**
 * Sanitize a show/episode name to Newznab scene-compatible format.
 * Replaces spaces with dots, converts German umlauts, removes special characters.
 */
export function sanitizeName(name: string): string {
  return name
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe')
    .replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss')
    .replace(/&/g, 'and')
    .replace(/[/:;,"''@#?$%^*+=!|<>,()\[\]{}\\]/g, '')
    .replace(/\s+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

/**
 * Format a standard season/episode title in scene format.
 * Output: ShowName.S01E03.EpisodeName.GERMAN.1080p.WEB.h264-JOYN
 */
export function formatTitle(
  showName: string,
  season: number,
  episode: number,
  episodeName: string,
  quality: string
): string {
  const show = sanitizeName(showName);
  const epName = sanitizeName(episodeName);
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  return `${show}.S${s}E${e}.${epName}.GERMAN.${quality}.WEB.h264-JOYN`;
}

/**
 * Format a date-based episode title (for daily shows).
 * Output: ShowName.2024.03.15.EpisodeName.GERMAN.1080p.WEB.h264-JOYN
 */
export function formatDateTitle(
  showName: string,
  date: string,
  episodeName: string,
  quality: string
): string {
  const show = sanitizeName(showName);
  const epName = sanitizeName(episodeName);
  // Normalise date separators to dots
  const normalizedDate = date.replace(/[-/]/g, '.');
  return `${show}.${normalizedDate}.${epName}.GERMAN.${quality}.WEB.h264-JOYN`;
}
