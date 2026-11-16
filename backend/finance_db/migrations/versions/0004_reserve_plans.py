"""Add nullable, owner-scoped mandatory reserve plan fields for #6.

Revision ID: 0004_reserve_plans
Revises: 0003_import_source

Legacy reserve rows retain NULL plan fields; no financial posting or
allocation is created by this migration.
"""
from __future__ import annotations

from alembic import op

revision = "0004_reserve_plans"
down_revision = "0003_import_source"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE finance.reserves
          ADD COLUMN obligation_id uuid,
          ADD COLUMN account_id uuid,
          ADD COLUMN opened_on date,
          ADD COLUMN first_due_on date,
          ADD COLUMN period_months smallint,
          ADD COLUMN due_day smallint,
          ADD COLUMN contribution_mode varchar(8),
          ADD COLUMN fixed_monthly_minor bigint,
          ADD CONSTRAINT reserves_plan_obligation_fk
            FOREIGN KEY (profile_id,obligation_id)
            REFERENCES finance.obligations(profile_id,id) ON DELETE RESTRICT,
          ADD CONSTRAINT reserves_plan_account_fk
            FOREIGN KEY (profile_id,account_id)
            REFERENCES finance.accounts(profile_id,id) ON DELETE RESTRICT,
          ADD CONSTRAINT reserves_plan_shape CHECK (
            (obligation_id IS NULL AND account_id IS NULL AND opened_on IS NULL
             AND first_due_on IS NULL AND period_months IS NULL
             AND due_day IS NULL AND contribution_mode IS NULL
             AND fixed_monthly_minor IS NULL)
            OR
            (obligation_id IS NOT NULL AND account_id IS NOT NULL
             AND opened_on IS NOT NULL AND first_due_on IS NOT NULL
             AND target_on IS NOT NULL AND opened_on <= first_due_on
             AND period_months BETWEEN 1 AND 60 AND due_day BETWEEN 1 AND 31
             AND (contribution_mode='auto' AND fixed_monthly_minor IS NULL
                  OR contribution_mode='fixed'
                     AND fixed_monthly_minor BETWEEN 1 AND 1000000000000))
          )
    """)
    op.execute("""
        CREATE UNIQUE INDEX reserves_one_active_per_obligation
        ON finance.reserves (profile_id,obligation_id)
        WHERE obligation_id IS NOT NULL AND archived_at IS NULL
    """)
    op.execute("""
        GRANT UPDATE (first_due_on,period_months,due_day,contribution_mode,
                      fixed_monthly_minor)
        ON finance.reserves TO fh_finance_runtime
    """)


def downgrade() -> None:
    # Destroying reserve schedules would orphan owner events and allocations.
    raise RuntimeError("Reserve plan migration is irreversible; use a verified backup")
