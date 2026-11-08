"""Real PostgreSQL + real FH SQLite-session HTTP regressions for #67.

No mocks of the financial database. Every fixture uses synthetic identities and
the dedicated, disposable PostgreSQL service in GitHub Actions.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import date
import os
from pathlib import Path
import sqlite3
import json
import time
from uuid import UUID, uuid4

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import text

from backend.fh_email_auth.app import create_app
from backend.fh_email_auth.config import Settings
COOKIE = "fh_email_session"
from backend.fh_email_auth.security import token_hash
from backend.fh_email_auth.store import AuthStore
from backend.finance_db.db import create_finance_engine, finance_transaction
from backend.finance_db.ledger_service import (
    ensure_verified_profile, get_account_snapshot, submit_account_command,
)

pytestmark = pytest.mark.skipif(
    os.getenv("FH_FINANCE_CI_ALLOW_BOOTSTRAP") != "yes",
    reason="Requires dedicated disposable PostgreSQL and explicit CI bootstrap",
)
ORIGIN = "http://127.0.0.1:8791"
NAMESPACE = UUID("e15ea001-d512-4fb7-a0ee-e05b4df1d45e")


@pytest.fixture(scope="module")
def engine():
    db = create_finance_engine()
    yield db
    db.dispose()


@pytest.fixture
def env(tmp_path: Path, engine):
    tmp_path.chmod(0o700)
    store = AuthStore(tmp_path / "auth.sqlite3")
    users = []

    def add_user():
        uid, token = uuid4().hex, "synthetic_session_" + uuid4().hex
        now = int(time.time())
        with sqlite3.connect(store.path) as cx:
            cx.execute(
                "INSERT INTO users(id,email,password_hash,verified_at,created_at)"
                " VALUES (?,?,?,?,?)",
                (uid, uid + "@example.test", "not-a-login-hash", now, now),
            )
            cx.execute(
                "INSERT INTO sessions(hash,user_id,expires_at,created_at)"
                " VALUES (?,?,?,?)",
                (token_hash(token), uid, now + 3600, now),
            )
        users.append((uid, token))
        return uid, token

    first = add_user()
    config = Settings(
        True, ORIGIN, store.path, "r" * 48, "synthetic-turnstile", "synthetic-site",
        "smtp.invalid", 465, "synthetic-user", "synthetic-password",
        "noreply@example.invalid", True,
    )
    app = create_app(config=config, store=store, finance_engine=engine,
                     finance_profile_namespace=NAMESPACE)

    def client(token: str) -> TestClient:
        c = TestClient(app, base_url=ORIGIN, raise_server_exceptions=False)
        # Real existing cookie path and HTTP bootstrap bridge from #98.
        c.cookies.set(COOKIE, token, domain="127.0.0.1", path="/api/auth")
        bootstrap = c.post("/api/auth/email/finance/session", headers={"Origin": ORIGIN}, json={})
        assert bootstrap.status_code == 200, bootstrap.text
        return c

    def scope(uid: str):
        return ensure_verified_profile(
            engine, verified_user_id=uid, server_namespace=NAMESPACE)

    def add_account(uid: str, *, opening=0) -> str:
        scoped = scope(uid)
        snapshot = get_account_snapshot(engine, scope=scoped)
        account_id = str(uuid4())
        cmd = {
            "schema_version": 1, "client_mutation_id": str(uuid4()),
            "base_revision": snapshot.body["revision"], "action": "account.create",
            "expected_entity_revisions": {},
            "payload": {"id": account_id, "name": "Synthetic account",
                        "kind": "bank", "currency": "RUB", "opening_minor": opening},
        }
        result = submit_account_command(
            engine, scope=scoped, command=cmd, if_match=snapshot.etag,
            idempotency_key=cmd["client_mutation_id"], allow_internal=True)
        assert result.status == 201
        return account_id

    yield {"app": app, "store": store, "users": users, "new_user": add_user, "first": first,
           "client": client, "scope": scope, "account": add_account, "engine": engine}


def snapshot(env, token):
    result = env["client"](token).get("/api/finance/v1/state")
    assert result.status_code == 200, result.text
    return result


def command(state, action, payload, versions=None, ident=None):
    return {"schema_version": 1, "client_mutation_id": ident or str(uuid4()),
            "base_revision": state.json()["revision"], "action": action,
            "expected_entity_revisions": versions or {}, "payload": payload}


def transfer(state, from_id, to_id, amount=210):
    revs = {e["id"]: e["entity_revision"] for e in state.json()["entities"]}
    return command(state, "account.transfer",
                   {"from_account_id": from_id, "to_account_id": to_id,
                    "amount_minor": amount, "occurred_on": "2026-11-08"},
                   {from_id: revs[from_id], to_id: revs[to_id]})


def submit(client, state, cmd, **headers):
    return client.post("/api/finance/v1/commands",
                       json=cmd, headers={"Origin": ORIGIN,
                        "If-Match": state.headers["etag"],
                        "Idempotency-Key": cmd["client_mutation_id"], **headers})


def balance(env, uid, account_id):
    with finance_transaction(env["engine"], verified_user_id=uid,
                             profile_id=env["scope"](uid).profile_id) as db:
        return int(db.execute(text("""
            SELECT a.opening_minor + COALESCE(SUM(p.signed_minor),0)
            FROM accounts a LEFT JOIN ledger_postings p ON
               p.account_id=a.id AND p.profile_id=a.profile_id
            WHERE a.id=:id GROUP BY a.opening_minor
        """), {"id": account_id}).scalar_one())


def test_factory_closed_without_opt_in():
    from fastapi.testclient import TestClient
    from pathlib import Path
    config = Settings(False, ORIGIN, Path("/tmp/unused-finance-auth.sqlite"), "", "", "",
                      "", 465, "", "", "", True)
    application = create_app(config=config)
    assert TestClient(application, base_url=ORIGIN).get("/api/finance/v1/state").status_code == 404


def test_real_sessions_and_two_profiles_no_idor(env):
    alice, token_a = env["first"]
    bob, token_b = env["new_user"]()
    a = env["account"](alice, opening=85100)
    b = env["account"](bob, opening=2100)
    user_a = env["client"](token_a)
    user_b = env["client"](token_b)
    aa, bb = snapshot(env, token_a), snapshot(env, token_b)
    assert aa.json()["profile_id"] != bb.json()["profile_id"]
    assert {e["id"] for e in aa.json()["entities"]} == {a}
    assert {e["id"] for e in bb.json()["entities"]} == {b}
    foreign = command(bb, "account.transfer",
                      {"from_account_id": a, "to_account_id": b,
                       "amount_minor": 50, "occurred_on": "2026-11-08"},
                      {a: 1, b: 1})
    denied = submit(user_b, bb, foreign)
    assert denied.status_code == 409
    assert balance(env, alice, a) == 85100
    assert user_b.get("/api/finance/v1/state", headers={
        "X-User-ID": alice, "X-Profile-ID": str(env["scope"](alice).profile_id)
    }).json()["profile_id"] == bb.json()["profile_id"]
    assert user_a.get("/api/finance/v1/state").status_code == 200


def test_origin_csrf_cors_and_internal_actions_are_denied(env):
    uid, token = env["first"]
    a, b = env["account"](uid), env["account"](uid)
    client = env["client"](token)
    state = snapshot(env, token)
    payload = transfer(state, a, b)
    for headers in [
        {"Origin": "https://evil.example"},
        {"Origin": ORIGIN, "Sec-Fetch-Site": "cross-site"},
    ]:
        r = client.post("/api/finance/v1/commands", json=payload,
                        headers={"If-Match": state.headers["etag"],
                                 "Idempotency-Key": payload["client_mutation_id"], **headers})
        assert r.status_code == 403
        assert "access-control-allow-origin" not in r.headers
    no_origin = client.post("/api/finance/v1/commands", json=payload,
                            headers={"If-Match": state.headers["etag"],
                                     "Idempotency-Key": payload["client_mutation_id"]})
    assert no_origin.status_code == 403
    options = client.options("/api/finance/v1/commands", headers={
        "Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in options.headers
    internal = command(state, "account.create", {"name": "not public"})
    assert submit(client, state, internal).status_code == 422
    assert balance(env, uid, a) == 0


def test_exact_replay_collision_stale_and_delta_pagination(env):
    uid, token = env["first"]
    a, b = env["account"](uid, opening=3000), env["account"](uid)
    client = env["client"](token)
    state = snapshot(env, token)
    request = transfer(state, a, b, 750)
    first = submit(client, state, request)
    assert first.status_code == 201, first.text
    assert first.json()["replayed"] is False
    assert first.headers["cache-control"] == "private, no-store"
    retry = submit(client, state, request)
    assert retry.status_code == 200
    assert retry.json()["replayed"] is True
    assert retry.json()["revision"] == first.json()["revision"]
    assert balance(env, uid, a) == 2250
    assert balance(env, uid, b) == 750
    altered = {**request, "payload": {**request["payload"], "amount_minor": 751}}
    assert submit(client, state, altered).json()["code"] == "idempotency_key_reuse"
    stale = transfer(state, a, b, 100)
    assert submit(client, state, stale).status_code == 412
    after = snapshot(env, token)
    assert after.headers["etag"] == first.headers["etag"]
    changed = client.get("/api/finance/v1/changes", params={
        "since_revision": state.json()["revision"], "limit_revisions": 1})
    assert changed.status_code == 200, changed.text
    assert changed.json()["changes"][0]["kind"] == "ledger_posted"
    assert changed.json()["next_since_revision"] == after.json()["revision"]


def test_concurrent_writers_only_one_commit(env):
    uid, token = env["first"]
    a, b = env["account"](uid, opening=5000), env["account"](uid)
    state = snapshot(env, token)
    requests = [transfer(state, a, b, 1400) for _ in range(2)]

    def writer(body):
        return submit(env["client"](token), state, body).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        codes = sorted(pool.map(writer, requests))
    assert codes == [201, 412], codes
    assert balance(env, uid, a) == 3600
    assert balance(env, uid, b) == 1400


def test_reverse_is_compensating_and_second_reverse_fails(env):
    uid, token = env["first"]
    a, b = env["account"](uid, opening=2200), env["account"](uid)
    client = env["client"](token)
    state = snapshot(env, token)
    result = submit(client, state, transfer(state, a, b, 200))
    assert result.status_code == 201, result.text
    txid = result.json()["changes"][0]["entity_id"]
    current = snapshot(env, token)
    versions = {e["id"]: e["entity_revision"] for e in current.json()["entities"]}
    cmd = command(current, "transaction.reverse",
                  {"transaction_id": txid, "reason": "Correction"},
                  {a: versions[a], b: versions[b], txid: 1})
    assert submit(client, current, cmd).status_code == 201
    assert balance(env, uid, a) == 2200
    assert balance(env, uid, b) == 0
    newest = snapshot(env, token)
    ver = {e["id"]: e["entity_revision"] for e in newest.json()["entities"]}
    repeat = command(newest, "transaction.reverse",
                     {"transaction_id": txid, "reason": "duplicate"},
                     {a: ver[a], b: ver[b], txid: 1})
    assert submit(client, newest, repeat).status_code == 409
    with finance_transaction(env["engine"], verified_user_id=uid,
                             profile_id=env["scope"](uid).profile_id) as db:
        assert db.execute(text("""
            SELECT count(*) FROM ledger_transactions
            WHERE reversed_transaction_id=:id
        """), {"id": txid}).scalar_one() == 1


def test_sql_failure_after_real_insert_rolls_back_everything(env, monkeypatch):
    import backend.finance_db.ledger_service as core
    uid, token = env["first"]
    a, b = env["account"](uid, opening=1000), env["account"](uid)
    client = env["client"](token)
    state = snapshot(env, token)
    request = transfer(state, a, b)
    original = core._post

    def simulated_mid_transaction_failure(*args, **kwargs):
        original(*args, **kwargs)  # Actual SQL INSERT and UPDATE in PostgreSQL.
        from sqlalchemy.exc import SQLAlchemyError
        raise SQLAlchemyError("synthetic failure after real writes")

    monkeypatch.setattr(core, "_post", simulated_mid_transaction_failure)
    failed = submit(client, state, request)
    assert failed.status_code == 503, failed.text
    assert "synthetic" not in failed.text
    assert balance(env, uid, a) == 1000
    assert balance(env, uid, b) == 0
    with finance_transaction(env["engine"], verified_user_id=uid,
                             profile_id=env["scope"](uid).profile_id) as db:
        assert db.execute(text("SELECT count(*) FROM ledger_postings")).scalar_one() == 0
        assert db.execute(text("SELECT count(*) FROM command_receipts")).scalar_one() == 2
        assert db.execute(text(
            "SELECT count(*) FROM command_receipts WHERE client_mutation_id=:id"
        ), {"id": request["client_mutation_id"]}).scalar_one() == 0
        assert db.execute(text(
            "SELECT count(*) FROM ledger_transactions")).scalar_one() == 0
    monkeypatch.setattr(core, "_post", original)
    assert snapshot(env, token).json()["revision"] == state.json()["revision"]


def test_revoked_expired_session_and_request_bounds(env):
    uid, token = env["first"]
    client = env["client"](token)
    assert snapshot(env, token).status_code == 200
    with sqlite3.connect(env["store"].path) as cx:
        cx.execute("UPDATE sessions SET revoked_at=? WHERE hash=?",
                   (int(time.time()), token_hash(token)))
    assert client.get("/api/finance/v1/state").status_code == 401
    assert client.post("/api/finance/v1/commands", headers={"Origin": ORIGIN,
               "Content-Type": "application/json"}, content=b"{}").status_code == 401
    _, expiring = env["new_user"]()
    with sqlite3.connect(env["store"].path) as cx:
        cx.execute("UPDATE sessions SET expires_at=1 WHERE hash=?", (token_hash(expiring),))
    expired = TestClient(env["app"], base_url=ORIGIN, raise_server_exceptions=False)
    expired.cookies.set("fh_finance_session", expiring, domain="127.0.0.1", path="/api/finance/v1")
    assert expired.get("/api/finance/v1/state").status_code == 401


def test_payload_type_rejected_before_pg_mutation(env):
    uid, token = env["first"]
    a, b = env["account"](uid), env["account"](uid)
    state = snapshot(env, token)
    client = env["client"](token)
    invalid = transfer(state, a, b)
    invalid["payload"]["amount_minor"] = True
    assert submit(client, state, invalid).status_code == 422
    big = b'{' + b' ' * 33_000 + b'}'
    oversized = client.post("/api/finance/v1/commands", content=big, headers={
        "Origin": ORIGIN, "Content-Type": "application/json", "If-Match": state.headers["etag"],
        "Idempotency-Key": str(uuid4())})
    assert oversized.status_code == 413
    assert snapshot(env, token).json()["revision"] == state.json()["revision"]


def test_missing_delta_revision_is_not_silently_skipped(env):
    """An out-of-band SQL bug must not advance clients over missing journal data."""
    uid, token = env["first"]
    scope = env["scope"](uid)
    with finance_transaction(env["engine"], verified_user_id=uid, profile_id=scope.profile_id) as db:
        db.execute(text("UPDATE finance_profiles SET revision=revision+1 WHERE id=:p"),
                   {"p": scope.profile_id})
    client = env["client"](token)
    res = client.get("/api/finance/v1/changes", params={"since_revision": 0})
    assert res.status_code == 503
    assert res.json()["code"] == "service_unavailable"


@pytest.mark.parametrize("page_limit", [1, 50])
def test_trailing_delta_gap_never_reports_false_end_of_journal(env, page_limit):
    """A nonempty last page still must reach the actual profile revision.

    Regression: journal=[1], profile revision=3, since=0 previously returned
    200 has_more=false, to_revision=3, next_since_revision=1. A client could
    silently treat that as a complete sync while missing committed changes.
    """
    uid, token = env["first"]
    env["account"](uid, opening=1234)  # Real receipt + journal revision 1.
    state = snapshot(env, token)
    assert state.json()["revision"] == 1
    scoped = env["scope"](uid)
    with finance_transaction(env["engine"], verified_user_id=uid,
                             profile_id=scoped.profile_id) as db:
        db.execute(text("""
            UPDATE finance_profiles SET revision=revision+2 WHERE id=:p
        """), {"p": scoped.profile_id})
    client = env["client"](token)
    missing_tail = client.get("/api/finance/v1/changes", params={
        "since_revision": 0, "limit_revisions": page_limit,
    })
    assert missing_tail.status_code == 503, missing_tail.text
    assert missing_tail.json()["code"] == "service_unavailable"
    assert "has_more" not in missing_tail.json()
    assert "next_since_revision" not in missing_tail.json()
    assert snapshot(env, token).json()["revision"] == 3
    # Existing 410 behaviour for legitimately compacted history is separate.
    missing_from_latest = client.get("/api/finance/v1/changes", params={
        "since_revision": 1,
    })
    assert missing_from_latest.status_code == 503
    assert missing_from_latest.json()["code"] == "service_unavailable"


def test_compacted_delta_requires_snapshot_410(env):
    uid, token = env["first"]
    env["account"](uid)
    scope = env["scope"](uid)
    with finance_transaction(env["engine"], verified_user_id=uid, profile_id=scope.profile_id) as db:
        db.execute(text("UPDATE finance_profiles SET min_available_revision=1 WHERE id=:p"),
                   {"p": scope.profile_id})
    res = env["client"](token).get("/api/finance/v1/changes", params={"since_revision": 0})
    assert res.status_code == 410, res.text
    assert res.json()["code"] == "snapshot_required"


def test_streamed_without_content_length_rejected_before_any_ledger_write(env):
    uid, token = env["first"]
    a, b = env["account"](uid, opening=1000), env["account"](uid)
    client = env["client"](token)
    state = snapshot(env, token)
    cmd = transfer(state, a, b, 300)

    def chunks():
        yield b"{" + b" " * 17_000
        yield b" " * 17_000 + b"}"

    result = client.post("/api/finance/v1/commands", content=chunks(),
                         headers={"Origin": ORIGIN, "Content-Type": "application/json",
                                  "If-Match": state.headers["etag"],
                                  "Idempotency-Key": cmd["client_mutation_id"]})
    assert result.status_code == 413, result.text
    assert balance(env, uid, a) == 1000
    assert balance(env, uid, b) == 0


def test_auth_store_failure_is_503_and_never_falls_back_to_headers(env, monkeypatch, caplog):
    uid, token = env["first"]
    client = env["client"](token)

    def unavailable(_token):
        raise sqlite3.OperationalError("synthetic private SQL query parameter")

    # The router captures a bound AuthStore.current; inject failure below
    # that bound method, at the real SQLite connection boundary.
    monkeypatch.setattr(env["store"], "_db", unavailable)
    with caplog.at_level("ERROR"):
        res = client.get("/api/finance/v1/state", headers={"X-User-Id": uid})
    assert res.status_code == 503, res.text
    assert "synthetic private" not in res.text
    assert "synthetic private" not in caplog.text


def test_v1_rejects_unapproved_actions_and_untrusted_profile_fields(env):
    uid, token = env["first"]
    a, b = env["account"](uid, opening=100), env["account"](uid)
    state = snapshot(env, token)
    client = env["client"](token)
    command_body = transfer(state, a, b, 10)
    command_body["profile_id"] = str(env["scope"](uid).profile_id)
    denied = submit(client, state, command_body)
    assert denied.status_code == 422
    forbidden = command(state, "loan.payment.record", {
        "loan_id": str(uuid4()), "amount_minor": 10,
        "paid_on": "2026-11-08", "strategy": "term",
    })
    assert submit(client, state, forbidden).status_code == 422
    assert balance(env, uid, a) == 100


def test_if_match_missing_is_428_and_base_revision_mismatch_is_409(env):
    uid, token = env["first"]
    a, b = env["account"](uid, opening=100), env["account"](uid)
    state = snapshot(env, token)
    client = env["client"](token)
    cmd = transfer(state, a, b, 30)
    no_match = client.post("/api/finance/v1/commands", json=cmd,
                           headers={"Origin": ORIGIN, "Idempotency-Key": cmd["client_mutation_id"]})
    assert no_match.status_code == 428, no_match.text
    invalid_rev = {**cmd, "base_revision": state.json()["revision"] - 1}
    conflict = submit(client, state, invalid_rev)
    assert conflict.status_code == 409, conflict.text
    assert conflict.json()["code"] == "semantic_conflict"
    assert balance(env, uid, a) == 100

def test_atomic_internal_loan_payment_contains_fact_link_and_two_delta_events(env):
    """Nonpublic candidate: one debit, verified fact and link in same PG commit."""
    uid, token = env["first"]
    account_id = env["account"](uid, opening=20_000)
    scope = env["scope"](uid)
    loan_id = str(uuid4())
    with finance_transaction(env["engine"], verified_user_id=uid,
                             profile_id=scope.profile_id) as db:
        db.execute(text("""
            INSERT INTO loans
              (profile_id,id,title,opening_minor,payment_minor,apr_basis_points,
               term_months,due_day,as_of_date)
            VALUES (:p,:id,'Synthetic loan',100000,5000,1200,24,8,'2026-11-08')
        """), {"p": scope.profile_id, "id": loan_id})
    before = snapshot(env, token)
    fact_id, transaction_id, mutation_id = str(uuid4()), str(uuid4()), str(uuid4())
    cmd = {
        "schema_version": 1, "client_mutation_id": mutation_id,
        "base_revision": before.json()["revision"], "action": "loan.payment.record",
        "expected_entity_revisions": {
            account_id: next(e["entity_revision"] for e in before.json()["entities"]
                             if e["id"] == account_id),
            loan_id: 1,
        },
        "payload": {
            "transaction_id": transaction_id, "fact_id": fact_id,
            "account_id": account_id, "amount_minor": 4_200,
            "paid_on": "2026-11-08", "loan_id": loan_id, "strategy": "term",
        },
    }
    accepted = submit_account_command(
        env["engine"], scope=scope, command=cmd, if_match=before.headers["etag"],
        idempotency_key=mutation_id, allow_internal=True,
    )
    assert accepted.status == 201
    assert len(accepted.body["changes"]) == 2
    assert {item["ordinal"] for item in accepted.body["changes"]} == {0, 1}
    assert {item["revision"] for item in accepted.body["changes"]} == {accepted.body["revision"]}
    assert balance(env, uid, account_id) == 15_800
    # A network retry before user refresh must not debit twice.
    replay = submit_account_command(
        env["engine"], scope=scope, command=cmd, if_match=before.headers["etag"],
        idempotency_key=mutation_id, allow_internal=True,
    )
    assert replay.status == 200 and replay.body["replayed"] is True
    assert balance(env, uid, account_id) == 15_800
    with finance_transaction(env["engine"], verified_user_id=uid,
                             profile_id=scope.profile_id) as db:
        assert db.execute(text("""
            SELECT count(*) FROM ledger_payment_links
            WHERE loan_payment_id=:fact AND transaction_id=:tx
        """), {"fact": fact_id, "tx": transaction_id}).scalar_one() == 1
        assert db.execute(text("""
            SELECT count(*) FROM loan_payments WHERE id=:fact AND voided_at IS NULL
        """), {"fact": fact_id}).scalar_one() == 1
        assert db.execute(text("""
            SELECT count(*) FROM ledger_postings
            WHERE transaction_id=:tx AND signed_minor=-4200
        """), {"tx": transaction_id}).scalar_one() == 1
        assert db.execute(text("""
            SELECT count(*) FROM change_log WHERE revision=:rev
        """), {"rev": accepted.body["revision"]}).scalar_one() == 2
    page = env["client"](token).get("/api/finance/v1/changes", params={
        "since_revision": before.json()["revision"], "limit_revisions": 1,
    })
    assert page.status_code == 200, page.text
    assert len(page.json()["changes"]) == 2
    assert page.json()["next_since_revision"] == accepted.body["revision"]
    assert page.json()["has_more"] is False

def test_snapshot_pagination_resumes_after_cursor_and_rejects_stale_pages(env):
    uid, token = env["first"]
    account_ids = {env["account"](uid, opening=100) for _ in range(4)}
    client = env["client"](token)
    seen: set[str] = set()
    next_cursor = None
    saved_first_cursor = None
    for _ in range(10):
        params = {"limit_entities": 1}
        if next_cursor is not None:
            params["cursor"] = next_cursor
        page = client.get("/api/finance/v1/state", params=params)
        assert page.status_code in (200, 206), page.text
        assert page.headers["cache-control"] == "private, no-store"
        seen.update(entity["id"] for entity in page.json()["entities"])
        next_cursor = page.json().get("next_cursor")
        if saved_first_cursor is None:
            saved_first_cursor = next_cursor
        if next_cursor is None:
            break
        assert page.status_code == 206
    else:
        pytest.fail("Snapshot cursor did not terminate")
    assert seen == account_ids
    assert saved_first_cursor is not None
    current = snapshot(env, token)
    first, second = list(account_ids)[:2]
    changed = submit(client, current, transfer(current, first, second, 25))
    assert changed.status_code == 201
    stale = client.get("/api/finance/v1/state", params={
        "limit_entities": 1, "cursor": saved_first_cursor,
    })
    assert stale.status_code == 412
    assert stale.json()["code"] == "stale_revision"


def test_snapshot_and_delta_query_validation_do_not_echo_sensitive_input(env):
    _, token = env["first"]
    client = env["client"](token)
    for path, query in [
        ("/api/finance/v1/changes", "since_revision=PRIVATE_VALUE"),
        ("/api/finance/v1/state", "limit_entities=PRIVATE_VALUE"),
        ("/api/finance/v1/state", "cursor=PRIVATE_VALUE"),
        ("/api/finance/v1/changes", "since_revision=0&since_revision=1"),
    ]:
        reply = client.get(path + "?" + query)
        assert reply.status_code == 422, reply.text
        assert reply.json()["code"] == "invalid_command"
        assert "PRIVATE_VALUE" not in reply.text


@pytest.mark.parametrize("bad_version", [True, False, 1.0, "1", None, 2])
def test_wire_schema_version_must_be_exact_integer(env, bad_version):
    """Regression for independent P2 review: Pydantic Literal must not coerce."""
    uid, token = env["first"]
    a, b = env["account"](uid, opening=10_000), env["account"](uid)
    client = env["client"](token)
    state = snapshot(env, token)
    cmd = transfer(state, a, b, amount=330)
    cmd["schema_version"] = bad_version
    rejected = submit(client, state, cmd)
    assert rejected.status_code == 422, rejected.text
    assert rejected.json()["code"] == "invalid_command"
    assert snapshot(env, token).json()["revision"] == state.json()["revision"]
    assert balance(env, uid, a) == 10_000
    assert balance(env, uid, b) == 0
    with finance_transaction(env["engine"], verified_user_id=uid,
                             profile_id=env["scope"](uid).profile_id) as db:
        assert db.execute(text("""
            SELECT count(*) FROM command_receipts WHERE client_mutation_id=:id
        """), {"id": cmd["client_mutation_id"]}).scalar_one() == 0



def test_ambiguous_json_keys_rejected_before_financial_mutation(env):
    """Two decoders may disagree on first-wins vs last-wins financial fields."""
    uid, token = env["first"]
    a = env["account"](uid, opening=25_000)
    b = env["account"](uid)
    client = env["client"](token)
    state = snapshot(env, token)
    cmd = transfer(state, a, b, 100)
    serialized = json.dumps(cmd, separators=(",", ":"), ensure_ascii=False)
    assert '"schema_version":1' in serialized
    assert '"amount_minor":100' in serialized
    repeated_mutation = (
        '"client_mutation_id":"' + cmd["client_mutation_id"] + '"'
    )
    assert repeated_mutation in serialized
    invalids = [
        serialized.replace('"schema_version":1', '"schema_version":1,"schema_version":1', 1),
        serialized.replace('"amount_minor":100', '"amount_minor":100,"amount_minor":200', 1),
        serialized.replace(repeated_mutation, repeated_mutation + "," + repeated_mutation, 1),
    ]
    for wire in invalids:
        result = client.post(
            "/api/finance/v1/commands", content=wire.encode("utf-8"),
            headers={
                "Origin": ORIGIN, "Content-Type": "application/json",
                "If-Match": state.headers["etag"],
                "Idempotency-Key": cmd["client_mutation_id"],
            },
        )
        assert result.status_code == 422, result.text
        assert result.json()["code"] == "invalid_command"
        assert "amount_minor" not in result.text
    assert snapshot(env, token).json()["revision"] == state.json()["revision"]
    assert balance(env, uid, a) == 25_000
    assert balance(env, uid, b) == 0
    with finance_transaction(env["engine"], verified_user_id=uid,
                             profile_id=env["scope"](uid).profile_id) as db:
        assert db.execute(text("""
            SELECT count(*) FROM command_receipts WHERE client_mutation_id=:id
        """), {"id": cmd["client_mutation_id"]}).scalar_one() == 0


def test_excessive_json_nesting_fails_closed_without_server_500(env):
    uid, token = env["first"]
    a = env["account"](uid, opening=1000)
    b = env["account"](uid)
    client = env["client"](token)
    state = snapshot(env, token)
    content = b"[" * 1200 + b"0" + b"]" * 1200
    response = client.post(
        "/api/finance/v1/commands", content=content,
        headers={
            "Origin": ORIGIN, "Content-Type": "application/json",
            "If-Match": state.headers["etag"],
            "Idempotency-Key": str(uuid4()),
        },
    )
    assert response.status_code == 422, response.text
    assert response.json()["code"] == "invalid_command"
    assert snapshot(env, token).json()["revision"] == state.json()["revision"]
    assert balance(env, uid, a) == 1000
    assert balance(env, uid, b) == 0



def obligation_payload(**changes):
    """Only the seven fields defined in accepted ADR-0065 OpenAPI v1."""
    return {
        "title": "Synthetic monthly rent",
        "direction": "expense",
        "amount_minor": 12_345,
        "starts_on": "2026-11-08",
        "timezone": "Europe/Helsinki",
        "recurrence_unit": "month",
        "recurrence_every": 1,
        **changes,
    }


def test_v1_obligation_create_is_atomic_scoped_and_replayable(env):
    """Plan creation changes no cash and yields the exact same delta as snapshot."""
    uid, token = env["first"]
    client = env["client"](token)
    before = snapshot(env, token)
    body = command(before, "obligation.create", obligation_payload())
    accepted = submit(client, before, body)
    assert accepted.status_code == 201, accepted.text
    data = accepted.json()
    assert data["revision"] == before.json()["revision"] + 1
    assert len(data["changes"]) == 1
    entity = data["changes"][0]["payload"]["entity"]
    assert entity["kind"] == "obligation"
    assert entity["entity_revision"] == 1
    assert entity["data"]["amount_minor"] == 12_345
    assert entity["data"]["timezone"] == "Europe/Helsinki"
    assert entity["data"]["deleted_at"] is None
    assert entity["data"]["category"] is None

    after = snapshot(env, token)
    assert after.json()["revision"] == data["revision"]
    assert after.json()["entities"] == [entity]
    assert after.headers["etag"] == accepted.headers["etag"]

    delta = client.get("/api/finance/v1/changes", params={
        "since_revision": before.json()["revision"],
    })
    assert delta.status_code == 200, delta.text
    assert delta.json()["changes"] == data["changes"]
    assert delta.json()["next_since_revision"] == after.json()["revision"]

    replay = submit(client, before, body)
    assert replay.status_code == 200, replay.text
    assert replay.json()["replayed"] is True
    assert replay.json()["revision"] == data["revision"]
    assert replay.json()["changes"] == data["changes"]
    assert snapshot(env, token).json()["entities"] == [entity]

    collision = {**body, "payload": obligation_payload(amount_minor=22_345)}
    conflict = submit(client, before, collision)
    assert conflict.status_code == 409, conflict.text
    assert conflict.json()["code"] == "idempotency_key_reuse"
    stale = submit(client, before, command(before, "obligation.create", obligation_payload()))
    assert stale.status_code == 412
    assert stale.json()["code"] == "stale_revision"

    other_uid, other_token = env["new_user"]()
    other = snapshot(env, other_token)
    assert other_uid != uid
    assert other.json()["entities"] == []
    with finance_transaction(env["engine"], verified_user_id=uid,
                             profile_id=env["scope"](uid).profile_id) as db:
        assert db.execute(text("SELECT count(*) FROM obligations")).scalar_one() == 1
        assert db.execute(text("SELECT count(*) FROM ledger_postings")).scalar_one() == 0
        assert db.execute(text("SELECT count(*) FROM command_receipts")).scalar_one() == 1


@pytest.mark.parametrize("invalid", [
    {"title": "  "},
    {"title": "X" * 161},
    {"direction": "transfer"},
    {"amount_minor": True},
    {"amount_minor": 1.25},
    {"amount_minor": -1},
    {"starts_on": "2026-02-30"},
    {"timezone": "Invalid/Timezone"},
    {"recurrence_unit": "weekly"},
    {"recurrence_every": 0},
    {"recurrence_every": 121},
    {"recurrence_every": 1.0},
    {"profile_id": "a" * 32},
])
def test_v1_obligation_create_invalid_payload_never_writes(env, invalid):
    uid, token = env["first"]
    client = env["client"](token)
    before = snapshot(env, token)
    body = command(before, "obligation.create", obligation_payload(**invalid))
    response = submit(client, before, body)
    assert response.status_code == 422, response.text
    assert response.json()["code"] == "invalid_command"
    after = snapshot(env, token)
    assert after.json()["revision"] == before.json()["revision"]
    assert after.json()["entities"] == []
    with finance_transaction(env["engine"], verified_user_id=uid,
                             profile_id=env["scope"](uid).profile_id) as db:
        assert db.execute(text("SELECT count(*) FROM obligations")).scalar_one() == 0
        assert db.execute(text("SELECT count(*) FROM command_receipts")).scalar_one() == 0



def seed_synthetic_reserve(env, uid, *, target=600):
    """Internal fixture only: no public reserve.create exists in approved v1."""
    reserve_id = str(uuid4())
    with finance_transaction(env["engine"], verified_user_id=uid,
                             profile_id=env["scope"](uid).profile_id) as db:
        db.execute(text("""
            INSERT INTO reserves(profile_id,id,title,target_minor)
            VALUES (:p,:id,'Synthetic target',:target)
        """), {"p": env["scope"](uid).profile_id, "id": reserve_id, "target": target})
    return reserve_id


def reserve_command(state, reserve_id, account_id, delta):
    revs = {e["id"]: e["entity_revision"] for e in state.json()["entities"]}
    return command(state, "reserve.allocate", {
        "reserve_id": reserve_id, "account_id": account_id, "delta_minor": delta,
    }, {reserve_id: revs[reserve_id], account_id: revs[account_id]})


def test_v1_reserve_allocate_release_is_atomic_scoped_and_replayable(env):
    """Allocate and release are reservation adjustments, not money movements."""
    uid, token = env["first"]
    acc = env["account"](uid, opening=1_000)
    reserve_id = seed_synthetic_reserve(env, uid)
    client = env["client"](token)
    before = snapshot(env, token)
    by_kind = {e["kind"]: e for e in before.json()["entities"]}
    assert by_kind["reserve"]["data"]["allocated_minor"] == 0
    assert by_kind["account"]["data"]["reserved_minor"] == 0
    assert by_kind["account"]["data"]["available_minor"] == 1_000

    cmd = reserve_command(before, reserve_id, acc, 400)
    accepted = submit(client, before, cmd)
    assert accepted.status_code == 201, accepted.text
    posted = accepted.json()
    assert len(posted["changes"]) == 2
    assert [c["ordinal"] for c in posted["changes"]] == [0, 1]
    assert {c["revision"] for c in posted["changes"]} == {posted["revision"]}
    current = snapshot(env, token)
    by_kind = {e["kind"]: e for e in current.json()["entities"]}
    assert by_kind["reserve"]["data"]["allocated_minor"] == 400
    assert by_kind["account"]["data"]["reserved_minor"] == 400
    assert by_kind["account"]["data"]["balance_minor"] == 1_000
    assert by_kind["account"]["data"]["available_minor"] == 600
    assert [c["payload"]["entity"] for c in posted["changes"]] == [
        by_kind["reserve"], by_kind["account"],
    ]
    changes = client.get("/api/finance/v1/changes", params={
        "since_revision": before.json()["revision"], "limit_revisions": 1,
    })
    assert changes.status_code == 200, changes.text
    assert changes.json()["changes"] == posted["changes"]
    assert changes.json()["has_more"] is False

    retry = submit(client, before, cmd)
    assert retry.status_code == 200, retry.text
    assert retry.json()["replayed"] is True
    assert retry.json()["changes"] == posted["changes"]
    reused = submit(client, before, {**cmd, "payload": {
        "reserve_id": reserve_id, "account_id": acc, "delta_minor": 200,
    }})
    assert reused.status_code == 409
    assert reused.json()["code"] == "idempotency_key_reuse"

    release = submit(client, current, reserve_command(current, reserve_id, acc, -125))
    assert release.status_code == 201, release.text
    released = snapshot(env, token)
    by_kind = {e["kind"]: e for e in released.json()["entities"]}
    assert by_kind["reserve"]["data"]["allocated_minor"] == 275
    assert by_kind["account"]["data"]["reserved_minor"] == 275
    assert by_kind["account"]["data"]["available_minor"] == 725
    assert balance(env, uid, acc) == 1_000
    for invalid_delta in (-276, 400):
        denial = submit(client, released, reserve_command(
            released, reserve_id, acc, invalid_delta))
        assert denial.status_code == 409, denial.text
        assert denial.json()["code"] == "semantic_conflict"
    assert snapshot(env, token).json()["entities"] == released.json()["entities"]
    with finance_transaction(env["engine"], verified_user_id=uid,
                             profile_id=env["scope"](uid).profile_id) as db:
        assert db.execute(text("SELECT count(*) FROM ledger_postings")).scalar_one() == 0
        assert db.execute(text("SELECT count(*) FROM reserve_allocations")).scalar_one() == 2
        assert db.execute(text("SELECT sum(delta_minor) FROM reserve_allocations")).scalar_one() == 275

    other_uid, other_token = env["new_user"]()
    other_acc = env["account"](other_uid, opening=1_000)
    other_state = snapshot(env, other_token)
    cross_scope = command(other_state, "reserve.allocate", {
        "reserve_id": reserve_id, "account_id": other_acc, "delta_minor": 1,
    }, {reserve_id: 1, other_acc: next(
        e["entity_revision"] for e in other_state.json()["entities"] if e["id"] == other_acc)})
    denied = submit(env["client"](other_token), other_state, cross_scope)
    assert denied.status_code in (403, 409), denied.text
    assert balance(env, uid, acc) == 1_000


@pytest.mark.parametrize("bad_delta", [0, True, 0.25, 1_000_000_000_001, -1_000_000_000_001])
def test_v1_reserve_allocate_rejects_unsafe_money_types(env, bad_delta):
    uid, token = env["first"]
    acc = env["account"](uid, opening=1_000)
    reserve_id = seed_synthetic_reserve(env, uid)
    state = snapshot(env, token)
    cmd = reserve_command(state, reserve_id, acc, bad_delta)
    invalid = submit(env["client"](token), state, cmd)
    assert invalid.status_code == 422, invalid.text
    assert invalid.json()["code"] == "invalid_command"
    assert snapshot(env, token).json()["revision"] == state.json()["revision"]
    assert balance(env, uid, acc) == 1_000
    with finance_transaction(env["engine"], verified_user_id=uid,
                             profile_id=env["scope"](uid).profile_id) as db:
        assert db.execute(text("SELECT count(*) FROM reserve_allocations")).scalar_one() == 0



def test_v1_reserve_allocate_rejects_exceeding_available_account_balance(env):
    """Even a large reserve target cannot make unavailable cash reservable."""
    uid, token = env["first"]
    account = env["account"](uid, opening=500)
    reserve_id = seed_synthetic_reserve(env, uid, target=50_000)
    state = snapshot(env, token)
    cmd = reserve_command(state, reserve_id, account, 501)
    client = env["client"](token)
    denied = submit(client, state, cmd)
    assert denied.status_code == 409, denied.text
    assert denied.json()["code"] == "semantic_conflict"
    after = snapshot(env, token)
    assert after.json()["revision"] == state.json()["revision"]
    assert after.json()["entities"] == state.json()["entities"]
    assert balance(env, uid, account) == 500
    with finance_transaction(env["engine"], verified_user_id=uid,
                             profile_id=env["scope"](uid).profile_id) as db:
        assert db.execute(text("SELECT count(*) FROM reserve_allocations")).scalar_one() == 0
        assert db.execute(text("""
            SELECT count(*) FROM command_receipts WHERE client_mutation_id=:id
        """), {"id": cmd["client_mutation_id"]}).scalar_one() == 0


def test_reserved_cash_is_not_silently_spent_by_transfers(env):
    """A transfer may spend only unreserved cash; failed writes leave no receipt."""
    uid, token = env["first"]
    source = env["account"](uid, opening=1_000)
    dest = env["account"](uid, opening=50)
    reserve_id = seed_synthetic_reserve(env, uid, target=900)
    client = env["client"](token)
    initial = snapshot(env, token)
    allocated = submit(client, initial, reserve_command(
        initial, reserve_id, source, 700))
    assert allocated.status_code == 201, allocated.text
    before = snapshot(env, token)
    denied_cmd = transfer(before, source, dest, 301)
    denied = submit(client, before, denied_cmd)
    assert denied.status_code == 409, denied.text
    assert denied.json()["code"] == "semantic_conflict"
    after = snapshot(env, token)
    assert after.json()["revision"] == before.json()["revision"]
    assert after.json()["entities"] == before.json()["entities"]
    with finance_transaction(env["engine"], verified_user_id=uid,
                             profile_id=env["scope"](uid).profile_id) as db:
        assert db.execute(text("SELECT count(*) FROM ledger_postings")).scalar_one() == 0
        assert db.execute(text("""
            SELECT count(*) FROM command_receipts WHERE client_mutation_id=:id
        """), {"id": denied_cmd["client_mutation_id"]}).scalar_one() == 0
    accepted = submit(client, before, transfer(before, source, dest, 300))
    assert accepted.status_code == 201, accepted.text
    available = snapshot(env, token)
    by_id = {e["id"]: e for e in available.json()["entities"]}
    assert by_id[source]["data"]["balance_minor"] == 700
    assert by_id[source]["data"]["reserved_minor"] == 700
    assert by_id[source]["data"]["available_minor"] == 0
    assert balance(env, uid, dest) == 350
    release = submit(client, available, reserve_command(
        available, reserve_id, source, -200))
    assert release.status_code == 201, release.text
    free = snapshot(env, token)
    completed = submit(client, free, transfer(free, source, dest, 200))
    assert completed.status_code == 201, completed.text
    final = snapshot(env, token)
    by_id = {e["id"]: e for e in final.json()["entities"]}
    assert by_id[source]["data"]["balance_minor"] == 500
    assert by_id[source]["data"]["reserved_minor"] == 500
    assert by_id[source]["data"]["available_minor"] == 0
    assert balance(env, uid, dest) == 550


def test_transfer_reversal_cannot_take_money_earmarked_after_original_post(env):
    """Reversal is also a debit and cannot invalidate a later reserve."""
    uid, token = env["first"]
    source = env["account"](uid, opening=1_200)
    dest = env["account"](uid, opening=300)
    reserve_id = seed_synthetic_reserve(env, uid, target=1_000)
    client = env["client"](token)
    before = snapshot(env, token)
    sent = submit(client, before, transfer(before, source, dest, 500))
    assert sent.status_code == 201, sent.text
    original_id = sent.json()["changes"][0]["entity_id"]
    arrived = snapshot(env, token)
    funded = submit(client, arrived, reserve_command(
        arrived, reserve_id, dest, 700))
    assert funded.status_code == 201, funded.text
    reserved = snapshot(env, token)
    revisions = {e["id"]: e["entity_revision"] for e in reserved.json()["entities"]}
    reverse_cmd = command(
        reserved, "transaction.reverse",
        {"transaction_id": original_id, "reason": "Synthetic correction"},
        {source: revisions[source], dest: revisions[dest], original_id: revisions[original_id]},
    )
    rejected = submit(client, reserved, reverse_cmd)
    assert rejected.status_code == 409, rejected.text
    assert rejected.json()["code"] == "semantic_conflict"
    assert snapshot(env, token).json()["entities"] == reserved.json()["entities"]
    assert balance(env, uid, source) == 700
    assert balance(env, uid, dest) == 800
    with finance_transaction(env["engine"], verified_user_id=uid,
                             profile_id=env["scope"](uid).profile_id) as db:
        assert db.execute(text("""
            SELECT count(*) FROM ledger_transactions
            WHERE reversed_transaction_id=:id
        """), {"id": original_id}).scalar_one() == 0
        assert db.execute(text("""
            SELECT count(*) FROM command_receipts WHERE client_mutation_id=:id
        """), {"id": reverse_cmd["client_mutation_id"]}).scalar_one() == 0
    released = submit(client, reserved, reserve_command(
        reserved, reserve_id, dest, -500))
    assert released.status_code == 201, released.text
    newest = snapshot(env, token)
    revs = {e["id"]: e["entity_revision"] for e in newest.json()["entities"]}
    allowed = submit(client, newest, command(
        newest, "transaction.reverse",
        {"transaction_id": original_id, "reason": "Correct after reserve release"},
        {source: revs[source], dest: revs[dest], original_id: revs[original_id]},
    ))
    assert allowed.status_code == 201, allowed.text
    assert balance(env, uid, source) == 1_200
    assert balance(env, uid, dest) == 300
    final = snapshot(env, token)
    dest_entity = next(e for e in final.json()["entities"] if e["id"] == dest)
    assert dest_entity["data"]["reserved_minor"] == 200
    assert dest_entity["data"]["available_minor"] == 100


def test_finance_cookie_is_invalidated_for_any_identity_cookie_issuer(env):
    """OAuth-shaped callback must not retain a previous email user's finance scope.

    This tests the generic Set-Cookie integration contract, not OAuth token
    exchange itself. The new OAuth router in main directly issues the
    fh_email_session cookie instead of calling the email app's cookie() helper.
    """
    from fastapi import Response

    alice, token_a = env["first"]
    bob, token_b = env["new_user"]()
    alice_account = env["account"](alice, opening=98_765)

    def synthetic_provider_callback(response: Response):
        response.set_cookie(
            "fh_email_session", token_b, path="/api/auth",
            secure=False, httponly=True, samesite="lax",
        )
        return {"authenticated": True}

    env["app"].add_api_route(
        "/__synthetic_provider_callback", synthetic_provider_callback,
        methods=["GET"], include_in_schema=False,
    )
    client = env["client"](token_a)
    before = client.get("/api/finance/v1/state")
    assert before.status_code == 200
    assert alice_account in before.text
    assert any(c.name == "fh_finance_session" for c in client.cookies.jar)

    swapped = client.get("/__synthetic_provider_callback")
    assert swapped.status_code == 200, swapped.text
    cookies = swapped.headers.get_list("set-cookie")
    assert any(c.startswith("fh_email_session=") for c in cookies)
    assert any(c.startswith("fh_finance_session=") and "Max-Age=0" in c
               for c in cookies)
    assert not any(c.name == "fh_finance_session" for c in client.cookies.jar)

    denied = client.get("/api/finance/v1/state")
    assert denied.status_code == 401, denied.text
    assert denied.json()["code"] == "unauthenticated"
    assert client.post("/api/auth/email/finance/session",
                       headers={"Origin": ORIGIN}, json={}).status_code == 200
    new_state = client.get("/api/finance/v1/state")
    assert new_state.status_code == 200
    assert new_state.json()["entities"] == []
    assert alice_account not in new_state.text


def test_finance_http_auth_origin_rate_and_outage_use_stable_error_envelope(env, monkeypatch):
    """AuthStore errors must use Error(code,message), not FastAPI's detail."""
    from backend.fh_email_auth.store import Throttled

    app = env["app"]
    with TestClient(app, base_url=ORIGIN, raise_server_exceptions=False) as anonymous:
        for path in ["/api/finance/v1/state", "/api/finance/v1/changes?since_revision=0"]:
            denied = anonymous.get(path)
            assert denied.status_code == 401, denied.text
            assert set(denied.json()) == {"code", "message"}
            assert denied.json()["code"] == "unauthenticated"
            assert denied.headers["cache-control"] == "private, no-store"
            assert denied.headers["x-content-type-options"] == "nosniff"
        unsafe = anonymous.post("/api/auth/email/finance/session",
                                headers={"Origin": "https://invalid.example"}, json={})
        assert unsafe.status_code == 403
        assert unsafe.json()["code"] == "forbidden"
        assert "detail" not in unsafe.json()

    uid, token = env["first"]
    client = env["client"](token)
    original_limit = env["store"].limit

    def blocked(*args, **kwargs):
        raise Throttled()

    monkeypatch.setattr(env["store"], "limit", blocked)
    throttled = client.get("/api/finance/v1/state")
    assert throttled.status_code == 429, throttled.text
    assert set(throttled.json()) == {"code", "message"}
    assert throttled.json()["code"] == "rate_limited"
    assert throttled.headers["cache-control"] == "private, no-store"

    def failed(*args, **kwargs):
        raise RuntimeError("PRIVATE_SQLITE_FAILURE_SHOULD_NOT_LEAK")

    monkeypatch.setattr(env["store"], "limit", failed)
    outage = client.get("/api/finance/v1/state")
    assert outage.status_code == 503
    assert outage.json()["code"] == "service_unavailable"
    assert "PRIVATE_SQLITE_FAILURE_SHOULD_NOT_LEAK" not in outage.text
    monkeypatch.setattr(env["store"], "limit", original_limit)


def test_snapshot_recovers_exact_reserve_allocation_pairs_after_delta_compaction(env):
    """2 reserves x 2 accounts: aggregates alone cannot identify releasable pairs."""
    uid, token = env["first"]
    account_a = env["account"](uid, opening=1_000)
    account_b = env["account"](uid, opening=600)
    reserve_a = seed_synthetic_reserve(env, uid, target=800)
    reserve_b = seed_synthetic_reserve(env, uid, target=600)
    client = env["client"](token)
    for reserve_id, account_id, amount in [
        (reserve_a, account_a, 300),
        (reserve_a, account_b, 200),
        (reserve_b, account_a, 150),
        (reserve_b, account_b, 100),
    ]:
        old = snapshot(env, token)
        result = submit(client, old, reserve_command(old, reserve_id, account_id, amount))
        assert result.status_code == 201, result.text
        after = snapshot(env, token)
        updated = {item["id"]: item for item in after.json()["entities"]}
        assert result.json()["changes"][0]["payload"]["entity"] == updated[reserve_id]
        assert result.json()["changes"][1]["payload"]["entity"] == updated[account_id]

    current = snapshot(env, token)
    entities = {item["id"]: item for item in current.json()["entities"]}
    assert entities[reserve_a]["data"]["allocations_by_account"] == [
        {"account_id": id, "allocated_minor": amount}
        for id, amount in sorted([(account_a, 300), (account_b, 200)])
    ]
    assert entities[reserve_b]["data"]["allocations_by_account"] == [
        {"account_id": id, "allocated_minor": amount}
        for id, amount in sorted([(account_a, 150), (account_b, 100)])
    ]
    assert entities[reserve_a]["data"]["allocated_minor"] == 500
    assert entities[reserve_b]["data"]["allocated_minor"] == 250
    assert entities[account_a]["data"]["reserved_minor"] == 450
    assert entities[account_b]["data"]["reserved_minor"] == 300

    with finance_transaction(env["engine"], verified_user_id=uid,
                             profile_id=env["scope"](uid).profile_id) as db:
        db.execute(text("""
            UPDATE finance_profiles SET min_available_revision=:min WHERE id=:p
        """), {"min": current.json()["revision"],
               "p": env["scope"](uid).profile_id})
    unavailable_delta = client.get("/api/finance/v1/changes", params={"since_revision": 0})
    assert unavailable_delta.status_code == 410
    assert unavailable_delta.json()["code"] == "snapshot_required"

    recovered = snapshot(env, token)
    assert recovered.json()["entities"] == current.json()["entities"]
    page_entities = {}
    cursor = None
    for _ in range(10):
        params = {"limit_entities": 1}
        if cursor:
            params["cursor"] = cursor
        part = client.get("/api/finance/v1/state", params=params)
        assert part.status_code in (200, 206), part.text
        for e in part.json()["entities"]:
            page_entities[e["id"]] = e
        cursor = part.json().get("next_cursor")
        if not cursor:
            break
    else:
        pytest.fail("Bounded snapshot cursor did not terminate")
    assert page_entities == entities

    rejected = submit(client, recovered, reserve_command(recovered, reserve_a, account_b, -201))
    assert rejected.status_code == 409
    assert rejected.json()["code"] == "semantic_conflict"
    assert snapshot(env, token).json()["revision"] == current.json()["revision"]
    allowed = submit(client, recovered, reserve_command(recovered, reserve_a, account_b, -200))
    assert allowed.status_code == 201, allowed.text
    final = {item["id"]: item for item in snapshot(env, token).json()["entities"]}
    assert final[reserve_a]["data"]["allocations_by_account"] == [
        {"account_id": account_a, "allocated_minor": 300}
    ]
