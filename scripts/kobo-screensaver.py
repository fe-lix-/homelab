#!/usr/bin/env python3
"""Prepare Kobo Clara Colour sleep-screen images from Pinterest URLs (or local
images): download → crop to the screen resolution → boost contrast/saturation
for the Kaleido 3 color filter → write Kobo-ready JPEGs.

Examples:
  # A Pinterest board + a single pin -> ./kobo-screensavers/
  ./kobo-screensaver.py https://www.pinterest.com/user/board/ https://www.pinterest.com/pin/123/

  # Local folder of images, write straight onto a mounted Kobo
  ./kobo-screensaver.py ~/Pictures/walls --out "/Volumes/KOBOeReader/.kobo/screensaver"

Deps: pip3 install --user gallery-dl Pillow   (gallery-dl only needed for URLs)
On the Kobo afterwards: Settings → Screensaver → tick "Show current read" +
"Show book covers full screen" (that's what makes it read the screensaver folder).
"""
import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    from PIL import Image, ImageOps, ImageEnhance
except ImportError:
    sys.exit("Pillow not installed. Run: pip3 install --user Pillow")

IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}
# Kobo Clara Colour panel resolution (portrait)
W, H = 1072, 1448


def is_url(s):
    return s.startswith("http://") or s.startswith("https://")


def gallery_dl(url, dest):
    if not shutil_which("gallery-dl"):
        sys.exit("gallery-dl not installed (needed for URLs). Run: pip3 install --user gallery-dl")
    print(f"  downloading {url}")
    r = subprocess.run(["gallery-dl", "-D", str(dest), url])
    if r.returncode != 0:
        print(f"  !! gallery-dl failed for {url}")


def shutil_which(name):
    from shutil import which
    return which(name)


def collect_images(args_inputs, workdir):
    """Return a list of source image paths from URLs (downloaded) and local paths."""
    paths = []
    for item in args_inputs:
        if is_url(item):
            d = Path(tempfile.mkdtemp(dir=workdir))
            gallery_dl(item, d)
            paths += [p for p in d.rglob("*") if p.suffix.lower() in IMG_EXTS]
        else:
            p = Path(item).expanduser()
            if p.is_dir():
                paths += [c for c in p.rglob("*") if c.suffix.lower() in IMG_EXTS]
            elif p.is_file() and p.suffix.lower() in IMG_EXTS:
                paths.append(p)
            else:
                print(f"  skip (not an image/dir/url): {item}")
    return paths


def process(src, dst, contrast, saturation, brightness):
    img = Image.open(src)
    img = ImageOps.exif_transpose(img)          # honor camera/phone rotation
    img = img.convert("RGB")
    img = ImageOps.fit(img, (W, H), Image.LANCZOS)   # fill + center-crop to panel
    if brightness != 1.0:
        img = ImageEnhance.Brightness(img).enhance(brightness)
    if contrast != 1.0:
        img = ImageEnhance.Contrast(img).enhance(contrast)
    if saturation != 1.0:
        img = ImageEnhance.Color(img).enhance(saturation)
    img.save(dst, "JPEG", quality=90)


def main():
    ap = argparse.ArgumentParser(description="Make Kobo Clara Colour screensaver images")
    ap.add_argument("inputs", nargs="+", help="Pinterest URLs, image files, or folders")
    ap.add_argument("--out", default="~/Documents/kobo-screensavers",
                    help="output dir (default ~/Documents/kobo-screensavers; kept out of the repo)")
    ap.add_argument("--contrast", type=float, default=1.15)
    ap.add_argument("--saturation", type=float, default=1.25)
    ap.add_argument("--brightness", type=float, default=1.0)
    ap.add_argument("--prefix", default="ss", help="output filename prefix")
    args = ap.parse_args()

    out = Path(args.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as workdir:
        sources = collect_images(args.inputs, workdir)
        if not sources:
            sys.exit("No images found.")
        print(f"Processing {len(sources)} image(s) -> {out}  ({W}x{H})")
        n = ok = 0
        existing = len([p for p in out.glob(f"{args.prefix}*.jpg")])
        for src in sorted(sources):
            n += 1
            dst = out / f"{args.prefix}{existing + n:03d}.jpg"
            try:
                process(src, dst, args.contrast, args.saturation, args.brightness)
                ok += 1
            except Exception as e:
                print(f"  !! {src.name}: {e}")
        print(f"Done: {ok}/{n} written to {out}")
        if "KOBOeReader" not in str(out):
            print("Copy these into  <Kobo>/.kobo/screensaver/  then enable the Screensaver settings.")


if __name__ == "__main__":
    main()
