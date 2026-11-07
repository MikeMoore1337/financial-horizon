#!/usr/bin/env bash
# Exercise actual deployment Compose image, roles and migrator on disposable CI.
set -euo pipefail
if [ "$GITHUB_ACTIONS" != "true" ] || [ "$FH_FINANCE_CI_ALLOW_BOOTSTRAP" != "yes" ]; then
  echo "Compose smoke is restricted to synthetic GitHub Actions runner" >&2
  exit 1
fi
umask 077
export FH_FINANCE_SECRETS_DIR
FH_FINANCE_SECRETS_DIR="$(mktemp -d)"
export FH_FINANCE_DATA_DIR="$FH_FINANCE_SECRETS_DIR/data"
mkdir -m 700 "$FH_FINANCE_DATA_DIR"
cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    # Synthetic CI-only secrets; do not reuse this error path in production.
    docker compose -f deploy/postgres/compose.yml ps -a >&2 || true
    docker compose -f deploy/postgres/compose.yml logs --no-color --tail=80 db >&2 || true
    docker inspect fh-finance-postgres --format 'health={{json .State.Health}}' >&2 || true
  fi
  docker compose -f deploy/postgres/compose.yml --profile ops down --volumes --remove-orphans >/dev/null 2>&1 || true
  # The disposable bind-mounted data dir belongs to postgres UID 999.
  # Restore CI runner ownership before removing only this mktemp directory.
  sudo chown -R "$(id -u):$(id -g)" "$FH_FINANCE_DATA_DIR" >/dev/null 2>&1 || true
  rm -rf "$FH_FINANCE_SECRETS_DIR"
  return "$status"
}
trap cleanup EXIT
printf '%s' 'CI-only-synthetic-admin-password-0123456789' > "$FH_FINANCE_SECRETS_DIR/admin_password"
printf '%s' 'CI-only-synthetic-migrator-password-0123456789' > "$FH_FINANCE_SECRETS_DIR/migrator_password"
printf '%s' 'CI-only-synthetic-runtime-password-0123456789' > "$FH_FINANCE_SECRETS_DIR/runtime_password"
# File-backed Compose secrets preserve host file ownership/mode. The PG entrypoint
# runs init scripts as the postgres UID, and migrator uses the same restricted UID.
pg_image="postgres:17@sha256:5b96f1a16bd9768b060dd2ffe55cb6225c4d9ef4d214a8b21eb08134869a97e4"
pg_uid="$(docker run --rm --network none "$pg_image" id -u postgres)"
test "$pg_uid" = "999"
chmod 400 "$FH_FINANCE_SECRETS_DIR/admin_password" "$FH_FINANCE_SECRETS_DIR/migrator_password" "$FH_FINANCE_SECRETS_DIR/runtime_password"
chmod 700 "$FH_FINANCE_DATA_DIR"
sudo chown "$pg_uid:$pg_uid" "$FH_FINANCE_SECRETS_DIR/admin_password" "$FH_FINANCE_SECRETS_DIR/migrator_password" "$FH_FINANCE_SECRETS_DIR/runtime_password" "$FH_FINANCE_DATA_DIR"
# This synthetic CI directory is intentionally not encrypted; the production
# gate MUST refuse it. Never make CI's temporary storage an alternative to LUKS.
if FH_FINANCE_MAPPER_NAME=fh-finance-pg bash deploy/postgres/scripts/storage-preflight.sh >/dev/null 2>&1; then
  echo "ERROR: production preflight accepted unencrypted CI storage" >&2
  exit 1
fi
echo "CI_UNENCRYPTED_STORAGE_REJECTED_PASS"
# The release wrapper must reject a synthetic runner lacking GitHub approvals,
# an encrypted production volume and externally provisioned recovery secrets.
if bash deploy/postgres/scripts/production-deploy.sh >/dev/null 2>&1; then
  echo "ERROR: production deploy bypassed security preconditions" >&2
  exit 1
fi
echo "CI_PRODUCTION_DEPLOY_REQUIRES_APPROVAL_PASS"
docker compose -f deploy/postgres/compose.yml config --quiet
docker compose -f deploy/postgres/compose.yml up -d --wait --wait-timeout 35 db
docker compose -f deploy/postgres/compose.yml --profile ops run --rm --build migrator
version="$(docker exec -u postgres fh-finance-postgres \
  psql -U postgres -d fh_finance -Atc 'SELECT version_num FROM finance.alembic_version')"
test "$version" = "0001_initial"
tables="$(docker exec -u postgres fh-finance-postgres \
  psql -U postgres -d fh_finance -Atc \
  "SELECT count(*) FROM pg_tables WHERE schemaname='finance' AND tablename<>'alembic_version'")"
test "$tables" = 15

# Exercise the actual production backup and isolated restore scripts with
# an ephemeral synthetic GPG key. No user or production data is used.
export FH_FINANCE_GPG_HOME="$FH_FINANCE_SECRETS_DIR/gnupg"
export FH_FINANCE_BACKUP_DIR="$FH_FINANCE_SECRETS_DIR/backups"
export FH_FINANCE_BACKUP_LOCK_FILE="$FH_FINANCE_SECRETS_DIR/backup.lock"
mkdir -m 700 "$FH_FINANCE_GPG_HOME" "$FH_FINANCE_BACKUP_DIR"
gpg --homedir "$FH_FINANCE_GPG_HOME" --batch --pinentry-mode loopback \
  --passphrase '' --quick-generate-key \
  'FH Finance CI-only Backup <synthetic@example.invalid>' rsa3072 encr 1d >/dev/null 2>&1
# Consume the complete GPG listing: awk's early exit can SIGPIPE gpg under
# `set -o pipefail`, creating an intermittent false CI failure.
export FH_FINANCE_GPG_RECIPIENT
FH_FINANCE_GPG_RECIPIENT="$(gpg --homedir "$FH_FINANCE_GPG_HOME" --batch \
  --with-colons --list-keys | awk -F: '$1=="fpr" && !found {print $10; found=1}')"
test -n "$FH_FINANCE_GPG_RECIPIENT"
# The CI key has encryption capability; verify GPG can encrypt a message.
# The actual backup.sh invocation below is the definitive compatibility check.
bash deploy/postgres/scripts/backup.sh
# Repeated backups cannot collide, overwrite or leave partial files.
bash deploy/postgres/scripts/backup.sh
actual_archives="$(find "$FH_FINANCE_BACKUP_DIR" -maxdepth 1 -name 'fh-finance-*.pgdump.gpg' -type f | wc -l)"
test "$actual_archives" -eq 2
test -z "$(find "$FH_FINANCE_BACKUP_DIR" -maxdepth 1 -name '*.partial' -print -quit)"
encrypted="$(find "$FH_FINANCE_BACKUP_DIR" -maxdepth 1 -type f \
  -name 'fh-finance-*.pgdump.gpg' -printf '%T@ %p\n' | sort -nr | sed -n '1s/^[^ ]* //p')"
test -n "$encrypted"
bash deploy/postgres/scripts/restore-drill.sh "$encrypted"
# A local snapshot must not be reported as disaster-recovery-ready without
# a configured, verified independent offsite destination.
if bash deploy/postgres/scripts/offsite-upload.sh "$encrypted" >/dev/null 2>&1; then
  echo "ERROR: offsite uploader accepted unconfigured remote storage" >&2
  exit 1
fi
echo "CI_OFFSITE_REQUIRED_FAIL_CLOSED_PASS"
echo "CI_PRODUCTION_BACKUP_RESTORE_PASS: GPG-encrypted full backup restored in isolated networkless PostgreSQL"

exposed="$(docker inspect fh-finance-postgres --format '{{json .NetworkSettings.Ports}}')"
# Published host port appears as an exposed HostPort entry.
case "$exposed" in
  *HostPort*|*HostIp*) echo "Unexpected published PostgreSQL port" >&2; exit 1;;
esac
echo "CI_COMPOSE_PASS: isolated PostgreSQL, roles and Alembic initialized"
