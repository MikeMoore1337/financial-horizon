"""Finance API integration on disposable real PostgreSQL + real AuthStore SQLite."""
from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from backend.fh_email_auth.app import create_app
from backend.fh_email_auth.config import Settings
from backend.fh_email_auth.store import AuthStore
from backend.finance_db.db import create_finance_engine
from backend.finance_db.ledger_service import (
    derive_verified_scope, get_account_snapshot, submit_account_command,
)

ORIGIN = "http://127.0.0.1:8791"
PASS = "A-strong-passphrase-98520!"


class SyntheticMailer:
    def __init__(self):
        self.sent = []

    def send(self, email, purpose, token):
        self.sent.append((email, purpose, token))
        return True

    def latest(self, purpose):
        return next(token for _, p, token in reversed(self.sent) if p == purpose)


@pytest.fixture
def auth_finance(tmp_path):
    if os.environ.get("FH_FINANCE_CI_ALLOW_BOOTSTRAP") != "yes":
        pytest.skip("Disposable real PostgreSQL and synthetic auth only")
    config = Settings(
        True, ORIGIN, tmp_path / "auth.sqlite", "h" * 48,
        "synthetic-turnstile-secret", "synthetic-site",
        "smtp.test.invalid", 465, "synthetic-user", "synthetic-password",
        "noreply@test.invalid", True,
    )
    engine = create_finance_engine()
    store = AuthStore(config.database_path)
    mail = SyntheticMailer()
    namespace = uuid4()  # Server-only stable namespace for this synthetic test.
    app = create_app(
        config=config, store=store, mailer=mail,
        captcha=lambda secret, token, origin, action:
            secret == "synthetic-turnstile-secret" and
            origin == ORIGIN and token == "valid-" + action,
        finance_engine=engine, finance_profile_namespace=namespace,
    )
    with TestClient(app) as client:
        yield client, app, mail, store, engine, namespace
    engine.dispose()


def authenticate(client, mail, email="synthetic@example.invalid"):
    response = client.post("/api/auth/email/register", headers={"Origin": ORIGIN}, json={
        "email": email, "challenge": "valid-register",
    })
    assert response.status_code == 202
    response = client.post("/api/auth/email/verify", headers={"Origin": ORIGIN}, json={
        "token": mail.latest("verify"), "password": PASS,
    })
    assert response.status_code == 200
    return client.get("/api/auth/email/me").json()["user"]["id"]


def bootstrap(client):
    return client.post("/api/auth/email/finance/session",
                       headers={"Origin": ORIGIN}, json={})


def seed(engine, scope, opening, kind="bank"):
    snap = get_account_snapshot(engine, scope=scope)
    acc = str(uuid4())
    mutation = str(uuid4())
    command = {
        "schema_version": 1, "client_mutation_id": mutation,
        "base_revision": snap.body["revision"],
        "action": "account.create",
        "expected_entity_revisions": {},
        "payload": {
            "id": acc, "name": "Synthetic account", "kind": kind,
            "currency": "RUB", "opening_minor": opening,
        },
    }
    result = submit_account_command(
        engine, scope=scope, command=command, if_match=snap.etag,
        idempotency_key=mutation, allow_internal=True,
    )
    assert result.status == 201
    return acc


def test_opt_in_finance_routes_reject_anonymous_requests_and_unsafe_origins(auth_finance):
    client, _, mail, _, _, _ = auth_finance
    assert bootstrap(client).status_code == 401
    assert client.get("/api/finance/v1/state").status_code == 401
    assert client.get("/api/finance/v1/changes?since_revision=0").status_code == 401
    assert client.post("/api/finance/v1/commands",
                       headers={"Origin": ORIGIN}, json={}).status_code == 401

    authenticate(client, mail)
    assert client.post("/api/auth/email/finance/session", json={}).status_code == 403
    assert client.post("/api/auth/email/finance/session",
                       headers={"Origin": "https://evil.invalid"}, json={}).status_code == 403
    assert bootstrap(client).status_code == 200
    assert client.get("/api/finance/v1/state").status_code == 200
    assert client.post("/api/finance/v1/commands", json={}).status_code == 403
    assert client.post("/api/finance/v1/commands",
                       headers={"Origin": "https://evil.invalid"}, json={}).status_code == 403


def test_session_bridge_is_scoped_cookie_and_logout_revokes_entire_finance_access(auth_finance):
    client, _, mail, store, _, _ = auth_finance
    authenticate(client, mail)
    result = bootstrap(client)
    assert result.status_code == 200
    assert result.json()["ok"] is True
    cookies = list(client.cookies.jar)
    finance = next(c for c in cookies if c.name == "fh_finance_session")
    auth = next(c for c in cookies if c.name == "fh_email_session")
    assert auth.path == "/api/auth"
    assert finance.path == "/api/finance/v1"
    assert "HttpOnly" in finance._rest
    assert finance.get_nonstandard_attr("SameSite") == "strict"
    assert result.headers["cache-control"].find("no-store") >= 0

    state = client.get("/api/finance/v1/state")
    assert state.status_code == 200
    assert state.headers["Cache-Control"] == "private, no-store"
    assert state.headers["ETag"].startswith('"fh.1.0.')
    assert state.json()["entities"] == []
    assert "email" not in state.text and "synthetic@example.invalid" not in state.text
    changes = client.get("/api/finance/v1/changes?since_revision=0")
    assert changes.status_code == 200
    assert changes.json()["changes"] == []

    assert client.post("/api/auth/email/logout",
                       headers={"Origin": ORIGIN}, json={}).status_code == 200
    assert store.current(auth.value) is None
    assert client.get("/api/finance/v1/state").status_code == 401


def test_v1_transfer_idempotency_and_revision_conflict_from_real_authenticated_browser(auth_finance):
    client, _, mail, _, engine, namespace = auth_finance
    uid = authenticate(client, mail)
    assert bootstrap(client).status_code == 200
    scope = derive_verified_scope(uid, namespace)
    a = seed(engine, scope, 10_000)
    b = seed(engine, scope, 500, "cash")
    state = client.get("/api/finance/v1/state")
    assert state.status_code == 200
    assert {x["kind"] for x in state.json()["entities"]} == {"account"}
    etag = state.headers["etag"]
    versions = {x["id"]: x["entity_revision"] for x in state.json()["entities"]}
    mutation = str(uuid4())
    command = {
        "schema_version": 1, "client_mutation_id": mutation,
        "base_revision": state.json()["revision"], "action": "account.transfer",
        "expected_entity_revisions": {a: versions[a], b: versions[b]},
        "payload": {
            "from_account_id": a, "to_account_id": b,
            "amount_minor": 1000, "occurred_on": "2026-11-08",
        },
    }
    headers = {"Origin": ORIGIN, "If-Match": etag,
               "Idempotency-Key": mutation}
    posted = client.post("/api/finance/v1/commands", json=command, headers=headers)
    assert posted.status_code == 201, posted.text
    assert posted.json()["replayed"] is False
    repeated = client.post("/api/finance/v1/commands", json=command, headers=headers)
    assert repeated.status_code == 200
    assert repeated.json()["replayed"] is True
    assert repeated.json()["revision"] == posted.json()["revision"]

    now = client.get("/api/finance/v1/state")
    assert now.status_code == 200
    accounts = {x["id"]: x["data"] for x in now.json()["entities"] if x["kind"] == "account"}
    assert accounts[a]["balance_minor"] == 9000
    assert accounts[b]["balance_minor"] == 1500
    txs = [x for x in now.json()["entities"] if x["kind"] == "transaction"]
    assert len(txs) == 1
    assert sorted(x["signed_minor"] for x in txs[0]["data"]["postings"]) == [-1000, 1000]
    assert client.get("/api/finance/v1/changes?since_revision=0").status_code == 200

    other = {**command, "client_mutation_id": str(uuid4())}
    old = client.post("/api/finance/v1/commands", json=other,
                      headers={**headers, "Idempotency-Key": other["client_mutation_id"]})
    assert old.status_code == 412
    assert old.json()["code"] == "stale_revision"
    changed = {**command, "payload": {**command["payload"], "amount_minor": 400}}
    reuse = client.post("/api/finance/v1/commands", json=changed, headers=headers)
    assert reuse.status_code == 409
    assert reuse.json()["code"] == "idempotency_key_reuse"


def test_public_v1_rejects_unapproved_account_creation_and_cross_scope_data(auth_finance):
    client, app, mail, _, engine, namespace = auth_finance
    first_user = authenticate(client, mail, "first@example.invalid")
    assert bootstrap(client).status_code == 200
    first_account = seed(engine, derive_verified_scope(first_user, namespace), 300)
    before = client.get("/api/finance/v1/state")
    mutation = str(uuid4())
    draft = {
        "schema_version": 1, "client_mutation_id": mutation,
        "base_revision": before.json()["revision"], "action": "account.create",
        "expected_entity_revisions": {}, "payload": {
            "id": str(uuid4()), "name": "Unapproved",
            "kind": "cash", "currency": "RUB", "opening_minor": 999,
        },
    }
    res = client.post("/api/finance/v1/commands", json=draft, headers={
        "Origin": ORIGIN, "If-Match": before.headers["ETag"],
        "Idempotency-Key": mutation,
    })
    assert res.status_code == 422 and res.json()["code"] == "invalid_command"

    # A separate browser with independent AuthStore session cannot read the first budget.
    with TestClient(app) as other:
        second_user = authenticate(other, mail, "second@example.invalid")
        assert bootstrap(other).status_code == 200
        other_state = other.get("/api/finance/v1/state")
        assert other_state.status_code == 200
        assert other_state.json()["profile_id"] != before.json()["profile_id"]
        assert first_account not in other_state.text
        assert other_state.json()["entities"] == []
        assert second_user != first_user


def test_two_authenticated_sessions_sync_the_same_server_ledger_without_double_post(auth_finance):
    first, app, mail, _, engine, namespace = auth_finance
    owner_id = authenticate(first, mail, "sync@example.invalid")
    assert bootstrap(first).status_code == 200
    scope = derive_verified_scope(owner_id, namespace)
    from_id = seed(engine, scope, 20_000)
    to_id = seed(engine, scope, 1_000)

    with TestClient(app) as second:
        login = second.post("/api/auth/email/login", headers={"Origin": ORIGIN}, json={
            "email": "sync@example.invalid", "password": PASS,
        })
        assert login.status_code == 200
        assert bootstrap(second).status_code == 200
        assert first.cookies.get("fh_finance_session") != second.cookies.get("fh_finance_session")
        initial_first = first.get("/api/finance/v1/state")
        initial_second = second.get("/api/finance/v1/state")
        assert initial_first.status_code == initial_second.status_code == 200
        assert initial_first.json()["profile_id"] == initial_second.json()["profile_id"]
        assert initial_first.json()["revision"] == initial_second.json()["revision"]
        assert initial_first.headers["ETag"] == initial_second.headers["ETag"]

        revision = initial_first.json()["revision"]
        versions = {e["id"]: e["entity_revision"] for e in initial_first.json()["entities"]}
        mutation = str(uuid4())
        command = {
            "schema_version": 1, "client_mutation_id": mutation,
            "base_revision": revision, "action": "account.transfer",
            "expected_entity_revisions": {
                from_id: versions[from_id], to_id: versions[to_id],
            },
            "payload": {
                "from_account_id": from_id, "to_account_id": to_id,
                "amount_minor": 2_500, "occurred_on": "2026-11-08",
            },
        }
        headers = {
            "Origin": ORIGIN,
            "If-Match": initial_first.headers["ETag"],
            "Idempotency-Key": mutation,
        }
        written = first.post("/api/finance/v1/commands", json=command, headers=headers)
        assert written.status_code == 201
        # Simulates offline-reconnect retry from the other browser.
        replay = second.post("/api/finance/v1/commands", json=command, headers=headers)
        assert replay.status_code == 200 and replay.json()["replayed"] is True
        latest = second.get("/api/finance/v1/state")
        assert latest.json()["revision"] == revision + 1
        balances = {
            e["id"]: e["data"]["balance_minor"]
            for e in latest.json()["entities"] if e["kind"] == "account"
        }
        assert balances == {from_id: 17_500, to_id: 3_500}
        changes = second.get(f"/api/finance/v1/changes?since_revision={revision}")
        assert changes.status_code == 200
        assert changes.json()["next_since_revision"] == revision + 1

        # A second writer using the old snapshot must not silently overwrite cash.
        different = {**command, "client_mutation_id": str(uuid4())}
        stale_headers = {**headers, "Idempotency-Key": different["client_mutation_id"]}
        conflict = second.post("/api/finance/v1/commands", json=different, headers=stale_headers)
        assert conflict.status_code == 412 and conflict.json()["code"] == "stale_revision"
        assert first.get("/api/finance/v1/state").json()["revision"] == revision + 1


def test_session_revocation_invalidates_finance_cookie_on_second_device(auth_finance):
    first, app, mail, _, _, _ = auth_finance
    authenticate(first, mail, "revocation@example.invalid")
    assert bootstrap(first).status_code == 200
    with TestClient(app) as second:
        login = second.post("/api/auth/email/login", headers={"Origin": ORIGIN}, json={
            "email": "revocation@example.invalid", "password": PASS,
        })
        assert login.status_code == 200
        assert bootstrap(second).status_code == 200
        assert second.get("/api/finance/v1/state").status_code == 200
        logout_others = first.post(
            "/api/auth/email/logout-others", headers={"Origin": ORIGIN}, json={},
        )
        assert logout_others.status_code == 200
        assert first.get("/api/finance/v1/state").status_code == 200
        # Raw finance cookie remains in remote browser, but the backend SQLite
        # token is revoked, so PostgreSQL must not be consulted as that principal.
        assert second.get("/api/finance/v1/state").status_code == 401
        mutation = str(uuid4())
        assert second.post("/api/finance/v1/commands", headers={
            "Origin": ORIGIN, "If-Match": '"dummy"',
            "Idempotency-Key": mutation,
        }, json={
            "schema_version": 1, "client_mutation_id": mutation,
            "base_revision": 0, "action": "transaction.reverse",
            "expected_entity_revisions": {},
            "payload": {"transaction_id": str(uuid4()), "reason": "revoked"},
        }).status_code == 401


def test_blocked_sql_command_never_stalls_unrelated_auth_requests(auth_finance):
    """A blocked finance command must run in a worker, not the ASGI event loop."""
    client, _, mail, _, _, _ = auth_finance
    authenticate(client, mail)
    assert bootstrap(client).status_code == 200
    entered, release = Event(), Event()

    def blocked_command(*args, **kwargs):
        from backend.finance_db.ledger_service import FinanceResult
        entered.set()
        if not release.wait(timeout=5):
            raise AssertionError("Test never released the simulated SQL lock")
        return FinanceResult(201, {"ok": True}, '"synthetic-test-etag"')

    mutation_id = str(uuid4())
    # A valid wire DTO must reach the mock SQL worker; an empty JSON is
    # correctly rejected by the stricter v1 boundary before reaching it.
    envelope = {
        "schema_version": 1, "client_mutation_id": mutation_id,
        "base_revision": 0, "action": "account.transfer",
        "expected_entity_revisions": {},
        "payload": {"from_account_id": str(uuid4()), "to_account_id": str(uuid4()),
                    "amount_minor": 1, "occurred_on": "2026-11-08"},
    }
    with patch("backend.finance_db.finance_router.submit_account_command", blocked_command):
        with ThreadPoolExecutor(max_workers=2) as pool:
            command = pool.submit(
                client.post, "/api/finance/v1/commands",
                json=envelope, headers={"Origin": ORIGIN, "Idempotency-Key": mutation_id,
                                        "If-Match": '"synthetic-etag"'},
            )
            assert entered.wait(timeout=3), "The finance worker did not start"
            try:
                auth = pool.submit(client.get, "/api/auth/email/me")
                user = auth.result(timeout=1.5)
                assert user.status_code == 200
                assert user.json()["authenticated"] is True
            finally:
                release.set()
            assert command.result(timeout=3).status_code == 201


def test_finance_command_auth_session_lookup_uses_worker_not_asgi_event_loop():
    """Even a slow synchronous AuthStore.current must not stop unrelated async routes."""
    from fastapi import FastAPI
    from threading import get_ident
    from backend.finance_db.finance_router import mount_finance_routes

    observed = []
    app = FastAPI()

    def synthetic_auth(token):
        observed.append(get_ident())
        return {"id": "a" * 32} if token == "test-session" else None

    # This test probes scheduler isolation only. Its invalid JSON never
    # reaches SQL, so a dialect-only stub is safe here (the separate
    # integration suite always uses actual disposable PostgreSQL).
    from types import SimpleNamespace
    dialect_only_engine = SimpleNamespace(dialect=SimpleNamespace(name="postgresql"))
    mount_finance_routes(
        app, engine=dialect_only_engine, namespace=uuid4(), public_origin=ORIGIN,
        auth_resolver=synthetic_auth, secure_cookie=False,
        rate_limiter=lambda request, action: None,
    )

    @app.get("/synthetic-loop-thread")
    async def loop_thread():
        return {"thread_id": get_ident()}

    with TestClient(app) as client:
        event_loop_thread = client.get("/synthetic-loop-thread").json()["thread_id"]
        client.cookies.set(
            "fh_finance_session", "test-session", path="/api/finance/v1",
        )
        response = client.post(
            "/api/finance/v1/commands", json={},
            headers={"Origin": ORIGIN},
        )
        assert response.status_code == 422
        assert observed, "Finance scope must resolve the actual session"
        assert observed[-1] != event_loop_thread


def test_chunked_finance_request_rejects_oversized_stream_without_length(auth_finance):
    client, _, mail, _, _, _ = auth_finance
    authenticate(client, mail)
    assert bootstrap(client).status_code == 200

    def large_chunks():
        yield b'{"schema_version":1,'
        for _ in range(10):
            yield b" " * 4096

    response = client.post("/api/finance/v1/commands", content=large_chunks(),
                           headers={"Origin": ORIGIN,
                                    "Content-Type": "application/json",
                                    "Transfer-Encoding": "chunked"})
    assert response.status_code == 413
    assert response.json()["code"] == "invalid_command"
    assert "Слишком большой запрос" in response.text

    def small_chunks():
        yield b"{"
        yield b"}"

    tiny = client.post("/api/finance/v1/commands", content=small_chunks(),
                       headers={"Origin": ORIGIN,
                                "Content-Type": "application/json",
                                "Transfer-Encoding": "chunked"})
    assert tiny.status_code == 422
    assert tiny.json()["code"] == "invalid_command"


def test_session_revoked_between_stream_chunks_never_commits_financial_transfer(auth_finance):
    """Real AuthStore revocation DURING the body cannot authorize a delayed write."""
    import asyncio
    import json
    import httpx

    client, app, mail, store, engine, namespace = auth_finance
    user_id = authenticate(client, mail)
    assert bootstrap(client).status_code == 200
    token = next(c.value for c in client.cookies.jar if c.name == "fh_finance_session")
    scope = derive_verified_scope(user_id, namespace)
    a = seed(engine, scope, 5000)
    b = seed(engine, scope, 200)
    snapshot = get_account_snapshot(engine, scope=scope)
    versions = {x["id"]: x["entity_revision"] for x in snapshot.body["entities"]}
    mutation = str(uuid4())
    command = {
        "schema_version": 1, "client_mutation_id": mutation,
        "base_revision": snapshot.body["revision"],
        "expected_entity_revisions": {a: versions[a], b: versions[b]},
        "action": "account.transfer", "payload": {
            "from_account_id": a, "to_account_id": b,
            "amount_minor": 1000, "occurred_on": "2026-11-08",
        },
    }
    encoded = json.dumps(command).encode("utf-8")
    half = len(encoded) // 2

    async def revoke_mid_body():
        first_consumed = asyncio.Event()
        finish_body = asyncio.Event()

        async def delayed_body():
            yield encoded[:half]
            # This executes only when ASGI requests another body chunk, so the
            # initial command handler session lookup already completed.
            first_consumed.set()
            await finish_body.wait()
            yield encoded[half:]

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url=ORIGIN,
        ) as other_client:
            pending = asyncio.create_task(other_client.post(
                "/api/finance/v1/commands", content=delayed_body(),
                headers={
                    "Origin": ORIGIN, "Content-Type": "application/json",
                    "Cookie": f"fh_finance_session={token}",
                    "Idempotency-Key": mutation, "If-Match": snapshot.etag,
                    "Transfer-Encoding": "chunked",
                },
            ))
            try:
                await asyncio.wait_for(first_consumed.wait(), timeout=4)
                # Model a logout-others event on another authenticated device.
                await asyncio.to_thread(store.logout, token)
            finally:
                finish_body.set()
            return await asyncio.wait_for(pending, timeout=6)

    result = asyncio.run(revoke_mid_body())
    assert result.status_code == 401, result.text
    assert store.current(token) is None
    after = get_account_snapshot(engine, scope=scope)
    assert after.body["revision"] == snapshot.body["revision"]
    accounts = {x["id"]: x["data"]["balance_minor"] for x in after.body["entities"]}
    assert accounts == {a: 5000, b: 200}
    from backend.finance_db.db import finance_transaction
    from sqlalchemy import text

    with finance_transaction(engine, verified_user_id=user_id, profile_id=scope.profile_id) as tx:
        assert tx.execute(text("SELECT count(*) FROM ledger_postings")).scalar_one() == 0
        assert tx.execute(text("""
            SELECT count(*) FROM command_receipts WHERE client_mutation_id=:mid
        """), {"mid": mutation}).scalar_one() == 0
