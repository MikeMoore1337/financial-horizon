"""#33/#67: strict unmounted account v2 against REAL PostgreSQL + FH SQLite auth.

All fixtures are synthetic; there is no public v2 route or production write.
"""
from __future__ import annotations

from uuid import uuid4

import pytest

from backend.finance_api.accounts_v2_service import submit_account_v2_candidate
from backend.finance_api.tests.test_http import env, engine, snapshot, balance
from backend.finance_db.ledger_service import (
    FinanceCommandError, get_account_snapshot, submit_account_command,
)


def v2(state, action, payload, revisions=None, mutation=None):
    return {
        "schema_version": 2,
        "client_mutation_id": mutation or str(uuid4()),
        "base_revision": state.json()["revision"],
        "action": action,
        "expected_entity_revisions": revisions if revisions is not None else {},
        "payload": payload,
    }


def submit(env, uid, state, cmd):
    return submit_account_v2_candidate(
        env["engine"], scope=env["scope"](uid), command=cmd,
        if_match=state.headers["etag"],
        idempotency_key=cmd["client_mutation_id"],
    )


def account_rev(state, account_id):
    return next(e["entity_revision"] for e in state.json()["entities"] if e["id"] == account_id)


def test_unmounted_v2_sql_create_archive_restore_and_actual_expense(env):
    uid, token = env["first"]
    before = snapshot(env, token)
    account_id = str(uuid4())
    create = v2(before, "account.create", {
        "id": account_id, "name": "Synthetic RUB wallet",
        "kind": "cash", "currency": "RUB", "opening_minor": 10_000,
    })
    # A v2 command must not be accepted by the live v1 callable.
    with pytest.raises(FinanceCommandError) as blocked:
        submit_account_command(
            env["engine"], scope=env["scope"](uid), command=create,
            if_match=before.headers["etag"],
            idempotency_key=create["client_mutation_id"],
        )
    assert blocked.value.code == "invalid_command"
    assert get_account_snapshot(env["engine"], scope=env["scope"](uid)).body["revision"] == before.json()["revision"]

    done = submit(env, uid, before, create)
    assert done.status == 201 and done.body["schema_version"] == 2
    assert done.body["replayed"] is False
    replay = submit(env, uid, before, create)
    assert replay.status == 200 and replay.body["replayed"] is True
    assert replay.body["revision"] == done.body["revision"]
    state = snapshot(env, token)
    assert account_rev(state, account_id) >= 1
    assert balance(env, uid, account_id) == 10_000

    archive = v2(state, "account.archive", {"account_id": account_id}, {
        account_id: account_rev(state, account_id),
    })
    assert submit(env, uid, state, archive).status == 201
    archived = snapshot(env, token)
    archived_entity = next(x for x in archived.json()["entities"] if x["id"] == account_id)
    assert archived_entity["data"]["archived_at"] is not None
    edit = v2(archived, "account.update", {
        "account_id": account_id, "name": "Should never save", "kind": "bank",
    }, {account_id: account_rev(archived, account_id)})
    with pytest.raises(FinanceCommandError) as rejected:
        submit(env, uid, archived, edit)
    assert rejected.value.code == "semantic_conflict"
    assert snapshot(env, token).json()["revision"] == archived.json()["revision"]

    restore = v2(archived, "account.unarchive", {"account_id": account_id}, {
        account_id: account_rev(archived, account_id),
    })
    assert submit(env, uid, archived, restore).status == 201
    state = snapshot(env, token)
    edit = v2(state, "account.update", {
        "account_id": account_id, "name": "Recovered account", "kind": "bank",
    }, {account_id: account_rev(state, account_id)})
    assert submit(env, uid, state, edit).status == 201

    state = snapshot(env, token)
    actual = v2(state, "transaction.record", {
        "id": str(uuid4()), "account_id": account_id, "kind": "expense",
        "signed_minor": -1_500, "occurred_on": "2026-11-11",
    }, {account_id: account_rev(state, account_id)})
    spent = submit(env, uid, state, actual)
    assert spent.status == 201 and spent.body["schema_version"] == 2
    assert submit(env, uid, state, actual).body["replayed"] is True
    assert balance(env, uid, account_id) == 8_500

    final = snapshot(env, token)
    row = next(x for x in final.json()["entities"] if x["id"] == account_id)
    assert row["data"]["name"] == "Recovered account"
    assert row["data"]["type"] == "bank"
    assert row["data"]["archived_at"] is None
    assert row["data"]["balance_minor"] == 8_500
    # No router publishes v2 yet; even a valid FH finance cookie cannot reach it.
    denied = env["client"](token).post("/api/finance/v2/commands", json=actual, headers={
        "Origin": "http://127.0.0.1:8791",
        "Idempotency-Key": actual["client_mutation_id"],
        "If-Match": state.headers["etag"],
    })
    assert denied.status_code == 404


def test_unmounted_v2_rejects_idor_and_unsafe_actions(env):
    uid, token = env["first"]
    before = snapshot(env, token)
    account_id = str(uuid4())
    created = v2(before, "account.create", {
        "id": account_id, "name": "Owned cash", "kind": "cash",
        "currency": "RUB", "opening_minor": 0,
    })
    assert submit(env, uid, before, created).status == 201
    user_b, token_b = env["new_user"]()
    fresh_b = snapshot(env, token_b)
    cross = v2(fresh_b, "account.update", {
        "account_id": account_id, "name": "Cross-profile", "kind": "bank",
    }, {account_id: 1})
    with pytest.raises(FinanceCommandError) as denied:
        submit(env, user_b, fresh_b, cross)
    assert denied.value.code == "semantic_conflict"
    assert snapshot(env, token_b).json()["entities"] == []
    assert balance(env, uid, account_id) == 0

    # A future caller cannot turn the v2 allowlist into general internal
    # command execution, even if the narrower transport validator is bypassed.
    forbidden = v2(fresh_b, "loan.payment.record", {
        "account_id": account_id,
    })
    with pytest.raises(FinanceCommandError) as excluded:
        submit_account_command(
            env["engine"], scope=env["scope"](user_b), command=forbidden,
            if_match=fresh_b.headers["etag"],
            idempotency_key=forbidden["client_mutation_id"],
            allow_account_v2=True,
        )
    assert excluded.value.code == "invalid_command"
    with pytest.raises(FinanceCommandError) as validated:
        submit(env, user_b, fresh_b, forbidden)
    assert validated.value.code == "invalid_command"
    with pytest.raises(ValueError):
        submit_account_command(
            env["engine"], scope=env["scope"](user_b), command=forbidden,
            if_match=fresh_b.headers["etag"],
            idempotency_key=forbidden["client_mutation_id"],
            allow_internal=True, allow_account_v2=True,
        )


def test_v2_collision_or_malformed_command_does_not_duplicate_cash(env):
    uid, token = env["first"]
    start = snapshot(env, token)
    account_id = str(uuid4())
    valid = v2(start, "account.create", {
        "id": account_id, "name": "First", "kind": "cash",
        "currency": "RUB", "opening_minor": -23,
    })
    assert submit(env, uid, start, valid).status == 201
    conflicting = v2(start, "account.create", {
        **valid["payload"], "opening_minor": 500_000,
    }, mutation=valid["client_mutation_id"])
    with pytest.raises(FinanceCommandError) as reused:
        submit(env, uid, start, conflicting)
    assert reused.value.code == "idempotency_key_reuse"

    state = snapshot(env, token)
    invalid = v2(state, "transaction.record", {
        "id": str(uuid4()), "account_id": account_id, "kind": "income",
        "signed_minor": -500, "occurred_on": "2026-11-11",
    }, {account_id: account_rev(state, account_id)})
    with pytest.raises(FinanceCommandError) as wrong_sign:
        submit(env, uid, state, invalid)
    assert wrong_sign.value.code == "invalid_command"
    assert snapshot(env, token).json()["revision"] == state.json()["revision"]
    assert balance(env, uid, account_id) == -23
