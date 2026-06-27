#!/usr/bin/env python3
"""Wait for the kcc-honzuki conversion to finish, then rescan the Kobo Komga
library, empty its trash, and report the Honzuki tome counts.
Usage: honzuki-kobo-finish.py EMAIL PASS"""
import sys, json, base64, urllib.request, subprocess, time

email, pw = sys.argv[1], sys.argv[2]
KOBO = "0QQHGP1AVYBNQ"
auth = base64.b64encode(f"{email}:{pw}".encode()).decode()


def api(method, path):
    r = urllib.request.Request("http://127.0.0.1:25600" + path,
                               headers={"Authorization": f"Basic {auth}"}, method=method)
    with urllib.request.urlopen(r, timeout=60) as resp:
        return resp.read() if method == "GET" else b""


def honzuki():
    raw = api("GET", f"/api/v1/series?library_id={KOBO}&search=Honzuki")
    return {s["name"]: s["booksCount"] for s in json.loads(raw)["content"]}


# 1. wait for the conversion unit to finish
while subprocess.run(["systemctl", "is-active", "--quiet", "kcc-honzuki"]).returncode == 0:
    time.sleep(20)
print("conversion finished")

# 2. rescan Kobo library, wait for T3 to reach 9 tomes (or timeout)
api("POST", f"/api/v1/libraries/{KOBO}/scan")
for _ in range(40):
    time.sleep(10)
    if honzuki().get("Honzuki No Gekokujou - Temporada 3", 0) >= 9:
        break

# 3. empty trash (clear any removed entries), report
api("POST", f"/api/v1/libraries/{KOBO}/empty-trash")
time.sleep(8)
print("=== Honzuki in Kobo library ===")
for name, n in sorted(honzuki().items()):
    print(f"  {name} -> {n}")
