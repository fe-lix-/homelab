# Mail VPS migration runbook (Ubuntu 22.04 → 24.04)

Operational runbook for moving the mail VPS (`mithlond`, `mail.delval.eu`, `149.28.47.10`) from Ubuntu 22.04 jammy to Ubuntu 24.04 noble by provisioning a fresh VPS and cutting over via DNS. **One-time procedure.** Estimated cutover downtime: **5–15 minutes** for most clients (DNS propagation with 60s TTL); SMTP retry semantics absorb stragglers gracefully.

## Why a fresh VPS, not `do-release-upgrade`

The current jammy install was originally bootstrapped from the emailwiz bash script in 2021 and has been incrementally Ansibled. A side-grade gives a clean slate against the now-validated Ansible flow (the May 2026 DR rehearsal exercised every role on a 22.04 fresh install end-to-end). It also lets us validate the playbook on noble before EOL pressure in April 2027.

## Constraints — what makes mail migration harder than a regular service

| Constraint | Why it matters |
|---|---|
| **Reverse DNS (rDNS) must match HELO** | Gmail, Outlook, Apple, etc. expect the sender rDNS to roughly match `EHLO mail.delval.eu` (FCrDNS). Today rDNS is the generic Vultr default `149.28.47.10.vultrusercontent.com` — should be set to `mail.delval.eu` (see pre-flight). Vultr's custom PTRs are per-IP and follow the IP across reserved-IP swaps. |
| **DKIM keys must NEVER be regenerated** | New keys would invalidate every signed message already in flight. Vault-backed restore (`vault_dkim_private_keys`) lays them down byte-for-byte on the new VPS. |
| **IMAP UIDs and flags must be preserved** | If UIDs change, every client re-downloads its entire mailbox and loses read/unread state. `doveadm sync` preserves these; raw `rsync` of maildirs doesn't. |
| **SMTP retries soften downtime** | Receiving servers retry 4xx/connection-refused for 24-72h. Brief outages don't lose mail in practice — IMAP visibility is the user-facing impact. |
| **Postfix outbound queue** | Anything in `/var/spool/postfix/deferred` on the old VPS at cutover must be flushed or copied. Otherwise it gets discarded with the VM. |
| **Let's Encrypt rate limits** | 5 duplicate certs per week per FQDN. Don't iterate on cert issuance — get it right once after cutover. |

## Strategy comparison

| Approach | Downtime | Cost | Risk |
|---|---|---|---|
| **DNS A-record cutover** (recommended) | ~5–15 min for most resolvers; up to a few hours for misbehaving ISP caches | Free | Some clients hit old VPS during propagation; their mail retries when old VPS refuses connections |
| **IP swap via Vultr Reserved IP** | 2–5 min | ~$3/mo *forever* — converting a main IP to a Reserved IP is one-way; the IP keeps the Reserved-IP billing flag even after attaching to a new instance as main | Single Vultr API call |
| **Active/active dovecot replication** | ~0 min | Free | Complex setup, ongoing maintenance for a one-time event |

**Recommended: DNS A-record cutover with parallel pre-staging.** Both servers run in parallel until the cutover. The new VPS gets its rDNS pre-set via Vultr CLI. The cutover is just an `A` record update at Gandi — with the TTL pre-lowered to 60s, most resolvers see the new IP within 1–5 min. Inbound mail retry semantics (SMTP receivers try for 24–72h) absorb stragglers gracefully. IMAP clients reconnect when their cached DNS expires.

The Reserved-IP route is theoretically cleaner (sub-second cutover, no DNS waiting) but the ongoing $3/mo billing is hard to justify for a one-time migration on a homelab mailbox. Reserved IPs are also one-way at Vultr: converting back to a main IP doesn't drop the billing.

## Pre-flight checklist (do these in the week before)

- [ ] **Confirm DKIM keys are in vault**:
      ```
      ansible-vault view inventories/production/group_vars/all/vault.yml --vault-password-file ~/.config/vaultpass | grep -A 1 "vault_dkim_private_keys"
      ```
      Should show `delval.eu:` and `quodt.eu:` entries. (Already validated 2026-05-13.)
- [ ] **Fix reverse DNS** (independent of migration but a natural moment to do it). Production currently has the generic Vultr default `149.28.47.10.vultrusercontent.com`. Set it to match the EHLO hostname so FCrDNS aligns and strict spam filters stop downgrading:
      ```
      vultr-cli instance reverse-dns set-ipv4 <instance-id> <ipv4> --entry mail.delval.eu
      # Production today:
      vultr-cli instance reverse-dns set-ipv4 9cae00a2-f7f9-408e-85ef-4e89578a5f78 149.28.47.10 --entry mail.delval.eu
      # Verify:
      dig +short -x 149.28.47.10   # expect: mail.delval.eu.
      ```
      Custom PTRs follow the IP through reserved-IP swaps, so this survives migration automatically. To revert to the Vultr default later: `vultr-cli instance reverse-dns default-ipv4 <instance-id> <ipv4>`.
- [ ] **Set rDNS on the new VPS's IP** *as soon as you have it* (before any outbound mail can leave). Done via:
      ```
      vultr-cli instance reverse-dns set-ipv4 <new-instance-id> <new-ipv4> --entry mail.delval.eu
      ```
      Without this, the new VPS's first outbound mail (e.g. ACME-failure replies, monitoring) goes out with a generic `<ip>.vultrusercontent.com` rDNS and gets spam-filtered. The role's rDNS assert (added 2026-05-13) will block the deploy if you forget.
- [ ] **Lower DNS TTL** on **just one record** at Gandi: `mail.delval.eu` A. Set to 60s. Wait 24h after lowering for old caches to flush.
      - MX, SPF, DKIM, DMARC records do NOT change during migration — they all reference the unchanging `mail.delval.eu` A, which itself only changes destination IP at the very end (and only if we go DNS-cutover instead of IP-swap). No TTL touch needed on those.
      - **`quodt.eu` is at Cloudflare, not Gandi** — but its MX (`10 mail.delval.eu`) and SPF (`v=spf1 mx a:mail.delval.eu -all`) reference the unchanging hostname, so there's nothing to change for quodt.eu at all. Two DNS providers, only one is touched.
- [ ] **Snapshot the current mailbox sizes** to size the new VPS appropriately:
      ```
      ssh -i ~/.ssh/mail.delval.eu root@149.28.47.10 'du -sh /home/*/Mail/ /var/lib/dbconfig-common/sqlite3/roundcube/ /var/spool/postfix/'
      ```
- [ ] **Inventory + Ansible state**:
      - Confirm `make check-mail` returns 0 changes against current `mithlond` (i.e., production matches the playbook).
      - Confirm `make deploy-mail` runs cleanly against current `mithlond`.
- [ ] **Take a final cold backup of the VM** via Vultr snapshot (1-click in dashboard, ~1h to complete). Worst-case rollback.

## Execution runbook

### Phase 1 — provision the new VPS (no production impact, ~30 min)

1. Create new Vultr instance, same plan/region:
   ```
   vultr os list | grep -i "ubuntu 24.04"          # note OS ID, currently 2284
   vultr instance create \
     --region ewr \
     --plan vc2-1c-1gb \
     --os <ubuntu-24.04-os-id> \
     --ssh-keys f06e4527-7af7-4c61-9fd6-f581f88e0775 \
     --host mithlond-noble \
     --label mithlond-noble \
     --tags "migration,noble"
   vultr instance list | grep mithlond-noble       # note new IP
   ```
2. Add to `inventories/production/hosts.yml` under `mail:` group as a temporary host:
   ```yaml
   mithlond-noble:
     ansible_host: <new IP>
     ansible_user: root
     ansible_ssh_private_key_file: ~/.ssh/mail.delval.eu
     ansible_python_interpreter: /usr/bin/python3
   ```
3. Run the playbook against the new host, **skipping mail-certbot** (no DNS pointing there yet):
   ```
   ansible-playbook site-mail.yml --vault-password-file ~/.config/vaultpass \
     --limit mithlond-noble --skip-tags mail-certbot
   ```
   The dovecot/postfix/nginx services need a cert to start, so stub a self-signed one (same trick as the DR rehearsal):
   ```
   ssh -i ~/.ssh/mail.delval.eu root@<new IP> '
     mkdir -p /etc/letsencrypt/live/mail.delval.eu
     cd /etc/letsencrypt/live/mail.delval.eu
     openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
       -keyout privkey.pem -out fullchain.pem \
       -subj "/CN=mail.delval.eu/O=migration-stub"
     chmod 600 privkey.pem
   '
   ```
   Re-run the playbook — services should converge clean. Verify:
   ```
   ssh -i ~/.ssh/mail.delval.eu root@<new IP> '
     for s in postfix dovecot opendkim nginx spamassassin fail2ban php8.1-fpm; do
       echo "$s: $(systemctl is-active $s)"
     done
   '
   ```
4. **Verify DKIM keys restored from vault** (the whole point of the prior session's work):
   ```
   ssh -i ~/.ssh/mail.delval.eu root@<new IP> '
     openssl pkey -in /etc/postfix/dkim/mail.private -pubout -outform DER 2>/dev/null | sha256sum
   '
   # Expected: 16e10aeee702e84c0aaa8af7c3c29db0268e9595793d7e99d87aae5ad3a3aad9
   ```

### Phase 2 — initial bulk mailbox sync (no production impact, time depends on mailbox size)

Use `doveadm sync` over SSH so IMAP UIDs are preserved. Run from the new VPS, pulling from the old.

For each mailbox user (felix, paul, kindle, emma, guest, nina):

```
ssh -i ~/.ssh/mail.delval.eu root@<new IP> '
  doveadm -o "ssl=no" backup -u <user> ssh -i /root/.ssh/migration_key root@149.28.47.10 doveadm dsync-server -u <user>
'
```

(Provision a temporary SSH keypair on the new VPS and authorize it on the old. `doveadm backup` does a one-way sync, leaving the source untouched.)

Roundcube user prefs:
```
rsync -av -e "ssh -i ~/.ssh/mail.delval.eu" \
  root@149.28.47.10:/var/lib/dbconfig-common/sqlite3/roundcube/ \
  root@<new IP>:/var/lib/dbconfig-common/sqlite3/roundcube/
```

Mail-agent state (Nina's auto-reply state file):
```
rsync -av -e "ssh -i ~/.ssh/mail.delval.eu" \
  root@149.28.47.10:/var/lib/mail-agent/ \
  root@<new IP>:/var/lib/mail-agent/
```

### Phase 3 — final cutover (~5–15 min, the only downtime window)

Choose a low-traffic time. Mail retries for 24–72h, so weekend mornings or evenings are fine. With TTL at 60s (pre-flight item), most resolvers refresh within minutes. A few misbehaving ISP caches may take longer — their users will see "cannot reach mail server" for a window, then everything resumes when the cache expires.

1. **Stop accepting new mail on the old VPS** so the final sync delta is bounded and any stale-DNS senders get a clean refusal (which triggers their retry queue, not silent loss):
   ```
   ssh -i ~/.ssh/mail.delval.eu root@149.28.47.10 '
     systemctl stop postfix dovecot
     postqueue -p | head    # confirm what is queued
     postqueue -f           # flush deferred outbound — last chance to deliver
   '
   ```
2. **Final delta sync** for each user (fast, only changes since Phase 2):
   ```
   for u in felix paul kindle emma guest nina; do
     ssh -i ~/.ssh/mail.delval.eu root@<new IP> "
       doveadm backup -u $u ssh -i /root/.ssh/migration_key root@149.28.47.10 doveadm dsync-server -u $u
     "
   done
   ```
3. **Migrate the postfix queue** (anything still in deferred):
   ```
   rsync -av -e "ssh -i ~/.ssh/mail.delval.eu" \
     root@149.28.47.10:/var/spool/postfix/deferred/ \
     root@<new IP>:/var/spool/postfix/deferred/
   ssh -i ~/.ssh/mail.delval.eu root@<new IP> 'chown -R postfix:postfix /var/spool/postfix/deferred'
   ```
4. **Update DNS** at Gandi: change `mail.delval.eu` A record from `149.28.47.10` (old VPS) to `<new VPS IP>`. With TTL pre-lowered to 60s, propagation begins immediately. Verify with public resolvers:
   ```
   dig +short @1.1.1.1 mail.delval.eu
   dig +short @8.8.8.8 mail.delval.eu
   # both should return the new IP within 1–5 min
   ```
5. **Acquire the real LE cert on the new VPS** (now that DNS points to it):
   ```
   ssh -i ~/.ssh/mail.delval.eu root@<new IP> '
     rm -rf /etc/letsencrypt/live/mail.delval.eu       # remove the stub
     systemctl stop nginx                              # free port 80 for --standalone
     certbot certonly --standalone --cert-name mail.delval.eu \
       -d mail.delval.eu --agree-tos --email felixdelval@gmail.com --non-interactive \
       --deploy-hook /etc/letsencrypt/renewal-hooks/deploy/reload-mail.sh
     systemctl start nginx
   '
   ```
   The role's renewal-conf patch task will rewrite `authenticator = nginx` on next Ansible run.
6. **Re-run the playbook against the new VPS at its production identity** (now that it has the live cert + DNS):
   - Update `inventories/production/hosts.yml`: point `mithlond` `ansible_host` at the new VPS's IP (or use `mail.delval.eu` which now resolves there), remove `mithlond-noble`.
   - `make deploy-mail` — should report 0 changes.
7. **Smoke-test mail flow**:
   - Send a test from a personal address to `felix@delval.eu`. Confirm arrival within 1 min.
   - Send from `felix@delval.eu` to a Gmail address. Confirm Gmail's `Authentication-Results` header shows `dkim=pass header.i=@delval.eu spf=pass dmarc=pass`.
   - IMAP login from a real client (Apple Mail / Thunderbird / mobile) — folder list intact, no re-download.

### Phase 4 — warm spare period (1 week)

- Leave the old VPS **running but with services stopped** for 1 week. If something breaks on the new VPS, you can re-attach the IP to the old in 10 seconds.
- After 1 week: snapshot the old VPS (one final cold backup), destroy it.

## Rollback plan

At any point before destroying the old VPS:
1. **Revert the DNS A record** at Gandi: `mail.delval.eu` → `149.28.47.10` (the original old-VPS IP).
2. **Restart services on the old VPS**:
   ```
   ssh -i ~/.ssh/mail.delval.eu root@149.28.47.10 'systemctl start postfix dovecot nginx'
   ```
3. With the 60s TTL, public resolvers see the rollback within 1–5 min. The old VPS resumes service. Mail data on the new VPS is now stale (any mail received post-cutover lives there) — extract anything that arrived post-cutover via `doveadm sync` back to old before discarding.

## Post-migration verification (run the day after)

```
ssh -i ~/.ssh/mail.delval.eu root@149.28.47.10 '
  echo "--- OS ---"; lsb_release -d
  echo "--- mail flow last 24h ---"; journalctl -u postfix --since "24h ago" | grep -E "status=(sent|deferred|bounced)" | awk "{print \$NF}" | sort | uniq -c
  echo "--- DKIM ---"; opendkim-testkey -d delval.eu -s mail -k /etc/postfix/dkim/mail.private
  echo "--- cert expiry ---"; openssl x509 -in /etc/letsencrypt/live/mail.delval.eu/fullchain.pem -noout -enddate
  echo "--- fail2ban jails ---"; fail2ban-client status | grep "Jail list"
'
```

Expected:
- OS: Ubuntu 24.04 noble
- Mail flow: mostly `sent`, low `deferred` (transient retries), zero `bounced` except spam
- DKIM: "key OK"
- Cert: 60-90 days out from now
- fail2ban: sshd, postfix, postfix-sasl, dovecot jails listed

## Notes on the zero-downtime alternative

If absolute zero downtime is ever a requirement (it isn't here), the path is:

1. Set up dovecot replication: `mail_replica = tcp:<new IP>:12345` on both servers + `doveadm replicator add ...` per mailbox. Two-way real-time sync.
2. Add new VPS as secondary MX with lower priority (higher number) — both servers accept inbound.
3. Cut over by raising the new VPS to primary MX priority and removing the old.
4. Maintain dual write until users confirm everything works.

This adds an ongoing replication subsystem to maintain and a real risk of split-brain if the replicator gets confused. Worth it for shared / multi-user production mail; not worth it for a 6-user homelab mailbox.

## Open decisions

- **Should noble include the unattended-upgrades `${distro_codename}-updates` pocket?** Jammy needed it explicitly (mail-base/tasks/main.yml). Noble may include it by default — verify and possibly simplify mail-base after migration.
- **Migrate the unused `1.2.3.4/24` style policy artifacts?** None known — earlier audit cleaned these up.
- **Rotate vault secrets at the same time?** Optional but a natural opportunity to rotate `vault_mail_agent_imap_password` and any cleartext SMTP/IMAP creds. The DKIM keys must NOT rotate.
