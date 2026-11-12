"""#67: full authorized snapshot and revision-aligned change feed on real PostgreSQL."""
from __future__ import annotations

from uuid import uuid4
import os

import pytest
from sqlalchemy import text

from backend.finance_db.db import create_finance_engine, finance_transaction
from backend.finance_db.ledger_service import (
    FinanceCommandError, VerifiedFinanceScope, ensure_verified_profile,
    get_account_snapshot, submit_account_command,
)
from backend.finance_db.snapshot import get_finance_snapshot, get_finance_delta


@pytest.fixture
def scoped():
    if os.environ.get("FH_FINANCE_CI_ALLOW_BOOTSTRAP") != "yes":
        pytest.skip("Only synthetic disposable PostgreSQL CI is authorized")
    engine = create_finance_engine()
    user = uuid4().hex
    scope = ensure_verified_profile(engine, verified_user_id=user, server_namespace=uuid4())
    yield engine, scope
    engine.dispose()


def do(engine, scope, action, payload, versions=None):
    snap = get_account_snapshot(engine, scope=scope)
    mutation = str(uuid4())
    command = {
        "schema_version": 1, "client_mutation_id": mutation,
        "base_revision": snap.body["revision"],
        "expected_entity_revisions": versions or {},
        "action": action, "payload": payload,
    }
    return submit_account_command(
        engine, scope=scope, command=command,
        if_match=snap.etag, idempotency_key=mutation,
        allow_internal=True,
    )


def test_complete_snapshot_contains_accounts_and_immutable_signed_transactions(scoped):
    engine, scope = scoped
    a, b = str(uuid4()), str(uuid4())
    do(engine, scope, "account.create", {
        "id": a, "name": "Main", "kind": "bank",
        "currency": "RUB", "opening_minor": 10_000,
    })
    do(engine, scope, "account.create", {
        "id": b, "name": "Cash", "kind": "cash",
        "currency": "RUB", "opening_minor": -500,
    })
    snapshot = get_finance_snapshot(engine, scope=scope)
    versions = {x["id"]: x["entity_revision"] for x in snapshot.body["entities"]}
    reply = do(engine, scope, "account.transfer", {
        "from_account_id": a, "to_account_id": b,
        "amount_minor": 700, "occurred_on": "2026-11-08",
    }, {a: versions[a], b: versions[b]})
    txid = reply.body["changes"][0]["entity_id"]
    state = get_finance_snapshot(engine, scope=scope)
    assert state.body["schema_version"] == 1
    assert state.body["revision"] == 3
    accounts = {e["id"]: e for e in state.body["entities"] if e["kind"] == "account"}
    assert accounts[a]["data"]["balance_minor"] == 9_300
    assert accounts[b]["data"]["balance_minor"] == 200
    assert accounts[a]["data"]["reserved_minor"] == 0
    assert accounts[a]["data"]["available_minor"] == 9_300
    assert sum(x["data"]["balance_minor"] for x in accounts.values()) == 9_500
    txs = [e for e in state.body["entities"] if e["kind"] == "transaction"]
    assert len(txs) == 1 and txs[0]["id"] == txid
    postings = sorted(x["signed_minor"] for x in txs[0]["data"]["postings"])
    assert postings == [-700, 700]
    assert txs[0]["data"]["kind"] == "transfer"
    assert state.etag == get_account_snapshot(engine, scope=scope).etag


def test_complete_snapshot_preserves_plan_and_reserve_as_non_cash_entities(scoped):
    engine, scope = scoped
    with finance_transaction(engine, verified_user_id=scope.user_id, profile_id=scope.profile_id) as s:
        obligation, reserve, loan = uuid4(), uuid4(), uuid4()
        s.execute(text("""
            INSERT INTO obligations (profile_id,id,title,direction,amount_minor,starts_on)
            VALUES (:p,:id,'Synthetic income','income',2500,current_date)
        """), {"p": scope.profile_id, "id": obligation})
        s.execute(text("""
            INSERT INTO reserves (profile_id,id,title,target_minor)
            VALUES (:p,:id,'Synthetic reserve',10000)
        """), {"p": scope.profile_id, "id": reserve})
        s.execute(text("""
            INSERT INTO loans (profile_id,id,title,opening_minor,payment_minor,
                               apr_basis_points,term_months,due_day,as_of_date)
            VALUES (:p,:id,'Synthetic loan',100000,5000,1200,24,15,current_date)
        """), {"p": scope.profile_id, "id": loan})
    state = get_finance_snapshot(engine, scope=scope)
    entities = {e["kind"]: e for e in state.body["entities"]}
    assert set(entities) == {"obligation", "reserve", "loan"}
    assert entities["obligation"]["data"]["amount_minor"] == 2500
    assert entities["obligation"]["data"]["direction"] == "income"
    assert entities["reserve"]["data"]["target_minor"] == 10000
    assert entities["loan"]["data"]["opening_minor"] == 100000
    assert state.body["revision"] == 0  # Plans never create ledger postings.


def test_revision_feed_never_splits_revision_and_preserves_original_entity_version(scoped):
    engine, scope = scoped
    a = str(uuid4())
    do(engine, scope, "account.create", {
        "id": a, "name": "First", "kind": "bank",
        "currency": "RUB", "opening_minor": 0,
    })
    first = get_finance_snapshot(engine, scope=scope)
    do(engine, scope, "account.update", {
        "account_id": a, "name": "Renamed", "kind": "cash",
    }, {a: first.body["entities"][0]["entity_revision"]})
    state = get_finance_snapshot(engine, scope=scope)
    assert state.body["revision"] == 2
    page = get_finance_delta(engine, scope=scope, since_revision=0, page_revisions=1)
    assert page.body["has_more"] is True
    assert page.body["next_since_revision"] == 1
    assert page.body["changes"][0]["entity_revision"] == 1
    assert page.body["changes"][0]["payload"]["opening_minor"] == 0
    next_page = get_finance_delta(engine, scope=scope, since_revision=1, page_revisions=1)
    assert next_page.body["has_more"] is False
    assert next_page.body["next_since_revision"] == 2
    assert next_page.body["changes"][0]["entity_revision"] == 2
    assert next_page.body["changes"][0]["payload"]["name"] == "Renamed"
    assert "_entity_revision" not in next_page.body["changes"][0]["payload"]


def test_delta_requires_snapshot_after_compaction_and_rejects_future_revision(scoped):
    engine, scope = scoped
    account_id = str(uuid4())
    do(engine, scope, "account.create", {
        "id": account_id, "name": "A", "kind": "bank",
        "currency": "RUB", "opening_minor": 0,
    })
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as s:
        s.execute(text("""
            UPDATE finance_profiles SET min_available_revision=1 WHERE id=:p
        """), {"p": scope.profile_id})
    with pytest.raises(FinanceCommandError) as exc:
        get_finance_delta(engine, scope=scope, since_revision=0)
    assert exc.value.code == "snapshot_required"
    with pytest.raises(FinanceCommandError) as exc:
        get_finance_delta(engine, scope=scope, since_revision=9)
    assert exc.value.code == "invalid_command"
    assert get_finance_delta(engine, scope=scope, since_revision=1).body["changes"] == []


def test_snapshot_and_delta_fail_closed_for_foreign_or_revoked_profile_scope(scoped):
    engine, scope = scoped
    foreign = VerifiedFinanceScope(uuid4().hex, scope.profile_id)
    for fn in [
        lambda: get_finance_snapshot(engine, scope=foreign),
        lambda: get_finance_delta(engine, scope=foreign, since_revision=0),
    ]:
        with pytest.raises(FinanceCommandError) as exc:
            fn()
        assert exc.value.code == "forbidden"


def test_deltas_reconstruct_exact_transfer_and_reversal_snapshot(scoped):
    engine, scope = scoped
    a, b = str(uuid4()), str(uuid4())
    do(engine, scope, "account.create", {
        "id": a, "name": "Main", "kind": "bank",
        "currency": "RUB", "opening_minor": 10_000,
    })
    do(engine, scope, "account.create", {
        "id": b, "name": "Cash", "kind": "cash",
        "currency": "RUB", "opening_minor": 250,
    })
    before = get_finance_snapshot(engine, scope=scope)
    replica = {e["id"]: e for e in before.body["entities"]}
    versions = {x["id"]: x["entity_revision"] for x in before.body["entities"]}
    posted = do(engine, scope, "account.transfer", {
        "from_account_id": a, "to_account_id": b,
        "amount_minor": 3000, "occurred_on": "2026-11-07",
    }, {a: versions[a], b: versions[b]})
    txid = posted.body["changes"][0]["entity_id"]

    def consume_from(revision):
        feed = get_finance_delta(engine, scope=scope, since_revision=revision)
        for change in feed.body["changes"]:
            effect = change["payload"]
            if change["kind"] == "ledger_posted":
                tx = effect["entity"]
                assert tx["kind"] == "transaction"
                assert tx["data"]["occurred_on"]
                assert tx["data"]["posted_at"]
                assert tx["data"]["postings"]
                replica[tx["id"]] = tx
                for account in effect["accounts"]:
                    assert account["kind"] == "account"
                    replica[account["id"]] = account
        return feed

    feed = consume_from(before.body["revision"])
    assert len(feed.body["changes"]) == 1
    current = get_finance_snapshot(engine, scope=scope)
    assert replica == {e["id"]: e for e in current.body["entities"]}
    assert replica[txid]["data"]["occurred_on"] == "2026-11-07"
    assert sorted(x["signed_minor"] for x in replica[txid]["data"]["postings"]) == [-3000, 3000]
    assert {replica[a]["data"]["balance_minor"], replica[b]["data"]["balance_minor"]} == {7000, 3250}

    versions = {x["id"]: x["entity_revision"] for x in current.body["entities"]}
    compensated = do(engine, scope, "transaction.reverse", {
        "transaction_id": txid, "reason": "Отмена перевода",
    }, {a: versions[a], b: versions[b], txid: versions[txid]})
    reversal = compensated.body["changes"][0]["entity_id"]
    second = consume_from(current.body["revision"])
    assert len(second.body["changes"]) == 1
    final = get_finance_snapshot(engine, scope=scope)
    assert replica == {e["id"]: e for e in final.body["entities"]}
    assert replica[reversal]["data"]["reversed_transaction_id"] == txid
    assert sorted(x["signed_minor"] for x in replica[reversal]["data"]["postings"]) == [-3000, 3000]
    assert replica[a]["data"]["balance_minor"] == 10_000
    assert replica[b]["data"]["balance_minor"] == 250


def test_snapshot_cursor_paginates_all_entity_kinds_and_rejects_revision_race(scoped):
    engine, scope = scoped
    a, b = str(uuid4()), str(uuid4())
    do(engine, scope, "account.create", {
        "id": a, "name": "A", "kind": "bank", "currency": "RUB", "opening_minor": 10_000,
    })
    do(engine, scope, "account.create", {
        "id": b, "name": "B", "kind": "cash", "currency": "RUB", "opening_minor": 0,
    })
    before = get_finance_snapshot(engine, scope=scope, limit_entities=1)
    assert before.status == 206 and before.body["next_cursor"]
    with pytest.raises(FinanceCommandError) as err:
        get_finance_snapshot(engine, scope=scope, cursor="not-a-valid-cursor")
    assert err.value.status == 422

    state = get_finance_snapshot(engine, scope=scope)
    versions = {e["id"]: e["entity_revision"] for e in state.body["entities"]}
    do(engine, scope, "account.transfer", {
        "from_account_id": a, "to_account_id": b,
        "amount_minor": 500, "occurred_on": "2026-11-08",
    }, {a: versions[a], b: versions[b]})
    with pytest.raises(FinanceCommandError) as err:
        get_finance_snapshot(engine, scope=scope, cursor=before.body["next_cursor"])
    assert err.value.status == 412 and err.value.code == "stale_revision"

    cursor = None
    received = []
    for _ in range(10):
        part = get_finance_snapshot(engine, scope=scope, cursor=cursor, limit_entities=1)
        received += part.body["entities"]
        cursor = part.body.get("next_cursor")
        if cursor is None:
            assert part.status == 200
            break
        assert part.status == 206
    else:
        pytest.fail("snapshot pagination did not terminate")
    complete = get_finance_snapshot(engine, scope=scope, limit_entities=20)
    assert len(received) == len(complete.body["entities"]) == 3
    assert {e["id"]: e for e in received} == {
        e["id"]: e for e in complete.body["entities"]
    }


def test_snapshot_handles_more_than_5000_append_only_transactions(scoped):
    engine, scope = scoped
    aid = str(uuid4())
    do(engine, scope, "account.create", {
        "id": aid, "name": "Many small movements", "kind": "bank",
        "currency": "RUB", "opening_minor": 0,
    })
    # Synthetic bulk data only, bounded disposable PostgreSQL role. The real
    # finance API must create a profile revision/receipt with every operation.
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as session:
        session.execute(text("""
            INSERT INTO ledger_transactions
              (profile_id,id,kind,occurred_on,actor_user_id)
            SELECT :p,gen_random_uuid(),'income',current_date,:actor
            FROM generate_series(1,5001)
        """), {"p": scope.profile_id, "actor": scope.user_id})
        session.execute(text("""
            INSERT INTO ledger_postings
              (profile_id,transaction_id,account_id,signed_minor)
            SELECT profile_id,id,:a,1 FROM ledger_transactions WHERE profile_id=:p
        """), {"a": aid, "p": scope.profile_id})

    cursor = None
    received = {}
    pages = 0
    while pages < 12:
        page = get_finance_snapshot(engine, scope=scope,
                                    cursor=cursor, limit_entities=1_000)
        pages += 1
        for entity in page.body["entities"]:
            assert entity["id"] not in received
            received[entity["id"]] = entity
        cursor = page.body.get("next_cursor")
        if cursor is None:
            assert page.status == 200
            break
        assert page.status == 206
    else:
        pytest.fail("Large ledger could not be reconstructed via snapshot pages")
    assert len(received) == 5002
    assert sum(e["kind"] == "transaction" for e in received.values()) == 5001
    assert received[aid]["data"]["balance_minor"] == 5001
    assert pages > 5
