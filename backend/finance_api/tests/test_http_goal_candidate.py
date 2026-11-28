"""#37 protected HTTP candidate, real FH session and disposable PostgreSQL."""
from uuid import uuid4
import os

import pytest
from fastapi.testclient import TestClient

from backend.fh_email_auth.app import create_app
from backend.fh_email_auth.config import Settings
from backend.finance_api.tests.test_http import COOKIE, NAMESPACE, ORIGIN, engine, env
from backend.finance_api.tests.test_http_v2_candidate import snapshot, request, post

pytestmark = pytest.mark.skipif(os.getenv("FH_FINANCE_CI_ALLOW_BOOTSTRAP") != "yes",
                               reason="Disposable synthetic PostgreSQL only")


@pytest.fixture
def goals_env(env):
    actor, token = env["first"]
    _, other_token = env["new_user"]()
    store = env["store"]
    config = Settings(True, ORIGIN, store.path, "r"*48, "synthetic-turnstile",
        "synthetic-site", "smtp.invalid", 465, "synthetic-user", "synthetic-password",
        "noreply@example.invalid", True)

    def make(enabled):
        return create_app(config=config, store=store, finance_engine=env["engine"],
            finance_profile_namespace=NAMESPACE, enable_account_v2_candidate=True,
            enable_goal_candidate=enabled, finance_sync_allowed_actor=actor)

    def client(app, cookie, allowed):
        c = TestClient(app, base_url=ORIGIN, raise_server_exceptions=False)
        c.cookies.set(COOKIE, cookie, domain="127.0.0.1", path="/api/auth")
        boot = c.post("/api/auth/email/finance/session", headers={"Origin": ORIGIN}, json={})
        assert boot.status_code == 200
        assert (boot.json().get("goal_commands_v1") is True) is allowed
        return c, boot.json()["profile_id"]

    active = make(True)
    owner, profile = client(active, token, True)
    foreign, foreign_profile = client(active, other_token, False)
    disabled, _ = client(make(False), token, False)
    yield owner, profile, foreign, foreign_profile, disabled, active
    for c in (owner, foreign, disabled):
        c.close()


def test_goal_command_opt_in_and_real_http_replay(goals_env):
    owner, profile, foreign, foreign_profile, disabled, active = goals_env
    aid, gid = str(uuid4()), str(uuid4())
    start = snapshot(owner)
    created = request(start, "account.create", {"id": aid, "name": "Synthetic",
        "kind": "cash", "currency": "RUB", "opening_minor": 100_000})
    assert post(owner, start, created).status_code == 201
    initial = snapshot(owner)
    body = request(initial, "goal.append", {})
    body["payload"] = {"goal_id": gid, "account_id": aid, "event": {
        "id": body["client_mutation_id"], "type": "create", "on": "2026-01-01",
        "title": "Synthetic", "category": "other", "targetCents": 120_000,
        "targetDate": "2027-01-01", "openingCents": 40_000, "monthlyCents": None,
        "plannedFunding": "virtual"}}
    body["expected_entity_revisions"] = {aid: 1}
    assert post(disabled, initial, body).status_code == 422
    other = snapshot(foreign)
    foreign_body = {**body, "base_revision": other.json()["revision"]}
    assert post(foreign, other, foreign_body).status_code == 403
    assert post(owner, initial, body, Origin="https://foreign.invalid").status_code == 403
    assert post(owner, initial, body, **{"X-FH-Expected-Profile": foreign_profile}).status_code == 403
    with TestClient(active, base_url=ORIGIN, raise_server_exceptions=False) as anonymous:
        assert post(anonymous, initial, body).status_code == 401
    assert snapshot(owner).json()["revision"] == initial.json()["revision"]
    accepted = post(owner, initial, body, **{"X-FH-Expected-Profile": profile, "X-FH-Offline-Sync": "1"})
    assert accepted.status_code == 201, accepted.text
    assert accepted.headers["cache-control"] == "private, no-store"
    retry = post(owner, initial, body)
    assert retry.status_code == 200 and retry.json()["replayed"] is True
    after = snapshot(owner).json()
    assert after["revision"] == initial.json()["revision"]+1
    goal = next(e for e in after["entities"] if e["kind"] == "goal")
    assert goal["data"]["saved_minor"] == 40_000
    account = next(e for e in after["entities"] if e["id"] == aid)
    assert account["data"]["balance_minor"] == 100_000
    assert account["data"]["available_minor"] == 60_000
    assert not [e for e in snapshot(foreign).json()["entities"] if e["kind"] == "goal"]
    journal = owner.get("/api/finance/v1/commands/" + body["client_mutation_id"] + "/changes")
    assert journal.status_code == 200
    assert journal.json()["changes"] == accepted.json()["changes"]
