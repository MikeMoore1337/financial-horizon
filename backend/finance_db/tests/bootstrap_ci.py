"""Create only disposable GitHub Actions finance test roles/database."""
from __future__ import annotations
import os
import psycopg
from psycopg import sql

if os.environ.get("GITHUB_ACTIONS") != "true":
    raise SystemExit("Refuse to create DB outside GitHub Actions")
if os.environ.get("FH_FINANCE_CI_ALLOW_BOOTSTRAP") != "yes":
    raise SystemExit("Missing dedicated CI bootstrap opt-in")

with psycopg.connect(
    host="127.0.0.1", port=5432, dbname="postgres",
    user="postgres", password="ci_admin_password_only", autocommit=True
) as conn:
    with conn.cursor() as cur:
        for role,password in (
            ("fh_finance_migrator", "ci_migration_password_only"),
            ("fh_finance_runtime", "ci_runtime_password_only"),
        ):
            cur.execute(
                sql.SQL("CREATE ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD {}").format(
                    sql.Identifier(role), sql.Literal(password)
                )
            )
        cur.execute("CREATE DATABASE fh_finance_ci OWNER fh_finance_migrator")
    # No cross-project database names, users, passwords or service access.
with psycopg.connect(
    host="127.0.0.1", port=5432, dbname="fh_finance_ci",
    user="postgres", password="ci_admin_password_only", autocommit=True
) as conn:
    conn.execute("REVOKE ALL ON DATABASE fh_finance_ci FROM PUBLIC")
    conn.execute("GRANT CONNECT ON DATABASE fh_finance_ci TO fh_finance_runtime")
    conn.execute("REVOKE ALL ON SCHEMA public FROM PUBLIC")
    conn.execute("ALTER DATABASE fh_finance_ci SET search_path = finance, pg_catalog")
print("Synthetic finance CI database provisioned")
