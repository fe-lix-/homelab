#!/usr/bin/env bash
# check-ownership.sh — verify file ownership and mode for service accounts
# Run via: make check-ownership
# Each check prints OK or FAIL with the expected vs actual values.

PASS=0
FAIL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# check_path <path> <expected_user> <expected_group> <expected_mode>
# mode is the 4-digit octal from stat --format=%a (e.g. 2775, 0755, 0750)
check_path() {
    local path="$1"
    local exp_user="$2"
    local exp_group="$3"
    local exp_mode="$4"

    if [ ! -e "$path" ]; then
        echo -e "${YELLOW}SKIP${NC}  $path (does not exist)"
        return
    fi

    local actual_user actual_group actual_mode
    actual_user=$(stat --format="%U" "$path")
    actual_group=$(stat --format="%G" "$path")
    actual_mode=$(stat --format="%04a" "$path")

    local ok=1
    local details=""

    if [ "$actual_user" != "$exp_user" ]; then
        ok=0
        details+=" user:${actual_user}≠${exp_user}"
    fi
    if [ "$actual_group" != "$exp_group" ]; then
        ok=0
        details+=" group:${actual_group}≠${exp_group}"
    fi
    if [ "$actual_mode" != "$exp_mode" ]; then
        ok=0
        details+=" mode:${actual_mode}≠${exp_mode}"
    fi

    if [ "$ok" -eq 1 ]; then
        echo -e "${GREEN}OK${NC}    $path"
        PASS=$((PASS + 1))
    else
        echo -e "${RED}FAIL${NC}  $path —$details"
        FAIL=$((FAIL + 1))
    fi
}

# check_uid <account> <expected_uid>
check_uid() {
    local account="$1"
    local exp_uid="$2"
    local actual_uid
    actual_uid=$(id -u "$account" 2>/dev/null)
    if [ -z "$actual_uid" ]; then
        echo -e "${RED}FAIL${NC}  account '$account' does not exist"
        FAIL=$((FAIL + 1))
    elif [ "$actual_uid" != "$exp_uid" ]; then
        echo -e "${RED}FAIL${NC}  account '$account' uid:${actual_uid}≠${exp_uid}"
        FAIL=$((FAIL + 1))
    else
        echo -e "${GREEN}OK${NC}    account $account uid=$actual_uid"
        PASS=$((PASS + 1))
    fi
}

# check_gid <group> <expected_gid>
check_gid() {
    local group="$1"
    local exp_gid="$2"
    local actual_gid
    actual_gid=$(getent group "$group" 2>/dev/null | cut -d: -f3)
    if [ -z "$actual_gid" ]; then
        echo -e "${RED}FAIL${NC}  group '$group' does not exist"
        FAIL=$((FAIL + 1))
    elif [ "$actual_gid" != "$exp_gid" ]; then
        echo -e "${RED}FAIL${NC}  group '$group' gid:${actual_gid}≠${exp_gid}"
        FAIL=$((FAIL + 1))
    else
        echo -e "${GREEN}OK${NC}    group $group gid=$actual_gid"
        PASS=$((PASS + 1))
    fi
}

# check_member <account> <group>
check_member() {
    local account="$1"
    local group="$2"
    if id -nG "$account" 2>/dev/null | tr ' ' '\n' | grep -qx "$group"; then
        echo -e "${GREEN}OK${NC}    $account ∈ $group"
        PASS=$((PASS + 1))
    else
        echo -e "${RED}FAIL${NC}  $account not in group '$group'"
        FAIL=$((FAIL + 1))
    fi
}

echo "=== Service accounts ==="
check_uid svc-arr      2001
check_uid svc-media    2002
check_uid svc-immich   2003
check_uid svc-paperless 2004

echo ""
echo "=== Shared data groups ==="
check_gid media-rw  3001
check_gid comics-rw 3002
check_gid photos-rw 3003
check_gid docs-rw   3004

echo ""
echo "=== Group memberships ==="
check_member svc-arr      media-rw
check_member svc-media    media-rw
check_member svc-media    comics-rw
check_member svc-immich   photos-rw
check_member svc-paperless docs-rw

echo ""
echo "=== /opt config dirs ==="
check_path /opt/sonarr       svc-arr      svc-arr      0755
check_path /opt/radarr       svc-arr      svc-arr      0755
check_path /opt/lidarr       svc-arr      svc-arr      0755
check_path /opt/prowlarr     svc-arr      svc-arr      0755
check_path /opt/bazarr       svc-arr      svc-arr      0755
check_path /opt/qbittorrent  svc-arr      svc-arr      0755
check_path /opt/sabnzbd      svc-arr      svc-arr      0755
check_path /opt/joynarr      svc-arr      svc-arr      0755
check_path /opt/mediathekarr svc-arr      svc-arr      0755
check_path /opt/jellyfin     svc-media    svc-media    0755
check_path /opt/komga        svc-media    svc-media    0755
check_path /opt/audiobookshelf svc-media  svc-media    0755
check_path /opt/immich       svc-immich   svc-immich   0750
check_path /opt/paperless    svc-paperless svc-paperless 0750

# check_tree <path> <expected_user>
# Finds all files and directories under <path> not owned by <expected_user>.
check_tree() {
    local path="$1"
    local exp_user="$2"

    if [ ! -d "$path" ]; then
        echo -e "${YELLOW}SKIP${NC}  $path (does not exist)"
        return
    fi

    local mismatches
    mismatches=$(find "$path" ! -user "$exp_user" -printf "%u %p\n" 2>/dev/null)

    if [ -z "$mismatches" ]; then
        echo -e "${GREEN}OK${NC}    $path (all owned by $exp_user)"
        PASS=$((PASS + 1))
    else
        echo -e "${RED}FAIL${NC}  $path — entries not owned by $exp_user:"
        echo "$mismatches" | while read -r owner entry; do
            echo "        $owner  $entry"
        done
        FAIL=$((FAIL + 1))
    fi
}

echo ""
echo "=== /srv data dirs ==="
check_path /srv/media        svc-arr      media-rw     2775
check_path /srv/downloads    svc-arr      media-rw     2775
check_path /srv/comics       svc-media    comics-rw    2775
check_path /srv/photos       svc-immich   photos-rw    0750
check_path /srv/paperless    svc-paperless docs-rw     0750

echo ""
echo "=== /srv media trees ==="
check_tree /srv/media/tv         svc-arr
check_tree /srv/media/movies     svc-arr
check_tree /srv/media/music      svc-arr
check_tree /srv/media/audiobooks svc-media
# NOTE: Immich runs as root in its container (no PUID/PGID support), so
# /srv/photos/upload/** will always be root-owned — only the dir itself is checked above.
check_tree /srv/paperless        svc-paperless

echo ""
echo "=== Summary ==="
echo -e "  ${GREEN}PASS${NC}: $PASS   ${RED}FAIL${NC}: $FAIL"
[ "$FAIL" -eq 0 ]
