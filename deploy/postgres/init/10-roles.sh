#!/usr/bin/env bash
# Official postgres entrypoint executes only on an empty dedicated volume.
set -euo pipefail
migration_password="$(cat "$FH_FINANCE_MIGRATION_PASSWORD_FILE")"
runtime_password="$(cat "$FH_FINANCE_RUNTIME_PASSWORD_FILE")"
if [ "${#migration_password}" -lt 32 ] || [ "${#runtime_password}" -lt 32 ]; then
  echo "Invalid database role secrets" >&2; exit 1
fi
# psql quote_literal via format %L; no interpolated SQL identifiers from inputs.
psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -v migration_password="$migration_password" -v runtime_password="$runtime_password" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L', 'fh_finance_migrator', :'migration_password') \gexec
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L', 'fh_finance_runtime', :'runtime_password') \gexec
CREATE DATABASE fh_finance OWNER fh_finance_migrator;
REVOKE ALL ON DATABASE fh_finance FROM PUBLIC;
GRANT CONNECT ON DATABASE fh_finance TO fh_finance_runtime;
SQL
psql -v ON_ERROR_STOP=1 -U postgres -d fh_finance <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER DATABASE fh_finance SET search_path = finance, pg_catalog;
SQL
unset migration_password runtime_password
