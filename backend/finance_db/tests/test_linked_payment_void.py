"""#33/#67: real PostgreSQL linked-payment void + immutable compensation.

All identities and amounts are synthetic; only disposable CI PostgreSQL.
"""
from __future__ import annotations

from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from backend.finance_db.db import finance_transaction
from backend.finance_db.ledger_service import (
    FinanceCommandError, get_account_snapshot, submit_account_command,
)
from backend.finance_db.snapshot import get_finance_delta, get_finance_snapshot
from backend.finance_db.tests.test_ledger_service import (
    context, add_account, make_command, call,
)


def _seed_payment(engine, scope, *, settlement: bool, direction: str = "expense"):
    account_id, _ = add_account(engine, scope, opening=20_000)
    source_id, fact_id, transaction_id = uuid4(), uuid4(), uuid4()
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as db:
        if settlement:
            db.execute(text("""
                INSERT INTO obligations
                 (profile_id,id,title,direction,amount_minor,starts_on)
                VALUES (:p,:id,'Synthetic payment',:direction,5000,'2026-11-08')
            """), {"p": scope.profile_id, "id": source_id, "direction": direction})
        else:
            db.execute(text("""
                INSERT INTO loans
                 (profile_id,id,title,opening_minor,payment_minor,apr_basis_points,
                  term_months,due_day,as_of_date)
                VALUES (:p,:id,'Synthetic debt',50000,5000,1200,24,8,'2026-11-08')
            """), {"p": scope.profile_id, "id": source_id})
    before = get_account_snapshot(engine, scope=scope)
    versions = {account_id: before.body["entities"][0]["entity_revision"], str(source_id): 1}
    body = ({
        "transaction_id": str(transaction_id), "fact_id": str(fact_id),
        "account_id": account_id, "amount_minor": 1_200,
        "paid_on": "2026-11-08", "obligation_id": str(source_id),
        "occurrence_on": "2026-11-08",
    } if settlement else {
        "transaction_id": str(transaction_id), "fact_id": str(fact_id),
        "account_id": account_id, "amount_minor": 1_200,
        "paid_on": "2026-11-08", "loan_id": str(source_id),
        "strategy": "term",
    })
    recorded = call(
        engine, scope, make_command(
            before.body["revision"],
            "settlement.payment.record" if settlement else "loan.payment.record",
            body, versions,
        ), before.etag,
    )
    assert recorded.status == 201
    return account_id, fact_id, transaction_id, recorded.body["revision"]


def _balances(engine, scope, account_id):
    state = get_account_snapshot(engine, scope=scope)
    item = next(x for x in state.body["entities"] if x["id"] == account_id)
    return state, item["data"]["balance_minor"], item["entity_revision"]


def _void(engine, scope, account_id, fact_id, transaction_id, *,
          settlement: bool, reason="Ошибка оплаты", mutation=None):
    state, _, account_version = _balances(engine, scope, account_id)
    cmd = make_command(
        state.body["revision"],
        "settlement.payment.void" if settlement else "loan.payment.void",
        {
            "transaction_id": str(transaction_id), "fact_id": str(fact_id),
            "account_id": account_id, "reason": reason,
        },
        {account_id: account_version, str(fact_id): 1, str(transaction_id): 1},
        mid=mutation,
    )
    return state, cmd


@pytest.mark.parametrize("settlement,direction,signed", [
    (True, "expense", -1_200),
    (True, "income", 1_200),
    (False, "expense", -1_200),
])
def test_void_once_with_exact_compensation_and_two_deltas(context, settlement, direction, signed):
    engine, scope = context
    acc, fact, original, recorded_revision = _seed_payment(
        engine, scope, settlement=settlement, direction=direction,
    )
    before, amount, cmd_revision = _balances(engine, scope, acc)
    assert before.body["revision"] == recorded_revision
    assert amount == 20_000 + signed
    prior, cmd = _void(engine, scope, acc, fact, original, settlement=settlement)
    accepted = call(engine, scope, cmd, prior.etag)
    assert accepted.status == 201
    assert accepted.body["revision"] == prior.body["revision"] + 1
    assert len(accepted.body["changes"]) == 2
    changes = accepted.body["changes"]
    assert [(x["revision"], x["ordinal"]) for x in changes] == [
        (accepted.body["revision"], 0), (accepted.body["revision"], 1),
    ]
    assert changes[0]["kind"] == "ledger_posted"
    assert changes[0]["payload"]["transaction_kind"] == "reversal"
    assert changes[0]["payload"]["reversed_transaction_id"] == str(original)
    assert changes[0]["payload"]["entity"]["data"]["postings"] == [{
        "account_id": acc, "signed_minor": -signed,
    }]
    assert changes[1]["kind"] == "upsert"
    assert changes[1]["entity_id"] == str(fact)
    assert changes[1]["payload"]["entity"]["data"]["voided_at"] is not None
    assert changes[1]["payload"]["entity"]["entity_revision"] == 2
    assert _balances(engine, scope, acc)[1] == 20_000

    replay = call(engine, scope, cmd, prior.etag)
    assert replay.status == 200 and replay.body["replayed"] is True
    assert replay.body["revision"] == accepted.body["revision"]
    assert _balances(engine, scope, acc)[1] == 20_000
    delta = get_finance_delta(
        engine, scope=scope, since_revision=prior.body["revision"], page_revisions=1,
    )
    assert delta.body["changes"] == changes
    snapshot = get_finance_snapshot(engine, scope=scope)
    server_fact = next(x for x in snapshot.body["entities"] if x["id"] == str(fact))
    assert server_fact == changes[1]["payload"]["entity"]

    retry_state, dup = _void(engine, scope, acc, fact, original, settlement=settlement)
    with pytest.raises(FinanceCommandError) as error:
        call(engine, scope, dup, retry_state.etag)
    assert error.value.code == "semantic_conflict"
    assert _balances(engine, scope, acc)[1] == 20_000
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as db:
        assert db.execute(text("""
            SELECT count(*) FROM ledger_transactions
            WHERE reversed_transaction_id=:id
        """), {"id": original}).scalar_one() == 1
        assert db.execute(text("""
            SELECT count(*) FROM ledger_payment_links
            WHERE transaction_id=:id
        """), {"id": original}).scalar_one() == 1


def test_sql_rejects_half_void_without_reversal(context):
    engine, scope = context
    acc, fact, original, _ = _seed_payment(engine, scope, settlement=False)
    before, balance, _ = _balances(engine, scope, acc)
    with pytest.raises(IntegrityError):
        with finance_transaction(engine, verified_user_id=scope.user_id,
                                 profile_id=scope.profile_id) as db:
            db.execute(text("""
                UPDATE loan_payments SET voided_at=now(),
                   entity_revision=entity_revision+1
                WHERE profile_id=:p AND id=:id
            """), {"p": scope.profile_id, "id": fact})
    after, result, _ = _balances(engine, scope, acc)
    assert result == balance and after.body["revision"] == before.body["revision"]
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as db:
        assert db.execute(text("""
            SELECT voided_at FROM loan_payments WHERE id=:id
        """), {"id": fact}).scalar_one() is None


def test_sql_rejects_payment_reversal_without_void(context):
    engine, scope = context
    acc, fact, original, _ = _seed_payment(engine, scope, settlement=True)
    before, balance, _ = _balances(engine, scope, acc)
    reversal_id = uuid4()
    with pytest.raises(IntegrityError):
        with finance_transaction(engine, verified_user_id=scope.user_id,
                                 profile_id=scope.profile_id) as db:
            db.execute(text("""
                INSERT INTO ledger_transactions
                (profile_id,id,kind,occurred_on,actor_user_id,reversed_transaction_id)
                VALUES (:p,:id,'reversal','2026-11-11',:actor,:original)
            """), {"p": scope.profile_id, "id": reversal_id,
                   "actor": scope.user_id, "original": original})
            db.execute(text("""
                INSERT INTO ledger_postings(profile_id,transaction_id,account_id,signed_minor)
                VALUES (:p,:tx,:a,1200)
            """), {"p": scope.profile_id, "tx": reversal_id, "a": acc})
    assert _balances(engine, scope, acc)[1] == balance
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as db:
        assert db.execute(text("""
            SELECT count(*) FROM ledger_transactions WHERE id=:id
        """), {"id": reversal_id}).scalar_one() == 0


def test_void_requires_matching_fact_account_and_versions(context):
    engine, scope = context
    acc, fact, original, _ = _seed_payment(engine, scope, settlement=True)
    other, _ = add_account(engine, scope, opening=0)
    old, cmd = _void(engine, scope, acc, fact, original, settlement=True)
    cmd["payload"]["account_id"] = other
    cmd["expected_entity_revisions"][other] = 1
    with pytest.raises(FinanceCommandError) as error:
        call(engine, scope, cmd, old.etag)
    assert error.value.code == "semantic_conflict"
    assert _balances(engine, scope, acc)[1] == 18_800

    fresh, good = _void(engine, scope, acc, fact, original, settlement=True)
    good["expected_entity_revisions"][str(fact)] = 100
    with pytest.raises(FinanceCommandError) as stale:
        call(engine, scope, good, fresh.etag)
    assert stale.value.code == "semantic_conflict"


def test_runtime_cannot_modify_original_fact_fields(context):
    engine, scope = context
    _seed_payment(engine, scope, settlement=True)
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as db:
        assert db.execute(text("""
            SELECT has_column_privilege(current_user,'finance.settlements',
                                        'voided_at','UPDATE')
        """)).scalar_one() is True
        assert db.execute(text("""
            SELECT has_column_privilege(current_user,'finance.settlements',
                                        'amount_minor','UPDATE')
        """)).scalar_one() is False
        assert db.execute(text("""
            SELECT has_column_privilege(current_user,'finance.loan_payments',
                                        'voided_at','UPDATE')
        """)).scalar_one() is True
        assert db.execute(text("""
            SELECT has_column_privilege(current_user,'finance.loan_payments',
                                        'amount_minor','UPDATE')
        """)).scalar_one() is False
