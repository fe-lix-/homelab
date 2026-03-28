#!/usr/bin/env python3
"""
get-widevine-keys.py  — extract Widevine content keys for a Joyn video.

Usage:
    python3 get-widevine-keys.py <video_id> <path/to/device.wvd>

Example:
    python3 get-widevine-keys.py a_pt5fm8rzl3q ./device.wvd

Output (printed to stdout, one line per key):
    KID:KEY

These can then be passed to ffmpeg:
    JOYN_DECRYPTION_KEYS="KID1:KEY1,KID2:KEY2" ts-node src/...

Or to N_m3u8DL-RE:
    N_m3u8DL-RE "manifest.m3u8" --key "KID1:KEY1" --key "KID2:KEY2"

Requirements:
    pip3 install pywidevine requests
    A .wvd device file (Widevine Device blob, extracted from Android/Chrome).
    Proxy is NOT needed here — the license server is accessible directly once
    you have a valid licenseUrl from the playlist API.

How to get a .wvd file:
    Option A: Extract from an Android device using WVExtractor (adb + Frida).
    Option B: Use a Chrome Widevine extractor browser extension.
    See: https://github.com/hyugogirubato/KeyDive for more details.
"""

import sys
import os
import json
import struct
import base64
import requests
from pathlib import Path

# We call the Node.js service to get the playlist info (manifestUrl + licenseUrl)
import subprocess


def get_playlist_info(video_id: str) -> dict:
    """Call the JoynArr Node service to get playlist info including licenseUrl."""
    script = f"""
process.env.BRIGHTDATA_PROXY_URL = process.env.BRIGHTDATA_PROXY_URL || '';
const {{ getPlaybackInfo }} = require('./src/services/joyn');
getPlaybackInfo('{video_id}').then(info => {{
    console.log(JSON.stringify(info));
}}).catch(err => {{
    console.error(err.message);
    process.exit(1);
}});
"""
    result = subprocess.run(
        ['npx', 'ts-node', '--eval', script],
        capture_output=True, text=True, timeout=60,
        cwd=Path(__file__).parent
    )
    if result.returncode != 0:
        raise RuntimeError(f"Failed to get playlist info: {result.stderr}")
    return json.loads(result.stdout.strip())


def get_pssh_from_manifest(manifest_url: str) -> str:
    """Fetch the HLS master manifest and extract the Widevine PSSH."""
    resp = requests.get(manifest_url, timeout=15)
    resp.raise_for_status()
    for line in resp.text.splitlines():
        if 'KEYFORMAT="urn:uuid:edef8ba9' in line:
            # Extract URI="data:text/plain;base64,<PSSH>"
            import re
            m = re.search(r'URI="data:text/plain;base64,([^"]+)"', line)
            if m:
                return m.group(1)
    raise ValueError("Widevine PSSH not found in manifest")


def get_content_keys(video_id: str, wvd_path: str) -> list[dict]:
    """Full Widevine flow: cert → challenge → license → keys."""
    from pywidevine.cdm import Cdm
    from pywidevine.device import Device
    from pywidevine.pssh import PSSH

    print(f"[1] Getting playlist info for {video_id}...", file=sys.stderr)
    info = get_playlist_info(video_id)
    manifest_url = info['manifestUrl']
    license_url = info['licenseUrl']
    cert_url = info.get('certificateUrl')

    print(f"[2] Fetching PSSH from manifest...", file=sys.stderr)
    pssh_b64 = get_pssh_from_manifest(manifest_url)
    pssh = PSSH(pssh_b64)
    print(f"    PSSH: {pssh_b64[:40]}...", file=sys.stderr)

    print(f"[3] Loading Widevine device from {wvd_path}...", file=sys.stderr)
    device = Device.load(wvd_path)
    cdm = Cdm.from_device(device)
    session_id = cdm.open()

    try:
        # Fetch and set service certificate (optional but reduces privacy leakage)
        if cert_url:
            print(f"[4] Fetching service certificate...", file=sys.stderr)
            cert_resp = requests.get(cert_url, timeout=15)
            if cert_resp.ok:
                cdm.set_service_certificate(session_id, cert_resp.content)
                print(f"    Certificate set.", file=sys.stderr)

        print(f"[5] Generating license challenge...", file=sys.stderr)
        challenge = cdm.get_license_challenge(session_id, pssh)

        print(f"[6] Posting challenge to license server...", file=sys.stderr)
        lic_resp = requests.post(
            license_url,
            data=challenge,
            headers={
                'Content-Type': 'application/octet-stream',
                'Origin': 'https://www.joyn.de',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            },
            timeout=30,
        )
        lic_resp.raise_for_status()
        print(f"    License HTTP {lic_resp.status_code}, {len(lic_resp.content)} bytes", file=sys.stderr)

        print(f"[7] Parsing license and extracting keys...", file=sys.stderr)
        cdm.parse_license(session_id, lic_resp.content)

        keys = []
        for key in cdm.get_keys(session_id):
            if key.type == 'CONTENT':
                keys.append({'kid': key.kid.hex, 'key': key.key.hex()})
                print(f"    KEY: {key.kid.hex}:{key.key.hex()}", file=sys.stderr)

        return keys
    finally:
        cdm.close(session_id)


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)

    video_id = sys.argv[1]
    wvd_path = sys.argv[2]

    if not Path(wvd_path).exists():
        print(f"Error: .wvd file not found: {wvd_path}", file=sys.stderr)
        sys.exit(1)

    keys = get_content_keys(video_id, wvd_path)
    if not keys:
        print("No CONTENT keys found in license response!", file=sys.stderr)
        sys.exit(1)

    # Print keys to stdout in KID:KEY format (for use with ffmpeg/N_m3u8DL-RE)
    for k in keys:
        print(f"{k['kid']}:{k['key']}")


if __name__ == '__main__':
    main()
