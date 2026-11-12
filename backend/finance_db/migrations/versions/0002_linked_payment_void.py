"""Linked payment void: one commit with append-only financial reversal.

Revision ID: 0002_linked_void
Revises: 0001_initial
"""
from __future__ import annotations

from pathlib import Path

import sqlparse
from alembic import op

revision = "0002_linked_void"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    script = Path(__file__).resolve().parents[1] / "ddl" / "0002_linked_payment_void.sql"
    # Alembic applies the migration as one transaction, including grants/triggers.
    # No destructive operations or automatic re-posting of existing records.
    bind = op.get_bind()
    for statement in sqlparse.split(script.read_text(encoding="utf-8")):
        if statement.strip():
            bind.exec_driver_sql(statement.replace("%", "%%"))


def downgrade() -> None:
    # Discarding the guards would allow a void and reversal in separate commits.
    # After real transactions exist, only reviewed forward repair/restore is safe.
    raise RuntimeError("Linked payment void migration is irreversible")
