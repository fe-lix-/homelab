import express from 'express';
import { ensureFfmpeg } from './downloader/ffmpeg.js';
import indexerRouter from './indexer/routes.js';
import downloaderRouter from './downloader/routes.js';
import { getEvents } from './activity.js';

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

  // Activity API + UI
  app.get('/activity', (_req, res) => res.json(getEvents()));
  app.get('/', (_req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(UI_HTML);
  });

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

const UI_HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>JoynArr Activity</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font:14px/1.5 system-ui,sans-serif;background:#0f0f0f;color:#e0e0e0;min-height:100vh}
    header{display:flex;align-items:center;justify-content:space-between;padding:12px 20px;border-bottom:1px solid #222}
    h1{font-size:15px;font-weight:600;color:#fff;letter-spacing:.01em}
    button.refresh{background:#1a1a1a;border:1px solid #2a2a2a;color:#777;padding:4px 10px;cursor:pointer;border-radius:4px;font:inherit;font-size:12px}
    button.refresh:hover{color:#ccc}
    nav{display:flex;border-bottom:1px solid #1a1a1a;padding:0 20px}
    nav button{background:none;border:none;border-bottom:2px solid transparent;color:#555;padding:10px 14px;cursor:pointer;font:inherit;font-size:13px;margin-bottom:-1px}
    nav button.active{color:#fff;border-bottom-color:#4a9eff}
    nav button:hover:not(.active){color:#aaa}
    table{width:100%;border-collapse:collapse}
    th{text-align:left;padding:8px 20px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#444;border-bottom:1px solid #1a1a1a;font-weight:500}
    td{padding:9px 20px;border-bottom:1px solid #141414;vertical-align:top}
    tr:hover td{background:#111}
    .ts{color:#444;font-size:12px;white-space:nowrap}
    .badge{display:inline-block;padding:2px 8px;border-radius:3px;font-size:11px;font-weight:500}
    .s {background:#0d1e30;color:#4a9eff}
    .ds{background:#0d1e15;color:#3dcc74}
    .dc{background:#13102a;color:#9a7aff}
    .df{background:#1e0d0d;color:#ff5555}
    .main{color:#ddd;font-size:13px}
    .sub{color:#555;font-size:12px;margin-top:2px}
    .err{color:#cc4444;font-size:12px;margin-top:2px}
    .empty{text-align:center;padding:60px;color:#333;font-size:13px}
    .retry{background:none;border:1px solid #3a1a1a;color:#cc4444;padding:2px 8px;border-radius:3px;cursor:pointer;font:inherit;font-size:11px;margin-left:8px}
    .retry:hover{background:#2a1010;color:#ff5555}
  </style>
</head>
<body>
  <header>
    <h1>JoynArr Activity</h1>
    <button class="refresh" onclick="load()">&#8635; Refresh</button>
  </header>
  <nav>
    <button class="active" data-filter="all"    onclick="setFilter('all',this)">All</button>
    <button             data-filter="search"   onclick="setFilter('search',this)">Searches</button>
    <button             data-filter="downloads" onclick="setFilter('downloads',this)">Downloads</button>
  </nav>
  <div id="content"></div>
  <script>
    let filter = 'all';
    let allEvents = [];

    function setFilter(f, btn) {
      filter = f;
      document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      render();
    }

    function fmt(ts) {
      const d = new Date(ts);
      return d.toLocaleDateString(undefined, {month:'short',day:'numeric'})
        + ' ' + d.toLocaleTimeString(undefined, {hour:'2-digit',minute:'2-digit',second:'2-digit'});
    }

    function badge(type) {
      const map = {
        search:             ['s',  'Search'],
        download_started:   ['ds', 'Started'],
        download_completed: ['dc', 'Completed'],
        download_failed:    ['df', 'Failed'],
      };
      const [cls, label] = map[type] || ['', type];
      return '<span class="badge ' + cls + '">' + label + '</span>';
    }

    function detail(e) {
      if (e.type === 'search') {
        const parts = [];
        if (e.data.q)      parts.push(e.data.q);
        if (e.data.tvdbid) parts.push('TVDB #' + e.data.tvdbid);
        if (e.data.season) parts.push('S' + String(e.data.season).padStart(2,'0'));
        if (e.data.ep)     parts.push('E' + String(e.data.ep).padStart(2,'0'));
        return '<span class="main">' + (parts.join(' &middot; ') || '&mdash;') + '</span>';
      }
      let html = '<span class="main">' + (e.data.title || '&mdash;') + '</span>';
      if (e.data.path)  html += '<div class="sub">' + e.data.path + '</div>';
      if (e.data.error) html += '<div class="err">' + e.data.error + '</div>';
      if (e.type === 'download_failed' && e.data.nzo_id) {
        html += '<button class="retry" onclick="retry(\'' + e.data.nzo_id + '\',this)">↺ Retry</button>';
      }
      return html;
    }

    function render() {
      const events = filter === 'all'       ? allEvents
                   : filter === 'search'    ? allEvents.filter(e => e.type === 'search')
                   : allEvents.filter(e => e.type !== 'search');

      const el = document.getElementById('content');
      if (!events.length) {
        el.innerHTML = '<div class="empty">No activity yet.</div>';
        return;
      }
      el.innerHTML =
        '<table><thead><tr><th>Time</th><th>Type</th><th>Detail</th></tr></thead><tbody>' +
        events.map(e =>
          '<tr><td class="ts">' + fmt(e.timestamp) + '</td>' +
          '<td>' + badge(e.type) + '</td>' +
          '<td>' + detail(e) + '</td></tr>'
        ).join('') +
        '</tbody></table>';
    }

    async function load() {
      allEvents = await fetch('/activity').then(r => r.json());
      render();
    }

    async function retry(nzo_id, btn) {
      btn.disabled = true;
      btn.textContent = '…';
      const r = await fetch('/download/retry/' + nzo_id, { method: 'POST' });
      if (r.ok) { await load(); } else { btn.textContent = '✗ Failed'; }
    }

    load();
    setInterval(load, 30000);
  </script>
</body>
</html>`;


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
