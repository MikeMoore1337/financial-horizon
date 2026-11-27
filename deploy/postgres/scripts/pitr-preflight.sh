#!/usr/bin/env bash
# #66: read-only PostgreSQL WAL/PITR LOCAL readiness probe.
# NOT a restore, encrypted offsite proof, RPO result or production authorization.
set -Eeuo pipefail
umask 077
fail() { echo "FINANCE_PITR_LOCAL_NO_GO: $1" >&2; exit 1; }

[[ "$(id -u)" = 0 ]] || fail "AUTHORIZED_ROOT_REQUIRED"
[[ "${FH_FINANCE_DATA_DIR:-}" = /srv/financial-horizon-finance/pgdata ]] ||
  fail "UNEXPECTED_FINANCE_DATA_PATH"
[[ "${FH_FINANCE_MAPPER_NAME:-}" = fh-finance-pg ]] ||
  fail "UNEXPECTED_LUKS_MAPPER"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bash "$script_dir/storage-preflight.sh" >/dev/null ||
  fail "LUKS2_STORAGE_PREFLIGHT_FAILED"

command -v docker >/dev/null || fail "DOCKER_UNAVAILABLE"
docker inspect -f '{{.State.Running}}' fh-finance-postgres 2>/dev/null |
  grep -qx true || fail "FINANCE_POSTGRES_UNAVAILABLE"

# Only booleans and bounded ages, never archive_command text, passwords,
# WAL contents, connection URLs, financial rows or identifiers.
query="SELECT
 CASE WHEN current_setting('archive_mode')='on' THEN 1 ELSE 0 END,
 CASE WHEN current_setting('wal_level') IN ('replica','logical') THEN 1 ELSE 0 END,
 CASE WHEN current_setting('archive_command') <> ''
   OR current_setting('archive_library') <> '' THEN 1 ELSE 0 END,
 CASE WHEN last_archived_time IS NOT NULL
   AND last_archived_time >= now()-interval '30 minutes' THEN 1 ELSE 0 END,
 CASE WHEN last_failed_time IS NULL OR
   (last_archived_time IS NOT NULL AND last_failed_time < last_archived_time)
   THEN 1 ELSE 0 END
 FROM pg_stat_archiver"

if ! state="$(docker exec -u postgres fh-finance-postgres psql -X -A -t -F '|' \
  -U postgres -d fh_finance -c "$query" 2>/dev/null)"; then
  fail "ARCHIVER_METRICS_UNAVAILABLE"
fi
IFS='|' read -r mode wal configured fresh no_recent_failure extra <<< "$state"
[[ -z "${extra:-}" && "$mode" = 1 ]] || fail "ARCHIVE_MODE_DISABLED"
[[ "$wal" = 1 ]] || fail "WAL_LEVEL_UNSAFE"
[[ "$configured" = 1 ]] || fail "ARCHIVE_COMMAND_NOT_CONFIGURED"
[[ "$fresh" = 1 ]] || fail "NO_RECENT_WAL_ARCHIVE_PROOF"
[[ "$no_recent_failure" = 1 ]] || fail "LATEST_ARCHIVE_FAILED"

echo "FINANCE_PITR_LOCAL_ARCHIVER_PREFLIGHT=PASS"
echo "FINANCE_PITR_ENCRYPTED_OFFSITE=NOT_VERIFIED"
echo "FINANCE_PITR_REAL_RESTORE=NOT_VERIFIED"
echo "FINANCE_PITR_RPO_RTO=NOT_VERIFIED"
