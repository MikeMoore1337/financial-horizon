"""One-shot migration using in-memory credentials and one audited transaction.

Never place migration passwords into URLs, environment variables, command-line
arguments, local .pgpass files or SQL logs. The secret remains in the isolated
migrator process and is used only to establish a psycopg connection.
"""
from __future__ import annotations

import os
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.pool import NullPool


def main() -> None:
    path = Path(os.environ["FH_FINANCE_PASSWORD_FILE"])
    password = path.read_text(encoding="utf-8").rstrip("\n")
    if len(password) < 32 or any(c in password for c in "\n\r:"):
        raise RuntimeError("Invalid migration secret")
    raw_url = os.environ["FH_FINANCE_MIGRATION_URL"]
    if not raw_url.startswith("postgresql+psycopg://"):
        raise ValueError("Expected a private PostgreSQL/psycopg finance URL")
    base_url = make_url(raw_url)
    if base_url.password:
        raise ValueError("Secrets must not be supplied in URL")
    # SQLAlchemy URLs mask credentials in diagnostics; the password is never
    # serialized to a file, process environment, or Alembic configuration.
    connection_url = base_url.set(password=password)
    engine = create_engine(
        connection_url,
        poolclass=NullPool,
        connect_args={"options": "-csearch_path=finance,pg_catalog -cstatement_timeout=30000"},
    )
    config = Config("backend/finance_db/alembic.ini")
    try:
        with engine.begin() as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, "head")
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
