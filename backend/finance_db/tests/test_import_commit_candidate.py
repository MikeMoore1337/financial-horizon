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
    atomic_verified_legacy_merge_candidate,
    restore_original_legacy_source_candidate,
    _snapshot_rows,
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


def test_import_refuses_nonempty_bank_history_before_sql():
    source = original()
    source["bankStatements"] = {"version": 1, "accounts": [], "operations": [], "batches": []}
    _snapshot_rows(source, source["revision"])
    for kind in ("accounts", "operations", "batches"):
        modified = json.loads(json.dumps(source))
        modified["bankStatements"][kind].append({"id": "synthetic"})
        with pytest.raises(FinanceCommandError):
            _snapshot_rows(modified, modified["revision"])


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


def test_bank_history_rejected_without_changing_existing_sql(context):
    engine, scope = context
    source = original()
    source["bankStatements"] = {"version": 1, "accounts": [{"id": "synthetic"}],
                                "operations": [], "batches": []}
    raw = canonical(source)
    manifest = manifest_for(scope, source, raw)
    stage_import_manifest_candidate(engine, scope=scope, manifest=manifest)
    before = counts(engine, scope)
    with pytest.raises(FinanceCommandError):
        commit_verified_legacy_import_candidate(
            engine, scope=scope, manifest=manifest, source_canonical_json=raw,
        )
    assert counts(engine, scope) == before
    assert get_finance_snapshot(engine, scope=scope).body["revision"] == 0


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


def _previous_import_and_merge(engine, scope):
    source = original()
    first = manifest_for(scope, source)
    stage_import_manifest_candidate(engine, scope=scope, manifest=first)
    commit_verified_legacy_import_candidate(
        engine, scope=scope, manifest=first, source_canonical_json=canonical(source),
    )
    with finance_transaction(engine, verified_user_id=scope.user_id, profile_id=scope.profile_id) as s:
        mapping = {(r["record_type"], r["source_record_id"]): str(r["target_id"])
                   for r in s.execute(text("""
                     SELECT record_type,source_record_id,target_id FROM import_record_map
                     WHERE profile_id=:p
                   """), {"p":scope.profile_id}).mappings().all()}
    account_id, _ = add_account(engine, scope, opening=123456)
    source["revision"] += 1
    source["entries"].append({"id":"new-entry", "title":"Новый синтетический расход",
        "kind":"expense", "amountCents":450, "date":"2026-12-05", "recurrence":"once"})
    raw = canonical(source)
    manifest = manifest_for(scope, source, raw, schema_version=2, expected_server_revision=2)
    for row in manifest["rows"]:
        target = mapping.get((row["record_type"], row["source_record_id"]))
        row["decision"] = "link" if target else "add"
        if target:
            row["target_id"] = target
    return source, raw, manifest, account_id


def test_merge_preserves_existing_profile_and_does_not_duplicate_previous_import(context):
    engine, scope = context
    source, raw, manifest, account_id = _previous_import_and_merge(engine, scope)
    before = get_finance_snapshot(engine, scope=scope).body["entities"]
    stage_import_manifest_candidate(engine, scope=scope, manifest=manifest)
    done = commit_verified_legacy_import_candidate(
        engine, scope=scope, manifest=manifest, source_canonical_json=raw,
    )
    after = get_finance_snapshot(engine, scope=scope).body["entities"]
    assert done["revision"] == 3 and done["cash_postings_created"] == 0
    assert {x["id"] for x in before}.issubset({x["id"] for x in after})
    assert len(after) == len(before) + 1
    assert next(x for x in after if x["id"] == account_id)["data"]["balance_minor"] == 123456
    assert restore_original_legacy_source_candidate(
        engine, scope=scope, batch_id=done["batch_id"], source_sha256=manifest["source_sha256"],
    ) == raw
    replay = commit_verified_legacy_import_candidate(
        engine, scope=scope, manifest=manifest, source_canonical_json=raw,
    )
    assert replay["replayed"] is True
    assert get_finance_snapshot(engine, scope=scope).body["entities"] == after


def test_merge_rejects_changed_link_without_partial_writes(context):
    engine, scope = context
    source, _, manifest, _ = _previous_import_and_merge(engine, scope)
    source["entries"][0]["amountCents"] += 1
    raw = canonical(source)
    manifest["source_sha256"] = sha256(raw.encode("utf-8")).hexdigest()
    before = get_finance_snapshot(engine, scope=scope)
    stage_import_manifest_candidate(engine, scope=scope, manifest=manifest)
    with pytest.raises(FinanceCommandError):
        commit_verified_legacy_import_candidate(
            engine, scope=scope, manifest=manifest, source_canonical_json=raw,
        )
    after = get_finance_snapshot(engine, scope=scope)
    assert after.body["entities"] == before.body["entities"] and after.etag == before.etag


def test_merge_rejects_previous_source_id_marked_as_new(context):
    engine, scope = context
    _, _, manifest, _ = _previous_import_and_merge(engine, scope)
    manifest["rows"][0].pop("target_id")
    manifest["rows"][0]["decision"] = "add"
    before = get_finance_snapshot(engine, scope=scope)
    with pytest.raises(FinanceCommandError):
        stage_import_manifest_candidate(engine, scope=scope, manifest=manifest)
    after = get_finance_snapshot(engine, scope=scope)
    assert after.body["entities"] == before.body["entities"] and after.etag == before.etag


def test_merge_rejects_new_id_with_identical_server_financial_record(context):
    engine, scope = context
    source, _, manifest, _ = _previous_import_and_merge(engine, scope)
    copied = dict(source["entries"][0], id="different-source-id")
    source["entries"].append(copied)
    raw = canonical(source)
    manifest["source_sha256"] = sha256(raw.encode("utf-8")).hexdigest()
    manifest["rows"].append({"record_type":"entries", "source_record_id":copied["id"],
                             "decision":"add"})
    before = get_finance_snapshot(engine, scope=scope)
    stage_import_manifest_candidate(engine, scope=scope, manifest=manifest)
    with pytest.raises(FinanceCommandError):
        commit_verified_legacy_import_candidate(engine, scope=scope, manifest=manifest,
                                                source_canonical_json=raw)
    after = get_finance_snapshot(engine, scope=scope)
    assert after.body["entities"] == before.body["entities"] and after.etag == before.etag


def test_merge_rejects_identical_new_records_before_any_insert(context):
    engine, scope = context
    source, _, manifest, _ = _previous_import_and_merge(engine, scope)
    copied = dict(source["entries"][-1], id="another-new-id")
    source["entries"].append(copied)
    raw = canonical(source)
    manifest["source_sha256"] = sha256(raw.encode("utf-8")).hexdigest()
    manifest["rows"].append({"record_type":"entries", "source_record_id":copied["id"],
                             "decision":"add"})
    before = get_finance_snapshot(engine, scope=scope)
    stage_import_manifest_candidate(engine, scope=scope, manifest=manifest)
    with pytest.raises(FinanceCommandError):
        commit_verified_legacy_import_candidate(engine, scope=scope, manifest=manifest,
                                                source_canonical_json=raw)
    after = get_finance_snapshot(engine, scope=scope)
    assert after.body["entities"] == before.body["entities"] and after.etag == before.etag


def test_merge_rechecks_revision_after_stage(context):
    engine, scope = context
    _, raw, manifest, _ = _previous_import_and_merge(engine, scope)
    stage_import_manifest_candidate(engine, scope=scope, manifest=manifest)
    add_account(engine, scope, opening=42, name="Другой синтетический счёт")
    before = get_finance_snapshot(engine, scope=scope)
    with pytest.raises(FinanceCommandError) as error:
        commit_verified_legacy_import_candidate(engine, scope=scope, manifest=manifest,
                                                source_canonical_json=raw)
    assert error.value.code == "stale_revision"
    after = get_finance_snapshot(engine, scope=scope)
    assert after.body["entities"] == before.body["entities"] and after.etag == before.etag


def test_merge_sql_failure_rolls_back_added_records_and_preserves_existing(context):
    engine, scope = context
    _, raw, manifest, _ = _previous_import_and_merge(engine, scope)
    stage_import_manifest_candidate(engine, scope=scope, manifest=manifest)
    before = get_finance_snapshot(engine, scope=scope)
    with pytest.raises(RuntimeError, match="SYNTHETIC_IMPORT_TRANSACTION_FAILURE"):
        commit_verified_legacy_import_candidate(engine, scope=scope, manifest=manifest,
                                                source_canonical_json=raw,
                                                fail_after_sql_kind="entries")
    after = get_finance_snapshot(engine, scope=scope)
    assert after.body["entities"] == before.body["entities"] and after.etag == before.etag


def test_merge_rejects_two_source_records_linked_to_one_target(context):
    engine, scope = context
    _, _, manifest, _ = _previous_import_and_merge(engine, scope)
    linked = next(row for row in manifest["rows"] if row["record_type"] == "entries" and row["decision"] == "link")
    new = next(row for row in manifest["rows"] if row["source_record_id"] == "new-entry")
    new.update(decision="link", target_id=linked["target_id"])
    before = get_finance_snapshot(engine, scope=scope)
    with pytest.raises(FinanceCommandError):
        stage_import_manifest_candidate(engine, scope=scope, manifest=manifest)
    after = get_finance_snapshot(engine, scope=scope)
    assert after.body["entities"] == before.body["entities"] and after.etag == before.etag


def test_merge_preserves_existing_reserve_and_allocations(context):
    from backend.finance_db.tests.test_reserve_v2_candidate import reserve_input, submit
    engine, scope = context
    _, raw, manifest, account = _previous_import_and_merge(engine, scope)
    obligation = next(row["target_id"] for row in manifest["rows"]
                      if row["record_type"] == "entries" and row["source_record_id"] == "legacy-rent")
    reserve = reserve_input(account, obligation)
    assert submit(engine, scope, "reserve.create", reserve, [account, obligation]).status == 201
    before = get_finance_snapshot(engine, scope=scope)
    manifest["expected_server_revision"] = before.body["revision"]
    stage_import_manifest_candidate(engine, scope=scope, manifest=manifest)
    commit_verified_legacy_import_candidate(engine, scope=scope, manifest=manifest,
                                            source_canonical_json=raw)
    after = get_finance_snapshot(engine, scope=scope)
    before_by_id = {row["id"]:row for row in before.body["entities"]}
    after_by_id = {row["id"]:row for row in after.body["entities"]}
    assert all(after_by_id[key] == value for key, value in before_by_id.items())
    assert after_by_id[reserve["id"]]["data"]["allocated_minor"] == 3000


def _import_metadata_counts(engine, scope):
    with finance_transaction(engine, verified_user_id=scope.user_id, profile_id=scope.profile_id) as s:
        return tuple(s.execute(text("SELECT count(*) FROM " + table + " WHERE profile_id=:p"),
                               {"p":scope.profile_id}).scalar_one()
                     for table in ("import_batches", "import_record_map"))


def test_atomic_merge_failure_leaves_no_staged_batch_or_new_financial_rows(context):
    engine, scope = context
    _, raw, manifest, _ = _previous_import_and_merge(engine, scope)
    before = get_finance_snapshot(engine, scope=scope)
    metadata = _import_metadata_counts(engine, scope)
    with pytest.raises(RuntimeError, match="SYNTHETIC_IMPORT_TRANSACTION_FAILURE"):
        atomic_verified_legacy_merge_candidate(engine, scope=scope, manifest=manifest,
            source_canonical_json=raw, fail_after_sql_kind="entries")
    after = get_finance_snapshot(engine, scope=scope)
    assert after.body["entities"] == before.body["entities"] and after.etag == before.etag
    assert _import_metadata_counts(engine, scope) == metadata


def test_atomic_merge_replay_does_not_add_any_financial_record(context):
    engine, scope = context
    _, raw, manifest, _ = _previous_import_and_merge(engine, scope)
    first = atomic_verified_legacy_merge_candidate(engine, scope=scope, manifest=manifest,
                                                    source_canonical_json=raw)
    after = get_finance_snapshot(engine, scope=scope)
    replay = atomic_verified_legacy_merge_candidate(engine, scope=scope, manifest=manifest,
                                                     source_canonical_json=raw)
    assert first["replayed"] is False and replay["replayed"] is True
    assert replay["batch_id"] == first["batch_id"]
    assert get_finance_snapshot(engine, scope=scope).body["entities"] == after.body["entities"]


def test_atomic_merge_refuses_unreviewable_schedule_fields_without_a_stage(context):
    engine, scope = context
    source, _, manifest, _ = _previous_import_and_merge(engine, scope)
    source["loans"][0]["schedule"][0]["internalId"] = "synthetic"
    raw = canonical(source)
    manifest["source_sha256"] = sha256(raw.encode("utf-8")).hexdigest()
    metadata = _import_metadata_counts(engine, scope)
    before = get_finance_snapshot(engine, scope=scope)
    with pytest.raises(FinanceCommandError):
        atomic_verified_legacy_merge_candidate(engine, scope=scope, manifest=manifest,
                                                source_canonical_json=raw)
    after = get_finance_snapshot(engine, scope=scope)
    assert after.body["entities"] == before.body["entities"] and after.etag == before.etag
    assert _import_metadata_counts(engine, scope) == metadata


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


def test_preserve_exact_one_unused_zero_account_requires_owner_opt_in(context):
    """A pre-existing 0-RUB test account is retained, never wiped or reused."""
    engine, scope = context
    account_id, _ = add_account(engine, scope, opening=0, name="Synthetic zero")
    before = get_account_snapshot(engine, scope=scope)
    assert before.body["revision"] == 1
    assert len(before.body["entities"]) == 1
    source = original()
    raw = canonical(source)
    request = manifest_for(
        scope, source, raw, expected_server_revision=before.body["revision"],
        preserve_zero_account_id=account_id,
        confirm_preserve_zero_account=True,
    )
    staged = stage_import_manifest_candidate(engine, scope=scope, manifest=request)
    assert staged["status"] == "UNVERIFIED_MANIFEST_STAGED"
    committed = commit_verified_legacy_import_candidate(
        engine, scope=scope, manifest=request, source_canonical_json=raw,
    )
    assert committed["status"] == "COMMITTED"
    assert committed["revision"] == 2
    assert committed["cash_postings_created"] == 0
    after = get_account_snapshot(engine, scope=scope)
    assert after.body["revision"] == 2
    assert len(after.body["entities"]) == 1
    assert after.body["entities"][0] == before.body["entities"][0]
    with finance_transaction(engine, verified_user_id=scope.user_id,
                             profile_id=scope.profile_id) as db:
        assert db.execute(text("SELECT count(*) FROM accounts")).scalar_one() == 1
        assert db.execute(text("SELECT count(*) FROM ledger_postings")).scalar_one() == 0
        assert db.execute(text("SELECT count(*) FROM obligations")).scalar_one() == 2
    replay = commit_verified_legacy_import_candidate(
        engine, scope=scope, manifest=request, source_canonical_json=raw,
    )
    assert replay["replayed"] is True and replay["revision"] == 2
    recovered = restore_original_legacy_source_candidate(
        engine, scope=scope, batch_id=committed["batch_id"],
        source_sha256=request["source_sha256"],
    )
    assert recovered == raw


@pytest.mark.parametrize("opening,additional,wrong_id", [
    (0, False, False),
    (100, False, False),
    (-100, False, False),
    (0, True, False),
    (0, False, True),
])
def test_nonempty_profile_requires_exact_zero_account_and_consent(
        context, opening, additional, wrong_id):
    engine, scope = context
    account_id, _ = add_account(engine, scope, opening=opening)
    if additional:
        add_account(engine, scope, opening=0)
    version = get_account_snapshot(engine, scope=scope).body["revision"]
    source = original()
    raw = canonical(source)
    candidate = manifest_for(
        scope, source, raw, expected_server_revision=version,
        preserve_zero_account_id=str(uuid4()) if wrong_id else account_id,
        confirm_preserve_zero_account=True,
    )
    before = counts(engine, scope)
    if opening == 0 and not additional and not wrong_id:
        with pytest.raises(FinanceCommandError) as missing:
            stage_import_manifest_candidate(
                engine, scope=scope,
                manifest={k: v for k, v in candidate.items()
                          if k not in ("preserve_zero_account_id",
                                      "confirm_preserve_zero_account")},
            )
        assert missing.value.status == 409
    else:
        with pytest.raises(FinanceCommandError) as error:
            stage_import_manifest_candidate(engine, scope=scope, manifest=candidate)
        assert error.value.status == 409
    assert counts(engine, scope) == before


def test_malformed_preservation_consent_does_not_stage_any_manifest(context):
    engine, scope = context
    account_id, _ = add_account(engine, scope, opening=0)
    source = original()
    raw = canonical(source)
    version = get_account_snapshot(engine, scope=scope).body["revision"]
    valid = manifest_for(scope, source, raw, expected_server_revision=version,
                         preserve_zero_account_id=account_id,
                         confirm_preserve_zero_account=True)
    initial = counts(engine, scope)
    for damaged in (
        {**valid, "confirm_preserve_zero_account": False},
        {**valid, "confirm_preserve_zero_account": "true"},
        {**valid, "preserve_zero_account_id": None},
        {**valid, "preserve_zero_account_id": "../../other"},
    ):
        with pytest.raises(FinanceCommandError) as error:
            stage_import_manifest_candidate(engine, scope=scope, manifest=damaged)
        assert error.value.status == 422
    assert counts(engine, scope) == initial


def test_new_server_account_between_zero_account_stage_and_commit_denies_import(context):
    engine, scope = context
    aid, _ = add_account(engine, scope, opening=0)
    snapshot = get_account_snapshot(engine, scope=scope)
    source = original()
    raw = canonical(source)
    manifest = manifest_for(
        scope, source, raw, expected_server_revision=snapshot.body["revision"],
        preserve_zero_account_id=aid, confirm_preserve_zero_account=True,
    )
    stage_import_manifest_candidate(engine, scope=scope, manifest=manifest)
    add_account(engine, scope, opening=0)
    before = counts(engine, scope)
    with pytest.raises(FinanceCommandError) as error:
        commit_verified_legacy_import_candidate(
            engine, scope=scope, manifest=manifest, source_canonical_json=raw,
        )
    assert error.value.status in (409, 412)
    assert counts(engine, scope) == before
