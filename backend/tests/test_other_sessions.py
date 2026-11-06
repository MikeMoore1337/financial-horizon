"""Revoke other sessions without closing the active browser or touching another user."""
from __future__ import annotations

from fastapi.testclient import TestClient

from test_email_flow import ORIGIN, PASSWORD, fixture, post, register, verify
from fh_email_auth.app import SESSION_COOKIE


def test_revoke_other_sessions_keeps_current_and_other_accounts(tmp_path):
    store, mail, current = fixture(tmp_path)
    second = TestClient(current.app)
    other_user = TestClient(current.app)

    assert register(current, "first@example.invalid").status_code == 202
    assert verify(current, mail.latest("verify")).status_code == 200
    assert post(second, "login", {
        "email": "first@example.invalid", "password": PASSWORD
    }).status_code == 200
    token1 = current.cookies.get(SESSION_COOKIE)
    token2 = second.cookies.get(SESSION_COOKIE)
    assert token1 and token2 and token1 != token2

    assert register(other_user, "other@example.invalid").status_code == 202
    assert verify(other_user, mail.latest("verify")).status_code == 200
    other_token = other_user.cookies.get(SESSION_COOKIE)
    assert other_token and other_token != token1

    response = post(current, "logout-others", {})
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert current.cookies.get(SESSION_COOKIE) == token1
    assert current.get("/api/auth/email/me").json()["authenticated"] is True
    assert second.get("/api/auth/email/me").json()["authenticated"] is False
    assert other_user.get("/api/auth/email/me").json()["authenticated"] is True
    assert store.current(token1) is not None
    assert store.current(token2) is None
    assert store.current(other_token) is not None


def test_revocation_requires_auth_origin_and_fresh_session(tmp_path):
    store, mail, current = fixture(tmp_path)
    guest = TestClient(current.app)

    assert post(guest, "logout-others", {}).status_code == 401
    assert register(current).status_code == 202
    assert verify(current, mail.latest("verify")).status_code == 200
    assert current.post("/api/auth/email/logout-others", json={}).status_code == 403
    assert current.post(
        "/api/auth/email/logout-others",
        json={},
        headers={"Origin": "https://attacker.invalid"}
    ).status_code == 403
    assert post(current, "logout-others", {}).status_code == 200
    assert post(current, "logout", {}).status_code == 200
    assert post(current, "logout-others", {}).status_code == 401


def test_revocation_stays_rate_limited(tmp_path):
    _, mail, current = fixture(tmp_path)
    assert register(current).status_code == 202
    assert verify(current, mail.latest("verify")).status_code == 200
    for _ in range(10):
        assert post(current, "logout-others", {}).status_code == 200
    assert post(current, "logout-others", {}).status_code == 429
