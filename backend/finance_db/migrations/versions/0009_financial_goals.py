"""#37 append-only goal allocations, scoped to existing finance accounts.

Additive; no existing ledger, reserve, authentication or financial data changes.
The goal command is not enabled by applying this migration.
"""
from alembic import op

revision = "0009_financial_goals"
down_revision = "0008_budget_rules"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE finance.financial_goals (
          profile_id uuid NOT NULL REFERENCES finance.finance_profiles(id) ON DELETE RESTRICT,
          id uuid NOT NULL,
          account_id uuid NOT NULL,
          entity_revision bigint NOT NULL DEFAULT 1 CHECK (entity_revision BETWEEN 1 AND 25000),
          PRIMARY KEY (profile_id,id),
          FOREIGN KEY (profile_id,account_id)
            REFERENCES finance.accounts(profile_id,id) ON DELETE RESTRICT
        )
    """)
    op.execute("""
        CREATE TABLE finance.goal_events (
          profile_id uuid NOT NULL REFERENCES finance.finance_profiles(id) ON DELETE RESTRICT,
          id uuid NOT NULL,
          goal_id uuid NOT NULL,
          ordinal bigint NOT NULL CHECK (ordinal BETWEEN 1 AND 25000),
          event jsonb NOT NULL CHECK (
            jsonb_typeof(event)='object' AND event ? 'id' AND event->>'id'=id::text
          ),
          delta_minor bigint NOT NULL CHECK (delta_minor BETWEEN -1000000000000 AND 1000000000000),
          ledger_transaction_id uuid,
          PRIMARY KEY (profile_id,id),
          UNIQUE (profile_id,goal_id,ordinal),
          UNIQUE (profile_id,ledger_transaction_id),
          FOREIGN KEY (profile_id,goal_id)
            REFERENCES finance.financial_goals(profile_id,id) ON DELETE RESTRICT,
          FOREIGN KEY (profile_id,ledger_transaction_id)
            REFERENCES finance.ledger_transactions(profile_id,id) ON DELETE RESTRICT
            DEFERRABLE INITIALLY DEFERRED,
          CHECK (
            CASE WHEN ledger_transaction_id IS NULL THEN
              NOT (event ? 'ledgerMovementId' OR event ? 'ledgerReversalId')
            ELSE
              COALESCE(event->>'ledgerMovementId',event->>'ledgerReversalId','')
                =ledger_transaction_id::text
            END
          )
        )
    """)
    op.execute("CREATE INDEX goals_account_idx ON finance.financial_goals(profile_id,account_id)")
    for table in ("financial_goals", "goal_events"):
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
    op.execute("GRANT UPDATE (entity_revision) ON finance.financial_goals TO fh_finance_runtime")
    op.execute("""
        CREATE TRIGGER protect_goal_events BEFORE UPDATE OR DELETE ON finance.goal_events
        FOR EACH ROW EXECUTE FUNCTION finance.reject_audit_mutation()
    """)
    # PostgreSQL 17: invoker security preserves the underlying forced RLS.
    op.execute("""
        CREATE VIEW finance.account_earmarks WITH (security_invoker=true) AS
          SELECT profile_id,account_id,delta_minor FROM finance.reserve_allocations
          UNION ALL
          SELECT g.profile_id,g.account_id,e.delta_minor
          FROM finance.financial_goals g JOIN finance.goal_events e
            ON (g.profile_id,g.id)=(e.profile_id,e.goal_id)
    """)
    op.execute("GRANT SELECT ON finance.account_earmarks TO fh_finance_runtime")
    # Defense in depth for older writers and alternate import paths.
    # Check the final transaction state, not intermediate linked postings.
    op.execute("""
        CREATE FUNCTION finance.check_goal_account_capacity()
        RETURNS trigger LANGUAGE plpgsql SET search_path=finance,pg_catalog AS $$
        DECLARE aid uuid; saved numeric; locked numeric; balance numeric; gsum numeric;
        BEGIN
          IF TG_TABLE_NAME='goal_events' THEN
            SELECT account_id INTO STRICT aid FROM financial_goals
              WHERE profile_id=NEW.profile_id AND id=NEW.goal_id;
          ELSE
            aid=NEW.account_id;
          END IF;
          -- Serialize with the same profile lock as all application commands.
          PERFORM 1 FROM finance_profiles WHERE id=NEW.profile_id FOR UPDATE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'finance profile unavailable' USING ERRCODE='23514';
          END IF;
          IF TG_TABLE_NAME='goal_events' THEN
            SELECT COALESCE(SUM(delta_minor),0) INTO gsum FROM goal_events
              WHERE profile_id=NEW.profile_id AND goal_id=NEW.goal_id;
            IF gsum<0 OR gsum>1000000000000 THEN
              RAISE EXCEPTION 'invalid goal allocation' USING ERRCODE='23514';
            END IF;
          END IF;
          SELECT COALESCE(SUM(e.delta_minor),0) INTO saved
            FROM financial_goals g JOIN goal_events e
              ON (g.profile_id,g.id)=(e.profile_id,e.goal_id)
            WHERE g.profile_id=NEW.profile_id AND g.account_id=aid;
          IF saved<0 THEN
            RAISE EXCEPTION 'invalid goal allocation' USING ERRCODE='23514';
          END IF;
          IF saved>0 THEN
            SELECT COALESCE(SUM(delta_minor),0) INTO locked FROM account_earmarks
              WHERE profile_id=NEW.profile_id AND account_id=aid;
            SELECT a.opening_minor+COALESCE((SELECT SUM(p.signed_minor) FROM ledger_postings p
              WHERE p.profile_id=a.profile_id AND p.account_id=a.id),0) INTO STRICT balance
              FROM accounts a WHERE a.profile_id=NEW.profile_id AND a.id=aid;
            IF locked<saved OR balance<locked THEN
              RAISE EXCEPTION 'goal funds already earmarked' USING ERRCODE='23514';
            END IF;
          END IF;
          RETURN NEW;
        END $$
    """)
    for table in ("goal_events", "ledger_postings", "reserve_allocations"):
        op.execute(f"""
            CREATE CONSTRAINT TRIGGER fh37_capacity_{table}
            AFTER INSERT ON finance.{table} DEFERRABLE INITIALLY DEFERRED
            FOR EACH ROW EXECUTE FUNCTION finance.check_goal_account_capacity()
        """)
    op.execute("""
        CREATE FUNCTION finance.check_goal_ledger_link()
        RETURNS trigger LANGUAGE plpgsql SET search_path=finance,pg_catalog AS $$
        BEGIN
          IF TG_TABLE_NAME='ledger_transactions' THEN
            IF NEW.reversed_transaction_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM goal_events WHERE profile_id=NEW.profile_id
                AND ledger_transaction_id=NEW.reversed_transaction_id
            ) AND NOT EXISTS (
              SELECT 1 FROM goal_events original_event JOIN goal_events correction
                ON (original_event.profile_id,original_event.goal_id)=(correction.profile_id,correction.goal_id)
              WHERE original_event.profile_id=NEW.profile_id
                AND original_event.ledger_transaction_id=NEW.reversed_transaction_id
                AND correction.ledger_transaction_id=NEW.id
                AND correction.event->>'type'='void'
                AND correction.event->>'eventId'=original_event.id::text
            ) THEN
              RAISE EXCEPTION 'goal movement requires paired correction' USING ERRCODE='23514';
            END IF;
          ELSIF TG_TABLE_NAME='goal_events' THEN
            IF NEW.ledger_transaction_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM reserve_allocations WHERE profile_id=NEW.profile_id
                AND linked_transaction_id=NEW.ledger_transaction_id
            ) THEN
              RAISE EXCEPTION 'movement already linked to a reserve' USING ERRCODE='23514';
            END IF;
          ELSIF NEW.linked_transaction_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM goal_events WHERE profile_id=NEW.profile_id
                AND ledger_transaction_id=NEW.linked_transaction_id
            ) THEN
            RAISE EXCEPTION 'movement already linked to a goal' USING ERRCODE='23514';
          END IF;
          RETURN NEW;
        END $$
    """)
    for table in ("goal_events", "ledger_transactions", "reserve_allocations"):
        op.execute(f"""
            CREATE CONSTRAINT TRIGGER fh37_link_{table}
            AFTER INSERT ON finance.{table} DEFERRABLE INITIALLY DEFERRED
            FOR EACH ROW EXECUTE FUNCTION finance.check_goal_ledger_link()
        """)
    op.execute("REVOKE ALL ON FUNCTION finance.check_goal_account_capacity() FROM PUBLIC")
    op.execute("REVOKE ALL ON FUNCTION finance.check_goal_ledger_link() FROM PUBLIC")


def downgrade() -> None:
    raise RuntimeError("Goal journal must be preserved; use verified backup/restore or compatible rollback")
