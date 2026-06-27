#!/usr/bin/env python3
"""One-off: merge the case-variant "L'atelier des Sorciers" folder into the
canonical "L'Atelier des Sorciers" (Komga sees the two casings as separate
series). Moves the stray volumes in, renaming to "Volume N" for consistent
ordering, then removes the now-empty folder. Runs on both the source and Kobo
libraries. Idempotent: skips a file if the destination already exists."""
import os
import re
import shutil

CANON = "L'Atelier des Sorciers"
LOWER = "L'atelier des Sorciers"

for base in ("/srv/comics", "/srv/comics-kobo"):
    cdir = os.path.join(base, CANON)
    ldir = os.path.join(base, LOWER)
    if not os.path.isdir(ldir):
        print(f"[{base}] no '{LOWER}' folder, skip")
        continue
    os.makedirs(cdir, exist_ok=True)
    for f in sorted(os.listdir(ldir)):
        src = os.path.join(ldir, f)
        if not os.path.isfile(src):
            continue
        m = re.search(r"Tomo\s*(\d+)", f) or re.search(r"(\d+)", f)
        num = m.group(1) if m else os.path.splitext(f)[0]
        if f.endswith(".kepub.epub"):
            ext = ".kepub.epub"
        elif f.lower().endswith((".cbz", ".cbr")):
            ext = os.path.splitext(f)[1]
        else:
            ext = os.path.splitext(f)[1]
        dst = os.path.join(cdir, f"Volume {num}{ext}")
        if os.path.exists(dst):
            print(f"[{base}] SKIP (exists): Volume {num}{ext}")
            continue
        shutil.move(src, dst)
        print(f"[{base}] {f}  ->  Volume {num}{ext}")
    leftover = os.listdir(ldir)
    if not leftover:
        os.rmdir(ldir)
        print(f"[{base}] removed empty '{LOWER}'")
    else:
        print(f"[{base}] NOT removed, still contains: {leftover}")
