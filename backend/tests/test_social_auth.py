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
        assert query["code_challenge_method"] == ["s256" if p == "vk" else "S256"]
        assert query.get("scope", [""])[0] == {
            "telegram": "openid", "google": "openid profile",
            "yandex": "login:info", "vk": ""
        }[p]
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
    # Use an OS-assigned port so parallel browser/CI suites do not collide.
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
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
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=5) as browser:
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
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False) as second:
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


def test_single_provider_identity_per_user_matches_yfc_policy(tmp_path):
    """A linked account cannot add a second, conflicting subject for one provider.

    Adopt YFC's unique(user_id, provider) identity invariant without sharing
    accounts or secrets with YFC.
    """
    email, oauth, cfg, app = context(tmp_path)
    user_id, initial_token = create_email_user(email, "single@example.test")
    browser = client(app)
    browser.cookies.set(
        SESSION_COOKIE, initial_token, domain="127.0.0.1", path="/api/auth"
    )
    target = "/api/auth/oauth/google/link/start"

    def link_subject(subject):
        started = browser.post(
            target, headers={"origin": ORIGIN}, json={"confirm": True},
            follow_redirects=False
        )
        assert started.status_code == 200
        url = started.json()["authorization_url"]
        state = parse_qs(urlsplit(url).query)["state"][0]
        return finish(browser, state, subject, "google")

    first = link_subject("account-a")
    assert first.status_code == 303
    assert first.headers["location"] == "/account.html?oauth=linked"
    assert oauth.user_id_for("google", "google-account-a") == user_id

    # A different subject of the same provider must not silently become
    # a second login alias of the same financial user.
    second = link_subject("account-b")
    assert second.status_code == 303
    assert second.headers["location"] == "/account.html?oauth=failed"
    assert oauth.user_id_for("google", "google-account-b") is None
    assert oauth.user_id_for("google", "google-account-a") == user_id

    # An unsuccessful link must neither revoke the current session
    # nor change its principal.
    current = browser.get("/api/auth/email/me").json()
    assert current["authenticated"] is True
    assert current["user"]["id"] == user_id


def test_oauth_only_account_cannot_invoke_password_based_email_change(tmp_path):
    """An OAuth-only account has no verified email or password.

    The endpoint must return a controlled denial, never HTTP 500 due to
    missing email rate-limit key and never create an email-change token.
    """
    email, oauth, cfg, app = context(tmp_path)
    uid, session = oauth.complete_login("telegram", "987654321")
    browser = client(app)
    browser.cookies.set(SESSION_COOKIE, session,
                        domain="127.0.0.1", path="/api/auth")
    response = browser.post(
        "/api/auth/email/change/request",
        headers={"origin": ORIGIN},
        json={"email": "somewhere@example.test",
              "password": "not-a-password", "challenge": "test-challenge"}
    )
    assert response.status_code == 403
    assert response.json() == {"detail": "Смена email недоступна для этого аккаунта"}
    assert browser.get("/api/auth/email/me").json()["user"] == {"id": uid, "email": None}
    with sqlite3.connect(cfg.database_path) as db:
        assert db.execute(
            "SELECT count(*) FROM email_changes WHERE user_id=?", (uid,)
        ).fetchone()[0] == 0
    assert email.current(session)["id"] == uid


def test_explicit_sqlite_backup_can_be_restored_without_user_id_changes(tmp_path):
    """Destructive recovery drill on synthetic data only, never live auth storage."""
    original = tmp_path / "auth.sqlite3"
    email = EmailStore(original)
    uid, cookie = create_email_user(email, "restore@example.test")
    backup_path = tmp_path / "pre-oauth-backup.sqlite3"
    assert migrate_user_table(original, backup_path) is True
    oauth = OAuthStore(original)
    other, other_cookie = oauth.complete_login("google", "new-oauth-subject")
    assert uid != other
    assert oauth.current(other_cookie)["id"] == other

    # Simulate offline recovery into an entirely separate SQLite file.
    # Restoring an old snapshot removes any later-created OAuth users,
    # so never do this in production without a data-loss assessment.
    restored_path = tmp_path / "restored-auth.sqlite3"
    restored_path.write_bytes(backup_path.read_bytes())
    restored = EmailStore(restored_path)
    assert restored.current(cookie) == {"id": uid, "email": "restore@example.test"}
    assert restored.login("restore@example.test", "LongEnoughPassword-12345")
    with sqlite3.connect(restored_path) as db:
        assert db.execute("SELECT count(*) FROM users WHERE id=?", (other,)).fetchone()[0] == 0
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_unrecognized_user_table_index_blocks_migration_without_backup(tmp_path):
    original = tmp_path / "auth.sqlite3"
    EmailStore(original)
    with sqlite3.connect(original) as db:
        db.execute("CREATE INDEX unexpected_users_index ON users(created_at)")
    backup_path = tmp_path / "never-written-backup.sqlite3"
    with pytest.raises(ValueError, match="Unexpected users index"):
        migrate_user_table(original, backup_path)
    assert not backup_path.exists()
    with sqlite3.connect(original) as db:
        assert db.execute("PRAGMA table_info(users)").fetchall()[1][3] == 1
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_vk_payload_rejects_duplicate_json_keys_without_consuming_state(tmp_path):
    """Reject ambiguous VK payloads before claiming the one-time transaction."""
    email, oauth, cfg, app = context(tmp_path)
    browser = client(app)
    state, _ = start(browser, "vk")
    duplicated = (
        '{"state":"' + state + '","state":"' + state +
        '","code":"subject-duplicate","device_id":"device-123"}'
    )
    rejected = browser.get(
        "/api/auth/oauth/vk/callback",
        params={"payload": duplicated},
        follow_redirects=False,
    )
    assert rejected.status_code == 400
    assert oauth.user_id_for("vk", "vk-subject-duplicate") is None
    # Rejecting malformed provider input must not burn the original state.
    valid = finish(
        browser, state, "subject-after-duplicate", "vk",
        {"device_id": "device-123"},
    )
    assert valid.status_code == 303
    assert valid.headers["location"] == "/?auth=success"


def test_callback_query_size_and_parameter_counts_are_bounded(tmp_path):
    email, oauth, cfg, app = context(tmp_path)
    browser = client(app)
    state, _ = start(browser, "google")
    oversized = browser.get(
        "/api/auth/oauth/google/callback",
        params={"state": state, "code": "x", "junk": "A" * 8500},
        follow_redirects=False,
    )
    assert oversized.status_code == 413
    fragmented = browser.get(
        "/api/auth/oauth/google/callback",
        params=[("state", state), ("code", "x")]
        + [(f"noise{i}", "x") for i in range(40)],
        follow_redirects=False,
    )
    assert fragmented.status_code == 400
    # Proper callback must still succeed after malformed requests.
    assert finish(browser, state, "valid-after-noise").status_code == 303


def test_callback_get_plus_post_body_cannot_bypass_total_bytes_limit(tmp_path):
    email, oauth, cfg, app = context(tmp_path)
    browser = client(app)
    state, _ = start(browser, "google")
    response = browser.post(
        "/api/auth/oauth/google/callback",
        params={"state": state, "padding": "Z" * 3900},
        headers={"content-type": "application/x-www-form-urlencoded"},
        content="code=valid&padding2=" + "B" * 4900,
        follow_redirects=False,
    )
    assert response.status_code == 413
    assert finish(browser, state, "valid-after-big-post").status_code == 303


def test_streamed_callback_body_has_a_hard_cap_before_state_claim(tmp_path):
    """Chunked or unknown-length form bodies must not be read without limits."""
    email, oauth, cfg, app = context(tmp_path)
    browser = client(app)
    state, _ = start(browser, "google")
    def chunks():
        yield b"code=some-code&extra="
        yield b"X" * 9000
    oversized = browser.post(
        "/api/auth/oauth/google/callback",
        params={"state": state},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        content=chunks(),
        follow_redirects=False,
    )
    assert oversized.status_code == 413
    assert finish(browser, state, "valid-after-chunks").status_code == 303


def test_callback_rejects_oversized_content_length_number(tmp_path):
    email, oauth, cfg, app = context(tmp_path)
    browser = client(app)
    state, _ = start(browser, "google")
    rejected = browser.post(
        "/api/auth/oauth/google/callback",
        params={"state": state},
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": "9" * 4500,
        },
        content="code=valid",
        follow_redirects=False,
    )
    assert rejected.status_code == 400
    assert finish(browser, state, "good-after-invalid-length").status_code == 303
