"""#51: personal-only email session regression against real SQLite AuthStore.

All credentials/users are synthetic. No production access or real email inbox
is claimed. Public registration remains a separate release decision.
"""
from __future__ import annotations

import sqlite3

from fastapi.testclient import TestClient

from fh_email_auth.app import SESSION_COOKIE
from fh_email_auth.store import AuthStore
from test_email_flow import ORIGIN, PASSWORD, fixture, post, register, verify


def _register(client, mail, email, password=PASSWORD):
    assert register(client, email).status_code == 202
    assert verify(client, mail.latest("verify"), password).status_code == 200
    identity = client.get("/api/auth/email/me").json()["user"]
    assert identity["email"] == email
    return identity


def test_personal_mode_two_principals_three_sessions_rotate_switch_and_revoke(tmp_path):
    store, mail, first = fixture(tmp_path)
    second = TestClient(first.app)
    unrelated = TestClient(first.app)
    unrelated_extra = TestClient(first.app)

    owner = _register(first, mail, "owner@example.invalid")
    guest = _register(unrelated, mail, "guest@example.invalid", "Another-Passphrase-2026!")
    assert owner["id"] != guest["id"]
    assert post(second, "login", {
        "email": "owner@example.invalid", "password": PASSWORD,
    }).status_code == 200
    assert post(unrelated_extra, "login", {
        "email": "guest@example.invalid", "password": "Another-Passphrase-2026!",
    }).status_code == 200

    first_token = first.cookies.get(SESSION_COOKIE)
    second_token = second.cookies.get(SESSION_COOKIE)
    guest_token = unrelated.cookies.get(SESSION_COOKIE)
    spare_guest_token = unrelated_extra.cookies.get(SESSION_COOKIE)
    assert len({first_token, second_token, guest_token, spare_guest_token}) == 4

    # An attacker cannot revoke owner sessions using an untrusted Origin,
    # spoofed proxy headers or a cookie of another account.
    forged = first.post("/api/auth/email/logout-others", json={}, headers={
        "Origin": "https://invalid.example",
        "X-Forwarded-For": "127.0.0.1",
        "Forwarded": "for=127.0.0.1",
    })
    assert forged.status_code == 403
    assert store.current(first_token) is not None
    assert store.current(second_token) is not None
    assert first.post("/api/auth/email/logout-others", json={},
                      headers={"Origin": ORIGIN, "Host": "evil.invalid"}).status_code == 400

    rotated = post(first, "session/rotate", {})
    assert rotated.status_code == 200
    assert "httponly" in rotated.headers["set-cookie"].lower()
    rotated_token = first.cookies.get(SESSION_COOKIE)
    assert rotated_token and rotated_token != first_token
    assert store.current(first_token) is None
    assert store.current(second_token) is not None

    assert post(first, "logout-others", {}).status_code == 200
    assert store.current(second_token) is None
    assert store.current(rotated_token) is not None
    assert store.current(guest_token) is not None

    # Switching identity in the SAME browser must revoke the prior account's
    # cookie without killing the other owner's independent sessions.
    assert post(unrelated, "login", {
        "email": "owner@example.invalid", "password": PASSWORD,
    }).status_code == 200
    switched_token = unrelated.cookies.get(SESSION_COOKIE)
    assert switched_token not in (guest_token, rotated_token)
    assert store.current(guest_token) is None
    assert unrelated.get("/api/auth/email/me").json()["user"] == owner
    assert store.current(spare_guest_token) is not None

    assert post(first, "logout", {}).status_code == 200
    assert store.current(rotated_token) is None
    assert first.get("/api/auth/email/me").json()["authenticated"] is False
    assert unrelated.get("/api/auth/email/me").json()["user"] == owner
    assert unrelated_extra.get("/api/auth/email/me").json()["user"] == guest
    for client in (first, second, unrelated_extra):
        response = client.get("/api/auth/email/me")
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["x-content-type-options"] == "nosniff"


def test_email_change_two_synthetic_inboxes_notifies_old_and_revokes_sessions(tmp_path):
    store, mail, first = fixture(tmp_path)
    second = TestClient(first.app)
    _register(first, mail, "original@example.invalid")
    assert post(second, "login", {
        "email":"original@example.invalid", "password":PASSWORD,
    }).status_code == 200
    old_1 = first.cookies.get(SESSION_COOKIE)
    old_2 = second.cookies.get(SESSION_COOKIE)
    requested = post(first, "change/request", {
        "email":"new-owner@example.invalid", "password":PASSWORD,
        "challenge":"valid-change-email",
    })
    assert requested.status_code == 202
    token = mail.latest("email-change")
    # Another device of the SAME authenticated user may legitimately confirm.
    # A DIFFERENT user must not be able to use the token.
    outsider = TestClient(first.app)
    _register(outsider, mail, "outsider@example.invalid", "Third-passphrase-2026!")
    assert post(outsider, "change/confirm", {"token":token}).status_code == 400
    confirmed = post(first, "change/confirm", {"token":token})
    assert confirmed.status_code == 200
    assert store.current(old_1) is None and store.current(old_2) is None
    assert post(first, "change/confirm", {"token":token}).status_code == 400
    assert second.get("/api/auth/email/me").json()["authenticated"] is False
    assert first.get("/api/auth/email/me").json()["user"]["email"] == "new-owner@example.invalid"

    delivery_types = [(address, kind) for address, kind, _ in mail.sent]
    assert ("new-owner@example.invalid", "email-change") in delivery_types
    assert ("original@example.invalid", "email-changed") in delivery_types
    assert post(first, "login", {
        "email":"original@example.invalid", "password":PASSWORD,
    }).status_code == 401
    assert post(first, "login", {
        "email":"new-owner@example.invalid", "password":PASSWORD,
    }).status_code == 200


def test_synthetic_sqlite_consistent_backup_restores_owner_identity_and_tokens(tmp_path):
    store, mail, client = fixture(tmp_path)
    owner = _register(client, mail, "backup-owner@example.invalid")
    session = client.cookies.get(SESSION_COOKIE)
    assert session
    path = tmp_path / "synthetic-restore.sqlite"
    # Use the SQLite backup API instead of copying a live WAL db file.
    with sqlite3.connect(store.path) as original, sqlite3.connect(path) as target:
        original.backup(target)
        assert target.execute("PRAGMA integrity_check").fetchone() == ("ok",)
    restored = AuthStore(path)
    assert restored.current(session) == owner
    restored.logout(session)
    assert restored.current(session) is None
    # Recovery exercises a disposable DB ONLY; never restore it over the
    # current live SQLite or copy real session tokens to public CI artifacts.
    assert store.current(session) == owner
