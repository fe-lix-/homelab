import { fetch } from 'undici';
import { getCached, setCached } from './cache.js';

const TVDB_API_BASE_URL = process.env.TVDB_API_BASE_URL ?? '';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0';

const TVDB_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export interface TvdbShow {
  name: string;
  germanName?: string;
}

function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Look up a show by its TVDB ID via the configured proxy.
 * Results are cached with a 12-hour TTL.
 * Returns null on any error.
 */
export async function getShowById(tvdbId: number): Promise<TvdbShow | null> {
  const cacheKey = `tvdb:show:${tvdbId}`;
  const cached = getCached<TvdbShow>(cacheKey);
  if (cached) {
    return cached;
  }

  if (!TVDB_API_BASE_URL) {
    console.warn(`[${timestamp()}] [TVDB] TVDB_API_BASE_URL is not set — cannot resolve show ${tvdbId}`);
    return null;
  }

  try {
    const url = `${TVDB_API_BASE_URL}/shows/${tvdbId}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      console.warn(`[${timestamp()}] [TVDB] Request for show ${tvdbId} failed: HTTP ${response.status}`);
      return null;
    }

    // The proxy response shape is assumed to contain at least { name, germanName? }.
    // Adjust field mapping if the actual proxy returns a different schema.
    const body = await response.json() as Record<string, unknown> & {
      translations?: Record<string, string>;
    };

    const show: TvdbShow = {
      name: (body['name'] as string | undefined) ?? String(tvdbId),
      germanName: (body['germanName'] as string | undefined) ??
                  body.translations?.['deu'] ??
                  undefined,
    };

    setCached<TvdbShow>(cacheKey, show, TVDB_TTL_MS);
    console.log(`[${timestamp()}] [TVDB] Resolved show ${tvdbId}: "${show.name}" / "${show.germanName ?? 'n/a'}"`);
    return show;
  } catch (err) {
    console.warn(`[${timestamp()}] [TVDB] Error fetching show ${tvdbId}:`, err);
    return null;
  }
}
