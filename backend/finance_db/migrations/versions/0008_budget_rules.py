"""Scoped budget catalogue, monthly limits and expense classification (#35).

Additive only; no existing financial facts, postings or category names migrate.
Candidate commands remain unmounted until snapshot/client compatibility passes.
"""
from alembic import op

revision = "0008_budget_rules"
down_revision = "0007_bank_statements"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE finance.budget_categories (
          profile_id uuid NOT NULL REFERENCES finance.finance_profiles(id) ON DELETE RESTRICT,
          id uuid NOT NULL,
          name varchar(40) NOT NULL CHECK (name=btrim(name) AND length(name)>0),
          archived boolean NOT NULL DEFAULT false,
          entity_revision bigint NOT NULL DEFAULT 1 CHECK (entity_revision>0),
          PRIMARY KEY (profile_id,id)
        )
    """)
    op.execute("""
        CREATE UNIQUE INDEX budget_category_name_unique
          ON finance.budget_categories(profile_id,lower(name))
    """)
    op.execute("""
        CREATE TABLE finance.budget_rules (
          profile_id uuid NOT NULL REFERENCES finance.finance_profiles(id) ON DELETE RESTRICT,
          id uuid NOT NULL,
          category_id uuid,
          limit_minor bigint NOT NULL CHECK (limit_minor BETWEEN 0 AND 1000000000000),
          recurrence varchar(7) NOT NULL CHECK (recurrence IN ('once','monthly')),
          from_month date NOT NULL CHECK (EXTRACT(DAY FROM from_month)=1),
          ends_before_month date CHECK (
            EXTRACT(DAY FROM ends_before_month)=1 AND ends_before_month>from_month),
          archived_from_month date CHECK (
            EXTRACT(DAY FROM archived_from_month)=1 AND archived_from_month>=from_month),
          entity_revision bigint NOT NULL DEFAULT 1 CHECK (entity_revision>0),
          PRIMARY KEY (profile_id,id),
          FOREIGN KEY (profile_id,category_id)
            REFERENCES finance.budget_categories(profile_id,id) ON DELETE RESTRICT
        )
    """)
    op.execute("""
        CREATE INDEX budget_rule_scope ON finance.budget_rules(profile_id,category_id,from_month)
    """)
    op.execute("""
        CREATE TABLE finance.budget_assignments (
          profile_id uuid NOT NULL REFERENCES finance.finance_profiles(id) ON DELETE RESTRICT,
          id uuid NOT NULL,
          category_id uuid,
          entity_revision bigint NOT NULL DEFAULT 1 CHECK (entity_revision>0),
          PRIMARY KEY (profile_id,id),
          FOREIGN KEY (profile_id,id)
            REFERENCES finance.ledger_transactions(profile_id,id) ON DELETE RESTRICT,
          FOREIGN KEY (profile_id,category_id)
            REFERENCES finance.budget_categories(profile_id,id) ON DELETE RESTRICT
        )
    """)
    for table in ("budget_categories", "budget_rules", "budget_assignments"):
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
        GRANT UPDATE (name,archived,entity_revision)
          ON finance.budget_categories TO fh_finance_runtime
    """)
    op.execute("""
        GRANT UPDATE (limit_minor,ends_before_month,archived_from_month,entity_revision)
          ON finance.budget_rules TO fh_finance_runtime
    """)
    op.execute("""
        GRANT UPDATE (category_id,entity_revision)
          ON finance.budget_assignments TO fh_finance_runtime
    """)


def downgrade() -> None:
    raise RuntimeError("Budget history must be preserved; use verified backup restore")
