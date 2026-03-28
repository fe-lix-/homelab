import { fetch } from 'undici';
import * as fs from 'fs';
import * as path from 'path';
import * as stream from 'stream';
import { QueueItem, moveToHistory, moveToHistoryFailed } from './queue.js';
import { convertToMkv, downloadHls } from './ffmpeg.js';
import { Semaphore } from '../utils/semaphore.js';
import { getPlaybackInfo } from '../services/joyn.js';
import { resolveDecryptionKeys } from '../services/widevine.js';
import { logActivity } from '../activity.js';

// Global concurrency limiter — at most 2 simultaneous downloads
export const downloadSemaphore = new Semaphore(2);

const DOWNLOAD_FOLDER_PATH_MAPPING =
  process.env.DOWNLOAD_FOLDER_PATH_MAPPING ?? '/downloads/completed';

function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Ensure the directory for a given file path exists.
 */
function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/**
 * Sanitize a filename by removing characters that are invalid on most filesystems.
 */
function safeFilename(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '_');
}

/**
 * Execute the full download pipeline for a queue item:
 *   acquire semaphore → HTTP download → FFmpeg conversion → history
 */
export async function startDownload(item: QueueItem): Promise<void> {
  await downloadSemaphore.acquire();

  const safeTitle = safeFilename(item.title);
  const categoryDir = path.join(process.cwd(), 'downloads', item.category);
  const mp4Path = path.join(categoryDir, `${safeTitle}.mp4`);
  const mkvPath = path.join(categoryDir, `${safeTitle}.mkv`);

  try {
    item.status = 'Downloading';
    logActivity('download_started', { title: item.title, nzo_id: item.nzo_id });
    console.log(`[${timestamp()}] [Download] Starting: "${item.title}"`);

    // --- Resolve joyn-vod:// URIs to real HLS stream URLs ---
    let resolvedUrl = item.videoUrl;
    let licenseUrl: string | undefined;
    let certificateUrl: string | undefined;
    if (item.videoUrl.startsWith('joyn-vod://')) {
      const videoId = item.videoUrl.slice('joyn-vod://'.length);
      console.log(`[${timestamp()}] [Download] Resolving playback URL for asset: ${videoId}`);
      const info = await getPlaybackInfo(videoId);
      if (!info) {
        throw new Error(`Failed to resolve playback URL for asset: ${videoId}`);
      }
      resolvedUrl = info.manifestUrl;
      licenseUrl = info.licenseUrl;
      certificateUrl = info.certificateUrl;
      console.log(`[${timestamp()}] [Download] Resolved to: ${resolvedUrl}`);
      if (licenseUrl) console.log(`[${timestamp()}] [Download] License URL: ${licenseUrl.slice(0, 80)}...`);
    }

    ensureDir(mkvPath);

    if (resolvedUrl.includes('.m3u8')) {
      // --- HLS path: ffmpeg downloads segments directly to MKV ---

      // Auto-fetch Widevine decryption keys if the stream is encrypted
      let decryptionKeys: string[] | undefined;
      if (licenseUrl && !process.env.JOYN_DECRYPTION_KEYS) {
        try {
          const keys = await resolveDecryptionKeys(resolvedUrl, licenseUrl);
          if (keys?.length) {
            decryptionKeys = keys.map(k => `${k.kid}:${k.key}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[${timestamp()}] [Download] Failed to auto-fetch Widevine keys: ${msg}`);
          console.warn(`[${timestamp()}] [Download] Attempting download without decryption (will likely fail)`);
        }
      }

      item.status = 'Extracting';
      await downloadHls(resolvedUrl, mkvPath, licenseUrl, certificateUrl, decryptionKeys);
      item.percentage = 100;
    } else {
      // --- Direct HTTP download path ---
      ensureDir(mp4Path);

      const response = await fetch(resolvedUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
        },
      });

      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} when fetching video URL`);
      }

      const contentLength = response.headers.get('content-length');
      item.totalBytes = contentLength ? parseInt(contentLength, 10) : 0;

      const fileStream = fs.createWriteStream(mp4Path);

      const readable = stream.Readable.fromWeb(
        response.body as Parameters<typeof stream.Readable.fromWeb>[0]
      );

      await new Promise<void>((resolve, reject) => {
        readable.on('data', (chunk: Buffer) => {
          item.downloadedBytes += chunk.length;
          if (item.totalBytes > 0) {
            item.percentage = Math.round((item.downloadedBytes / item.totalBytes) * 100);
          }
        });

        readable.on('error', reject);
        fileStream.on('error', reject);
        fileStream.on('finish', resolve);

        readable.pipe(fileStream);
      });

      if (item.totalBytes === 0) {
        item.totalBytes = item.downloadedBytes;
      }
      item.percentage = 100;

      console.log(
        `[${timestamp()}] [Download] Download complete: "${item.title}" ` +
        `(${(item.downloadedBytes / 1_048_576).toFixed(1)} MB)`
      );

      // --- FFmpeg conversion ---
      item.status = 'Extracting';
      await convertToMkv(mp4Path, mkvPath);

      fs.unlinkSync(mp4Path);
    }

    // --- Phase 3: Move to history ---
    // Compute external storage path using the folder path mapping
    const relativeMkv = path.relative(path.join(process.cwd(), 'downloads'), mkvPath);
    const externalPath = path.join(DOWNLOAD_FOLDER_PATH_MAPPING, relativeMkv);

    moveToHistory(item, externalPath);
    logActivity('download_completed', { title: item.title, nzo_id: item.nzo_id, path: externalPath });
    console.log(`[${timestamp()}] [Download] Completed: "${item.title}" → ${externalPath}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${timestamp()}] [Download] Failed: "${item.title}": ${message}`);

    // Clean up partial MP4 if it exists
    if (fs.existsSync(mp4Path)) {
      try { fs.unlinkSync(mp4Path); } catch { /* ignore cleanup errors */ }
    }

    logActivity('download_failed', { title: item.title, nzo_id: item.nzo_id, error: message });
    moveToHistoryFailed(item, message);
  } finally {
    downloadSemaphore.release();
  }
}
