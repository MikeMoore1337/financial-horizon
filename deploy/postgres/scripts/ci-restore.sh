#!/usr/bin/env bash
# Only synthetic GitHub Actions database - never production data or public artifacts.
set -euo pipefail
if [ "${GITHUB_ACTIONS:-}" != "true" ] || [ "${FH_FINANCE_CI_ALLOW_BOOTSTRAP:-}" != "yes" ]; then
  echo "Refusing restore outside dedicated CI" >&2; exit 1
fi
test -z "${FH_FINANCE_GPG_RECIPIENT:-}" || { echo "Refusing live key in CI" >&2; exit 1; }
pg="${FH_FINANCE_CI_POSTGRES_CONTAINER:?GitHub Actions postgres service ID required}"
docker inspect "$pg" >/dev/null
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
export GNUPGHOME="$dir/gnupg"
mkdir -m 700 "$GNUPGHOME"
docker exec "$pg" pg_dump -U postgres -d fh_finance_ci -Fc --no-owner --no-acl |
  gpg --batch --yes --pinentry-mode loopback --passphrase 'CI-ONLY-NOT-A-REAL-SECRET' \
      --symmetric --cipher-algo AES256 --output "$dir/backup.gpg"
test -s "$dir/backup.gpg"
docker exec "$pg" createdb -U postgres fh_finance_ci_restore
gpg --batch --yes --pinentry-mode loopback --passphrase 'CI-ONLY-NOT-A-REAL-SECRET' \
    --decrypt "$dir/backup.gpg" |
  docker exec -i "$pg" pg_restore -U postgres -d fh_finance_ci_restore \
    --exit-on-error --no-owner --no-acl
tables="$(docker exec "$pg" psql -U postgres -d fh_finance_ci_restore -Atc \
  "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='finance' AND tablename <> 'alembic_version'")"
test "$tables" = 15
# pg_amcheck requires amcheck in the target DB. Install in disposable restore DB,
# never in source or production data.
docker exec "$pg" psql -v ON_ERROR_STOP=1 -U postgres -d fh_finance_ci_restore \
  -c 'CREATE EXTENSION IF NOT EXISTS amcheck' >/dev/null
docker exec "$pg" pg_amcheck -U postgres -d fh_finance_ci_restore --no-dependent-indexes >/dev/null
echo "CI_ENCRYPTED_RESTORE_PASS: 15 tables, temporary restored database"
