#!/usr/bin/env python3
"""
Crawl tomosmanga.com/manga/ and recommend series suitable for a 10-year-old.

By default scans only the first listing page (latest updates). Pass --pages all
to check the full catalogue.

Usage:
    python3 scripts/tomo-recommend.py                              # latest updates only
    python3 scripts/tomo-recommend.py --pages 3                    # first 3 pages
    python3 scripts/tomo-recommend.py --pages all                  # full catalogue
    python3 scripts/tomo-recommend.py --comics-dir /srv/comics --uploads-dir /srv/uploads/mangas
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

BASE_URL = "https://tomosmanga.com/manga/"
HEADERS = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"}
REQUEST_DELAY = 0.5  # seconds between requests — be polite

# Demographics safe for a 10-year-old
SAFE_DEMOGRAPHICS = {"shonen", "shojo", "kodomo", "josei"}

# Categories that flag a series as not suitable regardless of demographic
SKIP_TAGS = {"seinen", "adulto", "hentai", "+18", "ecchi", "adult"}

# Genres to highlight as likely interesting for a child
HIGHLIGHT_GENRES = {
    "aventura", "adventure", "fantasía", "fantasy", "comedia", "comedy",
    "magia", "magic", "amistad", "friendship", "deportes", "sports",
    "misterio", "mystery", "sci-fi", "ciencia ficción",
}


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read().decode("utf-8", errors="replace")


def get_listing_pages() -> list[str]:
    """Return all paginated listing URLs."""
    html = fetch(BASE_URL)
    last_pages = re.findall(
        r'href="(https://tomosmanga\.com/manga/page/(\d+)/)"', html
    )
    if not last_pages:
        return [BASE_URL]
    max_page = max(int(n) for _, n in last_pages)
    urls = [BASE_URL]
    for i in range(2, max_page + 1):
        urls.append(f"https://tomosmanga.com/manga/page/{i}/")
    return urls


def parse_listing_page(html: str) -> list[tuple[str, str]]:
    """Extract (title, url) pairs from a listing page."""
    return re.findall(
        r'<h2 class="entry-title"[^>]*><a href="([^"]+)"[^>]*>([^<]+)</a>', html
    )


def get_series_metadata(url: str) -> dict:
    """Fetch a series page and extract categories/genres from JSON-LD."""
    try:
        html = fetch(url)
    except Exception as e:
        return {"error": str(e), "categories": [], "genres": []}

    # Extract JSON-LD blocks
    ld_blocks = re.findall(
        r'<script[^>]+type="application/ld\+json"[^>]*>(.*?)</script>',
        html, re.S | re.I
    )
    categories = []
    for block in ld_blocks:
        try:
            data = json.loads(block)
            if isinstance(data, list):
                data = data[0]
            if "articleSection" in data:
                categories = data["articleSection"]
                break
            # Sometimes it's nested in @graph
            for item in data.get("@graph", []):
                if "articleSection" in item:
                    categories = item["articleSection"]
                    break
        except (json.JSONDecodeError, TypeError, KeyError):
            pass

    # Also grab category tag links as fallback
    if not categories:
        categories = re.findall(
            r'<a[^>]*rel="category tag"[^>]*>([^<]+)</a>', html
        )

    cats_lower = [c.lower().strip() for c in categories]
    demographic = next(
        (c for c in cats_lower if c in SAFE_DEMOGRAPHICS | SKIP_TAGS), None
    )
    genres = [c for c in cats_lower if c not in {"manga", "en publicación", "completo"}]

    return {
        "categories": categories,
        "demographic": demographic,
        "genres": genres,
    }


def normalise_title(title: str) -> str:
    """Strip volume ranges and trailing whitespace for comparison."""
    return re.sub(r'\s*(Tomos?|Vol\.?|#).*$', '', title, flags=re.I).strip().lower()


def load_existing(comics_dir: str, uploads_dir: str) -> set[str]:
    """Return normalised folder names that are already downloaded."""
    existing = set()
    for d in [comics_dir, uploads_dir]:
        if d and os.path.isdir(d):
            for name in os.listdir(d):
                existing.add(name.lower().strip())
    return existing


def is_suitable(meta: dict) -> bool:
    """Return True if a series is appropriate for a 10-year-old."""
    genres = meta.get("genres", [])
    demo = meta.get("demographic")
    if any(tag in genres for tag in SKIP_TAGS):
        return False
    if demo in SKIP_TAGS:
        return False
    if demo in SAFE_DEMOGRAPHICS:
        return True
    # No demographic info — include with a note
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--comics-dir", default="", help="Path to /srv/comics")
    parser.add_argument("--uploads-dir", default="", help="Path to /srv/uploads/mangas")
    parser.add_argument("--delay", type=float, default=REQUEST_DELAY)
    parser.add_argument(
        "--pages", default="1",
        help="Number of listing pages to scan (default: 1 = latest updates only). Pass 'all' to scan everything.",
    )
    args = parser.parse_args()

    existing = load_existing(args.comics_dir, args.uploads_dir)

    print("Fetching listing pages…", flush=True)
    all_listing_pages = get_listing_pages()
    if args.pages == "all":
        listing_pages = all_listing_pages
    else:
        listing_pages = all_listing_pages[: int(args.pages)]
    print(f"  {len(listing_pages)} of {len(all_listing_pages)} page(s) to scan", flush=True)

    all_series = []
    for i, page_url in enumerate(listing_pages, 1):
        print(f"  Listing {i}/{len(listing_pages)}: {page_url}", flush=True)
        try:
            html = fetch(page_url)
            entries = parse_listing_page(html)
            all_series.extend(entries)
        except Exception as e:
            print(f"    ERROR: {e}", flush=True)
        time.sleep(args.delay)

    print(f"\nFound {len(all_series)} series total. Fetching metadata…\n", flush=True)

    suitable = []
    skip_count = 0

    for i, (url, title) in enumerate(all_series, 1):
        clean_title = title.strip()
        norm = normalise_title(clean_title)
        already_have = any(norm in e or e in norm for e in existing)

        print(f"  [{i}/{len(all_series)}] {clean_title}", end="", flush=True)
        meta = get_series_metadata(url)
        demo = meta.get("demographic", "?")
        genres = meta.get("genres", [])
        cats_str = ", ".join(meta.get("categories", []))
        print(f" [{demo}]", flush=True)

        time.sleep(args.delay)

        if is_suitable(meta):
            highlights = [g for g in genres if g in HIGHLIGHT_GENRES]
            suitable.append({
                "title": clean_title,
                "url": url,
                "demographic": demo,
                "genres": genres,
                "highlights": highlights,
                "already_have": already_have,
            })
        else:
            skip_count += 1

    # Output
    print("\n" + "=" * 72)
    print(f"SUITABLE FOR A 10-YEAR-OLD  ({len(suitable)} series, {skip_count} filtered out)")
    print("=" * 72)

    already = [s for s in suitable if s["already_have"]]
    new = [s for s in suitable if not s["already_have"]]

    if new:
        print(f"\n--- NEW (not in your library) — {len(new)} series ---\n")
        for s in sorted(new, key=lambda x: x["title"].lower()):
            demo_tag = f"[{s['demographic']}]" if s['demographic'] else "[unknown demo]"
            hl = f"  ✦ {', '.join(s['highlights'])}" if s['highlights'] else ""
            print(f"  {s['title']}")
            print(f"    {demo_tag}  {', '.join(s['genres'][:5])}{hl}")
            print(f"    {s['url']}")
            print()

    if already:
        print(f"\n--- ALREADY IN YOUR LIBRARY — {len(already)} series ---\n")
        for s in sorted(already, key=lambda x: x["title"].lower()):
            demo_tag = f"[{s['demographic']}]" if s['demographic'] else ""
            print(f"  ✓ {s['title']}  {demo_tag}")

    # JSON output for scripting
    out_path = Path("tomo-recommendations.json")
    out_path.write_text(json.dumps(suitable, indent=2, ensure_ascii=False))
    print(f"\nFull results saved to {out_path}")


if __name__ == "__main__":
    main()
