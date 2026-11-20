"""#38: real PostgreSQL atomic bank-import candidate tests. Synthetic only."""
from __future__ import annotations

from uuid import uuid4, uuid5
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
from backend.finance_db.tests.test_ledger_service import context, add_account, make_command, call


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

def test_bank_reimport_cannot_duplicate_a_paid_loan_even_if_explicitly_reviewed(context):
    engine,scope=context
    account,_=add_account(engine,scope,opening=50000)
    loan_id,payment_id,paid_txid=uuid4(),uuid4(),uuid4()
    with finance_transaction(engine,verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as session:
        session.execute(text("""
            INSERT INTO loans
              (profile_id,id,title,opening_minor,payment_minor,apr_basis_points,
               term_months,due_day,as_of_date)
            VALUES (:p,:id,'Only synthetic loan',50000,5000,1200,24,15,'2026-11-08')
        """), {"p":scope.profile_id,"id":loan_id})
    before=get_account_snapshot(engine,scope=scope)
    pay=make_command(before.body["revision"],"loan.payment.record",{
        "transaction_id":str(paid_txid),"fact_id":str(payment_id),
        "account_id":account,"loan_id":str(loan_id),"amount_minor":5000,
        "paid_on":"2026-11-08","strategy":"term",
    },{account:before.body["entities"][0]["entity_revision"],str(loan_id):1})
    assert call(engine,scope,pay,before.etag).status==201
    after=get_account_snapshot(engine,scope=scope)
    versions={row["id"]:row["entity_revision"] for row in after.body["entities"]}
    bank={ "source_key":digest("loan-statement-row"),
           "fingerprint":digest("loan-statement-fingerprint"),
           "external_id":"SYN-LOAN-DEBIT","account_id":account,
           "target_account_id":None,"occurred_on":"2026-11-08",
           "amount_minor":5000,"kind":"expense",
           "description":"Different bank description","category":None,
           "currency":"RUB","reviewed_transaction_ids":[str(paid_txid)] }
    batch=request_for(scope,(account,versions),after.body["revision"],[bank])
    counts=_counts(engine,scope)
    with pytest.raises(FinanceCommandError) as error:
        commit_bank_import_candidate(engine,scope=scope,request=batch,
            if_match=after.etag,idempotency_key=batch["client_mutation_id"])
    assert error.value.code=="semantic_conflict"
    assert _counts(engine,scope)==counts
    assert get_account_snapshot(engine,scope=scope).etag==after.etag


def test_whole_batch_undo_rejects_later_financial_revision_without_partial_reversal(context):
    engine,scope=context
    account,_=add_account(engine,scope,opening=10000)
    before=get_account_snapshot(engine,scope=scope)
    versions={row["id"]:row["entity_revision"] for row in before.body["entities"]}
    body=request_for(scope,(account,versions),before.body["revision"])
    assert commit_bank_import_candidate(engine,scope=scope,request=body,
        if_match=before.etag,idempotency_key=body["client_mutation_id"]).status==201
    committed=get_account_snapshot(engine,scope=scope)
    # Simulate another device changing the finance revision before undo.
    add_account(engine,scope,opening=0,name="Other device synthetic account")
    later=get_account_snapshot(engine,scope=scope)
    attempted={
        "schema_version":1,"client_mutation_id":str(uuid4()),
        "base_revision":later.body["revision"],"batch_key":body["batch_key"],
        "reason":"Attempted stale batch reversal",
    }
    original_counts=_counts(engine,scope)
    with pytest.raises(FinanceCommandError) as error:
        undo_bank_import_candidate(engine,scope=scope,request=attempted,
            if_match=later.etag,idempotency_key=attempted["client_mutation_id"])
    assert error.value.code=="semantic_conflict"
    assert _counts(engine,scope)==original_counts
    assert get_account_snapshot(engine,scope=scope).etag==later.etag
    assert committed.body["revision"]+1==later.body["revision"]
    with finance_transaction(engine,verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as session:
        assert session.execute(text("SELECT status FROM bank_import_batches")).scalar_one()=="committed"



def test_transfer_equal_amount_same_sender_different_recipient_is_distinct(context):
    """#38: A→B must not block an otherwise valid A→C transfer for same sum/day."""
    engine, scope = context
    a, _ = add_account(engine, scope, opening=10000, name="Outgoing")
    b, _ = add_account(engine, scope, opening=0, name="First recipient")
    c, _ = add_account(engine, scope, opening=0, name="Second recipient")

    def transfer(label, target, snapshot):
        revisions = {
            row["id"]: row["entity_revision"]
            for row in snapshot.body["entities"] if row["id"] in (a, target)
        }
        op = {
            "source_key": digest("transfer-source-" + label),
            "fingerprint": digest("transfer-fp-" + label),
            "external_id": "BANK-" + label,
            "account_id": a,
            "target_account_id": target,
            "occurred_on": "2026-11-08",
            "amount_minor": 1800,
            "kind": "transfer",
            "description": "Synthetic " + label,
            "category": None, "currency": "RUB",
            "reviewed_transaction_ids": [],
        }
        body = request_for(scope, (a, revisions), snapshot.body["revision"], [op])
        body["batch_key"] = digest("transfer-batch-" + label)
        body["file_digest"] = digest("transfer-file-" + label)
        return body

    before = get_account_snapshot(engine, scope=scope)
    first = transfer("TO-B", b, before)
    receipt = commit_bank_import_candidate(
        engine, scope=scope, request=first,
        if_match=before.etag, idempotency_key=first["client_mutation_id"],
    )
    assert receipt.status == 201

    after_first = get_account_snapshot(engine, scope=scope)
    second = transfer("TO-C", c, after_first)
    result = commit_bank_import_candidate(
        engine, scope=scope, request=second,
        if_match=after_first.etag, idempotency_key=second["client_mutation_id"],
    )
    assert result.status == 201
    assert result.body["new_operations"] == 1
    after_second = get_account_snapshot(engine, scope=scope)
    balances = {
        x["id"]: x["data"]["balance_minor"]
        for x in after_second.body["entities"] if x["kind"] == "account"
    }
    assert balances[a] == 6400
    assert balances[b] == 1800
    assert balances[c] == 1800

    third = transfer("AGAIN-TO-B", b, after_second)
    with pytest.raises(FinanceCommandError) as conflict:
        commit_bank_import_candidate(
            engine, scope=scope, request=third,
            if_match=after_second.etag,
            idempotency_key=third["client_mutation_id"],
        )
    assert conflict.value.code == "semantic_conflict"
    assert get_account_snapshot(engine, scope=scope).etag == after_second.etag
    assert _counts(engine, scope)["bank_import_rows"] == 2



def test_public_transaction_reverse_keeps_import_batch_committed_but_voids_money(context):
    """#38: independent ledger reversal is legitimate before whole-batch undo.

    The immutable bank source key remains reserved and bank batch remains
    committed; the signed UI must read and reconcile that state without error.
    """
    engine, scope = context
    account, _ = add_account(engine, scope, opening=50000)
    initial = get_account_snapshot(engine, scope=scope)
    versions = {
        entity["id"]: entity["entity_revision"]
        for entity in initial.body["entities"] if entity["id"] == account
    }
    bank = request_for(scope, (account, versions), initial.body["revision"])
    receipt = commit_bank_import_candidate(
        engine, scope=scope, request=bank,
        if_match=initial.etag, idempotency_key=bank["client_mutation_id"],
    )
    assert receipt.status == 201
    batch_id = uuid5(scope.profile_id, "bank-import:v1:" + bank["batch_key"])
    bank_tx_id = str(uuid5(batch_id, bank["operations"][0]["source_key"]))
    committed = get_account_snapshot(engine, scope=scope)
    # The v1/v2 account snapshot lists account entities only. The imported
    # transaction has the immutable first entity revision assigned by _post;
    # an existing public transaction.reverse test uses the same contract.
    revisions = {
        entity["id"]: entity["entity_revision"]
        for entity in committed.body["entities"] if entity["id"] == account
    }
    assert set(revisions) == {account}
    revisions[bank_tx_id] = 1
    cmd = make_command(
        committed.body["revision"], "transaction.reverse",
        {"transaction_id": bank_tx_id, "reason": "Synthetic individual reversal"},
        revisions,
    )
    result = call(engine, scope, cmd, committed.etag, internal=False)
    assert result.status == 201
    final = get_account_snapshot(engine, scope=scope)
    assert next(
        e["data"]["balance_minor"] for e in final.body["entities"]
        if e["id"] == account
    ) == 50000

    from backend.finance_db.bank_import_candidate import get_bank_import_rows

    private = get_bank_import_rows(engine, scope=scope)
    assert private.status == 200
    assert len(private.body["rows"]) == 1
    assert private.body["rows"][0]["transaction_id"] == bank_tx_id
    assert private.body["rows"][0]["status"] == "committed"
    assert private.body["rows"][0]["source_key"] == bank["operations"][0]["source_key"]
    assert _counts(engine, scope)["bank_import_rows"] == 1
