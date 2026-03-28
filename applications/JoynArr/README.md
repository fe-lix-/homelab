# JoynArr

A bridge between [Joyn.de](https://www.joyn.de) (German free streaming) and the \*arr ecosystem (Sonarr, Radarr, Prowlarr). Exposes a **Newznab indexer** and a **SABnzbd-compatible downloader** so Sonarr/Radarr can search Joyn like a normal indexer and trigger direct downloads — fully automated including Widevine DRM decryption.

---

## How It Works

```
Sonarr/Radarr
    │  Newznab search (port 5008)
    ▼
JoynArr Indexer ──► Joyn GraphQL API ──► Episode list
    │  SABnzbd add NZB (port 5007)
    ▼
JoynArr Downloader
    ├─ Joyn 3-step auth (anonymous token → entitlement token → HLS manifest)
    ├─ Widevine key extraction (RemoteCDM via cdrm-project.com)
    ├─ Raw HLS segment download → .enc.video.mp4 + .enc.audio.mp4 (parallel)
    ├─ mp4decrypt → .dec.video.mp4 + .dec.audio.mp4
    └─ ffmpeg  → remux → ShowName.S01E03.GERMAN.1080p.WEB.h264-JOYN.mkv
```

---

## Requirements

| Tool | Purpose | Install |
|------|---------|---------|
| **Node.js 22** | Runtime | `nvm install 22` |
| **ffmpeg** | HLS download + remux | `brew install ffmpeg` / `apt install ffmpeg` |
| **mp4decrypt** (Bento4) | CENC decryption | `brew install bento4` / see Dockerfile |
| **SOCKS5/HTTP proxy** | German IP for auth | BrightData residential or similar |

---

## Quick Start

### 1. Clone & install

```bash
git clone <repo>
cd JoynArr
npm install
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env — see Configuration section below
```

### 3. Run (development)

```bash
npm run dev
```

### 4. Run (production)

```bash
npm run build
npm start
```

### 5. Docker

```bash
docker compose up -d
```

---

## Configuration

Copy `.env.example` to `.env` and fill in:

```env
# --- Ports ---
INDEXER_PORT=5008       # Newznab API (add to Sonarr/Prowlarr as indexer)
DOWNLOADER_PORT=5007    # SABnzbd API (add to Sonarr/Prowlarr as download client)

# --- Storage ---
DOWNLOAD_FOLDER_PATH_MAPPING=/downloads/completed
# Path inside Docker where downloads land — map this to your media library

# --- Joyn API ---
JOYN_API_BASE_URL=https://api.joyn.de     # Default, no change needed
JOYN_API_KEY=4f0fd9f18abbe3cf0e87fdb556bc39c8   # From Joyn's Next.js bundle

# --- TVDB proxy ---
TVDB_API_BASE_URL=https://your-tvdb-proxy/api/v1
# Required for TVDB ID lookups (Sonarr sends tvdbid).
# Must expose: GET /shows/{tvdbid} → { name, germanName, ... }

# --- German IP proxy (required for auth) ---
BRIGHTDATA_PROXY_URL=socks5://user:pass@host:port
# Supports socks5:// and http:// proxies.
# Only used for auth.joyn.de + entitlement.p7s1.io — CDN downloads go direct.

# --- Widevine / RemoteCDM ---
REMOTE_CDM_HOST=https://cdrm-project.com/remotecdm/widevine
REMOTE_CDM_SECRET=CDRM
REMOTE_CDM_DEVICE=public
# cdrm-project.com provides a free public L3 RemoteCDM.
# Self-host with: https://github.com/tpd94/cdrm-project
# Override with JOYN_DECRYPTION_KEYS=KID1:KEY1,KID2:KEY2 to skip auto-extraction.

# --- Timezone / Docker UID ---
TZ=Europe/Berlin
PUID=1000
PGID=1000
```

---

## Sonarr / Radarr Setup

### Indexer (Prowlarr or direct)

| Field | Value |
|-------|-------|
| Type | Newznab |
| URL | `http://localhost:5008` |
| API Path | `/api` |
| API Key | *(any non-empty string)* |
| Categories | `5040` (TV HD), `5030` (TV SD) |

### Download Client

| Field | Value |
|-------|-------|
| Type | SABnzbd |
| Host | `localhost` |
| Port | `5007` |
| URL Base | `/download` |
| API Key | *(any non-empty string)* |

---

## Download Pipeline (CENC-encrypted content)

All Joyn content is Widevine CENC encrypted. The pipeline is fully automated:

1. **3-step Joyn auth** (proxy required for German IP):
   - Anonymous token → entitlement token → HLS manifest + `licenseUrl`

2. **Widevine key extraction** via RemoteCDM:
   - Extract Widevine PSSH from HLS manifest
   - Open session on RemoteCDM server
   - Generate CDM license challenge
   - POST challenge to Joyn's license server → get license response
   - Parse response → extract `KID:KEY` pairs

3. **Download & decrypt**:
   - HLS master manifest parsed → highest-quality video variant + audio playlist selected
   - Video and audio segments downloaded as raw bytes (in parallel), concatenating init segment + all `.m4s` files — this preserves CENC `tenc`/`senc` encryption metadata that ffmpeg would otherwise strip
   - `mp4decrypt --key KID:KEY ...` decrypts video and audio tracks separately
   - `ffmpeg` remuxes with German language tags to final `.mkv`

To skip auto-extraction and use known keys directly:
```env
JOYN_DECRYPTION_KEYS=1ad21e5a...:fc6c40ff...,cdee814f...:e5aa4c35...
```

---

## Manual Key Extraction

If the RemoteCDM is unavailable, use the Python script with a local `.wvd` device file:

```bash
pip3 install pywidevine requests
python3 get-widevine-keys.py <video_id> ./device.wvd
# Output: KID:KEY pairs → set as JOYN_DECRYPTION_KEYS
```

To get a `.wvd` file: [KeyDive](https://github.com/hyugogirubato/KeyDive) (Android device required).

---

## File Naming

Downloaded files follow scene naming conventions:

```
# Standard episode
Inside.FBI.Die.haertesten.Faelle.S01E08.Die.Beltway.Snipers.GERMAN.1080p.WEB.h264-JOYN.mkv

# Daily show
Guten.Morgen.Deutschland.2024.03.15.GERMAN.1080p.WEB.h264-JOYN.mkv
```

Quality variants exposed per episode: `1080p`, `720p`, `480p`.

---

## Project Structure

```
src/
├── app.ts                   # Bootstrap: starts indexer + downloader servers
├── indexer/
│   ├── routes.ts            # GET /api — Newznab search endpoints
│   ├── search.ts            # Query Joyn, build RSS results
│   ├── caps.ts              # Newznab capabilities XML
│   └── nzb.ts               # Fake NZB generation
├── downloader/
│   ├── routes.ts            # SABnzbd-compatible API
│   ├── download.ts          # Download orchestration (resolve → keys → download)
│   ├── ffmpeg.ts            # HLS download, mp4decrypt, remux
│   └── queue.ts             # In-memory queue + history
├── services/
│   ├── joyn.ts              # GraphQL client + 3-step playback auth
│   ├── widevine.ts          # RemoteCDM key extraction pipeline
│   ├── tvdb.ts              # TVDB show metadata
│   └── cache.ts             # LRU cache (55 min TTL)
└── utils/
    ├── title.ts             # Scene-format release name generation
    ├── xml.ts               # XML/RSS/Newznab builders
    └── semaphore.ts         # Concurrency limiter (max 2 downloads)
```

---

## Joyn API Notes

- GraphQL endpoint: `https://api.joyn.de/graphql`
- Headers: `x-api-key: 4f0fd9f18abbe3cf0e87fdb556bc39c8`, `Joyn-Platform: web`
- `episode.video.id` is the VOD asset ID used as `joyn-vod://<id>`
- Free content: `licenseTypes: ["AVOD"]`; Plus content: `["SVOD"]`
- Auth steps 1 & 2 **require a German IP** — use proxy
- Entitlement token expires in ~120 seconds — download must start promptly

---

## Docker

The `Dockerfile` installs ffmpeg and mp4decrypt (Bento4) automatically.

```bash
docker compose up -d
```

Volumes:
- `./downloads` → `/app/downloads` — where files are written
- `./ffmpeg` → `/app/ffmpeg` — optional local ffmpeg binary override

---

## License

For personal use only. Joyn's ToS prohibits automated downloading.
