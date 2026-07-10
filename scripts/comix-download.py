#!/usr/bin/env python3
"""Standalone comix.to downloader — one CBZ per chapter.

comix.to is heavily anti-scraped: Cloudflare, per-request anti-bot tokens, and an
AES-ENCRYPTED chapter image payload ({"e":"..."}) decrypted client-side by
obfuscated JS. So rather than crack the crypto, this drives a real headless Chrome
(Playwright) that decrypts + renders the pages natively as <img> tags; we read
those rendered image URLs from the DOM and download them. Chapters are enumerated
by clicking the reader's "Next chapter" control (stays within the selected group).

This is a fragile one-off (breaks whenever comix.to changes its bundle) and is NOT
wired into manga-scheduler. Run on the server, which has the browser:

  sudo PLAYWRIGHT_BROWSERS_PATH=/opt/manga-scheduler/ms-playwright \
    /opt/manga-scheduler/venv/bin/python comix-download.py \
    --url "https://comix.to/title/<slug>?group=1633" \
    --out /srv/uploads/mangas [--series "Name"] [--start 0] [--end 61]
"""
import argparse
import io
import re
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

UA = "Mozilla/5.0 (X11; Linux x86_64; rv:149.0) Gecko/20100101 Firefox/149.0"
IMG_MIN_W = 300          # ignore icons/thumbnails; real pages are >1000px wide
IMG_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif")


def log(m):
    print(m, flush=True)


def series_from_url(url):
    m = re.search(r"/title/[a-z0-9]+-([a-z0-9-]+)", url)
    slug = m.group(1) if m else "comix-series"
    return slug.replace("-", " ").title()


def chapter_num(url):
    m = re.search(r"-chapter-([\d.]+)", url)
    return m.group(1) if m else None


def with_group(url, group):
    if not group:
        return url
    base = url.split("?")[0]
    return f"{base}?group={group}"


def first_chapter_url(pg):
    """Read firstChapterUrl from the SSR'd React-Query cache on the title page."""
    html = pg.content()
    m = re.search(r'"firstChapterUrl":"([^"]+)"', html)
    return "https://comix.to" + m.group(1).replace("\\/", "/") if m else None


def configure_reader(pg):
    """Switch the reader out of its default windowed/paged mode into 'Top to bottom'
    (long-strip) + 'Preload all' so every page image is put into the DOM at once.
    Without this the viewer keeps only a ~6-image sliding window in the DOM and we
    only ever capture a fraction of the chapter. Settings persist in localStorage,
    so this is idempotent and cheap to call per chapter."""
    def click_text(t):
        return pg.evaluate(
            "(t) => { const el=[...document.querySelectorAll('button,[role=menuitem],li,div,label,span')]"
            ".find(e => (e.textContent||'').trim() === t); if(el){ el.click(); return true; } return false; }", t)
    pg.evaluate(
        "() => { document.querySelectorAll('a[href=\"#\"][target=\"_blank\"],iframe,.adsbygoogle').forEach(e=>e.remove());"
        " const s=[...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||'')==='Settings'); if(s) s.click(); }")
    pg.wait_for_timeout(900)
    click_text("Top to bottom")
    pg.wait_for_timeout(400)
    click_text("Preload all")
    pg.wait_for_timeout(400)
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(800)


def expected_pages(pg):
    """Read the chapter's declared page count from the reader's 'Go to page N' buttons."""
    return pg.evaluate(
        "() => Math.max(0, ...[...document.querySelectorAll('button')]"
        ".map(b => { const m=(b.getAttribute('aria-label')||'').match(/^Go to page (\\d+)$/); return m?+m[1]:0; }))")


def collect_page_images(pg):
    """Scroll the (long-strip) reader to force all lazy pages to render, then return
    the ordered, de-duplicated page-image URLs from the DOM. Stops once the count
    reaches the reader's declared page total, or after it stabilises at the bottom."""
    want = expected_pages(pg)
    stable = 0
    last = -1
    for _ in range(120):
        pg.mouse.wheel(0, 3000)
        pg.wait_for_timeout(350)
        n = pg.evaluate(
            "(w) => [...document.querySelectorAll('img')].filter(i=>i.naturalWidth>w).length",
            IMG_MIN_W)
        at_bottom = pg.evaluate(
            "() => (window.innerHeight + window.scrollY) >= document.body.scrollHeight - 100")
        stable = stable + 1 if n == last else 0
        last = n
        if want and n >= want:
            break
        if at_bottom and stable >= 4:
            break
    srcs = pg.evaluate(
        "(w) => [...new Set([...document.querySelectorAll('img')]"
        ".filter(i=>i.naturalWidth>w).map(i=>i.currentSrc||i.src))]", IMG_MIN_W)
    return srcs, want


def download(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://comix.to/"})
    with urllib.request.urlopen(req, timeout=45) as r:
        return r.read()


def valid_image(d):
    return (d[:3] == b"\xff\xd8\xff" or d[:4] == b"\x89PNG"
            or d[:4] == b"RIFF" or d[:6] in (b"GIF87a", b"GIF89a"))


def ext_for(data, url):
    if data[:4] == b"RIFF":
        return ".webp"
    if data[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if data[:4] == b"\x89PNG":
        return ".png"
    p = urllib.parse.urlparse(url).path.lower()
    for e in IMG_EXTS:
        if p.endswith(e):
            return e
    return ".webp"


def build_cbz(images, series, num, out_dir):
    buf = io.BytesIO()
    pages = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
        for i, data in enumerate(images, 1):
            zf.writestr(f"{i:03d}{ext_for(data, '')}", data)
            pages += 1
        ci = ('<?xml version="1.0" encoding="UTF-8"?>\n'
              '<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" '
              'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n'
              f'\t<Series>{series}</Series>\n\t<Number>{num}</Number>\n'
              f'\t<PageCount>{pages}</PageCount>\n\t<Manga>YesAndRightToLeft</Manga>\n'
              '</ComicInfo>\n')
        zf.writestr("ComicInfo.xml", ci.encode())
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"Chapter {num}.cbz"
    path.write_bytes(buf.getvalue())
    return path, pages


def download_chapter(pg, url, series, out_dir):
    num = chapter_num(url) or "?"
    dest = out_dir / f"Chapter {num}.cbz"
    if dest.exists() and dest.stat().st_size > 10240:
        log(f"  Ch {num}: already downloaded, skipping")
        return True
    configure_reader(pg)
    srcs, want = collect_page_images(pg)
    if not srcs:
        log(f"  Ch {num}: NO page images found")
        return False
    if want and len(srcs) < want:
        log(f"  Ch {num}: WARNING only {len(srcs)}/{want} pages rendered")
    images, failed = [], 0
    for i, s in enumerate(srcs, 1):
        try:
            d = download(s)
            if valid_image(d):
                images.append(d)
            else:
                failed += 1
        except Exception as e:
            log(f"    page {i} failed: {e}")
            failed += 1
        time.sleep(0.2)
    if not images or failed:
        log(f"  Ch {num}: {len(images)}/{len(srcs)} pages ({failed} failed)")
        if not images:
            return False
    path, pages = build_cbz(images, series, num, out_dir)
    log(f"  Ch {num}: {path.name} ({pages} pages)")
    return True


# --- chapter enumeration via the title-page chapter list (paginated, per-group) ---

def _collect_page(pg):
    return pg.evaluate(
        "() => [...document.querySelectorAll('a[href*=\"-chapter-\"]')].map(a => ({"
        "num: (a.getAttribute('href').match(/chapter-([\\d.]+)/)||[])[1],"
        "url: 'https://comix.to' + a.getAttribute('href')}))")


def select_group(pg, name):
    """Open the chapter-list group filter (bypassing ad overlays) and pick a group.
    Returns True if the dropdown shows the selected group afterwards."""
    pg.evaluate(
        "() => { document.querySelectorAll('a[href=\"#\"][target=\"_blank\"],iframe,.adsbygoogle')"
        ".forEach(e=>e.remove()); const b=document.querySelector('.mpage__group button'); if(b) b.click(); }")
    pg.wait_for_timeout(1000)
    pg.evaluate(
        "(name) => { const el=[...document.querySelectorAll('button,[role=menuitem],li,a')]"
        ".find(e => (e.textContent||'').trim() === name); if(el) el.click(); }", name)
    pg.wait_for_timeout(2000)
    label = pg.evaluate("() => { const s=document.querySelector('.mpage__group span'); return s?s.textContent.trim():''; }")
    return label == name


def enumerate_group(pg, title_url, group):
    """Return {chapter_number_str: reader_url} for one group, across all list pages."""
    pg.goto(title_url, wait_until="networkidle", timeout=60000)
    pg.wait_for_timeout(3500)
    pg.evaluate("() => window.scrollTo(0, document.body.scrollHeight)")
    pg.wait_for_timeout(1000)
    if group != "All groups" and not select_group(pg, group):
        log(f"  (group '{group}' not selectable — skipping)")
        return {}
    chapters = {}
    page = 1
    for _ in range(30):
        for c in _collect_page(pg):
            if c["num"]:
                chapters.setdefault(c["num"], c["url"])
        before = pg.evaluate("() => document.querySelector('a[href*=\"-chapter-\"]')?.getAttribute('href') || ''")
        page += 1
        # Only the numbered page buttons advance (real Playwright click); "Next page"
        # doesn't. The pagination window slides, so str(page) stays reachable.
        pg.evaluate("() => document.querySelectorAll('a[href=\"#\"][target=\"_blank\"],iframe,.adsbygoogle').forEach(e=>e.remove())")
        btn = pg.get_by_role("button", name=str(page), exact=True).last
        try:
            if btn.count() == 0:
                break
            btn.scroll_into_view_if_needed(timeout=4000)
            btn.click(timeout=5000, force=True)
        except Exception:
            break
        pg.wait_for_timeout(1500)
        after = pg.evaluate("() => document.querySelector('a[href*=\"-chapter-\"]')?.getAttribute('href') || ''")
        if after == before:
            break
    return chapters


def build_selection(groups_in_priority):
    """Merge per-group chapter dicts (highest priority first) → {num: url}, sorted.
    Integer chapters: highest-priority group that has them wins. Decimal "extras":
    taken only from the base (highest-priority) group, so cross-group equivalents
    (e.g. one group's 20.1 == another's 20.5) aren't downloaded twice."""
    def is_int(n):
        return float(n) == int(float(n))

    selected, covered = {}, set()
    base = groups_in_priority[0] if groups_in_priority else {}
    for n, u in base.items():                      # take the base group entirely
        selected[n] = u
        if is_int(n):
            covered.add(int(float(n)))
    for gd in groups_in_priority[1:]:              # gap-fill missing INTEGER chapters
        for n, u in gd.items():
            if is_int(n) and int(float(n)) not in covered:
                selected[n] = u
                covered.add(int(float(n)))
    return dict(sorted(selected.items(), key=lambda kv: float(kv[0])))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True, help="comix.to title URL")
    ap.add_argument("--out", default="/srv/uploads/mangas")
    ap.add_argument("--series", default="", help="series folder name override")
    ap.add_argument("--groups", default="Official,J-Novel Club",
                    help="comma-separated group priority; falls back to 'All groups'")
    ap.add_argument("--start", type=float, default=None, help="first chapter number to keep")
    ap.add_argument("--end", type=float, default=None, help="last chapter number to keep")
    ap.add_argument("--list-only", action="store_true", help="enumerate + print the selection, don't download")
    args = ap.parse_args()

    title_url = args.url.split("?")[0]
    priority = [g.strip() for g in args.groups.split(",") if g.strip()] + ["All groups"]
    series = args.series.strip() or series_from_url(args.url)
    out_dir = Path(args.out) / re.sub(r"[^\w\s.()-]", "_", series).strip()
    log(f"Series: {series}  | group priority: {priority}  | out: {out_dir}")

    with sync_playwright() as pw:
        b = pw.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        ctx = b.new_context(user_agent=UA, viewport={"width": 1400, "height": 2200})
        pg = ctx.new_page()

        # 1. Enumerate each group's chapter list (paginated), highest priority first.
        per_group = []
        for g in priority:
            ch = enumerate_group(pg, title_url, g)
            log(f"Group '{g}': {len(ch)} chapter(s)")
            per_group.append(ch)

        # 2. Merge with the priority + dedup rule.
        selection = build_selection(per_group)
        sel = [(n, u) for n, u in selection.items()
               if (args.start is None or float(n) >= args.start)
               and (args.end is None or float(n) <= args.end)]
        log(f"\nSelected {len(sel)} chapter(s): {' '.join(n for n, _ in sel)}")
        if args.list_only:
            b.close()
            return

        # 3. Download each selected chapter (browser renders → read <img> → save CBZ).
        done = 0
        for num, url in sel:
            log(f"Ch {num}: {url}")
            try:
                pg.goto(url, wait_until="networkidle", timeout=60000)
                pg.wait_for_timeout(2500)
                if download_chapter(pg, url, series, out_dir):
                    done += 1
            except Exception as e:
                log(f"  Ch {num}: FAILED {e}")

        b.close()
    log(f"\nDone: {done}/{len(sel)} chapter(s) downloaded to {out_dir}")


if __name__ == "__main__":
    main()
