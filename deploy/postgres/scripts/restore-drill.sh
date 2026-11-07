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
for i in $(seq 1 60); do
  if docker exec "$name" pg_isready -U postgres -d fh_restore >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$name" pg_isready -U postgres -d fh_restore >/dev/null
gpg --homedir "$FH_FINANCE_GPG_HOME" --batch --no-tty --decrypt "$1" \
  | docker exec -i "$name" pg_restore -U postgres --exit-on-error --no-owner --no-acl -d fh_restore
# No financial values or identifiers enter public logs.
count="$(docker exec "$name" psql -U postgres -d fh_restore -Atc \
  "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='finance' AND tablename <> 'alembic_version'")"
test "$count" -eq 15
# pg_amcheck requires amcheck in the target DB. Install in disposable restore DB,
# never in source or production data.
docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d fh_restore \
  -c 'CREATE EXTENSION IF NOT EXISTS amcheck' >/dev/null
docker exec "$name" pg_amcheck -U postgres -d fh_restore --no-dependent-indexes >/dev/null
printf 'RESTORE_DRILL_PASS: %s finance tables, no ports, disposable volume\n' "$count"
