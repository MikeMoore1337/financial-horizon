"""Preserve exact canonical legacy JSON for #69 lossless import recovery.

Revision ID: 0003_import_source
Revises: 0002_linked_void

The byte archive has the same PostgreSQL RLS and encrypted pg_dump protection
as existing financial tables. No legacy or auth SQLite files are touched.
"""
from __future__ import annotations

from alembic import op

revision = "0003_import_source"
down_revision = "0002_linked_void"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE finance.import_batches
          ADD COLUMN source_canonical_json bytea,
          ADD CONSTRAINT import_source_size_guard CHECK (
            source_canonical_json IS NULL
            OR octet_length(source_canonical_json) BETWEEN 2 AND 8000000
          ),
          ADD CONSTRAINT import_committed_requires_source CHECK (
            status <> 'committed' OR source_canonical_json IS NOT NULL
          )
    """)


def downgrade() -> None:
    # Downgrading would silently destroy the only server-side copy of
    # user-imported categories, audit, payment methods and original IDs.
    raise RuntimeError("Import archive migration is irreversible; restore a verified backup")
