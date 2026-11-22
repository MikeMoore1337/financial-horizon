from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from sqlalchemy import text

from backend.finance_db.db import finance_transaction
from backend.finance_db.legacy_bank_import import validate_legacy_bank_ledger
from backend.finance_db.ledger_service import FinanceCommandError, VerifiedFinanceScope
from backend.finance_db.import_commit_candidate import atomic_verified_legacy_merge_candidate
from backend.finance_db.import_commit_candidate import commit_verified_legacy_import_candidate
from backend.finance_db.import_manifest_candidate import stage_import_manifest_candidate
from backend.finance_db.snapshot import get_finance_snapshot
from backend.finance_db.tests.test_import_commit_candidate import original, manifest_for, canonical, counts
from backend.finance_db.tests.test_ledger_service import context, add_account


def _ledger():
    account = "11111111-1111-4111-8111-111111111111"
    target = "22222222-2222-4222-8222-222222222222"
    operation = {
        "sourceKey": "a" * 64, "fingerprint": "b" * 64, "externalId": "synthetic-1",
        "date": "2026-01-01", "amountCents": 1000, "kind": "transfer",
        "description": "Тестовый перевод", "accountId": account,
        "targetAccountId": target, "category": None, "batchKey": "c" * 64,
    }
    return {
        "version": 1,
        "accounts": [
            {"id": account, "name": "Тест 1", "currency": "RUB", "openingMinor": 5000},
            {"id": target, "name": "Тест 2", "currency": "RUB", "openingMinor": -500},
        ],
        "operations": [operation],
        "batches": [{"batchKey": "c" * 64, "fileDigest": "d" * 64,
                     "operationCount": 1, "committedStateRevision": 3,
                     "cancelledStateRevision": None}],
    }


def test_bank_source_validation_preserves_transfer_and_cancellation():
    source = _ledger()
    original = deepcopy(source)
    result = validate_legacy_bank_ledger(source, 5)
    assert result["balances"] == {source["accounts"][0]["id"]: 4000,
                                  source["accounts"][1]["id"]: 500}
    assert source == original
    source["batches"][0]["cancelledStateRevision"] = 4
    result = validate_legacy_bank_ledger(source, 5)
    assert result["balances"] == {source["accounts"][0]["id"]: 5000,
                                  source["accounts"][1]["id"]: -500}


@pytest.mark.parametrize("change", [
    lambda x: x["operations"].append(deepcopy(x["operations"][0])),
    lambda x: x["operations"][0].update(amountCents=True),
    lambda x: x["operations"][0].update(targetAccountId=x["accounts"][0]["id"]),
    lambda x: x["operations"][0].update(date="2026-02-31"),
    lambda x: x["operations"][0].update(unexpected="must not disappear"),
    lambda x: x["batches"][0].update(operationCount=2),
    lambda x: x["batches"][0].update(cancelledStateRevision=6),
    lambda x: x["accounts"][1].update(id=x["accounts"][0]["id"]),
])
def test_bank_source_validation_rejects_tampering(change):
    source = _ledger()
    change(source)
    with pytest.raises(FinanceCommandError):
        validate_legacy_bank_ledger(source, 5)


def _request(scope, source, revision=0):
    return manifest_for(scope, source, schema_version=3, source_scope="guest:local-guest-v1",
                        explicit_guest_transfer=True, expected_server_revision=revision,
                        rows=[{"record_type":kind,"source_record_id":item["id"],"decision":"add"}
                              for kind in ("entries","loans","settlements","loanPayments")
                              for item in source[kind]],
                        bank_accounts=[{"source_id":a["id"],"decision":"add","account_kind":"bank"}
                                       for a in source["bankStatements"]["accounts"]],
                        bank_operations=[{"source_key":op["sourceKey"],"decision":"add"}
                                         for op in source["bankStatements"]["operations"]])


@pytest.mark.parametrize("cancelled", [False, True])
def test_bank_import_is_atomic_and_preserves_balances(context, cancelled):
    engine, scope = context
    source = original()
    source["bankStatements"] = _ledger()
    if cancelled:
        source["bankStatements"]["batches"][0]["cancelledStateRevision"] = 4
    request = _request(scope, source)
    result = atomic_verified_legacy_merge_candidate(engine,scope=scope,manifest=request,
                                                    source_canonical_json=canonical(source))
    assert result["bank_accounts_created"] == 2
    assert result["bank_operations_created"] == 1
    assert result["cash_postings_created"] == (4 if cancelled else 2)
    assert result["revision"] == (2 if cancelled else 1)
    snapshot = get_finance_snapshot(engine,scope=scope).body
    balances = sorted(e["data"]["balance_minor"] for e in snapshot["entities"] if e["kind"] == "account")
    assert balances == ([-500,5000] if cancelled else [500,4000])
    before = counts(engine,scope)
    replay = atomic_verified_legacy_merge_candidate(engine,scope=scope,manifest=request,
                                                    source_canonical_json=canonical(source))
    assert replay["replayed"] is True
    assert counts(engine,scope) == before


def test_bank_write_failure_rolls_back_planner_and_all_postings(context, monkeypatch):
    from backend.finance_db import legacy_bank_import
    engine, scope = context
    source = original()
    source["bankStatements"] = _ledger()
    source["bankStatements"]["batches"][0]["cancelledStateRevision"] = 4
    request = _request(scope,source)
    before = counts(engine,scope)
    original_post = legacy_bank_import._post
    calls = []
    def fail(*args, **kwargs):
        calls.append(True)
        if len(calls) == 2:
            raise RuntimeError("SYNTHETIC_BANK_FAILURE")
        return original_post(*args, **kwargs)
    monkeypatch.setattr(legacy_bank_import,"_post",fail)
    with pytest.raises(RuntimeError, match="SYNTHETIC_BANK_FAILURE"):
        atomic_verified_legacy_merge_candidate(engine,scope=scope,manifest=request,
                                               source_canonical_json=canonical(source))
    assert counts(engine,scope) == before
    assert len(calls) == 2
    assert get_finance_snapshot(engine,scope=scope).body["revision"] == 0


@pytest.mark.parametrize("cancelled", [False, True])
@pytest.mark.parametrize("changed_key", [False, True])
def test_changed_source_links_prior_bank_records_without_duplicate_postings(context, cancelled, changed_key):
    engine, scope = context
    source = original()
    source["bankStatements"] = _ledger()
    if cancelled:
        source["bankStatements"]["batches"][0]["cancelledStateRevision"] = 4
    first = _request(scope,source)
    done = atomic_verified_legacy_merge_candidate(engine,scope=scope,manifest=first,
                                                  source_canonical_json=canonical(source))
    with finance_transaction(engine,verified_user_id=scope.user_id,profile_id=scope.profile_id) as session:
        mapping = {(row["record_type"],row["source_record_id"]):str(row["target_id"])
                   for row in session.execute(text("""
                       SELECT record_type,source_record_id,target_id FROM import_record_map
                       WHERE profile_id=:p
                   """),{"p":scope.profile_id}).mappings().all()}
    source["revision"] += 1
    source["audit"].append({"action":"synthetic second source"})
    if changed_key:
        source["bankStatements"]["operations"][0]["sourceKey"] = "e"*64
    again = _request(scope,source,done["revision"])
    for row in again["rows"]:
        row.update(decision="link",target_id=mapping[row["record_type"],row["source_record_id"]])
    for row in again["bank_accounts"]:
        row.update(decision="link",target_id=mapping["bankAccounts",row["source_id"]],account_kind=None)
    for row in again["bank_operations"]:
        row.update(decision="link",target_id=mapping["bankOperations","a"*64])
    before = counts(engine,scope)
    result = atomic_verified_legacy_merge_candidate(engine,scope=scope,manifest=again,
                                                    source_canonical_json=canonical(source))
    after = counts(engine,scope)
    assert result["bank_accounts_linked"] == 2 and result["bank_operations_linked"] == 1
    assert result["cash_postings_created"] == 0
    assert after["ledger_postings"] == before["ledger_postings"]
    assert after["ledger_transactions"] == before["ledger_transactions"]


def test_changed_bank_fact_cannot_be_linked_or_partially_imported(context):
    engine, scope = context
    source = original()
    source["bankStatements"] = _ledger()
    first = _request(scope,source)
    done = atomic_verified_legacy_merge_candidate(engine,scope=scope,manifest=first,
                                                  source_canonical_json=canonical(source))
    with finance_transaction(engine,verified_user_id=scope.user_id,profile_id=scope.profile_id) as session:
        mapping = {(r["record_type"],r["source_record_id"]):str(r["target_id"])
                   for r in session.execute(text("SELECT record_type,source_record_id,target_id FROM import_record_map"))
                   .mappings().all()}
    source["revision"] += 1
    source["bankStatements"]["operations"][0]["amountCents"] += 1
    request = _request(scope,source,done["revision"])
    for row in request["rows"]:
        row.update(decision="link",target_id=mapping[row["record_type"],row["source_record_id"]])
    for row in request["bank_accounts"]:
        row.update(decision="link",target_id=mapping["bankAccounts",row["source_id"]],account_kind=None)
    for row in request["bank_operations"]:
        row.update(decision="link",target_id=mapping["bankOperations",row["source_key"]])
    before = counts(engine,scope)
    with pytest.raises(FinanceCommandError):
        atomic_verified_legacy_merge_candidate(engine,scope=scope,manifest=request,
                                               source_canonical_json=canonical(source))
    assert counts(engine,scope) == before
    assert get_finance_snapshot(engine,scope=scope).body["revision"] == done["revision"]


def test_ambiguous_existing_payment_is_not_silently_reposted(context):
    engine, scope = context
    source = original()
    ledger = _ledger()
    ledger["operations"][0].update(kind="expense",targetAccountId=None,
                                   date="2026-10-10",amountCents=120000)
    source["bankStatements"] = ledger
    request = _request(scope,source)
    before = counts(engine,scope)
    with pytest.raises(FinanceCommandError) as error:
        atomic_verified_legacy_merge_candidate(engine,scope=scope,manifest=request,
                                               source_canonical_json=canonical(source))
    assert error.value.code == "semantic_conflict"
    assert counts(engine,scope) == before


def test_ambiguous_income_settlement_is_not_silently_reposted(context):
    engine, scope = context
    source = original()
    source["settlements"].append({"id":"synthetic-income-payment","entryId":"legacy-income",
        "occurrence":"2026-10","date":"2026-10-15","amountCents":900000,
        "createdAt":"2026-10-15T12:00:00Z"})
    ledger = _ledger()
    ledger["operations"][0].update(kind="income",targetAccountId=None,
                                   date="2026-10-15",amountCents=900000)
    source["bankStatements"] = ledger
    request = _request(scope,source)
    before = counts(engine,scope)
    with pytest.raises(FinanceCommandError) as error:
        atomic_verified_legacy_merge_candidate(engine,scope=scope,manifest=request,
                                               source_canonical_json=canonical(source))
    assert error.value.code == "semantic_conflict"
    assert counts(engine,scope) == before


def test_existing_server_payment_conflict_rolls_back_entire_bank_import(context):
    engine, scope = context
    initial = original()
    first = manifest_for(scope,initial)
    stage_import_manifest_candidate(engine,scope=scope,manifest=first)
    commit_verified_legacy_import_candidate(engine,scope=scope,manifest=first,
                                             source_canonical_json=canonical(initial))
    source = original()
    for kind in ("entries","loans","settlements","loanPayments"):
        source[kind] = []
    ledger = _ledger()
    ledger["operations"][0].update(kind="expense",targetAccountId=None,
                                   date="2026-10-10",amountCents=120000)
    source["bankStatements"] = ledger
    request = _request(scope,source,revision=1)
    before = counts(engine,scope)
    with pytest.raises(FinanceCommandError) as error:
        atomic_verified_legacy_merge_candidate(engine,scope=scope,manifest=request,
                                               source_canonical_json=canonical(source))
    assert error.value.code == "semantic_conflict"
    assert counts(engine,scope) == before


def test_concurrent_identical_imports_create_one_bank_history(context):
    engine, scope = context
    source = original()
    source["bankStatements"] = _ledger()
    request = _request(scope,source)
    def run(_):
        return atomic_verified_legacy_merge_candidate(engine,scope=scope,manifest=request,
                                                      source_canonical_json=canonical(source))
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(run,range(2)))
    assert sorted(x["replayed"] for x in results) == [False,True]
    assert counts(engine,scope)["ledger_postings"] == 2


def test_unrelated_server_account_is_preserved_byte_for_byte(context):
    engine, scope = context
    account,_ = add_account(engine,scope,opening=12345,name="Unrelated synthetic account")
    prior = get_finance_snapshot(engine,scope=scope).body
    original_account = next(x for x in prior["entities"] if x["id"] == account)
    source = original()
    source["bankStatements"] = _ledger()
    request = _request(scope,source,revision=prior["revision"])
    atomic_verified_legacy_merge_candidate(engine,scope=scope,manifest=request,
                                           source_canonical_json=canonical(source))
    after = get_finance_snapshot(engine,scope=scope).body
    assert next(x for x in after["entities"] if x["id"] == account) == original_account


def test_partially_matched_batch_adds_only_the_new_operation(context):
    engine, scope = context
    source = original()
    source["bankStatements"] = _ledger()
    first = _request(scope,source)
    done = atomic_verified_legacy_merge_candidate(engine,scope=scope,manifest=first,
                                                  source_canonical_json=canonical(source))
    with finance_transaction(engine,verified_user_id=scope.user_id,profile_id=scope.profile_id) as session:
        mapping = {(r["record_type"],r["source_record_id"]):str(r["target_id"])
                   for r in session.execute(text("SELECT record_type,source_record_id,target_id FROM import_record_map"))
                   .mappings().all()}
    source["revision"] += 1
    operation = deepcopy(source["bankStatements"]["operations"][0])
    operation.update(sourceKey="e"*64,fingerprint="f"*64,externalId="synthetic-2",
                     date="2026-01-02",amountCents=300,kind="expense",targetAccountId=None)
    source["bankStatements"]["operations"].append(operation)
    source["bankStatements"]["batches"][0]["operationCount"] = 2
    request = _request(scope,source,done["revision"])
    for row in request["rows"]:
        row.update(decision="link",target_id=mapping[row["record_type"],row["source_record_id"]])
    for row in request["bank_accounts"]:
        row.update(decision="link",target_id=mapping["bankAccounts",row["source_id"]],account_kind=None)
    request["bank_operations"][0].update(decision="link",target_id=mapping["bankOperations","a"*64])
    before = counts(engine,scope)
    result = atomic_verified_legacy_merge_candidate(engine,scope=scope,manifest=request,
                                                    source_canonical_json=canonical(source))
    after = counts(engine,scope)
    assert result["bank_operations_linked"] == 1 and result["bank_operations_created"] == 1
    assert after["ledger_postings"] == before["ledger_postings"] + 1
    snapshot = get_finance_snapshot(engine,scope=scope).body
    assert sorted(x["data"]["balance_minor"] for x in snapshot["entities"] if x["kind"] == "account") == [500,3700]


def test_stale_profile_and_other_owners_account_fail_without_partial_write(context):
    engine, scope = context
    source = original()
    source["bankStatements"] = _ledger()
    stale = _request(scope,source)
    add_account(engine,scope,opening=77,name="Existing synthetic account")
    before = counts(engine,scope)
    with pytest.raises(FinanceCommandError) as error:
        atomic_verified_legacy_merge_candidate(engine,scope=scope,manifest=stale,
                                               source_canonical_json=canonical(source))
    assert error.value.code == "stale_revision"
    assert counts(engine,scope) == before

    other = VerifiedFinanceScope(user_id=uuid4().hex,profile_id=uuid4())
    with finance_transaction(engine,verified_user_id=other.user_id,profile_id=other.profile_id) as session:
        session.execute(text("INSERT INTO finance_profiles (id,owner_user_id) VALUES (:p,:u)"),
                        {"p":other.profile_id,"u":other.user_id})
    alien,_ = add_account(engine,other,opening=5000,name="Тест 1")
    request = _request(scope,source,revision=1)
    request["bank_accounts"][0].update(decision="link",target_id=alien,account_kind=None)
    foreign_before = counts(engine,other)
    with pytest.raises(FinanceCommandError):
        atomic_verified_legacy_merge_candidate(engine,scope=scope,manifest=request,
                                               source_canonical_json=canonical(source))
    assert counts(engine,scope) == before
    assert counts(engine,other) == foreign_before


def test_account_revision_overflow_rolls_back_all_imported_rows(context):
    engine, scope = context
    account,_ = add_account(engine,scope,opening=5000,name="Тест 1")
    with finance_transaction(engine,verified_user_id=scope.user_id,profile_id=scope.profile_id) as session:
        session.execute(text("UPDATE accounts SET entity_revision=:r WHERE profile_id=:p AND id=:id"),
                        {"p":scope.profile_id,"id":account,"r":(1<<53)-1})
    source = original()
    source["bankStatements"] = _ledger()
    request = _request(scope,source,revision=1)
    request["bank_accounts"][0].update(decision="link",target_id=account,account_kind=None)
    before = counts(engine,scope)
    with pytest.raises(FinanceCommandError):
        atomic_verified_legacy_merge_candidate(engine,scope=scope,manifest=request,
                                               source_canonical_json=canonical(source))
    assert counts(engine,scope) == before


def test_resulting_balance_overflow_rolls_back_all_imported_rows(context):
    engine, scope = context
    account,_ = add_account(engine,scope,opening=1_000_000_000_000,name="Тест 1")
    with finance_transaction(engine,verified_user_id=scope.user_id,profile_id=scope.profile_id) as session:
        session.execute(text("""
            WITH inserted AS (
              INSERT INTO ledger_transactions (profile_id,id,kind,occurred_on,actor_user_id,note)
              SELECT :p,gen_random_uuid(),'income','2020-01-01',:actor,'synthetic'
              FROM generate_series(1,9006) RETURNING id
            )
            INSERT INTO ledger_postings (profile_id,transaction_id,account_id,signed_minor)
            SELECT :p,id,:account,1000000000000 FROM inserted
        """), {"p":scope.profile_id,"actor":scope.user_id,"account":account})
    source = original()
    source["bankStatements"] = _ledger()
    source["bankStatements"]["accounts"][0]["openingMinor"] = 1_000_000_000_000
    source["bankStatements"]["operations"][0].update(kind="income",targetAccountId=None,
                                                      amountCents=1_000_000_000_000)
    request = _request(scope,source,revision=1)
    request["bank_accounts"][0].update(decision="link",target_id=account,account_kind=None)
    before = counts(engine,scope)
    with pytest.raises(FinanceCommandError):
        atomic_verified_legacy_merge_candidate(engine,scope=scope,manifest=request,
                                               source_canonical_json=canonical(source))
    assert counts(engine,scope) == before
