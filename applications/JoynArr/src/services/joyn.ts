import { fetch, ProxyAgent, Agent, buildConnector } from 'undici';
import { SocksClient } from 'socks';
import * as tls from 'tls';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Auth proxy helpers (lazy — reads BRIGHTDATA_PROXY_URL at call time)
// Supports both HTTP proxies (http://...) and SOCKS5 proxies (socks5://...)
// ---------------------------------------------------------------------------

function parseSocksUrl(proxyUrl: string): { host: string; port: number; username: string; password: string } {
  const withoutScheme = proxyUrl.replace(/^socks5?:\/\//, '');
  const lastAt = withoutScheme.lastIndexOf('@');
  const hostPort = withoutScheme.slice(lastAt + 1);
  const userInfo = withoutScheme.slice(0, lastAt);
  const portIdx = hostPort.lastIndexOf(':');
  const host = hostPort.slice(0, portIdx);
  const port = parseInt(hostPort.slice(portIdx + 1), 10);
  const colonIdx = userInfo.indexOf(':');
  const username = userInfo.slice(0, colonIdx);
  const password = userInfo.slice(colonIdx + 1);
  return { host, port, username, password };
}

function createSocksAgent(proxyUrl: string): Agent {
  const { host: proxyHost, port: proxyPort, username, password } = parseSocksUrl(proxyUrl);
  const connector: buildConnector.connector = (options, callback) => {
    const destPort = parseInt(options.port, 10) || (options.protocol === 'https:' ? 443 : 80);
    SocksClient.createConnection({
      proxy: { host: proxyHost, port: proxyPort, type: 5, userId: username, password },
      command: 'connect',
      destination: { host: options.hostname, port: destPort },
    }).then(({ socket }) => {
      if (options.protocol !== 'https:') {
        callback(null, socket);
        return;
      }
      const tlsSocket = tls.connect({
        socket,
        servername: options.servername ?? options.hostname,
      });
      tlsSocket.once('secureConnect', () => callback(null, tlsSocket));
      tlsSocket.once('error', (err) => callback(err, null));
    }).catch(err => callback(err, null));
  };
  return new Agent({ connect: connector });
}

/** Returns a dispatcher for auth calls, or undefined if no proxy is configured. */
function getAuthProxy(): ProxyAgent | Agent | undefined {
  const proxyUrl = process.env.BRIGHTDATA_PROXY_URL;
  if (!proxyUrl) return undefined;
  return proxyUrl.startsWith('socks') ? createSocksAgent(proxyUrl) : new ProxyAgent(proxyUrl);
}

const JOYN_GRAPHQL_URL =
  process.env.JOYN_API_BASE_URL
    ? `${process.env.JOYN_API_BASE_URL}/graphql`
    : 'https://api.joyn.de/graphql';

const JOYN_API_KEY = process.env.JOYN_API_KEY ?? '4f0fd9f18abbe3cf0e87fdb556bc39c8';
const JOYN_PLATFORM = 'web';

const JOYN_AUTH_URL = 'https://auth.joyn.de/auth/anonymous';
const JOYN_ENTITLEMENT_URL = 'https://entitlement.p7s1.io/api/user/entitlement-token';
const JOYN_PLAYBACK_URL = 'https://api.vod-prd.s.joyn.de/v1';
const JOYN_CLIENT_VERSION = '5.1457.0';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0';

export interface JoynEpisode {
  id: string;
  title: string;
  showTitle: string;
  season?: number;
  episode?: number;
  airDate?: string;
  description?: string;
  streamUrl?: string;
  thumbnailUrl?: string;
  duration?: number; // seconds
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ApiEpisode {
  id: string;
  title: string;
  number?: number;
  description?: string;
  airdate?: number; // Unix timestamp (seconds)
  url?: string;
  images?: Array<{ url: string; type: string }>;
  video?: { id: string; type: string; duration?: number; quality?: string };
  season?: { id: string; number?: number; title?: string };
  series?: { id: string; title: string };
}

interface ApiSeries {
  id: string;
  title: string;
  episodes?: ApiEpisode[];
}

interface SearchData {
  search: {
    totalCount: number;
    results: Array<{ __typename: string; id: string; title?: string; episodes?: ApiEpisode[] }>;
  };
}

interface SeriesData {
  series: ApiSeries;
}

interface LandingPageData {
  page: {
    blocks?: Array<{
      __typename: string;
      headline?: string;
      assets?: Array<{ __typename: string; id: string; title?: string }>;
    }>;
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function timestamp(): string {
  return new Date().toISOString();
}

async function graphqlRequest<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
  try {
    const response = await fetch(JOYN_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        'x-api-key': JOYN_API_KEY,
        'Joyn-Platform': JOYN_PLATFORM,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      console.warn(`[${timestamp()}] [Joyn] GraphQL request failed: HTTP ${response.status}`);
      return null;
    }

    const data = await response.json() as { data?: T; errors?: unknown[] };
    if (data.errors?.length) {
      console.warn(`[${timestamp()}] [Joyn] GraphQL errors:`, JSON.stringify(data.errors));
    }
    return data.data ?? null;
  } catch (err) {
    console.warn(`[${timestamp()}] [Joyn] Request error:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Playback URL resolution (3-step flow)
// ---------------------------------------------------------------------------

async function getAnonToken(): Promise<string | null> {
  const deviceId = randomUUID();
  try {
    const response = await fetch(JOYN_AUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'Origin': 'https://www.joyn.de',
      },
      body: JSON.stringify({ client_id: deviceId, client_name: 'web', anon_device_id: deviceId }),
      dispatcher: getAuthProxy(),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.warn(`[${timestamp()}] [Joyn] getAnonToken HTTP ${response.status}: ${body}`);
      return null;
    }
    const data = await response.json() as { access_token?: string };
    return data.access_token ?? null;
  } catch (err) {
    console.warn(`[${timestamp()}] [Joyn] getAnonToken error:`, err);
    return null;
  }
}

async function getEntitlementToken(videoId: string, accessToken: string): Promise<string | null> {
  try {
    const response = await fetch(JOYN_ENTITLEMENT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'Authorization': `Bearer ${accessToken}`,
        'Joyn-Client-Version': JOYN_CLIENT_VERSION,
        'Joyn-Platform': JOYN_PLATFORM,
        'Origin': 'https://www.joyn.de',
      },
      body: JSON.stringify({ content_id: videoId, content_type: 'VOD' }),
      dispatcher: getAuthProxy(),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.warn(`[${timestamp()}] [Joyn] getEntitlementToken HTTP ${response.status}: ${body}`);
      return null;
    }
    const data = await response.json() as { entitlement_token?: string };
    return data.entitlement_token ?? null;
  } catch (err) {
    console.warn(`[${timestamp()}] [Joyn] getEntitlementToken error:`, err);
    return null;
  }
}

export interface PlaybackInfo {
  manifestUrl: string;
  licenseUrl?: string;
  certificateUrl?: string;
}

export async function getPlaybackInfo(videoId: string): Promise<PlaybackInfo | null> {
  const anonToken = await getAnonToken();
  if (!anonToken) return null;

  const entitlementToken = await getEntitlementToken(videoId, anonToken);
  if (!entitlementToken) return null;

  try {
    const response = await fetch(`${JOYN_PLAYBACK_URL}/asset/${videoId}/playlist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'Authorization': `Bearer ${entitlementToken}`,
        'Origin': 'https://www.joyn.de',
      },
      body: JSON.stringify({
        platform: 'browser',
        streamingFormat: 'hls',
        protectionSystem: 'widevine',
        enableDolbyAudio: false,
        enableMultiAudio: true,
        enableSubtitles: true,
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.warn(`[${timestamp()}] [Joyn] getPlaylist HTTP ${response.status}: ${body}`);
      return null;
    }
    const data = await response.json() as { manifestUrl?: string; licenseUrl?: string; certificateUrl?: string };
    if (!data.manifestUrl) return null;
    return { manifestUrl: data.manifestUrl, licenseUrl: data.licenseUrl, certificateUrl: data.certificateUrl };
  } catch (err) {
    console.warn(`[${timestamp()}] [Joyn] getPlaylist error:`, err);
    return null;
  }
}

/** @deprecated Use getPlaybackInfo instead */
export async function getPlaybackUrl(videoId: string): Promise<string | null> {
  return (await getPlaybackInfo(videoId))?.manifestUrl ?? null;
}

function mapEpisode(ep: ApiEpisode, showTitle: string): JoynEpisode {
  return {
    id: ep.id,
    title: ep.title,
    showTitle,
    season: ep.season?.number,
    episode: ep.number,
    airDate: ep.airdate != null ? new Date(ep.airdate * 1000).toISOString() : undefined,
    description: ep.description ?? undefined,
    streamUrl: ep.video?.id ? `joyn-vod://${ep.video.id}` : ep.url,
    thumbnailUrl: ep.images?.find(i => i.type === 'PRIMARY')?.url,
    duration: ep.video?.duration,
  };
}

// ---------------------------------------------------------------------------
// GraphQL queries
// ---------------------------------------------------------------------------

const EPISODE_FIELDS = `
  id title number description airdate url
  images { url type }
  video { id type duration quality }
  season { id number title }
`;

const GQL_SEARCH_SERIES = `
  query SearchSeries($term: String!, $first: Int) {
    search(term: $term, type: SERIES, first: $first) {
      results {
        __typename
        ... on Series {
          id
          title
          episodes {
            ${EPISODE_FIELDS}
          }
        }
      }
    }
  }
`;

const GQL_LANDING_PAGE = `
  query LatestLanding {
    page(path: "/") {
      ... on LandingPage {
        blocks {
          __typename
          ... on StandardLane {
            headline
            assets {
              __typename
              id
              ... on Series { title }
            }
          }
        }
      }
    }
  }
`;

const GQL_SERIES_EPISODES = `
  query SeriesEpisodes($id: ID!) {
    series(id: $id) {
      id title
      episodes {
        ${EPISODE_FIELDS}
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search Joyn for episodes matching the query, optionally filtered by season.
 */
export async function searchJoyn(query: string, season?: number): Promise<JoynEpisode[]> {
  console.log(`[${timestamp()}] [Joyn] searchJoyn query="${query}" season=${season ?? 'any'}`);

  const data = await graphqlRequest<SearchData>(GQL_SEARCH_SERIES, { term: query, first: 50 });
  if (!data) return [];

  const episodes: JoynEpisode[] = [];
  for (const result of data.search.results) {
    if (result.__typename !== 'Series' || !result.episodes || !result.title) continue;
    for (const ep of result.episodes) {
      if (season != null && ep.season?.number !== season) continue;
      episodes.push(mapEpisode(ep, result.title));
    }
  }

  console.log(`[${timestamp()}] [Joyn] searchJoyn returned ${episodes.length} episodes`);
  return episodes;
}

/**
 * Fetch the most recently published episodes from Joyn via the "Neu auf Joyn" editorial lane.
 */
export async function getLatestEpisodes(limit = 50): Promise<JoynEpisode[]> {
  console.log(`[${timestamp()}] [Joyn] getLatestEpisodes limit=${limit}`);

  const landingData = await graphqlRequest<LandingPageData>(GQL_LANDING_PAGE, {});
  if (!landingData?.page?.blocks) {
    console.warn(`[${timestamp()}] [Joyn] getLatestEpisodes: landing page returned no blocks`);
    return [];
  }

  const neuLane = landingData.page.blocks.find(
    b => b.__typename === 'StandardLane' && b.headline?.toLowerCase().includes('neu')
  );

  if (!neuLane?.assets) {
    console.warn(`[${timestamp()}] [Joyn] getLatestEpisodes: "Neu auf Joyn" lane not found`);
    return [];
  }

  const seriesIds = neuLane.assets
    .filter(a => a.__typename === 'Series')
    .map(a => a.id);

  const seriesResults = await Promise.all(
    seriesIds.map(id => graphqlRequest<SeriesData>(GQL_SERIES_EPISODES, { id }))
  );

  const allEpisodes: JoynEpisode[] = [];
  for (const result of seriesResults) {
    if (!result?.series?.episodes) continue;
    const { series } = result;
    for (const ep of series.episodes!) {
      allEpisodes.push(mapEpisode(ep, series.title));
    }
  }

  allEpisodes.sort((a, b) => {
    const ta = a.airDate ? new Date(a.airDate).getTime() : 0;
    const tb = b.airDate ? new Date(b.airDate).getTime() : 0;
    return tb - ta;
  });

  const limited = allEpisodes.slice(0, limit);
  console.log(`[${timestamp()}] [Joyn] getLatestEpisodes returned ${limited.length} episodes`);
  return limited;
}
