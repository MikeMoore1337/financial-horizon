#!/usr/bin/env bash
# Manual-only restart for the reviewed finance DB: Docker daemon restart must
# never initialize PostgreSQL on a plaintext path before LUKS2 unlock.
set -Eeuo pipefail
umask 077
deny() { echo "FINANCE_GUARDED_START_NO_GO: $*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || deny "An authorized root operator is required"
[[ "${GITHUB_ACTIONS:-}" != "true" ]] || deny "Never start real database on a CI runner"
: "${FH_FINANCE_APPROVED_SHA:?Verified deployed commit SHA required}"
: "${FH_FINANCE_DATA_DIR:?Dedicated data mount required}"
: "${FH_FINANCE_MAPPER_NAME:?LUKS2 mapper required}"
[[ "$FH_FINANCE_APPROVED_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  deny "Malformed approved commit SHA"
[[ "$FH_FINANCE_DATA_DIR" = /srv/financial-horizon-finance/pgdata ]] ||
  deny "Unexpected finance data path"
[[ "$FH_FINANCE_MAPPER_NAME" = fh-finance-pg ]] ||
  deny "Unexpected LUKS2 mapper"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo="$(cd -- "$script_dir/../../.." && pwd -P)"
[[ "$(git -C "$repo" rev-parse --show-toplevel)" = "$repo" ]] ||
  deny "Must run from reviewed finance repository checkout"
[[ "$(git -C "$repo" rev-parse HEAD)" = "$FH_FINANCE_APPROVED_SHA" ]] ||
  deny "Checkout no longer matches approved production release"
[[ -z "$(git -C "$repo" status --porcelain)" ]] ||
  deny "Dirty production checkout is forbidden"
command -v docker >/dev/null || deny "Docker unavailable"

# Mandatory on EVERY supported manual start: no daemon auto-restart and no
# alternative path that can silently create a second unencrypted cluster.
bash "$script_dir/storage-preflight.sh" ||
  deny "LUKS2 mount unavailable: PostgreSQL remains stopped"
cd -- "$repo"
docker compose -f deploy/postgres/compose.yml config --quiet ||
  deny "Invalid isolated finance Compose config"
docker compose -f deploy/postgres/compose.yml up -d --wait db ||
  deny "Finance PostgreSQL did not become healthy"
policy="$(docker inspect fh-finance-postgres --format '{{.HostConfig.RestartPolicy.Name}}')"
[[ "$policy" = no ]] || deny "Unsafe Docker restart policy"
bash "$script_dir/storage-preflight.sh" ||
  deny "LUKS2 mount changed during startup"
echo "FINANCE_GUARDED_START_PASS: exact SHA, LUKS2 mount, no daemon auto-restart"
