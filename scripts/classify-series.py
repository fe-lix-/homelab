#!/usr/bin/env python3
"""Classify each /srv/comics series as volume-based (~200pp tomes) or
chapter-based (~40pp) by median image-pages-per-file. Threshold default 100."""
import os, sys, zipfile, statistics

ROOT = "/srv/comics"
THRESH = int(sys.argv[1]) if len(sys.argv) > 1 else 100
IMG = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif")


def pages(path):
    try:
        with zipfile.ZipFile(path) as z:
            return sum(1 for n in z.namelist() if n.lower().endswith(IMG))
    except Exception:
        return None


rows = []
for d in sorted(os.listdir(ROOT)):
    p = os.path.join(ROOT, d)
    if not os.path.isdir(p):
        continue
    cbz = [f for f in sorted(os.listdir(p)) if f.lower().endswith(".cbz")]
    pdf = [f for f in os.listdir(p) if f.lower().endswith(".pdf")]
    if not cbz:
        rows.append((d, len(pdf), None, "PDF/other" if pdf else "empty"))
        continue
    sample = cbz[:: max(1, len(cbz) // 5)][:5]  # up to 5 spread samples
    counts = [c for c in (pages(os.path.join(p, f)) for f in sample) if c]
    med = int(statistics.median(counts)) if counts else 0
    kind = "VOLUME" if med >= THRESH else "chapter"
    rows.append((d, len(cbz), med, kind))

print(f"threshold = {THRESH} pages/file\n")
print(f"{'series':45} {'files':>5} {'med.pp':>7}  kind")
for d, n, med, kind in rows:
    print(f"{d[:45]:45} {n:>5} {str(med):>7}  {kind}")
vols = [r for r in rows if r[3] == "VOLUME"]
print(f"\nVOLUME-based: {len(vols)} series, {sum(r[1] for r in vols)} files")
print(f"chapter-based/other: {len(rows)-len(vols)} series")
