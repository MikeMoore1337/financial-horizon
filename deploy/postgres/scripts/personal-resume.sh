#!/usr/bin/env bash
# #66 - resume ONLY the owner's known first-bootstrap failure before migrations.
# Never recreate the PostgreSQL container, re-run initdb or delete a volume.
# Requires the existing personal-prepare start.env and a fast-forwarded main.
set -Eeuo pipefail
umask 077
deny() { printf 'FINANCE_PERSONAL_RESUME_NO_GO: %s\n' "$1" >&2; exit 1; }
[[ "$(id -u)" -eq 0 ]] || deny ROOT_REQUIRED
[[ "${GITHUB_ACTIONS:-}" != true ]] || deny NEVER_RUN_IN_CI
[[ "${FH_FINANCE_PERSONAL_MODE:-}" = YES ]] || deny EXPLICIT_PERSONAL_MODE_REQUIRED
[[ "${FH_FINANCE_RESUME_PRE_MIGRATION:-}" = YES ]] || deny EXPLICIT_PRE_MIGRATION_RESUME_REQUIRED
[[ "${FH_FINANCE_DATA_DIR:-}" = /srv/financial-horizon-finance/pgdata ]] || deny FIXED_DATA_DIR_REQUIRED
[[ "${FH_FINANCE_APPROVED_SHA:-}" =~ ^[a-f0-9]{40}$ ]] || deny EXACT_SHA_REQUIRED
for command in docker git python3 gpg systemctl; do
  command -v "$command" >/dev/null || deny "MISSING_${command}"
done
root="$(git rev-parse --show-toplevel)" || deny VERIFIED_CHECKOUT_REQUIRED
cd "$root"
[[ "$root" = /opt/financial-horizon-ops ]] || deny UNEXPECTED_CHECKOUT_PATH
[[ "$(git rev-parse HEAD)" = "$FH_FINANCE_APPROVED_SHA" ]] || deny CHECKOUT_SHA_MISMATCH
[[ -z "$(git status --porcelain)" ]] || deny DIRTY_SOURCE
[[ "$(git remote get-url origin)" =~ ^(https://github.com/|git@github.com:)MikeMoore1337/financial-horizon(\.git)?$ ]] ||
  deny UNTRUSTED_REPOSITORY

# Accept only the original, owner-created configuration. Never source arbitrary
# text from a file when the protected schema can be checked as pure data.
start_env=/etc/financial-horizon/finance/start.env
[[ -f "$start_env" && ! -L "$start_env" &&
   "$(stat -c '%a:%u' "$start_env")" = 600:0 ]] ||
  deny ORIGINAL_START_ENV_REQUIRED
old_sha="$(python3 - "$start_env" "$root" <<'PY'
import re
import sys
from pathlib import Path

try:
    entries = Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()
    values = {}
    for entry in entries:
        key, value = entry.split("=", 1)
        if key in values:
            raise ValueError()
        values[key] = value
    if set(values) != {
        "FH_FINANCE_PERSONAL_MODE", "FH_FINANCE_APPROVED_SHA",
        "FH_FINANCE_DATA_DIR", "FH_FINANCE_CHECKOUT_DIR",
    } or values["FH_FINANCE_PERSONAL_MODE"] != "YES" or (
        values["FH_FINANCE_DATA_DIR"] != "/srv/financial-horizon-finance/pgdata"
    ) or values["FH_FINANCE_CHECKOUT_DIR"] != sys.argv[2] or not re.fullmatch(
        r"[0-9a-f]{40}", values["FH_FINANCE_APPROVED_SHA"]
    ):
        raise ValueError()
    print(values["FH_FINANCE_APPROVED_SHA"])
except (OSError, ValueError, UnicodeError):
    raise SystemExit("FINANCE_PERSONAL_RESUME_NO_GO: INVALID_ORIGINAL_START_ENV")
PY
)" || deny INVALID_ORIGINAL_START_ENV
[[ "$old_sha" != "$FH_FINANCE_APPROVED_SHA" ]] ||
  deny NEW_RELEASE_SHA_REQUIRED
git merge-base --is-ancestor "$old_sha" "$FH_FINANCE_APPROVED_SHA" ||
  deny NEW_SHA_MUST_FAST_FORWARD_FROM_ORIGINAL

# Do not approve a new source revision based on checks of the old checkout.
python3 - "$FH_FINANCE_APPROVED_SHA" <<'PY'
import json
import sys
from urllib.request import Request, urlopen

sha = sys.argv[1]
base = "https://api.github.com/repos/MikeMoore1337/financial-horizon/"
def load(path):
    request = Request(base + path, headers={
        "User-Agent": "financial-horizon-personal-release",
        "Accept": "application/vnd.github+json",
    })
    with urlopen(request, timeout=12) as response:
        return json.load(response)
def deny(reason):
    raise SystemExit("FINANCE_PERSONAL_RESUME_NO_GO: " + reason)

if load("branches/main")["commit"]["sha"] != sha:
    deny("RELEASE_IS_NOT_CURRENT_MAIN")
runs = load("actions/runs?head_sha=" + sha + "&event=push&per_page=50")
required = {"finance-postgres", "app-tests", "email-auth-tests", "e2e-real-browser"}
if not any(
    run.get("name") == "tests" and run.get("head_sha") == sha
    and run.get("status") == "completed" and run.get("conclusion") == "success"
    and required.issubset({
        job.get("name") for job in load(
            "actions/runs/" + str(run["id"]) + "/jobs?per_page=100"
        ).get("jobs", []) if job.get("conclusion") == "success"
    })
    for run in runs.get("workflow_runs", [])
):
    deny("EXACT_SHA_REQUIRED_CI_INCOMPLETE")
print("FINANCE_PERSONAL_RESUME_EXACT_SHA_CI=PASS")
PY

# This is NOT a generic repair/upgrade script. It accepts only a stopped
# PostgreSQL 17 cluster created by personal-bootstrap before Alembic ran.
bash deploy/postgres/scripts/personal-storage-preflight.sh ||
  deny STORAGE_PREFLIGHT_FAILED
[[ "$(systemctl is-enabled fh-finance-personal.service 2>/dev/null || true)" != enabled ]] ||
  deny DISABLE_PERSONAL_SERVICE_BEFORE_RESUME
[[ "$(systemctl is-active fh-finance-personal.service 2>/dev/null || true)" != active ]] ||
  deny PERSONAL_SERVICE_ALREADY_ACTIVE
[[ "$(systemctl is-enabled fh-finance-personal-backup.timer 2>/dev/null || true)" != enabled ]] ||
  deny DISABLE_BACKUP_TIMER_BEFORE_RESUME
[[ "$(systemctl is-active fh-finance-personal-backup.timer 2>/dev/null || true)" != active ]] ||
  deny BACKUP_TIMER_ALREADY_ACTIVE
[[ -f "$FH_FINANCE_DATA_DIR/pgdata/PG_VERSION" &&
   ! -L "$FH_FINANCE_DATA_DIR/pgdata/PG_VERSION" &&
   "$(cat "$FH_FINANCE_DATA_DIR/pgdata/PG_VERSION")" = 17 ]] ||
  deny EXISTING_PG17_CLUSTER_REQUIRED
[[ "$(docker inspect -f '{{.State.Status}}' fh-finance-postgres 2>/dev/null)" = exited ]] ||
  deny STOPPED_CONTAINER_REQUIRED
[[ "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' fh-finance-postgres)" = no ]] ||
  deny DOCKER_AUTO_RESTART_FORBIDDEN
python3 deploy/postgres/scripts/personal_port_check.py --configured-only ||
  deny UNSAFE_EXISTING_CONTAINER_CONFIG
docker compose -f deploy/postgres/compose.yml -f deploy/postgres/personal-loopback.override.yml config --quiet ||
  deny INVALID_PRIVATE_COMPOSE

secrets=/etc/financial-horizon/finance/secrets
[[ -d "$secrets" && ! -L "$secrets" &&
   "$(stat -c '%a:%u' "$secrets")" = 700:0 ]] || deny PRIVATE_SECRETS_REQUIRED
for item in admin_password migrator_password runtime_password; do
  path="$secrets/$item"
  [[ -f "$path" && ! -L "$path" &&
     "$(stat -c '%a:%u' "$path")" = 400:999 &&
     "$(wc -c < "$path")" -ge 32 ]] || deny INVALID_ROLE_SECRET
done
[[ "$(sha256sum "$secrets/"*_password | cut -d' ' -f1 | sort -u | wc -l)" = 3 ]] ||
  deny ROLE_SECRETS_NOT_DISTINCT
backup_env=/etc/financial-horizon/finance/backup.env
[[ -f "$backup_env" && ! -L "$backup_env" &&
   "$(stat -c '%a:%u' "$backup_env")" = 600:0 ]] ||
  deny PRIVATE_BACKUP_ENV_REQUIRED
set -a
source "$backup_env"
set +a
[[ "${FH_FINANCE_GPG_RECIPIENT:-}" =~ ^[0-9A-Fa-f]{40}$ &&
   "${FH_FINANCE_GPG_HOME:-}" = /etc/financial-horizon/finance/gnupg &&
   "${FH_FINANCE_BACKUP_DIR:-}" = /var/backups/financial-horizon-finance ]] ||
  deny INVALID_PRIVATE_BACKUP_CONFIG
for p in "$FH_FINANCE_GPG_HOME" "$FH_FINANCE_BACKUP_DIR"; do
  [[ -d "$p" && ! -L "$p" &&
     "$(stat -c '%a:%u' "$p")" = 700:0 ]] || deny PRIVATE_BACKUP_DIRECTORY_REQUIRED
done
gpg --homedir "$FH_FINANCE_GPG_HOME" --batch --with-colons --list-secret-keys "$FH_FINANCE_GPG_RECIPIENT" 2>/dev/null |
  grep -q '^sec:' || deny GPG_DECRYPTION_KEY_REQUIRED

started=0
cleanup() {
  outcome=$?
  if (( outcome != 0 && started == 1 )); then
    docker stop --time=30 fh-finance-postgres >/dev/null 2>&1 || true
    echo "FINANCE_PERSONAL_RESUME_FAIL_CLOSED: database stopped; volume preserved" >&2
  fi
}
trap cleanup EXIT
# docker start does not recreate the container or ever run initdb again.
docker start fh-finance-postgres >/dev/null || deny STOPPED_DB_START_FAILED
started=1
ready=0
for _ in $(seq 1 30); do
  if docker exec -u postgres fh-finance-postgres     psql -X -U postgres -d fh_finance -Atqc 'SELECT 1' 2>/dev/null | grep -qx 1; then
    ready=1; break
  fi
  sleep 1
done
[[ "$ready" = 1 ]] || deny EXISTING_FINANCE_DB_NOT_READY
python3 deploy/postgres/scripts/personal_port_check.py ||
  deny ONLY_LOOPBACK_DATABASE_PORT_ALLOWED

# A populated or partly migrated DB is deliberately ineligible for automatic
# first-bootstrap recovery. Never stamp, drop, truncate or overwrite schema.
table_count="$(docker exec -u postgres fh-finance-postgres   psql -X -U postgres -d fh_finance -Atqc \
  "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='finance'")" ||
  deny CANNOT_INSPECT_EXISTING_FINANCE_SCHEMA
[[ "$table_count" = 0 ]] || deny EXISTING_SCHEMA_REQUIRES_MANUAL_REVIEW
role_count="$(docker exec -u postgres fh-finance-postgres   psql -X -U postgres -d postgres -Atqc \
  "SELECT count(*) FROM pg_roles WHERE rolname IN ('fh_finance_runtime','fh_finance_migrator')")" ||
  deny CANNOT_INSPECT_FINANCE_ROLES
[[ "$role_count" = 2 ]] || deny EXPECTED_DB_ROLES_MISSING

docker compose -f deploy/postgres/compose.yml -f deploy/postgres/personal-loopback.override.yml \
  --profile ops run --no-deps --build --rm migrator ||
  deny SCHEMA_MIGRATION_FAILED
docker compose -f deploy/postgres/compose.yml -f deploy/postgres/personal-loopback.override.yml \
  --profile ops run --no-deps --rm migrator >/dev/null ||
  deny MIGRATION_IDEMPOTENCE_FAILED
tables="$(docker exec -u postgres fh-finance-postgres psql -X -U postgres -d fh_finance -Atqc "
 SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='finance' AND c.relkind='r' AND c.relname<>'alembic_version'
 AND c.relrowsecurity AND c.relforcerowsecurity")"
[[ "$tables" = 15 ]] || deny FORCE_RLS_MISSING
archive="$(bash deploy/postgres/scripts/backup.sh)" || deny ENCRYPTED_BACKUP_FAILED
[[ -f "$archive" && -s "$archive" ]] || deny EMPTY_BACKUP
FH_FINANCE_GPG_HOME="$FH_FINANCE_GPG_HOME" \
  bash deploy/postgres/scripts/restore-drill.sh "$archive" ||
  deny REAL_ISOLATED_RESTORE_FAILED

# Switch ONLY the existing SHA pin, AFTER successful backup/restore. Atomic
# rename preserves the original configuration if any preceding step failed.
tmp="$(mktemp /etc/financial-horizon/finance/start.env.new.XXXXXXXX)" ||
  deny CANNOT_PREPARE_START_PIN
trap 'cleanup; rm -f -- "${tmp:-}"' EXIT
sed "s/^FH_FINANCE_APPROVED_SHA=$old_sha$/FH_FINANCE_APPROVED_SHA=$FH_FINANCE_APPROVED_SHA/" \
  "$start_env" > "$tmp" || deny START_PIN_UPDATE_FAILED
[[ "$(stat -c '%a:%u' "$tmp")" = 600:0 ]] || deny START_PIN_PERMISSIONS
grep -Fxq "FH_FINANCE_APPROVED_SHA=$FH_FINANCE_APPROVED_SHA" "$tmp" ||
  deny NEW_SHA_NOT_PINNED
mv -f -- "$tmp" "$start_env" || deny START_PIN_ATOMIC_REPLACE_FAILED
unset tmp
printf 'FINANCE_PERSONAL_RESUME=PASS\n'
printf 'FINANCE_PERSONAL_BACKUP_RESTORE=PASS\n'
printf 'FINANCE_PERSONAL_START_ENV_UPDATED=PASS\n'
printf 'FINANCE_FINANCIAL_API=NOT_ENABLED\n'
