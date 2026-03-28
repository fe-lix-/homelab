import express from 'express';
import { ensureFfmpeg } from './downloader/ffmpeg.js';
import indexerRouter from './indexer/routes.js';
import downloaderRouter from './downloader/routes.js';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const INDEXER_PORT = parseInt(process.env['INDEXER_PORT'] ?? '5008', 10);
const DOWNLOADER_PORT = parseInt(process.env['DOWNLOADER_PORT'] ?? '5007', 10);

function timestamp(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Indexer server
// ---------------------------------------------------------------------------

function createIndexerApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use('/', indexerRouter);

  // Health check
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'indexer' }));

  return app;
}

// ---------------------------------------------------------------------------
// Downloader server
// ---------------------------------------------------------------------------

function createDownloaderApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use('/', downloaderRouter);

  // Health check
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'downloader' }));

  return app;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`[${timestamp()}] [App] JoynArr starting...`);

  // Ensure FFmpeg is available before accepting download requests
  try {
    const ffmpegPath = await ensureFfmpeg();
    console.log(`[${timestamp()}] [App] FFmpeg ready at: ${ffmpegPath}`);
  } catch (err) {
    console.error(`[${timestamp()}] [App] FFmpeg setup failed:`, err);
    console.error(`[${timestamp()}] [App] Downloads will fail until FFmpeg is available.`);
    // Do not exit — the indexer can still serve search results without FFmpeg
  }

  // Start indexer
  const indexerApp = createIndexerApp();
  await new Promise<void>((resolve, reject) => {
    indexerApp.listen(INDEXER_PORT, '0.0.0.0', () => {
      console.log(`[${timestamp()}] [App] Indexer (Newznab)  listening on port ${INDEXER_PORT}`);
      resolve();
    }).on('error', reject);
  });

  // Start downloader
  const downloaderApp = createDownloaderApp();
  await new Promise<void>((resolve, reject) => {
    downloaderApp.listen(DOWNLOADER_PORT, '0.0.0.0', () => {
      console.log(`[${timestamp()}] [App] Downloader (SABnzbd) listening on port ${DOWNLOADER_PORT}`);
      resolve();
    }).on('error', reject);
  });

  console.log(`[${timestamp()}] [App] JoynArr is ready.`);
}

main().catch(err => {
  console.error(`[${timestamp()}] [App] Fatal startup error:`, err);
  process.exit(1);
});
