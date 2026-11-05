"""Abuse, expiration, SMTP outage, privacy and fail-closed configuration."""
from __future__ import annotations
from dataclasses import replace
from pathlib import Path
import sqlite3
import sys
import pytest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from fh_email_auth.config import Settings
from fh_email_auth.app import create_app
from fh_email_auth.store import AuthStore
from test_email_flow import fixture,post,register,verify,ORIGIN


def test_disabled_default_and_required_external_integrations(tmp_path):
 disabled=Settings(False,ORIGIN,tmp_path/"off.db","","","","",465,"","","",True)
 from fastapi.testclient import TestClient
 c=TestClient(create_app(disabled))
 assert c.get("/api/auth/email/config").json()=={"enabled":False,"sitekey":"","email_only":True}
 assert register(c).status_code==404
 assert c.get("/api/auth/email/me").json()=={"authenticated":False}
 with pytest.raises(ValueError):
  replace(disabled,enabled=True)
 with pytest.raises(ValueError):
  replace(disabled,enabled=True,rate_secret="a"*48,
          turnstile_sitekey="public",turnstile_secret="secret")
 with pytest.raises(ValueError):
  replace(disabled,enabled=True,rate_secret="a"*48,
          turnstile_sitekey="public",turnstile_secret="secret",
          smtp_host="smtp.example.invalid",smtp_username="user",
          smtp_password="pwd",smtp_from="from@example.invalid",smtp_port=25)
 with pytest.raises(ValueError):
  replace(disabled,public_origin="http://evil.invalid",test_mode=False)


def test_captcha_origin_and_bad_token_rejection(tmp_path):
 store,mail,c=fixture(tmp_path)
 assert register(c,challenge="bad").status_code==400
 assert c.post("/api/auth/email/register",
      json={"email":"one@example.invalid","challenge":"valid-register"}).status_code==403
 assert c.post("/api/auth/email/register",
      json={"email":"one@example.invalid","challenge":"valid-register"},
      headers={"Origin":"https://evil.invalid"}).status_code==403
 assert c.post("/api/auth/email/register",
      json={"email":"one@example.invalid","challenge":"valid-register"},
      headers={"Origin":ORIGIN,"Sec-Fetch-Site":"cross-site"}).status_code==403
 assert c.post("/api/auth/email/register",data=b"A"*5000,
      headers={"Origin":ORIGIN}).status_code==413
 assert not mail.sent
 with sqlite3.connect(store.path) as db:
  assert db.execute("SELECT count(*) FROM users").fetchone()[0]==0


def test_replay_unicode_and_session_timeouts(tmp_path):
 now=[1700000000]
 store,mail,c=fixture(tmp_path,now=lambda:now[0])
 assert register(c).status_code==202
 raw=mail.latest("verify")
 assert verify(c,"й"*50).status_code==422
 now[0]+=24*3600+1
 assert verify(c,raw).status_code==400
 assert post(c,"resend",{"email":"one@example.invalid","challenge":"valid-resend"}).status_code==202
 next_token=mail.latest("verify")
 assert next_token!=raw
 assert verify(c,next_token).status_code==200
 session=c.cookies.get("fh_email_session")
 assert store.current(session)
 now[0]+=7*86400+1
 assert store.current(session) is None


def test_per_email_and_ip_rate_limit_before_captcha(tmp_path):
 store,mail,c=fixture(tmp_path)
 assert register(c,challenge="bad").status_code==400
 assert register(c).status_code==202
 assert register(c).status_code==429
 assert len(mail.sent)==1


def test_failure_of_external_smtp_is_generic_and_retryable(tmp_path,caplog):
 store,mail,c=fixture(tmp_path)
 mail.fail=True
 first=register(c)
 assert first.status_code==202
 mail.fail=False
 repeat=register(c)
 assert repeat.status_code==202 and repeat.json()==first.json()
 assert post(c,"resend",{"email":"one@example.invalid","challenge":"valid-resend"}).status_code==202
 assert len(mail.sent)==1
 assert "one@example.invalid" not in caplog.text
 assert "smtp-failure" not in caplog.text


def test_reset_requires_turnstile_and_cannot_spam(tmp_path):
 _,mail,c=fixture(tmp_path)
 assert register(c).status_code==202
 assert verify(c,mail.latest("verify")).status_code==200
 missing=post(c,"reset/request",{"email":"missing@example.invalid","challenge":"valid-reset"})
 assert missing.status_code==202
 assert post(c,"reset/request",{"email":"one@example.invalid","challenge":"bad"}).status_code==400
 assert post(c,"reset/request",{"email":"one@example.invalid","challenge":"valid-reset"}).status_code==202
 assert post(c,"reset/request",{"email":"one@example.invalid","challenge":"valid-reset"}).status_code==202
 assert post(c,"reset/request",{"email":"one@example.invalid","challenge":"valid-reset"}).status_code==429


def test_production_rejects_cloudflare_testing_keys(tmp_path):
 with pytest.raises(ValueError,match="Turnstile"):
  Settings(True,"https://fin-horizon.mikemoore.top",tmp_path/"auth.db",
           "x"*48,"1x0000000000000000000000000000000AA",
           "1x00000000000000000000AA","smtp.test.invalid",465,
           "user","not-a-live-password","noreply@test.invalid",False)


def test_password_reset_race_cannot_issue_old_password_session(tmp_path,monkeypatch):
 import fh_email_auth.store as store_module
 store,mail,client=fixture(tmp_path)
 assert register(client).status_code==202
 assert verify(client,mail.latest("verify")).status_code==200
 reset_request=post(client,"reset/request",{"email":"one@example.invalid","challenge":"valid-reset"})
 assert reset_request.status_code==202
 raw=mail.latest("reset")
 real_verify=store_module.verify_password
 called=[False]

 def verify_and_reset(old_password,encoded):
  accepted=real_verify(old_password,encoded)
  if accepted and not called[0]:
   called[0]=True
   store.reset_password(raw,"New-Password-After-Reset-2026!")
  return accepted

 monkeypatch.setattr(store_module,"verify_password",verify_and_reset)
 response=post(client,"login",{"email":"one@example.invalid","password":"A-strong-passphrase-98520!"})
 assert response.status_code==401
 assert called[0]
 assert post(client,"login",{"email":"one@example.invalid","password":"New-Password-After-Reset-2026!"}).status_code==200
