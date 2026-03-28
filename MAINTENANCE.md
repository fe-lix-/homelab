# Maintenance Guide

Routine maintenance tasks for keeping the homelab server healthy.

## Weekly

- [ ] Check for Docker image updates: `make versions`
- [ ] Review Uptime Kuma dashboard for any downtime events

## Monthly

- [ ] Apply image updates: `make versions-update` then `make deploy`
- [ ] Read changelogs before major version bumps (Authelia, Home Assistant, Immich, Uptime Kuma)
- [ ] Run full OS upgrade: `ssh server 'sudo apt update && sudo apt upgrade -y'`
- [ ] Reboot if needed: check `ssh server 'cat /var/run/reboot-required 2>/dev/null || echo "No reboot needed"'`
- [ ] Clean up unused Docker resources: `ssh server 'sudo docker system prune -af --volumes'`

## Quarterly

- [ ] Test a backup restore — pick a service, restore its config to `/tmp`, verify contents:
  ```bash
  ssh server 'sudo restic -r /srv/backups/restic restore latest --target /tmp/restore-test --include /opt/<service>/config'
  ```
- [ ] Verify backup repo integrity: `ssh server 'sudo restic -r /srv/backups/restic check'`
- [ ] Review Authelia logs for suspicious login attempts: `ssh server 'sudo cat /opt/authelia/data/authelia.log | grep "Unsuccessful"'`
- [ ] Check disk usage: `ssh server 'df -h / /opt /srv'`
- [ ] Test a full `make deploy` dry-run: `make check`

## After a Reboot

All containers use `restart: unless-stopped` and should come back automatically. If they don't:

```bash
make deploy
```

This is idempotent and will start any stopped containers.

## Disaster Recovery

### What you need to rebuild from scratch

1. This git repository
2. Vault password (stored in `~/.config/vaultpass` locally)
3. SSH key (`~/.ssh/homelab`)
4. A fresh Ubuntu server at the same IP (or update `inventories/production/hosts.yml`)

### Recovery steps

```bash
git clone <repo-url>
cd homelab
make collections
make deploy
```

Then manually:
- Restore backups: `/opt/backup/restore.sh`
- Home Assistant: restore config backup, verify integrations reconnect, check Nabu Casa tunnel
- Immich/Jellyfin: reconfigure OIDC in their admin UIs
- Re-upload media to `/srv/media`, `/srv/comics`, `/srv/downloads` (not backed up)

### What IS backed up (daily at 03:00)

- All service configs (`/opt/*/config`)
- Authelia config + database (`/opt/authelia/config`, `/opt/authelia/data`)
- Monitoring stack (`/opt/monitoring`)
- Immich PostgreSQL dump
- Photo library (`/srv/photos`)

### What is NOT backed up (replaceable)

- `/srv/media` (movies, TV, music)
- `/srv/comics`
- `/srv/downloads`

## Key Alerts to Set Up in Grafana

| Alert | Condition | Why |
|-------|-----------|-----|
| Disk space | >85% on `/`, `/opt`, or `/srv` | #1 cause of homelab outages |
| Container restarts | >3 restarts in 5 min | Restart loops fill logs fast |
| Backup freshness | No successful backup in 48h | Catch silent backup failures |
| TLS certificate | Expires in <14 days | Certbot renewal may have failed |

## Useful Commands

```bash
# Server access
ssh -i ~/.ssh/homelab ansible@YOUR_SERVER_IP

# Service logs
ssh server 'cd /opt/<service> && sudo docker compose logs --tail=50'

# Restart a single service
make deploy-role ROLE=<service>

# Check all container status
ssh server 'sudo docker ps --format "table {{.Names}}\t{{.Status}}"'

# Restic snapshots
ssh server 'sudo restic -r /srv/backups/restic snapshots'
```
