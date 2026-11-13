#!/usr/bin/env bash
# #66: single-owner first-time PostgreSQL bootstrap on the existing VPS.
# No LUKS/offsite/PITR; encrypted local pg_dump + real isolated restore remain mandatory.
# Must run ONLY on an authorized production host after reviewed code is merged.
set -Eeuo pipefail
umask 077
deny() { echo "FINANCE_PERSONAL_DEPLOY_NO_GO: $1" >&2; exit 1; }
[[ "$(id -u)" -eq 0 ]] || deny "ROOT_REQUIRED"
[[ "${GITHUB_ACTIONS:-}" != true ]] || deny "NEVER_DEPLOY_IN_CI"
[[ "${FH_FINANCE_PERSONAL_MODE:-}" = YES ]] || deny "EXPLICIT_PERSONAL_CONSENT_REQUIRED"
[[ "${FH_FINANCE_APPROVED_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || deny "EXACT_SHA_REQUIRED"
for command in docker git gpg python3; do command -v "$command" >/dev/null || deny "MISSING_DEPENDENCY"; done
root="$(git rev-parse --show-toplevel)" || deny "NOT_A_CHECKOUT"
cd "$root"
[[ "$(git rev-parse HEAD)" = "$FH_FINANCE_APPROVED_SHA" ]] || deny "RELEASE_SHA_MISMATCH"
[[ -z "$(git status --porcelain)" ]] || deny "DIRTY_SOURCE"
[[ "$(git remote get-url origin)" =~ ^(https://github.com/|git@github.com:)MikeMoore1337/financial-horizon(\.git)?$ ]] ||
  deny "UNTRUSTED_REPOSITORY"

# Require an exact successful merge-and-CI on main. A PR-only PASS is insufficient.
python3 - "$FH_FINANCE_APPROVED_SHA" <<'PY'
import json, sys
from urllib.request import Request, urlopen

sha = sys.argv[1]
base = "https://api.github.com/repos/MikeMoore1337/financial-horizon/"
def load(path):
    request = Request(base + path, headers={
        "User-Agent": "financial-horizon-personal-release",
        "Accept": "application/vnd.github+json",
    })
    with urlopen(request, timeout=12) as resp:
        return json.load(resp)
def deny(reason):
    raise SystemExit("FINANCE_PERSONAL_DEPLOY_NO_GO: " + reason)

if load("branches/main")["commit"]["sha"] != sha:
    deny("RELEASE_IS_NOT_CURRENT_MAIN")
runs = load("actions/runs?head_sha=" + sha + "&event=push&per_page=50")
required = {"finance-postgres","app-tests","email-auth-tests","e2e-real-browser"}
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
print("FINANCE_PERSONAL_EXACT_SHA_CI=PASS")
PY

script_dir="$root/deploy/postgres/scripts"
bash "$script_dir/personal-storage-preflight.sh" || deny "PRIVATE_STORAGE_FAILED"
[[ "${FH_FINANCE_SECRETS_DIR:-/etc/financial-horizon/finance/secrets}" = /etc/financial-horizon/finance/secrets ]] ||
  deny "FINANCE_SECRETS_MUST_BE_ISOLATED"
secrets="${FH_FINANCE_SECRETS_DIR:-/etc/financial-horizon/finance/secrets}"
[[ -d "$secrets" && ! -L "$secrets" &&
   "$(stat -c '%a' "$secrets")" = 700 &&
   "$(stat -c '%u' "$secrets")" = 0 ]] || deny "PRIVATE_SECRETS_DIRECTORY_REQUIRED"
for item in admin_password migrator_password runtime_password; do
  path="$secrets/$item"
  [[ -f "$path" && ! -L "$path" &&
     "$(stat -c '%a' "$path")" = 400 &&
     "$(stat -c '%u' "$path")" = 999 &&
     "$(wc -c < "$path")" -ge 32 ]] || deny "INVALID_FINANCE_SECRET"
done
[[ "$(sha256sum "$secrets/"*_password | cut -d' ' -f1 | sort -u | wc -l)" = 3 ]] ||
  deny "FINANCE_ROLE_SECRETS_MUST_BE_DISTINCT"

backup_env=/etc/financial-horizon/finance/backup.env
[[ -f "$backup_env" && ! -L "$backup_env" &&
   "$(stat -c '%a' "$backup_env")" = 600 &&
   "$(stat -c '%u' "$backup_env")" = 0 ]] ||
  deny "ROOT_ONLY_BACKUP_CONFIG_REQUIRED"
set -a
source "$backup_env"
set +a
[[ "${FH_FINANCE_GPG_RECIPIENT:-}" =~ ^[0-9A-Fa-f]{40}$ ]] ||
  deny "GPG_RECIPIENT_FINGERPRINT_REQUIRED"
[[ "${FH_FINANCE_GPG_HOME:-}" = /etc/financial-horizon/finance/gnupg ]] ||
  deny "ISOLATED_GPG_KEYRING_REQUIRED"
[[ "${FH_FINANCE_BACKUP_DIR:-}" = /var/backups/financial-horizon-finance ]] ||
  deny "ISOLATED_BACKUP_PATH_REQUIRED"
for path in "$FH_FINANCE_GPG_HOME" "$FH_FINANCE_BACKUP_DIR"; do
  [[ -d "$path" && ! -L "$path" &&
     "$(stat -c '%a' "$path")" = 700 &&
     "$(stat -c '%u' "$path")" = 0 ]] || deny "ROOT_PRIVATE_BACKUP_PATH_REQUIRED"
done
gpg --homedir "$FH_FINANCE_GPG_HOME" --batch --with-colons --list-secret-keys "$FH_FINANCE_GPG_RECIPIENT" 2>/dev/null |
  grep -q '^sec:' || deny "LOCAL_RECOVERY_KEY_NOT_AVAILABLE"
if docker ps -a --format '{{.Names}}' | grep -Fxq fh-finance-postgres; then
  deny "EXISTING_FINANCE_DATABASE_REQUIRES_SEPARATE_UPGRADE"
fi
[[ -z "$(find "$FH_FINANCE_DATA_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]] ||
  deny "FINANCE_DATA_DIR_NOT_EMPTY_DO_NOT_REINITIALIZE"
docker compose -f deploy/postgres/compose.yml -f deploy/postgres/personal-loopback.override.yml config --quiet || deny "INVALID_PRIVATE_COMPOSE"
started=0
cleanup() {
  outcome=$?
  if (( outcome != 0 && started == 1 )); then
    docker stop --time=30 fh-finance-postgres >/dev/null 2>&1 || true
    echo "FINANCE_PERSONAL_DEPLOY_FAIL_CLOSED: database stopped; volume preserved" >&2
  fi
}
trap cleanup EXIT
docker compose -f deploy/postgres/compose.yml -f deploy/postgres/personal-loopback.override.yml up -d --wait db || deny "DB_START_FAILED"
started=1
python3 "$script_dir/personal_port_check.py" ||
  deny "ONLY_LOOPBACK_DATABASE_PORT_ALLOWED"
[[ "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' fh-finance-postgres)" = no ]] ||
  deny "DOCKER_AUTO_RESTART_FORBIDDEN"
docker compose -f deploy/postgres/compose.yml -f deploy/postgres/personal-loopback.override.yml --profile ops run --build --rm migrator ||
  deny "SCHEMA_MIGRATION_FAILED"

# Migrations may evolve; accept ONLY the actual HEAD as reported by Alembic.
docker compose -f deploy/postgres/compose.yml -f deploy/postgres/personal-loopback.override.yml --profile ops run --rm migrator >/dev/null ||
  deny "MIGRATION_IDEMPOTENCE_FAILED"
tables="$(docker exec -u postgres fh-finance-postgres psql -U postgres -d fh_finance -Atc "
 SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='finance' AND c.relkind='r' AND c.relname<>'alembic_version'
 AND c.relrowsecurity AND c.relforcerowsecurity")"
[[ "$tables" = 15 ]] || deny "FORCE_RLS_MISSING"
archive="$(bash "$script_dir/backup.sh")" || deny "ENCRYPTED_BACKUP_FAILED"
[[ -f "$archive" && -s "$archive" ]] || deny "EMPTY_BACKUP"
FH_FINANCE_GPG_HOME="$FH_FINANCE_GPG_HOME" bash "$script_dir/restore-drill.sh" "$archive" ||
  deny "REAL_ISOLATED_RESTORE_FAILED"
echo "FINANCE_PERSONAL_BOOTSTRAP=PASS"
echo "FINANCE_PERSONAL_BACKUP_RESTORE=PASS"
echo "FINANCE_FINANCIAL_API=NOT_ENABLED"
echo "FINANCE_OFFSITE_LUKS_PITR=NOT_REQUIRED_BY_OWNER"
