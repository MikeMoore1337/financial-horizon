"""Atomic reserve-payment release and restoration (#6).

Revision ID: 0005_reserved_payment
Revises: 0004_reserve_plans

Only nullable columns and append-only checks are added. Existing allocations
and ledger facts retain their exact values. No automatic cash movements.
"""
from __future__ import annotations

from alembic import op

revision = "0005_reserved_payment"
down_revision = "0004_reserve_plans"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE finance.reserve_allocations
          ADD COLUMN linked_transaction_id uuid,
          ADD COLUMN reverses_allocation_id uuid,
          ADD CONSTRAINT reserve_allocations_linked_tx_fk
            FOREIGN KEY (profile_id,linked_transaction_id)
            REFERENCES finance.ledger_transactions(profile_id,id)
            DEFERRABLE INITIALLY DEFERRED,
          ADD CONSTRAINT reserve_allocations_reverses_fk
            FOREIGN KEY (profile_id,reverses_allocation_id)
            REFERENCES finance.reserve_allocations(profile_id,id)
            DEFERRABLE INITIALLY DEFERRED,
          ADD CONSTRAINT reserve_allocations_pair_shape CHECK (
            (linked_transaction_id IS NULL AND reverses_allocation_id IS NULL)
            OR
            (linked_transaction_id IS NOT NULL AND (
              (reverses_allocation_id IS NULL AND delta_minor < 0)
              OR (reverses_allocation_id IS NOT NULL AND delta_minor > 0)
            ))
          )
    """)
    op.execute("""
        CREATE UNIQUE INDEX reserve_allocations_linked_tx_unique
        ON finance.reserve_allocations(profile_id,linked_transaction_id)
        WHERE linked_transaction_id IS NOT NULL
    """)
    op.execute("""
        CREATE UNIQUE INDEX reserve_allocations_reversed_once
        ON finance.reserve_allocations(profile_id,reverses_allocation_id)
        WHERE reverses_allocation_id IS NOT NULL
    """)
    op.execute("""
        CREATE FUNCTION finance.check_reserve_payment_allocation()
        RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
        SET search_path=finance,pg_catalog
        AS $fn$
        DECLARE
          v_kind text;
          v_reversed uuid;
          v_posting bigint;
          v_paid bigint;
          v_obligation uuid;
          v_account uuid;
          v_plan_obligation uuid;
          v_original finance.reserve_allocations%ROWTYPE;
          v_voided timestamptz;
        BEGIN
          IF NEW.linked_transaction_id IS NULL THEN RETURN NULL; END IF;
          SELECT kind,reversed_transaction_id INTO v_kind,v_reversed
            FROM finance.ledger_transactions
            WHERE profile_id=NEW.profile_id AND id=NEW.linked_transaction_id;
          IF NEW.reverses_allocation_id IS NULL THEN
            SELECT s.amount_minor,s.obligation_id INTO v_paid,v_obligation
              FROM finance.ledger_payment_links l
              JOIN finance.settlements s
                ON s.profile_id=l.profile_id AND s.id=l.settlement_id
             WHERE l.profile_id=NEW.profile_id
               AND l.transaction_id=NEW.linked_transaction_id
               AND s.voided_at IS NULL;
            SELECT account_id,obligation_id INTO v_account,v_plan_obligation
              FROM finance.reserves
             WHERE profile_id=NEW.profile_id AND id=NEW.reserve_id;
            SELECT signed_minor INTO v_posting
              FROM finance.ledger_postings
             WHERE profile_id=NEW.profile_id
               AND transaction_id=NEW.linked_transaction_id
               AND account_id=NEW.account_id;
            IF v_kind IS DISTINCT FROM 'payment' OR v_paid IS NULL
               OR v_account IS DISTINCT FROM NEW.account_id
               OR v_plan_obligation IS DISTINCT FROM v_obligation
               OR v_posting IS DISTINCT FROM -v_paid
               OR -NEW.delta_minor > v_paid THEN
              RAISE EXCEPTION 'reserved payment allocation is not linked to a valid cash fact'
                USING ERRCODE='23514';
            END IF;
          ELSE
            SELECT * INTO v_original FROM finance.reserve_allocations
             WHERE profile_id=NEW.profile_id AND id=NEW.reverses_allocation_id;
            IF NOT FOUND THEN
              RAISE EXCEPTION 'reserve restoration has no prior release'
                USING ERRCODE='23514';
            END IF;
            SELECT s.voided_at INTO v_voided
              FROM finance.ledger_payment_links l
              JOIN finance.settlements s
                ON s.profile_id=l.profile_id AND s.id=l.settlement_id
             WHERE l.profile_id=NEW.profile_id
               AND l.transaction_id=v_original.linked_transaction_id;
            IF v_kind IS DISTINCT FROM 'reversal'
               OR v_reversed IS DISTINCT FROM v_original.linked_transaction_id
               OR v_original.reverses_allocation_id IS NOT NULL
               OR v_original.delta_minor >= 0
               OR v_voided IS NULL
               OR NEW.reserve_id IS DISTINCT FROM v_original.reserve_id
               OR NEW.account_id IS DISTINCT FROM v_original.account_id
               OR NEW.delta_minor IS DISTINCT FROM -v_original.delta_minor THEN
              RAISE EXCEPTION 'reserve payment compensation is not exactly paired'
                USING ERRCODE='23514';
            END IF;
          END IF;
          RETURN NULL;
        END
        $fn$
    """)
    op.execute("""
        CREATE CONSTRAINT TRIGGER reserve_allocation_payment_integrity
        AFTER INSERT ON finance.reserve_allocations
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION finance.check_reserve_payment_allocation()
    """)
    op.execute("""
        REVOKE ALL ON FUNCTION finance.check_reserve_payment_allocation() FROM PUBLIC
    """)


def downgrade() -> None:
    raise RuntimeError("Reserved payment audit link cannot be dropped safely")
