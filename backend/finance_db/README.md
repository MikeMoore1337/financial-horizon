# Financial PostgreSQL internals

SQLAlchemy 2 mappings cover all 15 tables. Alembic reviewable DDL is the
authoritative source of physical constraints, RLS and grants. Autogenerate
and Base.metadata.create_all are not a replacement for this migration.

Only use FH_FINANCE_MIGRATION_URL with migration credentials and private
PGPASSFILE for Alembic, and FH_FINANCE_DATABASE_URL with the unprivileged
runtime role for transactional access.

finance_transaction(engine, verified_user_id, profile_id) binds transaction
scope with SET LOCAL. The finance API in #67 must first validate the real
auth SQLite session and authorized profile. RLS does not secure arbitrary
untrusted SQL able to set session GUCs. There are no HTTP endpoints here.
