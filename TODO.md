# Homelab TODO

Combined findings from the March 2026 security audits and Ansible reviews.

## Bugs

- [ ] **Uptime Kuma provisioning script never executed** — `roles/uptime-kuma/tasks/main.yml:23-29`: The `provision-monitors.py` script is templated to disk but no task runs it. Monitors are never provisioned by Ansible.

### Ansible Best Practices

- [x] **Add `proxy_connect_timeout` to Jellyfin nginx block** — `roles/nginx/templates/default.conf.j2`: Jellyfin has `proxy_read_timeout` and `proxy_send_timeout` (600s) but is missing `proxy_connect_timeout`. Immich has all three.

- [x] **Use `netplan try` instead of `netplan apply` in handler** — `roles/base/handlers/main.yml`: `netplan apply` with a bad template can disrupt live networking mid-playbook. Replace with `netplan try --timeout 30` which auto-rolls-back on connection loss. Also remove `changed_when: true` (only fires when notified, so this inflates change counts).

## Security — High

- [ ] **Minecraft docker-compose rendered at 0644 with RCON password** — `roles/minecraft/tasks/main.yml:33-39`: The compose file embeds `RCON_PASSWORD` but is written at `mode: "0644"` with no `no_log`. Any local user on the host can read it; verbose ansible runs log it. Change to `mode: "0640"` owned by root with `no_log: true` (matching the pihole/immich/paperless pattern).

- [ ] **Jellyfin `SSO-Auth.xml` deployed at 0644 with inline OIDC secret** — `roles/jellyfin/tasks/main.yml:32-37`: Template `SSO-Auth.xml.j2:13` renders `<OidSecret>{{ authelia_jellyfin_oidc_secret }}</OidSecret>` into a world-readable file. Set `mode: "0600"` owned by jellyfin user, add `no_log: true`.

- [ ] **Immich OIDC client missing PKCE** — `roles/authelia/templates/configuration.yml.j2:130-147`: Immich registers the custom-scheme public redirect `app.immich:///oauth-callback` alongside web redirects with a shared static `client_secret` and no `require_pkce`. Any Android app can claim the scheme and intercept the authorization code; the secret is extractable from the mobile app binary. Add `require_pkce: true` and `pkce_challenge_method: S256`.

- [ ] **Arr-stack Authelia bypass regex too broad** — `roles/authelia/templates/configuration.yml.j2:208-216`: `^/api.*` matches `/apifoo`, bare `/api`, and mutating endpoints like `/api/v3/command` (arbitrary downloads) and `/api/v1/system/backup/restore`. Anchor to `^/api/v[0-9]+/` and consider keeping mutating endpoints behind Authelia via a second rule.

- [ ] **NUT `upsd` binds 0.0.0.0 with UFW allow on entire 172.16.0.0/12** — `roles/nut/defaults/main.yml:6`, `roles/nut/templates/upsd.conf.j2:2`, `roles/nut/tasks/main.yml:37-43`: The allow range is far broader than the Docker bridge subnets it was meant to cover. Any future VLAN/VPN/route into that /12 reaches port 3493 with only app-level auth (defaults `CHANGE_ME`). Bind to 127.0.0.1 + specific bridge IP; scope UFW to the actual bridge subnet.

- [ ] **`screentime` container joined to Pi-hole and monitoring networks** — `roles/screentime/templates/docker-compose.yml.j2:16-27`: Joining `pihole_default` + `monitoring_default` gives east-west access to Pi-hole admin API (WEBPASSWORD) and every monitoring container (Grafana, Prometheus, Loki, cAdvisor, webhook-receiver). Remove `monitoring_default`; reach Pi-hole via host-gateway on its published port.

- [ ] **`screentime-collector` runs `pip install` from PyPI at every container start as root** — `roles/screentime/templates/docker-compose.yml.j2:13-15`: Typosquat or mirror compromise = RCE as root on a container with access to Pi-hole and monitoring (see above). Bake deps into a built image with pinned hashes.

- [ ] **Pi-hole runs with `cap_add: NET_ADMIN` without documented need** — `roles/pihole/templates/docker-compose.yml.j2:21-22`: Only required for Pi-hole's DHCP server mode. Without it, compromise is container-local; with it an attacker can manipulate netfilter/routes from inside the DNS container — ideal MITM position. Remove unless DHCP is actively used.

- [x] **Restore brute-force protection** — `roles/security/tasks/main.yml`: fail2ban is explicitly removed (`state: absent`) with no replacement. Re-add fail2ban with an nginx/ssh jail, or add `limit_req_zone`/`limit_req` to the Authelia nginx server block.

- [x] **Add `regulation:` block to Authelia** — `roles/authelia/templates/configuration.yml.j2`: No explicit brute-force lockout configured. Add: `regulation: {max_retries: 5, find_time: 2m, ban_time: 10m}`.

- [x] **Add explicit nginx volume mounts for `mc-forbidden.html` and `favicon.svg`** — `roles/nginx/templates/docker-compose.yml.j2`: These static files are referenced in `default.conf.j2` but have no volume mounts. They work today only because nginx uses host networking (container inherits host filesystem). Add explicit `ro` mounts so the config doesn't silently break if networking mode ever changes.

- [x] **Clear `Remote-User` header before Authelia sets it in Paperless vhost** — `roles/nginx/templates/default.conf.j2`: Paperless trusts the `Remote-User` header for authentication (`PAPERLESS_ENABLE_HTTP_REMOTE_USER: true`). nginx doesn't strip client-supplied headers by default. Add `proxy_set_header Remote-User "";` in the proxy location block before `authelia_auth()` sets it from the validated Authelia response, so a client cannot self-authenticate by injecting the header.

## Security — Medium

- [x] **Restrict Pi-hole DNS port 53** — Accepted risk: Pi-hole DNS should be reachable by all LAN devices (10.0.0.0/8, 192.168.0.0/16 including WireGuard VPN clients). Port 53 is not forwarded from the internet, so exposure is limited to devices already on the network. No DOCKER-USER iptables rules needed.

- [x] **Fix compose file permissions for secrets** — `roles/pihole/tasks/main.yml`, `roles/immich/tasks/main.yml`, `roles/paperless/tasks/main.yml`: Changed to `mode: "0600"` and added `no_log: true` (matching authelia/monitoring pattern).

- [x] **Restrict Samba by network** — Added `hosts allow = 10.0.0.0/8 192.168.0.0/16 127.0.0.1` to `[global]` in `smb.conf.j2`. Restricted UFW rules to `10.0.0.0/8` and `192.168.0.0/16` (LAN + VPN).

- [x] **Harden Minecraft systemd services** — All three services (mc-proxy, mc-fake-server, mc-idle-watcher) now run as `svc-minecraft` with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`. Docker-accessing services use `Group=docker`. Scripts owned by `svc-minecraft`. mc-start.sh log moved from `/var/log` to data dir.

- [x] **Harden manga-scheduler systemd service** — All three services (scheduler, chapter-checker, UI) hardened with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `ReadWritePaths`. Kept running as root (needed for `os.chown()`).

- [x] **Add nginx upload size limit for Goploader** — Added `client_max_body_size 2G` to the `files.` server block in nginx.

- [ ] **Authelia `manga-scheduler` access rule references a group that doesn't exist** — `roles/authelia/templates/configuration.yml.j2:245-249`: The rule grants `group:manga-scheduler` which isn't in LLDAP. The manga-scheduler UI shells out to `systemctl` as root, so any future typo in the ACL could silently broaden access to a code-execution-adjacent surface. Either create the LLDAP group or change the rule to an existing group.

- [ ] **No 2FA anywhere — global `one_factor` policy** — `roles/authelia/defaults/main.yml:9` plus every rule in `configuration.yml.j2`: TOTP is configured but never required. Password compromise → full admin on pihole/uptime/docs/screentime/manga-scheduler (root via systemd) and the arr/qbit/komga stack. Apply `two_factor` at minimum to admin-scoped rules and the manga-scheduler rule.

- [ ] **Long-lived Authelia sessions** — `roles/authelia/templates/configuration.yml.j2:29-36`: `inactivity: 7d`, `expiration: 7d`, `remember_me: 30d` with cookie scoped at the apex `lab.delval.eu`. Stolen cookie = broad cross-service compromise for a month. Tighten to e.g. `inactivity: 4h`, `remember_me: 7d`, or disable `remember_me`.

- [ ] **`node-exporter` mounts host `/` read-only with `pid: host`** — `roles/monitoring/templates/docker-compose.yml.j2:30-44`: Any RCE or container escape reads every file on host (`/etc/shadow`, all role config with secrets, TLS private keys) and observes every host process. Restrict the mount to `/proc`, `/sys`, `/etc/os-release`, `/etc/hostname`.

- [ ] **`webhook-receiver` runs as root with mounted script** — `roles/monitoring/templates/docker-compose.yml.j2:135-147`: Bound to 127.0.0.1 but no `user:`, `cap_drop`, `read_only`, or `no-new-privileges`. Add `user: "65534:65534"`, `cap_drop: [ALL]`, `read_only: true`, `security_opt: [no-new-privileges:true]`.

- [ ] **Missing `no_log: true` on secret-rendering template tasks** — Add to:
  - `roles/manga-scheduler/tasks/main.yml` template tasks (~lines 65, 98, 128) — templates embed `KOMGA_PASSWORD` and `NTFY_TOKEN` as Python literals
  - `roles/backup/tasks/main.yml:17-29` — templates embed `RESTIC_PASSWORD` and `B2_ACCOUNT_KEY`

- [ ] **Unpinned local image `mediathekarr-local:latest`** — `roles/mediathekarr/templates/docker-compose.yml.j2:4`: Upstream base is digest-pinned but the local tag is floating. A stale or overwritten `latest` silently changes what runs. Tag with a content-addressed identifier (e.g. `mediathekarr-local:{{ mediathekarr_version[:12] }}`).

- [ ] **Authelia `/api/authz/auth-request` forward-auth endpoint not rate-limited** — `roles/nginx/templates/default.conf.j2:149-175`: Rate limits apply only to `/api/firstfactor|secondfactor`. The forward-auth endpoint permits unthrottled session probing from any LAN host. Add a `limit_req` zone covering the forward-auth location.

- [ ] **OIDC `consent_mode: implicit` on all five clients** — `roles/authelia/templates/configuration.yml.j2` (grafana/komga/immich/audiobookshelf/jellyfin blocks): First-party apps, so usually fine — but silent scope grants mean a rogue/compromised client can exfiltrate identity+groups with no user-visible step. Consider `explicit` for at least one admin-adjacent client.

- [ ] **`brscan-skey.config.j2` and HA `configuration.yaml` deployed at 0644** — `roles/brscan/tasks/main.yml:95`, `roles/homeassistant/tasks/main.yml:19-28`: Both are natural homes for credentials (scanner `password=` field is already present but empty; HA integrations store API keys in `configuration.yaml`). Tighten to `mode: "0640"` now.

- [ ] **Manga-scheduler UI writes unsanitized `Remote-Name`/`Remote-User` headers to disk** — `roles/manga-scheduler/templates/manga-scheduler-ui.py.j2:764,798`: Nginx sets the header from Authelia and the UI binds 127.0.0.1, so not currently exploitable, but no length/charset check defends against future nginx changes or header smuggling. Regex-validate (`[A-Za-z0-9._@-]{1,64}`) before `.write_text()`.

## Security — Low

- [ ] **Remove stale Jellyfin redirect URI** — `roles/authelia/templates/configuration.yml.j2`: `/sso/OID/redirect/authelia` is registered as a redirect_uri but per CLAUDE.md the plugin always sends `/sso/OID/r/authelia`. Remove the stale entry (OIDC best practice: minimal redirect_uri set).

- [ ] **Remove dead `access_control` subject rules for OIDC-only services** — `roles/authelia/templates/configuration.yml.j2`: Subject rules for `comics`, `audiobooks`, `grafana`, `jellyfin`, `photos` in `access_control` have no effect on OIDC flows — enforcement is via `authorization_policies`. Remove or annotate as intentional defense-in-depth.

- [ ] **Raise `mc-proxy.service` `LimitNOFILE`** — `roles/minecraft/templates/mc-proxy.service.j2`: `LimitNOFILE=256` hard-caps at ~127 concurrent TCP connections. A connection flood from the internet-facing Minecraft port exhausts this, blocking all whitelisted players. Raise to `4096`.

- [ ] **Fix `mc-start.sh` unrotated root-owned log** — `roles/minecraft/templates/mc-start.sh.j2`: Logs to `/var/log/mc-start.log` as root with no logrotate config. Switch to `StandardOutput=journal` in the systemd unit to use journald instead.

- [ ] **Increase Authelia `ban_time`** — `roles/authelia/templates/configuration.yml.j2`: `ban_time: 10m` allows ~30 password attempts/hour against the publicly reachable auth endpoint. Consider `ban_time: 1h`.

- [ ] **Pin Immich to a specific version tag** — `roles/immich/defaults/main.yml`: `immich_version: release` is a floating tag. Pin to a specific semver tag and update deliberately.

- [ ] **Fix Jellyfin hardcoded domain in extra_hosts** — `roles/jellyfin/templates/docker-compose.yml.j2`: Uses literal `auth.homelab.example.com` instead of `auth.{{ authelia_domain }}`. Change to use the variable.

- [ ] **Add `PAPERLESS_TRUSTED_PROXIES`** — `roles/paperless/templates/docker-compose.yml.j2`: `PAPERLESS_ENABLE_HTTP_REMOTE_USER` is set but `PAPERLESS_TRUSTED_PROXIES: "127.0.0.1"` is missing, making the trust boundary implicit rather than explicit.

- [ ] **Clean up or integrate orphaned sabnzbd role** — `roles/sabnzbd/` exists but is not in `site.yml`. Either add it with nginx vhost and Authelia coverage, or delete the role directory.

- [ ] **Deploy explicit unattended-upgrades config** — `roles/base/tasks/main.yml`: Package is installed but no managed config template is deployed. Add a `50unattended-upgrades` template to make upgrade behavior idempotent and auditable.

## Low Priority

- [ ] **Standardize secret placeholder values** — Some roles use `"CHANGE_ME"`, others use `""`. Standardize on `"CHANGE_ME"` for clarity.

- [ ] **Add Docker healthchecks** — Most docker-compose templates lack `healthcheck` definitions. Not critical (restart policies handle recovery) but improves observability.

- [ ] **Add explicit owner/group on directory tasks** — ~7 roles create directories without explicit `owner`/`group` (defaults to root, which is correct but implicit).

- [ ] **Harden systemd services** — Backup and certbot renewal services run as root without `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem` etc. (Documented as accepted trade-off in CLAUDE.md.)

- [ ] **Add Content-Security-Policy header** — `roles/nginx/templates/default.conf.j2`: The `ssl_params()` macro has HSTS/X-Frame-Options/etc. but no CSP header. Add a permissive default CSP to the macro with per-vhost overrides for services that need inline scripts.

- [ ] **Self-host landing page fonts** — `roles/nginx/templates/landing.html`: Loads fonts from `fonts.googleapis.com`, leaking visitor IPs to Google.
