# Manga Scheduler — Implementation Notes

## ouo.io bypass

ouo.io link shortener requires human verification with an "I'm human" button that only appears if no bot is detected.

**What does NOT work**:
- ByParr/FlareSolverr: only renders pages and waits, cannot click buttons or simulate mouse movement.
- `curl_cffi` + programmatic reCAPTCHA v3 solving: ouo.io does browser-level bot detection; pure HTTP requests (even with TLS fingerprint impersonation) are detected as bots and the form/button is never shown.

**Working approach**: Playwright with headless Chromium + human-like mouse simulation. Must simulate random mouse movements (Bezier-like waypoints) before clicking the "I'm human" button, then wait for the redirect chain to complete.

Flow: Playwright opens ouo.io page -> random mouse movements -> find and click "I'm human" button -> wait for redirect away from ouo.io -> return final URL.

Key dependency: `playwright` (installed in venv, Chromium installed via `playwright install --with-deps chromium`).

## tomosmanga.com page structure

- Pages are Cloudflare-protected (use ByParr to fetch).
- Download links come in two flavors: **Terabox** (direct cloud links) and **Fireload** (via ouo.io redirect). We use only the Fireload/ouo.io links.
- Links are organized by volume ranges (e.g., `[01-03]`, `[04-06]`).
- ouo.io links follow the pattern `https://ouo.io/SHORT_CODE`.

## Fireload

- After resolving ouo.io, the Fireload page needs rendering to extract the direct download link (use ByParr).
- Downloads are typically RAR or ZIP archives containing `.cbz`/`.cbr`/`.pdf` files.
- Fireload has rate limiting — downloads must be sequential with a delay between each (default 30s).

## sushiscan.net

### Page structure

- **Catalogue page** (`/catalogue/<slug>/`): Cloudflare-protected. Chapter/volume list in `<div class="eplister" id="chapterlist">` with `<li data-num="Volume 14">` entries. The last entry has an additional `class="first-chapter"` — regex must use `[^>]*` to match extra attributes.
- **Reader page** (`/<slug>-volume-N/`): Cloudflare-protected. Image data embedded in `ts_reader.run({...})` JavaScript call. The JSON contains `sources[0].images[]` — a flat array of CDN image URLs.
- **CDN** (`c.sushiscan.net` or `c1.sushiscan.net`): Separate Cloudflare protection from the main site. Cookies from `sushiscan.net` do NOT work on the CDN domain.

### Image download — what works and what doesn't

**Does NOT work**:
- `urllib` with Referer header: CDN returns 403 (Cloudflare blocks).
- `urllib` with `cf_clearance` cookies from ByParr: cookies are for `sushiscan.net`, not `c.sushiscan.net`. Still 403.
- `page.request.get()` in Playwright: this is a programmatic fetch, not a browser navigation. CDN Cloudflare blocks it with 403 even within a browser context.
- `page.goto()` with `wait_until="networkidle"`: reader pages have ads/trackers that keep connections open indefinitely. Always times out.

**Working approach**: Playwright response interception. Navigate to the reader page with `wait_until="domcontentloaded"`, register a `page.on("response", handler)` listener, then scroll through the page to trigger lazy-loaded images. The browser loads images naturally (solving CDN Cloudflare), and the response handler captures the binary data.

Flow:
1. Register response interceptor mapping CDN URLs to page numbers
2. `page.goto(reader_url, wait_until="domcontentloaded")`
3. Scroll progressively (10% increments, 1.5s pauses) to trigger lazy-loading
4. Interceptor saves each image response to staging directory
5. After scrolling, check which pages were captured vs missing

### CBZ creation

Sushiscan serves individual page images, not archives. The downloader creates CBZ files with:
- Sequential page filenames: `001.webp`, `002.webp`, etc.
- `ComicInfo.xml` with `<Series>`, `<Volume>` (for volumes) or `<Number>` (for chapters), `<Title>`, `<PageCount>`, `<LanguageISO>fr`, `<Manga>YesAndRightToLeft`

### Staging and retry

Pages are downloaded to a staging directory (`/opt/manga-scheduler/staging/sushiscan/<entry_name>/`). If some pages fail, successfully downloaded pages are kept. On retry, cached pages (>10KB) are skipped. CBZ is only created when all pages are present. The staging dir is cleaned up after successful CBZ creation. The tomosmanga `cleanup_staging()` preserves the `sushiscan/` subdirectory.

### Anti-hotlinking

Image downloads require:
- Browser-like `User-Agent`
- `Referer: https://sushiscan.net/` header
- Valid Cloudflare cookies for the CDN domain (only obtainable via actual browser navigation)

## fmteam.fr (chapter checker)

### Page structure

- **Comic API** (`/api/comics/<slug>`): Returns JSON with `comic.chapters[]`. Each chapter has `chapter` (int), `subchapter` (int or null), `title`, `url` (reader path like `/read/blue-lock/fr/ch/342`).
- **Reader API** (`/api/read/<slug>/fr/ch/<number>[/sub/<sub>]`): Returns JSON with `chapter.pages[]` — a flat array of direct image URLs on `fmteam.fr/storage/...`.
- **No Cloudflare on the API** — direct `urllib` fetches work with a browser-like User-Agent.

### Chapter numbering

Chapters use `chapter` + `subchapter` fields. Key format: `"342"` or `"340.2"` for subchapters. Existing files in Komga use `Chapitre NNN.cbz` naming (e.g., `Chapitre 342.cbz`, `Chapitre 340.2.cbz`).

### State tracking

Downloaded chapters tracked in `/opt/manga-scheduler/chapter-checker-state.json` keyed by manga slug. Each entry is a sorted list of chapter keys (e.g., `["340.2", "341", "342"]`).

### ntfy

Uses the JSON publishing API (`POST` to base URL with `topic` in body) to handle UTF-8 in titles. Per-manga topics (e.g., `manga-bluelock`). Note: ntfy topic names cannot contain `/` — use `-` instead.

## Architecture

- `manga-downloader.py` is a standalone script, separate from the scheduler. It handles acquisition; the scheduler handles delivery.
- Spawned as a background process by the UI via `subprocess.Popen` with `start_new_session=True`.
- Progress tracked via `download-status.json` (atomic writes), polled by the UI every 5s.
- History persisted in `download-history.json`, appended at the end of each run.
- Concurrency guarded by PID file + `os.kill(pid, 0)` liveness check.
- tomosmanga: archives downloaded to staging, extracted with `7z`, comic files moved to `/srv/uploads/mangas/<series>/`.
- sushiscan: page images downloaded to `staging/sushiscan/<entry>/`, packaged into CBZ with ComicInfo.xml, moved to `/srv/uploads/mangas/<series>/`.
- `manga-chapter-checker.py` is a separate daily systemd timer for fmteam.fr. Downloads chapters directly to `/srv/comics/<series>/` (bypasses the scheduler queue).
- `schedule.json` stores active series selection. The scheduler filters round-robin to active series first, falls back to all when active are exhausted.
