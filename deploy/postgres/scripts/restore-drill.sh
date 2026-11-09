#!/usr/bin/env bash
# Offline restore into a disposable container with no network and no published ports.
set -euo pipefail
umask 077
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then echo "Usage: restore-drill.sh BACKUP.gpg" >&2; exit 2; fi
: "${FH_FINANCE_GPG_HOME:?Local decryption keyring required for restore}"
IMAGE="postgres:17@sha256:5b96f1a16bd9768b060dd2ffe55cb6225c4d9ef4d214a8b21eb08134869a97e4"
name="fh-finance-restore-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name "$name" --network none \
  --tmpfs /var/lib/postgresql/data:rw,size=384m \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --memory 512m --cpus 0.5 --pids-limit 128 \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=fh_restore "$IMAGE" >/dev/null
# The official image first starts a *temporary* postmaster during initdb,
# shuts it down and then starts the final service. pg_isready alone can report
# the temporary server ready and make pg_restore race its shutdown.
ready=false
for i in $(seq 1 60); do
  if docker logs "$name" 2>&1 | grep -F 'PostgreSQL init process complete; ready for start up.' >/dev/null &&
     docker exec "$name" pg_isready -U postgres -d fh_restore >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [ "$ready" != true ]; then
  echo "Isolated PostgreSQL restore instance did not become ready" >&2
  exit 1
fi
# The dump deliberately preserves GRANT/REVOKE; cluster-level roles are
# external to pg_dump and must be provisioned before restoring table ACLs.
# The disposable role has no password; --network none prevents remote login.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d fh_restore \
  -c 'CREATE ROLE fh_finance_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT' >/dev/null
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d fh_restore \
  -c 'CREATE ROLE fh_finance_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT' >/dev/null
gpg --homedir "$FH_FINANCE_GPG_HOME" --batch --no-tty --decrypt "$1" \
  | docker exec -i "$name" pg_restore -U postgres --exit-on-error -d fh_restore
# No financial values or identifiers enter public logs.
count="$(docker exec "$name" psql -U postgres -d fh_restore -Atc \
  "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='finance' AND tablename <> 'alembic_version'")"
test "$count" -eq 15
# The schema must belong to the unprivileged migrator, not the restoring
# superuser; otherwise the next Alembic upgrade would fail after disaster
# recovery even if read-only smoke tests appeared healthy.
test "$(docker exec "$name" psql -U postgres -d fh_restore -Atc \
  "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='finance'")" = "fh_finance_migrator"
test "$(docker exec "$name" psql -U postgres -d fh_restore -Atc \
  "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid
     WHERE n.nspname='finance' AND c.relkind='r' AND c.relname<>'alembic_version'
       AND pg_get_userbyid(c.relowner)='fh_finance_migrator'")" = "15"
# The restored ACL and FORCE RLS must permit only scoped data access.
# Confirm actual source grant survives backup/restore; local trust is safe only
# in this isolated disposable --network none container.
test "$(docker exec "$name" psql -U fh_finance_runtime -d fh_restore -Atc \
  "SELECT has_table_privilege(current_user,'finance.accounts','SELECT')")" = "t"
test "$(docker exec "$name" psql -U fh_finance_runtime -d fh_restore -Atc \
  "SELECT has_table_privilege(current_user,'finance.ledger_transactions','DELETE')")" = "f"
test "$(docker exec "$name" psql -U fh_finance_runtime -d fh_restore -Atc \
  "SELECT count(*) FROM finance.finance_profiles")" = "0"
test "$(docker exec "$name" psql -U postgres -d fh_restore -Atc \
  "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='finance' AND c.relkind='r'
     AND c.relname<>'alembic_version'
     AND c.relrowsecurity AND c.relforcerowsecurity")" = "15"
# pg_amcheck requires amcheck in the target DB. Install in disposable restore DB,
# never in source or production data.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d fh_restore \
  -c 'CREATE EXTENSION IF NOT EXISTS amcheck' >/dev/null
docker exec "$name" pg_amcheck -U postgres -d fh_restore --no-dependent-indexes >/dev/null
printf 'RESTORE_DRILL_PASS: %s finance tables, no ports, disposable volume\n' "$count"
