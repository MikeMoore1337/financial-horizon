"""#69: explicit personal HTTP legacy import with real FH SQLite + PostgreSQL.

Disposable synthetic users/database only; no real browser files, no production
upload, no financial identifier or value logged to external artifacts.
"""
from __future__ import annotations

from hashlib import sha256
import json
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import text

from backend.fh_email_auth.app import create_app
from backend.fh_email_auth.config import Settings
from backend.finance_db.db import finance_transaction
from backend.finance_api.tests.test_http import env, ORIGIN, NAMESPACE, COOKIE


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
