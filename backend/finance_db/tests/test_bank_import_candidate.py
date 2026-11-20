"""#38: real PostgreSQL atomic bank-import candidate tests. Synthetic only."""
from __future__ import annotations

from uuid import uuid4
from hashlib import sha256
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import text

from backend.finance_db.db import finance_transaction
from backend.finance_db.ledger_service import (
    FinanceCommandError, VerifiedFinanceScope, get_account_snapshot,
)
from backend.finance_db.bank_import_candidate import (
    commit_bank_import_candidate, undo_bank_import_candidate,
)
from backend.finance_db.tests.test_ledger_service import context, add_account


def digest(label):
    return sha256(label.encode("utf-8")).hexdigest()


def request_for(scope, accounts, etag_revision, operations=None):
    ops = operations or [{
        "source_key":digest("source-1"),"fingerprint":digest("fingerprint-1"),
        "external_id":"SYN-001","account_id":accounts[0],
        "target_account_id":None,"occurred_on":"2026-11-07",
        "amount_minor":12000,"kind":"income","description":"Синтетический доход",
        "category":None,"currency":"RUB","reviewed_transaction_ids":[],
    }]
    return {
        "schema_version":1,"client_mutation_id":str(uuid4()),
        "base_revision":etag_revision,
        "batch_key":digest("confirmed-batch-1"),"file_digest":digest("file-1"),
        "expected_account_revisions":accounts[1],"operations":ops,
    }


def _counts(engine, scope):
    with finance_transaction(engine,verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as s:
        return {name:s.execute(text("SELECT count(*) FROM "+name)).scalar_one()
                for name in ("bank_import_batches","bank_import_rows",
                             "ledger_transactions","ledger_postings",
                             "change_log","command_receipts")}


def test_atomic_bank_commit_replay_and_whole_batch_reversal(context):
    engine,scope=context
    a,_=add_account(engine,scope,opening=50000)
    b,_=add_account(engine,scope,opening=1000,name="Второй счёт")
    before=get_account_snapshot(engine,scope=scope)
    versions={row["id"]:row["entity_revision"] for row in before.body["entities"]}
    ops=[
        {"source_key":digest("bank-1"),"fingerprint":digest("bank-fp-1"),
         "external_id":"SYN-001","account_id":a,"target_account_id":None,
         "occurred_on":"2026-11-07","amount_minor":12000,"kind":"income",
         "description":"Синтетический доход","category":None,"currency":"RUB",
         "reviewed_transaction_ids":[]},
        {"source_key":digest("bank-2"),"fingerprint":digest("bank-fp-2"),
         "external_id":"SYN-002","account_id":a,"target_account_id":b,
         "occurred_on":"2026-11-08","amount_minor":4000,"kind":"transfer",
         "description":"Синтетический перевод","category":None,"currency":"RUB",
         "reviewed_transaction_ids":[]},
    ]
    payload=request_for(scope,(a,versions),before.body["revision"],ops)
    response=commit_bank_import_candidate(engine,scope=scope,request=payload,
        if_match=before.etag,idempotency_key=payload["client_mutation_id"])
    assert response.status==201
    assert response.body["new_operations"]==2
    after=get_account_snapshot(engine,scope=scope)
    assert {x["id"]:x["data"]["balance_minor"] for x in after.body["entities"]}=={
        a:58000,b:5000,
    }
    assert _counts(engine,scope)["ledger_postings"]==3
    replay=commit_bank_import_candidate(engine,scope=scope,request=payload,
        if_match=before.etag,idempotency_key=payload["client_mutation_id"])
    assert replay.status==200 and replay.body["new_operations"]==0
    assert _counts(engine,scope)["ledger_transactions"]==2
    undo={"schema_version":1,"client_mutation_id":str(uuid4()),
          "base_revision":after.body["revision"],
          "batch_key":payload["batch_key"],"reason":"Синтетическая отмена"}
    cancelled=undo_bank_import_candidate(engine,scope=scope,request=undo,
        if_match=after.etag,idempotency_key=undo["client_mutation_id"])
    assert cancelled.status==201 and cancelled.body["reversed_operations"]==2
    final=get_account_snapshot(engine,scope=scope)
    assert {x["id"]:x["data"]["balance_minor"] for x in final.body["entities"]}=={
        a:50000,b:1000,
    }
    assert _counts(engine,scope)["ledger_transactions"]==4
    assert _counts(engine,scope)["ledger_postings"]==6
    assert _counts(engine,scope)["bank_import_rows"]==2
    with finance_transaction(engine,verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as s:
        assert s.execute(text("SELECT status FROM bank_import_batches")).scalar_one()=="cancelled"
    undo_replay=undo_bank_import_candidate(engine,scope=scope,request=undo,
        if_match=after.etag,idempotency_key=undo["client_mutation_id"])
    assert undo_replay.status==200 and undo_replay.body["replayed"]
    assert _counts(engine,scope)["ledger_transactions"]==4


def test_failed_last_row_rolls_back_all_financial_writes(context,monkeypatch):
    engine,scope=context
    a,_=add_account(engine,scope,opening=500)
    before=get_account_snapshot(engine,scope=scope)
    versions={row["id"]:row["entity_revision"] for row in before.body["entities"]}
    first=request_for(scope,(a,versions),before.body["revision"])
    second={**first["operations"][0],"source_key":digest("source-2"),
            "fingerprint":digest("fp-2"),"external_id":"SYN-002",
            "amount_minor":300}
    payload={**first,"operations":[first["operations"][0],second]}
    from backend.finance_db import bank_import_candidate as module
    original=module._post
    calls=[0]
    def abort_on_second(*args,**kwargs):
        calls[0]+=1
        if calls[0]==2:
            raise RuntimeError("SYNTHETIC_AFTER_FIRST_LEDGER_POST")
        return original(*args,**kwargs)
    monkeypatch.setattr(module,"_post",abort_on_second)
    counts=_counts(engine,scope)
    with pytest.raises(RuntimeError,match="SYNTHETIC_"):
        commit_bank_import_candidate(engine,scope=scope,request=payload,
            if_match=before.etag,idempotency_key=payload["client_mutation_id"])
    assert _counts(engine,scope)==counts
    assert get_account_snapshot(engine,scope=scope).etag==before.etag


def test_source_and_bank_id_dedup_requires_a_new_preview(context):
    engine,scope=context
    a,_=add_account(engine,scope,opening=0)
    before=get_account_snapshot(engine,scope=scope)
    versions={row["id"]:row["entity_revision"] for row in before.body["entities"]}
    payload=request_for(scope,(a,versions),before.body["revision"])
    commit_bank_import_candidate(engine,scope=scope,request=payload,
        if_match=before.etag,idempotency_key=payload["client_mutation_id"])
    later=get_account_snapshot(engine,scope=scope)
    newer={**payload,"client_mutation_id":str(uuid4()),"base_revision":later.body["revision"],
           "batch_key":digest("distinct-batch")}
    newer["expected_account_revisions"]={a:next(row["entity_revision"] for row in later.body["entities"] if row["id"]==a)}
    with pytest.raises(FinanceCommandError) as exc:
        commit_bank_import_candidate(engine,scope=scope,request=newer,
            if_match=later.etag,idempotency_key=newer["client_mutation_id"])
    assert exc.value.code=="semantic_conflict"
    assert _counts(engine,scope)["bank_import_rows"]==1


def test_two_concurrent_replays_are_serialized_under_postgres(context):
    engine,scope=context
    a,_=add_account(engine,scope,opening=0)
    before=get_account_snapshot(engine,scope=scope)
    versions={row["id"]:row["entity_revision"] for row in before.body["entities"]}
    payload=request_for(scope,(a,versions),before.body["revision"])
    def commit():
        return commit_bank_import_candidate(engine,scope=scope,request=payload,
            if_match=before.etag,idempotency_key=payload["client_mutation_id"])
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(lambda _:commit(),range(2)))
    assert sorted(x.status for x in results)==[200,201]
    assert _counts(engine,scope)["ledger_transactions"]==1


def test_wrong_profile_and_invalid_minor_units_rejected_without_writes(context):
    engine,scope=context
    a,_=add_account(engine,scope,opening=0)
    before=get_account_snapshot(engine,scope=scope)
    versions={row["id"]:row["entity_revision"] for row in before.body["entities"]}
    payload=request_for(scope,(a,versions),before.body["revision"])
    alien=VerifiedFinanceScope(uuid4().hex,scope.profile_id)
    with pytest.raises(FinanceCommandError) as e:
        commit_bank_import_candidate(engine,scope=alien,request=payload,
            if_match=before.etag,idempotency_key=payload["client_mutation_id"])
    assert e.value.code=="forbidden"
    for invalid in [0,-1,1.25,True]:
        attempt={**payload,"operations":[{**payload["operations"][0],"amount_minor":invalid}]}
        with pytest.raises(FinanceCommandError) as e:
            commit_bank_import_candidate(engine,scope=scope,request=attempt,
                if_match=before.etag,idempotency_key=payload["client_mutation_id"])
        assert e.value.code=="invalid_command"
    assert _counts(engine,scope)["bank_import_rows"]==0
