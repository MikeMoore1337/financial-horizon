#!/usr/bin/env bash
# Controlled first production deployment for Financial Horizon #66.
# Refuses to run until independently approved exact-SHA CI and LUKS2 gates pass.
# Never touches auth SQLite, other projects or browser IndexedDB.
set -euo pipefail
umask 077
deny() { echo "FINANCE_PRODUCTION_NO_GO: $*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || deny "First production bootstrap requires authorized root"
: "${FH_FINANCE_APPROVED_SHA:?Final merged production SHA required}"
: "${FH_FINANCE_REVIEWED_HEAD_SHA:?Independently reviewed PR HEAD required}"
[[ "$FH_FINANCE_APPROVED_SHA" =~ ^[a-f0-9]{40}$ ]] || deny "Invalid production SHA"
[[ "$FH_FINANCE_REVIEWED_HEAD_SHA" =~ ^[a-f0-9]{40}$ ]] || deny "Invalid reviewed SHA"

root="$(git rev-parse --show-toplevel)" || deny "Must run from a verified Git checkout"
cd "$root"
[[ "$(git rev-parse HEAD)" = "$FH_FINANCE_APPROVED_SHA" ]] ||
  deny "Checkout HEAD does not match approved merged SHA"
[[ -z "$(git status --porcelain)" ]] || deny "Refusing dirty checkout"
command -v docker >/dev/null || deny "Docker is required"
command -v python3 >/dev/null || deny "Python3 is required"

# Review and CI are fetched from the public GitHub origin. No token or
# financial data is sent. Network/JSON errors fail closed.
python3 - "$FH_FINANCE_APPROVED_SHA" "$FH_FINANCE_REVIEWED_HEAD_SHA" <<'PY'
import json, re, sys
from urllib.request import Request, urlopen

prod, reviewed = sys.argv[1:]
base = "https://api.github.com/repos/MikeMoore1337/financial-horizon/"
def api(path):
    request = Request(base + path, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "financial-horizon-issue66-release-gate",
    })
    with urlopen(request, timeout=12) as response:
        return json.load(response)

def denied(reason):
    raise SystemExit("FINANCE_PRODUCTION_NO_GO: " + reason)

pr = api("pulls/79")
if pr.get("merged") is not True or not pr.get("merged_at"):
    denied("PR #79 has not been merged")
if pr.get("merge_commit_sha") != prod:
    denied("Production SHA must be PR #79 merge commit")
if pr.get("head", {}).get("sha") != reviewed:
    denied("The reviewed PR HEAD differs from the merged PR")

reviews = api("pulls/79/reviews?per_page=100")
if len(reviews) >= 100:
    denied("Review pagination not exhausted")
latest = {}
for item in reviews:
    author = item.get("user") or {}
    username = author.get("login")
    if (username and username != "MikeMoore1337"
            and item.get("author_association") in ("COLLABORATOR", "MEMBER", "OWNER")):
        latest[username] = item
if not any(r.get("state") == "APPROVED" and r.get("commit_id") == reviewed
           for r in latest.values()):
    denied("No independent APPROVED review for the exact financial PR HEAD")

required = {"finance-postgres", "app-tests", "email-auth-tests", "e2e-real-browser"}
for sha, event in ((reviewed, "pull_request"), (prod, "push")):
    runs = api("actions/runs?head_sha=" + sha + "&event=" + event + "&per_page=50")
    candidates = [
        r for r in runs.get("workflow_runs", []) if
        r.get("name") == "tests" and r.get("head_sha") == sha and
        r.get("status") == "completed" and r.get("conclusion") == "success"
    ]
    if not candidates:
        denied("Missing successful CI for SHA " + sha[:12])
    success = False
    for run in candidates:
        jobs = api("actions/runs/" + str(run["id"]) + "/jobs?per_page=100")
        results = {j.get("name"): j.get("conclusion")
                   for j in jobs.get("jobs", [])}
        if all(results.get(name) == "success" for name in required):
            success = True
            break
    if not success:
        denied("Required CI job is missing or unsuccessful for SHA " + sha[:12])
print("FINANCE_GITHUB_RELEASE_GATES_PASS: approved PR and exact-SHA CI")
PY

: "${FH_FINANCE_DATA_DIR:?Encrypted mount path required}"
: "${FH_FINANCE_MAPPER_NAME:?LUKS2 mapper name required}"
[[ "$FH_FINANCE_DATA_DIR" = /srv/financial-horizon-finance/pgdata ]] ||
  deny "Only dedicated Financial Horizon data path is permitted"
[[ "$FH_FINANCE_MAPPER_NAME" = fh-finance-pg ]] ||
  deny "Only the dedicated Financial Horizon LUKS2 mapper is permitted"
[[ "${FH_FINANCE_SECRETS_DIR:-/etc/financial-horizon/finance/secrets}" = /etc/financial-horizon/finance/secrets ]] ||
  deny "Finance secrets cannot be drawn from an unrelated project"
bash "$root/deploy/postgres/scripts/storage-preflight.sh" ||
  deny "Dedicated encrypted storage gate failed"

# Dedicated role secrets exist only outside git and must be unreadable to
# unrelated host identities. Docker mounts them read-only inside container.
secret_dir="${FH_FINANCE_SECRETS_DIR:-/etc/financial-horizon/finance/secrets}"
[[ -d "$secret_dir" && ! -L "$secret_dir" ]] || deny "Dedicated secrets directory missing"
[[ "$(stat -c %a "$secret_dir")" = 700 ]] ||
  deny "Secrets directory must be 0700"
for secret in admin_password migrator_password runtime_password; do
    path="$secret_dir/$secret"
    [[ -f "$path" && ! -L "$path" ]] || deny "Required PostgreSQL secret unavailable"
    [[ "$(stat -c %a "$path")" = 400 ]] || deny "Secret must be mode 0400"
    [[ "$(stat -c %u "$path")" = 999 ]] || deny "Secret must belong to PostgreSQL UID 999"
    [[ "$(wc -c < "$path")" -ge 32 ]] || deny "Secret is too short"
done
[[ -f /etc/financial-horizon/finance/backup.env ]] ||
  deny "Encrypted backup and offsite settings missing"
[[ "$(stat -c %a /etc/financial-horizon/finance/backup.env)" = 600 ]] ||
  deny "Offsite configuration file must be mode 0600"
# Source only the root-protected reviewed deployment environment.
set -a
source /etc/financial-horizon/finance/backup.env
set +a
for var in FH_FINANCE_GPG_RECIPIENT FH_FINANCE_GPG_HOME FH_FINANCE_BACKUP_DIR \
           FH_FINANCE_OFFSITE_HOST FH_FINANCE_OFFSITE_USER FH_FINANCE_OFFSITE_DIR \
           FH_FINANCE_OFFSITE_SSH_KEY FH_FINANCE_OFFSITE_KNOWN_HOSTS; do
    [[ -n "${!var:-}" ]] || deny "Mandatory backup/offsite setting missing: $var"
done
[[ -d "$FH_FINANCE_GPG_HOME" && -d "$FH_FINANCE_BACKUP_DIR" ]] ||
  deny "GPG keyring or private encrypted backup directory missing"
[[ "$(stat -c %a "$FH_FINANCE_BACKUP_DIR")" = 700 ]] ||
  deny "Backup directory must be 0700"
gpg --homedir "$FH_FINANCE_GPG_HOME" --batch --list-keys "$FH_FINANCE_GPG_RECIPIENT" >/dev/null ||
  deny "Public backup encryption key is not provisioned"

# First install only. A subsequent schema/data upgrade requires an independent
# rollout plan and separate backup+restore confirmation.
if docker ps -a --format '{{.Names}}' | grep -Fxq fh-finance-postgres; then
  deny "A finance DB container already exists: refusing to overwrite"
fi
docker compose -f deploy/postgres/compose.yml config --quiet ||
  deny "Invalid isolated production Compose configuration"
docker compose -f deploy/postgres/compose.yml up -d --wait db ||
  deny "PostgreSQL failed to reach healthcheck"
docker compose -f deploy/postgres/compose.yml --profile ops run --build --rm migrator ||
  deny "Alembic migration failure; preserve volume for investigation"

version="$(docker exec -u postgres fh-finance-postgres psql -U postgres -d fh_finance -Atc   'SELECT version_num FROM finance.alembic_version')"
[[ "$version" = 0001_initial ]] || deny "Unexpected Alembic head"
rls="$(docker exec -u postgres fh-finance-postgres psql -U postgres -d fh_finance -Atc "
  SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='finance' AND c.relkind='r' AND c.relname<>'alembic_version'
    AND c.relrowsecurity AND c.relforcerowsecurity")"
[[ "$rls" = 15 ]] || deny "FORCE RLS incomplete"
[[ -z "$(docker port fh-finance-postgres)" ]] ||
  deny "Unexpected PostgreSQL public port"

# Backup/offsite is a separate gate. No public API or sync gets enabled.
bash "$root/deploy/postgres/scripts/backup-and-offsite.sh" ||
  deny "First encrypted offsite backup failed"
echo "FINANCE_DB_BOOTSTRAPPED: exact merged SHA, FORCE RLS, encrypted offsite copy"
echo "RESTORE_ACCEPTANCE_STILL_REQUIRED: decrypt/restore on independent trusted host"
