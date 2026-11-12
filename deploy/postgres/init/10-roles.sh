#!/usr/bin/env bash
# Official PostgreSQL entrypoint: create isolated roles only on a fresh volume.
# Passwords are read by the PostgreSQL server from read-only Docker secrets;
# no password value enters shell variables, psql argv, env or client logs.
set -euo pipefail
for file in "$FH_FINANCE_MIGRATION_PASSWORD_FILE" "$FH_FINANCE_RUNTIME_PASSWORD_FILE"; do
  [[ -f "$file" && ! -L "$file" && -r "$file" ]] || {
    echo "Invalid PostgreSQL role secret file" >&2; exit 1
  }
  [[ "$(wc -c < "$file")" -ge 32 ]] || {
    echo "Invalid database role secret length" >&2; exit 1
  }
done
migration_digest="$(sha256sum "$FH_FINANCE_MIGRATION_PASSWORD_FILE" | cut -d' ' -f1)"
runtime_digest="$(sha256sum "$FH_FINANCE_RUNTIME_PASSWORD_FILE" | cut -d' ' -f1)"
[[ "$migration_digest" != "$runtime_digest" ]] || {
  echo "Migration and runtime role secrets must differ" >&2; exit 1
}
unset migration_digest runtime_digest

# The static SQL below never contains any secret bytes; pg_read_file()
# executes as local postgres superuser and uses SQL format(%L) for quoting.
# The official image is configured with log_statement=none and no duration SQL
# logs; -X ignores potentially unsafe local psql startup configuration.
psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
SELECT format(
 'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L',
 'fh_finance_migrator',
 rtrim(pg_read_file('/run/secrets/migrator_password'), E'\r\n')
) \gexec
SELECT format(
 'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L',
 'fh_finance_runtime',
 rtrim(pg_read_file('/run/secrets/runtime_password'), E'\r\n')
) \gexec
CREATE DATABASE fh_finance OWNER fh_finance_migrator;
REVOKE ALL ON DATABASE fh_finance FROM PUBLIC;
GRANT CONNECT ON DATABASE fh_finance TO fh_finance_runtime;
SQL
psql -X -q -v ON_ERROR_STOP=1 -U postgres -d fh_finance <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER DATABASE fh_finance SET search_path = finance, pg_catalog;
SQL
