#!/usr/bin/env bash
# #66 personal mode: guarded reboot of an ALREADY initialized PostgreSQL.
set -Eeuo pipefail
umask 077
deny() { echo "FINANCE_PERSONAL_START_NO_GO: $1" >&2; exit 1; }
[[ "$(id -u)" -eq 0 && "${GITHUB_ACTIONS:-}" != true ]] ||
  deny "AUTHORIZED_PRODUCTION_ROOT_REQUIRED"
[[ "${FH_FINANCE_APPROVED_SHA:-}" =~ ^[a-f0-9]{40}$ ]] ||
  deny "EXACT_INSTALLED_SHA_REQUIRED"
[[ "${FH_FINANCE_PERSONAL_MODE:-}" = YES ]] ||
  deny "EXPLICIT_PERSONAL_MODE_REQUIRED"
root="$(git -C "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)" rev-parse --show-toplevel)" ||
  deny "VERIFIED_CHECKOUT_REQUIRED"
[[ "$(git -C "$root" rev-parse HEAD)" = "$FH_FINANCE_APPROVED_SHA" ]] ||
  deny "CHECKOUT_SHA_CHANGED"
[[ -z "$(git -C "$root" status --porcelain)" ]] || deny "DIRTY_CHECKOUT"
bash "$root/deploy/postgres/scripts/personal-storage-preflight.sh" ||
  deny "PRIVATE_DATA_PATH_NOT_READY"
[[ -f "$FH_FINANCE_DATA_DIR/pgdata/PG_VERSION" &&
   "$(cat "$FH_FINANCE_DATA_DIR/pgdata/PG_VERSION")" = 17 ]] ||
  deny "EXISTING_PG17_DATA_REQUIRED_DO_NOT_REINITIALIZE"
docker inspect -f '{{.State.Status}}' fh-finance-postgres >/dev/null 2>&1 ||
  deny "FINANCE_DB_NOT_BOOTSTRAPPED"
python3 "$root/deploy/postgres/scripts/personal_port_check.py" --configured-only ||
  deny "UNSAFE_STOPPED_CONTAINER_CONFIG"
cd "$root"
# The separately attached non-internal loopback bridge is owned by this
# personal setup, not Compose. Recreating the container would silently drop it.
# Start ONLY the existing PostgreSQL container and preserve its bind mount.
python3 "$root/deploy/postgres/scripts/personal-host-bridge.py" --verify-configured ||
  deny "PERSONAL_HOST_BRIDGE_NOT_ATTACHED"
status="$(docker inspect -f '{{.State.Status}}' fh-finance-postgres)" ||
  deny "FINANCE_DB_NOT_FOUND"
if [[ "$status" = exited ]]; then
  docker start fh-finance-postgres >/dev/null || deny "FINANCE_DB_START_FAILED"
elif [[ "$status" != running ]]; then
  deny "FINANCE_DB_UNEXPECTED_STATUS"
fi
ready=0
for _ in $(seq 1 30); do
  if [[ "$(docker inspect -f '{{.State.Health.Status}}' fh-finance-postgres 2>/dev/null)" = healthy ]]; then
    ready=1; break
  fi
  sleep 1
done
[[ "$ready" = 1 ]] || deny "HEALTH_CHECK_FAILED"
python3 "$root/deploy/postgres/scripts/personal-host-bridge.py" --verify ||
  deny "PERSONAL_HOST_BRIDGE_NOT_REACHABLE"
python3 "$root/deploy/postgres/scripts/personal_port_check.py" ||
  deny "ONLY_LOOPBACK_DATABASE_PORT_ALLOWED"
[[ "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' fh-finance-postgres)" = no ]] ||
  deny "UNSAFE_DOCKER_RESTART_POLICY"
echo "FINANCE_PERSONAL_GUARDED_START=PASS"
