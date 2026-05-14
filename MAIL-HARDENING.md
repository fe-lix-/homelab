# Mail server hardening — current state + roadmap

Companion doc to `MAIL-VPS-MIGRATION.md`. Tracks the ongoing email-deliverability and security posture for `delval.eu` and `quodt.eu`. Each subsection lists what's done, what's open, why it matters, and the next step.

## Current state (as of 2026-05-14)

### Authentication

| Item | delval.eu | quodt.eu |
|---|---|---|
| MX | ✅ `10 mail.delval.eu` | ✅ `10 mail.delval.eu` (shared MX) |
| SPF | ✅ `v=spf1 mx a:mail.delval.eu -all` | ✅ same |
| DKIM | ✅ key in vault, restored on deploy | ✅ key in vault |
| DMARC | ⚠️ `p=none` (observational) | ⚠️ `p=none` |
| Forward DNS (mail.delval.eu) | ✅ A + AAAA | shared |
| Reverse DNS — v4 | ✅ `149.28.47.10 → mail.delval.eu` | shared |
| Reverse DNS — v6 | ⏳ propagating (set 2026-05-14, Vultr lag) | shared |
| DKIM-signing of outbound DSNs (bounces) | ✅ via `internal_mail_filter_classes` | ✅ |

### Transport security

| Item | delval.eu | quodt.eu |
|---|---|---|
| STARTTLS on 25 / submission on 465+587 | ✅ | ✅ |
| TLS protocols | ✅ TLS 1.2 + 1.3 only (SSLv2/3, TLS 1.0/1.1 disabled) | ✅ |
| TLS 1.2 cipher policy | ✅ NCSC-NL "Sufficient" allow-list: ECDHE+AEAD only (CBC/DHE/static-RSA rejected) | ✅ |
| TLS 1.2 signature algorithms | ✅ SHA-256/384/512 only — SHA-1 key-exchange signatures rejected (RFC 9155) | ✅ |
| TLS cert key type | ✅ ECDSA P-256 leaf, ECDSA P-384 intermediate (E7) | ✅ same cert covers SAN |
| TLS cert | ✅ LE, auto-renew via certbot.timer | n/a (uses mail.delval.eu's) |
| CAA records (apex) | ⏳ user-added at Gandi: issue/issuewild/issuemail/issuevmc/iodef | ⏳ same at Cloudflare |
| MTA-STS DNS (`_mta-sts.<domain>` TXT) | ✅ `v=STSv1; id=2026051401` | ✅ |
| MTA-STS HTTPS policy | ✅ `mta-sts.delval.eu` (mode=enforce) | ✅ `mta-sts.quodt.eu` |
| TLS-RPT (`_smtp._tls.<domain>` TXT) | ✅ → dmarc@delval.eu | ✅ → dmarc@quodt.eu |

### Reporting + monitoring

- **DMARC aggregate reports** flow to `dmarc@delval.eu` and `dmarc@quodt.eu` mailboxes. ~144 reports accumulated since 2021 covering 5 years of authentication outcomes.
- **TLS-RPT failure reports** now flow to the same mailboxes (configured 2026-05-14; first reports expected within 24-72h).
- Quick parse: `python3` script in this repo's history (search commit `9476568`-era for the inline aggregator) — produces a per-source-IP pass/fail breakdown.

### Network families

- IPv4: enabled, 149.28.47.10
- IPv6: enabled 2026-05-14, address `2001:19f0:1000:2f51:5400:3ff:fe24:6b47/64`. AAAA records published for `mail.delval.eu`, `mta-sts.delval.eu`, `mta-sts.quodt.eu`. Postfix, Dovecot, nginx all bind dual-stack.

## Open hardening items

In rough order of value-per-effort.

### 1. DMARC ramp `p=none` → `p=quarantine` → `p=reject`

**State**: both domains at `p=none` (observational). Receivers don't act on DMARC failures from your domain; spoofing attempts still land in inboxes if the receiver's own anti-spam doesn't catch them.

**Blocker preventing immediate ramp**: the 5-year DMARC archive shows ~150 spoofer-IPs from AWS/Hetzner sending mail claiming `From: …@delval.eu`. Those would be DMARC-dropped at `p=reject` — exactly what we want. **But** the archive also shows ~13 records from Google/Microsoft outbound IPs sending as `@delval.eu` — likely real humans using Gmail/Outlook's "Send as" feature on a delval.eu address without relaying through our SMTP. At `p=reject` those drop too.

**Steps**:
1. Identify the ~13 Google/MS sender entries (check the DMARC reports for source IP + From: + dates). Are they you? A family member? Investigate.
2. Either:
   - Add a mechanism for them to send via our server (SMTP auth + relay), OR
   - Add their sending domains to our SPF as `include:` clauses, OR
   - Accept those messages will quarantine when you ramp
3. Forward DMARC reports to a free third-party parser (Postmark DMARC monitor: paste their address into the `rua=` list) for a real-time dashboard.
4. Watch 2 weeks of reports under `p=none` with the new mail-postfix DSN-signing fix in place. The 136 historical self-failures should drop to 0.
5. Switch to `p=quarantine; pct=25` at Gandi and Cloudflare. Hold 2 weeks.
6. Bump `pct=50`, `pct=100` over 4 weeks watching reports.
7. Promote to `p=reject`.

**Why it matters**: with `p=reject` and our current SPF+DKIM, a spoofer trying to forge `felix@delval.eu` is dropped at the receiver's SMTP gateway before it reaches the inbox. The current `p=none` provides zero such protection.

### 2. DNSSEC for both domains

**State**: ❌ neither domain signed. Tested via internet.nl / Hardenize as a fail.

**Approach**: provider-managed DNSSEC, NOT self-managed (keys, rollovers, expiry monitoring). Both Gandi and Cloudflare offer fully-automated DNSSEC. Misconfigured DNSSEC creates harder outages than no DNSSEC at all, so this is provider-managed only.

**Per-domain steps**:
- **delval.eu** (Gandi for both DNS + registrar): Gandi dashboard → delval.eu → DNSSEC tab → Enable. They generate keys + auto-submit DS to the `.eu` registry. Effective within 1-2 days.
- **quodt.eu** (Cloudflare for DNS, registrar tbd via `whois`):
  - Cloudflare → quodt.eu → DNS → DNSSEC → Enable.
  - If Cloudflare is also the registrar: DS submission is automatic.
  - If a different registrar holds the registration: Cloudflare gives you a DS record string; paste into the registrar's DNSSEC management page. Manual one-time step. DS propagation 24-48h.

**Why it matters**: with DNSSEC, a validating resolver (~30% of DNS queries) can verify the authenticity of MX/A/AAAA lookups for your domain. Without it, BGP hijacks of authoritative DNS or cache-poisoning attacks could redirect mail to an attacker's server. Modern receivers (Apple Mail clients, M365 enterprise filters) increasingly factor DNSSEC into spam scoring. Also a hard prereq for #3 (DANE).

**Risk**: managed DNSSEC at Gandi/Cloudflare is set-and-forget. Major outages from DNSSEC come from self-managed setups botching key rollovers — not applicable here.

### 3. DANE / TLSA records

**State**: ❌ not configured. Requires DNSSEC first (#2).

**Approach**: publish a `TLSA` record under `_25._tcp.mail.delval.eu` pinning either the mail server's cert public key or its issuer. Sending MTAs that support DANE (most large operators) then refuse to deliver unless the presented cert matches the TLSA record.

**Trade-off vs. MTA-STS**: both achieve similar goals (force TLS, fail closed). DANE is stronger (relies on DNS rather than HTTPS, no CA dependency) but requires DNSSEC and TLSA rotation when the cert changes. With Let's Encrypt's 90-day cert lifecycle, TLSA records pinning the public key (3 1 1 mode) need to be re-published on every cert rotation — automatable but adds a moving part.

**Recommendation**: defer until DNSSEC is in. Then evaluate: if you're feeling thorough, publish DANE alongside MTA-STS (belt-and-suspenders, modest extra benefit). If you want simplicity, MTA-STS alone is widely sufficient.

### 4. v6 reverse-DNS assertion in `mail-base`

**State**: the role's `rdns-check` task only asserts the v4 PTR matches `mail_hostname`. With v6 now enabled, the v6 PTR should also be validated.

**Fix**: extend the assert task to walk both `ansible_facts.default_ipv4.address` and `ansible_facts.default_ipv6.address` (when present). One-line addition.

### 5. Autoconfig / Autodiscover

**State**: ❌ not configured. Convenience-only — Thunderbird/Apple Mail can auto-detect IMAP/SMTP settings if served. Low ROI unless you onboard mail clients frequently. Skip for now.

### 6. BIMI

**State**: ❌ not configured. Requires `p=reject` DMARC (so blocked by #1) plus a paid Verified Mark Certificate ($1500+/yr). **Skip** — not worth it for personal infrastructure.

## Reporting + verification cadence

- **Weekly during DMARC ramp**: re-run the inline DMARC aggregator (Python heredoc that walks `/home/dmarc/Mail/Inbox/`) and look for new source IPs / unexpected pass-fail shifts.
- **Monthly**: run the test domain through https://www.hardenize.com/report/delval.eu and https://internet.nl/mail/delval.eu/ — scoreboard should improve as each item lands.
- **After any cert renewal or rDNS change**: spot-check `dig +short -x <IP>` against both v4 and v6 and verify external SMTP/IMAP probes still validate. The `rdns-check` assert catches drift on every `make deploy-mail`.

## Quick reference — what's where

| File | Purpose |
|---|---|
| `roles/mail-base/tasks/main.yml` | apt packages + rDNS assert |
| `roles/mail-certbot/tasks/main.yml` | LE cert acquisition (--standalone bootstrap + --nginx renewal) |
| `roles/mail-opendkim/` | DKIM keytable + signingtable + key restore from vault |
| `roles/mail-postfix/templates/main.cf.j2` | Postfix config including `internal_mail_filter_classes` (DSN signing) |
| `roles/mail-dovecot/files/dovecot.pam` | PAM auth (no `nullok`) |
| `roles/mail-mta-sts/` | MTA-STS policy serving + separate LE cert |
| `roles/mail-users/` | POSIX mailbox users (nologin shells) |
| `inventories/production/group_vars/all/vault.yml` | DKIM private keys (encrypted) |

## What's NOT in scope of this doc

- VPS lifecycle / OS upgrade — see `MAIL-VPS-MIGRATION.md`
- Backups — see `BACKUP.md`
- General homelab security audit findings — see `TODO.md`
