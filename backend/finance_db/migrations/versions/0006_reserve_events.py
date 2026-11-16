"""Append-only reserve event history for recurring obligation plans (#6).

Revision ID: 0006_reserve_events
Revises: 0005_reserved_payment

No financial fact or ledger posting is migrated or synthesized. Existing reserve
rows retain their original allocations; old optional plan fields remain nullable.
"""
from __future__ import annotations

from alembic import op

revision = "0006_reserve_events"
down_revision = "0005_reserved_payment"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE finance.reserves
          ADD COLUMN opening_reserved_minor bigint NOT NULL DEFAULT 0
            CHECK (opening_reserved_minor BETWEEN 0 AND 1000000000000),
          ADD COLUMN cycle_number integer NOT NULL DEFAULT 1
            CHECK (cycle_number BETWEEN 1 AND 10000)
    """)
    op.execute("""
        CREATE TABLE finance.reserve_events (
          profile_id uuid NOT NULL REFERENCES finance.finance_profiles(id) ON DELETE RESTRICT,
          id uuid NOT NULL,
          reserve_id uuid NOT NULL,
          kind varchar(20) NOT NULL CHECK (kind IN
            ('contribution','release','payment','skip','target_change','cycle_close','void')),
          occurred_on date NOT NULL,
          cycle_number integer NOT NULL CHECK (cycle_number BETWEEN 1 AND 10000),
          revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
          amount_minor bigint CHECK (amount_minor BETWEEN 1 AND 1000000000000),
          reserved_used_minor bigint CHECK (reserved_used_minor BETWEEN 0 AND 1000000000000),
          target_minor bigint CHECK (target_minor BETWEEN 1 AND 1000000000000),
          slot_on date,
          target_event_id uuid,
          allocation_id uuid,
          transaction_id uuid,
          recorded_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (profile_id,id),
          FOREIGN KEY (profile_id,reserve_id) REFERENCES finance.reserves(profile_id,id)
            ON DELETE RESTRICT,
          FOREIGN KEY (profile_id,target_event_id) REFERENCES finance.reserve_events(profile_id,id)
            DEFERRABLE INITIALLY DEFERRED,
          FOREIGN KEY (profile_id,allocation_id) REFERENCES finance.reserve_allocations(profile_id,id)
            DEFERRABLE INITIALLY DEFERRED,
          FOREIGN KEY (profile_id,transaction_id) REFERENCES finance.ledger_transactions(profile_id,id)
            DEFERRABLE INITIALLY DEFERRED,
          CONSTRAINT reserve_event_shape CHECK (
            (kind IN ('contribution','release') AND amount_minor IS NOT NULL
               AND allocation_id IS NOT NULL AND reserved_used_minor IS NULL
               AND target_minor IS NULL AND slot_on IS NULL
               AND target_event_id IS NULL AND transaction_id IS NULL)
            OR (kind='payment' AND amount_minor IS NOT NULL
               AND reserved_used_minor BETWEEN 0 AND amount_minor
               AND transaction_id IS NOT NULL AND allocation_id IS NULL
               AND target_minor IS NULL AND slot_on IS NULL AND target_event_id IS NULL)
            OR (kind='skip' AND slot_on IS NOT NULL
               AND slot_on <= occurred_on AND amount_minor IS NULL
               AND reserved_used_minor IS NULL AND target_minor IS NULL
               AND allocation_id IS NULL AND transaction_id IS NULL AND target_event_id IS NULL)
            OR (kind='target_change' AND target_minor IS NOT NULL
               AND amount_minor IS NULL AND reserved_used_minor IS NULL AND slot_on IS NULL
               AND allocation_id IS NULL AND transaction_id IS NULL AND target_event_id IS NULL)
            OR (kind='cycle_close' AND amount_minor IS NULL
               AND reserved_used_minor IS NULL AND target_minor IS NULL AND slot_on IS NULL
               AND allocation_id IS NULL AND transaction_id IS NULL AND target_event_id IS NULL)
            OR (kind='void' AND target_event_id IS NOT NULL
               AND amount_minor IS NULL AND reserved_used_minor IS NULL
               AND target_minor IS NULL AND slot_on IS NULL)
          )
        )
    """)
    op.execute("""
        CREATE INDEX reserve_events_timeline
        ON finance.reserve_events(profile_id,reserve_id,cycle_number,occurred_on,recorded_at,id)
    """)
    op.execute("""
        CREATE UNIQUE INDEX reserve_events_void_once
        ON finance.reserve_events(profile_id,target_event_id)
        WHERE target_event_id IS NOT NULL
    """)
    op.execute("""
        CREATE UNIQUE INDEX reserve_events_allocation_unique
        ON finance.reserve_events(profile_id,allocation_id)
        WHERE allocation_id IS NOT NULL
    """)
    op.execute("""
        CREATE UNIQUE INDEX reserve_events_transaction_unique
        ON finance.reserve_events(profile_id,transaction_id)
        WHERE transaction_id IS NOT NULL
    """)
    op.execute("ALTER TABLE finance.reserve_events ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE finance.reserve_events FORCE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY owner_scope ON finance.reserve_events
        USING (
          profile_id = NULLIF(current_setting('fh.profile_id',true),'')::uuid
          AND EXISTS (SELECT 1 FROM finance.finance_profiles p WHERE p.id=profile_id)
        )
        WITH CHECK (
          profile_id = NULLIF(current_setting('fh.profile_id',true),'')::uuid
          AND EXISTS (SELECT 1 FROM finance.finance_profiles p WHERE p.id=profile_id)
        )
    """)
    op.execute("GRANT SELECT,INSERT ON finance.reserve_events TO fh_finance_runtime")
    op.execute("GRANT UPDATE (cycle_number) ON finance.reserves TO fh_finance_runtime")
    op.execute("""
        CREATE TRIGGER protect_reserve_events
        BEFORE UPDATE OR DELETE ON finance.reserve_events
        FOR EACH ROW EXECUTE FUNCTION finance.reject_audit_mutation()
    """)


def downgrade() -> None:
    raise RuntimeError("Financial reserve event history is immutable; restore a verified backup")
