"""#69: explicit personal HTTP legacy import with real FH SQLite + PostgreSQL.

Disposable synthetic users/database only; no real browser files, no production
upload, no financial identifier or value logged to external artifacts.
"""
from __future__ import annotations

from hashlib import sha256
import os
import json
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import text

from backend.fh_email_auth.app import create_app
from backend.fh_email_auth.config import Settings
from backend.finance_db.db import finance_transaction
from backend.finance_api.tests.test_http import engine, env, ORIGIN, NAMESPACE, COOKIE


pytestmark = pytest.mark.skipif(
    os.getenv('FH_FINANCE_CI_ALLOW_BOOTSTRAP') != 'yes',
    reason='Requires dedicated disposable PostgreSQL and real FH SQLite AuthStore',
)


@pytest.fixture
def personal_import(env):
    config = Settings(
        True, ORIGIN, env["store"].path, "r" * 48,
        "synthetic-turnstile", "synthetic-site",
        "smtp.invalid", 465, "synthetic-user", "synthetic-password",
        "noreply@example.invalid", True,
    )
    app = create_app(
        config=config, store=env["store"], finance_engine=env["engine"],
        finance_profile_namespace=NAMESPACE, enable_account_v2_candidate=True,
        enable_import_candidate=True,
    )
    def client(token):
        c = TestClient(app, base_url=ORIGIN, raise_server_exceptions=False)
        c.cookies.set(COOKIE, token, domain="127.0.0.1", path="/api/auth")
        res = c.post("/api/auth/email/finance/session", headers={"Origin":ORIGIN}, json={})
        assert res.status_code == 200, res.text
        return c
    return {**env, "client_import": client, "app_import": app}


def source():
    return {
        "version": 2, "revision": 0,
        "entries": [{
            "id": "legacy-entry-1", "title": "Синтетическая аренда",
            "kind": "expense", "amountCents": 120000,
            "date": "2026-11-10", "recurrence": "monthly", "category": "Жильё",
        }],
        "loans": [], "settlements": [], "loanPayments": [],
        "categories": ["Жильё"], "audit": [],
        "settings": {"currency": "RUB"},
    }


def bundle(uid, state=None):
    original = state or source()
    raw = json.dumps(original, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    manifest = {
        "schema_version": 1, "source_scope": "account:" + uid,
        "source_revision": 0, "source_sha256": sha256(raw.encode("utf-8")).hexdigest(),
        "expected_server_revision": 0, "external_encrypted_backup_checked": True,
        "explicit_owner_consent": True, "explicit_guest_transfer": False,
        "rows": [
            {"record_type": "entries", "source_record_id": item["id"]}
            for item in original["entries"]
        ],
    }
    return manifest, raw


def write(client, endpoint, state, body, **headers):
    return client.post(
        "/api/finance/v1/import/" + endpoint,
        headers={"Origin": ORIGIN, "If-Match": state.headers["etag"], **headers},
        json=body,
    )


def test_personal_import_feature_disabled_by_default(env):
    uid, token = env["first"]
    app = create_app(
        config=Settings(
            True, ORIGIN, env["store"].path, "r" * 48,
            "synthetic-turnstile", "synthetic-site",
            "smtp.invalid", 465, "synthetic-user", "synthetic-password",
            "noreply@example.invalid", True,
        ), store=env["store"], finance_engine=env["engine"],
        finance_profile_namespace=NAMESPACE, enable_account_v2_candidate=True,
    )
    c = TestClient(app, base_url=ORIGIN, raise_server_exceptions=False)
    c.cookies.set(COOKIE, token, domain="127.0.0.1", path="/api/auth")
    assert c.post("/api/finance/v1/import/manifest",
                  headers={"Origin": ORIGIN}, json={}).status_code == 404


def test_import_http_stage_commit_replay_restore_without_minting_cash(personal_import):
    uid, token = personal_import["first"]
    c = personal_import["client_import"](token)
    state = c.get("/api/finance/v1/state")
    assert state.status_code == 200
    manifest, original = bundle(uid)
    staged = write(c, "manifest", state, {"manifest": manifest})
    assert staged.status_code == 202, staged.text
    assert staged.json()["status"] == "UNVERIFIED_MANIFEST_STAGED"
    assert staged.json()["financial_write"] is False
    assert staged.headers["cache-control"] == "private, no-store"
    second = write(c, "manifest", state, {"manifest": manifest})
    assert second.status_code == 200 and second.json()["replayed"] is True

    body = {"manifest": manifest, "source_canonical_json": original}
    committed = write(c, "commit", state, body)
    assert committed.status_code == 201, committed.text
    assert committed.json()["status"] == "COMMITTED"
    assert committed.json()["revision"] == 1
    assert committed.json()["cash_postings_created"] == 0
    assert committed.json()["record_count"] == 1
    assert "source_canonical_json" not in committed.text

    replay = write(c, "commit", state, body)
    assert replay.status_code == 200
    assert replay.json()["replayed"] is True
    assert replay.json()["revision"] == committed.json()["revision"]
    restored = c.post(
        "/api/finance/v1/import/restore", headers={"Origin": ORIGIN},
        json={"batch_id": committed.json()["batch_id"],
              "source_sha256": manifest["source_sha256"],
              "confirm_restore": True},
    )
    assert restored.status_code == 200, restored.text
    assert restored.content == original.encode("utf-8")
    assert restored.headers["cache-control"] == "private, no-store"
    assert restored.headers["content-disposition"].startswith("attachment;")
    assert c.get("/api/finance/v1/changes", params={"since_revision":0}).status_code == 410
    with finance_transaction(
        personal_import["engine"], verified_user_id=uid,
        profile_id=personal_import["scope"](uid).profile_id,
    ) as s:
        assert s.execute(text("SELECT count(*) FROM ledger_transactions")).scalar_one() == 0
        assert s.execute(text("SELECT count(*) FROM obligations")).scalar_one() == 1
        assert s.execute(text("SELECT count(*) FROM command_receipts")).scalar_one() == 1


def test_personal_import_http_rejects_cross_scope_csrf_malformed_and_unapproved(personal_import):
    uid, token = personal_import["first"]
    c = personal_import["client_import"](token)
    state = c.get("/api/finance/v1/state")
    manifest, original = bundle(uid)
    endpoint = "/api/finance/v1/import/manifest"
    assert c.post(endpoint, json={"manifest":manifest}).status_code == 403
    assert c.post(endpoint, json={"manifest":manifest},
                  headers={"Origin":"https://attacker.invalid"}).status_code == 403
    assert c.post(endpoint, json={"manifest":manifest},
                  headers={"Origin":ORIGIN, "Sec-Fetch-Site":"cross-site"}).status_code == 403
    assert write(c, "manifest", state, {"manifest": manifest},
                 **{"If-Match":'"bad-etag"'}).status_code == 412
    assert write(c, "manifest", state, {"manifest":{
        **manifest, "source_scope":"account:"+uuid4().hex,
    }}).status_code == 403
    assert write(c, "manifest", state, {
        "manifest":{**manifest, "external_encrypted_backup_checked":False},
    }).status_code == 422
    assert write(c, "manifest", state, {
        "manifest":{**manifest, "explicit_owner_consent":False},
    }).status_code == 422
    assert write(c, "commit", state, {
        "manifest":manifest, "source_canonical_json":original,
    }).status_code == 409  # No staged server manifest.
    raw = '{"manifest":{},"manifest":{}}'
    assert c.post(endpoint, content=raw, headers={
        "Origin":ORIGIN, "Content-Type":"application/json",
    }).status_code == 422
    oversized = c.post(endpoint, content="a" * 2_000_005, headers={
        "Origin":ORIGIN, "Content-Type":"application/json",
    })
    assert oversized.status_code == 413


def test_personal_import_http_rechecks_revoked_fh_session_and_never_reveals_other_owner(personal_import):
    uid, token = personal_import["first"]
    c = personal_import["client_import"](token)
    state = c.get("/api/finance/v1/state")
    manifest, original = bundle(uid)
    assert write(c, "manifest", state, {"manifest":manifest}).status_code == 202
    other_uid, other_token = personal_import["new_user"]()
    other = personal_import["client_import"](other_token)
    unauthorized = other.post("/api/finance/v1/import/restore",
         headers={"Origin":ORIGIN}, json={
             "batch_id":str(uuid4()), "source_sha256":manifest["source_sha256"],
             "confirm_restore":True,
         })
    assert unauthorized.status_code == 404
    personal_import["store"].logout(token)
    assert write(c, "commit", state, {
        "manifest":manifest, "source_canonical_json":original,
    }).status_code == 401
    assert c.post("/api/finance/v1/import/restore",
         headers={"Origin":ORIGIN},json={
             "batch_id":str(uuid4()), "source_sha256":manifest["source_sha256"],
             "confirm_restore":True,
         }).status_code == 401



def test_http_import_keeps_preexisting_unused_zero_account_and_rejects_silent_merge(personal_import):
    """Actual FH cookie -> HTTP manifest -> RLS Postgres commit -> restore."""
    user_id, token = personal_import["first"]
    client = personal_import["client_import"](token)
    before = client.get("/api/finance/v1/state?limit_entities=5000")
    assert before.status_code == 200 and before.json()["entities"] == []
    account_id = str(uuid4())
    mutation_id = str(uuid4())
    create = {
        "schema_version": 2, "client_mutation_id": mutation_id,
        "base_revision": before.json()["revision"], "action": "account.create",
        "expected_entity_revisions": {},
        "payload": {
            "id": account_id, "name": "Synthetic retained empty",
            "kind": "cash", "currency": "RUB", "opening_minor": 0,
        },
    }
    created = client.post("/api/finance/v2/commands", json=create, headers={
        "Origin": ORIGIN, "If-Match": before.headers["etag"],
        "Idempotency-Key": mutation_id,
    })
    assert created.status_code == 201, created.text
    original_server = client.get("/api/finance/v1/state?limit_entities=5000")
    assert original_server.status_code == 200
    zero_account = next(row for row in original_server.json()["entities"]
                        if row["kind"] == "account")
    assert zero_account["id"] == account_id
    assert zero_account["data"]["balance_minor"] == 0

    manifest, raw = bundle(user_id)
    manifest = {
        **manifest,
        "expected_server_revision": original_server.json()["revision"],
        "preserve_zero_account_id": account_id,
        "confirm_preserve_zero_account": True,
    }
    # A valid owner session alone cannot authorize a merge.
    no_consent = {**manifest, "confirm_preserve_zero_account": False}
    assert write(client, "manifest", original_server,
                 {"manifest": no_consent}).status_code == 422
    without_identity = {k: v for k, v in manifest.items()
                        if k not in ("preserve_zero_account_id",
                                     "confirm_preserve_zero_account")}
    assert write(client, "manifest", original_server,
                 {"manifest": without_identity}).status_code == 409
    assert write(client, "manifest", original_server, {
        "manifest": {**manifest, "preserve_zero_account_id": str(uuid4())},
    }).status_code == 409

    stage = write(client, "manifest", original_server, {"manifest": manifest})
    assert stage.status_code == 202, stage.text
    committed = write(client, "commit", original_server, {
        "manifest": manifest, "source_canonical_json": raw,
    })
    assert committed.status_code == 201, committed.text
    assert committed.json()["revision"] == original_server.json()["revision"] + 1
    assert committed.json()["cash_postings_created"] == 0
    replay = write(client, "commit", original_server, {
        "manifest": manifest, "source_canonical_json": raw,
    })
    assert replay.status_code == 200 and replay.json()["replayed"] is True
    after = client.get("/api/finance/v1/state?limit_entities=5000")
    assert after.status_code == 200
    retained = next(row for row in after.json()["entities"]
                    if row["kind"] == "account")
    assert retained == zero_account
    assert sum(row["kind"] == "account" for row in after.json()["entities"]) == 1
    assert sum(row["kind"] == "obligation" for row in after.json()["entities"]) == 1

    recovered = client.post("/api/finance/v1/import/restore",
                            headers={"Origin": ORIGIN}, json={
        "batch_id": committed.json()["batch_id"],
        "source_sha256": manifest["source_sha256"],
        "confirm_restore": True,
    })
    assert recovered.status_code == 200
    assert recovered.content == raw.encode("utf-8")
    with finance_transaction(
        personal_import["engine"], verified_user_id=user_id,
        profile_id=personal_import["scope"](user_id).profile_id,
    ) as session:
        assert session.execute(text("SELECT count(*) FROM ledger_postings")).scalar_one() == 0
