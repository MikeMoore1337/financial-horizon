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
# Nanoseconds prevent same-second collisions on consecutive backups.
stamp="$(date -u +%Y%m%dT%H%M%S%NZ)"
file="$BACKUP_DIR/fh-finance-$stamp.pgdump.gpg"
temp="$file.partial"
test ! -e "$file" && test ! -e "$temp"
trap 'rm -f "$temp"' EXIT
docker exec -u postgres fh-finance-postgres \
  # Preserve object ownership AND GRANT/REVOKE; otherwise a restored migrator
  # cannot own or evolve the recovered schema.
  pg_dump -U postgres --format=custom --dbname=fh_finance \
  | gpg --homedir "$KEYRING" --batch --no-tty --trust-model always \
    --recipient "$FH_FINANCE_GPG_RECIPIENT" --encrypt --output "$temp"
test -s "$temp"
chmod 600 "$temp"
mv --no-clobber "$temp" "$file"
# GNU mv --no-clobber may return success without moving on collisions.
test ! -e "$temp" && test -s "$file"
trap - EXIT

# Retain the three newest archives regardless of age; prune the rest only
# after 30 days. An older verified recovery point is never replaced silently.
mapfile -d '' -t entries < <(
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'fh-finance-*.pgdump.gpg' -printf '%T@ %p\0' | sort -z -nr
)
for ((i = 3; i < ${#entries[@]}; i++)); do
  candidate="${entries[$i]#* }"
  if test -f "$candidate" && test -n "$(find "$candidate" -mtime +30 -print -quit)"; then
    rm -- "$candidate"
  fi
done
# Caller must know the exact archive when mirroring it to independent storage.
printf '%s\n' "$file"
