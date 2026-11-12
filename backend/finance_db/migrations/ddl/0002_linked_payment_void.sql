-- #67 / #33: reversible payment facts with append-only compensating postings.
-- Applies only after 0001_initial. Run in one Alembic transaction.
-- Never change or delete the existing payment link, posting or original tx.

-- Runtime can only mark a fact void and increase its revision. No permission
-- to alter amounts, dates, source references or tenant ownership.
GRANT UPDATE (voided_at,entity_revision)
  ON settlements,loan_payments TO fh_finance_runtime;

CREATE FUNCTION finance.guard_payment_fact_void()
RETURNS trigger LANGUAGE plpgsql
SET search_path = finance, pg_catalog
AS $fh_guard_fact_void$
BEGIN
  IF OLD.voided_at IS NOT NULL
     OR NEW.voided_at IS NULL
     OR NEW.entity_revision IS DISTINCT FROM OLD.entity_revision + 1
     OR (to_jsonb(NEW) - 'voided_at' - 'entity_revision')
        IS DISTINCT FROM (to_jsonb(OLD) - 'voided_at' - 'entity_revision') THEN
    RAISE EXCEPTION 'payment fact may be voided exactly once'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$fh_guard_fact_void$;

CREATE TRIGGER guard_settlement_void
  BEFORE UPDATE ON settlements
  FOR EACH ROW EXECUTE FUNCTION finance.guard_payment_fact_void();
CREATE TRIGGER guard_loan_payment_void
  BEFORE UPDATE ON loan_payments
  FOR EACH ROW EXECUTE FUNCTION finance.guard_payment_fact_void();

-- COMMIT-time pairing permits insert reversal -> void fact OR void fact ->
-- insert reversal in one SQL transaction, but refuses either half alone.
CREATE FUNCTION finance.check_voided_payment_pair()
RETURNS trigger LANGUAGE plpgsql
SET search_path = finance, pg_catalog
AS $fh_check_void_pair$
DECLARE
  v_original uuid;
  v_original_kind text;
  v_settlement_voided timestamptz;
  v_loan_voided timestamptz;
BEGIN
  IF TG_TABLE_NAME IN ('settlements', 'loan_payments') THEN
    IF NEW.voided_at IS NULL THEN
      RAISE EXCEPTION 'payment fact must be voided' USING ERRCODE='23514';
    END IF;
    IF TG_TABLE_NAME = 'settlements' THEN
      SELECT transaction_id INTO v_original
      FROM finance.ledger_payment_links
      WHERE profile_id=NEW.profile_id AND settlement_id=NEW.id;
    ELSE
      SELECT transaction_id INTO v_original
      FROM finance.ledger_payment_links
      WHERE profile_id=NEW.profile_id AND loan_payment_id=NEW.id;
    END IF;
    IF v_original IS NULL OR NOT EXISTS (
      SELECT 1 FROM finance.ledger_transactions
      WHERE profile_id=NEW.profile_id AND kind='reversal'
        AND reversed_transaction_id=v_original
    ) THEN
      RAISE EXCEPTION 'voided payment fact requires compensating reversal'
        USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'ledger_transactions' THEN
    IF NEW.kind <> 'reversal' THEN
      RETURN NULL;
    END IF;
    SELECT kind INTO v_original_kind FROM finance.ledger_transactions
    WHERE profile_id=NEW.profile_id AND id=NEW.reversed_transaction_id;
    IF v_original_kind IS DISTINCT FROM 'payment' THEN
      RETURN NULL;
    END IF;
    SELECT s.voided_at,lpay.voided_at
      INTO v_settlement_voided,v_loan_voided
    FROM finance.ledger_payment_links links
      LEFT JOIN finance.settlements s
        ON s.profile_id=links.profile_id AND s.id=links.settlement_id
      LEFT JOIN finance.loan_payments lpay
        ON lpay.profile_id=links.profile_id AND lpay.id=links.loan_payment_id
    WHERE links.profile_id=NEW.profile_id
      AND links.transaction_id=NEW.reversed_transaction_id;
    IF NOT FOUND
       OR (v_settlement_voided IS NULL AND v_loan_voided IS NULL) THEN
      RAISE EXCEPTION 'payment reversal requires an atomically voided fact'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END
$fh_check_void_pair$;

CREATE CONSTRAINT TRIGGER settlement_void_complete
  AFTER UPDATE OF voided_at ON settlements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance.check_voided_payment_pair();
CREATE CONSTRAINT TRIGGER loan_payment_void_complete
  AFTER UPDATE OF voided_at ON loan_payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance.check_voided_payment_pair();
CREATE CONSTRAINT TRIGGER payment_reversal_void_complete
  AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance.check_voided_payment_pair();

REVOKE ALL ON FUNCTION finance.guard_payment_fact_void() FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.check_voided_payment_pair() FROM PUBLIC;
