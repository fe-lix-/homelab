#!/usr/bin/env bash
# Extract existing mailbox users from the mail VPS into a YAML snippet
# ready to paste under `mail_users:` in vault.yml. Hashes are written
# directly to the output file — never echoed to stdout.
set -euo pipefail

OUTPUT="${1:-/tmp/mail_users_extract.yml}"
MAIL_SSH_USER="${MAIL_SSH_USER:-root}"
MAIL_SSH_HOST="${MAIL_SSH_HOST:-mail.delval.eu}"
MAIL_SSH_KEY="${MAIL_SSH_KEY:-$HOME/.ssh/mail.delval.eu}"

# Skip system / role accounts.
SKIP_USERS_RE='^(vmail|syslog|nobody)$'

remote='
set -e
awk -F: "\$6 ~ /^\/home\// {print \$1}" /etc/passwd |
while read -r u; do
  case "$u" in
    vmail|syslog|nobody) continue ;;
  esac
  hash=$(getent shadow "$u" | cut -d: -f2)
  gecos=$(getent passwd "$u" | cut -d: -f5)
  shell=$(getent passwd "$u" | cut -d: -f7)
  groups=$(id -nG "$u" | tr " " "\n" | grep -vx "$u" | grep -vx mail | paste -sd "," -)
  printf "  - name: %s\n" "$u"
  [ -n "$gecos" ] && printf "    full_name: \"%s\"\n" "$gecos"
  printf "    shell: %s\n" "$shell"
  printf "    password_hash: \"%s\"\n" "$hash"
  if [ -n "$groups" ]; then
    printf "    groups: [%s]\n" "$groups"
  fi
done
'

# Write directly to the output file with restricted perms.
umask 077
ssh -i "$MAIL_SSH_KEY" -o ControlPath=none "$MAIL_SSH_USER@$MAIL_SSH_HOST" "$remote" > "$OUTPUT"
chmod 600 "$OUTPUT"

# Sanity-check the file exists and has > 0 bytes without revealing contents.
if [ -s "$OUTPUT" ]; then
  echo "Wrote $OUTPUT ($(wc -l <"$OUTPUT") lines)"
  echo "Review with your editor, then paste under 'mail_users:' in vault.yml"
  echo "Delete the temp file after: rm $OUTPUT"
else
  echo "WARNING: $OUTPUT is empty — extraction failed"
  exit 1
fi
