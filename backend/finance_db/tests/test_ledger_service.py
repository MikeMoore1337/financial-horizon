"""#67/#33: real SQL ledger service acceptance under PostgreSQL FORCE RLS.

All user/profile IDs and money are SYNTHETIC; never run against production.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4
import os

import pytest
from sqlalchemy import text

from backend.finance_db.db import create_finance_engine, finance_transaction
from backend.finance_db.ledger_service import (
    FinanceCommandError, VerifiedFinanceScope, ensure_verified_profile,
    get_account_snapshot, submit_account_command,
)


@pytest.fixture
def context():
    if os.environ.get("FH_FINANCE_CI_ALLOW_BOOTSTRAP") != "yes":
        pytest.skip("Requires the isolated CI PostgreSQL fixture")
    engine = create_finance_engine()
    scope = VerifiedFinanceScope(user_id=uuid4().hex, profile_id=uuid4())
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as s:
        s.execute(text("INSERT INTO finance_profiles (id,owner_user_id) VALUES (:p,:u)"),
                  {"p": scope.profile_id, "u": scope.user_id})
    yield engine, scope
    engine.dispose()


def make_command(revision, action, payload, versions=None, mid=None):
    return {
        "schema_version": 1,
        "client_mutation_id": str(mid or uuid4()),
        "base_revision": revision,
        "action": action,
        "expected_entity_revisions": versions or {},
        "payload": payload,
    }


def call(engine, scope, cmd, etag, *, internal=True):
    return submit_account_command(
        engine, scope=scope, command=cmd, if_match=etag,
        idempotency_key=cmd["client_mutation_id"],
        allow_internal=internal,
    )


def add_account(engine, scope, *, opening=0, name="Синтетический счёт", kind="bank"):
    snapshot = get_account_snapshot(engine, scope=scope)
    aid = str(uuid4())
    cmd = make_command(snapshot.body["revision"], "account.create", {
        "id": aid, "name": name, "kind": kind,
        "currency": "RUB", "opening_minor": opening,
    })
    reply = call(engine, scope, cmd, snapshot.etag)
    assert reply.status == 201
    assert reply.body["changes"][0]["entity_id"] == aid
    return aid, reply


def expected(snapshot, *ids):
    versions = {e["id"]: e["entity_revision"] for e in snapshot.body["entities"]}
    return {x: versions[x] for x in ids}


def ledger_counts(engine, scope):
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as s:
        return (
            s.execute(text("SELECT count(*) FROM ledger_transactions")).scalar_one(),
            s.execute(text("SELECT count(*) FROM ledger_postings")).scalar_one(),
            s.execute(text("SELECT count(*) FROM command_receipts")).scalar_one(),
            s.execute(text("SELECT count(*) FROM change_log")).scalar_one(),
        )


def test_account_create_reads_exact_opening_and_scoped_snapshot(context):
    engine, scope = context
    first = get_account_snapshot(engine, scope=scope)
    assert first.body["revision"] == 0
    assert first.body["entities"] == []
    aid, result = add_account(engine, scope, opening=-4550, kind="cash")
    assert result.body["revision"] == 1
    state = get_account_snapshot(engine, scope=scope)
    assert state.etag != first.etag
    account, = state.body["entities"]
    assert account["id"] == aid
    assert account["data"]["opening_minor"] == -4550
    assert account["data"]["balance_minor"] == -4550
    assert account["data"]["type"] == "cash"
    assert account["data"]["currency"] == "RUB"
    assert ledger_counts(engine, scope) == (0, 0, 1, 1)


def test_transfer_is_exactly_two_postings_and_conserves_total_assets(context):
    engine, scope = context
    from_id, _ = add_account(engine, scope, opening=25_000)
    to_id, _ = add_account(engine, scope, opening=-1_000, name="Кошелёк")
    before = get_account_snapshot(engine, scope=scope)
    cmd = make_command(before.body["revision"], "account.transfer", {
        "from_account_id": from_id, "to_account_id": to_id,
        "amount_minor": 9000, "occurred_on": "2026-11-08",
    }, expected(before, from_id, to_id))
    result = call(engine, scope, cmd, before.etag, internal=False)
    assert result.status == 201
    assert result.body["changes"][0]["kind"] == "ledger_posted"
    after = get_account_snapshot(engine, scope=scope)
    accounts = {a["id"]: a["data"]["balance_minor"] for a in after.body["entities"]}
    assert accounts == {from_id: 16_000, to_id: 8_000}
    assert sum(accounts.values()) == 24_000
    assert ledger_counts(engine, scope) == (1, 2, 3, 3)
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as s:
        amounts = sorted(s.execute(text("SELECT signed_minor FROM ledger_postings")).scalars().all())
        assert amounts == [-9000, 9000]
        assert s.execute(text("SELECT kind FROM ledger_transactions")).scalar_one() == "transfer"


def test_receipt_replay_precedes_stale_etag_and_different_command_is_conflict(context):
    engine, scope = context
    a, _ = add_account(engine, scope, opening=1000)
    b, _ = add_account(engine, scope)
    old = get_account_snapshot(engine, scope=scope)
    cmd = make_command(old.body["revision"], "account.transfer", {
        "from_account_id": a, "to_account_id": b,
        "amount_minor": 200, "occurred_on": "2026-11-08",
    }, expected(old, a, b))
    committed = call(engine, scope, cmd, old.etag, internal=False)
    replay = call(engine, scope, cmd, old.etag, internal=False)
    assert committed.status == 201 and replay.status == 200
    assert replay.body["replayed"] is True
    assert replay.body["revision"] == committed.body["revision"]
    assert replay.etag == committed.etag
    assert ledger_counts(engine, scope) == (1, 2, 3, 3)
    corrupt = {**cmd, "payload": {**cmd["payload"], "amount_minor": 300}}
    with pytest.raises(FinanceCommandError) as exc:
        call(engine, scope, corrupt, old.etag, internal=False)
    assert exc.value.code == "idempotency_key_reuse"


def test_stale_revision_and_invalid_transfer_roll_back_without_receipts(context):
    engine, scope = context
    a, _ = add_account(engine, scope, opening=300)
    b, _ = add_account(engine, scope)
    current = get_account_snapshot(engine, scope=scope)
    cmd = make_command(current.body["revision"], "account.transfer", {
        "from_account_id": a, "to_account_id": b,
        "amount_minor": 100, "occurred_on": "2026-11-08",
    }, expected(current, a, b))
    for prior_etag, body, code in [
        ('"stale-etag"', cmd, "stale_revision"),
        (current.etag, {**cmd, "base_revision": current.body["revision"] - 1},
         "semantic_conflict"),
        (current.etag, {**cmd, "payload": {**cmd["payload"], "amount_minor": 0}},
         "invalid_command"),
    ]:
        with pytest.raises(FinanceCommandError) as exc:
            call(engine, scope, body, prior_etag, internal=False)
        assert exc.value.code == code
    assert get_account_snapshot(engine, scope=scope).body["revision"] == current.body["revision"]
    assert ledger_counts(engine, scope) == (0, 0, 2, 2)


def test_archiving_and_restoring_preserve_existing_postings(context):
    engine, scope = context
    a, _ = add_account(engine, scope, opening=20_000)
    b, _ = add_account(engine, scope, opening=0)
    current = get_account_snapshot(engine, scope=scope)
    cmd = make_command(current.body["revision"], "account.transfer", {
        "from_account_id": a, "to_account_id": b,
        "amount_minor": 500, "occurred_on": "2026-11-08",
    }, expected(current, a, b))
    call(engine, scope, cmd, current.etag, internal=False)
    current = get_account_snapshot(engine, scope=scope)
    archive = make_command(current.body["revision"], "account.archive",
                           {"account_id": a}, expected(current, a))
    call(engine, scope, archive, current.etag)
    frozen = get_account_snapshot(engine, scope=scope)
    assert next(x for x in frozen.body["entities"] if x["id"] == a)["data"]["archived_at"]
    no_transfer = make_command(frozen.body["revision"], "account.transfer", {
        "from_account_id": a, "to_account_id": b, "amount_minor": 300,
        "occurred_on": "2026-11-08",
    }, expected(frozen, a, b))
    with pytest.raises(FinanceCommandError) as exc:
        call(engine, scope, no_transfer, frozen.etag, internal=False)
    assert exc.value.code == "semantic_conflict"
    undo = make_command(frozen.body["revision"], "account.unarchive",
                        {"account_id": a}, expected(frozen, a))
    call(engine, scope, undo, frozen.etag)
    restored = get_account_snapshot(engine, scope=scope)
    balances = {x["id"]: x["data"]["balance_minor"] for x in restored.body["entities"]}
    assert balances == {a: 19_500, b: 500}
    assert ledger_counts(engine, scope)[0:2] == (1, 2)


def test_reversal_is_append_only_and_cannot_reverse_a_second_time(context):
    engine, scope = context
    a, _ = add_account(engine, scope, opening=10_000)
    b, _ = add_account(engine, scope, opening=100)
    old = get_account_snapshot(engine, scope=scope)
    transfer = make_command(old.body["revision"], "account.transfer", {
        "from_account_id": a, "to_account_id": b,
        "amount_minor": 1200, "occurred_on": "2026-11-08",
    }, expected(old, a, b))
    committed = call(engine, scope, transfer, old.etag, internal=False)
    txid = committed.body["changes"][0]["entity_id"]
    state = get_account_snapshot(engine, scope=scope)
    rev = make_command(state.body["revision"], "transaction.reverse", {
        "transaction_id": txid, "reason": "Возврат перевода",
    }, {**expected(state, a, b), txid: 1})
    result = call(engine, scope, rev, state.etag, internal=False)
    assert result.status == 201
    balances = {x["id"]: x["data"]["balance_minor"]
                for x in get_account_snapshot(engine, scope=scope).body["entities"]}
    assert balances == {a: 10_000, b: 100}
    assert ledger_counts(engine, scope)[0:2] == (2, 4)
    with finance_transaction(engine, verified_user_id=scope.user_id, profile_id=scope.profile_id) as s:
        original_revision = s.execute(text("""
            SELECT entity_revision FROM ledger_transactions WHERE id=:id
        """), {"id": txid}).scalar_one()
        assert original_revision == 1
    latest = get_account_snapshot(engine, scope=scope)
    duplicate = make_command(latest.body["revision"], "transaction.reverse", {
        "transaction_id": txid, "reason": "Повторная отмена",
    }, {**expected(latest, a, b), txid: 1})
    with pytest.raises(FinanceCommandError) as exc:
        call(engine, scope, duplicate, latest.etag, internal=False)
    assert exc.value.code == "semantic_conflict"


def test_cross_profile_financial_scope_cannot_read_or_post(context):
    engine, owner = context
    a, _ = add_account(engine, owner, opening=98_000)
    alien = VerifiedFinanceScope(uuid4().hex, owner.profile_id)
    with pytest.raises(FinanceCommandError) as exc:
        get_account_snapshot(engine, scope=alien)
    assert exc.value.code == "forbidden"
    snap = get_account_snapshot(engine, scope=owner)
    other = make_command(snap.body["revision"], "account.create", {
        "id": str(uuid4()), "name": "Чужой", "kind": "cash",
        "currency": "RUB", "opening_minor": 0,
    })
    with pytest.raises(FinanceCommandError) as exc:
        call(engine, alien, other, snap.etag)
    assert exc.value.code == "forbidden"
    assert get_account_snapshot(engine, scope=owner).body["entities"][0]["id"] == a


def test_two_concurrent_writers_get_one_commit_and_one_stale_error(context):
    engine, scope = context
    a, _ = add_account(engine, scope, opening=10_000)
    b, _ = add_account(engine, scope)
    snapshot = get_account_snapshot(engine, scope=scope)
    cmds = [make_command(snapshot.body["revision"], "account.transfer", {
        "from_account_id": a, "to_account_id": b,
        "amount_minor": 1000, "occurred_on": "2026-11-08",
    }, expected(snapshot, a, b)) for _ in range(2)]

    def write(c):
        try:
            return call(engine, scope, c, snapshot.etag, internal=False).status
        except FinanceCommandError as exc:
            return exc.code

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(write, cmds))
    assert sorted(results, key=str) == sorted([201, "stale_revision"], key=str)
    state = get_account_snapshot(engine, scope=scope)
    balances = {e["id"]: e["data"]["balance_minor"] for e in state.body["entities"]}
    assert balances == {a: 9000, b: 1000}
    assert ledger_counts(engine, scope)[:2] == (1, 2)


def test_rejects_unpublished_account_actions_in_public_v1(context):
    engine, scope = context
    snap = get_account_snapshot(engine, scope=scope)
    cmd = make_command(snap.body["revision"], "account.create", {
        "id": str(uuid4()), "name": "Not public", "kind": "bank",
        "currency": "RUB", "opening_minor": 0,
    })
    with pytest.raises(FinanceCommandError) as exc:
        call(engine, scope, cmd, snap.etag, internal=False)
    assert exc.value.code == "invalid_command"
    assert get_account_snapshot(engine, scope=scope).body["revision"] == 0


def test_profile_provisioning_is_stable_scoped_and_idempotent(context):
    engine, _ = context
    user_id = uuid4().hex
    namespace = uuid4()  # Synthetic server-side static namespace.
    scope = ensure_verified_profile(
        engine, verified_user_id=user_id, server_namespace=namespace,
    )
    again = ensure_verified_profile(
        engine, verified_user_id=user_id, server_namespace=namespace,
    )
    assert scope == again
    assert isinstance(scope.profile_id, type(namespace))
    assert get_account_snapshot(engine, scope=scope).body["revision"] == 0
    with finance_transaction(engine, verified_user_id=user_id, profile_id=scope.profile_id) as s:
        assert s.execute(text("""
            SELECT count(*) FROM finance_profiles WHERE id=:id
        """), {"id": scope.profile_id}).scalar_one() == 1

    stranger = ensure_verified_profile(
        engine, verified_user_id=uuid4().hex, server_namespace=namespace,
    )
    assert stranger.profile_id != scope.profile_id
    with pytest.raises(FinanceCommandError) as exc:
        get_account_snapshot(engine, scope=VerifiedFinanceScope(stranger.user_id, scope.profile_id))
    assert exc.value.code == "forbidden"
    with pytest.raises(ValueError):
        ensure_verified_profile(engine, verified_user_id="made-up-id", server_namespace=namespace)


def test_untrusted_account_kind_and_missing_opening_never_raise_unhandled_type_errors(context):
    engine, scope = context
    snap = get_account_snapshot(engine, scope=scope)
    for invalid in [
        {"id": str(uuid4()), "name": "X", "kind": {"name": "bank"},
         "currency": "RUB", "opening_minor": 0},
        {"id": str(uuid4()), "name": "X", "kind": "bank", "currency": "RUB"},
        {"id": str(uuid4()), "name": "X", "kind": "bank",
         "currency": "RUB", "opening_minor": True},
    ]:
        cmd = make_command(snap.body["revision"], "account.create", invalid)
        with pytest.raises(FinanceCommandError) as exc:
            call(engine, scope, cmd, snap.etag)
        assert exc.value.code == "invalid_command"
    assert get_account_snapshot(engine, scope=scope).body["revision"] == 0
    assert ledger_counts(engine, scope) == (0, 0, 0, 0)


def test_settlement_payment_posts_exact_signed_income_and_expense_once(context):
    engine, scope = context
    a, _ = add_account(engine, scope, opening=10_000)
    for direction, amount in (("income", 2000), ("expense", -700)):
        obligation, payment_fact, txid = uuid4(), uuid4(), uuid4()
        with finance_transaction(engine, verified_user_id=scope.user_id,
                                 profile_id=scope.profile_id) as session:
            session.execute(text("""
                INSERT INTO obligations
                  (profile_id,id,title,direction,amount_minor,starts_on)
                VALUES (:p,:id,'Synthetic bill',:direction,5000,'2026-11-08')
            """), {"p": scope.profile_id, "id": obligation, "direction": direction})
        snap = get_account_snapshot(engine, scope=scope)
        revision = snap.body["entities"][0]["entity_revision"]
        cmd = make_command(snap.body["revision"], "settlement.payment.record", {
            "transaction_id": str(txid), "fact_id": str(payment_fact),
            "account_id": a, "obligation_id": str(obligation),
            "amount_minor": abs(amount), "paid_on": "2026-11-08",
            "occurrence_on": "2026-11-08",
        }, {a: revision, str(obligation): 1})
        reply = call(engine, scope, cmd, snap.etag)
        assert reply.status == 201 and len(reply.body["changes"]) == 2
        assert reply.body["changes"][0]["kind"] == "ledger_posted"
        assert reply.body["changes"][0]["payload"]["signed_minor"] == amount
        assert reply.body["changes"][1]["kind"] == "upsert"
        assert reply.body["changes"][1]["ordinal"] == 1
        assert reply.body["revision"] == snap.body["revision"] + 1
        repeated = call(engine, scope, cmd, snap.etag)
        assert repeated.status == 200 and repeated.body["replayed"] is True
        with finance_transaction(engine, verified_user_id=scope.user_id,
                                 profile_id=scope.profile_id) as session:
            posting = session.execute(text("""
                SELECT signed_minor FROM ledger_postings
                WHERE transaction_id=:id
            """), {"id": txid}).scalar_one()
            assert posting == amount
            assert session.execute(text("""
                SELECT count(*) FROM ledger_payment_links
                WHERE settlement_id=:id
            """), {"id": payment_fact}).scalar_one() == 1
        page = get_finance_delta(
            engine, scope=scope, since_revision=snap.body["revision"], page_revisions=1
        )
        assert page.body["next_since_revision"] == reply.body["revision"]
        assert len(page.body["changes"]) == 2
        assert [c["ordinal"] for c in page.body["changes"]] == [0, 1]
    state = get_account_snapshot(engine, scope=scope)
    assert state.body["entities"][0]["data"]["balance_minor"] == 11_300


def test_loan_payment_debits_cash_atomically_and_blocks_invalid_strategy(context):
    engine, scope = context
    a, _ = add_account(engine, scope, opening=15_000)
    loan_id, payment_id, txid = uuid4(), uuid4(), uuid4()
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as session:
        session.execute(text("""
            INSERT INTO loans
              (profile_id,id,title,opening_minor,payment_minor,apr_basis_points,
               term_months,due_day,as_of_date)
            VALUES (:p,:id,'Synthetic loan',50000,5000,1200,24,15,'2026-11-08')
        """), {"p": scope.profile_id, "id": loan_id})
    before = get_account_snapshot(engine, scope=scope)
    cmd = make_command(before.body["revision"], "loan.payment.record", {
        "transaction_id": str(txid), "fact_id": str(payment_id),
        "account_id": a, "loan_id": str(loan_id), "amount_minor": 5000,
        "paid_on": "2026-11-08", "strategy": "term",
    }, {a: before.body["entities"][0]["entity_revision"], str(loan_id): 1})
    posted = call(engine, scope, cmd, before.etag)
    assert posted.status == 201 and len(posted.body["changes"]) == 2
    assert posted.body["changes"][0]["payload"]["signed_minor"] == -5000
    assert get_account_snapshot(engine, scope=scope).body["entities"][0]["data"]["balance_minor"] == 10_000
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as session:
        assert session.execute(text("""
            SELECT amount_minor FROM loan_payments WHERE id=:p
        """), {"p": payment_id}).scalar_one() == 5000
        assert session.execute(text("""
            SELECT loan_payment_id FROM ledger_payment_links WHERE transaction_id=:tx
        """), {"tx": txid}).scalar_one() == payment_id

    fresh = get_account_snapshot(engine, scope=scope)
    bad = make_command(fresh.body["revision"], "loan.payment.record", {
        **cmd["payload"], "transaction_id": str(uuid4()), "fact_id": str(uuid4()),
        "strategy": "malicious",
    }, {a: fresh.body["entities"][0]["entity_revision"], str(loan_id): 1})
    with pytest.raises(FinanceCommandError) as exc:
        call(engine, scope, bad, fresh.etag)
    assert exc.value.code == "invalid_command"
    assert get_account_snapshot(engine, scope=scope).body["revision"] == fresh.body["revision"]


def test_linked_payment_commands_are_off_in_public_v1(context):
    engine, scope = context
    snap = get_account_snapshot(engine, scope=scope)
    for action in ["settlement.payment.record", "loan.payment.record"]:
        cmd = make_command(snap.body["revision"], action, {
            "transaction_id": str(uuid4()), "fact_id": str(uuid4()),
            "account_id": str(uuid4()), "amount_minor": 100,
            "paid_on": "2026-11-08", "loan_id": str(uuid4()), "strategy": "term",
        })
        with pytest.raises(FinanceCommandError) as exc:
            call(engine, scope, cmd, snap.etag, internal=False)
        assert exc.value.code == "invalid_command"
