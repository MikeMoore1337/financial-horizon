#!/usr/bin/env bash
# Root-owned private backup script. No plaintext dump is written to disk.
set -euo pipefail
umask 077
exec 9>"${FH_FINANCE_BACKUP_LOCK_FILE:-/run/lock/fh-finance-backup.lock}"
flock -n 9 || exit 1
: "${FH_FINANCE_GPG_RECIPIENT:?Backup recipient fingerprint required}"
KEYRING="${FH_FINANCE_GPG_HOME:-/etc/financial-horizon/finance/gnupg}"
BACKUP_DIR="${FH_FINANCE_BACKUP_DIR:-/var/backups/financial-horizon-finance}"
test -d "$KEYRING"
test -d "$BACKUP_DIR"
test "$(stat -c %a "$BACKUP_DIR")" = "700"
docker inspect -f '{{.State.Running}}' fh-finance-postgres | grep -qx true
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$BACKUP_DIR/fh-finance-$stamp.pgdump.gpg"
temp="$file.partial"
trap 'rm -f "$temp"' EXIT
docker exec -u postgres fh-finance-postgres \
  pg_dump -U postgres --format=custom --no-owner --no-acl --dbname=fh_finance \
  | gpg --homedir "$KEYRING" --batch --no-tty --trust-model always \
    --recipient "$FH_FINANCE_GPG_RECIPIENT" --encrypt --output "$temp"
test -s "$temp"
chmod 600 "$temp"
mv -n "$temp" "$file"
trap - EXIT
# Do not remove the last known-good encrypted backup.
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'fh-finance-*.pgdump.gpg' -mtime +30 -print0 \
  | xargs -0 -r rm --
