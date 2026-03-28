import { Router, Request, Response } from 'express';
import multer from 'multer';
import {
  downloadQueue,
  downloadHistory,
  createQueueItem,
  deleteHistoryItem,
  QueueItem,
} from './queue.js';
import { startDownload } from './download.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

const COMPLETE_DIR =
  process.env.DOWNLOAD_FOLDER_PATH_MAPPING ?? '/downloads/completed';

function timestamp(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format seconds as HH:MM:SS */
function formatTimeLeft(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Estimated download speed assumed for time-remaining calculation: 5 MB/s */
const ASSUMED_SPEED_BPS = 5 * 1_048_576;

function queueItemToSlot(item: QueueItem): Record<string, unknown> {
  const remainingBytes = Math.max(0, item.totalBytes - item.downloadedBytes);
  const timeLeftSec = remainingBytes / ASSUMED_SPEED_BPS;
  const mbTotal = (item.totalBytes / 1_048_576).toFixed(2);
  const mbLeft = (remainingBytes / 1_048_576).toFixed(2);

  return {
    nzo_id: item.nzo_id,
    filename: item.title,
    category: item.category,
    status: item.status,
    percentage: String(item.percentage),
    mb: mbTotal,
    mbleft: mbLeft,
    timeleft: formatTimeLeft(timeLeftSec),
    index: 0,
    priority: 'Normal',
    script: 'None',
    unpackopts: '3',
  };
}

/**
 * Parse a fake NZB XML buffer and extract the embedded video URL and title.
 * The NZB contains XML comments of the form:
 *   <!-- joyn-url:<url> -->
 *   <!-- joyn-title:<title> -->
 */
function parseNzb(nzbBuffer: Buffer): { videoUrl: string; title: string } | null {
  const content = nzbBuffer.toString('utf-8');

  const urlMatch = content.match(/<!--\s*joyn-url:(.+?)\s*-->/);
  const titleMatch = content.match(/<!--\s*joyn-title:(.+?)\s*-->/);

  if (!urlMatch || !titleMatch) return null;

  return {
    videoUrl: urlMatch[1].trim(),
    title: titleMatch[1].trim(),
  };
}

// ---------------------------------------------------------------------------
// Routes — all under /download/api?mode=...
// ---------------------------------------------------------------------------

router.get('/download/api', async (req: Request, res: Response): Promise<void> => {
  const mode = (req.query['mode'] as string | undefined) ?? '';

  switch (mode) {
    case 'version': {
      res.json({ version: '4.3.3' });
      return;
    }

    case 'get_config': {
      res.json({
        config: {
          misc: {
            complete_dir: COMPLETE_DIR,
            download_dir: './downloads/incomplete',
          },
          categories: [
            { name: 'tv', dir: 'tv', newzbin: '', order: 0, priority: 0, script: 'Default', pp: '' },
            { name: 'movie', dir: 'movie', newzbin: '', order: 1, priority: 0, script: 'Default', pp: '' },
          ],
        },
      });
      return;
    }

    case 'queue': {
      const slots = Array.from(downloadQueue.values()).map(queueItemToSlot);
      const totalMb = slots.reduce((sum, s) => sum + parseFloat(s['mb'] as string), 0);
      const totalMbLeft = slots.reduce((sum, s) => sum + parseFloat(s['mbleft'] as string), 0);

      res.json({
        queue: {
          status: slots.length > 0 ? 'Downloading' : 'Idle',
          speed: '0 B/s',
          speedlimit: '',
          speedlimit_abs: '',
          paused: false,
          noofslots_total: slots.length,
          noofslots: slots.length,
          limit: 20,
          start: 0,
          timeleft: '0:00:00',
          eta: '',
          mb: totalMb.toFixed(2),
          mbleft: totalMbLeft.toFixed(2),
          mbdiscarded: '0.00',
          have_warnings: '0',
          pause_int: '0',
          diskspacetotal1: '0',
          diskspacetotal2: '0',
          diskspace1: '0',
          diskspace2: '0',
          slots,
        },
      });
      return;
    }

    case 'history': {
      // Handle delete operation: ?mode=history&name=delete&value=<nzo_id>
      const name = req.query['name'] as string | undefined;
      const value = req.query['value'] as string | undefined;

      if (name === 'delete' && value) {
        if (value === 'all') {
          downloadHistory.length = 0;
          console.log(`[${timestamp()}] [Downloader] Cleared all history`);
        } else {
          deleteHistoryItem(value);
          console.log(`[${timestamp()}] [Downloader] Deleted history item: ${value}`);
        }
        res.json({ status: true });
        return;
      }

      res.json({
        history: {
          noofslots: downloadHistory.length,
          slots: downloadHistory,
          ppslots: 0,
          month_size: '0 B',
          week_size: '0 B',
          day_size: '0 B',
          total_size: '0 B',
        },
      });
      return;
    }

    default: {
      res.status(400).json({ error: `Unknown mode: ${mode}` });
    }
  }
});

/**
 * POST /download/api?mode=addfile
 * Accepts a multipart upload with the NZB file. Parses it and enqueues a download.
 */
router.post(
  '/download/api',
  upload.any(),
  async (req: Request, res: Response): Promise<void> => {
    const mode = (req.query['mode'] as string | undefined) ?? '';

    if (mode !== 'addfile') {
      res.status(400).json({ error: `Unexpected POST mode: ${mode}` });
      return;
    }

    const files = req.files as Express.Multer.File[] | undefined;
    const file = files?.[0];
    if (!file) {
      res.status(400).json({ error: 'No NZB file uploaded' });
      return;
    }

    const parsed = parseNzb(file.buffer);
    if (!parsed) {
      console.error(`[${timestamp()}] [Downloader] Failed to parse NZB: ${file.originalname}`);
      res.status(422).json({ error: 'Could not parse NZB — missing joyn-url or joyn-title comments' });
      return;
    }

    const category = (req.body['cat'] as string | undefined) ?? 'tv';
    const item = createQueueItem(parsed.title, parsed.videoUrl, category);

    console.log(`[${timestamp()}] [Downloader] Queued: "${parsed.title}" (${item.nzo_id})`);

    // Fire and forget — do not await so the HTTP response is immediate
    startDownload(item).catch(err => {
      console.error(`[${timestamp()}] [Downloader] Unhandled error in startDownload:`, err);
    });

    res.json({
      status: true,
      nzo_ids: [item.nzo_id],
    });
  }
);

/**
 * POST /download/retry/:nzo_id
 * Re-queue a failed history item for download.
 */
router.post('/download/retry/:nzo_id', (req: Request, res: Response): void => {
  const { nzo_id } = req.params;
  const historyItem = downloadHistory.find(h => h.nzo_id === nzo_id);

  if (!historyItem) {
    res.status(404).json({ error: 'History item not found' });
    return;
  }
  if (!historyItem.videoUrl) {
    res.status(422).json({ error: 'No video URL stored for this item — cannot retry' });
    return;
  }

  deleteHistoryItem(nzo_id);
  const item = createQueueItem(historyItem.name, historyItem.videoUrl, historyItem.category);

  console.log(`[${timestamp()}] [Downloader] Retrying: "${item.title}" (${item.nzo_id})`);

  startDownload(item).catch(err => {
    console.error(`[${timestamp()}] [Downloader] Unhandled error in startDownload:`, err);
  });

  res.json({ status: true, nzo_ids: [item.nzo_id] });
});

export default router;
