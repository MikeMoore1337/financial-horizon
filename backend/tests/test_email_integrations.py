"""Outgoing TLS relay and mandatory Cloudflare Siteverify contracts; entirely mocked."""
from __future__ import annotations
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
import httpx
import sys
import pytest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from fh_email_auth.config import Settings
from fh_email_auth.mailer import Mailer
from fh_email_auth.turnstile import validate_token,SITEVERIFY


def settings(tmp_path,port=465):
 return Settings(True,"http://127.0.0.1:8791",tmp_path/"db.sqlite",
       "x"*48,"turnstile-secret","site",
       "smtp.test.invalid",port,"smtp-user","not-real-password",
       "noreply@test.invalid",True)


def test_turnstile_enforces_host_action_and_provider_response(monkeypatch):
 import fh_email_auth.turnstile as ts
 result={"success":True,"hostname":"127.0.0.1","action":"register"}
 class FakeClient:
  def __init__(self,*args,**kwargs):
   assert kwargs["trust_env"] is False and kwargs["follow_redirects"] is False
  def __enter__(self):return self
  def __exit__(self,*args):pass
  def post(self,url,data):
   assert url==SITEVERIFY
   assert data=={"secret":"turnstile-secret","response":"sample-token"}
   return SimpleNamespace(status_code=200,content=b"{}",json=lambda:result)
 monkeypatch.setattr(ts.httpx,"Client",FakeClient)
 assert validate_token("turnstile-secret","sample-token","http://127.0.0.1:8791","register")
 result["action"]="login"
 assert not validate_token("turnstile-secret","sample-token","http://127.0.0.1:8791","register")
 result["action"]="register";result["hostname"]="evil.invalid"
 assert not validate_token("turnstile-secret","sample-token","http://127.0.0.1:8791","register")
 result["hostname"]="127.0.0.1";result["success"]=False
 assert not validate_token("turnstile-secret","sample-token","http://127.0.0.1:8791","register")
 assert not validate_token("turnstile-secret","","http://127.0.0.1:8791","register")


def test_mailer_uses_authenticated_implicit_tls_and_fragment(monkeypatch,tmp_path):
 import fh_email_auth.mailer as module
 events=[]
 class SMTP:
  def __init__(self,host,port,timeout,context=None):
   assert host=="smtp.test.invalid" and port==465 and timeout==12 and context
  def __enter__(self):return self
  def __exit__(self,*args):pass
  def login(self,username,password):events.append(("login",username,password))
  def send_message(self,msg):events.append(("mail",msg["To"],msg.get_content()))
 monkeypatch.setattr(module.smtplib,"SMTP_SSL",SMTP)
 m=Mailer(settings(tmp_path))
 assert m.send("one@example.invalid","verify","TESTTOKEN123456") is True
 assert events[0][0]=="login"
 assert events[1][0]=="mail"
 assert "/account.html#verify-email=TESTTOKEN123456" in events[1][2]
 assert "http://127.0.0.1:8791/account.html#verify-email" in events[1][2]
 assert m.send("one@example.invalid","reset","RESETTOKEN123456")
 assert "#reset-password=RESETTOKEN123456" in events[-1][2]


def test_starttls_required_no_plaintext_credentials(monkeypatch,tmp_path):
 import fh_email_auth.mailer as module
 events=[]
 class SMTP:
  def __init__(self,host,port,timeout):assert port==587
  def __enter__(self):return self
  def __exit__(self,*args):pass
  def ehlo(self):events.append("ehlo")
  def starttls(self,context):events.append("tls")
  def login(self,user,password):
   assert events[-2:]==["tls","ehlo"]
   events.append("login")
  def send_message(self,msg):events.append("sent")
 monkeypatch.setattr(module.smtplib,"SMTP",SMTP)
 Mailer(settings(tmp_path,587)).send("one@example.invalid","reset","TOKEN2345678")
 assert events==["ehlo","tls","ehlo","login","sent"]
