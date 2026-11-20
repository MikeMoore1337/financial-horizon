"""#38 private bank import routes: real SQLite auth + PostgreSQL and no file uploads."""
from __future__ import annotations

from hashlib import sha256
import json
import os
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from backend.fh_email_auth.app import create_app
from backend.fh_email_auth.config import Settings
from backend.finance_api.tests.test_http import COOKIE, NAMESPACE, ORIGIN, env, engine
from backend.finance_api.tests.test_http_v2_candidate import snapshot, request, revisions, post

pytestmark = pytest.mark.skipif(
    os.getenv("FH_FINANCE_CI_ALLOW_BOOTSTRAP") != "yes",
    reason="Uses isolated synthetic PostgreSQL and SQLite auth",
)


@pytest.fixture
def bank_http(env):
    config=Settings(
        True,ORIGIN,env["store"].path,"r"*48,"synthetic-turnstile","synthetic-site",
        "smtp.invalid",465,"synthetic-user","synthetic-password",
        "noreply@example.invalid",True,
    )
    app=create_app(config=config,store=env["store"],finance_engine=env["engine"],
                   finance_profile_namespace=NAMESPACE,enable_account_v2_candidate=True,
                   enable_bank_import_candidate=True)
    def client(token):
        c=TestClient(app,base_url=ORIGIN,raise_server_exceptions=False)
        c.cookies.set(COOKIE,token,domain="127.0.0.1",path="/api/auth")
        assert c.post("/api/auth/email/finance/session",
                      headers={"Origin":ORIGIN},json={}).status_code==200
        return c
    return {**env,"bank_app":app,"bank_client":client}


def _hash(x):
    return sha256(x.encode("utf-8")).hexdigest()


def _write(client,endpoint,state,body,**headers):
    return client.post("/api/finance/v2/bank-import/"+endpoint,
        headers={"Origin":ORIGIN,"If-Match":state.headers["etag"],
                 "Idempotency-Key":body["client_mutation_id"],**headers},
        json=body)


def _bank_body(state,account_id):
    version=revisions(state,account_id)
    return {
        "schema_version":1,"client_mutation_id":str(uuid4()),
        "base_revision":state.json()["revision"],
        "batch_key":_hash("only synthetic bank batch"),
        "file_digest":_hash("only synthetic bank bytes"),
        "expected_account_revisions":version,
        "operations":[{
            "source_key":_hash("only synthetic bank row"),
            "fingerprint":_hash("only synthetic bank content"),
            "external_id":"SYN-008",
            "account_id":account_id,"target_account_id":None,
            "occurred_on":"2026-11-08","amount_minor":1250,
            "kind":"income","description":"Synthetic reimbursement",
            "category":None,"currency":"RUB","reviewed_transaction_ids":[],
        }],
    }


def test_bank_route_unmounted_without_separate_opt_in(env):
    assert all("bank-import" not in getattr(route, "path", "") for route in env["app"].routes)
    _,token=env["first"]
    client=env["client"](token)
    assert client.post("/api/finance/v2/bank-import/commit",
                       headers={"Origin":ORIGIN},json={}).status_code==404


def test_bank_route_atomic_http_replay_undo_and_cash_snapshot(bank_http):
    _,token=bank_http["first"]
    client=bank_http["bank_client"](token)
    state=snapshot(client)
    account_id=str(uuid4())
    create=request(state,"account.create",{
        "id":account_id,"name":"Synthetic bank","kind":"bank",
        "currency":"RUB","opening_minor":10000,
    })
    assert post(client,state,create).status_code==201
    before=snapshot(client)
    body=_bank_body(before,account_id)
    done=_write(client,"commit",before,body)
    assert done.status_code==201,done.text
    assert done.json()["new_operations"]==1
    assert done.headers["cache-control"]=="private, no-store"
    assert _write(client,"commit",before,body).status_code==200
    after=snapshot(client)
    acc=next(x for x in after.json()["entities"] if x["id"]==account_id)
    assert acc["data"]["balance_minor"]==11250
    undo={
        "schema_version":1,"client_mutation_id":str(uuid4()),
        "base_revision":after.json()["revision"],
        "batch_key":body["batch_key"],"reason":"Synthetic undo",
    }
    undone=_write(client,"undo",after,undo)
    assert undone.status_code==201,undone.text
    restored=snapshot(client)
    acc=next(x for x in restored.json()["entities"] if x["id"]==account_id)
    assert acc["data"]["balance_minor"]==10000
    assert _write(client,"undo",after,undo).status_code==200


def test_bank_http_origin_scope_bad_payload_and_json_duplicates(bank_http):
    _,token=bank_http["first"]
    client=bank_http["bank_client"](token)
    state=snapshot(client)
    account_id=str(uuid4())
    create=request(state,"account.create",{
        "id":account_id,"name":"Synthetic account","kind":"bank",
        "currency":"RUB","opening_minor":0,
    })
    assert post(client,state,create).status_code==201
    before=snapshot(client)
    body=_bank_body(before,account_id)
    path="/api/finance/v2/bank-import/commit"
    anonymous=TestClient(bank_http["bank_app"],base_url=ORIGIN,
                         raise_server_exceptions=False)
    assert _write(anonymous,"commit",before,body).status_code==401
    assert _write(client,"commit",before,body,**{"Origin":"https://evil.invalid"}).status_code==403
    assert client.post(path,json=body).status_code==403
    assert _write(client,"commit",before,body,**{"Sec-Fetch-Site":"cross-site"}).status_code==403
    assert _write(client,"commit",before,body,**{"Idempotency-Key":"wrong"}).status_code==428
    bad={**body,"operations":[{**body["operations"][0],"amount_minor":1.1}]}
    assert _write(client,"commit",before,bad).status_code==422
    headers={"Origin":ORIGIN,"If-Match":before.headers["etag"],
             "Idempotency-Key":body["client_mutation_id"],
             "Content-Type":"application/json"}
    dup=client.post(path,headers=headers,
                    content='{"schema_version":1,"schema_version":1}')
    assert dup.status_code==422
    assert client.post(path,headers={**headers,"Content-Type":"text/csv"},
                       content=b"not a bank statement").status_code==415
    assert snapshot(client).json()["revision"]==before.json()["revision"]

def test_bank_history_private_pagination_tracks_reversals(bank_http):
    _,token=bank_http["first"]
    client=bank_http["bank_client"](token)
    current=snapshot(client)
    account_id=str(uuid4())
    create=request(current,"account.create",{
        "id":account_id,"name":"History test account","kind":"bank",
        "currency":"RUB","opening_minor":0,
    })
    assert post(client,current,create).status_code==201
    before=snapshot(client)
    first=_bank_body(before,account_id)
    posted=_write(client,"commit",before,first)
    assert posted.status_code==201
    path="/api/finance/v2/bank-import/batches"
    listed=client.get(path)
    assert listed.status_code==200,listed.text
    assert listed.headers["cache-control"]=="private, no-store"
    data=listed.json()
    assert data["revision"]==posted.json()["revision"]
    assert data["has_more"] is False
    assert data["next_cursor"] is None
    assert len(data["batches"])==1
    batch=data["batches"][0]
    assert batch["batch_id"]==posted.json()["batch_id"]
    assert batch["batch_key"]==first["batch_key"]
    assert batch["status"]=="committed"
    assert batch["operation_count"]==1
    assert "file_digest" not in json.dumps(data)
    assert "description" not in json.dumps(data)
    invalid=client.get(path+"?limit=1000")
    assert invalid.status_code==422
    assert client.get(path+"?cursor=2&cursor=3").status_code==422
    anonymous=TestClient(bank_http["bank_app"],base_url=ORIGIN,
                         raise_server_exceptions=False)
    assert anonymous.get(path).status_code==401
    after=snapshot(client)
    undo={"schema_version":1,"client_mutation_id":str(uuid4()),
          "base_revision":after.json()["revision"],
          "batch_key":first["batch_key"],"reason":"Synthetic history undo"}
    assert _write(client,"undo",after,undo).status_code==201
    after_undo=client.get(path)
    assert after_undo.status_code==200
    assert after_undo.json()["batches"][0]["status"]=="cancelled"
    assert after_undo.json()["batches"][0]["cancelled_revision"]==after_undo.json()["revision"]

def test_bank_reconciliation_rows_return_exact_profile_records_without_raw_file(bank_http):
    _,token=bank_http["first"]
    client=bank_http["bank_client"](token)
    state=snapshot(client)
    account_id=str(uuid4())
    create=request(state,"account.create",{
        "id":account_id,"name":"Owned synthetic bank","kind":"bank",
        "currency":"RUB","opening_minor":15000,
    })
    assert post(client,state,create).status_code==201
    before=snapshot(client)
    payload=_bank_body(before,account_id)
    committed=_write(client,"commit",before,payload)
    assert committed.status_code==201,committed.text
    read=client.get("/api/finance/v2/bank-import/rows")
    assert read.status_code==200,read.text
    body=read.json()
    assert body["revision"]==committed.json()["revision"]
    assert len(body["rows"])==1
    row=body["rows"][0]
    assert row["source_key"]==payload["operations"][0]["source_key"]
    assert row["external_id"]=="SYN-008"
    assert row["amount_minor"]==1250
    assert row["status"]=="committed"
    assert "file_digest" not in read.text
    assert "filename" not in read.text
    assert read.headers["cache-control"]=="private, no-store"
    assert client.get("/api/finance/v2/bank-import/rows?cursor=x").status_code==422
    anonymous=TestClient(bank_http["bank_app"],base_url=ORIGIN,
                         raise_server_exceptions=False)
    assert anonymous.get("/api/finance/v2/bank-import/rows").status_code==401

