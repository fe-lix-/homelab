# Homelab TODO

Combined findings from the March 2026 security audits and Ansible reviews.

## Bugs

- [ ] **Uptime Kuma provisioning script never executed** — `roles/uptime-kuma/tasks/main.yml:23-29`: The `provision-monitors.py` script is templated to disk but no task runs it. Monitors are never provisioned by Ansible.

### Ansible Best Practices

- [x] **Add `proxy_connect_timeout` to Jellyfin nginx block** — `roles/nginx/templates/default.conf.j2`: Jellyfin has `proxy_read_timeout` and `proxy_send_timeout` (600s) but is missing `proxy_connect_timeout`. Immich has all three.

- [x] **Use `netplan try` instead of `netplan apply` in handler** — `roles/base/handlers/main.yml`: `netplan apply` with a bad template can disrupt live networking mid-playbook. Replace with `netplan try --timeout 30` which auto-rolls-back on connection loss. Also remove `changed_when: true` (only fires when notified, so this inflates change counts).

## Security — High

- [x] **Restore brute-force protection** — `roles/security/tasks/main.yml`: fail2ban is explicitly removed (`state: absent`) with no replacement. Re-add fail2ban with an nginx/ssh jail, or add `limit_req_zone`/`limit_req` to the Authelia nginx server block.

- [x] **Add `regulation:` block to Authelia** — `roles/authelia/templates/configuration.yml.j2`: No explicit brute-force lockout configured. Add: `regulation: {max_retries: 5, find_time: 2m, ban_time: 10m}`.

- [x] **Add explicit nginx volume mounts for `mc-forbidden.html` and `favicon.svg`** — `roles/nginx/templates/docker-compose.yml.j2`: These static files are referenced in `default.conf.j2` but have no volume mounts. They work today only because nginx uses host networking (container inherits host filesystem). Add explicit `ro` mounts so the config doesn't silently break if networking mode ever changes.

- [x] **Clear `Remote-User` header before Authelia sets it in Paperless vhost** — `roles/nginx/templates/default.conf.j2`: Paperless trusts the `Remote-User` header for authentication (`PAPERLESS_ENABLE_HTTP_REMOTE_USER: true`). nginx doesn't strip client-supplied headers by default. Add `proxy_set_header Remote-User "";` in the proxy location block before `authelia_auth()` sets it from the validated Authelia response, so a client cannot self-authenticate by injecting the header.

## Security — Medium

- [ ] **Restrict Pi-hole DNS port 53** — `roles/pihole/templates/docker-compose.yml.j2`: Docker bypasses UFW; port 53 is reachable from all network segments including VLAN 30. Add iptables DOCKER-USER rules to restrict port 53 to `10.0.0.0/8`.

- [ ] **Fix compose file permissions for secrets** — `roles/pihole/tasks/main.yml`, `roles/immich/tasks/main.yml`, `roles/paperless/tasks/main.yml`: Compose files containing plaintext secrets are deployed with `mode: "0644"`. Change to `mode: "0600"` and add `no_log: true` on deploy tasks (matching authelia/monitoring pattern).

- [ ] **Restrict Samba by network** — `roles/samba/templates/smb.conf.j2` and `roles/samba/tasks/main.yml`: (1) No `hosts allow` directive in `smb.conf`; add `hosts allow = 10.0.0.0/8 127.0.0.1` to `[global]`. (2) The UFW rule uses the `Samba` predefined set which opens ports 137–445 from `0.0.0.0/0`; restrict with `src: 10.0.0.0/8`. Combined with `map to guest = Bad User`, any routed host can write to `/srv/uploads` unauthenticated.

- [ ] **Harden Minecraft systemd services** — `roles/minecraft/templates/mc-fake-server.service.j2`, `mc-idle-watcher.service.j2`: Both run as root with no systemd hardening. Add `User=`, `NoNewPrivileges=true`, `ProtectSystem=strict`, `PrivateTmp=true`. The idle watcher can run as a non-root user with Docker socket group membership instead of root.

- [ ] **Harden manga-scheduler systemd service** — `roles/manga-scheduler/templates/manga-scheduler.service.j2`: Runs as root with no systemd hardening. Add `NoNewPrivileges=true`, `ProtectSystem=strict`, `ReadWritePaths=/srv/comics /srv/uploads/mangas /opt/manga-scheduler`, or create a dedicated non-root user.

- [ ] **Add nginx upload size limit for Goploader** — `roles/nginx/templates/default.conf.j2`: No `client_max_body_size` on `files.homelab.example.com` server block. Add a sensible limit (e.g. `client_max_body_size 2G;`) matching Goploader's configured max file size.

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
