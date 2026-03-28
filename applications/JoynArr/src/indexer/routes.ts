import { Router, Request, Response } from 'express';
import { buildCapsResponse } from './caps.js';
import { handleSearch, SearchParams } from './search.js';
import { buildFakeNzb } from './nzb.js';

const router = Router();

function timestamp(): string {
  return new Date().toISOString();
}

function buildBaseUrl(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) ?? req.protocol;
  const host = (req.headers['x-forwarded-host'] as string) ?? req.get('host') ?? 'localhost';
  return `${proto}://${host}`;
}

/**
 * GET /api
 * Dispatch on the `t` query parameter (Newznab standard).
 */
router.get('/api', async (req: Request, res: Response): Promise<void> => {
  const t = (req.query['t'] as string | undefined) ?? '';

  switch (t) {
    case 'caps': {
      console.log(`[${timestamp()}] [Indexer] Caps request`);
      res.set('Content-Type', 'application/xml; charset=utf-8');
      res.send(buildCapsResponse());
      return;
    }

    case 'tvsearch':
    case 'search':
    case 'movie': {
      const q = (req.query['q'] as string | undefined)?.trim() || undefined;
      const tvdbid = req.query['tvdbid'] ? parseInt(req.query['tvdbid'] as string, 10) : undefined;
      const season = req.query['season'] ? parseInt(req.query['season'] as string, 10) : undefined;
      const rawEp = req.query['ep'] as string | undefined;
      const limit = Math.min(parseInt((req.query['limit'] as string) ?? '50', 10), 100);
      const offset = parseInt((req.query['offset'] as string) ?? '0', 10);
      const cat = req.query['cat'] ? parseInt(req.query['cat'] as string, 10) : undefined;

      // ep can be a number or a MM/DD date string
      let ep: number | string | undefined;
      if (rawEp) {
        ep = rawEp.includes('/') ? rawEp : parseInt(rawEp, 10);
      }

      const params: SearchParams = {
        q,
        tvdbid: isNaN(tvdbid as number) ? undefined : tvdbid,
        season: isNaN(season as number) ? undefined : season,
        ep,
        limit: isNaN(limit) ? 50 : limit,
        offset: isNaN(offset) ? 0 : offset,
        cat,
      };

      console.log(`[${timestamp()}] [Indexer] Search request: t=${t}`, params);

      try {
        const baseUrl = buildBaseUrl(req);
        const xml = await handleSearch(params, baseUrl);
        res.set('Content-Type', 'application/rss+xml; charset=utf-8');
        res.send(xml);
      } catch (err) {
        console.error(`[${timestamp()}] [Indexer] Search error:`, err);
        res.status(500).set('Content-Type', 'application/xml').send(
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<error code="200" description="Internal server error"/>'
        );
      }
      return;
    }

    default: {
      res.status(400).set('Content-Type', 'application/xml').send(
        '<?xml version="1.0" encoding="UTF-8"?>' +
        `<error code="202" description="Unknown function: ${t}"/>`
      );
    }
  }
});

/**
 * GET /api/fake_nzb_download
 * Decode base64url params and return a fake NZB file.
 */
router.get('/api/fake_nzb_download', (req: Request, res: Response): void => {
  const encodedUrl = req.query['encodedUrl'] as string | undefined;
  const encodedTitle = req.query['encodedTitle'] as string | undefined;

  if (!encodedUrl || !encodedTitle) {
    res.status(400).send('Missing encodedUrl or encodedTitle');
    return;
  }

  try {
    const videoUrl = Buffer.from(encodedUrl, 'base64url').toString('utf-8');
    const title = Buffer.from(encodedTitle, 'base64url').toString('utf-8');

    console.log(`[${timestamp()}] [Indexer] NZB download requested: "${title}"`);

    const nzbContent = buildFakeNzb(title, videoUrl);

    res.set('Content-Type', 'application/x-nzb');
    res.set('Content-Disposition', `attachment; filename="${title}.nzb"`);
    res.send(nzbContent);
  } catch (err) {
    console.error(`[${timestamp()}] [Indexer] NZB generation error:`, err);
    res.status(500).send('Failed to generate NZB');
  }
});

export default router;
