"""Budget transport tests: real synthetic AuthStore and PostgreSQL, owner-only."""
from uuid import uuid4
import os

import pytest
from fastapi.testclient import TestClient

from backend.fh_email_auth.app import create_app
from backend.fh_email_auth.config import Settings
from backend.finance_api.tests.test_http import COOKIE, NAMESPACE, ORIGIN, engine, env
from backend.finance_api.tests.test_http_v2_candidate import snapshot, request, post

pytestmark = pytest.mark.skipif(
    os.getenv("FH_FINANCE_CI_ALLOW_BOOTSTRAP") != "yes",
    reason="Dedicated synthetic PostgreSQL only",
)


@pytest.fixture
def budget_env(env):
    actor, token = env["first"]
    other, other_token = env["new_user"]()
    store = env["store"]
    config = Settings(
        True, ORIGIN, store.path, "r" * 48, "synthetic-turnstile", "synthetic-site",
        "smtp.invalid", 465, "synthetic-user", "synthetic-password",
        "noreply@example.invalid", True,
    )

    def make(enabled):
        return create_app(
            config=config, store=store, finance_engine=env["engine"],
            finance_profile_namespace=NAMESPACE, enable_account_v2_candidate=True,
            enable_budget_candidate=enabled, finance_sync_allowed_actor=actor,
        )

    def client(app, cookie, allowed):
        c = TestClient(app, base_url=ORIGIN, raise_server_exceptions=False)
        c.cookies.set(COOKIE, cookie, domain="127.0.0.1", path="/api/auth")
        boot = c.post("/api/auth/email/finance/session", headers={"Origin": ORIGIN}, json={})
        assert boot.status_code == 200
        assert (boot.json().get("budget_commands_v1") is True) is allowed
        return c, boot.json()["profile_id"]

    active = make(True)
    owner, profile = client(active, token, True)
    foreign, foreign_profile = client(active, other_token, False)
    disabled, _ = client(make(False), token, False)
    yield owner, profile, foreign, foreign_profile, disabled, active
    for c in (owner, foreign, disabled):
        c.close()


def rule():
    return {"id": str(uuid4()), "category_id": None, "limit_minor": 1_000_000,
            "recurrence": "monthly", "from_month": "2026-01"}


def test_budget_feature_is_explicit_owner_only_and_no_unauthorized_write(budget_env):
    owner, profile, foreign, foreign_profile, disabled, active = budget_env
    initial = snapshot(owner)
    body = request(initial, "budget.create", rule())
    assert post(disabled, initial, body).status_code == 422
    other_state = snapshot(foreign)
    assert post(foreign, other_state, request(other_state, "budget.create", rule())).status_code == 403
    assert post(owner, initial, body, Origin="https://foreign.invalid").status_code == 403
    assert post(owner, initial, body, **{"X-FH-Expected-Profile": foreign_profile}).status_code == 403
    with TestClient(active, base_url=ORIGIN, raise_server_exceptions=False) as anonymous:
        assert post(anonymous, initial, body).status_code == 401
    assert snapshot(owner).json()["revision"] == initial.json()["revision"]
    assert snapshot(foreign).json()["revision"] == other_state.json()["revision"]
    accepted = post(owner, initial, body, **{"X-FH-Expected-Profile": profile, "X-FH-Offline-Sync": "1"})
    assert accepted.status_code == 201, accepted.text
    assert accepted.headers["cache-control"] == "private, no-store"
    replay = post(owner, initial, body)
    assert replay.status_code == 200 and replay.json()["replayed"] is True
    after = snapshot(owner)
    assert after.json()["revision"] == initial.json()["revision"] + 1
    assert len([e for e in after.json()["entities"] if e["kind"] == "budget_rule"]) == 1
    assert not [e for e in snapshot(foreign).json()["entities"] if e["kind"].startswith("budget_")]
    journal = owner.get("/api/finance/v1/commands/" + body["client_mutation_id"] + "/changes")
    assert journal.status_code == 200
    assert journal.json()["changes"] == accepted.json()["changes"]


def test_budget_cancel_fences_exact_command_and_stale_revision(budget_env):
    owner, _, _, _, _, _ = budget_env
    initial = snapshot(owner)
    body = request(initial, "budget.create", rule())
    headers = {"Origin": ORIGIN, "If-Match": initial.headers["etag"],
               "Idempotency-Key": body["client_mutation_id"]}
    cancelled = owner.post("/api/finance/v2/commands/cancel", json=body, headers=headers)
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["code"] == "command_cancelled"
    rejected = post(owner, initial, body)
    assert rejected.status_code == 409 and rejected.json()["code"] == "command_cancelled"
    assert snapshot(owner).json()["revision"] == initial.json()["revision"]
    good = request(initial, "budget.create", rule())
    assert post(owner, initial, good).status_code == 201
    stale = request(initial, "budget.create", rule())
    assert post(owner, initial, stale).status_code == 412


@pytest.mark.parametrize("patch", [
    {"limit_minor": 0.5}, {"limit_minor": True}, {"limit_minor": -1},
    {"from_month": "0000-01"}, {"from_month": "2026-13"},
    {"profile_id": str(uuid4())}, {"actor_user_id": "a" * 32},
])
def test_budget_payload_rejects_bad_money_dates_and_caller_scope(budget_env, patch):
    owner, _, _, _, _, _ = budget_env
    initial = snapshot(owner)
    bad = request(initial, "budget.create", {**rule(), **patch})
    assert post(owner, initial, bad).status_code == 422
    assert snapshot(owner).json()["revision"] == initial.json()["revision"]


def test_budget_parser_rejects_duplicate_keys_and_weak_etag(budget_env):
    owner, _, _, _, _, _ = budget_env
    initial = snapshot(owner)
    body = request(initial, "budget.create", rule())
    assert post(owner, initial, body, **{"If-Match": 'W/"weak"'}).status_code == 428
    import json
    raw = json.dumps(body).replace('"limit_minor": 1000000', '"limit_minor": 1, "limit_minor": 1000000')
    assert raw.count('"limit_minor"') == 2
    response = owner.post("/api/finance/v2/commands", content=raw, headers={
        "Origin": ORIGIN, "Content-Type": "application/json",
        "If-Match": initial.headers["etag"], "Idempotency-Key": body["client_mutation_id"],
    })
    assert response.status_code == 422
    assert snapshot(owner).json()["revision"] == initial.json()["revision"]
