"""#6: isolated PostgreSQL/FastAPI reserve plan command acceptance.

Synthetic profiles only. This test suite must never run against production.
"""
from __future__ import annotations

import os
from uuid import uuid4

import pytest
from sqlalchemy import text

from backend.finance_api.accounts_v2_service import submit_account_v2_candidate
from backend.finance_db.db import create_finance_engine, finance_transaction
from backend.finance_db.ledger_service import (
    FinanceCommandError, VerifiedFinanceScope, submit_account_command,
)
from backend.finance_db.snapshot import get_finance_snapshot


@pytest.fixture
def financial_context():
    if os.environ.get("FH_FINANCE_CI_ALLOW_BOOTSTRAP") != "yes":
        pytest.skip("Only disposable PostgreSQL CI database is supported")
    engine = create_finance_engine()
    scope = VerifiedFinanceScope(user_id=uuid4().hex, profile_id=uuid4())
    with finance_transaction(
        engine, verified_user_id=scope.user_id, profile_id=scope.profile_id,
    ) as session:
        session.execute(
            text("INSERT INTO finance_profiles(id,owner_user_id) VALUES (:p,:u)"),
            {"p": scope.profile_id, "u": scope.user_id},
        )
    try:
        account_id = str(uuid4())
        state = get_finance_snapshot(engine, scope=scope)
        command = {
            "schema_version": 1, "client_mutation_id": str(uuid4()),
            "base_revision": state.body["revision"], "action": "account.create",
            "expected_entity_revisions": {},
            "payload": {"id": account_id, "name": "Тестовый счёт", "kind": "bank",
                        "currency": "RUB", "opening_minor": 10_000},
        }
        submit_account_command(
            engine, scope=scope, command=command, if_match=state.etag,
            idempotency_key=command["client_mutation_id"], allow_internal=True,
        )
        state = get_finance_snapshot(engine, scope=scope)
        command = {
            "schema_version": 1, "client_mutation_id": str(uuid4()),
            "base_revision": state.body["revision"], "action": "obligation.create",
            "expected_entity_revisions": {},
            "payload": {
                "title": "Тестовая страховка", "direction": "expense",
                "amount_minor": 9000, "starts_on": "2027-11-16",
                "timezone": "UTC", "recurrence_unit": "year",
                "recurrence_every": 1,
            },
        }
        reply = submit_account_command(
            engine, scope=scope, command=command, if_match=state.etag,
            idempotency_key=command["client_mutation_id"], allow_internal=True,
        )
        obligation_id = reply.body["changes"][0]["entity_id"]
        yield engine, scope, account_id, obligation_id
    finally:
        engine.dispose()


def snapshot(engine, scope):
    return get_finance_snapshot(engine, scope=scope)


def submit(engine, scope, action, payload, required, *, base=None, mutation_id=None):
    state = base or snapshot(engine, scope)
    versions = {
        entity["id"]: entity["entity_revision"]
        for entity in snapshot(engine, scope).body["entities"]
    }
    command = {
        "schema_version": 2, "client_mutation_id": str(mutation_id or uuid4()),
        "base_revision": state.body["revision"], "action": action,
        "expected_entity_revisions": {identifier: versions[identifier] for identifier in required},
        "payload": payload,
    }
    return submit_account_v2_candidate(
        engine, scope=scope, command=command, if_match=state.etag,
        idempotency_key=command["client_mutation_id"],
    )


def reserve_input(account, obligation, *, reserve_id=None, opening=3000):
    return {
        "id": reserve_id or str(uuid4()),
        "obligation_id": obligation, "account_id": account,
        "title": "Страховка", "target_minor": 9000,
        "opened_on": "2026-11-16", "first_due_on": "2027-11-16",
        "period_months": 12, "due_day": 16, "contribution_mode": "auto",
        "opening_reserved_minor": opening,
    }


def entities(engine, scope):
    return {e["id"]: e for e in snapshot(engine, scope).body["entities"]}


def test_create_is_atomic_and_does_not_change_bank_cash(financial_context):
    engine, scope, account_id, obligation_id = financial_context
    initial = snapshot(engine, scope)
    payload = reserve_input(account_id, obligation_id)
    reserve_id = payload["id"]
    created = submit(engine, scope, "reserve.create", payload, [account_id, obligation_id])
    assert created.status == 201
    assert created.body["revision"] == initial.body["revision"] + 1
    assert len(created.body["changes"]) == 2
    after = entities(engine, scope)
    account = after[account_id]["data"]
    reserve = after[reserve_id]["data"]
    assert account["balance_minor"] == 10_000
    assert account["reserved_minor"] == 3_000
    assert account["available_minor"] == 7_000
    assert reserve["allocated_minor"] == 3_000
    assert reserve["period_months"] == 12
    assert reserve["obligation_id"] == obligation_id
    assert reserve["account_id"] == account_id
    assert reserve["first_due_on"] == "2027-11-16"
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as session:
        assert session.execute(text("SELECT count(*) FROM ledger_transactions")).scalar_one() == 0
        assert session.execute(text("SELECT count(*) FROM reserve_allocations")).scalar_one() == 1


def test_update_allocate_release_and_archive_keep_history(financial_context):
    engine, scope, account_id, obligation_id = financial_context
    rid = reserve_input(account_id, obligation_id)
    created = submit(engine, scope, "reserve.create", rid, [account_id, obligation_id])
    assert created.status == 201
    amended = {
        "reserve_id": rid["id"], "title": "Страховка обновлена",
        "target_minor": 12_000, "first_due_on": "2027-11-16",
        "period_months": 12, "due_day": 16,
        "contribution_mode": "fixed", "fixed_monthly_minor": 750,
    }
    assert submit(engine, scope, "reserve.update", amended, [rid["id"]]).status == 201
    assert submit(engine, scope, "reserve.allocate", {
        "reserve_id": rid["id"], "account_id": account_id, "delta_minor": 2000,
    }, [rid["id"], account_id]).status == 201
    # Target reduction preserves the already-reserved surplus for the next cycle.
    amended = {**amended, "target_minor": 4_000}
    assert submit(engine, scope, "reserve.update", amended, [rid["id"]]).status == 201
    before_bad_archive = snapshot(engine, scope)
    with pytest.raises(FinanceCommandError) as exc:
        submit(engine, scope, "reserve.archive", {"reserve_id": rid["id"]}, [rid["id"]])
    assert exc.value.code == "semantic_conflict"
    assert snapshot(engine, scope).body["revision"] == before_bad_archive.body["revision"]
    assert submit(engine, scope, "reserve.allocate", {
        "reserve_id": rid["id"], "account_id": account_id, "delta_minor": -5000,
    }, [rid["id"], account_id]).status == 201
    assert submit(engine, scope, "reserve.archive", {
        "reserve_id": rid["id"],
    }, [rid["id"]]).status == 201
    state = entities(engine, scope)
    assert state[rid["id"]]["data"]["archived_at"] is not None
    assert state[rid["id"]]["data"]["fixed_monthly_minor"] == 750
    assert state[rid["id"]]["data"]["opening_target_minor"] == 9000
    assert state[account_id]["data"]["balance_minor"] == 10_000
    assert state[account_id]["data"]["reserved_minor"] == 0
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as session:
        assert session.execute(text("SELECT count(*) FROM reserve_allocations")).scalar_one() == 3
        assert session.execute(text("SELECT count(*) FROM ledger_transactions")).scalar_one() == 0


def test_available_cash_duplicates_and_unowned_accounts(financial_context):
    engine, scope, account_id, obligation_id = financial_context
    payload = reserve_input(account_id, obligation_id)
    assert submit(engine, scope, "reserve.create", payload, [account_id, obligation_id]).status == 201
    duplicate = reserve_input(account_id, obligation_id)
    with pytest.raises(FinanceCommandError) as exc:
        submit(engine, scope, "reserve.create", duplicate, [account_id, obligation_id])
    assert exc.value.code == "semantic_conflict"
    # A different profile's account ID with a syntactically correct revision
    # must be rejected by the server-side RLS-scoped account lookup.
    foreign_account = str(uuid4())
    foreign_payload = reserve_input(foreign_account, obligation_id)
    state = snapshot(engine, scope)
    cmd = {
        "schema_version": 2, "client_mutation_id": str(uuid4()),
        "base_revision": state.body["revision"], "action": "reserve.create",
        "expected_entity_revisions": {foreign_account: 1, obligation_id: 1},
        "payload": foreign_payload,
    }
    with pytest.raises(FinanceCommandError) as exc:
        submit_account_v2_candidate(
            engine, scope=scope, command=cmd, if_match=state.etag,
            idempotency_key=cmd["client_mutation_id"],
        )
    assert exc.value.code == "semantic_conflict"
    before = snapshot(engine, scope)
    with pytest.raises(FinanceCommandError) as exc:
        submit(engine, scope, "reserve.allocate", {
            "reserve_id": payload["id"], "account_id": account_id,
            "delta_minor": 8_000,
        }, [payload["id"], account_id])
    assert exc.value.code == "semantic_conflict"
    assert snapshot(engine, scope).body["revision"] == before.body["revision"]


def test_request_replay_and_conflicting_mutation_preserve_exact_cash(financial_context):
    engine, scope, account_id, obligation_id = financial_context
    initial = snapshot(engine, scope)
    p = reserve_input(account_id, obligation_id)
    mid = uuid4()
    versions = {account_id: 1, obligation_id: 1}
    command = {
        "schema_version": 2, "client_mutation_id": str(mid),
        "base_revision": initial.body["revision"], "action": "reserve.create",
        "expected_entity_revisions": versions, "payload": p,
    }
    def dispatch(c):
        return submit_account_v2_candidate(
            engine, scope=scope, command=c, if_match=initial.etag,
            idempotency_key=str(mid),
        )
    first = dispatch(command)
    replay = dispatch(command)
    assert first.status == 201 and replay.status == 200 and replay.body["replayed"]
    with pytest.raises(FinanceCommandError) as exc:
        dispatch({**command, "payload": {**p, "target_minor": 9500}})
    assert exc.value.code == "idempotency_key_reuse"
    new_mid = str(uuid4())
    with pytest.raises(FinanceCommandError) as exc:
        submit_account_v2_candidate(
            engine, scope=scope,
            command={**command, "client_mutation_id": new_mid,
                     "action": "reserve.archive", "payload": {"reserve_id": p["id"]},
                     "expected_entity_revisions": {p["id"]: 1}},
            if_match=initial.etag, idempotency_key=new_mid,
        )
    assert exc.value.code == "stale_revision"
    assert exc.value.status == 412
    final = entities(engine, scope)
    assert final[account_id]["data"]["balance_minor"] == 10_000
    assert final[account_id]["data"]["reserved_minor"] == 3_000


def test_invalid_plan_rejected_before_sql(financial_context):
    engine, scope, account_id, obligation_id = financial_context
    before = snapshot(engine, scope)
    for override in (
        {"period_months": 61},
        {"contribution_mode": "fixed"},
        {"due_day": 31},
        {"opening_reserved_minor": 1_000_000_000_001},
    ):
        payload = {**reserve_input(account_id, obligation_id), **override}
        with pytest.raises(FinanceCommandError) as exc:
            submit(engine, scope, "reserve.create", payload, [account_id, obligation_id])
        assert exc.value.code == "invalid_command"
    assert snapshot(engine, scope).body["revision"] == before.body["revision"]



def test_reserved_payment_and_void_are_one_cash_write_each(financial_context):
    from backend.finance_db.snapshot import get_finance_delta

    engine, scope, account_id, obligation_id = financial_context
    plan = reserve_input(account_id, obligation_id, opening=9000)
    assert submit(
        engine, scope, "reserve.create", plan, [account_id, obligation_id],
    ).status == 201
    before = snapshot(engine, scope)
    payment = submit(engine, scope, "settlement.payment.record", {
        "account_id": account_id, "obligation_id": obligation_id,
        "amount_minor": 6000, "occurrence_on": "2027-11-16",
        "paid_on": "2027-11-16", "reserve_id": plan["id"],
        "reserved_used_minor": 6000,
    }, [account_id, obligation_id, plan["id"]])
    assert payment.status == 201
    assert len(payment.body["changes"]) == 3
    transaction_id = payment.body["changes"][0]["entity_id"]
    fact_id = payment.body["changes"][1]["entity_id"]
    payment_link = entities(engine, scope)[transaction_id]["data"]["reserve_allocation"]
    assert payment_link["delta_minor"] == -6000
    assert payment_link["reserve_id"] == plan["id"]
    assert payment_link["reverses_allocation_id"] is None
    after = entities(engine, scope)
    assert after[account_id]["data"]["balance_minor"] == 4000
    assert after[account_id]["data"]["reserved_minor"] == 3000
    assert after[account_id]["data"]["available_minor"] == 1000
    assert after[plan["id"]]["data"]["allocated_minor"] == 3000

    delta = get_finance_delta(
        engine, scope=scope, since_revision=before.body["revision"], page_revisions=1,
    )
    assert delta.body["next_since_revision"] == payment.body["revision"]
    assert [change["ordinal"] for change in delta.body["changes"]] == [0, 1, 2]
    assert delta.body["changes"][0]["payload"]["entity"] == after[transaction_id]
    assert delta.body["changes"][2]["payload"]["entity"] == after[plan["id"]]

    original = snapshot(engine, scope)
    reason = "Тестовая отмена ошибочной оплаты"
    void = submit(engine, scope, "settlement.payment.void", {
        "transaction_id": transaction_id, "fact_id": fact_id,
        "account_id": account_id, "reserve_id": plan["id"], "reason": reason,
    }, [transaction_id, fact_id, account_id, plan["id"]])
    assert void.status == 201
    assert len(void.body["changes"]) == 3
    reversal_id = void.body["changes"][0]["entity_id"]
    reversed_link = entities(engine, scope)[reversal_id]["data"]["reserve_allocation"]
    assert reversed_link["delta_minor"] == 6000
    assert reversed_link["reverses_allocation_id"] == payment_link["id"]
    state = entities(engine, scope)
    assert state[account_id]["data"]["balance_minor"] == 10_000
    assert state[account_id]["data"]["reserved_minor"] == 9_000
    assert state[account_id]["data"]["available_minor"] == 1_000
    assert state[plan["id"]]["data"]["allocated_minor"] == 9_000
    assert state[fact_id]["data"]["voided_at"] is not None
    assert get_finance_delta(
        engine, scope=scope, since_revision=original.body["revision"], page_revisions=1,
    ).body["changes"][0]["payload"]["entity"] == state[reversal_id]
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as session:
        assert session.execute(text("SELECT count(*) FROM ledger_transactions")).scalar_one() == 2
        assert sorted(session.execute(text("""
            SELECT signed_minor FROM ledger_postings
        """)).scalars().all()) == [-6000, 6000]
        assert sorted(session.execute(text("""
            SELECT delta_minor FROM reserve_allocations
        """)).scalars().all()) == [-6000, 6000, 9000]
    with pytest.raises(FinanceCommandError) as exc:
        submit(engine, scope, "settlement.payment.void", {
            "transaction_id": transaction_id, "fact_id": fact_id,
            "account_id": account_id, "reserve_id": plan["id"],
            "reason": "Повторная отмена",
        }, [transaction_id, fact_id, account_id, plan["id"]])
    assert exc.value.code == "semantic_conflict"


def test_reserved_payment_rejects_partial_release_if_cash_would_be_overreserved(financial_context):
    engine, scope, account_id, obligation_id = financial_context
    plan = reserve_input(account_id, obligation_id, opening=9000)
    submit(engine, scope, "reserve.create", plan, [account_id, obligation_id])
    before = snapshot(engine, scope)
    for amount, used, code in (
        (6000, 9000, "invalid_command"),
        (6000, 3000, "semantic_conflict"),
    ):
        with pytest.raises(FinanceCommandError) as exc:
            submit(engine, scope, "settlement.payment.record", {
                "account_id": account_id, "obligation_id": obligation_id,
                "amount_minor": amount, "occurrence_on": "2027-11-16",
                "paid_on": "2027-11-16", "reserve_id": plan["id"],
                "reserved_used_minor": used,
            }, [account_id, obligation_id, plan["id"]])
        assert exc.value.code == code
        assert snapshot(engine, scope).body["revision"] == before.body["revision"]
    a = entities(engine, scope)[account_id]["data"]
    assert a["balance_minor"] == 10_000 and a["reserved_minor"] == 9000
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as session:
        assert session.execute(text("SELECT count(*) FROM ledger_transactions")).scalar_one() == 0
        assert session.execute(text("SELECT count(*) FROM settlements")).scalar_one() == 0
        assert session.execute(text("SELECT count(*) FROM reserve_allocations")).scalar_one() == 1


def test_direct_orphan_reserved_payment_fails_at_sql_commit(financial_context):
    from sqlalchemy.exc import DBAPIError

    engine, scope, account_id, obligation_id = financial_context
    plan = reserve_input(account_id, obligation_id, opening=3000)
    submit(engine, scope, "reserve.create", plan, [account_id, obligation_id])
    before = snapshot(engine, scope)
    with pytest.raises(DBAPIError):
        with finance_transaction(
            engine, verified_user_id=scope.user_id, profile_id=scope.profile_id,
        ) as session:
            session.execute(text("""
                INSERT INTO reserve_allocations
                  (profile_id,id,reserve_id,account_id,delta_minor,linked_transaction_id)
                VALUES (:p,:id,:reserve,:account,-1000,:missing)
            """), {
                "p": scope.profile_id, "id": uuid4(), "reserve": plan["id"],
                "account": account_id, "missing": uuid4(),
            })
    assert snapshot(engine, scope).body["revision"] == before.body["revision"]
    assert entities(engine, scope)[account_id]["data"]["reserved_minor"] == 3000



def test_reserve_event_undo_and_skipped_installment(financial_context):
    engine, scope, account, obligation = financial_context
    plan = reserve_input(account, obligation)
    reserve = plan["id"]
    create = submit(engine, scope, "reserve.create", plan, [account, obligation])
    assert create.status == 201
    original = entities(engine, scope)[reserve]["data"]
    assert original["opening_reserved_minor"] == 3000
    assert original["opening_target_minor"] == 9000
    assert original["cycle_number"] == 1
    assert original["event_log"] == []

    paid_in = submit(engine, scope, "reserve.allocate", {
        "reserve_id": reserve, "account_id": account,
        "delta_minor": 2000, "occurred_on": "2026-11-17",
    }, [reserve, account])
    assert paid_in.status == 201
    state = entities(engine, scope)
    assert state[reserve]["data"]["allocated_minor"] == 5000
    contribution, = state[reserve]["data"]["event_log"]
    assert contribution["kind"] == "contribution"
    assert contribution["amount_minor"] == 2000
    assert contribution["occurred_on"] == "2026-11-17"
    assert contribution["cycle_number"] == 1
    assert contribution["revision"] == paid_in.body["revision"]
    assert contribution["allocation_id"]

    void = submit(engine, scope, "reserve.event.void", {
        "reserve_id": reserve, "account_id": account,
        "target_event_id": contribution["id"],
        "occurred_on": "2026-11-18", "reason": "Исправление суммы",
    }, [reserve, account])
    assert void.status == 201
    state = entities(engine, scope)
    assert state[reserve]["data"]["allocated_minor"] == 3000
    assert state[account]["data"]["balance_minor"] == 10000
    history = state[reserve]["data"]["event_log"]
    assert [event["kind"] for event in history] == ["contribution", "void"]
    assert history[1]["target_event_id"] == contribution["id"]
    assert history[1]["note"] == "Исправление суммы"
    assert history[1]["allocation_id"]
    before_duplicate = snapshot(engine, scope)
    with pytest.raises(FinanceCommandError) as exc:
        submit(engine, scope, "reserve.event.void", {
            "reserve_id": reserve, "account_id": account,
            "target_event_id": contribution["id"],
            "occurred_on": "2026-11-19", "reason": "Повторная отмена",
        }, [reserve, account])
    assert exc.value.code == "semantic_conflict"
    assert snapshot(engine, scope).body["revision"] == before_duplicate.body["revision"]

    skipped = submit(engine, scope, "reserve.skip", {
        "reserve_id": reserve, "slot_on": "2026-12-16",
        "occurred_on": "2026-12-17",
    }, [reserve])
    assert skipped.status == 201
    skip_event = entities(engine, scope)[reserve]["data"]["event_log"][-1]
    assert skip_event["kind"] == "skip"
    assert skip_event["slot_on"] == "2026-12-16"
    with pytest.raises(FinanceCommandError) as exc:
        submit(engine, scope, "reserve.skip", {
            "reserve_id": reserve, "slot_on": "2026-12-16",
            "occurred_on": "2026-12-18",
        }, [reserve])
    assert exc.value.code == "semantic_conflict"
    assert submit(engine, scope, "reserve.event.void", {
        "reserve_id": reserve, "account_id": account,
        "target_event_id": skip_event["id"],
        "occurred_on": "2026-12-18", "reason": "Взнос не пропускали",
    }, [reserve, account]).status == 201
    assert submit(engine, scope, "reserve.skip", {
        "reserve_id": reserve, "slot_on": "2026-12-16",
        "occurred_on": "2026-12-19",
    }, [reserve]).status == 201

    release = submit(engine, scope, "reserve.allocate", {
        "reserve_id": reserve, "account_id": account,
        "delta_minor": -1500, "occurred_on": "2026-12-20",
    }, [reserve, account])
    assert release.status == 201
    release_event = entities(engine, scope)[reserve]["data"]["event_log"][-1]
    assert release_event["kind"] == "release"
    assert release_event["amount_minor"] == 1500
    assert submit(engine, scope, "reserve.event.void", {
        "reserve_id": reserve, "account_id": account,
        "target_event_id": release_event["id"],
        "occurred_on": "2026-12-21", "reason": "Отмена ошибочного снятия",
    }, [reserve, account]).status == 201
    assert entities(engine, scope)[reserve]["data"]["allocated_minor"] == 3000

    state = entities(engine, scope)
    assert state[account]["data"]["reserved_minor"] == 3000
    assert state[account]["data"]["available_minor"] == 7000
    assert state[account]["data"]["balance_minor"] == 10000
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as session:
        assert session.execute(text("SELECT count(*) FROM ledger_transactions")).scalar_one() == 0
        events = session.execute(text("""
            SELECT count(*) FROM reserve_events WHERE reserve_id=:id
        """), {"id": reserve}).scalar_one()
        assert events == len(state[reserve]["data"]["event_log"])


def test_paid_cycle_close_rolls_original_date_forward_without_posting_cash(financial_context):
    engine, scope, account, obligation = financial_context
    plan = reserve_input(account, obligation, opening=6000)
    reserve = plan["id"]
    submit(engine, scope, "reserve.create", plan, [account, obligation])
    with pytest.raises(FinanceCommandError) as exc:
        submit(engine, scope, "reserve.cycle.close", {
            "reserve_id": reserve, "occurred_on": "2026-11-17",
        }, [reserve])
    assert exc.value.code == "semantic_conflict"
    assert submit(engine, scope, "settlement.payment.record", {
        "account_id": account, "obligation_id": obligation,
        "amount_minor": 9000, "occurrence_on": "2027-11-16",
        "paid_on": "2027-11-16", "reserve_id": reserve,
        "reserved_used_minor": 6000,
    }, [account, obligation, reserve]).status == 201
    payment = entities(engine, scope)[reserve]["data"]["event_log"][-1]
    assert payment["kind"] == "payment"
    assert payment["amount_minor"] == 9000
    assert payment["reserved_used_minor"] == 6000
    assert payment["transaction_id"]
    cash_before_close = entities(engine, scope)[account]["data"]
    closed = submit(engine, scope, "reserve.cycle.close", {
        "reserve_id": reserve, "occurred_on": "2027-11-16",
    }, [reserve])
    assert closed.status == 201
    state = entities(engine, scope)
    assert state[reserve]["data"]["cycle_number"] == 2
    assert state[reserve]["data"]["target_on"] == "2028-11-16"
    assert state[reserve]["data"]["first_due_on"] == "2027-11-16"
    assert [e["kind"] for e in state[reserve]["data"]["event_log"]] == ["payment", "cycle_close"]
    assert state[account]["data"] == cash_before_close
    assert state[account]["data"]["balance_minor"] == 1000
    assert state[reserve]["data"]["allocated_minor"] == 0
    with pytest.raises(FinanceCommandError) as exc:
        submit(engine, scope, "reserve.cycle.close", {
            "reserve_id": reserve, "occurred_on": "2027-11-17",
        }, [reserve])
    assert exc.value.code == "semantic_conflict"
    with pytest.raises(FinanceCommandError) as exc:
        submit(engine, scope, "settlement.payment.void", {
            "transaction_id": payment["transaction_id"],
            "fact_id": next(
                e["id"] for e in snapshot(engine, scope).body["entities"]
                if e["kind"] == "settlement"
            ),
            "account_id": account, "reserve_id": reserve,
            "reason": "После закрытия цикла",
        }, [payment["transaction_id"],
            next(e["id"] for e in snapshot(engine, scope).body["entities"]
                 if e["kind"] == "settlement"), account, reserve])
    assert exc.value.code == "semantic_conflict"
    assert entities(engine, scope)[reserve]["data"]["cycle_number"] == 2


def test_skipped_short_month_anchor_validated(financial_context):
    engine, scope, account, obligation = financial_context
    plan = {
        **reserve_input(account, obligation, opening=0),
        "opened_on": "2028-01-31", "first_due_on": "2028-02-29",
        "period_months": 1, "due_day": 31,
    }
    submit(engine, scope, "reserve.create", plan, [account, obligation])
    assert submit(engine, scope, "reserve.skip", {
        "reserve_id": plan["id"], "slot_on": "2028-02-29",
        "occurred_on": "2028-03-01",
    }, [plan["id"]]).status == 201
    for bad in ["2028-02-28", "2028-03-31", "2028-02-30"]:
        with pytest.raises(FinanceCommandError) as exc:
            submit(engine, scope, "reserve.skip", {
                "reserve_id": plan["id"], "slot_on": bad,
                "occurred_on": "2028-03-02",
            }, [plan["id"]])
        assert exc.value.code == "invalid_command"



def test_reserved_payment_can_use_zero_allocated_cash_and_void_atomically(financial_context):
    engine, scope, account, obligation = financial_context
    plan = reserve_input(account, obligation, opening=3000)
    reserve = plan["id"]
    submit(engine, scope, "reserve.create", plan, [account, obligation])
    starting = snapshot(engine, scope)
    with pytest.raises(FinanceCommandError) as exc:
        submit(engine, scope, "settlement.payment.record", {
            "account_id": account, "obligation_id": obligation,
            "amount_minor": 2000, "occurrence_on": "2027-11-16",
            "paid_on": "2027-11-16",
        }, [account, obligation])
    assert exc.value.code == "semantic_conflict"
    assert snapshot(engine, scope).body["revision"] == starting.body["revision"]

    record = submit(engine, scope, "settlement.payment.record", {
        "account_id": account, "obligation_id": obligation,
        "amount_minor": 2000, "occurrence_on": "2027-11-16",
        "paid_on": "2027-11-16", "reserve_id": reserve,
        "reserved_used_minor": 0,
    }, [account, obligation, reserve])
    assert record.status == 201
    event = entities(engine, scope)[reserve]["data"]["event_log"][-1]
    assert event["kind"] == "payment"
    assert event["reserved_used_minor"] == 0
    a = entities(engine, scope)[account]["data"]
    assert (a["balance_minor"], a["reserved_minor"], a["available_minor"]) == (8000, 3000, 5000)
    fact_id = next(e["id"] for e in snapshot(engine, scope).body["entities"]
                   if e["kind"] == "settlement")
    undone = submit(engine, scope, "settlement.payment.void", {
        "transaction_id": event["transaction_id"], "fact_id": fact_id,
        "account_id": account, "reserve_id": reserve, "reason": "Ошибка оплаты",
    }, [event["transaction_id"], fact_id, account, reserve])
    assert undone.status == 201
    final = entities(engine, scope)
    a = final[account]["data"]
    assert (a["balance_minor"], a["reserved_minor"], a["available_minor"]) == (10000, 3000, 7000)
    journal = final[reserve]["data"]["event_log"]
    assert len(journal) == 2 and journal[-1]["kind"] == "void"
    assert journal[-1]["target_event_id"] == event["id"]
    assert journal[-1]["note"] == "Ошибка оплаты"
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as session:
        assert session.execute(text("SELECT count(*) FROM reserve_allocations")).scalar_one() == 1
        assert sorted(session.execute(text("""
            SELECT signed_minor FROM ledger_postings
        """)).scalars().all()) == [-2000, 2000]


def test_zero_funded_reserve_allows_signed_negative_account_without_cash_movement(financial_context):
    engine, scope, _, obligation_id = financial_context
    account_id = str(uuid4())
    opening = -500
    created = submit(engine, scope, "account.create", {
        "id": account_id, "name": "Отрицательный синтетический счёт",
        "kind": "cash", "currency": "RUB", "opening_minor": opening,
    }, [])
    assert created.status == 201
    before = snapshot(engine, scope)
    plan = reserve_input(account_id, obligation_id, opening=0)
    result = submit(engine, scope, "reserve.create", plan, [account_id, obligation_id])
    assert result.status == 201
    assert result.body["revision"] == before.body["revision"] + 1
    after = entities(engine, scope)
    assert after[account_id]["data"]["opening_minor"] == opening
    assert after[account_id]["data"]["balance_minor"] == opening
    assert after[account_id]["data"]["reserved_minor"] == 0
    assert after[account_id]["data"]["available_minor"] == opening
    assert after[plan["id"]]["data"]["allocated_minor"] == 0
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as session:
        assert session.execute(text("SELECT count(*) FROM reserve_allocations")).scalar_one() == 0
        assert session.execute(text("SELECT count(*) FROM ledger_transactions")).scalar_one() == 0
