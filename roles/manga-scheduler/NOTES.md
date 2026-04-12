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
- **Reader page** (`/<slug>-volume-N/`): Cloudflare-protected. Image data embedded in `ts_reader.run({...})` JavaScript call. The JSON contains `sources[0].images[]` — a flat array of CDN image URLs. The reader shows one page at a time (mode: "single") and prefetches the next page.
- **CDN** (`c.sushiscan.net` or `c1.sushiscan.net`): Separate Cloudflare protection from the main site. Different manga may use different CDN subdomains.

### Image download — what works and what doesn't

**Working approach**: ByParr fetches the reader page HTML → parse `ts_reader.run()` for image URLs → ByParr's `cf_clearance` cookie (domain `.sushiscan.net`) is passed to urllib → urllib downloads images with browser-like headers. This works because the `.sushiscan.net` cookie covers CDN subdomains, and ByParr's cookie + urllib's TLS fingerprint are sometimes accepted by the CDN.

**Intermittent failures**: The CDN's Cloudflare protection may block urllib after a few requests. The `cf_clearance` cookie is tied to the TLS fingerprint of the browser that solved the challenge. urllib's TLS fingerprint differs from Chrome's and may be rejected. When this happens, the downloader fails fast (stops on first blocked image) and the error message suggests retrying later.

**What does NOT work reliably**:
- `page.request.get()` in Playwright: programmatic fetch, not a browser navigation. CDN blocks with 403.
- `fetch()` / `XMLHttpRequest` from within a reader page: blocked by CORS (CDN is a different origin).
- Canvas extraction (`drawImage` + `toDataURL`): CORS taint — CDN images loaded without `crossOrigin` taint the canvas.
- Navigating Playwright directly to CDN image URLs: CDN detects headless browser and blocks.
- Playwright response interception: the CDN serves a 403 Cloudflare challenge page, then the browser solves it via JS redirect. The interceptor only catches the initial 403, not the final image.
- `page.goto()` with `wait_until="networkidle"` on reader pages: ads/trackers keep connections open. Always times out. Use `domcontentloaded` instead.
- Playwright with persistent context / stealth mode: Cloudflare Turnstile detects Playwright's automation flags and enters an infinite verification loop even in non-headless mode.

**Key insight — image validation**: Some manga pages are legitimately small (e.g., a white inner cover page can be ~5KB JPEG). Never use file size to validate images — check **magic bytes** instead (JPEG: `\xff\xd8\xff`, PNG: `\x89PNG`, WEBP: `RIFF`, AVIF: `\x00\x00\x00\x1c`). A 5KB Cloudflare HTML response and a 5KB white page JPEG are distinguished by their magic bytes, not their size.

### Retry and recovery

- If the CDN blocks, wait and retry later — the block is temporary (hours to days).
- Pages are cached in staging (`/opt/manga-scheduler/staging/sushiscan/<entry>/`). On retry, only missing pages are re-downloaded.
- The `cleanup_staging()` function preserves the `sushiscan/` subdirectory.
- The download pipeline also checks for existing CBZ files on disk (in both `/srv/uploads/mangas/` and `/srv/comics/`) to avoid re-downloading completed entries.

### CBZ creation

Sushiscan serves individual page images, not archives. The downloader creates CBZ files with:
- Sequential page filenames: `001.jpg`, `002.jpg`, etc.
- `ComicInfo.xml` with `<Series>`, `<Volume>` (for volumes) or `<Number>` (for chapters), `<Title>`, `<PageCount>`, `<LanguageISO>fr`, `<Manga>YesAndRightToLeft`

### Delays

- 0.3–1.0s between page downloads (random)
- 45–90s between volumes (random)
- These mimic the reader's prefetch pattern where 1-2 pages load at a time

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

Notifications sent to per-manga topics (e.g., `manga-bluelock`). Uses header-based publishing with `urllib.parse.quote()` for the Title header to handle non-ASCII characters. ntfy topic names cannot contain `/` — use `-` instead.

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
- The UI has three pages: Delivery (`/`), Download (`/download-page`), and Schedule (`/schedule`).
