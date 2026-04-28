# Domains

All domains terminated by nginx on `kazad-dum`. "Public" means the name has a public DNS A record pointing to the WAN IP and the nginx server block accepts external traffic. "LAN/VPN only" means the name resolves only to `10.0.0.163` (split DNS) and/or the server block uses `local_guard()` to refuse non-LAN clients.

Reachability summary (verified by `dig` against public DNS):

- Public WAN IP (`85.85.191.50`): `lab.delval.eu`, `home.delval.eu`, `paul.delval.eu` (CNAME → `home.delval.eu`), `atomic313.cloud`, `auth.lab.delval.eu`, `ntfy.lab.delval.eu` (CNAME → `home.delval.eu`)
- Private LAN IP (`10.0.0.163`): every other `*.lab.delval.eu` — only reachable from the LAN or VPN

Public reachability still requires the router's 80/443 forward to be active and the matching nginx `server_name` block to exist.

## Public-facing

### `home.delval.eu`
External entry point. Has its own LE cert (wildcard only covers `*.lab.delval.eu`).

| Path | Maps to |
|------|---------|
| `/` | Landing page (`landing.html`) |
| `/v/...` | Goploader download links (no auth — key in URL) |
| `/minecraft` | Minecraft IP-whitelist portal (Authelia, group `minecraft`) |
| `/favicon.ico` | Static favicon |

### `lab.delval.eu`
Public alias for the homepage / dashboard.

| Path | From public internet | From LAN |
|------|----------------------|----------|
| `/` | Landing page (`landing.html`) | Homepage dashboard |
| `/v/...` | Goploader downloads | Goploader downloads |
| `/minecraft` | Minecraft whitelist portal (Authelia) | Same |
| `/favicon.ico` | Static favicon | Static favicon |

### `paul.delval.eu`
Paul's static games. CNAME to `home.delval.eu` so it inherits the WAN IP. Own LE cert. Serves `/srv/games` with autoindex.

### `atomic313.cloud`
Alias for `paul.delval.eu` — same content, separate LE cert.

### `auth.lab.delval.eu`
Authelia SSO portal. Public DNS (resolves to WAN IP) and no `local_guard()`, so it is internet-reachable. Authelia handles its own auth and rate-limits `/api/firstfactor` and `/api/secondfactor`.

### `ntfy.lab.delval.eu`
ntfy push notification server. CNAME to `home.delval.eu` (WAN IP), no `local_guard()` — needed so mobile clients can subscribe over cellular. No nginx-layer auth (ntfy enforces its own access control).

## LAN / VPN only

All `*.lab.delval.eu` names below resolve only to `10.0.0.163`, so they are not reachable from the public internet even without a `local_guard()`. All proxy `/` to the named service unless noted.

| Domain | Service | Auth |
|--------|---------|------|
| `homepage.lab.delval.eu` | Homepage dashboard (same block as `lab.delval.eu`) | None |
| `comics.lab.delval.eu` | Komga | OIDC (`comics`) |
| `jellyfin.lab.delval.eu` | Jellyfin | OIDC (`jellyfin`) or native |
| `torrent.lab.delval.eu` | qBittorrent | Authelia forward-auth (`torrent`) |
| `sonarr.lab.delval.eu` | Sonarr | Authelia forward-auth (`arr-stack`) |
| `radarr.lab.delval.eu` | Radarr | Authelia forward-auth (`arr-stack`) |
| `lidarr.lab.delval.eu` | Lidarr | Authelia forward-auth (`arr-stack`) |
| `prowlarr.lab.delval.eu` | Prowlarr | Authelia forward-auth (`arr-stack`) |
| `bazarr.lab.delval.eu` | Bazarr | Authelia forward-auth (`arr-stack`) |
| `mediathek.lab.delval.eu` | MediathekArr | Authelia forward-auth (`arr-stack`) |
| `joynarr.lab.delval.eu` | JoynArr indexer | Authelia forward-auth (`arr-stack`) |
| `uptime.lab.delval.eu` | Uptime Kuma — `/status/*`, `/api/status-page/heartbeat/*`, `/api/push/*`, `/api/badge/*`, `/assets/`, `/upload/*`, `/icon.svg` are public; `/` is Authelia-protected | Mixed |
| `photos.lab.delval.eu` | Immich | OIDC (`photo`) |
| `grafana.lab.delval.eu` | Grafana | OIDC (`grafana`) |
| `ha.lab.delval.eu` | Home Assistant | Self (HA native auth + MFA) |
| `audiobooks.lab.delval.eu` | Audiobookshelf | OIDC (`audiobook`) |
| `files.lab.delval.eu` | Goploader — `/v/...` open downloads, `/` is landing page from public / Authelia-protected upload UI from LAN | Mixed |
| `docs.lab.delval.eu` | Paperless-ngx | Authelia forward-auth (`admin`) |
| `pihole.lab.delval.eu` | Pi-hole admin | Authelia forward-auth (`admin`) |
| `screentime.lab.delval.eu` | Screentime | Authelia forward-auth (`admin`) |
| `lldap.lab.delval.eu` | LLDAP user/group admin | Authelia forward-auth (`one_factor`, all users) |
| `unifi.lab.delval.eu` | UniFi controller (proxied to router) | UniFi self |
| `frigate.lab.delval.eu` | Frigate NVR (proxied to barad-dur) | — (see nginx config) |
| `manga-scheduler.lab.delval.eu` | Manga scheduler UI | Authelia forward-auth (`admin`) |

## Special

- **HTTP → HTTPS** (port 80): all server names redirect to HTTPS via 301
- **Unknown subdomain**: caught by `default_server` and 302-redirected to `homepage.lab.delval.eu`

## Sources

- nginx config: `roles/nginx/templates/default.conf.j2`
- Domain variables: `inventories/production/group_vars/all/main.yml` (`base_domain`, `paul_domain`, `paul_extra_domain`, `home_domain`)
- Authelia rules: `roles/authelia/templates/configuration.yml.j2`
