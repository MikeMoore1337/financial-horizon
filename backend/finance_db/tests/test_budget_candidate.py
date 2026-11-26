"""#35 candidate acceptance on a real disposable PostgreSQL database."""
from uuid import uuid4
import os

import pytest
from sqlalchemy import text

from backend.finance_db.budget_service import get_budget_candidate_snapshot
from backend.finance_db.db import create_finance_engine, finance_transaction
from backend.finance_db.ledger_service import (
    FinanceCommandError, ensure_verified_profile, submit_account_command,
)
from backend.finance_db.snapshot import get_finance_delta, get_finance_snapshot


@pytest.fixture
def scoped():
    if os.environ.get("FH_FINANCE_CI_ALLOW_BOOTSTRAP") != "yes":
        pytest.skip("Only disposable synthetic PostgreSQL is authorized")
    engine = create_finance_engine()
    a = ensure_verified_profile(engine, verified_user_id=uuid4().hex, server_namespace=uuid4())
    b = ensure_verified_profile(engine, verified_user_id=uuid4().hex, server_namespace=uuid4())
    yield engine, a, b
    engine.dispose()


def cmd(engine, scope, action, payload, versions=None):
    snap = get_budget_candidate_snapshot(engine, scope=scope)
    return {
        "schema_version": 2, "client_mutation_id": str(uuid4()),
        "base_revision": snap.body["revision"], "expected_entity_revisions": versions or {},
        "action": action, "payload": payload,
    }, snap.etag


def submit(engine, scope, command, etag, *, budget=True):
    return submit_account_command(engine, scope=scope, command=command,
        if_match=etag, idempotency_key=command["client_mutation_id"],
        allow_budget_candidate=budget, allow_account_v2=not budget)


def act(engine, scope, action, payload, versions=None, *, budget=True):
    c, etag = cmd(engine, scope, action, payload, versions)
    return submit(engine, scope, c, etag, budget=budget)


def rule_payload(category=None, month="2026-01", amount=1_000_000, recurrence="monthly"):
    return {"id": str(uuid4()), "category_id": category, "from_month": month,
            "limit_minor": amount, "recurrence": recurrence}


def entities(engine, scope, kind):
    return {e["id"]: e for e in get_budget_candidate_snapshot(engine, scope=scope).body["entities"]
            if e["kind"] == kind}


def create_category(engine, scope, name="Еда"):
    id_ = str(uuid4())
    act(engine, scope, "budget.category.create", {"id": id_, "name": name})
    return id_


def create_account(engine, scope):
    aid = str(uuid4())
    act(engine, scope, "account.create", {"id": aid, "name": "Synthetic", "kind": "cash",
        "currency": "RUB", "opening_minor": 1_000_000}, budget=False)
    return aid


def expense(engine, scope, aid, kind="expense", amount=-150_000):
    # Existing account gateway increments entity_revision after posting.
    with finance_transaction(engine, verified_user_id=scope.user_id, profile_id=scope.profile_id) as s:
        version = s.execute(text("SELECT entity_revision FROM accounts WHERE id=:a"), {"a": aid}).scalar_one()
    txid = str(uuid4())
    act(engine, scope, "transaction.record", {"id": txid, "account_id": aid,
        "kind": kind, "occurred_on": "2026-01-10", "signed_minor": amount}, {aid: version}, budget=False)
    return txid


def test_budget_commands_are_unmounted_in_existing_v2_and_replay_uses_shared_receipt(scoped):
    engine, a, _ = scoped
    body, etag = cmd(engine, a, "budget.create", rule_payload())
    with pytest.raises(FinanceCommandError) as error:
        submit(engine, a, body, etag, budget=False)
    assert error.value.status == 422
    first = submit(engine, a, body, etag)
    replay = submit(engine, a, body, etag)
    assert first.status == 201 and replay.status == 200
    assert replay.body["replayed"] is True
    assert replay.body["revision"] == first.body["revision"] == 1
    assert replay.etag == first.etag
    changed = {**body, "payload": {**body["payload"], "limit_minor": 0}}
    with pytest.raises(FinanceCommandError) as error:
        submit(engine, a, changed, etag)
    assert error.value.code == "idempotency_key_reuse"
    with finance_transaction(engine, verified_user_id=a.user_id, profile_id=a.profile_id) as s:
        assert s.execute(text("SELECT count(*) FROM budget_rules")).scalar_one() == 1
        assert s.execute(text("SELECT octet_length(request_sha256) FROM command_receipts")).scalar_one() == 32
    assert get_finance_delta(engine, scope=a, since_revision=0).body["changes"] == first.body["changes"]


def test_recurring_split_archive_and_overlap_preserve_history(scoped):
    engine, a, _ = scoped
    cat = create_category(engine, a)
    original = rule_payload(cat)
    act(engine, a, "budget.create", original)
    act(engine, a, "budget.create", rule_payload())
    for payload in (rule_payload(cat, month="2027-01"),
                    rule_payload(cat, month="2026-02", recurrence="once")):
        before = get_budget_candidate_snapshot(engine, scope=a)
        with pytest.raises(FinanceCommandError):
            act(engine, a, "budget.create", payload)
        assert get_budget_candidate_snapshot(engine, scope=a).etag == before.etag
    new_id = str(uuid4())
    change = act(engine, a, "budget.amend", {"rule_id": original["id"],
        "effective_from_month": "2026-03", "replacement_id": new_id, "limit_minor": 800_000},
        {original["id"]: 1})
    assert len(change.body["changes"]) == 2
    assert [e["ordinal"] for e in change.body["changes"]] == [0, 1]
    act(engine, a, "budget.archive", {"rule_id": new_id, "archived_from_month": "2026-05"}, {new_id: 1})
    act(engine, a, "budget.create", rule_payload(cat, month="2026-05", amount=0, recurrence="once"))
    rules = entities(engine, a, "budget_rule")
    assert rules[original["id"]]["data"]["limit_minor"] == 1_000_000
    assert rules[original["id"]]["data"]["ends_before_month"] == "2026-03"
    assert rules[new_id]["data"]["from_month"] == "2026-03"
    assert rules[new_id]["data"]["limit_minor"] == 800_000
    assert rules[new_id]["data"]["archived_from_month"] == "2026-05"


def test_foreign_category_and_stale_revision_rejected_without_writes(scoped):
    engine, a, b = scoped
    cat = create_category(engine, a)
    with pytest.raises(FinanceCommandError) as error:
        act(engine, b, "budget.create", rule_payload(cat))
    assert error.value.status == 409
    assert entities(engine, b, "budget_category") == {}
    assert entities(engine, b, "budget_rule") == {}
    old, etag = cmd(engine, a, "budget.create", rule_payload())
    act(engine, a, "budget.category.rename", {"id": cat, "name": "Продукты"}, {cat: 1})
    with pytest.raises(FinanceCommandError) as error:
        submit(engine, a, old, etag)
    assert error.value.status == 412
    assert entities(engine, a, "budget_rule") == {}
    with engine.connect() as c:
        assert c.execute(text("SELECT count(*) FROM budget_categories")).scalar_one() == 0


@pytest.mark.parametrize("amount", [-1, 0.5, True, 1_000_000_000_001])
def test_invalid_amount_is_rejected(scoped, amount):
    engine, a, _ = scoped
    with pytest.raises(FinanceCommandError) as error:
        act(engine, a, "budget.create", rule_payload(amount=amount))
    assert error.value.status == 422
    assert get_budget_candidate_snapshot(engine, scope=a).body["revision"] == 0


def test_reclassification_isolated_and_archived_category_preserves_history(scoped):
    engine, a, b = scoped
    cat = create_category(engine, a)
    foreign = create_category(engine, b, "Чужая")
    aid = create_account(engine, a)
    txid = expense(engine, a, aid)
    income_id = expense(engine, a, aid, kind="income", amount=1000)
    with finance_transaction(engine, verified_user_id=a.user_id, profile_id=a.profile_id) as s:
        before = s.execute(text("SELECT * FROM ledger_postings ORDER BY transaction_id,account_id")).all()
    for target, category in [(txid, foreign), (income_id, cat), (str(uuid4()), cat)]:
        with pytest.raises(FinanceCommandError):
            act(engine, a, "budget.category.assign", {"transaction_id": target, "category_id": category}, {target: 1})
    assigned = act(engine, a, "budget.category.assign", {"transaction_id": txid, "category_id": cat}, {txid: 1})
    assignment_id = assigned.body["changes"][0]["entity_id"]
    assert assignment_id != txid
    act(engine, a, "budget.category.archive", {"id": cat}, {cat: 1})
    assert entities(engine, a, "budget_assignment")[assignment_id]["data"]["category_id"] == cat
    assert entities(engine, a, "budget_category")[cat]["data"]["archived"] is True
    with pytest.raises(FinanceCommandError):
        act(engine, a, "budget.category.assign", {"transaction_id": txid, "category_id": cat}, {txid: 1})
    cleared = act(engine, a, "budget.category.assign", {"transaction_id": txid, "category_id": None}, {txid: 1})
    assert assigned.body["changes"][0]["payload"]["previous_category_id"] is None
    assert cleared.body["changes"][0]["payload"]["previous_category_id"] == cat
    assert cleared.body["changes"][0]["entity_id"] == assignment_id
    stored = entities(engine, a, "budget_assignment")[assignment_id]
    assert stored["data"]["category_id"] is None
    assert stored["data"]["transaction_id"] == txid
    assert stored["entity_revision"] == 2
    with finance_transaction(engine, verified_user_id=a.user_id, profile_id=a.profile_id) as s:
        assert s.execute(text("SELECT * FROM ledger_postings ORDER BY transaction_id,account_id")).all() == before
        assert s.execute(text("SELECT count(*) FROM budget_assignments")).scalar_one() == 1
        assert not s.execute(text("SELECT has_table_privilege(current_user,'finance.budget_assignments','DELETE')")).scalar_one()


def test_concurrent_writes_use_same_profile_lock_and_reject_stale_etag(scoped):
    from concurrent.futures import ThreadPoolExecutor

    engine, a, _ = scoped
    one, etag = cmd(engine, a, "budget.create", rule_payload())
    two, other_etag = cmd(engine, a, "budget.create", rule_payload())
    assert etag == other_etag

    def attempt(body):
        try:
            return submit(engine, a, body, etag).status
        except FinanceCommandError as error:
            return error.status

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(attempt, [one, two])) == [201, 412]
    assert len(entities(engine, a, "budget_rule")) == 1
    assert get_budget_candidate_snapshot(engine, scope=a).body["revision"] == 1


def test_rollback_after_split_collision_and_profile_identity_privileges(scoped):
    engine, a, _ = scoped
    old = rule_payload()
    occupied = rule_payload(month="2025-01", recurrence="once")
    act(engine, a, "budget.create", old)
    act(engine, a, "budget.create", occupied)
    snapshot = get_budget_candidate_snapshot(engine, scope=a)
    with pytest.raises(FinanceCommandError):
        act(engine, a, "budget.amend", {"rule_id": old["id"],
            "effective_from_month": "2026-03", "replacement_id": occupied["id"], "limit_minor": 0},
            {old["id"]: 1})
    assert get_budget_candidate_snapshot(engine, scope=a).body == snapshot.body
    with finance_transaction(engine, verified_user_id=a.user_id, profile_id=a.profile_id) as s:
        for table in ("budget_categories", "budget_rules", "budget_assignments"):
            assert not s.execute(text(
                "SELECT has_column_privilege(current_user,:table,'profile_id','UPDATE')"
            ), {"table": "finance." + table}).scalar_one()
            assert not s.execute(text(
                "SELECT has_table_privilege(current_user,:table,'DELETE')"
            ), {"table": "finance." + table}).scalar_one()


def test_budget_snapshot_pages_match_atomic_candidate_entities(scoped):
    engine, a, _ = scoped
    cat = create_category(engine, a)
    act(engine, a, "budget.create", rule_payload(cat))
    aid = create_account(engine, a)
    txid = expense(engine, a, aid)
    act(engine, a, "budget.category.assign", {"transaction_id": txid, "category_id": cat}, {txid: 1})
    candidate = get_budget_candidate_snapshot(engine, scope=a)
    before = get_finance_snapshot(engine, scope=a)
    kinds = {"budget_category", "budget_rule", "budget_assignment"}
    rows = [e for e in before.body["entities"] if e["kind"] in kinds]
    assert rows == candidate.body["entities"]
    assert before.etag == candidate.etag
    cursor = None
    paged = []
    for _ in range(12):
        result = get_finance_snapshot(engine, scope=a, cursor=cursor, limit_entities=1)
        assert result.etag == before.etag
        paged.extend(result.body["entities"])
        cursor = result.body.get("next_cursor")
        if cursor is None:
            break
    assert cursor is None
    assert paged == before.body["entities"]
    with pytest.raises(FinanceCommandError):
        act(engine, a, "budget.category.create", {"id": txid, "name": "ID collision"})
    assert get_finance_snapshot(engine, scope=a).etag == before.etag
