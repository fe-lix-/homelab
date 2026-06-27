#!/usr/bin/env python3
"""Inject a curated <Writer> into the ComicInfo.xml of every CBZ in the named
series (the ones no metadata provider could author). Matches series folders by
lowercase substring (dodges special chars in folder names). Idempotent: skips a
CBZ that already has a non-empty <Writer>. Preserves owner/mode."""
import io
import os
import re
import shutil
import sys
import tempfile
import zipfile

# lowercase substring of folder name -> writer
AUTHORS = {
    "atelier des sorciers": "Kamome Shirahama",
    "awakens romance": "Nobuyuki Anzai",
    "titeuf": "Zep",
    "les sisters": "Christophe Cazenove, William",
    "harlock": "Leiji Matsumoto",
    "vecino totoro": "Hayao Miyazaki",
    "wolf children": "Mamoru Hosoda, Yu",
    "clear card": "CLAMP",
    "forastera": "Nagabe",
    "magu": "Kei Kamiki",
    "eyes only": "Tatsuya Endo",
    "honzuki": "Miya Kazuki, Suzuka",
    "hanzawa": "Mayuko Kanba",
    "wild police": "Gosho Aoyama, Takahiro Arai",
    "tea time": "Takahiro Arai",
}
ROOT = "/srv/comics"
HAS_WRITER = re.compile(r"<Writer>\s*\S")


def set_writer(xml: str, writer: str, series: str) -> str:
    if not xml.strip():
        return ('<?xml version="1.0" encoding="UTF-8"?>\n'
                '<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" '
                'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n'
                f'\t<Series>{series}</Series>\n\t<Writer>{writer}</Writer>\n</ComicInfo>\n')
    if "<Writer>" in xml:
        return re.sub(r"<Writer>.*?</Writer>", f"<Writer>{writer}</Writer>", xml, count=1, flags=re.S)
    return xml.replace("</ComicInfo>", f"\t<Writer>{writer}</Writer>\n</ComicInfo>", 1)


def process_cbz(path: str, writer: str, series: str) -> str:
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        ci = next((n for n in names if n.lower().endswith("comicinfo.xml")), None)
        existing = z.read(ci).decode("utf-8", "replace") if ci else ""
        if existing and HAS_WRITER.search(existing):
            return "skip"
        new_ci = set_writer(existing, writer, series)
        st = os.stat(path)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as out:
            for n in names:
                if n.lower().endswith("comicinfo.xml"):
                    continue
                out.writestr(z.getinfo(n), z.read(n))
            out.writestr("ComicInfo.xml", new_ci.encode("utf-8"))
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
    with os.fdopen(fd, "wb") as f:
        f.write(buf.getvalue())
    os.chown(tmp, st.st_uid, st.st_gid)
    os.chmod(tmp, st.st_mode & 0o7777)
    os.replace(tmp, path)
    return "written"


dirs = sorted(d for d in os.listdir(ROOT) if os.path.isdir(os.path.join(ROOT, d)))
for d in dirs:
    key = next((k for k in AUTHORS if k in d.lower()), None)
    if not key:
        continue
    writer = AUTHORS[key]
    p = os.path.join(ROOT, d)
    cbzs = sorted(f for f in os.listdir(p) if f.lower().endswith(".cbz"))
    w = s = 0
    for f in cbzs:
        try:
            r = process_cbz(os.path.join(p, f), writer, d)
            w += r == "written"
            s += r == "skip"
        except Exception as e:
            print(f"  !! {d}/{f}: {e}")
    print(f"{d}  ->  {writer}   ({w} written, {s} already had writer)")
print("done")
