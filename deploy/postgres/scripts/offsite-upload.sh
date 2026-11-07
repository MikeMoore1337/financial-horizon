#!/usr/bin/env bash
# Push only an already encrypted pg_dump to a dedicated independent server.
# Remote storage must be provisioned separately; never install or reuse any DB.
set -euo pipefail
umask 077
fail() { echo "OFFSITE_BACKUP_NO_GO: $*" >&2; exit 1; }

[[ "$#" -eq 1 && -f "$1" && -s "$1" && ! -L "$1" ]] ||
  fail "One completed encrypted backup is required"
: "${FH_FINANCE_OFFSITE_HOST:?Offsite host must be configured}"
: "${FH_FINANCE_OFFSITE_USER:?Offsite user must be configured}"
: "${FH_FINANCE_OFFSITE_DIR:?Offsite destination directory required}"
: "${FH_FINANCE_OFFSITE_SSH_KEY:?Private SSH identity required}"
: "${FH_FINANCE_OFFSITE_KNOWN_HOSTS:?Pinned SSH host key file required}"

# Dedicated offsite hosts may use non-default SSH ports. Both ssh and scp
# accept the shared OpenSSH -o Port= option, avoiding ambiguous -p/-P flags.
offsite_port="${FH_FINANCE_OFFSITE_PORT:-22}"
[[ "$offsite_port" =~ ^[1-9][0-9]{0,4}$ ]] && (( 10#$offsite_port <= 65535 )) ||
  fail "Invalid offsite SSH port"

[[ "$FH_FINANCE_OFFSITE_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] ||
  fail "Invalid remote hostname"
case "$FH_FINANCE_OFFSITE_HOST" in
  localhost|127.*|0.0.0.0) fail "Localhost is not offsite storage";;
esac
[[ "$FH_FINANCE_OFFSITE_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] ||
  fail "Invalid remote user"
[[ "$FH_FINANCE_OFFSITE_DIR" =~ ^/[a-zA-Z0-9/_-]+$ ]] &&
  [[ "$FH_FINANCE_OFFSITE_DIR" != *..* ]] ||
  fail "Invalid remote path"
[[ -f "$FH_FINANCE_OFFSITE_SSH_KEY" && ! -L "$FH_FINANCE_OFFSITE_SSH_KEY" &&
   -f "$FH_FINANCE_OFFSITE_KNOWN_HOSTS" && ! -L "$FH_FINANCE_OFFSITE_KNOWN_HOSTS" ]] ||
  fail "Local SSH key/known_hosts files must be regular files"
[[ "$(stat -c %u "$FH_FINANCE_OFFSITE_SSH_KEY")" = 0 ]] &&
  [[ "$(stat -c %u "$FH_FINANCE_OFFSITE_KNOWN_HOSTS")" = 0 ]] ||
  fail "SSH identity and pinned host keys must be root-owned"
for trusted_file in "$FH_FINANCE_OFFSITE_SSH_KEY" "$FH_FINANCE_OFFSITE_KNOWN_HOSTS"; do
  [[ "$(stat -c %a "$trusted_file")" = 600 ||
     "$(stat -c %a "$trusted_file")" = 400 ]] ||
    fail "SSH identity/host key files must be 0600 or 0400"
done

backup_dir="$(realpath -- "${FH_FINANCE_BACKUP_DIR:-/var/backups/financial-horizon-finance}")"
archive="$(realpath -- "$1")"
[[ "$archive" = "$backup_dir/"* ]] || fail "Archive outside configured backup directory"
base="$(basename -- "$archive")"
[[ "$base" =~ ^fh-finance-[0-9TZ]+[.]pgdump[.]gpg$ ]] ||
  fail "Unexpected backup filename"
[[ "$(stat -c %a "$archive")" = 600 ]] || fail "Encrypted archive must be mode 0600"

identity="$FH_FINANCE_OFFSITE_SSH_KEY"
hostkey="$FH_FINANCE_OFFSITE_KNOWN_HOSTS"
opts=(-i "$identity" -o "Port=$offsite_port" -o IdentitiesOnly=yes -o BatchMode=yes
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$hostkey"
  -o ConnectTimeout=8 -o ServerAliveInterval=10 -o ServerAliveCountMax=2)
target="${FH_FINANCE_OFFSITE_USER}@${FH_FINANCE_OFFSITE_HOST}"
dest="${FH_FINANCE_OFFSITE_DIR}/$base"
tmp="$dest.partial"

perms="$(ssh "${opts[@]}" "$target" "stat -c %a '$FH_FINANCE_OFFSITE_DIR'")" ||
  fail "Offsite directory could not be inspected"
[[ "$perms" = 700 ]] || fail "Offsite destination must be mode 0700"
ssh "${opts[@]}" "$target" "test ! -e '$dest' && test ! -e '$tmp'" ||
  fail "Remote backup filename collision"
scp -B -q "${opts[@]}" -- "$archive" "$target:$tmp" ||
  fail "Encrypted archive upload failed"
local_sum="$(sha256sum -- "$archive" | cut -d' ' -f1)"
remote_sum="$(ssh "${opts[@]}" "$target" "sha256sum '$tmp'" | cut -d' ' -f1)"
[[ "$remote_sum" = "$local_sum" ]] || fail "Remote archive checksum mismatch"
ssh "${opts[@]}" "$target"   "test ! -e '$dest' && mv -n '$tmp' '$dest' && test -f '$dest' && test ! -e '$tmp'" ||
  fail "Remote atomic rename failed"
remote_final="$(ssh "${opts[@]}" "$target" "sha256sum '$dest'" | cut -d' ' -f1)"
[[ "$remote_final" = "$local_sum" ]] || fail "Offsite verification after rename failed"
echo "OFFSITE_BACKUP_PASS: encrypted archive checksum verified"
