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
docker exec "$pg" pg_dump -U postgres -d fh_finance_ci -Fc |
  gpg --batch --yes --pinentry-mode loopback --passphrase 'CI-ONLY-NOT-A-REAL-SECRET' \
      --symmetric --cipher-algo AES256 --output "$dir/backup.gpg"
test -s "$dir/backup.gpg"
docker exec "$pg" createdb -U postgres fh_finance_ci_restore
gpg --batch --yes --pinentry-mode loopback --passphrase 'CI-ONLY-NOT-A-REAL-SECRET' \
    --decrypt "$dir/backup.gpg" |
  docker exec -i "$pg" pg_restore -U postgres -d fh_finance_ci_restore \
    --exit-on-error
tables="$(docker exec "$pg" psql -U postgres -d fh_finance_ci_restore -Atc \
  "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='finance' AND tablename <> 'alembic_version'")"
test "$tables" = 23
test "$(docker exec "$pg" psql -U postgres -d fh_finance_ci_restore -Atc \
  "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='finance'")" = fh_finance_migrator
test "$(docker exec "$pg" psql -U postgres -d fh_finance_ci_restore -Atc \
  "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid
     WHERE n.nspname='finance' AND c.relkind='r' AND c.relname<>'alembic_version'
       AND pg_get_userbyid(c.relowner)='fh_finance_migrator'")" = 23
# Verify at least the two synthetic owner profiles are present after restore.\n# The expanded ledger suite may legitimately add more isolated profiles.
test "$(docker exec "$pg" psql -U postgres -d fh_finance_ci_restore -Atc \
  "SELECT count(*) FROM finance.finance_profiles")" -ge 2
test "$(docker exec "$pg" psql -U fh_finance_runtime -d fh_finance_ci_restore -Atc \
  "SELECT count(*) FROM finance.finance_profiles")" = 0
test "$(docker exec "$pg" psql -U fh_finance_runtime -d fh_finance_ci_restore -Atc \
  "SELECT has_table_privilege(current_user,'finance.accounts','SELECT')")" = t
test "$(docker exec "$pg" psql -U fh_finance_runtime -d fh_finance_ci_restore -Atc \
  "SELECT has_schema_privilege(current_user,'finance','CREATE')")" = f
# #35: ensure budget rules, assignments, catalogue and their history survived
# the encrypted dump/restore without publishing row contents or digests.
for table in budget_categories budget_rules budget_assignments financial_goals goal_events; do
  query="SELECT count(*) || ':' || md5(COALESCE(string_agg(to_jsonb(t)::text, E'\\n' ORDER BY profile_id,id),'')) FROM finance.$table t"
  original="$(docker exec "$pg" psql -X -v ON_ERROR_STOP=1 -U postgres -d fh_finance_ci -Atc "$query")"
  restored="$(docker exec "$pg" psql -X -v ON_ERROR_STOP=1 -U postgres -d fh_finance_ci_restore -Atc "$query")"
  test "${original%%:*}" -gt 0
  test "$original" = "$restored"
done
query="SELECT count(*) || ':' || md5(COALESCE(string_agg(to_jsonb(t)::text, E'\\n' ORDER BY profile_id,revision,ordinal),'')) FROM finance.change_log t WHERE payload->'entity'->>'kind' IN ('budget_rule','budget_category','budget_assignment','goal')"
original="$(docker exec "$pg" psql -X -v ON_ERROR_STOP=1 -U postgres -d fh_finance_ci -Atc "$query")"
restored="$(docker exec "$pg" psql -X -v ON_ERROR_STOP=1 -U postgres -d fh_finance_ci_restore -Atc "$query")"
test "${original%%:*}" -gt 0
test "$original" = "$restored"
echo "CI_BUDGET_AND_GOAL_HISTORY_RESTORE_PASS"
# pg_amcheck requires amcheck in the target DB. Install in disposable restore DB,
# never in source or production data.
docker exec "$pg" psql -v ON_ERROR_STOP=1 -U postgres -d fh_finance_ci_restore \
  -c 'CREATE EXTENSION IF NOT EXISTS amcheck' >/dev/null
docker exec "$pg" pg_amcheck -U postgres -d fh_finance_ci_restore --no-dependent-indexes >/dev/null
echo "CI_ENCRYPTED_RESTORE_PASS: 23 tables, temporary restored database"
