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
cd "$root"
docker compose -f deploy/postgres/compose.yml up -d --wait db ||
  deny "HEALTH_CHECK_FAILED"
[[ -z "$(docker port fh-finance-postgres)" ]] || deny "DB_PORT_PUBLISHED"
[[ "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' fh-finance-postgres)" = no ]] ||
  deny "UNSAFE_DOCKER_RESTART_POLICY"
echo "FINANCE_PERSONAL_GUARDED_START=PASS"
