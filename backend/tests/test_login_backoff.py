"""Incremental login throttling without creating victim-wide lockouts."""
from __future__ import annotations
import sqlite3
from test_email_flow import PASSWORD,fixture,post,register,verify

BAD="Synthetic-Incorrect-Password-2026!"
EMAIL="one@example.invalid"

def login(client,email=EMAIL,password=BAD):
    return post(client,"login",{"email":email,"password":password})

def test_backoff_after_three_failures_and_valid_login_releases_client(tmp_path):
    now=[1700000000]
    store,mail,client=fixture(tmp_path,now=lambda:now[0])
    assert register(client).status_code==202
    assert verify(client,mail.latest("verify")).status_code==200

    for i in range(3):
        assert login(client).status_code==401,i
    blocked=login(client,password=PASSWORD)
    assert blocked.status_code==429
    assert blocked.headers["retry-after"]=="2"
    now[0]+=2
    assert login(client).status_code==401
    blocked=login(client,password=PASSWORD)
    assert blocked.status_code==429
    assert blocked.headers["retry-after"]=="4"
    now[0]+=4
    success=login(client,password=PASSWORD)
    assert success.status_code==200 and success.json()["authenticated"] is True
    with sqlite3.connect(store.path) as conn:
        assert conn.execute("SELECT count(*) FROM login_backoff").fetchone()==(0,)

def test_backoff_is_per_ip_email_pair_and_hashes_principals(tmp_path):
    now=[1700000000]
    store,mail,client=fixture(tmp_path,now=lambda:now[0])
    assert register(client).status_code==202
    assert verify(client,mail.latest("verify")).status_code==200

    for _ in range(3):
        assert login(client,email=EMAIL).status_code==401
    assert login(client,email=EMAIL,password=PASSWORD).status_code==429
    missing="missing@example.invalid"
    other=login(client,email=missing)
    assert other.status_code==401
    assert other.json()=={"detail":"Неверный email или пароль"}
    with sqlite3.connect(store.path) as conn:
        keys=[row[0] for row in conn.execute("SELECT key FROM login_backoff")]
        assert len(keys)==2
        assert all(len(key)==64 and all(c in "0123456789abcdef" for c in key) for key in keys)
        assert EMAIL not in "".join(keys) and missing not in "".join(keys)

def test_backoff_expires_without_user_wide_lockout(tmp_path):
    now=[1700000000]
    store,mail,client=fixture(tmp_path,now=lambda:now[0])
    assert register(client).status_code==202
    assert verify(client,mail.latest("verify")).status_code==200
    for _ in range(3):
        assert login(client).status_code==401
    now[0]+=3601
    assert login(client,password=PASSWORD).status_code==200
    with sqlite3.connect(store.path) as conn:
        assert conn.execute("SELECT count(*) FROM login_backoff").fetchone()==(0,)
