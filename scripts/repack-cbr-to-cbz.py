#!/usr/bin/env python3
"""One-time maintenance: repack every .cbr (RAR) under /work into .cbz (zip),
losslessly, so ComicInfo.xml can be written back into the archive (Komf can
update zip/cbz but not rar) and the whole library is uniform CBZ.

Runs INSIDE the homelab/kcc-rar image (its 7z has the non-free RAR codec):

  docker run --rm \
    -v /srv/comics:/work \
    -v /opt/cbr-quarantine:/quarantine \
    -v /tmp/repack-cbr-to-cbz.py:/repack.py:ro \
    --entrypoint /opt/venv/bin/python3 \
    homelab/kcc-rar:latest /repack.py [--dry-run]

Safety: the original .cbr is MOVED to /quarantine/<relpath> (never deleted) and
only after the new .cbz is verified (entry count matches the extracted tree).
Original owner/group/mode are preserved on the new .cbz. Idempotent: skips a
.cbr if a same-stem .cbz already exists next to it.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

WORK = Path("/work")
QUARANTINE = Path("/quarantine")
DRY_RUN = "--dry-run" in sys.argv


def count_files(root: Path) -> int:
    return sum(1 for p in root.rglob("*") if p.is_file())


def repack(cbr: Path) -> tuple[bool, str]:
    dest = cbr.with_suffix(".cbz")
    if dest.exists():
        return False, "skip (.cbz already exists)"
    if DRY_RUN:
        return True, "would repack"

    st = cbr.stat()
    with tempfile.TemporaryDirectory(dir="/tmp") as tmp:
        extract = Path(tmp) / "x"
        extract.mkdir()
        r = subprocess.run(
            ["7z", "x", "-y", f"-o{extract}", str(cbr)],
            capture_output=True, text=True)
        if r.returncode != 0:
            return False, f"FAILED extract: {r.stderr.strip()[-200:]}"
        src_n = count_files(extract)
        if src_n == 0:
            return False, "FAILED: no files extracted"

        out = Path(tmp) / "out.cbz"
        # -mx=0 = store (images are already compressed; no point re-deflating)
        r = subprocess.run(
            ["7z", "a", "-tzip", "-mx=0", str(out), "."],
            cwd=extract, capture_output=True, text=True)
        if r.returncode != 0:
            return False, f"FAILED zip: {r.stderr.strip()[-200:]}"

        with zipfile.ZipFile(out) as z:
            zip_n = sum(1 for i in z.infolist() if not i.is_dir())
        if zip_n != src_n:
            return False, f"FAILED verify: {src_n} extracted vs {zip_n} in cbz"

        # Verified — quarantine original, then place the new cbz.
        qpath = QUARANTINE / cbr.relative_to(WORK)
        qpath.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(cbr), str(qpath))
        shutil.move(str(out), str(dest))
        os.chown(dest, st.st_uid, st.st_gid)
        os.chmod(dest, st.st_mode & 0o7777)
        return True, f"repacked ({src_n} entries)"


def main():
    cbrs = sorted(p for p in WORK.rglob("*")
                  if p.is_file() and p.suffix.lower() == ".cbr")
    print(f"{'DRY RUN — ' if DRY_RUN else ''}found {len(cbrs)} .cbr file(s)\n")
    ok = skipped = failed = 0
    cur_series = None
    for cbr in cbrs:
        series = cbr.relative_to(WORK).parts[0]
        if series != cur_series:
            cur_series = series
            print(f"\n## {series}")
        done, msg = repack(cbr)
        if msg.startswith("FAILED"):
            failed += 1
            print(f"  !! {cbr.name}: {msg}")
        elif msg.startswith("skip"):
            skipped += 1
            print(f"  -- {cbr.name}: {msg}")
        else:
            ok += 1
            print(f"  ok {cbr.name}: {msg}")
    print(f"\n{'(dry run) ' if DRY_RUN else ''}done: "
          f"{ok} repacked, {skipped} skipped, {failed} failed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
