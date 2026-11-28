"""#37 authoritative database acceptance; never run on an owner database."""
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4
import os

import pytest
from sqlalchemy import text

from backend.finance_db.db import create_finance_engine, finance_transaction
from backend.finance_db.ledger_service import (
    FinanceCommandError, ensure_verified_profile, submit_account_command,
    cancel_uncommitted_account_command,
)
from backend.finance_db.snapshot import get_finance_snapshot, get_finance_delta


@pytest.fixture
def world():
    if os.environ.get("FH_FINANCE_CI_ALLOW_BOOTSTRAP") != "yes":
        pytest.skip("Disposable synthetic PostgreSQL only")
    engine = create_finance_engine()
    namespace = uuid4()
    a, b = [ensure_verified_profile(engine, verified_user_id=uuid4().hex,
                                    server_namespace=namespace) for _ in range(2)]
    yield engine, a, b
    engine.dispose()


def snap(engine, scope):
    return get_finance_snapshot(engine, scope=scope)


def entities(engine, scope, kind):
    return {e["id"]: e for e in snap(engine, scope).body["entities"] if e["kind"] == kind}


def cmd(engine, scope, action, payload, ids=(), mutation=None):
    s = snap(engine, scope)
    current = {e["id"]: e["entity_revision"] for e in s.body["entities"]}
    return {"schema_version": 2, "client_mutation_id": mutation or str(uuid4()),
            "base_revision": s.body["revision"], "action": action, "payload": payload,
            "expected_entity_revisions": {i: current[i] for i in ids}}, s.etag


def send(engine, scope, body, tag):
    goal = body["action"] == "goal.append"
    return submit_account_command(engine, scope=scope, command=body, if_match=tag,
        idempotency_key=body["client_mutation_id"], allow_goal_candidate=goal, allow_account_v2=not goal)


def account(engine, scope, opening=100_000):
    aid = str(uuid4())
    send(engine, scope, *cmd(engine, scope, "account.create", {
        "id": aid, "name": "Synthetic", "kind": "cash", "currency": "RUB", "opening_minor": opening}))
    return aid


def goal_cmd(engine, scope, gid, aid, kind, *, other=None, extra_ids=(), **fields):
    mutation = str(uuid4())
    event = {"id": mutation, "type": kind, "on": "2026-01-01", **fields}
    payload = {"goal_id": gid, "account_id": aid, "event": event}
    if other is not None:
        payload["counterparty_account_id"] = other
    ids = [aid] + ([] if kind == "create" else [gid]) + ([other] if other else []) + list(extra_ids)
    return cmd(engine, scope, "goal.append", payload, ids, mutation)


def create_goal(engine, scope, aid, opening=0):
    gid = str(uuid4())
    request = goal_cmd(engine, scope, gid, aid, "create", title="Synthetic", category="other",
        targetCents=120_000, targetDate="2027-01-01", openingCents=opening,
        monthlyCents=None, plannedFunding="virtual")
    send(engine, scope, *request)
    return gid, request


def test_goal_atomic_transfer_expense_correction_and_receipt(world):
    e, a, _ = world
    src, dst = account(e, a), account(e, a, 0)
    gid, _ = create_goal(e, a, dst)
    funding = goal_cmd(e, a, gid, dst, "contribution", other=src, amountCents=40_000,
                       funding="account-transfer")
    first = send(e, a, *funding)
    assert send(e, a, *funding).body["replayed"] is True
    accounts = entities(e, a, "account")
    assert accounts[src]["data"]["balance_minor"] == 60_000
    assert accounts[dst]["data"]["balance_minor"] == 40_000
    assert accounts[dst]["data"]["reserved_minor"] == 40_000
    expense = goal_cmd(e, a, gid, dst, "use", amountCents=10_000, usage="expense")
    paid = send(e, a, *expense)
    assert len(entities(e, a, "transaction")) == 2
    accounts = entities(e, a, "account")
    assert accounts[dst]["data"]["balance_minor"] == accounts[dst]["data"]["reserved_minor"] == 30_000
    journal = entities(e, a, "goal")[gid]["data"]["event_log"]
    assert journal[-1]["ledgerMovementId"] == paid.body["changes"][1]["entity_id"]
    corrected = send(e, a, *goal_cmd(e, a, gid, dst, "void",
        eventId=expense[0]["client_mutation_id"], reason="Synthetic correction"))
    assert len(entities(e, a, "transaction")) == 3
    accounts = entities(e, a, "account")
    assert accounts[dst]["data"]["balance_minor"] == accounts[dst]["data"]["reserved_minor"] == 40_000
    assert entities(e, a, "goal")[gid]["data"]["saved_minor"] == 40_000
    delta = get_finance_delta(e, scope=a, since_revision=corrected.body["revision"] - 1)
    assert delta.body["changes"] == corrected.body["changes"]
    assert first.body["changes"][0]["payload"]["entity"]["kind"] == "goal"


def test_two_goals_compete_for_same_cash_and_scope(world):
    e, a, b = world
    aid = account(e, a)
    x, _ = create_goal(e, a, aid)
    y, _ = create_goal(e, a, aid)
    requests = [goal_cmd(e, a, gid, aid, "contribution", amountCents=70_000, funding="virtual")
                for gid in (x, y)]
    def run(req):
        try:
            return send(e, a, *req).status
        except FinanceCommandError as exc:
            return exc.status
    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(run, requests))
    assert sorted(statuses) == [201, 412]
    before = snap(e, a)
    losing = next(gid for gid, item in entities(e, a, "goal").items() if not item["data"]["saved_minor"])
    with pytest.raises(FinanceCommandError) as failure:
        send(e, a, *goal_cmd(e, a, losing, aid, "contribution", amountCents=70_000, funding="virtual"))
    assert failure.value.status == 409 and snap(e, a).etag == before.etag
    assert entities(e, b, "goal") == {}
    with finance_transaction(e, verified_user_id=b.user_id, profile_id=b.profile_id) as s:
        assert s.execute(text("SELECT count(*) FROM goal_events")).scalar_one() == 0
    with e.connect() as s:
        assert s.execute(text("SELECT count(*) FROM account_earmarks")).scalar_one() == 0


def test_old_debit_cannot_spend_goal_funds_and_cancel_is_fenced(world):
    e, a, _ = world
    aid = account(e, a)
    gid, _ = create_goal(e, a, aid, 80_000)
    bad = cmd(e, a, "transaction.record", {"id": str(uuid4()), "account_id": aid,
        "kind": "expense", "signed_minor": -30_000, "occurred_on": "2026-01-01"}, [aid])
    before = snap(e, a)
    with pytest.raises(FinanceCommandError) as failure:
        send(e, a, *bad)
    assert failure.value.status == 409 and snap(e, a).etag == before.etag
    request, tag = goal_cmd(e, a, gid, aid, "use", amountCents=20_000, usage="virtual-release")
    cancel_uncommitted_account_command(e, scope=a, command=request, if_match=tag,
        idempotency_key=request["client_mutation_id"], allow_goal_candidate=True)
    with pytest.raises(FinanceCommandError) as failure:
        send(e, a, request, tag)
    assert failure.value.code == "command_cancelled"
    assert entities(e, a, "goal")[gid]["data"]["saved_minor"] == 80_000


def test_no_client_ledger_reference_or_noninteger_money(world):
    e, a, _ = world
    aid = account(e, a)
    gid, _ = create_goal(e, a, aid)
    for fields in ({"amountCents": True}, {"amountCents": 1.5},
                   {"amountCents": 1, "ledgerMovementId": str(uuid4())}):
        request = goal_cmd(e, a, gid, aid, "contribution", funding="virtual", **fields)
        before = snap(e, a)
        with pytest.raises(FinanceCommandError):
            send(e, a, *request)
        assert snap(e, a).etag == before.etag


def test_mandatory_reserve_and_goal_share_one_balance(world):
    from backend.finance_db.tests.test_reserve_v2_candidate import reserve_input, submit

    engine, scope, _ = world
    aid = account(engine, scope, 10_000)
    gid, _ = create_goal(engine, scope, aid, 8_000)
    s = snap(engine, scope)
    obligation = {"schema_version": 1, "client_mutation_id": str(uuid4()),
        "base_revision": s.body["revision"], "action": "obligation.create",
        "expected_entity_revisions": {},
        "payload": {"title": "Synthetic", "direction": "expense",
                    "amount_minor": 9000, "starts_on": "2027-11-16",
                    "timezone": "UTC", "recurrence_unit": "year", "recurrence_every": 1}}
    created = submit_account_command(engine, scope=scope, command=obligation,
        if_match=s.etag, idempotency_key=obligation["client_mutation_id"], allow_internal=True)
    oid = created.body["changes"][0]["entity_id"]
    before = snap(engine, scope)
    with pytest.raises(FinanceCommandError) as failure:
        submit(engine, scope, "reserve.create", reserve_input(aid, oid, opening=3000), [aid, oid])
    assert failure.value.status == 409 and snap(engine, scope).etag == before.etag
    assert entities(engine, scope, "reserve") == {}
    submit(engine, scope, "reserve.create", reserve_input(aid, oid, opening=2000), [aid, oid])
    assert entities(engine, scope, "account")[aid]["data"]["reserved_minor"] == 10000
    with pytest.raises(FinanceCommandError) as failure:
        send(engine, scope, *goal_cmd(engine, scope, gid, aid, "contribution",
                                     amountCents=1, funding="virtual"))
    assert failure.value.status == 409
    assert entities(engine, scope, "account")[aid]["data"]["balance_minor"] == 10000
