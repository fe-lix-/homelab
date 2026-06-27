#!/usr/bin/env python3
"""Propose tome boundaries for a Honzuki Temporada by clustering consecutive
chapters that share an early (cover) page image. Decimal chapters (X.5) bind to
their integer chapter X. Output only — prints a proposal to verify, no bundling."""
import os, re, sys, zipfile, hashlib
from collections import defaultdict

SERIES_DIR = sys.argv[1]
EXPECTED = sys.argv[2] if len(sys.argv) > 2 else "?"   # official volume count, for sanity
IMG = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif")
FRONT = 4   # how many leading pages to consider as cover candidates


def chapnum(f):
    m = re.search(r"Cap[ií]tulo\s+([0-9]+(?:\.[0-9]+)?)", f)
    return float(m.group(1)) if m else None


def natkey(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


# group files into integer-chapter units
units = defaultdict(list)
for f in os.listdir(SERIES_DIR):
    if not f.lower().endswith(".cbz") or "aviso" in f.lower():
        continue
    c = chapnum(f)
    if c is not None:
        units[int(c)].append(f)
order = sorted(units)


def unit_info(x):
    files = sorted(units[x], key=chapnum)
    front, pages = [], 0
    for i, f in enumerate(files):
        with zipfile.ZipFile(os.path.join(SERIES_DIR, f)) as z:
            imgs = sorted([n for n in z.namelist() if n.lower().endswith(IMG)], key=natkey)
            pages += len(imgs)
            if i == 0:
                front = [hashlib.md5(z.read(n)).hexdigest()[:10] for n in imgs[:FRONT]]
    return set(front), pages


info = {x: unit_info(x) for x in order}

# cluster: consecutive units sharing any front-page hash → same volume
vols, cur = [], [order[0]]
for a, b in zip(order, order[1:]):
    if info[a][0] & info[b][0]:
        cur.append(b)
    else:
        vols.append(cur); cur = [b]
vols.append(cur)

print(f"\n=== {os.path.basename(SERIES_DIR)} — detected {len(vols)} volume(s) (official: {EXPECTED}) ===")
for vi, v in enumerate(vols, 1):
    pages = sum(info[x][1] for x in v)
    chs = f"{v[0]}-{v[-1]}" if len(v) > 1 else f"{v[0]}"
    flag = "  ⚠️SINGLE" if len(v) == 1 else ("  ⚠️SHORT" if pages < 120 else "")
    print(f"  Vol {vi:2}: ch {chs:>9}  ({len(v)} ch, {pages} pp){flag}")
