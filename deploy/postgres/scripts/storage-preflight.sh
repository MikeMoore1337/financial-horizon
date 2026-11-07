#!/usr/bin/env bash
# Fail-closed production gate: never put finance data on an unencrypted bind mount.
# Read-only check. It creates neither devices nor databases.
set -euo pipefail
fail() { echo "FINANCE_STORAGE_NO_GO: $*" >&2; exit 1; }

: "${FH_FINANCE_DATA_DIR:?FH_FINANCE_DATA_DIR is required}"
: "${FH_FINANCE_MAPPER_NAME:?FH_FINANCE_MAPPER_NAME is required}"
[[ "$FH_FINANCE_MAPPER_NAME" =~ ^[a-zA-Z0-9_-]+$ ]] || fail "Invalid mapper name"
[[ "$FH_FINANCE_DATA_DIR" = /* ]] || fail "Data directory must be an absolute path"
[[ ! -L "$FH_FINANCE_DATA_DIR" ]] || fail "Symbolic link forbidden"
[[ -d "$FH_FINANCE_DATA_DIR" ]] || fail "Data mount directory does not exist"
canonical="$(realpath -- "$FH_FINANCE_DATA_DIR")"
[[ "$canonical" = "$FH_FINANCE_DATA_DIR" ]] || fail "Noncanonical data path"
mounted_at="$(findmnt -n -o TARGET --mountpoint "$FH_FINANCE_DATA_DIR" || true)"
[[ "$mounted_at" = "$FH_FINANCE_DATA_DIR" ]] || fail "Directory is not an independent mountpoint"
mapper="/dev/mapper/$FH_FINANCE_MAPPER_NAME"
[[ -b "$mapper" ]] || fail "Dedicated LUKS mapper does not exist"
cryptsetup status "$FH_FINANCE_MAPPER_NAME" >/dev/null 2>&1 ||
  fail "Dedicated LUKS mapper is not active"
crypttype="$(cryptsetup status "$FH_FINANCE_MAPPER_NAME" | sed -n 's/^ *type: *//p' | head -n 1)"
[[ "$crypttype" = "LUKS2" ]] || fail "Only LUKS2 encrypted storage is accepted"
mounted_device="$(findmnt -n -o MAJ:MIN --mountpoint "$FH_FINANCE_DATA_DIR")"
crypt_device="$(lsblk -dn -o MAJ:MIN "$mapper" | tr -d '[:space:]')"
[[ -n "$mounted_device" && "$mounted_device" = "$crypt_device" ]] ||
  fail "Mounted device does not match dedicated LUKS2 mapper"
[[ "$(stat -c '%a' "$FH_FINANCE_DATA_DIR")" = "700" ]] ||
  fail "Mountpoint must have permissions 0700"
[[ "$(stat -c '%u' "$FH_FINANCE_DATA_DIR")" = "999" ]] ||
  fail "Mountpoint must be owned by finance PostgreSQL UID 999"

# Capacity guard: never consume the host root disk reserve of co-located
# services merely to provision a new finance cluster. Values are bytes.
free_data="$(df -B1 --output=avail "$FH_FINANCE_DATA_DIR" | awk 'NR==2 {print $1}')"
free_root="$(df -B1 --output=avail / | awk 'NR==2 {print $1}')"
[[ "$free_data" =~ ^[0-9]+$ && "$free_root" =~ ^[0-9]+$ ]] ||
  fail "Cannot determine storage capacity"
(( free_data >= 2 * 1024 * 1024 * 1024 )) ||
  fail "Encrypted financial volume needs at least 2 GiB available"
(( free_root >= 5 * 1024 * 1024 * 1024 )) ||
  fail "Host needs at least 5 GiB root reserve for other services"
echo "FINANCE_STORAGE_PRECHECK_PASS: dedicated LUKS2 mount and disk reserves"
