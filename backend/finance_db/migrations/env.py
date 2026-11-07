"""Alembic is the sole schema installer. No create_all(), no auth SQLite."""
from __future__ import annotations
import os
from logging.config import fileConfig
from alembic import context
from sqlalchemy import create_engine, pool

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Schema is managed by reviewed SQL migrations. Autogeneration is disallowed
# until a separately audited ORM metadata parity check is implemented.
target_metadata = None


def url() -> str:
    value = os.environ["FH_FINANCE_MIGRATION_URL"]
    if not value.startswith("postgresql+psycopg://"):
        raise ValueError("Only PostgreSQL/psycopg migration URLs are permitted")
    return value


def migrate_offline():
    raise RuntimeError("Financial migrations require an actual PostgreSQL transaction")


def migrate_online():
    engine = create_engine(
        url(),
        poolclass=pool.NullPool,
        connect_args={"options": "-csearch_path=finance,pg_catalog -cstatement_timeout=30000"},
    )
    with engine.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            version_table_schema="finance",
            transaction_per_migration=True,
            compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()


if context.is_offline_mode():
    migrate_offline()
else:
    migrate_online()
