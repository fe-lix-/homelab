#!/usr/bin/env python3
"""Bundle scanlation chapter CBZs into official tomes by chapter-number ranges.
Usage: honzuki-bundle.py SERIES_DIR QUARANTINE_DIR WRITER "lo-hi,lo-hi,..."
Each range = one volume (inclusive, by integer chapter number). Decimal release-
splits (e.g. 10.0/10.5) and titled chapters go with their integer; "Aviso"
notices are dropped. Pages are renumbered sequentially; ComicInfo written."""
import io, os, re, shutil, sys, zipfile

SERIES_DIR, QUARANTINE, WRITER, RANGES_STR = sys.argv[1:5]
IMG_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif")
ranges = [tuple(int(x) for x in r.split("-")) for r in RANGES_STR.split(",")]
series_name = os.path.basename(SERIES_DIR)


def chapnum(f):
    m = re.search(r"Cap[ií]tulo\s+([0-9]+(?:\.[0-9]+)?)", f)
    return float(m.group(1)) if m else None


def natkey(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


chapters = [f for f in os.listdir(SERIES_DIR)
            if f.lower().endswith(".cbz") and "aviso" not in f.lower()
            and chapnum(f) is not None]

for vi, (lo, hi) in enumerate(ranges, 1):
    vol_files = sorted([f for f in chapters if lo <= int(chapnum(f)) <= hi],
                       key=chapnum)
    if not vol_files:
        print(f"Volume {vi}: NO files for {lo}-{hi}"); continue
    buf = io.BytesIO(); page = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as out:
        for cf in vol_files:
            with zipfile.ZipFile(os.path.join(SERIES_DIR, cf)) as z:
                imgs = sorted([n for n in z.namelist()
                               if n.lower().endswith(IMG_EXTS)], key=natkey)
                for n in imgs:
                    page += 1
                    out.writestr(f"{page:04d}{os.path.splitext(n)[1].lower()}", z.read(n))
        ci = ('<?xml version="1.0" encoding="UTF-8"?>\n'
              '<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" '
              'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n'
              f'\t<Series>{series_name}</Series>\n\t<Number>{vi}</Number>\n'
              f'\t<Title>Volume {vi}</Title>\n\t<Writer>{WRITER}</Writer>\n'
              f'\t<PageCount>{page}</PageCount>\n\t<Manga>YesAndRightToLeft</Manga>\n'
              '</ComicInfo>\n')
        out.writestr("ComicInfo.xml", ci.encode())
    open(os.path.join(SERIES_DIR, f"Volume {vi}.cbz"), "wb").write(buf.getvalue())
    print(f"Volume {vi}: chapters {lo}-{hi} ({len(vol_files)} files) -> {page} pages")

os.makedirs(QUARANTINE, exist_ok=True)
moved = 0
for f in os.listdir(SERIES_DIR):
    if f.startswith("Cap") or "aviso" in f.lower():
        shutil.move(os.path.join(SERIES_DIR, f), os.path.join(QUARANTINE, f)); moved += 1
print(f"quarantined {moved} chapter file(s)")
