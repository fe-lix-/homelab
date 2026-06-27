#!/usr/bin/env python3
"""List series in the main Komga library that still have no author (book-level)."""
import sys, json, base64, urllib.request

email, pw = sys.argv[1], sys.argv[2]
LIB = "0PPDTQP8W026N"
auth = base64.b64encode(f"{email}:{pw}".encode()).decode()


def get(path):
    req = urllib.request.Request("http://127.0.0.1:25600" + path,
                                 headers={"Authorization": f"Basic {auth}"})
    return json.load(urllib.request.urlopen(req, timeout=30))


series, page = [], 0
while True:
    d = get(f"/api/v1/series?library_id={LIB}&size=100&page={page}")
    series += d["content"]
    if d["last"]:
        break
    page += 1

unident = []
for s in series:
    b = get(f"/api/v1/series/{s['id']}/books?size=1")
    authors = b["content"][0]["metadata"].get("authors", []) if b["content"] else []
    if not authors:
        unident.append(s["name"])

print(f"total series: {len(series)} | unidentified (no author): {len(unident)}\n")
for n in sorted(unident):
    print("  -", n)
