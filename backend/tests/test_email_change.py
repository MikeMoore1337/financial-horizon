"""Email change, session rotation and tenant separation using only synthetic accounts."""
from __future__ import annotations
import sqlite3
import sys
from pathlib import Path
from fastapi.testclient import TestClient
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from fh_email_auth.app import SESSION_COOKIE
from fh_email_auth.security import token_hash
from test_email_flow import fixture,post,register,verify,PASSWORD,ORIGIN

def registered(tmp_path):
    store,mail,current=fixture(tmp_path)
    assert register(current,"one@example.invalid").status_code==202
    assert verify(current,mail.latest("verify")).status_code==200
    return store,mail,current

def change(client, target="new@example.invalid", password=PASSWORD, challenge="valid-change-email"):
    return post(client,"change/request",{"email":target,"password":password,"challenge":challenge})

def test_confirmed_email_change_rotates_cookie_and_revokes_other_sessions(tmp_path):
    store,mail,current=registered(tmp_path)
    other_browser=TestClient(current.app)
    assert post(other_browser,"login",{"email":"one@example.invalid","password":PASSWORD}).status_code==200
    uid=current.get("/api/auth/email/me").json()["user"]["id"]
    old_cookie=current.cookies.get(SESSION_COOKIE)
    other_cookie=other_browser.cookies.get(SESSION_COOKIE)
    assert old_cookie and other_cookie and old_cookie!=other_cookie

    assert change(current).status_code==202
    assert mail.sent[-1][0]=="new@example.invalid"
    raw=mail.latest("email-change")
    with sqlite3.connect(store.path) as db:
        row=db.execute("SELECT hash,new_email FROM email_changes").fetchone()
    assert row==(token_hash(raw),"new@example.invalid")
    assert raw not in row[0]
    assert current.get("/api/auth/email/me").json()["user"]["email"]=="one@example.invalid"

    confirmed=post(current,"change/confirm",{"token":raw})
    assert confirmed.status_code==200 and confirmed.json()=={"ok":True,"authenticated":True}
    rotated=current.cookies.get(SESSION_COOKIE)
    assert rotated and rotated!=old_cookie
    assert store.current(old_cookie) is None and store.current(other_cookie) is None
    new_profile=current.get("/api/auth/email/me").json()["user"]
    assert new_profile=={"id":uid,"email":"new@example.invalid"}
    assert other_browser.get("/api/auth/email/me").json()["authenticated"] is False
    assert post(current,"login",{"email":"one@example.invalid","password":PASSWORD}).status_code==401
    assert post(current,"login",{"email":"new@example.invalid","password":PASSWORD}).status_code==200
    assert post(current,"change/confirm",{"token":raw}).status_code==400
    assert mail.sent[-1][0]=="one@example.invalid"
    assert mail.sent[-1][1]=="email-changed"
    with sqlite3.connect(store.path) as db:
        assert db.execute("SELECT count(*) FROM email_changes").fetchone()==(0,)

def test_change_requires_current_password_captcha_and_same_origin(tmp_path):
    _,mail,current=registered(tmp_path)
    guest=TestClient(current.app)
    start=len(mail.sent)
    assert change(guest).status_code==401
    assert change(current,challenge="bad").status_code==400
    assert change(current,password="incorrect").status_code==401
    assert current.post("/api/auth/email/change/request",json={
        "email":"new@example.invalid","password":PASSWORD,"challenge":"valid-change-email"
    }).status_code==403
    assert change(current).status_code==202
    assert len(mail.sent)==start+1

def test_email_collision_is_generic_and_wrong_user_cannot_confirm(tmp_path):
    store,mail,a=registered(tmp_path)
    b=TestClient(a.app)
    assert register(b,"two@example.invalid").status_code==202
    assert verify(b,mail.latest("verify"),"Some-other-passphrase-2026!").status_code==200
    a_id=a.get("/api/auth/email/me").json()["user"]["id"]
    b_id=b.get("/api/auth/email/me").json()["user"]["id"]
    count=len(mail.sent)
    response=change(a,target="two@example.invalid")
    assert response.status_code==202
    assert len(mail.sent)==count
    token_result=change(a,target="available@example.invalid")
    assert token_result.status_code==response.status_code
    assert token_result.json()==response.json()
    token=mail.latest("email-change")
    assert post(b,"change/confirm",{"token":token}).status_code==400
    assert b.get("/api/auth/email/me").json()["user"]["id"]==b_id
    assert post(a,"change/confirm",{"token":token}).status_code==200
    assert a.get("/api/auth/email/me").json()["user"]=={"id":a_id,"email":"available@example.invalid"}

def test_email_change_expires_and_replay_never_changes_address(tmp_path):
    now=[1700000000]
    store,mail,current=fixture(tmp_path,now=lambda:now[0])
    assert register(current).status_code==202
    assert verify(current,mail.latest("verify")).status_code==200
    assert change(current).status_code==202
    token=mail.latest("email-change")
    now[0]+=3601
    assert post(current,"change/confirm",{"token":token}).status_code==400
    assert current.get("/api/auth/email/me").json()["user"]["email"]=="one@example.invalid"
    assert change(current).status_code==202
    token2=mail.latest("email-change")
    assert token2!=token
    assert post(current,"change/confirm",{"token":token}).status_code==400
    assert post(current,"change/confirm",{"token":token2}).status_code==200
    assert post(current,"change/confirm",{"token":token2}).status_code==400

def test_password_reset_cancels_pending_email_change(tmp_path):
    store,mail,current=registered(tmp_path)
    assert change(current).status_code==202
    pending=mail.latest("email-change")
    assert post(current,"reset/request",{"email":"one@example.invalid","challenge":"valid-reset"}).status_code==202
    reset=mail.latest("reset")
    assert post(current,"reset/confirm",{"token":reset,"password":"Different-password-2026!"}).status_code==200
    with sqlite3.connect(store.path) as db:
        assert db.execute("SELECT count(*) FROM email_changes").fetchone()==(0,)
    assert post(current,"login",{"email":"one@example.invalid","password":"Different-password-2026!"}).status_code==200
    assert post(current,"change/confirm",{"token":pending}).status_code==400
    assert current.get("/api/auth/email/me").json()["user"]["email"]=="one@example.invalid"

def test_same_browser_login_rotates_presented_session_cookie(tmp_path):
    store,mail,current=registered(tmp_path)
    old=current.cookies.get(SESSION_COOKIE)
    assert post(current,"login",{"email":"one@example.invalid","password":PASSWORD}).status_code==200
    new=current.cookies.get(SESSION_COOKIE)
    assert new!=old and store.current(old) is None and store.current(new) is not None
    rotate=post(current,"session/rotate",{})
    assert rotate.status_code==200 and rotate.json()=={"ok":True,"authenticated":True}
    third=current.cookies.get(SESSION_COOKIE)
    assert third!=new and store.current(new) is None and store.current(third) is not None
    attacker=TestClient(current.app)
    attacker.cookies.set(SESSION_COOKIE,new,path="/api/auth")
    assert post(attacker,"session/rotate",{}).status_code==401
    assert current.get("/api/auth/email/me").json()["authenticated"] is True

def test_change_is_rate_limited_without_sending_more_mail(tmp_path):
    _,mail,current=registered(tmp_path)
    for _ in range(2):
        assert change(current).status_code==202
    assert change(current).status_code==429
    assert len([msg for msg in mail.sent if msg[1]=="email-change"])==2


def test_session_rotation_requires_origin_and_rejects_stale_cookie(tmp_path):
 store,mail,current=registered(tmp_path)
 original=current.cookies.get(SESSION_COOKIE)
 assert current.post("/api/auth/email/session/rotate",json={}).status_code==403
 assert current.post("/api/auth/email/session/rotate",json={},
                     headers={"Origin":"https://attacker.invalid"}).status_code==403
 assert post(current,"session/rotate",{}).status_code==200
 assert store.current(original) is None
 assert current.get("/api/auth/email/me").json()["authenticated"] is True

def test_email_change_token_invalidated_by_newer_request(tmp_path):
 store,mail,current=registered(tmp_path)
 assert change(current,target="first-available@example.invalid").status_code==202
 token1=mail.latest("email-change")
 assert change(current,target="second-available@example.invalid").status_code==202
 token2=mail.latest("email-change")
 assert post(current,"change/confirm",{"token":token1}).status_code==400
 assert post(current,"change/confirm",{"token":token2}).status_code==200
 assert current.get("/api/auth/email/me").json()["user"]["email"]=="second-available@example.invalid"
