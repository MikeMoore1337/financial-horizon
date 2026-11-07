-- Financial Horizon #66 - reviewed executable migration v0001. Never execute as runtime.
-- Runtime context is transaction-local, verified by the API before use.
-- Search path is additionally set explicitly by Alembic.
-- Financial Horizon #65: reference PostgreSQL schema, NOT an Alembic migration.
-- Implementation / exact DDL + DB invariants belong to #66/#67.
-- Never apply this file to production or to the existing auth SQLite.
-- PostgreSQL runtime role must NOT be owner, superuser or BYPASSRLS.
-- All timestamps are timestamptz UTC; calendar days are date; money is signed BIGINT minor units.
-- One RUB minor unit = one kopeck. Max absolute amount per money field = 10^12.

CREATE TABLE finance_profiles (
  id uuid PRIMARY KEY,
  owner_user_id varchar(32) NOT NULL UNIQUE
    CHECK (owner_user_id ~ '^[0-9a-f]{32}$'),
  currency char(3) NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  min_available_revision bigint NOT NULL DEFAULT 0
    CHECK (min_available_revision >= 0 AND min_available_revision <= revision),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- owner_user_id is an external logical link to auth SQLite users.id.
-- No cross-database FOREIGN KEY. Never trust it from HTTP request body.

CREATE TABLE accounts (
  profile_id uuid NOT NULL REFERENCES finance_profiles(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  name varchar(160) NOT NULL CHECK (length(btrim(name)) > 0),
  kind varchar(16) NOT NULL
    CHECK (kind IN ('bank','card','cash','savings','other')),
  currency char(3) NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
  -- Opening balance must be entered explicitly, including an explicit zero.
  opening_minor bigint NOT NULL
    CHECK (opening_minor BETWEEN -1000000000000 AND 1000000000000),
  entity_revision bigint NOT NULL DEFAULT 1 CHECK (entity_revision > 0),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, id)
);
CREATE INDEX accounts_active_idx ON accounts (profile_id, archived_at);

CREATE TABLE obligations (
  profile_id uuid NOT NULL REFERENCES finance_profiles(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  title varchar(160) NOT NULL CHECK (length(btrim(title)) > 0),
  direction varchar(8) NOT NULL CHECK (direction IN ('income','expense')),
  amount_minor bigint NOT NULL
    CHECK (amount_minor BETWEEN 0 AND 1000000000000),
  starts_on date NOT NULL,
  timezone varchar(64) NOT NULL DEFAULT 'UTC',
  recurrence_unit varchar(8) NOT NULL DEFAULT 'none'
    CHECK (recurrence_unit IN ('none','month','year')),
  recurrence_every integer NOT NULL DEFAULT 1
    CHECK (recurrence_every BETWEEN 1 AND 120),
  category varchar(100),
  entity_revision bigint NOT NULL DEFAULT 1 CHECK (entity_revision > 0),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, id)
);
CREATE INDEX obligations_by_date_idx ON obligations (profile_id, starts_on) WHERE deleted_at IS NULL;

CREATE TABLE loans (
  profile_id uuid NOT NULL REFERENCES finance_profiles(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  title varchar(160) NOT NULL CHECK (length(btrim(title)) > 0),
  opening_minor bigint NOT NULL CHECK (opening_minor BETWEEN 0 AND 1000000000000),
  payment_minor bigint NOT NULL CHECK (payment_minor BETWEEN 0 AND 1000000000000),
  apr_basis_points integer NOT NULL CHECK (apr_basis_points BETWEEN 0 AND 100000),
  term_months integer NOT NULL CHECK (term_months BETWEEN 1 AND 1200),
  due_day smallint NOT NULL CHECK (due_day BETWEEN 1 AND 31),
  as_of_date date NOT NULL,
  calculation_version smallint NOT NULL DEFAULT 1 CHECK (calculation_version > 0),
  imported_schedule jsonb, -- validated separately: bounded, versioned, no JSON float money
  entity_revision bigint NOT NULL DEFAULT 1 CHECK (entity_revision > 0),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, id)
);

CREATE TABLE reserves (
  profile_id uuid NOT NULL REFERENCES finance_profiles(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  title varchar(160) NOT NULL CHECK (length(btrim(title)) > 0),
  target_minor bigint NOT NULL CHECK (target_minor BETWEEN 0 AND 1000000000000),
  target_on date,
  entity_revision bigint NOT NULL DEFAULT 1 CHECK (entity_revision > 0),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, id)
);

CREATE TABLE ledger_transactions (
  profile_id uuid NOT NULL REFERENCES finance_profiles(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  kind varchar(16) NOT NULL CHECK (kind IN
    ('income','expense','transfer','adjustment','payment','reversal')),
  occurred_on date NOT NULL,
  note varchar(500),
  posted_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id varchar(32) NOT NULL CHECK (actor_user_id ~ '^[0-9a-f]{32}$'),
  entity_revision bigint NOT NULL DEFAULT 1 CHECK (entity_revision > 0),
  reversed_transaction_id uuid,
  PRIMARY KEY (profile_id, id),
  FOREIGN KEY (profile_id,reversed_transaction_id)
    REFERENCES ledger_transactions(profile_id,id) ON DELETE RESTRICT
);
CREATE INDEX ledger_by_date_idx ON ledger_transactions (profile_id, occurred_on DESC, id);

CREATE TABLE ledger_postings (
  profile_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  account_id uuid NOT NULL,
  signed_minor bigint NOT NULL
    CHECK (signed_minor BETWEEN -1000000000000 AND 1000000000000 AND signed_minor <> 0),
  PRIMARY KEY (profile_id, transaction_id, account_id),
  FOREIGN KEY (profile_id,transaction_id)
    REFERENCES ledger_transactions(profile_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (profile_id,account_id)
    REFERENCES accounts(profile_id,id) ON DELETE RESTRICT
);
CREATE INDEX postings_account_idx ON ledger_postings (profile_id, account_id);

CREATE TABLE settlements (
  profile_id uuid NOT NULL REFERENCES finance_profiles(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  obligation_id uuid NOT NULL,
  occurrence_on date NOT NULL,
  paid_on date NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 1000000000000),
  entity_revision bigint NOT NULL DEFAULT 1 CHECK (entity_revision > 0),
  voided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, id),
  FOREIGN KEY (profile_id,obligation_id)
    REFERENCES obligations(profile_id,id) ON DELETE RESTRICT
);
CREATE INDEX settlements_obligation_idx ON settlements (profile_id,obligation_id,occurrence_on);

CREATE TABLE loan_payments (
  profile_id uuid NOT NULL REFERENCES finance_profiles(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  loan_id uuid NOT NULL,
  paid_on date NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 1000000000000),
  strategy varchar(8) NOT NULL CHECK (strategy IN ('term','amount')),
  entity_revision bigint NOT NULL DEFAULT 1 CHECK (entity_revision > 0),
  voided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id,id),
  FOREIGN KEY (profile_id,loan_id)
    REFERENCES loans(profile_id,id) ON DELETE RESTRICT
);
CREATE INDEX loan_payments_loan_idx ON loan_payments (profile_id, loan_id, paid_on);

-- A ledger transaction can be claimed by at most one actual payment,
-- across BOTH obligation settlements and loan payments.
CREATE TABLE ledger_payment_links (
  profile_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  settlement_id uuid,
  loan_payment_id uuid,
  PRIMARY KEY (profile_id,transaction_id),
  UNIQUE (profile_id,settlement_id),
  UNIQUE (profile_id,loan_payment_id),
  CHECK (num_nonnulls(settlement_id,loan_payment_id) = 1),
  FOREIGN KEY (profile_id,transaction_id)
    REFERENCES ledger_transactions(profile_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (profile_id,settlement_id)
    REFERENCES settlements(profile_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (profile_id,loan_payment_id)
    REFERENCES loan_payments(profile_id,id) ON DELETE RESTRICT
);

CREATE TABLE reserve_allocations (
  profile_id uuid NOT NULL REFERENCES finance_profiles(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  reserve_id uuid NOT NULL,
  account_id uuid NOT NULL,
  delta_minor bigint NOT NULL
    CHECK (delta_minor BETWEEN -1000000000000 AND 1000000000000 AND delta_minor <> 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id,id),
  FOREIGN KEY (profile_id,reserve_id) REFERENCES reserves(profile_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (profile_id,account_id) REFERENCES accounts(profile_id,id) ON DELETE RESTRICT
);
CREATE INDEX reserve_allocations_by_account_idx ON reserve_allocations (profile_id,account_id);

-- Never remove receipt tombstones while the finance profile exists.
CREATE TABLE command_receipts (
  profile_id uuid NOT NULL REFERENCES finance_profiles(id) ON DELETE RESTRICT,
  client_mutation_id uuid NOT NULL,
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256)=32),
  status_code smallint NOT NULL CHECK (status_code BETWEEN 200 AND 599),
  committed_revision bigint, -- NULL only for a stored rejected command
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id,client_mutation_id)
);
CREATE INDEX receipts_revision_idx ON command_receipts (profile_id,committed_revision);

CREATE TABLE change_log (
  profile_id uuid NOT NULL REFERENCES finance_profiles(id) ON DELETE RESTRICT,
  revision bigint NOT NULL CHECK (revision > 0),
  ordinal smallint NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
  schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  kind varchar(50) NOT NULL,
  entity_id uuid,
  payload jsonb NOT NULL,
  server_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id,revision,ordinal)
);
-- Consuming deltas by (revision,ordinal) must not advance a partial revision;
-- page boundaries are at revision, not per row.

CREATE TABLE import_batches (
  profile_id uuid NOT NULL REFERENCES finance_profiles(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  source_sha256 bytea NOT NULL CHECK (octet_length(source_sha256)=32),
  status varchar(16) NOT NULL CHECK (status IN ('staged','reviewed','committed','cancelled')),
  base_revision bigint NOT NULL CHECK (base_revision >= 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  PRIMARY KEY (profile_id,id)
);
CREATE TABLE import_record_map (
  profile_id uuid NOT NULL,
  source_sha256 bytea NOT NULL CHECK (octet_length(source_sha256)=32),
  record_type varchar(30) NOT NULL,
  source_record_id varchar(128) NOT NULL,
  target_id uuid NOT NULL,
  PRIMARY KEY (profile_id,source_sha256,record_type,source_record_id),
  FOREIGN KEY (profile_id) REFERENCES finance_profiles(id) ON DELETE RESTRICT
);

-- RLS defence in depth: owner principal is resolved from a real session.
-- Request transaction must set both via SET LOCAL, *after* auth:
--   SELECT set_config('fh.user_id', :verified_user_id, true);
--   SELECT set_config('fh.profile_id', :authorized_profile_id, true);
-- If these are absent, policies deny; do not grant public/schema-owner access.
ALTER TABLE finance_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY profiles_owner ON finance_profiles
  USING (
    owner_user_id = NULLIF(current_setting('fh.user_id', true),'')
    AND id = NULLIF(current_setting('fh.profile_id', true),'')::uuid
  )
  WITH CHECK (
    owner_user_id = NULLIF(current_setting('fh.user_id', true),'')
    AND id = NULLIF(current_setting('fh.profile_id', true),'')::uuid
  );

-- Apply default-deny policies to EVERY child table; omission would be an IDOR risk.
-- App runtime role cannot bypass RLS even if it is the owner (FORCE).
-- The auth user's principal must be server-validated before SET LOCAL.
DO $fh_rls$
DECLARE tablename text;
BEGIN
  FOREACH tablename IN ARRAY ARRAY[
    'accounts','obligations','loans','reserves','ledger_transactions',
    'ledger_postings','settlements','loan_payments','ledger_payment_links',
    'reserve_allocations','command_receipts','change_log','import_batches',
    'import_record_map'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tablename);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tablename);
    EXECUTE format(
      'CREATE POLICY owner_scope ON %I USING (
        profile_id = NULLIF(current_setting(''fh.profile_id'',true),'''')::uuid
        AND EXISTS (SELECT 1 FROM finance_profiles p WHERE p.id=profile_id)
      ) WITH CHECK (
        profile_id = NULLIF(current_setting(''fh.profile_id'',true),'''')::uuid
        AND EXISTS (SELECT 1 FROM finance_profiles p WHERE p.id=profile_id)
      )',tablename
    );
  END LOOP;
END
$fh_rls$;


-- A reversal must be unique and reference one previously recorded transaction.
CREATE UNIQUE INDEX ledger_reversal_unique_idx
 ON ledger_transactions(profile_id,reversed_transaction_id)
 WHERE reversed_transaction_id IS NOT NULL;

CREATE INDEX ledger_postings_transaction_idx ON ledger_postings(profile_id,transaction_id);
CREATE INDEX ledger_payment_links_settlement_idx ON ledger_payment_links(profile_id,settlement_id);
CREATE INDEX ledger_payment_links_loan_idx ON ledger_payment_links(profile_id,loan_payment_id);
CREATE INDEX reserve_allocations_reserve_idx ON reserve_allocations(profile_id,reserve_id);

-- Every persisted ledger transaction must be complete at COMMIT, not at statement
-- time: callers insert the transaction and its postings in one atomic transaction.
CREATE FUNCTION finance.check_ledger_transaction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = finance, pg_catalog
AS $$
DECLARE
  v_profile uuid;
  v_transaction uuid;
  v_kind text;
  v_reversed uuid;
  v_original_kind text;
  v_count integer;
  v_total numeric;
  v_min bigint;
  v_max bigint;
  v_original_count integer;
BEGIN
  IF TG_TABLE_NAME = 'ledger_postings' THEN
    v_profile := NEW.profile_id;
    v_transaction := NEW.transaction_id;
  ELSE
    v_profile := NEW.profile_id;
    v_transaction := NEW.id;
  END IF;

  SELECT kind, reversed_transaction_id INTO v_kind, v_reversed
    FROM finance.ledger_transactions
    WHERE profile_id=v_profile AND id=v_transaction;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger transaction missing' USING ERRCODE='23503';
  END IF;

  SELECT count(*),coalesce(sum(signed_minor),0),min(signed_minor),max(signed_minor)
    INTO v_count,v_total,v_min,v_max
    FROM finance.ledger_postings
    WHERE profile_id=v_profile AND transaction_id=v_transaction;

  IF v_kind='transfer' THEN
    IF v_count <> 2 OR v_total <> 0 OR v_min >= 0 OR v_max <= 0 THEN
      RAISE EXCEPTION 'transfer must contain two opposite postings' USING ERRCODE='23514';
    END IF;
  ELSIF v_kind='reversal' THEN
    IF v_reversed IS NULL THEN
      RAISE EXCEPTION 'reversal must identify a transaction' USING ERRCODE='23514';
    END IF;
    SELECT kind INTO v_original_kind FROM finance.ledger_transactions
      WHERE profile_id=v_profile AND id=v_reversed;
    IF v_original_kind IS NULL OR v_original_kind='reversal' THEN
      RAISE EXCEPTION 'invalid reversal target' USING ERRCODE='23514';
    END IF;
    SELECT count(*) INTO v_original_count FROM finance.ledger_postings
      WHERE profile_id=v_profile AND transaction_id=v_reversed;
    IF v_count <> v_original_count OR v_count NOT IN (1,2) OR
       EXISTS (
         (SELECT account_id,signed_minor FROM finance.ledger_postings
           WHERE profile_id=v_profile AND transaction_id=v_reversed)
         EXCEPT
         (SELECT account_id,-signed_minor FROM finance.ledger_postings
           WHERE profile_id=v_profile AND transaction_id=v_transaction)
       ) OR EXISTS (
         (SELECT account_id,-signed_minor FROM finance.ledger_postings
           WHERE profile_id=v_profile AND transaction_id=v_transaction)
         EXCEPT
         (SELECT account_id,signed_minor FROM finance.ledger_postings
           WHERE profile_id=v_profile AND transaction_id=v_reversed)
       ) THEN
      RAISE EXCEPTION 'reversal must exactly compensate original postings' USING ERRCODE='23514';
    END IF;
  ELSE
    IF v_reversed IS NOT NULL THEN
      RAISE EXCEPTION 'only reversals may refer to another transaction' USING ERRCODE='23514';
    END IF;
    IF v_count <> 1 OR
       (v_kind='income' AND v_min <= 0) OR
       -- Linked payments may be inflows or outflows. Their exact signed
       -- amount is validated by the deferred payment-link trigger.
       (v_kind='expense' AND v_max >= 0) OR
       v_kind NOT IN ('income','expense','payment','adjustment') THEN
      RAISE EXCEPTION 'incorrect ledger posting shape' USING ERRCODE='23514';
    END IF;
    -- An unlinked payment is an untraceable financial movement. Require exactly one
    -- settlement or loan payment link in the same committed transaction.
    IF v_kind='payment' AND (
      SELECT count(*) FROM finance.ledger_payment_links
      WHERE profile_id=v_profile AND transaction_id=v_transaction
    ) <> 1 THEN
      RAISE EXCEPTION 'payment transaction requires an atomic payment link' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ledger_tx_complete
  AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance.check_ledger_transaction();
CREATE CONSTRAINT TRIGGER ledger_posting_complete
  AFTER INSERT ON ledger_postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance.check_ledger_transaction();

-- The audit actor must be the principal verified by the server; rejecting
-- spoofed actor IDs remains valid even when an application bug passes them.
CREATE FUNCTION finance.verify_ledger_actor()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = finance, pg_catalog
AS $$
BEGIN
  IF NEW.actor_user_id IS DISTINCT FROM NULLIF(current_setting('fh.user_id',true),'') THEN
    RAISE EXCEPTION 'ledger actor does not match authenticated principal' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_actor_guard
  BEFORE INSERT ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION finance.verify_ledger_actor();
REVOKE ALL ON FUNCTION finance.verify_ledger_actor() FROM PUBLIC;

-- A payment link never posts new money: it connects one existing payment to
-- one existing debit of exactly the same amount. Unique keys reject repeats.
CREATE FUNCTION finance.check_payment_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = finance, pg_catalog
AS $$
DECLARE
  v_kind text;
  v_amount bigint;
  v_direction text;
  v_expected bigint;
  v_posting bigint;
  v_count integer;
BEGIN
  SELECT kind INTO v_kind FROM finance.ledger_transactions
    WHERE profile_id=NEW.profile_id AND id=NEW.transaction_id;
  IF v_kind IS DISTINCT FROM 'payment' THEN
    RAISE EXCEPTION 'payment link requires payment ledger kind' USING ERRCODE='23514';
  END IF;
  IF NEW.settlement_id IS NOT NULL THEN
    SELECT s.amount_minor,o.direction INTO v_amount,v_direction
      FROM finance.settlements s
      JOIN finance.obligations o
        ON o.profile_id=s.profile_id AND o.id=s.obligation_id
     WHERE s.profile_id=NEW.profile_id AND s.id=NEW.settlement_id
       AND s.voided_at IS NULL;
  ELSE
    SELECT amount_minor INTO v_amount FROM finance.loan_payments
      WHERE profile_id=NEW.profile_id AND id=NEW.loan_payment_id AND voided_at IS NULL;
    v_direction := 'expense'; -- loan repayment is always an outflow
  END IF;
  IF v_amount IS NULL OR v_direction NOT IN ('income','expense') THEN
    RAISE EXCEPTION 'payment link has no valid obligation or loan payment'
      USING ERRCODE='23514';
  END IF;
  v_expected := CASE WHEN v_direction='income' THEN v_amount ELSE -v_amount END;
  SELECT count(*),sum(signed_minor) INTO v_count,v_posting
    FROM finance.ledger_postings
    WHERE profile_id=NEW.profile_id AND transaction_id=NEW.transaction_id;
  IF v_count <> 1 OR v_posting IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'payment link amount or signed direction does not match posting'
      USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payment_link_valid
  AFTER INSERT ON ledger_payment_links
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance.check_payment_link();

-- Once a settlement exists, changing obligation direction would reinterpret
-- historical positive/negative payments without changing immutable postings.
CREATE FUNCTION finance.guard_obligation_direction()
RETURNS trigger LANGUAGE plpgsql
SET search_path = finance, pg_catalog
AS $$
BEGIN
  IF OLD.direction IS DISTINCT FROM NEW.direction AND EXISTS (
    SELECT 1 FROM finance.settlements s
      WHERE s.profile_id=OLD.profile_id AND s.obligation_id=OLD.id
  ) THEN
    RAISE EXCEPTION 'settled obligation direction is immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_settled_obligation_direction
  BEFORE UPDATE OF direction ON obligations
  FOR EACH ROW EXECUTE FUNCTION finance.guard_obligation_direction();
REVOKE ALL ON FUNCTION finance.guard_obligation_direction() FROM PUBLIC;

-- Audit and journal are append-only even if a privileged grant is accidentally
-- broadened later. Corrections require a compensating transaction.
CREATE FUNCTION finance.reject_audit_mutation()
RETURNS trigger LANGUAGE plpgsql
SET search_path = finance, pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'financial journal is append only' USING ERRCODE='23514';
END $$;
CREATE TRIGGER protect_ledger_transaction BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION finance.reject_audit_mutation();
CREATE TRIGGER protect_ledger_posting BEFORE UPDATE OR DELETE ON ledger_postings
  FOR EACH ROW EXECUTE FUNCTION finance.reject_audit_mutation();
CREATE TRIGGER protect_ledger_payment_link BEFORE UPDATE OR DELETE ON ledger_payment_links
  FOR EACH ROW EXECUTE FUNCTION finance.reject_audit_mutation();
CREATE TRIGGER protect_change_log BEFORE UPDATE OR DELETE ON change_log
  FOR EACH ROW EXECUTE FUNCTION finance.reject_audit_mutation();
CREATE TRIGGER protect_allocations BEFORE UPDATE OR DELETE ON reserve_allocations
  FOR EACH ROW EXECUTE FUNCTION finance.reject_audit_mutation();

REVOKE ALL ON FUNCTION finance.check_ledger_transaction() FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.check_payment_link() FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.reject_audit_mutation() FROM PUBLIC;

-- Explicit runtime grants: never grant DELETE, TRUNCATE, REFERENCES, TRIGGER,
-- CREATE, schema ownership, or wide privileges on future tables.
GRANT USAGE ON SCHEMA finance TO fh_finance_runtime;
GRANT SELECT,INSERT ON finance_profiles TO fh_finance_runtime;
GRANT UPDATE (revision,min_available_revision,updated_at) ON finance_profiles TO fh_finance_runtime;
-- Deliberately deny UPDATE on tenant identity (profile_id,id), audit metadata
-- and ownership; fields not listed here are immutable for the runtime role.
GRANT SELECT,INSERT ON accounts,obligations,loans,reserves TO fh_finance_runtime;
-- The opening balance is immutable after account creation; correct balances
-- with an auditable adjustment transaction, never rewrite historical opening.
GRANT UPDATE (name,kind,entity_revision,archived_at,updated_at)
  ON accounts TO fh_finance_runtime;
GRANT UPDATE (title,direction,amount_minor,starts_on,timezone,
              recurrence_unit,recurrence_every,category,
              entity_revision,deleted_at,updated_at)
  ON obligations TO fh_finance_runtime;
GRANT UPDATE (title,opening_minor,payment_minor,apr_basis_points,term_months,
              due_day,as_of_date,calculation_version,imported_schedule,
              entity_revision,deleted_at,updated_at)
  ON loans TO fh_finance_runtime;
GRANT UPDATE (title,target_minor,target_on,entity_revision,archived_at,updated_at)
  ON reserves TO fh_finance_runtime;
GRANT SELECT,INSERT ON ledger_transactions,ledger_postings,settlements,
  loan_payments,ledger_payment_links,reserve_allocations,command_receipts,
  change_log,import_batches,import_record_map TO fh_finance_runtime;
GRANT UPDATE (status,committed_at) ON import_batches TO fh_finance_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA finance FROM PUBLIC;
