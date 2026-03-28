import { searchJoyn, getLatestEpisodes, JoynEpisode } from '../services/joyn.js';
import { getShowById } from '../services/tvdb.js';
import { getCached, setCached } from '../services/cache.js';
import { formatTitle, formatDateTitle } from '../utils/title.js';
import { buildRssXml, RssItem } from '../utils/xml.js';
import { encodedNzbDownloadUrl } from './nzb.js';

export interface SearchParams {
  q?: string;
  tvdbid?: number;
  season?: number;
  /** Episode number, or "MM/DD" date string */
  ep?: number | string;
  limit: number;
  offset: number;
  cat?: number;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

const SKIP_TITLE_KEYWORDS = [
  'Trailer',
  'Audiodeskription',
  'Hörfassung',
  '(klare Sprache)',
  '(Gebärdensprache)',
  'Outtakes:',
];

function shouldSkip(episode: JoynEpisode): boolean {
  if (!episode.streamUrl?.startsWith('joyn-vod://')) return true;
  for (const keyword of SKIP_TITLE_KEYWORDS) {
    if (episode.title.includes(keyword) || episode.showTitle.includes(keyword)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Quality variants
// ---------------------------------------------------------------------------

interface QualityVariant {
  label: string;       // e.g. "1080p"
  sizeMultiplier: number;
  category: number;    // Newznab category id
}

const QUALITY_VARIANTS: QualityVariant[] = [
  { label: '1080p', sizeMultiplier: 1.6, category: 5040 },
  { label: '720p',  sizeMultiplier: 1.0, category: 5040 },
  { label: '480p',  sizeMultiplier: 0.4, category: 5030 },
];

/** Estimate file size in bytes from duration using 3 Mbps average bitrate. */
function estimateBytes(duration: number): number {
  return Math.round((duration * 3_000_000) / 8);
}

// ---------------------------------------------------------------------------
// RSS item building
// ---------------------------------------------------------------------------

function episodeToRssItems(episode: JoynEpisode, baseUrl: string): RssItem[] {
  const duration = episode.duration ?? 0;
  const baseBytes = duration > 0 ? estimateBytes(duration) : 500_000_000; // 500 MB fallback
  const videoUrl = episode.streamUrl ?? '';
  const pubDate = episode.airDate
    ? new Date(episode.airDate).toUTCString()
    : new Date().toUTCString();

  const items: RssItem[] = [];

  for (const variant of QUALITY_VARIANTS) {
    let title: string;

    if (episode.season != null && episode.episode != null) {
      title = formatTitle(
        episode.showTitle,
        episode.season,
        episode.episode,
        episode.title,
        variant.label,
      );
    } else if (episode.airDate) {
      // Daily show — use date-based title
      const datePart = episode.airDate.slice(0, 10); // YYYY-MM-DD
      title = formatDateTitle(episode.showTitle, datePart, episode.title, variant.label);
    } else {
      title = formatTitle(episode.showTitle, 0, 0, episode.title, variant.label);
    }

    const sizeBytes = Math.round(baseBytes * variant.sizeMultiplier);
    const guid = `joyn-${episode.id}-${variant.label}`;
    const downloadUrl = encodedNzbDownloadUrl(baseUrl, videoUrl, title);

    const seasonAttr = episode.season != null ? String(episode.season) : undefined;

    items.push({
      title,
      guid,
      link: downloadUrl,
      comments: `https://www.joyn.de`,
      pubDate,
      category: 'TV > HD',
      description: episode.description ?? episode.title,
      enclosureUrl: downloadUrl,
      enclosureLength: sizeBytes,
      newznabCategory: variant.category,
      season: seasonAttr,
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Episode filtering by season / episode number or date
// ---------------------------------------------------------------------------

function matchesSeasonEp(episode: JoynEpisode, season?: number, ep?: number | string): boolean {
  if (season != null && episode.season !== season) return false;

  if (ep != null) {
    if (typeof ep === 'string' && ep.includes('/')) {
      // Date format MM/DD — compare against airDate
      if (!episode.airDate) return false;
      const [mm, dd] = ep.split('/').map(Number);
      const air = new Date(episode.airDate);
      if (air.getMonth() + 1 !== mm || air.getDate() !== dd) return false;
    } else {
      const epNum = typeof ep === 'string' ? parseInt(ep, 10) : ep;
      if (episode.episode !== epNum) return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleSearch(params: SearchParams, baseUrl: string): Promise<string> {
  const { q, tvdbid, season, ep, limit, offset } = params;

  // --- TVDB-based lookup ---
  if (tvdbid != null) {
    const cacheKey = `tvdb:${tvdbid}:${season ?? ''}:${ep ?? ''}:${limit}:${offset}`;
    const cached = getCached<string>(cacheKey);
    if (cached) return cached;

    const show = await getShowById(tvdbid);
    const searchName = show?.germanName ?? show?.name ?? '';

    let episodes: JoynEpisode[] = [];
    if (searchName) {
      episodes = await searchJoyn(searchName, season);
    }

    // Filter to matching season/episode
    const filtered = episodes.filter(e => !shouldSkip(e) && matchesSeasonEp(e, season, ep));
    const page = filtered.slice(offset, offset + limit);

    const items = page.flatMap(e => episodeToRssItems(e, baseUrl));
    const xml = buildRssXml(items, filtered.length * QUALITY_VARIANTS.length, offset);

    setCached<string>(cacheKey, xml);
    return xml;
  }

  // --- Free-text search ---
  if (q && q.trim().length > 0) {
    const cacheKey = `joyn:search:${q}:${season ?? ''}`;
    const cached = getCached<string>(cacheKey);
    if (cached) return cached;

    const episodes = await searchJoyn(q, season);
    const filtered = episodes.filter(e => !shouldSkip(e));
    const page = filtered.slice(offset, offset + limit);

    const items = page.flatMap(e => episodeToRssItems(e, baseUrl));
    const xml = buildRssXml(items, filtered.length * QUALITY_VARIANTS.length, offset);

    setCached<string>(cacheKey, xml);
    return xml;
  }

  // --- RSS sync: no search params, return latest ---
  {
    const cacheKey = `rss:latest:${limit}:${offset}`;
    const cached = getCached<string>(cacheKey);
    if (cached) return cached;

    const TTL_20_MIN = 20 * 60 * 1000;
    const episodes = await getLatestEpisodes(limit + offset);
    const filtered = episodes.filter(e => !shouldSkip(e));
    const page = filtered.slice(offset, offset + limit);

    const items = page.flatMap(e => episodeToRssItems(e, baseUrl));
    const xml = buildRssXml(items, filtered.length * QUALITY_VARIANTS.length, offset);

    setCached<string>(cacheKey, xml, TTL_20_MIN);
    return xml;
  }
}
