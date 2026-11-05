"""Isolated email registration and login lifecycle."""
from __future__ import annotations
import sqlite3
import sys
from pathlib import Path
from fastapi.testclient import TestClient

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from fh_email_auth.app import create_app, SESSION_COOKIE
from fh_email_auth.config import Settings
from fh_email_auth.store import AuthStore
from fh_email_auth.security import token_hash

ORIGIN="http://127.0.0.1:8791"
PASSWORD="A-strong-passphrase-98520!"

class Mail:
 def __init__(self):self.sent=[];self.fail=False
 def send(self,email,purpose,token):
  if self.fail:raise RuntimeError("simulated failure")
  self.sent.append((email,purpose,token))
  return True
 def latest(self,purpose):
  return next(token for _,p,token in reversed(self.sent) if p==purpose)

def fixture(tmp_path,now=None):
 config=Settings(True,ORIGIN,tmp_path/"db.sqlite","h"*48,"test-ts-secret","site",
      "smtp.test.invalid",465,"user","not-a-secret","noreply@test.invalid",True)
 store=AuthStore(config.database_path,now=now)
 mail=Mail()
 client=TestClient(create_app(config,store=store,mailer=mail,
     captcha=lambda secret,token,origin,action:secret=="test-ts-secret" and
          token=="valid-"+action and origin==ORIGIN))
 return store,mail,client

def post(c,s,p):return c.post("/api/auth/email/"+s,json=p,headers={"Origin":ORIGIN})

def register(c,email="one@example.invalid",challenge="valid-register"):
 return post(c,"register",{"email":email,"challenge":challenge})

def verify(c,token,password=PASSWORD):
 return post(c,"verify",{"token":token,"password":password})

def test_email_registration_does_not_store_unverified_password(tmp_path):
 store,mail,client=fixture(tmp_path)
 result=register(client)
 assert result.status_code==202
 assert len(mail.sent)==1
 with sqlite3.connect(store.path) as db:
  assert db.execute("SELECT password_hash,verified_at FROM users").fetchone()==("",None)
 assert post(client,"login",{"email":"one@example.invalid","password":PASSWORD}).status_code==401
 token=mail.latest("verify")
 assert verify(client,token).status_code==200
 assert SESSION_COOKIE in client.cookies
 assert verify(client,token).status_code==400
 with sqlite3.connect(store.path) as db:
  stored,verified=db.execute("SELECT password_hash,verified_at FROM users").fetchone()
  token_hash_stored=db.execute("SELECT hash FROM actions WHERE purpose='verify'").fetchone()[0]
 assert stored.startswith("$argon2id$") and verified is not None
 assert token_hash_stored==token_hash(token)
 assert token not in stored
 assert client.get("/api/auth/email/me").json()["authenticated"] is True

def test_duplicate_and_unknown_accounts_not_enumerable_by_response(tmp_path):
 store,mail,client=fixture(tmp_path)
 first=register(client)
 second=register(client,"ONE@example.invalid")
 assert first.status_code==202 and first.json()==second.json()
 assert len(mail.sent)==1
 with sqlite3.connect(store.path) as db:
  assert db.execute("SELECT count(*) FROM users").fetchone()[0]==1
 assert post(client,"login",{"email":"missing@example.invalid","password":PASSWORD}).status_code==401
 assert post(client,"login",{"email":"one@example.invalid","password":PASSWORD}).status_code==401

def test_reset_replay_and_all_sessions_revoked(tmp_path):
 store,mail,client=fixture(tmp_path)
 assert register(client).status_code==202
 assert verify(client,mail.latest("verify")).status_code==200
 second=TestClient(client.app)
 assert post(second,"login",{"email":"one@example.invalid","password":PASSWORD}).status_code==200
 t1=client.cookies.get(SESSION_COOKIE);t2=second.cookies.get(SESSION_COOKIE)
 assert t1!=t2
 unknown=post(client,"reset/request",{"email":"missing@example.invalid","challenge":"valid-reset"})
 found=post(client,"reset/request",{"email":"one@example.invalid","challenge":"valid-reset"})
 assert found.status_code==unknown.status_code==202 and found.json()==unknown.json()
 token=mail.latest("reset")
 assert post(client,"reset/confirm",{"token":token,"password":"A-New-Strong-Password-2026!"}).status_code==200
 assert post(client,"reset/confirm",{"token":token,"password":"AnotherPassphrase-2026!"}).status_code==400
 assert store.current(t1) is None and store.current(t2) is None
 assert post(client,"login",{"email":"one@example.invalid","password":PASSWORD}).status_code==401
 assert post(client,"login",{"email":"one@example.invalid","password":"A-New-Strong-Password-2026!"}).status_code==200

def test_origin_logout_and_account_isolation(tmp_path):
 store,mail,a=fixture(tmp_path)
 b=TestClient(a.app)
 assert register(a,"a@example.invalid").status_code==202
 assert verify(a,mail.latest("verify")).status_code==200
 assert register(b,"b@example.invalid").status_code==202
 assert verify(b,mail.latest("verify"),"B-Strong-passphrase-2026!").status_code==200
 u1=a.get("/api/auth/email/me").json()["user"]
 u2=b.get("/api/auth/email/me").json()["user"]
 assert u1["id"]!=u2["id"] and u1["email"]!=u2["email"]
 assert a.post("/api/auth/email/logout",json={}).status_code==403
 assert post(a,"logout",{}).status_code==200
 assert b.get("/api/auth/email/me").json()["user"]==u2
