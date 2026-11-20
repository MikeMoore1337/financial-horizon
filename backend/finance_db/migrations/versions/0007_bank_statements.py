"""RLS-isolated append-only bank statement import batches (#38, feature OFF).

Revision ID: 0007_bank_statements
Revises: 0006_reserve_events

Not shared with the opt-in historical IndexedDB source import (#69).
"""
from __future__ import annotations

from alembic import op

revision = "0007_bank_statements"
down_revision = "0006_reserve_events"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE finance.bank_import_batches (
          profile_id uuid NOT NULL REFERENCES finance.finance_profiles(id) ON DELETE RESTRICT,
          id uuid NOT NULL,
          batch_key char(64) NOT NULL CHECK (batch_key ~ '^[0-9a-f]{64}$'),
          file_digest char(64) NOT NULL CHECK (file_digest ~ '^[0-9a-f]{64}$'),
          payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
          status varchar(16) NOT NULL CHECK (status IN ('committed','cancelled')),
          committed_revision bigint NOT NULL CHECK (committed_revision > 0),
          cancelled_revision bigint CHECK (
             cancelled_revision IS NULL OR cancelled_revision > committed_revision
          ),
          operation_count integer NOT NULL CHECK (operation_count BETWEEN 1 AND 1000),
          committed_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (profile_id,id),
          UNIQUE (profile_id,batch_key),
          CHECK ((status='committed' AND cancelled_revision IS NULL)
              OR (status='cancelled' AND cancelled_revision IS NOT NULL))
        )
    """)
    op.execute("""
        CREATE TABLE finance.bank_import_rows (
          profile_id uuid NOT NULL,
          batch_id uuid NOT NULL,
          source_key char(64) NOT NULL CHECK (source_key ~ '^[0-9a-f]{64}$'),
          fingerprint char(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
          external_id varchar(150),
          account_id uuid NOT NULL,
          target_account_id uuid,
          transaction_id uuid NOT NULL,
          kind varchar(16) NOT NULL CHECK (kind IN ('income','expense','transfer')),
          occurred_on date NOT NULL,
          amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 1000000000000),
          description varchar(500) NOT NULL,
          category varchar(160),
          PRIMARY KEY (profile_id,source_key),
          UNIQUE (profile_id,transaction_id),
          FOREIGN KEY (profile_id,batch_id)
            REFERENCES finance.bank_import_batches(profile_id,id) ON DELETE RESTRICT,
          FOREIGN KEY (profile_id,account_id)
            REFERENCES finance.accounts(profile_id,id) ON DELETE RESTRICT,
          FOREIGN KEY (profile_id,target_account_id)
            REFERENCES finance.accounts(profile_id,id) ON DELETE RESTRICT,
          FOREIGN KEY (profile_id,transaction_id)
            REFERENCES finance.ledger_transactions(profile_id,id) ON DELETE RESTRICT,
          CHECK ((kind='transfer' AND target_account_id IS NOT NULL
                   AND target_account_id <> account_id)
              OR (kind<>'transfer' AND target_account_id IS NULL))
        )
    """)
    op.execute("""
        CREATE UNIQUE INDEX bank_import_external_id_unique
        ON finance.bank_import_rows(profile_id,account_id,external_id)
        WHERE external_id IS NOT NULL
    """)
    op.execute("""
        CREATE INDEX bank_import_batch_rows
        ON finance.bank_import_rows(profile_id,batch_id,transaction_id)
    """)
    for table in ("bank_import_batches","bank_import_rows"):
        op.execute(f"ALTER TABLE finance.{table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE finance.{table} FORCE ROW LEVEL SECURITY")
        op.execute(f"""
            CREATE POLICY owner_scope ON finance.{table}
            USING (
              profile_id = NULLIF(current_setting('fh.profile_id',true),'')::uuid
              AND EXISTS (SELECT 1 FROM finance.finance_profiles p WHERE p.id=profile_id)
            )
            WITH CHECK (
              profile_id = NULLIF(current_setting('fh.profile_id',true),'')::uuid
              AND EXISTS (SELECT 1 FROM finance.finance_profiles p WHERE p.id=profile_id)
            )
        """)
        op.execute(f"GRANT SELECT,INSERT ON finance.{table} TO fh_finance_runtime")
    op.execute("""
        GRANT UPDATE (status,cancelled_revision) ON finance.bank_import_batches
          TO fh_finance_runtime
    """)
    op.execute("""
        CREATE TRIGGER protect_bank_import_rows
        BEFORE UPDATE OR DELETE ON finance.bank_import_rows
        FOR EACH ROW EXECUTE FUNCTION finance.reject_audit_mutation()
    """)


def downgrade() -> None:
    raise RuntimeError("Bank import audit is append-only; use verified backup restore")
