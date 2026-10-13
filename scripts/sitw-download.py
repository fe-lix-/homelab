#!/usr/bin/env python3
"""
Secrets of the Silent Witch (Spanish) — chapter downloader.

Walks chapters starting from capitulo-0 by following "next chapter" links,
downloads images from the CDN (imagenes.mangasnosekai.com), and groups them
into volume CBZs of ~TARGET_PAGES pages each.

Auth flow:
  - ByParr (FlareSolverr-compatible at localhost:8191) handles Cloudflare on
    mangasnosekai.com chapter pages and returns cf_clearance + its User-Agent.
  - The cf_clearance cookie for .mangasnosekai.com covers all subdomains
    (including the CDN), but is bound to the exact User-Agent ByParr used.
  - We extract both and use them in a plain requests.Session for image downloads.

Incomplete batches are saved to staging and resumed on the next run.

Output: /srv/uploads/mangas/Secrets of the Silent Witch/Volume NN.cbz
Staging: /srv/uploads/mangas/Secrets of the Silent Witch/.staging/

Usage on kazad-dum:
    sudo PLAYWRIGHT_BROWSERS_PATH=/opt/manga-scheduler/ms-playwright \\
        /opt/manga-scheduler/venv/bin/python3 /opt/manga-scheduler/sitw-download.py

    # dry-run:
    sudo ... sitw-download.py --dry-run
"""

import argparse
import json
import re
import shutil
import sys
import time
import zipfile
from pathlib import Path

import requests

SERIES_SLUG = "los-secretos-de-la-bruja-silenciosa"
BASE = f"https://mangasnosekai.com/manga/{SERIES_SLUG}"
CDN_HOST = "imagenes.mangasnosekai.com"

IMG_URLS_RE = re.compile(
    rf'https://{re.escape(CDN_HOST)}/manga_\w+/\w+/(\d+)\.(jpg|jpeg|png|webp|gif|avif)',
    re.IGNORECASE,
)
NEXT_RE = re.compile(
    rf'href="({re.escape(BASE)}/capitulo-[\w-]+/)"'
)

SERIES_OUTPUT_NAME = "Secrets of the Silent Witch"
DEFAULT_UPLOAD_DIR = f"/srv/uploads/mangas/{SERIES_OUTPUT_NAME}"
DEFAULT_TARGET_PAGES = 180
BYPARR = "http://127.0.0.1:8191/v1"
MANIFEST_FILE = "manifest.json"


# ── ByParr ─────────────────────────────────────────────────────────────────────

def byparr_get(session, url):
    """Return (html, cookies_dict, user_agent)."""
    resp = session.post(BYPARR, json={
        "cmd": "request.get", "url": url, "maxTimeout": 60000,
    }, timeout=90)
    resp.raise_for_status()
    data = resp.json()
    if data.get("status") != "ok":
        raise RuntimeError(f"ByParr error for {url}: {data.get('message')}")
    sol = data["solution"]
    cookies = {c["name"]: c["value"] for c in sol.get("cookies", [])}
    return sol["response"], cookies, sol.get("userAgent", "")


# ── HTML parsing ────────────────────────────────────────────────────────────────

def _slug_num(slug):
    m = re.match(r'capitulo-(\d+)(?:-(\d+))?', slug)
    if not m:
        return -1
    major = int(m.group(1))
    minor = int(m.group(2)) if m.group(2) else 0
    return major + minor / 100  # capitulo-8-5 → 8.05, capitulo-29-1 → 29.01


def parse_chapter(html, chapter_url):
    """Return (image_urls_ordered, next_url_or_None)."""
    seen = {}
    for m in IMG_URLS_RE.finditer(html):
        page_n = int(m.group(1))
        if page_n not in seen:
            seen[page_n] = m.group(0)
    image_urls = [seen[n] for n in sorted(seen)]

    current_num = _slug_num(chapter_url.rstrip("/").rsplit("/", 1)[-1])
    next_url = None
    best_num = float("inf")
    for link in NEXT_RE.findall(html):
        num = _slug_num(link.rstrip("/").rsplit("/", 1)[-1])
        if num > current_num and num < best_num:
            best_num = num
            next_url = link

    return image_urls, next_url


# ── staging ────────────────────────────────────────────────────────────────────

def load_staging(staging_dir):
    manifest = staging_dir / MANIFEST_FILE
    if manifest.exists():
        data = json.loads(manifest.read_text())
        print(f"Resuming from staging: volume {data['volume_num']}, "
              f"{len(data['chapters'])} staged chapters "
              f"({sum(c['pages'] for c in data['chapters'])} pages), "
              f"next URL: {data['next_url']}", flush=True)
        return data["volume_num"], data["next_url"], data["chapters"]
    return None, f"{BASE}/capitulo-0/", []


def save_staging(staging_dir, volume_num, next_url, chapters):
    staging_dir.mkdir(parents=True, exist_ok=True)
    (staging_dir / MANIFEST_FILE).write_text(json.dumps({
        "volume_num": volume_num,
        "next_url": next_url,
        "chapters": chapters,
    }, indent=2))


def clear_staging(staging_dir):
    if staging_dir.exists():
        shutil.rmtree(staging_dir)


# ── volume packing ─────────────────────────────────────────────────────────────

def pack_volume(cbz_path, staging_dir, chapters):
    with zipfile.ZipFile(cbz_path, "w", zipfile.ZIP_STORED) as zf:
        page_num = 1
        for ch in chapters:
            ch_dir = staging_dir / ch["dir"]
            for img_path in sorted(ch_dir.iterdir()):
                zf.write(img_path, f"{page_num:04d}{img_path.suffix}")
                page_num += 1
    return page_num - 1


# ── main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--upload-dir", default=DEFAULT_UPLOAD_DIR)
    parser.add_argument("--target-pages", type=int, default=DEFAULT_TARGET_PAGES)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    out_dir = Path(args.upload_dir)
    staging_dir = out_dir / ".staging"

    if not args.dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)

    byparr_session = requests.Session()
    # http session is configured per-chapter with ByParr's User-Agent
    http = requests.Session()
    http.headers["Accept"] = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
    http.headers["Accept-Language"] = "es-ES,es;q=0.9,en;q=0.8"

    if args.dry_run:
        volume_num, next_url, staged_chapters = None, f"{BASE}/capitulo-0/", []
    else:
        volume_num, next_url, staged_chapters = load_staging(staging_dir)

    if volume_num is None:
        volume_num = 1
        while (out_dir / f"Volume {volume_num:02d}.cbz").exists():
            volume_num += 1
        if volume_num > 1:
            print(f"Found {volume_num - 1} existing volume(s), starting at Volume {volume_num:02d}", flush=True)

    chapters = list(staged_chapters)
    volume_pages = sum(c["pages"] for c in chapters)
    chapter_num = 0
    visited = set()
    byparr_ua = None    # set on first successful ByParr call
    cf_cookies = {}     # updated each chapter
    stopped_at_url = None  # set when a chapter fails mid-download

    while next_url:
        chapter_url = next_url
        canonical = chapter_url.rstrip("/")
        if canonical in visited:
            print(f"\nLoop detected — already visited {chapter_url}, stopping.", flush=True)
            break
        visited.add(canonical)

        slug = chapter_url.rstrip("/").rsplit("/", 1)[-1]
        label = slug.replace("capitulo-", "Chapter ").replace("-", ".")
        chapter_num += 1

        print(f"\n[Ch {chapter_num}] {label}  ({chapter_url})", flush=True)

        try:
            html, cf_cookies, ua = byparr_get(byparr_session, chapter_url)
            if ua and byparr_ua is None:
                byparr_ua = ua
                http.headers["User-Agent"] = ua
        except Exception as e:
            print(f"  ERROR fetching page: {e}", file=sys.stderr)
            break

        image_urls, next_url = parse_chapter(html, chapter_url)

        if not image_urls:
            print(f"  WARNING: no images found — skipping", file=sys.stderr)
            continue

        page_count = len(image_urls)
        print(f"  {page_count} pages", flush=True)

        if args.dry_run:
            volume_pages += page_count
            if volume_pages >= args.target_pages:
                print(f"  → would close Volume {volume_num:02d} ({volume_pages} pages)", flush=True)
                volume_num += 1
                volume_pages = 0
            continue

        # Download images: use ByParr's UA + cf_clearance cookie (covers all subdomains).
        # On 403 (CDN rate-limit), refresh cookies via ByParr and retry up to 2 times.
        staging_chapter_dir = staging_dir / slug
        staging_chapter_dir.mkdir(parents=True, exist_ok=True)
        downloaded = 0
        chapter_failed = False
        for i, url in enumerate(image_urls, start=1):
            ext = url.rsplit(".", 1)[-1]
            dest = staging_chapter_dir / f"{i:04d}.{ext}"
            ok = False
            for attempt in range(3):
                try:
                    r = http.get(url, timeout=30,
                                 headers={"Referer": chapter_url},
                                 cookies=cf_cookies)
                    if r.ok:
                        dest.write_bytes(r.content)
                        downloaded += 1
                        ok = True
                        break
                    elif r.status_code in (403, 429) and attempt < 2:
                        print(f"  HTTP {r.status_code} on image {i} (attempt {attempt+1}) — "
                              f"waiting 30s and refreshing cookies...", file=sys.stderr)
                        time.sleep(30)
                        try:
                            _, cf_cookies, _ = byparr_get(byparr_session, chapter_url)
                        except Exception as e:
                            print(f"  WARNING: cookie refresh failed: {e}", file=sys.stderr)
                    else:
                        print(f"  WARNING: {url}: HTTP {r.status_code}", file=sys.stderr)
                        break
                except Exception as e:
                    print(f"  WARNING: {url}: {e}", file=sys.stderr)
                    break
            if not ok and i == 1:
                # First image failed after retries — chapter is inaccessible; stop here
                chapter_failed = True
                break

        if chapter_failed or downloaded == 0:
            print(f"  Chapter download failed — saving staging and stopping.", file=sys.stderr)
            shutil.rmtree(staging_chapter_dir, ignore_errors=True)
            stopped_at_url = chapter_url
            break

        print(f"  downloaded {downloaded}/{page_count} pages", flush=True)

        chapters.append({"label": label, "dir": slug, "pages": downloaded})
        volume_pages += downloaded

        if volume_pages >= args.target_pages:
            cbz_path = out_dir / f"Volume {volume_num:02d}.cbz"
            print(f"\nPacking {cbz_path.name} ({volume_pages} pages)...", flush=True)
            written = pack_volume(cbz_path, staging_dir, chapters)
            print(f"  → {written} pages written", flush=True)
            volume_num += 1
            chapters = []
            volume_pages = 0
            clear_staging(staging_dir)

        time.sleep(5)  # reduce CDN rate-limit pressure between chapters

    if args.dry_run:
        print(f"\nDry-run complete.")
        if volume_pages:
            print(f"  {volume_pages} pages would be left in staging "
                  f"(not enough for Volume {volume_num:02d} yet).")
        return

    resume_url = stopped_at_url or next_url or ""
    if stopped_at_url:
        label = stopped_at_url.rstrip("/").rsplit("/", 1)[-1].replace("capitulo-", "Chapter ").replace("-", ".")
        print(f"Progress saved to staging. Re-run to continue from {label}.", flush=True)

    if chapters or stopped_at_url:
        if chapters:
            print(f"\n{volume_pages} pages staged ({len(chapters)} chapters) — "
                  f"not enough for Volume {volume_num:02d} yet.", flush=True)
        save_staging(staging_dir, volume_num, resume_url, chapters)
        print(f"Saved to {staging_dir} — run again when more chapters are available.", flush=True)
    else:
        clear_staging(staging_dir)
        print("\nAll chapters packed into volumes.", flush=True)

    print("\nDone.", flush=True)


if __name__ == "__main__":
    main()
