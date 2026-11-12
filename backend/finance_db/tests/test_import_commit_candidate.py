"""#69: true SQL-atomic, owner-scoped legacy import and exact-source recovery.

Synthetic v1/v2 finance data on a disposable PostgreSQL; nothing is uploaded
from real IndexedDB and no current production API is changed.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
import json
from uuid import uuid4

import pytest
from sqlalchemy import text

from backend.finance_db.db import finance_transaction
from backend.finance_db.import_commit_candidate import (
    commit_verified_legacy_import_candidate,
    restore_original_legacy_source_candidate,
)
from backend.finance_db.import_manifest_candidate import stage_import_manifest_candidate
from backend.finance_db.ledger_service import (
    FinanceCommandError, VerifiedFinanceScope, get_account_snapshot,
)
from backend.finance_db.snapshot import get_finance_delta, get_finance_snapshot
from backend.finance_db.tests.test_ledger_service import context, add_account


def original(version=2):
    state = {
        "version": version,
        "entries": [
            {"id":"legacy-income", "title":"Синтетический доход", "kind":"income",
             "amountCents":900000, "date":"2026-10-15", "recurrence":"monthly",
             "category":"Работа", "paymentMethods": []},
            {"id":"legacy-rent", "title":"Синтетическая аренда", "kind":"expense",
             "amountCents":120000, "date":"2026-10-10", "recurrence":"yearly",
             "category":"Жильё"},
        ],
        "loans": [{
            "id":"loan-1", "title":"Синтетический кредит", "openingCents":200000,
            "paymentCents":10000, "apr":12.5, "termMonths":24,
            "dueDay":10, "asOfDate":"2026-10-01",
            "schedule":[{"date":"2026-11-10", "amountCents":10000}],
        }],
        "settlements": [
            {"id":"settlement-1","entryId":"legacy-rent","occurrence":"2026-10",
             "date":"2026-10-10","amountCents":120000,
             "createdAt":"2026-10-10T12:00:00Z"},
        ],
        "loanPayments": [
            {"id":"loan-payment-1","loanId":"loan-1","date":"2026-10-10",
             "amountCents":10000,"strategy":"term",
             "createdAt":"2026-10-10T12:00:00Z"},
        ],
        "categories":["Работа","Жильё","Кредиты"],
        "audit":[{"action":"synthetic","description":"Локальная история","date":"2026-10-10"}],
        "settings":{"currency":"RUB","customFlag":True},
    }
    if version == 2:
        state["revision"] = 7
    return state


def canonical(snapshot):
    return json.dumps(snapshot, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"))


def manifest_for(scope, snapshot, serialized=None, **patch):
    raw = serialized if serialized is not None else canonical(snapshot)
    rows = [{"record_type":kind, "source_record_id":x["id"]}
            for kind in ("entries","loans","settlements","loanPayments")
            for x in snapshot[kind]]
    return {
        "schema_version":1,
        "source_scope":"account:" + scope.user_id,
        "source_revision":snapshot.get("revision", 0),
        "source_sha256":sha256(raw.encode("utf-8")).hexdigest(),
        "expected_server_revision":0,
        "external_encrypted_backup_checked":True,
        "explicit_owner_consent":True,
        "explicit_guest_transfer":False,
        "rows":rows,
        **patch,
    }


def counts(engine, scope):
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as s:
        return {
            name:s.execute(text("SELECT count(*) FROM " + name)).scalar_one()
            for name in ("obligations","loans","settlements","loan_payments",
                         "accounts","ledger_postings","ledger_transactions",
                         "command_receipts","change_log")
        }


def test_real_atomic_import_preserves_all_four_types_and_original_bytes(context):
    engine, scope = context
    source = original()
    # A real user would first save and independently re-import the encrypted
    # browser backup. This test proves SQL storage/restore, NOT a physical inbox.
    raw = canonical(source)
    manifest = manifest_for(scope, source, raw)
    staged = stage_import_manifest_candidate(engine, scope=scope, manifest=manifest)
    before = get_account_snapshot(engine, scope=scope)
    assert before.body["entities"] == []
    assert staged["status"] == "UNVERIFIED_MANIFEST_STAGED"

    done = commit_verified_legacy_import_candidate(
        engine, scope=scope, manifest=manifest, source_canonical_json=raw,
    )
    assert done["status"] == "COMMITTED"
    assert done["replayed"] is False
    assert done["revision"] == 1
    assert done["record_count"] == 5
    assert done["counts"] == {
        "entries":2,"loans":1,"settlements":1,"loanPayments":1,
    }
    assert done["cash_postings_created"] == 0
    assert "audit" not in done and "settings" not in done
    assert counts(engine, scope) == {
        "obligations":2,"loans":1,"settlements":1,"loan_payments":1,
        "accounts":0,"ledger_postings":0,"ledger_transactions":0,
        "command_receipts":1,"change_log":1,
    }
    assert get_account_snapshot(engine, scope=scope).body["entities"] == []
    page = get_finance_snapshot(engine, scope=scope)
    assert page.status == 200
    assert sorted(x["kind"] for x in page.body["entities"]) == [
        "loan","loan_payment","obligation","obligation","settlement",
    ]
    with pytest.raises(FinanceCommandError) as ex:
        get_finance_delta(engine, scope=scope, since_revision=0)
    assert ex.value.code == "snapshot_required" and ex.value.status == 410
    restored = restore_original_legacy_source_candidate(
        engine, scope=scope, batch_id=done["batch_id"],
        source_sha256=manifest["source_sha256"],
    )
    assert restored == raw
    assert json.loads(restored) == source
    # No reconstructed starting bank balance can be inferred from old payments.
    assert all(x["kind"] != "account" for x in page.body["entities"])

    replay = commit_verified_legacy_import_candidate(
        engine, scope=scope, manifest=manifest, source_canonical_json=raw,
    )
    assert replay["replayed"] is True and replay["revision"] == 1
    assert replay["record_count"] == done["record_count"]
    assert counts(engine, scope)["command_receipts"] == 1


@pytest.mark.parametrize("version", [1, 2])
def test_v1_and_v2_snapshot_bytes_round_trip_without_inventing_balances(context, version):
    engine, scope = context
    source = original(version)
    raw = canonical(source)
    manifest = manifest_for(scope, source, raw)
    stage_import_manifest_candidate(engine, scope=scope, manifest=manifest)
    done = commit_verified_legacy_import_candidate(
        engine, scope=scope, manifest=manifest, source_canonical_json=raw,
    )
    restored = restore_original_legacy_source_candidate(
        engine, scope=scope, batch_id=done["batch_id"],
        source_sha256=manifest["source_sha256"],
    )
    assert restored.encode("utf-8") == raw.encode("utf-8")
    assert json.loads(restored)["version"] == version


@pytest.mark.parametrize("fail_after", ["entries", "loans", "settlements", "loanPayments"])
def test_mid_transaction_failure_rolls_back_every_record_receipt_and_revision(context, fail_after):
    engine, scope = context
    source = original()
    raw = canonical(source)
    manifest = manifest_for(scope, source, raw)
    stage_import_manifest_candidate(engine, scope=scope, manifest=manifest)
    start = counts(engine, scope)
    with pytest.raises(RuntimeError, match="SYNTHETIC_IMPORT_TRANSACTION_FAILURE"):
        commit_verified_legacy_import_candidate(
            engine, scope=scope, manifest=manifest, source_canonical_json=raw,
            fail_after_sql_kind=fail_after,
        )
    assert counts(engine, scope) == start
    assert get_account_snapshot(engine, scope=scope).body["revision"] == 0
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as s:
        status, content = s.execute(text("""
            SELECT status,source_canonical_json FROM import_batches
            WHERE profile_id=:p
        """), {"p":scope.profile_id}).one()
    assert status == "staged" and content is None


def test_bad_hash_duplicate_json_and_manifest_mismatch_fail_without_writes(context):
    engine, scope = context
    source = original()
    raw = canonical(source)
    manifest = manifest_for(scope, source, raw)
    stage_import_manifest_candidate(engine, scope=scope, manifest=manifest)
    initial = counts(engine, scope)
    for untrusted in (
        raw[:-1], raw + " ", raw.replace('"version":2','"version":2,"version":2'),
    ):
        with pytest.raises(FinanceCommandError):
            commit_verified_legacy_import_candidate(
                engine, scope=scope, manifest=manifest, source_canonical_json=untrusted,
            )
    altered = json.loads(raw)
    altered["entries"][0]["amountCents"] = 900001
    with pytest.raises(FinanceCommandError):
        commit_verified_legacy_import_candidate(
            engine, scope=scope, manifest=manifest,
            source_canonical_json=canonical(altered),
        )
    mismatched = {**manifest, "rows":manifest["rows"][:-1]}
    with pytest.raises(FinanceCommandError):
        commit_verified_legacy_import_candidate(
            engine, scope=scope, manifest=mismatched, source_canonical_json=raw,
        )
    assert counts(engine, scope) == initial


def test_existing_financial_data_is_never_silently_overwritten(context):
    engine, scope = context
    source = original()
    raw = canonical(source)
    manifest = manifest_for(scope, source, raw)
    stage_import_manifest_candidate(engine, scope=scope, manifest=manifest)
    add_account(engine, scope, opening=123456)
    before = counts(engine, scope)
    with pytest.raises(FinanceCommandError) as ex:
        commit_verified_legacy_import_candidate(
            engine, scope=scope, manifest=manifest, source_canonical_json=raw,
        )
    assert ex.value.status == 412
    assert counts(engine, scope) == before


def test_wrong_owner_and_guest_consent_rejected_before_sql_import(context):
    engine, scope = context
    source = original()
    raw = canonical(source)
    man = manifest_for(scope, source, raw)
    wrong = {**man, "source_scope":"account:" + "b"*32}
    with pytest.raises(FinanceCommandError) as ex:
        commit_verified_legacy_import_candidate(
            engine, scope=scope, manifest=wrong, source_canonical_json=raw,
        )
    assert ex.value.status == 403

    guest = {**man,"source_scope":"guest:synthetic-guest"}
    with pytest.raises(FinanceCommandError):
        commit_verified_legacy_import_candidate(
            engine, scope=scope, manifest=guest, source_canonical_json=raw,
        )
    allowed = {**guest, "explicit_guest_transfer":True}
    stage_import_manifest_candidate(engine, scope=scope, manifest=allowed)
    done = commit_verified_legacy_import_candidate(
        engine, scope=scope, manifest=allowed, source_canonical_json=raw,
    )
    assert done["status"] == "COMMITTED"


def test_separate_auth_profiles_cannot_restore_other_person_archive(context):
    engine, scope = context
    source = original()
    raw = canonical(source)
    manifest = manifest_for(scope, source, raw)
    stage_import_manifest_candidate(engine, scope=scope, manifest=manifest)
    done = commit_verified_legacy_import_candidate(
        engine, scope=scope, manifest=manifest, source_canonical_json=raw,
    )
    other = VerifiedFinanceScope(user_id=uuid4().hex, profile_id=uuid4())
    with finance_transaction(engine, verified_user_id=other.user_id,
                             profile_id=other.profile_id) as s:
        s.execute(text("INSERT INTO finance_profiles(id,owner_user_id) VALUES (:p,:u)"),
                  {"p":other.profile_id, "u":other.user_id})
    with pytest.raises(FinanceCommandError) as ex:
        restore_original_legacy_source_candidate(
            engine, scope=other, batch_id=done["batch_id"],
            source_sha256=manifest["source_sha256"],
        )
    assert ex.value.status == 404


def test_two_concurrent_identical_commits_create_one_financial_revision(context):
    engine, scope = context
    source = original()
    raw = canonical(source)
    manifest = manifest_for(scope, source, raw)
    stage_import_manifest_candidate(engine, scope=scope, manifest=manifest)
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(
            lambda _: commit_verified_legacy_import_candidate(
                engine, scope=scope, manifest=manifest,
                source_canonical_json=raw,
            ), (1, 2),
        ))
    assert sorted(x["replayed"] for x in responses) == [False, True]
    assert responses[0]["revision"] == responses[1]["revision"] == 1
    assert counts(engine, scope)["command_receipts"] == 1
    assert counts(engine, scope)["obligations"] == 2
