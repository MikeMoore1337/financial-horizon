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
cleanup() {
  docker compose -f deploy/postgres/compose.yml --profile ops down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$FH_FINANCE_SECRETS_DIR"
}
trap cleanup EXIT
printf '%s' 'CI-only-synthetic-admin-password-0123456789' > "$FH_FINANCE_SECRETS_DIR/admin_password"
printf '%s' 'CI-only-synthetic-migrator-password-0123456789' > "$FH_FINANCE_SECRETS_DIR/migrator_password"
printf '%s' 'CI-only-synthetic-runtime-password-0123456789' > "$FH_FINANCE_SECRETS_DIR/runtime_password"
chmod 600 "$FH_FINANCE_SECRETS_DIR/"*
docker compose -f deploy/postgres/compose.yml config --quiet
docker compose -f deploy/postgres/compose.yml up -d --wait db
docker compose -f deploy/postgres/compose.yml --profile ops run --rm --build migrator
version="$(docker exec -u postgres fh-finance-postgres \
  psql -U postgres -d fh_finance -Atc 'SELECT version_num FROM finance.alembic_version')"
test "$version" = "0001_initial"
tables="$(docker exec -u postgres fh-finance-postgres \
  psql -U postgres -d fh_finance -Atc \
  "SELECT count(*) FROM pg_tables WHERE schemaname='finance' AND tablename<>'alembic_version'")"
test "$tables" = 15
exposed="$(docker inspect fh-finance-postgres --format '{{json .NetworkSettings.Ports}}')"
# Published host port appears as an exposed HostPort entry.
case "$exposed" in
  *HostPort*|*HostIp*) echo "Unexpected published PostgreSQL port" >&2; exit 1;;
esac
echo "CI_COMPOSE_PASS: isolated PostgreSQL, roles and Alembic initialized"
