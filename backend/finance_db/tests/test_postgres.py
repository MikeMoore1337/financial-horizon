"""Real PostgreSQL tests: tenant isolation, limited runtime grants and ledgers."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import date
from uuid import UUID, uuid4
import os
import threading
import time

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DBAPIError, IntegrityError, ProgrammingError

from backend.finance_db.db import create_finance_engine, finance_transaction
from backend.finance_db.models import Base

USER_A, USER_B = "1" * 32, "2" * 32
PROFILE_A, PROFILE_B = UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), UUID("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
ACCOUNT_A1, ACCOUNT_A2 = uuid4(), uuid4()


@pytest.fixture(scope="module")
def runtime():
    engine = create_finance_engine()
    with engine.connect() as c:
        roles = c.execute(text(
            "SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user"
        )).one()
        assert roles == (False, False, False, False)
        assert c.execute(text("SELECT current_user")).scalar_one() == "fh_finance_runtime"
    with finance_transaction(engine, verified_user_id=USER_A, profile_id=PROFILE_A) as s:
        s.execute(text(
            "INSERT INTO finance_profiles(id,owner_user_id) VALUES (:p,:u)"
        ), {"p": PROFILE_A, "u": USER_A})
        for a, n in ((ACCOUNT_A1, "Synthetic one"), (ACCOUNT_A2, "Synthetic two")):
            s.execute(text(
                "INSERT INTO accounts(profile_id,id,name,kind,opening_minor) VALUES (:p,:a,:n,'bank',0)"
            ), {"p": PROFILE_A, "a": a, "n": n})
    with finance_transaction(engine, verified_user_id=USER_B, profile_id=PROFILE_B) as s:
        s.execute(text("INSERT INTO finance_profiles(id,owner_user_id) VALUES (:p,:u)"),
                  {"p": PROFILE_B, "u": USER_B})
    yield engine
    engine.dispose()


def test_mapping_covers_all_finance_tables():
    expected = {
        "finance_profiles", "accounts", "obligations", "loans", "reserves",
        "ledger_transactions", "ledger_postings", "settlements", "loan_payments",
        "ledger_payment_links", "reserve_allocations", "command_receipts",
        "change_log", "import_batches", "import_record_map",
    }
    assert {t.name for t in Base.metadata.tables.values()} == expected


def test_migration_head():
    dsn = os.environ["FH_FINANCE_MIGRATION_URL"]
    engine = create_engine(dsn, connect_args={"options": "-csearch_path=finance,pg_catalog"})
    try:
        with engine.connect() as c:
            assert c.execute(text("SELECT version_num FROM finance.alembic_version")).scalar_one() == "0001_initial"
            policies = c.execute(text("""
                SELECT count(*) FROM pg_class c
                JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname='finance' AND c.relkind='r'
                  AND c.relname <> 'alembic_version' AND c.relrowsecurity AND c.relforcerowsecurity
            """)).scalar_one()
            assert policies == 15
    finally:
        engine.dispose()


def test_fail_closed_without_scope_and_pool_reuse(runtime):
    with runtime.connect() as c:
        assert c.execute(text("SELECT count(*) FROM finance_profiles")).scalar_one() == 0
        with pytest.raises(DBAPIError):
            c.execute(text(
                "INSERT INTO finance_profiles(id,owner_user_id) VALUES (:p,:u)"
            ), {"p": uuid4(), "u": "3"*32})
    for user, profile in ((USER_A, PROFILE_A), (USER_B, PROFILE_B)):
        with finance_transaction(runtime, verified_user_id=user, profile_id=profile) as s:
            assert s.execute(text("SELECT count(*) FROM finance_profiles")).scalar_one() == 1
            assert s.execute(text("SELECT owner_user_id FROM finance_profiles")).scalar_one() == user
        with runtime.connect() as c:
            assert c.execute(text("SELECT count(*) FROM finance_profiles")).scalar_one() == 0


def test_cross_tenant_select_insert_update_returning_and_delete(runtime):
    with finance_transaction(runtime, verified_user_id=USER_B, profile_id=PROFILE_B) as s:
        assert s.execute(text(
            "SELECT count(*) FROM accounts WHERE profile_id=:other"
        ), {"other": PROFILE_A}).scalar_one() == 0
        assert s.execute(text(
            "UPDATE finance_profiles SET revision=revision+1 WHERE id=:other RETURNING id"
        ), {"other": PROFILE_A}).first() is None
        with pytest.raises(DBAPIError):
            s.execute(text(
                "INSERT INTO accounts(profile_id,id,name,kind,opening_minor) VALUES (:p,:a,'forbidden','cash',0) RETURNING id"
            ), {"p": PROFILE_A, "a": uuid4()})


def test_delete_and_schema_privileges_denied(runtime):
    with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as s:
        with pytest.raises(DBAPIError):
            s.execute(text("DELETE FROM accounts WHERE profile_id=:p RETURNING id"), {"p": PROFILE_A})
    with runtime.connect() as c:
        assert c.execute(text("SELECT has_schema_privilege(current_user,'finance','CREATE')")).scalar_one() is False
        assert c.execute(text("SELECT has_table_privilege(current_user,'finance.ledger_transactions','DELETE')")).scalar_one() is False


def test_amount_checks_and_cross_profile_fk(runtime):
    with pytest.raises(IntegrityError):
        with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as s:
            s.execute(text("INSERT INTO accounts(profile_id,id,name,kind,opening_minor) VALUES (:p,:a,'bad','bank',1000000000001)"),
                      {"p": PROFILE_A, "a": uuid4()})
    with pytest.raises(IntegrityError):
        with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as s:
            s.execute(text("""
                INSERT INTO settlements(profile_id,id,obligation_id,occurrence_on,paid_on,amount_minor)
                VALUES (:p,:id,:bad,current_date,current_date,1)
            """), {"p": PROFILE_A, "id":uuid4(), "bad":uuid4()})


def insert_ledger(s, tid, kind, postings, reversed_id=None):
    s.execute(text("""
        INSERT INTO ledger_transactions(profile_id,id,kind,occurred_on,actor_user_id,reversed_transaction_id)
        VALUES (:p,:id,:k,current_date,:actor,:rev)
    """), {"p": PROFILE_A, "id":tid, "k":kind, "actor":USER_A, "rev":reversed_id})
    for account, amount in postings:
        s.execute(text("""
            INSERT INTO ledger_postings(profile_id,transaction_id,account_id,signed_minor)
            VALUES (:p,:t,:a,:n)
        """), {"p":PROFILE_A, "t":tid, "a":account, "n":amount})


def test_transfer_constraint_deferred_and_rollback(runtime):
    bad_id = uuid4()
    with pytest.raises(IntegrityError):
        with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as s:
            insert_ledger(s, bad_id, "transfer", [(ACCOUNT_A1, -120)])
    with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as s:
        assert s.execute(text("SELECT count(*) FROM ledger_transactions WHERE id=:id"), {"id":bad_id}).scalar_one()==0
        good_id = uuid4()
        insert_ledger(s, good_id, "transfer", [(ACCOUNT_A1,-120), (ACCOUNT_A2,120)])
    with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as s:
        assert s.execute(text("SELECT sum(signed_minor) FROM ledger_postings WHERE transaction_id=:id"),
                         {"id":good_id}).scalar_one() == 0
        reverse_id = uuid4()
        insert_ledger(s, reverse_id, "reversal", [(ACCOUNT_A1,120),(ACCOUNT_A2,-120)],good_id)
    with pytest.raises(IntegrityError):
        with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as s:
            insert_ledger(s, uuid4(), "reversal", [(ACCOUNT_A1,120),(ACCOUNT_A2,-120)],good_id)
    with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as s:
        with pytest.raises(DBAPIError):
            s.execute(text("UPDATE ledger_postings SET signed_minor=5 WHERE transaction_id=:id"), {"id": good_id})


def test_payment_link_exact_amount_and_no_double_charge(runtime):
    oid, sid, tx = uuid4(), uuid4(), uuid4()
    with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as s:
        s.execute(text("""
            INSERT INTO obligations(profile_id,id,title,direction,amount_minor,starts_on)
            VALUES (:p,:id,'Synthetic expense','expense',100,current_date)
        """), {"p":PROFILE_A,"id":oid})
        s.execute(text("""
            INSERT INTO settlements(profile_id,id,obligation_id,occurrence_on,paid_on,amount_minor)
            VALUES (:p,:sid,:oid,current_date,current_date,100)
        """), {"p":PROFILE_A,"sid":sid,"oid":oid})
        insert_ledger(s,tx,"payment",[(ACCOUNT_A1,-100)])
        s.execute(text("""
            INSERT INTO ledger_payment_links(profile_id,transaction_id,settlement_id)
            VALUES (:p,:tx,:sid)
        """), {"p":PROFILE_A,"tx":tx,"sid":sid})
    with pytest.raises(IntegrityError):
        with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as s:
            s.execute(text("""
                INSERT INTO ledger_payment_links(profile_id,transaction_id,settlement_id)
                VALUES (:p,:tx,:sid)
            """), {"p":PROFILE_A,"tx":tx,"sid":sid})
    with pytest.raises(IntegrityError):
        with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as s:
            incorrect = uuid4()
            insert_ledger(s,incorrect,"payment",[(ACCOUNT_A1,-101)])
            s.execute(text("""
                INSERT INTO ledger_payment_links(profile_id,transaction_id,settlement_id)
                VALUES (:p,:tx,:sid)
            """), {"p":PROFILE_A,"tx":incorrect,"sid":sid})


def test_concurrent_revision_serialization(runtime):
    barrier=threading.Barrier(2)
    def increment():
        with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as s:
            barrier.wait(timeout=5)
            return s.execute(text("""
                UPDATE finance_profiles SET revision=revision+1 WHERE id=:p RETURNING revision
            """), {"p":PROFILE_A}).scalar_one()
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures=[pool.submit(increment) for _ in range(2)]
        results=sorted(f.result(timeout=8) for f in futures)
    assert results[1]-results[0]==1


def test_idempotency_unique_under_concurrency(runtime):
    mutation = uuid4()
    barrier = threading.Barrier(2)
    def submit():
        try:
            with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as s:
                barrier.wait(timeout=5)
                s.execute(text("""
                    INSERT INTO command_receipts
                      (profile_id,client_mutation_id,request_sha256,status_code,response_body)
                    VALUES (:p,:id,:hash,409,CAST(:body AS jsonb))
                """), {"p": PROFILE_A, "id":mutation, "hash": b"x"*32, "body":"{}"})
            return "committed"
        except IntegrityError:
            return "duplicate_rejected"
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures=[pool.submit(submit) for _ in range(2)]
        assert sorted(f.result(timeout=8) for f in futures)==["committed","duplicate_rejected"]


def test_unlinked_payment_is_rejected_on_commit(runtime):
    """Every payment debit must attach to exactly one valid settlement/loan payment."""
    transaction_id = uuid4()
    with pytest.raises(IntegrityError):
        with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as session:
            insert_ledger(session, transaction_id, "payment", [(ACCOUNT_A1, -123)])
    with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as session:
        assert session.execute(
            text("SELECT count(*) FROM ledger_transactions WHERE id=:t"),
            {"t": transaction_id},
        ).scalar_one() == 0


def test_actor_cannot_be_spoofed_by_finance_role(runtime):
    """PostgreSQL rejects an actor ID that does not match SET LOCAL identity."""
    with pytest.raises(DBAPIError):
        with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as session:
            session.execute(
                text("""
                    INSERT INTO ledger_transactions
                      (profile_id,id,kind,occurred_on,actor_user_id)
                    VALUES (:p,:t,'income',current_date,:other)
                """),
                {"p": PROFILE_A, "t": uuid4(), "other": USER_B},
            )


def test_failing_ledger_commit_rolls_back_profile_revision_and_receipt(runtime):
    """A transfer's failed deferred check cannot leave an acknowledged command."""
    mutation_id, transaction_id = uuid4(), uuid4()
    with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as session:
        previous = session.execute(
            text("SELECT revision FROM finance_profiles WHERE id=:p"),
            {"p": PROFILE_A},
        ).scalar_one()

    with pytest.raises(IntegrityError):
        with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as session:
            session.execute(
                text("UPDATE finance_profiles SET revision=revision+1 WHERE id=:p"),
                {"p": PROFILE_A},
            )
            session.execute(
                text("""
                    INSERT INTO command_receipts
                      (profile_id,client_mutation_id,request_sha256,status_code,
                       committed_revision,response_body)
                    VALUES (:p,:id,:hash,200,:rev,CAST(:body AS jsonb))
                """),
                {
                    "p": PROFILE_A, "id": mutation_id, "hash": b"z" * 32,
                    "rev": previous + 1, "body": "{}",
                },
            )
            insert_ledger(session, transaction_id, "transfer", [(ACCOUNT_A1, -7)])

    with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as session:
        assert session.execute(
            text("SELECT revision FROM finance_profiles WHERE id=:p"),
            {"p": PROFILE_A},
        ).scalar_one() == previous
        assert session.execute(
            text("SELECT count(*) FROM command_receipts WHERE client_mutation_id=:id"),
            {"id": mutation_id},
        ).scalar_one() == 0
        assert session.execute(
            text("SELECT count(*) FROM ledger_transactions WHERE id=:t"),
            {"t": transaction_id},
        ).scalar_one() == 0


def test_sqlalchemy_column_parity_and_bigint_monetary_storage():
    """Detect drift between reviewed SQL migration and SQLAlchemy 2 mappings."""
    from sqlalchemy import BigInteger

    engine = create_engine(os.environ["FH_FINANCE_MIGRATION_URL"])
    try:
        with engine.connect() as c:
            for table in Base.metadata.tables.values():
                actual = {
                    name: data_type
                    for name, data_type in c.execute(
                        text("""
                            SELECT column_name, data_type
                            FROM information_schema.columns
                            WHERE table_schema='finance' AND table_name=:name
                        """),
                        {"name": table.name},
                    )
                }
                declared = set(table.columns.keys())
                assert declared == set(actual), (
                    table.name,
                    "only_orm", sorted(declared - set(actual)),
                    "only_sql", sorted(set(actual) - declared),
                )
                for column in table.columns:
                    if column.name.endswith("_minor"):
                        assert isinstance(column.type, BigInteger), (
                            table.name, column.name, "ORM must use BIGINT"
                        )
                        assert actual[column.name] == "bigint", (
                            table.name, column.name, "PostgreSQL must use BIGINT"
                        )
    finally:
        engine.dispose()

def test_runtime_cannot_update_tenant_identity(runtime):
    """A valid profile context does not grant permission to rewrite tenant/UUID keys."""
    with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as session:
        assert session.execute(text(
            "SELECT has_column_privilege(current_user,'finance.accounts','id','UPDATE')"
        )).scalar_one() is False
        assert session.execute(text(
            "SELECT has_column_privilege(current_user,'finance.accounts','profile_id','UPDATE')"
        )).scalar_one() is False
        assert session.execute(text(
            "SELECT has_column_privilege(current_user,'finance.accounts','name','UPDATE')"
        )).scalar_one() is True
        assert session.execute(text(
            "SELECT has_column_privilege(current_user,'finance.obligations','profile_id','UPDATE')"
        )).scalar_one() is False
        assert session.execute(text(
            "SELECT has_column_privilege(current_user,'finance.loans','id','UPDATE')"
        )).scalar_one() is False
        assert session.execute(text(
            "SELECT has_column_privilege(current_user,'finance.reserves','id','UPDATE')"
        )).scalar_one() is False

    with pytest.raises(DBAPIError):
        with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as session:
            session.execute(text(
                "UPDATE accounts SET id=:next WHERE profile_id=:profile AND id=:existing RETURNING id"
            ), {"next":uuid4(), "profile":PROFILE_A, "existing":ACCOUNT_A1})

    with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as session:
        assert session.execute(text(
            "SELECT count(*) FROM accounts WHERE profile_id=:p AND id=:a"
        ), {"p":PROFILE_A, "a":ACCOUNT_A1}).scalar_one() == 1


def test_account_requires_explicit_opening_balance_and_valid_kind(runtime):
    """Database must not silently interpret an absent balance as 0."""
    with pytest.raises(IntegrityError):
        with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as session:
            session.execute(
                text("INSERT INTO accounts(profile_id,id,name,kind) VALUES (:p,:a,'missing opening','cash')"),
                {"p": PROFILE_A, "a": uuid4()},
            )

    with pytest.raises(IntegrityError):
        with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as session:
            session.execute(
                text(
                    "INSERT INTO accounts(profile_id,id,name,kind,opening_minor) "
                    "VALUES (:p,:a,'invalid kind','crypto',0)"
                ),
                {"p": PROFILE_A, "a": uuid4()},
            )

    with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as session:
        record_id = uuid4()
        session.execute(
            text(
                "INSERT INTO accounts(profile_id,id,name,kind,opening_minor) "
                "VALUES (:p,:a,'explicit zero','savings',0)"
            ),
            {"p": PROFILE_A, "a": record_id},
        )
        row = session.execute(
            text("SELECT kind,opening_minor FROM accounts WHERE profile_id=:p AND id=:a"),
            {"p": PROFILE_A, "a": record_id},
        ).one()
        assert row == ("savings", 0)


def test_opening_balance_is_immutable_after_account_creation(runtime):
    """Opening balance corrections must be auditable ledger adjustments."""
    with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as session:
        assert session.execute(text(
            "SELECT has_column_privilege(current_user,'finance.accounts','opening_minor','UPDATE')"
        )).scalar_one() is False
        original = session.execute(text(
            "SELECT opening_minor FROM accounts WHERE profile_id=:p AND id=:a"
        ), {"p": PROFILE_A, "a": ACCOUNT_A1}).scalar_one()

    with pytest.raises(DBAPIError):
        with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as session:
            session.execute(text(
                "UPDATE accounts SET opening_minor=:n WHERE profile_id=:p AND id=:a RETURNING opening_minor"
            ), {"n": 1234, "p": PROFILE_A, "a": ACCOUNT_A1})

    with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as session:
        assert session.execute(text(
            "SELECT opening_minor FROM accounts WHERE profile_id=:p AND id=:a"
        ), {"p": PROFILE_A, "a": ACCOUNT_A1}).scalar_one() == original
        # The ledger adjustment itself is permitted, and remains append-only.
        tx = uuid4()
        insert_ledger(session, tx, "adjustment", [(ACCOUNT_A1, 1234)])
    with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as session:
        assert session.execute(text(
            "SELECT signed_minor FROM ledger_postings WHERE transaction_id=:t"
        ), {"t": tx}).scalar_one() == 1234


def test_income_settlement_requires_positive_payment_and_expense_requires_negative(runtime):
    """A received income is credited, and an outgoing obligation is debited."""
    def post_settlement(direction: str, signed_minor: int):
        oid, sid, tx = uuid4(), uuid4(), uuid4()
        with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as session:
            session.execute(text("""
                INSERT INTO obligations(profile_id,id,title,direction,amount_minor,starts_on)
                VALUES (:p,:oid,'Synthetic signed obligation',:direction,175,current_date)
            """), {"p": PROFILE_A, "oid": oid, "direction": direction})
            session.execute(text("""
                INSERT INTO settlements(profile_id,id,obligation_id,occurrence_on,paid_on,amount_minor)
                VALUES (:p,:sid,:oid,current_date,current_date,175)
            """), {"p": PROFILE_A, "sid": sid, "oid": oid})
            insert_ledger(session, tx, "payment", [(ACCOUNT_A1, signed_minor)])
            session.execute(text("""
                INSERT INTO ledger_payment_links(profile_id,transaction_id,settlement_id)
                VALUES (:p,:tx,:sid)
            """), {"p": PROFILE_A, "tx": tx, "sid": sid})
        return oid, sid, tx

    income_oid, _, income_tx = post_settlement("income", 175)
    _, _, expense_tx = post_settlement("expense", -175)

    with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as session:
        assert session.execute(text(
            "SELECT signed_minor FROM ledger_postings WHERE transaction_id=:tx"
        ), {"tx": income_tx}).scalar_one() == 175
        assert session.execute(text(
            "SELECT signed_minor FROM ledger_postings WHERE transaction_id=:tx"
        ), {"tx": expense_tx}).scalar_one() == -175

    # Rewriting direction after a settlement would invalidate historical flow.
    with pytest.raises(DBAPIError):
        with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as session:
            session.execute(text(
                "UPDATE obligations SET direction='expense' WHERE profile_id=:p AND id=:oid"
            ), {"p": PROFILE_A, "oid": income_oid})

    with pytest.raises(IntegrityError):
        post_settlement("income", -175)
    with pytest.raises(IntegrityError):
        post_settlement("expense", 175)


def test_loan_payment_is_always_negative(runtime):
    """Credits to a loan repayment account cannot masquerade as repayment."""
    lid = uuid4()
    with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as session:
        session.execute(text("""
            INSERT INTO loans(profile_id,id,title,opening_minor,payment_minor,
                              apr_basis_points,term_months,due_day,as_of_date)
            VALUES (:p,:loan,'Synthetic loan',10000,100,1500,12,15,current_date)
        """), {"p": PROFILE_A, "loan": lid})

    def record_loan_payment(signed: int):
        pay_id, tx = uuid4(), uuid4()
        with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as session:
            session.execute(text("""
                INSERT INTO loan_payments(profile_id,id,loan_id,paid_on,amount_minor,strategy)
                VALUES (:p,:pay,:loan,current_date,100,'term')
            """), {"p": PROFILE_A, "pay": pay_id, "loan": lid})
            insert_ledger(session, tx, "payment", [(ACCOUNT_A1, signed)])
            session.execute(text("""
                INSERT INTO ledger_payment_links(profile_id,transaction_id,loan_payment_id)
                VALUES (:p,:tx,:pay)
            """), {"p": PROFILE_A, "tx": tx, "pay": pay_id})
        return tx

    good = record_loan_payment(-100)
    with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as session:
        assert session.execute(text(
            "SELECT signed_minor FROM ledger_postings WHERE transaction_id=:tx"
        ), {"tx": good}).scalar_one() == -100
    with pytest.raises(IntegrityError):
        record_loan_payment(100)


def test_settlement_insert_waits_for_concurrent_direction_change(runtime):
    """INSERT must use FOR UPDATE, not compatible FK KEY SHARE."""
    oid = uuid4()
    with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as s:
        s.execute(text("""
            INSERT INTO obligations (profile_id,id,title,direction,amount_minor,starts_on)
            VALUES (:p,:oid,'Concurrent direction change','income',125,current_date)
        """), {"p": PROFILE_A, "oid": oid})

    changed, release = threading.Event(), threading.Event()

    def change_direction():
        with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as s:
            s.execute(text("""
                UPDATE obligations SET direction='expense'
                WHERE profile_id=:p AND id=:oid
            """), {"p": PROFILE_A, "oid": oid})
            changed.set()
            if not release.wait(timeout=5):
                raise TimeoutError("Synthetic direction-change lock was not released")

    with ThreadPoolExecutor(max_workers=1) as pool:
        task = pool.submit(change_direction)
        assert changed.wait(timeout=3)
        try:
            with pytest.raises(DBAPIError) as exc:
                with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as s:
                    s.execute(text("SET LOCAL lock_timeout = '200ms'"))
                    s.execute(text("""
                        INSERT INTO settlements
                          (profile_id,id,obligation_id,occurrence_on,paid_on,amount_minor)
                        VALUES (:p,:sid,:oid,current_date,current_date,125)
                    """), {"p": PROFILE_A, "sid": uuid4(), "oid": oid})
            assert exc.value.orig.sqlstate == "55P03"
        finally:
            release.set()
        task.result(timeout=5)
    with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as s:
        assert s.execute(text("""
            SELECT direction FROM obligations WHERE profile_id=:p AND id=:oid
        """), {"p": PROFILE_A, "oid": oid}).scalar_one() == "expense"
        assert s.execute(text("""
            SELECT count(*) FROM settlements WHERE profile_id=:p AND obligation_id=:oid
        """), {"p": PROFILE_A, "oid": oid}).scalar_one() == 0


def test_settlement_lock_prevents_concurrent_direction_update(runtime):
    """An open income settlement+positive ledger posting bars a direction UPDATE."""
    oid, sid, txid = uuid4(), uuid4(), uuid4()
    with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as s:
        s.execute(text("""
            INSERT INTO obligations (profile_id,id,title,direction,amount_minor,starts_on)
            VALUES (:p,:oid,'Concurrent paid obligation','income',125,current_date)
        """), {"p": PROFILE_A, "oid": oid})

    inserted, release = threading.Event(), threading.Event()

    def commit_income_settlement():
        with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as s:
            s.execute(text("""
                INSERT INTO settlements
                  (profile_id,id,obligation_id,occurrence_on,paid_on,amount_minor)
                VALUES (:p,:sid,:oid,current_date,current_date,125)
            """), {"p": PROFILE_A, "sid": sid, "oid": oid})
            insert_ledger(s, txid, "payment", [(ACCOUNT_A1, 125)])
            s.execute(text("""
                INSERT INTO ledger_payment_links(profile_id,transaction_id,settlement_id)
                VALUES (:p,:tx,:sid)
            """), {"p": PROFILE_A, "tx": txid, "sid": sid})
            inserted.set()
            if not release.wait(timeout=5):
                raise TimeoutError("Synthetic settlement lock was not released")

    with ThreadPoolExecutor(max_workers=1) as pool:
        task = pool.submit(commit_income_settlement)
        assert inserted.wait(timeout=3)
        try:
            with pytest.raises(DBAPIError) as exc:
                with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as s:
                    s.execute(text("SET LOCAL lock_timeout = '200ms'"))
                    s.execute(text("""
                        UPDATE obligations SET direction='expense'
                        WHERE profile_id=:p AND id=:oid
                    """), {"p": PROFILE_A, "oid": oid})
            assert exc.value.orig.sqlstate == "55P03"
        finally:
            release.set()
        task.result(timeout=5)

    with pytest.raises(DBAPIError):
        with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as s:
            s.execute(text("""
                UPDATE obligations SET direction='expense'
                WHERE profile_id=:p AND id=:oid
            """), {"p": PROFILE_A, "oid": oid})
    with finance_transaction(runtime, verified_user_id=USER_A, profile_id=PROFILE_A) as s:
        assert s.execute(text("""
            SELECT direction FROM obligations WHERE profile_id=:p AND id=:oid
        """), {"p": PROFILE_A, "oid": oid}).scalar_one() == "income"
        assert s.execute(text("""
            SELECT signed_minor FROM ledger_postings WHERE profile_id=:p AND transaction_id=:tx
        """), {"p": PROFILE_A, "tx": txid}).scalar_one() == 125
