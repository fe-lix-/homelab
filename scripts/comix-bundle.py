#!/usr/bin/env python3
"""Bundle comix-download.py chapter CBZs into volumes by chapter-number ranges.
Usage: comix-bundle.py SRC_DIR OUT_DIR "lo-hi,lo-hi,..." [SERIES_NAME]

Each range = one volume (inclusive, by INTEGER chapter number, so decimal side
chapters like 10.5 fall into the volume of their integer floor). Reads files named
"Chapter N.cbz" (comix-download.py output). Pages are renumbered sequentially and
a ComicInfo.xml is written per volume. Komf/Komga fill in real author metadata."""
import io
import os
import re
import sys
import zipfile

SRC_DIR, OUT_DIR, RANGES_STR = sys.argv[1:4]
SERIES = sys.argv[4] if len(sys.argv) > 4 else os.path.basename(OUT_DIR.rstrip("/"))
IMG_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif")
ranges = [tuple(int(x) for x in r.split("-")) for r in RANGES_STR.split(",")]


def chapnum(f):
    m = re.search(r"Chapter\s+([0-9]+(?:\.[0-9]+)?)", f)
    return float(m.group(1)) if m else None


def natkey(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


chapters = [f for f in os.listdir(SRC_DIR)
            if f.lower().endswith(".cbz") and chapnum(f) is not None]
os.makedirs(OUT_DIR, exist_ok=True)

for vi, (lo, hi) in enumerate(ranges, 1):
    vol_files = sorted([f for f in chapters if lo <= int(chapnum(f)) <= hi],
                       key=chapnum)
    if not vol_files:
        print(f"Volume {vi}: NO files for {lo}-{hi}"); continue
    buf = io.BytesIO(); page = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as out:
        for cf in vol_files:
            with zipfile.ZipFile(os.path.join(SRC_DIR, cf)) as z:
                imgs = sorted([n for n in z.namelist()
                               if n.lower().endswith(IMG_EXTS)], key=natkey)
                for n in imgs:
                    page += 1
                    out.writestr(f"{page:04d}{os.path.splitext(n)[1].lower()}", z.read(n))
        ci = ('<?xml version="1.0" encoding="UTF-8"?>\n'
              '<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" '
              'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n'
              f'\t<Series>{SERIES}</Series>\n\t<Number>{vi}</Number>\n'
              f'\t<Title>Volume {vi}</Title>\n'
              f'\t<PageCount>{page}</PageCount>\n\t<Manga>YesAndRightToLeft</Manga>\n'
              '</ComicInfo>\n')
        out.writestr("ComicInfo.xml", ci.encode())
    nums = ", ".join(f"{chapnum(f):g}" for f in vol_files)
    open(os.path.join(OUT_DIR, f"Volume {vi}.cbz"), "wb").write(buf.getvalue())
    print(f"Volume {vi}: ch [{nums}] -> {page} pages")
