"""Shared email/OAuth users, session lifecycle, explicit linking and CSRF/replay tests.

Synthetic OAuth exchanges only; no claim of real provider login or human review.
"""
from __future__ import annotations

import sqlite3
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fh_auth.config import Config
from fh_auth.app import make_oauth_router
from fh_auth.migrate import migrate_user_table
from fh_auth.providers import OAuthProvider, pkce_challenge
from fh_auth.store import OAuthStore, Claim
from fh_email_auth.app import create_app as create_email_app, SESSION_COOKIE
from fh_email_auth.config import Settings
from fh_email_auth.store import AuthStore as EmailStore, AuthFailure


CREDS = {
    "telegram": ("123456789", "test-telegram-secret"),
    "google": ("test-google-client", "test-google-secret"),
    "yandex": ("test-yandex-client", "test-yandex-secret"),
    "vk": ("test-vk-client", ""),
}
ORIGIN = "http://127.0.0.1:8791"


def context(tmp_path, *, providers=("telegram", "google", "yandex", "vk"), exchanger=None):
    db = tmp_path / "auth.sqlite3"
    email = EmailStore(db)
    backup = tmp_path / "auth.pre-oauth.sqlite3"
    assert migrate_user_table(db, backup) is True
    oauth = OAuthStore(db)
    assert backup.exists()
    config = Config(True, ORIGIN, db, "synthetic-oauth-rate-secret-1234567890",
                    CREDS, test_mode=True, allowed_providers=providers)
    settings = Settings(True, ORIGIN, db, "synthetic-email-rate-secret-1234567890",
                        "turnstile-test-secret", "turnstile-test-sitekey",
                        "smtp.invalid", 465, "test", "test", "noreply@example.test",
                        test_mode=True)

    async def fake_exchange(provider, claim, code, *, device_id, state):
        if not code or code == "fail":
            raise RuntimeError("synthetic provider failure without tokens")
        return provider.name + "-" + code

    app = create_email_app(
        settings, email,
        captcha=lambda *args: True, mailer=None,
        oauth_config=config, oauth_store=oauth, oauth_exchanger=exchanger or fake_exchange
    )
    return email, oauth, config, app


def client(app):
    return TestClient(app, base_url=ORIGIN)


def create_email_user(email_store, address):
    code = email_store.create_account(address)
    assert code is not None
    token = email_store.confirm_email(code, "LongEnoughPassword-12345")
    user = email_store.current(token)
    assert user is not None and user["email"] == address
    return user["id"], token


def start(browser, provider="google"):
    response = browser.get(f"/api/auth/oauth/{provider}/start", follow_redirects=False)
    assert response.status_code == 303, response.text
    query = parse_qs(urlsplit(response.headers["location"]).query)
    return query["state"][0], response


def finish(browser, state, code, provider="google", extra=None):
    return browser.get(
        f"/api/auth/oauth/{provider}/callback",
        params={"state": state, "code": code, **(extra or {})},
        follow_redirects=False
    )


def test_provider_redirects_exact_pkce_and_minimal_scope():
    for p, (cid, secret) in CREDS.items():
        provider = OAuthProvider(p, cid, secret)
        url = provider.authorize(
            base="https://fin-horizon.mikemoore.top",
            state="s" * 45, verifier="v" * 65, nonce="n" * 45
        )
        query = parse_qs(urlsplit(url).query)
        assert query["redirect_uri"] == [
            "https://fin-horizon.mikemoore.top/api/auth/oauth/" + p + "/callback"
        ]
        assert query["code_challenge"] == [pkce_challenge("v" * 65)]
        assert query["code_challenge_method"] == ["S256"]
        assert query.get("scope", [""])[0] in ("openid", "login:info", "")
        assert "email" not in query.get("scope", [""])[0]
        if p in ("telegram", "google"):
            assert query["nonce"] == ["n" * 45]
        else:
            assert "nonce" not in query


def test_configuration_fails_closed_and_single_database(monkeypatch, tmp_path):
    monkeypatch.setenv("FH_ENABLE_CLOUD_AUTH", "true")
    monkeypatch.setenv("FH_EMAIL_AUTH_ENABLED", "true")
    monkeypatch.setenv("FH_PUBLIC_URL", "https://fin-horizon.mikemoore.top")
    monkeypatch.setenv("FH_AUTH_DATABASE_PATH", str(tmp_path / "auth.sqlite3"))
    monkeypatch.setenv("FH_SESSION_SECRET", "synthetic-only-session-secret-12345678")
    monkeypatch.setenv("FH_GOOGLE_OAUTH_CLIENT_ID", "synthetic-id")
    monkeypatch.setenv("FH_GOOGLE_OAUTH_CLIENT_SECRET", "synthetic-secret")
    monkeypatch.delenv("FH_GOOGLE_OAUTH_ENABLED", raising=False)
    with pytest.raises(ValueError, match="No provider"):
        Config.from_env()
    monkeypatch.setenv("FH_GOOGLE_OAUTH_ENABLED", "true")
    cfg = Config.from_env()
    assert cfg.active_providers() == ("google",)
    monkeypatch.setenv("FH_OAUTH_DATABASE_PATH", str(tmp_path / "old-oauth.sqlite3"))
    with pytest.raises(ValueError, match="Standalone OAuth"):
        Config.from_env()
    with pytest.raises(ValueError):
        Config(True, ORIGIN, tmp_path / "x", "short", CREDS, test_mode=True,
               allowed_providers=("google",))


def test_email_schema_migration_backup_is_atomic_and_idempotent(tmp_path):
    db = tmp_path / "auth.sqlite3"
    email = EmailStore(db)
    user, session = create_email_user(email, "before@example.test")
    pending = email.create_account("pending@example.test")
    with sqlite3.connect(db) as cx:
        original = cx.execute("SELECT id,email FROM users ORDER BY id").fetchall()
        action_count = cx.execute("SELECT count(*) FROM actions").fetchone()[0]
        count_sessions = cx.execute("SELECT count(*) FROM sessions").fetchone()[0]
    backup = tmp_path / "auth.pre-oauth.sqlite3"
    assert migrate_user_table(db, backup) is True
    assert migrate_user_table(db, tmp_path / "backup2.sqlite3") is False
    with sqlite3.connect(db) as cx:
        assert cx.execute("SELECT id,email FROM users ORDER BY id").fetchall() == original
        assert cx.execute("SELECT count(*) FROM actions").fetchone()[0] == action_count
        assert cx.execute("SELECT count(*) FROM sessions").fetchone()[0] == count_sessions
        assert cx.execute("PRAGMA foreign_key_check").fetchall() == []
        assert cx.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    with sqlite3.connect(backup) as cx:
        assert cx.execute("SELECT id,email FROM users ORDER BY id").fetchall() == original
    assert email.current(session)["id"] == user
    assert email.email_action("pending@example.test", "verify")
    assert pending is not None
    oauth = OAuthStore(db)
    other, oauth_session = oauth.complete_login("google", "same-email-not-used")
    assert user != other
    assert oauth.current(oauth_session) == {"id": other, "email": None}
    assert email.login("before@example.test", "LongEnoughPassword-12345")
    assert email.current(session)["id"] == user


def test_no_implicit_merging_and_shared_cookie_stable_ids(tmp_path):
    email, oauth, cfg, app = context(tmp_path)
    uid, token = create_email_user(email, "shared@example.test")
    browser = client(app)
    state, _ = start(browser, "google")
    ok = finish(browser, state, "subject-1", "google")
    assert ok.status_code == 303
    assert ok.headers["location"] == "/?auth=success"
    assert SESSION_COOKIE in browser.cookies
    oauth_identity = browser.get("/api/auth/email/me").json()
    assert oauth_identity["authenticated"] is True
    assert oauth_identity["user"]["id"] != uid
    assert oauth_identity["user"]["email"] is None
    same, _ = start(client(app), "google")
    repeat = client(app)
    state2, _ = start(repeat, "google")
    assert finish(repeat, state2, "subject-1", "google").status_code == 303
    assert repeat.get("/api/auth/email/me").json()["user"]["id"] == oauth_identity["user"]["id"]
    assert oauth.user_id_for("google", "google-subject-1") == oauth_identity["user"]["id"]
    assert email.current(token)["id"] == uid
    assert uid != oauth.user_id_for("google", "google-subject-1")


def test_explicit_link_requires_origin_confirmation_and_rotates_session(tmp_path):
    email, oauth, cfg, app = context(tmp_path)
    uid, original = create_email_user(email, "link@example.test")
    browser = client(app)
    browser.cookies.set(SESSION_COOKIE, original, domain="127.0.0.1", path="/api/auth")
    endpoint = "/api/auth/oauth/yandex/link/start"
    assert browser.post(endpoint, json={"confirm": True}).status_code == 403
    assert browser.post(endpoint, headers={"origin": ORIGIN}, json={"confirm": False}).status_code == 400
    assert browser.post(endpoint, headers={"origin": ORIGIN}, json={"confirm": 1}).status_code == 422
    begin = browser.post(endpoint, headers={"origin": ORIGIN}, json={"confirm": True},
                         follow_redirects=False)
    assert begin.status_code == 200
    assert begin.headers["cache-control"] == "no-store"
    assert begin.json()["authorization_url"].startswith("https://oauth.yandex.ru/authorize?")
    state = parse_qs(urlsplit(begin.json()["authorization_url"]).query)["state"][0]
    finish_link = finish(browser, state, "sub-2", "yandex")
    assert finish_link.status_code == 303
    assert finish_link.headers["location"] == "/account.html?oauth=linked"
    assert oauth.user_id_for("yandex", "yandex-sub-2") == uid
    assert email.current(original) is None
    updated = browser.get("/api/auth/email/me").json()
    assert updated["authenticated"] is True and updated["user"]["id"] == uid
    assert browser.cookies.get(SESSION_COOKIE) != original


def test_link_session_swap_cross_account_and_collision_denied(tmp_path):
    email, oauth, cfg, app = context(tmp_path)
    uid_a, token_a = create_email_user(email, "a@example.test")
    uid_b, token_b = create_email_user(email, "b@example.test")
    browser_a = client(app)
    browser_a.cookies.set(SESSION_COOKIE, token_a, domain="127.0.0.1", path="/api/auth")
    endpoint = "/api/auth/oauth/google/link/start"
    begun = browser_a.post(endpoint, json={"confirm": True},
                           headers={"origin": ORIGIN}, follow_redirects=False)
    state = parse_qs(urlsplit(begun.json()["authorization_url"]).query)["state"][0]
    browser_a.cookies.set(SESSION_COOKIE, token_b, domain="127.0.0.1", path="/api/auth")
    swapped = finish(browser_a, state, "subject-swap", "google")
    assert swapped.headers["location"] == "/account.html?oauth=failed"
    assert oauth.user_id_for("google", "google-subject-swap") is None
    assert email.current(token_b)["id"] == uid_b
    # The subject already belongs to B, linking it to A must fail.
    b_state = browser_a.post(endpoint, json={"confirm": True},
                             headers={"origin": ORIGIN}, follow_redirects=False)
    state_b = parse_qs(urlsplit(b_state.json()["authorization_url"]).query)["state"][0]
    assert finish(browser_a, state_b, "owned", "google").headers["location"].endswith("linked")
    assert oauth.user_id_for("google", "google-owned") == uid_b
    browser_a.cookies.set(SESSION_COOKIE, token_a, domain="127.0.0.1", path="/api/auth")
    a_state = browser_a.post(endpoint, json={"confirm": True},
                             headers={"origin": ORIGIN}, follow_redirects=False)
    state_a = parse_qs(urlsplit(a_state.json()["authorization_url"]).query)["state"][0]
    conflict = finish(browser_a, state_a, "owned", "google")
    assert conflict.headers["location"] == "/account.html?oauth=failed"
    assert oauth.user_id_for("google", "google-owned") == uid_b
    assert email.current(token_a)["id"] == uid_a


def test_browser_marker_duplicate_state_replay_and_expired(tmp_path):
    email, oauth, cfg, app = context(tmp_path)
    browser = client(app)
    state, response = start(browser)
    outsider = client(app)
    assert finish(outsider, state, "x").status_code == 400
    dup = browser.get("/api/auth/oauth/google/callback",
                      params=[("state", state), ("state", state), ("code", "x")],
                      follow_redirects=False)
    assert dup.status_code == 400
    assert finish(browser, state, "x").status_code == 303
    assert finish(browser, state, "x").status_code == 400
    # A short-lived transaction must never become usable again.
    now = [int(time.time())]
    expired_store = OAuthStore(cfg.database_path, now=lambda: now[0])
    expired_store.begin(provider="vk", state="s"*45, browser_marker="m"*45,
                        verifier="v"*55, nonce="n"*45,
                        redirect_uri="https://example.test/cb", ttl=1)
    now[0] += 2
    assert expired_store.claim(provider="vk", state="s"*45, marker="m"*45) is None


def test_vk_device_required_state_errors_and_provider_denials(tmp_path):
    email, oauth, cfg, app = context(tmp_path)
    browser = client(app)
    state, _ = start(browser, "vk")
    missing = finish(browser, state, "test", "vk")
    assert missing.headers["location"] == "/account.html?oauth=failed"
    assert SESSION_COOKIE not in browser.cookies
    second, _ = start(browser, "vk")
    ok = finish(browser, second, "test", "vk", {"device_id": "device-123"})
    assert ok.headers["location"] == "/?auth=success"
    assert browser.get("/api/auth/email/me").json()["authenticated"]
    other = client(app)
    state3, _ = start(other, "yandex")
    denied = other.get("/api/auth/oauth/yandex/callback",
                       params={"state": state3, "error": "access_denied"},
                       follow_redirects=False)
    assert denied.headers["location"] == "/account.html?oauth=denied"
    assert finish(other, state3, "retry", "yandex").status_code == 400


def test_login_cannot_overwrite_live_email_session_or_leave_it_active_on_relogin(tmp_path):
    email, oauth, cfg, app = context(tmp_path)
    uid, original = create_email_user(email, "principal@example.test")
    browser = client(app)
    browser.cookies.set(SESSION_COOKIE, original, domain="127.0.0.1", path="/api/auth")
    assert browser.get("/api/auth/oauth/google/start").status_code == 409
    assert browser.get("/api/auth/email/me").json()["user"]["id"] == uid
    browser.cookies.delete(SESSION_COOKIE, domain="127.0.0.1", path="/api/auth")
    state, _ = start(browser, "google")
    browser.cookies.set(SESSION_COOKIE, original, domain="127.0.0.1", path="/api/auth")
    denied = finish(browser, state, "unexpected", "google")
    assert denied.headers["location"] == "/account.html?oauth=failed"
    assert oauth.user_id_for("google", "google-unexpected") is None
    assert email.current(original)["id"] == uid


def test_oauth_sessions_email_logout_revoke_others_and_two_accounts(tmp_path):
    email, oauth, cfg, app = context(tmp_path)
    user_a, session_a = oauth.complete_login("google", "a")
    same_a, session_a2 = oauth.complete_login("google", "a")
    user_b, session_b = oauth.complete_login("vk", "b")
    assert user_a == same_a != user_b
    browser = client(app)
    browser.cookies.set(SESSION_COOKIE, session_a, domain="127.0.0.1", path="/api/auth")
    revoked = browser.post("/api/auth/email/logout-others", headers={"origin": ORIGIN})
    assert revoked.status_code == 200
    assert email.current(session_a) is not None
    assert email.current(session_a2) is None
    assert email.current(session_b) is not None
    logout = browser.post("/api/auth/email/logout", headers={"origin": ORIGIN})
    assert logout.status_code == 200
    assert email.current(session_a) is None
    assert email.current(session_b) is not None


def test_throttle_denies_abuse_and_preserves_email_state(tmp_path):
    email, oauth, cfg, app = context(tmp_path)
    browser = client(app)
    for _ in range(8):
        assert browser.get("/api/auth/oauth/google/start", follow_redirects=False).status_code == 303
    assert browser.get("/api/auth/oauth/google/start").status_code == 429
    for _ in range(20):
        assert browser.get("/api/auth/oauth/google/callback",
                           params={"state": "x" * 45}, follow_redirects=False).status_code == 400
    assert browser.get("/api/auth/oauth/google/callback",
                       params={"state": "x" * 45}, follow_redirects=False).status_code == 429
    email_user, token = create_email_user(email, "healthy@example.test")
    assert email.current(token)["id"] == email_user


def test_provider_disabled_routes_not_advertised(tmp_path):
    email, oauth, cfg, app = context(tmp_path, providers=("google",))
    browser = client(app)
    assert browser.get("/api/auth/providers").json() == {"enabled": True, "providers": ["google"]}
    assert browser.get("/api/auth/oauth/yandex/start").status_code == 404
    assert browser.post("/api/auth/oauth/yandex/link/start",
                        headers={"origin": ORIGIN}, json={"confirm": True}).status_code == 404


def test_real_loopback_http_with_sqlite_and_cookies(tmp_path):
    """Actual TCP/HTTP request path through Uvicorn; no synthetic ASGI transport."""
    import socket
    import threading
    import httpx
    import uvicorn

    email, oauth, cfg, app = context(tmp_path)
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 8791))
    listener.listen(32)
    server = uvicorn.Server(uvicorn.Config(
        app, log_level="critical", access_log=False
    ))
    worker = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
    worker.start()
    try:
        for _ in range(100):
            if server.started:
                break
            time.sleep(0.05)
        assert server.started, "Uvicorn did not start"
        with httpx.Client(base_url=ORIGIN, trust_env=False, timeout=5) as browser:
            offer = browser.get("/api/auth/providers").json()
            assert offer["providers"] == ["telegram", "google", "yandex", "vk"]
            state, _ = start(browser)
            finished = finish(browser, state, "tcp-id")
            assert finished.status_code == 303
            assert "fh_email_session" in finished.headers["set-cookie"]
            account = browser.get("/api/auth/email/me").json()
            assert account["authenticated"] is True
            assert account["user"]["email"] is None
            uid = account["user"]["id"]
            with httpx.Client(base_url=ORIGIN, trust_env=False) as second:
                state2, _ = start(second)
                assert finish(second, state2, "tcp-id").status_code == 303
                assert second.get("/api/auth/email/me").json()["user"]["id"] == uid
            assert browser.post("/api/auth/email/logout",
                                headers={"origin": ORIGIN}, json={}).json() == {"ok": True}
            assert browser.get("/api/auth/email/me").json()["authenticated"] is False
            assert oauth.user_id_for("google", "google-tcp-id") == uid
    finally:
        server.should_exit = True
        worker.join(timeout=7)
        listener.close()
        assert not worker.is_alive(), "Uvicorn loopback server failed to stop"
