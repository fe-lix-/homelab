#!/usr/bin/env python3
"""
Seed /opt/manga-scheduler/series-sources.json from a tomo-recommendations.json file.

Reads the tomo catalogue (produced by tomo-recommend.py --pages all), then tries to
match each "already in library" entry against the actual disk folders using normalised
names. Writes the result to the sources file, preserving any manually-set entries.

Run on kazad-dum:
    python3 /opt/manga-scheduler/tomo-seed-sources.py \
        --recs ~/tomo-recommendations.json \
        --comics-dir /srv/comics \
        --uploads-dir /srv/uploads/mangas \
        --sources /opt/manga-scheduler/series-sources.json
"""

import argparse
import html
import json
import os
import re
from pathlib import Path


def normalise(name: str) -> str:
    """Strip volume info, HTML entities, punctuation; lowercase."""
    name = html.unescape(name)
    name = re.sub(r'\s*(Tomos?|Vol\.?|#|\[.*?\]|\(.*?\))\s*.*$', '', name, flags=re.I)
    name = re.sub(r'[^\w\s]', ' ', name)
    name = re.sub(r'\s+', ' ', name).strip().lower()
    return name


def all_folders(comics_dir: str, uploads_dir: str) -> list[str]:
    folders = []
    for d in [comics_dir, uploads_dir]:
        if d and os.path.isdir(d):
            for entry in os.listdir(d):
                full = os.path.join(d, entry)
                if os.path.isdir(full) and not entry.startswith('.') and entry != 'script.sh':
                    folders.append(entry)
    # Deduplicate, preferring comics-dir casing
    seen: dict[str, str] = {}
    for f in folders:
        key = f.lower()
        if key not in seen:
            seen[key] = f
    return list(seen.values())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--recs", default="/home/felix/tomo-recommendations.json")
    parser.add_argument("--comics-dir", default="/srv/comics")
    parser.add_argument("--uploads-dir", default="/srv/uploads/mangas")
    parser.add_argument("--sources", default="/opt/manga-scheduler/series-sources.json")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    recs = json.loads(Path(args.recs).read_text())
    folders = all_folders(args.comics_dir, args.uploads_dir)
    folder_norm = {normalise(f): f for f in folders}

    # Load existing sources to preserve manual edits
    sources_path = Path(args.sources)
    existing = {}
    if sources_path.exists():
        try:
            existing = json.loads(sources_path.read_text())
        except json.JSONDecodeError:
            pass

    matched = 0
    skipped_existing = 0
    unmatched = []

    for entry in recs:
        url = entry.get("url", "")
        title = entry.get("title", "")
        norm = normalise(title)
        folder = folder_norm.get(norm)

        if folder is None:
            unmatched.append(title)
            continue

        if folder in existing and existing[folder].get("source_url"):
            skipped_existing += 1
            continue

        existing[folder] = {"source_url": url}
        matched += 1
        print(f"  ✓ {folder!r} → {url}")

    print(f"\nMatched:          {matched}")
    print(f"Skipped (exist):  {skipped_existing}")
    print(f"Unmatched:        {len(unmatched)}")
    if unmatched:
        print("\nUnmatched series (need manual URL):")
        for t in sorted(unmatched):
            print(f"  ? {t}")

    if not args.dry_run:
        sources_path.write_text(json.dumps(existing, indent=2, ensure_ascii=False))
        print(f"\nWrote {len(existing)} entries to {args.sources}")
    else:
        print(f"\n[dry-run] Would write {len(existing)} entries to {args.sources}")


if __name__ == "__main__":
    main()
