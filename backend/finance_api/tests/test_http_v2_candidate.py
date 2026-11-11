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
