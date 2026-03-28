# Brother MFC-L2800DW Scan-to-PC on Linux

## Goal

Configure the MFC-L2800DW scan buttons to automatically deliver PDFs to
Paperless-ngx on a headless Ubuntu server:

- **FILE button** → single-sided scan → PDF direct to Paperless consume dir
- **OCR button** → double-sided scan → PDF to Paperless `double-sided/` subdir
  for automatic front/back collation

---

## Hardware/Software Versions

- Scanner: Brother MFC-L2800DW (network, IP YOUR_SCANNER_IP)
- Server: Ubuntu 22.04+, YOUR_SERVER_IP
- brscan5: 1.5.1-0
- brscan-skey: 0.3.4-0

---

## Architecture

### Scan button flow

1. brscan-skey-exe starts, acquires the lockfile, registers with scanner
2. User presses a scan button (pages loaded in ADF)
3. Scanner sends UDP packet to port 54925 on the server
4. brscan-skey-exe receives it, invokes the mapped script from `brscan-skey.config`
5. Script detaches a background process via `setsid bash -c "..." &`
6. Background process closes inherited fds 3–20 (releases inherited lockfile flock)
7. `pkill -KILL -x brscan-skey-exe` kills the main process (`KillMode=process`
   means only MainPID is killed; the setsid'd child survives)
8. `rm -f` removes the lockfile from disk (belt-and-suspenders)
9. `env -i ... scanimage ...` scans all ADF pages to per-page TIFFs;
   exit code 7 (ADF feeder empty) is treated as success
10. `img2pdf` combines the TIFFs into a single multi-page PDF
11. PDF written to the appropriate consume directory
12. 30 seconds later, systemd auto-restarts brscan-skey (`Restart=always`,
    `RestartSec=30`) with ExecStartPre removing the lockfile

### Button mapping (`brscan-skey.config`)

| Button | Script | Destination |
|--------|--------|-------------|
| FILE | `scantofile.sh` | `/opt/paperless/consume/` |
| OCR | `scantofile_doublesided.sh` | `/opt/paperless/consume/double-sided/` |
| IMAGE | `scantofile.sh` | `/opt/paperless/consume/` |
| EMAIL | `scantofile.sh` | `/opt/paperless/consume/` |

### Double-sided collation (OCR button)

Paperless-ngx has built-in support for collating two single-sided ADF scans into
one double-sided document (`PAPERLESS_CONSUMER_ENABLE_COLLATE_DOUBLE_SIDED=true`).

**Workflow for a double-sided document:**
1. Load all pages face-up in the ADF → press **OCR**
2. Flip the stack upside down → press **OCR** again
3. Paperless automatically reverses the even-page scan and interleaves both
   scans into a single correctly-ordered document

Files in `double-sided/` expire after 30 minutes if the second scan never arrives.

---

## Key Technical Facts

### The "Scan to PC" button is brother5-protocol only

When the scan button is pressed, the scanner enters **"Connecting to PC" mode**:
- Sends a UDP packet to the registered host on **port 54925**
- Waits for the **brother5 SANE backend** to connect and pull the scan
- **eSCL (AirScan) returns "Device busy"** while in this mode

eSCL only works as a *pull* protocol (PC initiates, scanner idle). It cannot
satisfy a scanner waiting for a brother5 connection.

### The lockfile flock is inherited by child processes

brscan-skey-exe creates `/tmp/brother_lockfile_saneskey_jhsga2shuioahja9kaf3dfsfdlsdfjbgfkj`
and holds a `LOCK_EX` flock. When it forks bash to call the script, bash inherits
the lockfile fd (no `FD_CLOEXEC`). If the brother5 backend then tries to acquire
the same lock, it gets `LOCK_EWOULDBLOCK` and crashes with:

```
terminate called after throwing an instance of 'std::logic_error'
  what():  basic_string::_S_construct null not valid
```

**Fix**: close fds 3–20 in the setsid bash at the very start:

```bash
for fd in 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    eval "exec ${fd}>&-"
done 2>/dev/null
```

### The same crash signature has two root causes

The `std::logic_error: basic_string::_S_construct null not valid` exception
appears in two distinct scenarios that look identical in the journal:

1. **Lockfile flock contention** — fixed by the fd close loop above
2. **Missing environment variables** — the systemd service environment lacks
   `HOME` and `SANE_CONFIG_DIR`; the brother5 backend constructs config paths
   from null pointers. Fixed by `env -i` (see below)

Both must be fixed; either alone is not sufficient.

### The systemd environment lacks HOME and SANE_CONFIG_DIR

The brscan-skey.service environment contains only `PATH`, `LANG`, `USER`, `PWD`,
and systemd-internal variables — no `HOME` or `SANE_CONFIG_DIR`. Manual
`sudo scanimage` works because the user environment has `HOME` set.

**Fix**: run scanimage with an explicit minimal environment:

```bash
env -i HOME=/root PATH=/usr/bin:/usr/sbin:/bin:/sbin SANE_CONFIG_DIR=/etc/sane.d \
    scanimage -d 'brother5:net1;dev0' ...
```

### ADF scanning: --batch + img2pdf + full source name

`scanimage --format=pdf` outputs only the first page. For multi-page ADF scans:

```bash
env -i HOME=/root PATH=/usr/bin:/usr/sbin:/bin:/sbin SANE_CONFIG_DIR=/etc/sane.d \
    scanimage -d 'brother5:net1;dev0' \
    --source='Automatic Document Feeder(left aligned)' \
    --format=tiff --resolution=300 \
    --batch='/tmp/scan_dir/page_%04d.tiff'
# exit 0 or 7 = success
img2pdf /tmp/scan_dir/page_*.tiff -o output.pdf
```

**Critical**: `--source=ADF` is not a valid source name for the brother5 backend.
Using it silently falls back to flatbed (one page only). The full name required is
`Automatic Document Feeder(left aligned)`. Verify with:
`scanimage -d 'brother5:net1;dev0' --help | grep source`

### Why setsid is necessary

Without `setsid`, the background job is in brscan-skey's cgroup. With default
`KillMode=control-group`, systemd kills all cgroup processes when the service
stops — including the background scan job. With `KillMode=process`, only
MainPID is killed and the setsid'd child survives.

### Why systemctl cannot be used inside the script

`systemctl stop/start brscan-skey` from the setsid'd background process fails
with "Interactive authentication required" — polkit denies the request because
the process has no active D-Bus session. Use `pkill` to stop and rely on
`Restart=always` for the restart.

### Key systemd service settings

```ini
KillMode=process        # only kills MainPID, setsid'd child survives
Restart=always          # auto-restart after scan completes
RestartSec=30           # wait for scan to finish before restarting
ExecStartPre=-/bin/rm -f /tmp/brother_lockfile_saneskey_jhsga2shuioahja9kaf3dfsfdlsdfjbgfkj
```

### brscan-skey exits immediately if the lockfile is already locked

If the lockfile is held by a leftover process, brscan-skey-exe silently exits
with code 0 in ~7ms. Diagnosed via `strace`: it calls `flock(LOCK_EX|LOCK_NB)`,
gets `EAGAIN`, and calls `exit_group(0)`.

### Stale brscan-skey-exe processes steal UDP packets

Multiple brscan-skey-exe instances bind to UDP 54925 with `SO_REUSEADDR`. The OS
delivers each packet to only one socket, silently starving the systemd-managed
process. Diagnose with `ss -ulnp | grep 54925` (run without sudo to see non-root
pids).

### brscan4 → brscan5 / Ubuntu 22.04+ dependency fix

The MFC-L2800DW requires brscan5. brscan-skey depends on `libsane (>= 1.0.11-3)`
which was renamed to `libsane1` in Ubuntu 22.04+. Install `libsane1` + `sane-utils`
via apt first, then install brscan-skey with `dpkg --force-depends -i`.
Because of the force-depends, apt considers the system broken and refuses to run
`apt-get upgrade` etc. Use `apt --fix-broken install` to clear the metadata.

### Inter-VLAN routing

The scanner is on VLAN 20 (YOUR_SCANNER_VLAN_SUBNET), the server on VLAN 1 (YOUR_SERVER_VLAN_SUBNET).
Required: UniFi **LAN In** firewall rule — source IoT network, destination
YOUR_SERVER_IP, Accept, Before Predefined. UFW on the server must also allow
`ufw allow 54925/udp`.

---

## Failed Approaches

### eSCL scan from brscan-skey's script
`sane_start: Invalid argument` — scanner is in "Connecting to PC" mode and
rejects eSCL entirely.

### eSCL scan with sleep delays
Still `Invalid argument` / `Device busy` regardless of delay length. The scanner
stays in "Connecting to PC" mode until a brother5 scan completes or times out.

### Replacing brscan-skey with a Python UDP listener + eSCL
UDP packets received correctly, but eSCL returned "Device busy" because a prior
brscan-skey registration run had left the scanner blocked for 3+ minutes.

### Periodic brief brscan-skey registration runs
brscan-skey runs for 5 seconds to register then is killed. Leaves the scanner in
"Device busy" for eSCL for several minutes regardless of SIGTERM vs SIGKILL.
