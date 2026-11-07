"""Financial PostgreSQL v1: reviewed schema, FORCE RLS and ledger constraints.

Revision ID: 0001_initial
Revises:
"""
from __future__ import annotations
from pathlib import Path
import sqlparse
from alembic import op

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    # Role must already have an isolated database; never run as an auth role.
    bind.exec_driver_sql("CREATE SCHEMA IF NOT EXISTS finance")
    bind.exec_driver_sql("REVOKE ALL ON SCHEMA finance FROM PUBLIC")
    script = Path(__file__).resolve().parents[1] / "ddl" / "0001_initial.sql"
    for statement in sqlparse.split(script.read_text(encoding="utf-8")):
        if statement.strip():
            bind.exec_driver_sql(statement)


def downgrade() -> None:
    # Unconditional DROP would destroy financial history and idempotency receipts.
    # Production rollback is application rollback/roll-forward or verified restore.
    raise RuntimeError("Financial v1 is irreversible; use verified backup restore")
