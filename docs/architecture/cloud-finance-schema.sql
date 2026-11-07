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
  currency char(3) NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
  opening_minor bigint NOT NULL DEFAULT 0
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
  timezone varchar(64) NOT NULL DEFAULT 'Europe/Moscow',
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

-- Repeat the following for every child table above (including receipts,
-- change_log and import_*) as part of Alembic #66. No child-table exemptions.
-- Replace <table_name> with a child table name before execution.
-- ALTER TABLE <table_name> ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE <table_name> FORCE ROW LEVEL SECURITY;
-- CREATE POLICY <table_name>_owner ON <table_name>
--   USING (profile_id = NULLIF(current_setting('fh.profile_id',true),'')::uuid
--     AND EXISTS (SELECT 1 FROM finance_profiles p
--                 WHERE p.id = profile_id))
--   WITH CHECK (profile_id = NULLIF(current_setting('fh.profile_id',true),'')::uuid
--     AND EXISTS (SELECT 1 FROM finance_profiles p
--                 WHERE p.id = profile_id));

-- #66/#67 mandatory, NOT implemented here:
-- (1) Deferred DB constraint trigger or equivalent locked transactional validation
--     checks every transfer has exactly 2 *different* accounts and opposite postings,
--     and non-transfer kinds have their allowed posting shape.
-- (2) Account balance/reseve allocation cannot violate business invariants;
--     perform validations under account locks within the same transaction.
-- (3) Reversal is a new compensating ledger transaction linked once, never DELETE;
--     don't allow reversed_transaction_id to cross profile or a reversal cycle.
-- (4) Every committed command increments profile revision once; change_log,
--     receipts and all business mutations share one COMMIT.
-- (5) Set runtime database privileges SELECT/INSERT/UPDATE only as necessary.
--     No TRUNCATE/DDL, never run app as migration owner.
