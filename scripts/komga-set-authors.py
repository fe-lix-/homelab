#!/usr/bin/env python3
"""Set book-level authors for every book in a Komga series (used for formats with
no embeddable ComicInfo, e.g. PDFs). Usage: komga-set-authors.py EMAIL PASS SERIES_ID "Author Name"."""
import sys, json, base64, urllib.request

email, pw, sid, author = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
auth = base64.b64encode(f"{email}:{pw}".encode()).decode()
HDR = {"Authorization": f"Basic {auth}", "Content-Type": "application/json"}


def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request("http://127.0.0.1:25600" + path, data=data, headers=HDR, method=method)
    with urllib.request.urlopen(r, timeout=30) as resp:
        return resp.status, (resp.read() if method == "GET" else b"")


_, raw = req("GET", f"/api/v1/series/{sid}/books?size=100")
books = json.loads(raw)["content"]
roles = ["writer", "penciller"]
payload = {"authors": [{"name": author, "role": r} for r in roles], "authorsLock": True}
for b in books:
    status, _ = req("PATCH", f"/api/v1/books/{b['id']}/metadata", payload)
    print(f"  {b['name']}: HTTP {status}")
print(f"set '{author}' on {len(books)} book(s)")
