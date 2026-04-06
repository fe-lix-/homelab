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

## Architecture

- `manga-downloader.py` is a standalone script, separate from the scheduler. It handles acquisition; the scheduler handles delivery.
- Spawned as a background process by the UI via `subprocess.Popen` with `start_new_session=True`.
- Progress tracked via `download-status.json` (atomic writes), polled by the UI every 5s.
- History persisted in `download-history.json`, appended at the end of each run.
- Concurrency guarded by PID file + `os.kill(pid, 0)` liveness check.
- Archives downloaded to a staging directory, extracted with `7z` (p7zip-full), comic files moved to `/srv/uploads/mangas/<series>/`.
