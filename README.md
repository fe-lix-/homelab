# Homelab

Ansible playbook to provision and manage a single Ubuntu server running Docker-based self-hosted services.

## Services

| Service | Description | Subdomain |
|---------|-------------|-----------|
| Jellyfin | Media server | `jellyfin.homelab.example.com` |
| Komga | Comic & manga library | `comics.homelab.example.com` |
| Sonarr | TV show management | `sonarr.homelab.example.com` |
| Radarr | Movie management | `radarr.homelab.example.com` |
| Lidarr | Music management | `lidarr.homelab.example.com` |
| Prowlarr | Indexer manager | `prowlarr.homelab.example.com` |
| Bazarr | Subtitle management | `bazarr.homelab.example.com` |
| MediathekArr | German public TV indexer (routed via VLAN 30 German VPN) | `mediathek.homelab.example.com` |
| JoynArr | Joyn.de streaming bridge for *arr (Newznab indexer + SABnzbd downloader) | `joynarr.homelab.example.com` |
| qBittorrent | BitTorrent client | `torrent.homelab.example.com` |
| Immich | Photo & video management | `photos.homelab.example.com` |
| Audiobookshelf | Audiobook & podcast server | `audiobooks.homelab.example.com` |
| Grafana | Dashboards & logs (+ Loki + Alloy + systemd journal) | `grafana.homelab.example.com` |
| Authelia | SSO & access control | `auth.homelab.example.com` |
| LLDAP | Lightweight LDAP user directory (self-service profile editing for all users) | `lldap.homelab.example.com` |
| Home Assistant | Home automation | `ha.homelab.example.com` |
| Goploader | Encrypted file sharing | `files.homelab.example.com` (downloads via `homelab.example.com/v/`) |
| Paperless-ngx | Document management & OCR | `docs.homelab.example.com` |
| Uptime Kuma | Uptime monitoring | `uptime.homelab.example.com` |
| Pi-hole | DNS ad blocker | `pihole.homelab.example.com` |
| Minecraft | PaperMC 1.20.4 (offline mode, LAN only) | `YOUR_SERVER_IP:25565` (direct TCP, UFW-restricted to 10.0.0.0/8) |
| Homepage | Dashboard | `homelab.example.com` |
| manga-scheduler | Drip-feeds manga from `/srv/uploads/mangas` into Komga library every 2 days (systemd timer) | — |
| ntfy | Push notification server (publicly accessible, ntfy built-in auth) | `ntfy.homelab.example.com` |
| Screen Time | Kids screen time monitoring via Pi-hole DNS analysis | `screentime.homelab.example.com` |
| Paul's Games | Static public-facing games site, content uploaded via the Samba `games` share (`@games-rw`) | `paul.delval.eu` (own LE cert, public-facing) |

## Architecture

- All services run as Docker Compose stacks behind an nginx reverse proxy with HTTPS
- Wildcard TLS certificate via Let's Encrypt + Gandi DNS-01 challenge (`*.homelab.example.com`)
- **DNS & port forwarding:**
  - Router forwards ports 80 and 443 to the server
  - `homelab.example.com` A record → public IP (internet-reachable)
  - `*.homelab.example.com` A record → `YOUR_SERVER_IP` (LAN only, not reachable from the internet)
- **Public internet access** at `homelab.example.com`:
  - `/v/...` — Goploader encrypted file downloads (open, decryption key in URL)
  - `/` — static landing page for public visitors, Homepage dashboard for local users
  - Everything else is LAN-only via the `geo` block (`local_guard()` macro)
- **Authelia SSO** — centralized authentication and access control:
  - **Forward-auth** (proxy-level) for: arr stack, qBittorrent, Uptime Kuma (dashboard only — status pages are public), Goploader (uploads only — downloads are open)
  - **OIDC** (native integration, `consent_mode: implicit`) for: Grafana, Komga, Immich, Audiobookshelf, Jellyfin. Group enforcement uses `authorization_policies` in the OIDC config (not `access_control` rules, which don't apply to OIDC flows).
  - **Own auth**: Home Assistant (built-in auth + Nabu Casa for remote access)
  - **LLDAP** as user directory — Authelia connects via `ldap://lldap:3890` on the shared `auth-internal` Docker network. All authenticated users can reach `lldap.homelab.example.com` for self-service profile editing.
  - Groups: `admin` (everything), `arr-stack`, `audiobook`, `comics`, `filesharing`, `grafana`, `jellyfin`, `minecraft`, `photo`, `torrent`
- Security headers on all HTTPS responses (HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy)
- Local network access guard (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) — includes WireGuard VPN subnet (`192.168.4.0/24`), so VPN clients have full service access
- **WireGuard VPN** — UniFi Cloud Gateway Ultra serves a WireGuard VPN on `192.168.4.0/24` (port 51820). Use `Endpoint = YOUR_ROUTER_IP:51820` from LAN, `Endpoint = YOUR_PUBLIC_IP:51820` from internet (NAT hairpin prevents using the public IP from inside). The server has a static route to `192.168.4.0/24` via `YOUR_ROUTER_IP` (managed by the `base` role via netplan).
- UFW firewall + hardened SSH (key-only, no root login, port 22 not forwarded from internet)
- **German VPN VLAN** — Router provides VLAN 30 (`10.0.30.0/24`) with a German VPN exit. MediathekArr uses a Docker macvlan on this VLAN to access geo-restricted German public broadcaster content (ARD, ZDF, WDR, etc.). The container requires `cap_add: NET_ADMIN` for route manipulation; standard hardening options (`cap_drop: ALL`, `no-new-privileges`, `read_only`) are incompatible with the base image's root-init/gosu-drop startup pattern and cause crash-loops.
- **Brother MFC-L2800DW scanner** — brscan5 + brscan-skey on the host (not Docker) listens for scan button presses on UDP 54925. FILE button scans to Paperless consume dir; OCR button scans to `consume/double-sided/` for Paperless automatic front/back collation of double-sided documents. See `roles/brscan/SOLUTION.md` for full technical details.
- Samba file sharing (`/srv`) with read-only, read-write, and guest upload groups
- 3-2-1 backup strategy with restic (local + Backblaze B2)
- Uptime monitoring with push-based health checks for backups

## Prerequisites

- Ubuntu server with SSH access
- Ansible 2.15+
- Required collections: `ansible-galaxy collection install -r requirements.yml`

## Setup

1. Clone this repo
2. Update `inventories/production/hosts.yml` with your server IP
3. Create a vault file for secrets:
   ```bash
   make vault-create
   ```
   Required variables:
   ```yaml
   backup_restic_password: ""
   backup_b2_account_id: ""
   backup_b2_account_key: ""
   backup_healthcheck_url: ""
   immich_db_password: ""
   uptime_kuma_username: ""
   uptime_kuma_password: ""
   certbot_gandi_api_key: ""
   certbot_email: ""
   grafana_admin_password: ""
   authelia_jwt_secret: ""
   authelia_session_secret: ""
   authelia_storage_encryption_key: ""
   authelia_oidc_hmac_secret: ""       # openssl rand -hex 32
   authelia_grafana_oidc_secret: ""    # openssl rand -hex 32
   authelia_immich_oidc_secret: ""     # openssl rand -hex 32
   authelia_jellyfin_oidc_secret: ""   # openssl rand -hex 32
   authelia_komga_oidc_secret: ""              # openssl rand -hex 32
   authelia_audiobookshelf_oidc_secret: ""    # openssl rand -hex 32
   paperless_db_password: ""               # openssl rand -hex 16
   paperless_secret_key: ""               # openssl rand -hex 32
   vault_router_ssh_password: ""   # UniFi router root SSH password
   pihole_admin_password: ""
   ntfy_admin_password: ""
   lldap_admin_password: ""
   lldap_jwt_secret: ""                   # openssl rand -hex 32
   lldap_bind_password: ""               # password for svc-authelia LDAP bind user (create manually in LLDAP UI)
   authelia_users:
     - username: YOUR_USERNAME
       display_name: "YOUR_DISPLAY_NAME"
       password_hash: "$argon2id$..."  # generate with: docker run authelia/authelia:latest authelia crypto hash generate argon2
       email: "you@homelab.example.com"
       groups: [admin]
   samba_users:
     - name: YOUR_USERNAME
       password: ""
       groups: [samba-rw]
   ```
4. Optionally store vault password for convenience:
   ```bash
   echo 'your-vault-password' > ~/.config/vaultpass
   chmod 600 ~/.config/vaultpass
   ```
5. Deploy:
   ```bash
   make deploy
   ```

## Make Targets

| Command | Description |
|---------|-------------|
| `make deploy` | Deploy full playbook |
| `make deploy-role ROLE=x` | Deploy a single role |
| `make collections` | Install Ansible collections |
| `make vault-edit` | Edit vault secrets |
| `make check` | Dry-run with diff |
| `make logs-backup` | View backup logs |
| `make logs-immich` | View Immich logs |
| `make versions` | Check for Docker image updates |
| `make versions-update` | Update all image versions to latest stable |
| `make dump-router` | Dump UniFi router config to `/tmp/router-dump/` |

## Backups

Restic runs daily at 03:00 via systemd timer. Backed up data:
- All service configs (`/opt/*/config`)
- Immich PostgreSQL database dump
- Photo library (`/srv/photos`)

Not backed up (replaceable): `/srv/media`, `/srv/comics`, `/srv/downloads`

## Manga Scheduler

`manga-scheduler` is a host-side systemd service (not Docker) that drip-feeds manga series from `/srv/uploads/mangas` into the Komga library at `/srv/comics` every 2 days. It picks the next series in round-robin order and moves ~100 MB of files per run. State is kept in `/opt/manga-scheduler/state.json`.

Logs: `journalctl -u manga-scheduler.service`

Manual / test run:
```bash
sudo python3 /opt/manga-scheduler/manga-scheduler.py --dry-run
sudo python3 /opt/manga-scheduler/manga-scheduler.py --dry-run --upload-dir /srv/uploads/manga-test --comics-dir /tmp/comics-test
sudo systemctl start manga-scheduler.service  # live run
```

Reset state: `sudo rm /opt/manga-scheduler/state.json`

Restore helper available at `/opt/backup/restore.sh` on the server.

## Maintenance

See [MAINTENANCE.md](MAINTENANCE.md) for routine upkeep tasks, disaster recovery steps, and monitoring recommendations.
