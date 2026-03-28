/**
 * Fetches the Joyn x-api-key from the public Next.js JS bundle.
 *
 * Usage:
 *   npx ts-node scripts/fetch-joyn-api-key.ts           # normal
 *   npx ts-node scripts/fetch-joyn-api-key.ts --debug   # show context around matches
 *
 * Exits with code 0 and prints the key on stdout.
 * Exits with code 1 if the key could not be found.
 */

import { fetch } from 'undici';

const JOYN_HOME = 'https://www.joyn.de';
const DEBUG = process.argv.includes('--debug');

// Known key shape: 32-char lowercase hex string
const HEX32 = /([0-9a-f]{32})/;

// The key is stored in the Next.js public env config as "API_GW_API_KEY":"<value>"
// and referenced at runtime via (0,l.$)("API_GW_API_KEY") in the headers block.
const API_KEY_PATTERN = /API_GW_API_KEY[^"']*["']([0-9a-f]{32})["']/;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
      Accept: 'text/html,application/xhtml+xml,*/*',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

function extractChunkUrls(html: string): string[] {
  const urls = new Set<string>();

  for (const m of html.matchAll(/src="(\/_next\/static\/chunks\/[^"]+\.js)"/g)) {
    urls.add(`${JOYN_HOME}${m[1]}`);
  }

  for (const m of html.matchAll(/\/_next\/static\/[^"' ]+\.js/g)) {
    urls.add(`${JOYN_HOME}${m[0]}`);
  }

  return [...urls];
}

/** Returns 100 chars of context around each occurrence of `needle` in `text`. */
function showContext(text: string, needle: string): void {
  let pos = 0;
  let found = 0;
  while ((pos = text.indexOf(needle, pos)) !== -1) {
    const start = Math.max(0, pos - 40);
    const end = Math.min(text.length, pos + needle.length + 60);
    console.error(`  …${text.slice(start, end).replace(/\n/g, '\\n')}…`);
    pos += needle.length;
    if (++found >= 5) { console.error('  (truncated)'); break; }
  }
}

async function scanChunk(url: string): Promise<string | null> {
  let text: string;
  try {
    text = await fetchText(url);
  } catch {
    return null;
  }

  const m = text.match(API_KEY_PATTERN);
  if (m) return m[1];

  if (DEBUG && text.includes('API_GW_API_KEY')) {
    console.error(`[debug] "API_GW_API_KEY" found in ${url.split('/').pop()}`);
    showContext(text, 'API_GW_API_KEY');
  }

  return null;
}

async function main() {
  if (DEBUG) console.error('[fetch-joyn-api-key] Fetching Joyn homepage…');
  const html = await fetchText(JOYN_HOME);

  const chunkUrls = extractChunkUrls(html);
  if (DEBUG) console.error(`[fetch-joyn-api-key] Found ${chunkUrls.length} JS chunk(s) to scan`);

  if (chunkUrls.length === 0) {
    console.error('error: no JS chunks found — Joyn may have changed their HTML structure');
    process.exit(1);
  }

  const results = await Promise.allSettled(chunkUrls.map(scanChunk));

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      console.log(result.value);
      process.exit(0);
    }
  }

  console.error('error: API key not found in any chunk — pattern may need updating (run with --debug)');
  process.exit(1);
}

main().catch(err => {
  console.error('[fetch-joyn-api-key] Fatal:', err);
  process.exit(1);
});
