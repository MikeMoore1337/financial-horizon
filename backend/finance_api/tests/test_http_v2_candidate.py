"""#33/#67 - opt-in v2 HTTP candidate, real PostgreSQL and FH SQLite AuthStore.

This suite uses disposable synthetic identities and a test-only opt-in.
The production create_app() keeps the v2 route disabled by default.
"""
from __future__ import annotations

import json
import os
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from backend.fh_email_auth.app import create_app
from backend.fh_email_auth.config import Settings
from backend.finance_api.tests.test_http import (
    COOKIE, NAMESPACE, ORIGIN, balance, engine, env,
)

pytestmark = pytest.mark.skipif(
    os.getenv("FH_FINANCE_CI_ALLOW_BOOTSTRAP") != "yes",
    reason="Requires dedicated disposable PostgreSQL and real test AuthStore",
)


@pytest.fixture
def v2_env(env):
    store = env["store"]
    config = Settings(
        True, ORIGIN, store.path, "r" * 48, "synthetic-turnstile", "synthetic-site",
        "smtp.invalid", 465, "synthetic-user", "synthetic-password",
        "noreply@example.invalid", True,
    )
    app = create_app(
        config=config, store=store, finance_engine=env["engine"],
        finance_profile_namespace=NAMESPACE, enable_account_v2_candidate=True,
    )

    def client(token: str):
        c = TestClient(app, base_url=ORIGIN, raise_server_exceptions=False)
        c.cookies.set(COOKIE, token, domain="127.0.0.1", path="/api/auth")
        login = c.post("/api/auth/email/finance/session",
                       headers={"Origin": ORIGIN}, json={})
        assert login.status_code == 200, login.text
        # The existing auth middleware enforces no-store for bootstrap.
        assert login.headers["cache-control"] == "no-store"
        return c

    return {**env, "v2_app": app, "v2_client": client}


def snapshot(client):
    result = client.get("/api/finance/v1/state")
    assert result.status_code == 200, result.text
    return result


def request(state, action, payload, versions=None, mutation=None):
    return {
        "schema_version": 2,
        "client_mutation_id": mutation or str(uuid4()),
        "base_revision": state.json()["revision"],
        "action": action,
        "expected_entity_revisions": versions if versions is not None else {},
        "payload": payload,
    }


def revisions(state, *ids):
    available = {item["id"]: item["entity_revision"]
                 for item in state.json()["entities"]}
    return {ident: available[ident] for ident in ids}


def post(client, state, command, **headers):
    return client.post(
        "/api/finance/v2/commands", json=command,
        headers={"Origin": ORIGIN, "If-Match": state.headers["etag"],
                 "Idempotency-Key": command["client_mutation_id"], **headers},
    )


def test_v2_candidate_has_no_http_route_by_default(env):
    uid, token = env["first"]
    old_app = env["app"]
    assert not any(getattr(route, "path", "") == "/api/finance/v2/commands"
                   for route in old_app.routes)
    client = env["client"](token)
    response = client.post("/api/finance/v2/commands",
                           headers={"Origin": ORIGIN}, json={})
    assert response.status_code == 404


def test_v2_candidate_http_full_account_lifecycle_and_replay(v2_env):
    uid, token = v2_env["first"]
    client = v2_env["v2_client"](token)
    state = snapshot(client)
    account_id = str(uuid4())
    create = request(state, "account.create", {
        "id": account_id, "name": "Synthetic account", "kind": "bank",
        "currency": "RUB", "opening_minor": 5_000,
    })
    new = post(client, state, create)
    assert new.status_code == 201, new.text
    assert new.json()["schema_version"] == 2
    assert new.headers["cache-control"] == "private, no-store"
    replay = post(client, state, create)
    assert replay.status_code == 200 and replay.json()["replayed"] is True
    assert replay.json()["revision"] == new.json()["revision"]
    assert balance(v2_env, uid, account_id) == 5_000

    after = snapshot(client)
    assert after.json()["revision"] == state.json()["revision"] + 1
    spend = request(after, "transaction.record", {
        "id": str(uuid4()), "account_id": account_id, "kind": "expense",
        "signed_minor": -1_000, "occurred_on": "2026-11-11",
    }, revisions(after, account_id))
    spent = post(client, after, spend)
    assert spent.status_code == 201, spent.text
    assert balance(v2_env, uid, account_id) == 4_000

    current = snapshot(client)
    archive = request(current, "account.archive",
                      {"account_id": account_id}, revisions(current, account_id))
    assert post(client, current, archive).status_code == 201
    archived = snapshot(client)
    invalid = request(archived, "account.update", {
        "account_id": account_id, "name": "Rejected", "kind": "cash",
    }, revisions(archived, account_id))
    reject = post(client, archived, invalid)
    assert reject.status_code == 409
    assert snapshot(client).json()["revision"] == archived.json()["revision"]

    restore = request(archived, "account.unarchive",
                      {"account_id": account_id}, revisions(archived, account_id))
    assert post(client, archived, restore).status_code == 201
    active = snapshot(client)
    edit = request(active, "account.update", {
        "account_id": account_id, "name": "Reopened", "kind": "cash",
    }, revisions(active, account_id))
    assert post(client, active, edit).status_code == 201
    final = snapshot(client)
    acc = next(item for item in final.json()["entities"] if item["id"] == account_id)
    assert acc["data"]["name"] == "Reopened"
    assert acc["data"]["type"] == "cash"
    assert acc["data"]["balance_minor"] == 4_000
    assert acc["data"]["archived_at"] is None


def test_v2_candidate_auth_origin_and_revoked_session(v2_env):
    uid, token = v2_env["first"]
    client = v2_env["v2_client"](token)
    state = snapshot(client)
    create = request(state, "account.create", {
        "id": str(uuid4()), "name": "Own", "kind": "bank",
        "currency": "RUB", "opening_minor": 0,
    })
    anonymous = TestClient(v2_env["v2_app"], base_url=ORIGIN,
                           raise_server_exceptions=False)
    assert post(anonymous, state, create).status_code == 401
    denied = post(client, state, create, **{"Origin": "https://evil.invalid"})
    assert denied.status_code == 403
    assert post(client, state, create,
                **{"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert snapshot(client).json()["revision"] == state.json()["revision"]

    v2_env["store"].logout(token)
    revoked = post(client, state, create)
    assert revoked.status_code == 401
    assert revoked.json()["code"] == "unauthenticated"


def test_v2_candidate_opaque_json_and_request_limits_fail_closed(v2_env):
    uid, token = v2_env["first"]
    client = v2_env["v2_client"](token)
    state = snapshot(client)
    account = {
        "id": str(uuid4()), "name": "Valid", "kind": "bank",
        "currency": "RUB", "opening_minor": 0,
    }
    original = request(state, "account.create", account)
    headers = {"Origin": ORIGIN, "If-Match": state.headers["etag"],
               "Idempotency-Key": original["client_mutation_id"],
               "Content-Type": "application/json"}

    raw = json.dumps(original, ensure_ascii=False)
    duplicated = raw.replace('"opening_minor": 0',
                             '"opening_minor": 0, "opening_minor": 100')
    assert duplicated != raw
    for body in (duplicated, raw.replace('"opening_minor": 0',
                                          '"opening_minor": NaN')):
        bad = client.post("/api/finance/v2/commands", content=body, headers=headers)
        assert bad.status_code == 422
        assert bad.json()["code"] == "invalid_command"

    excess = client.post("/api/finance/v2/commands",
                         content="x" * 33_000, headers=headers)
    assert excess.status_code == 413
    forbidden = request(state, "loan.payment.record",
                        {"account_id": account["id"]})
    assert post(client, state, forbidden).status_code == 422
    wrong_version = {**original, "schema_version": 1}
    assert post(client, state, wrong_version).status_code == 422
    assert snapshot(client).json()["revision"] == state.json()["revision"]


def test_v2_candidate_account_scope_conflict_and_stale_etag(v2_env):
    uid, token = v2_env["first"]
    first = v2_env["v2_client"](token)
    state = snapshot(first)
    account_id = str(uuid4())
    create = request(state, "account.create", {
        "id": account_id, "name": "Owned", "kind": "cash",
        "currency": "RUB", "opening_minor": 500,
    })
    assert post(first, state, create).status_code == 201
    # Two devices authenticated as one user must see server-conflict rather
    # than silently overwrite a committed revision.
    other_device = v2_env["v2_client"](token)
    obsolete = request(state, "account.create", {
        "id": str(uuid4()), "name": "Stale", "kind": "cash",
        "currency": "RUB", "opening_minor": 1_000,
    })
    assert post(other_device, state, obsolete).status_code == 412

    uid_b, token_b = v2_env["new_user"]()
    second_user = v2_env["v2_client"](token_b)
    isolated = snapshot(second_user)
    assert isolated.json()["entities"] == []
    foreign = request(isolated, "account.update", {
        "account_id": account_id, "name": "Foreign", "kind": "cash",
    }, {account_id: 1})
    denied = post(second_user, isolated, foreign)
    assert denied.status_code == 409
    assert snapshot(second_user).json()["entities"] == []
    assert balance(v2_env, uid, account_id) == 500


def test_v2_candidate_missing_or_weak_etag_fails_428_without_cash_mutation(v2_env):
    uid, token = v2_env["first"]
    client = v2_env["v2_client"](token)
    before = snapshot(client)
    command = request(before, "account.create", {
        "id": str(uuid4()), "name": "Precondition guard", "kind": "cash",
        "currency": "RUB", "opening_minor": 700,
    })
    for etag in (None, 'W/"old"', '"broken'):
        headers = {"Origin": ORIGIN, "Idempotency-Key": command["client_mutation_id"]}
        if etag is not None:
            headers["If-Match"] = etag
        denied = client.post("/api/finance/v2/commands", json=command, headers=headers)
        assert denied.status_code == 428, denied.text
        assert denied.json()["code"] == "precondition_required"
    assert snapshot(client).json()["revision"] == before.json()["revision"]


def test_v2_candidate_email_logout_invalidates_both_finance_cookie_paths(v2_env):
    uid, token = v2_env["first"]
    client = v2_env["v2_client"](token)
    before = snapshot(client)
    command = request(before, "account.create", {
        "id": str(uuid4()), "name": "No post after logout", "kind": "cash",
        "currency": "RUB", "opening_minor": 100,
    })
    logout = client.post("/api/auth/email/logout", headers={"Origin": ORIGIN}, json={})
    assert logout.status_code == 200, logout.text
    cookies = logout.headers.get_list("set-cookie")
    assert any(
        "fh_finance_session=" in cookie and "Path=/api/finance/v1" in cookie
        for cookie in cookies
    )
    assert any(
        "fh_finance_session=" in cookie and "Path=/api/finance/v2" in cookie
        for cookie in cookies
    )
    denied = post(client, before, command)
    assert denied.status_code == 401
    assert denied.json()["code"] == "unauthenticated"
    assert v2_env["scope"](uid).user_id == uid

def test_v2_candidate_revoked_during_stream_never_commits(env, v2_env):
    """Live AuthStore revocation after first chunk blocks even a valid SQL command."""
    import asyncio
    import httpx

    uid, token = v2_env["first"]
    client = v2_env["v2_client"](token)
    before = snapshot(client)
    command = request(before, "account.create", {
        "id": str(uuid4()), "name": "Never posted after logout",
        "kind": "cash", "currency": "RUB", "opening_minor": 2_000,
    })
    encoded = json.dumps(command).encode("utf-8")
    midpoint = len(encoded) // 2

    async def revoked_request():
        consumed = asyncio.Event()
        release = asyncio.Event()

        async def stream():
            yield encoded[:midpoint]
            consumed.set()
            await release.wait()
            yield encoded[midpoint:]

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=v2_env["v2_app"]), base_url=ORIGIN,
        ) as remote:
            pending = asyncio.create_task(remote.post(
                "/api/finance/v2/commands", content=stream(),
                headers={
                    "Origin": ORIGIN,
                    "Content-Type": "application/json",
                    "Cookie": f"fh_finance_session={token}",
                    "Idempotency-Key": command["client_mutation_id"],
                    "If-Match": before.headers["etag"],
                    "Transfer-Encoding": "chunked",
                },
            ))
            try:
                await asyncio.wait_for(consumed.wait(), timeout=4)
                await asyncio.to_thread(v2_env["store"].logout, token)
            finally:
                release.set()
            return await asyncio.wait_for(pending, timeout=6)

    result = asyncio.run(revoked_request())
    assert result.status_code == 401, result.text
    assert result.json()["code"] == "unauthenticated"
    from backend.finance_db.ledger_service import get_account_snapshot
    state = get_account_snapshot(v2_env["engine"], scope=v2_env["scope"](uid))
    assert state.body["revision"] == before.json()["revision"]
    assert state.body["entities"] == before.json()["entities"]


@pytest.mark.parametrize("kind,direction", [
    ("loan", "expense"), ("settlement", "expense"), ("settlement", "income"),
])
def test_v2_candidate_linked_record_void_is_one_exact_cash_compensation(v2_env, kind, direction):
    """Real FH session -> v2 HTTP -> RLS PostgreSQL -> second-device snapshot."""
    from sqlalchemy import text
    from backend.finance_db.db import finance_transaction

    uid, token = v2_env["first"]
    c1 = v2_env["v2_client"](token)
    account_id = v2_env["account"](uid, opening=20_000)
    source_id = str(uuid4())
    with finance_transaction(v2_env["engine"], verified_user_id=uid,
                             profile_id=v2_env["scope"](uid).profile_id) as db:
        if kind == "loan":
            db.execute(text("""
                INSERT INTO loans
                 (profile_id,id,title,opening_minor,payment_minor,apr_basis_points,
                  term_months,due_day,as_of_date)
                VALUES (:p,:id,'Synthetic debt',50000,5000,1200,24,8,'2026-11-08')
            """), {"p": v2_env["scope"](uid).profile_id, "id": source_id})
            action = "loan.payment.record"
            payload = {"loan_id": source_id, "account_id": account_id,
                       "amount_minor": 1_200, "paid_on": "2026-11-11", "strategy": "term"}
        else:
            db.execute(text("""
                INSERT INTO obligations
                  (profile_id,id,title,direction,amount_minor,starts_on)
                VALUES (:p,:id,'Synthetic bill',:direction,5000,'2026-11-08')
            """), {"p": v2_env["scope"](uid).profile_id,
                   "id": source_id, "direction": direction})
            action = "settlement.payment.record"
            payload = {"obligation_id": source_id, "account_id": account_id,
                       "amount_minor": 1_200, "paid_on": "2026-11-11",
                       "occurrence_on": "2026-11-08"}

    before = snapshot(c1)
    cmd = request(before, action, payload, revisions(before, account_id, source_id))
    record = post(c1, before, cmd)
    assert record.status_code == 201, record.text
    result = record.json()
    assert result["schema_version"] == 2
    assert len(result["changes"]) == 2
    assert [x["ordinal"] for x in result["changes"]] == [0, 1]
    payment_tx = result["changes"][0]["entity_id"]
    payment_fact = result["changes"][1]["entity_id"]
    assert payment_tx not in (source_id, account_id, payment_fact)
    signed = 1_200 if kind == "settlement" and direction == "income" else -1_200
    assert result["changes"][0]["payload"]["signed_minor"] == signed
    assert result["changes"][1]["payload"]["entity"]["data"]["voided_at"] is None
    assert balance(v2_env, uid, account_id) == 20_000 + signed

    # Stable server-generated identifiers preserve the original fingerprint.
    replay = post(c1, before, cmd)
    assert replay.status_code == 200 and replay.json()["replayed"] is True
    assert replay.json()["revision"] == result["revision"]
    assert replay.json()["changes"][0]["entity_id"] == payment_tx
    assert replay.json()["changes"][1]["entity_id"] == payment_fact
    assert balance(v2_env, uid, account_id) == 20_000 + signed

    # Other authenticated device sees exact same committed state.
    c2 = v2_env["v2_client"](token)
    after = snapshot(c2)
    assert next(x for x in after.json()["entities"]
                if x["id"] == account_id)["data"]["balance_minor"] == 20_000 + signed
    undo = request(after, "loan.payment.void" if kind == "loan" else "settlement.payment.void",
                   {"transaction_id": payment_tx, "fact_id": payment_fact,
                    "account_id": account_id, "reason": "Ошибка платежа"},
                   revisions(after, account_id, payment_tx, payment_fact))
    compensated = post(c2, after, undo)
    assert compensated.status_code == 201, compensated.text
    cancel = compensated.json()
    assert cancel["schema_version"] == 2
    assert len(cancel["changes"]) == 2
    assert cancel["changes"][0]["payload"]["reversed_transaction_id"] == payment_tx
    assert cancel["changes"][0]["payload"]["entity"]["data"]["postings"] == [{
        "account_id": account_id, "signed_minor": -signed,
    }]
    assert cancel["changes"][1]["entity_id"] == payment_fact
    assert cancel["changes"][1]["entity_revision"] == 2
    assert cancel["changes"][1]["payload"]["entity"]["data"]["voided_at"] is not None
    assert balance(v2_env, uid, account_id) == 20_000

    original_replay = post(c2, after, undo)
    assert original_replay.status_code == 200
    assert original_replay.json()["replayed"] is True
    fresh = snapshot(c1)
    second_void = request(fresh, undo["action"], undo["payload"],
                          revisions(fresh, account_id, payment_tx, payment_fact))
    rejected = post(c1, fresh, second_void)
    assert rejected.status_code == 409
    assert balance(v2_env, uid, account_id) == 20_000
    delta = c1.get("/api/finance/v1/changes", params={
        "since_revision": after.json()["revision"], "limit_revisions": 1,
    })
    assert delta.status_code == 200, delta.text
    assert delta.json()["changes"] == cancel["changes"]


def test_v2_candidate_linked_payment_cannot_be_voided_by_other_user(v2_env):
    from sqlalchemy import text
    from backend.finance_db.db import finance_transaction

    uid, token = v2_env["first"]
    owner = v2_env["v2_client"](token)
    account_id = v2_env["account"](uid, opening=12_000)
    loan_id = str(uuid4())
    with finance_transaction(v2_env["engine"], verified_user_id=uid,
                             profile_id=v2_env["scope"](uid).profile_id) as db:
        db.execute(text("""
            INSERT INTO loans
             (profile_id,id,title,opening_minor,payment_minor,apr_basis_points,
              term_months,due_day,as_of_date)
            VALUES (:p,:id,'Private loan',20000,2000,1000,12,8,'2026-11-08')
        """), {"p": v2_env["scope"](uid).profile_id, "id": loan_id})
    before = snapshot(owner)
    record = post(owner, before, request(before, "loan.payment.record", {
        "loan_id": loan_id, "account_id": account_id,
        "amount_minor": 900, "paid_on": "2026-11-11", "strategy": "term",
    }, revisions(before, account_id, loan_id)))
    assert record.status_code == 201, record.text
    transaction_id = record.json()["changes"][0]["entity_id"]
    fact_id = record.json()["changes"][1]["entity_id"]

    other_uid, other_token = v2_env["new_user"]()
    other = v2_env["v2_client"](other_token)
    foreign = snapshot(other)
    attempt = request(foreign, "loan.payment.void", {
        "transaction_id": transaction_id, "fact_id": fact_id,
        "account_id": account_id, "reason": "Unauthorized refund",
    }, {transaction_id: 1, fact_id: 1, account_id: 2})
    denied = post(other, foreign, attempt)
    assert denied.status_code == 409
    assert balance(v2_env, uid, account_id) == 11_100
    assert snapshot(other).json()["entities"] == []
