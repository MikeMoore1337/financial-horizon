#!/usr/bin/env bash
# Lightweight owner-approved #66 mode; private PostgreSQL on the existing VPS.
# Read-only, does not create mounts, keys, data, containers or databases.
set -Eeuo pipefail
deny() { echo "FINANCE_PERSONAL_STORAGE_NO_GO: $1" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || deny "AUTHORIZED_ROOT_REQUIRED"
[[ "${GITHUB_ACTIONS:-}" != true ]] || deny "CI_IS_NOT_PRODUCTION"
[[ "${FH_FINANCE_PERSONAL_MODE:-}" = YES ]] || deny "EXPLICIT_PERSONAL_MODE_REQUIRED"
[[ "${FH_FINANCE_DATA_DIR:-}" = /srv/financial-horizon-finance/pgdata ]] ||
  deny "UNEXPECTED_DATA_DIR"
[[ -d "$FH_FINANCE_DATA_DIR" && ! -L "$FH_FINANCE_DATA_DIR" ]] ||
  deny "MISSING_PRIVATE_FINANCE_DIRECTORY"
[[ "$(realpath -- "$FH_FINANCE_DATA_DIR")" = "$FH_FINANCE_DATA_DIR" ]] ||
  deny "NONCANONICAL_DATA_DIR"
[[ "$(stat -c '%a' "$FH_FINANCE_DATA_DIR")" = 700 &&
   "$(stat -c '%u' "$FH_FINANCE_DATA_DIR")" = 999 ]] ||
  deny "PRIVATE_DIRECTORY_MUST_BE_0700_OWNED_BY_POSTGRES"

# The owner's existing root disk may be used. Guard its free space so the
# personal finance cluster cannot exhaust co-located services' root partition.
free_root="$(df -B1 --output=avail / | awk 'NR==2 {print $1}')"
free_finance="$(df -B1 --output=avail "$FH_FINANCE_DATA_DIR" | awk 'NR==2 {print $1}')"
[[ "$free_root" =~ ^[0-9]+$ && "$free_finance" =~ ^[0-9]+$ ]] ||
  deny "UNKNOWN_DISK_CAPACITY"
(( free_root >= 3 * 1024 * 1024 * 1024 )) || deny "INSUFFICIENT_ROOT_RESERVE"
(( free_finance >= 1 * 1024 * 1024 * 1024 )) || deny "INSUFFICIENT_FINANCE_CAPACITY"
echo "FINANCE_PERSONAL_STORAGE_PREFLIGHT=PASS"
echo "LUKS_OFFSITE_PITR=NOT_REQUIRED_BY_OWNER"
