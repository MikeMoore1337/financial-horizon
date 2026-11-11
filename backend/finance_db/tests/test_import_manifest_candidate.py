"""#69 - disposable PostgreSQL-only source manifest staging (feature OFF).

This intentionally verifies source-ID accounting and RLS, NOT a financial
import or the claimed external encrypted-backup checksum.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from backend.finance_db.db import finance_transaction
from backend.finance_db.import_manifest_candidate import (
    stage_import_manifest_candidate,
)
from backend.finance_db.ledger_service import FinanceCommandError, get_account_snapshot
from backend.finance_db.tests.test_ledger_service import context, add_account


def request(scope, *, sha=None, rows=None, source=None, rev=0):
    return {
        "schema_version": 1,
        "source_scope": source or "account:" + scope.user_id,
        "source_revision": 0,
        "source_sha256": sha or ("ab" * 32),
        "expected_server_revision": rev,
        "external_encrypted_backup_checked": True,
        "explicit_owner_consent": True,
        "explicit_guest_transfer": False,
        "rows": rows if rows is not None else [
            {"record_type": "entries", "source_record_id": "legacy-entry-1"},
            {"record_type": "loans", "source_record_id": "legacy-loan-1"},
        ],
    }


def batch_rows(engine, scope):
    with finance_transaction(
        engine, verified_user_id=scope.user_id, profile_id=scope.profile_id,
    ) as s:
        batches = s.execute(text("""
            SELECT id,source_sha256,status,base_revision FROM import_batches
            WHERE profile_id=:p
        """), {"p": scope.profile_id}).mappings().all()
        mapped = s.execute(text("""
            SELECT record_type,source_record_id,target_id FROM import_record_map
            WHERE profile_id=:p ORDER BY record_type,source_record_id
        """), {"p": scope.profile_id}).mappings().all()
        revisions = s.execute(text("""
            SELECT revision FROM finance_profiles WHERE id=:p
        """), {"p": scope.profile_id}).scalar_one()
        financial = s.execute(text("""
            SELECT (SELECT count(*) FROM accounts) +
                   (SELECT count(*) FROM ledger_transactions) +
                   (SELECT count(*) FROM ledger_postings) +
                   (SELECT count(*) FROM command_receipts) +
                   (SELECT count(*) FROM change_log)
        """)).scalar_one()
        return batches, mapped, revisions, financial


def test_stage_then_replay_preserves_original_financial_revision_and_zero_cash(context):
    engine, scope = context
    manifest = request(scope)
    before = get_account_snapshot(engine, scope=scope)
    staged = stage_import_manifest_candidate(engine, scope=scope, manifest=manifest)
    assert staged["status"] == "UNVERIFIED_MANIFEST_STAGED"
    assert staged["financial_write"] is False
    assert staged["source_approved"] is False
    assert staged["replayed"] is False
    assert staged["record_count"] == 2
    assert len(staged["manifest_fingerprint"]) == 64
    batches, records, revision, financial = batch_rows(engine, scope)
    assert revision == before.body["revision"] == 0
    assert financial == 0
    assert len(batches) == 1
    assert batches[0]["status"] == "staged"
    assert bytes(batches[0]["source_sha256"]).hex() == manifest["source_sha256"]
    assert len(records) == 2
    assert {r["record_type"] for r in records} == {"entries", "loans"}
    assert len({r["target_id"] for r in records}) == 2
    assert get_account_snapshot(engine, scope=scope).etag == before.etag

    replay = stage_import_manifest_candidate(engine, scope=scope, manifest={
        **manifest, "rows": list(reversed(manifest["rows"])),
    })
    assert replay["replayed"] is True
    assert replay["batch_id"] == staged["batch_id"]
    assert replay["manifest_fingerprint"] == staged["manifest_fingerprint"]
    assert batch_rows(engine, scope)[2:] == (0, 0)


def test_staged_batch_rejects_same_digest_different_record_inventory(context):
    engine, scope = context
    original = request(scope)
    stage_import_manifest_candidate(engine, scope=scope, manifest=original)
    changed = request(scope, rows=[original["rows"][0]])
    with pytest.raises(FinanceCommandError) as ex:
        stage_import_manifest_candidate(engine, scope=scope, manifest=changed)
    assert ex.value.code == "semantic_conflict"
    batches, rows, revision, financial = batch_rows(engine, scope)
    assert len(batches) == 1 and len(rows) == 2
    assert revision == 0 and financial == 0


def test_different_pending_sources_require_explicit_conflict_decision(context):
    engine, scope = context
    stage_import_manifest_candidate(engine, scope=scope, manifest=request(scope))
    with pytest.raises(FinanceCommandError) as ex:
        stage_import_manifest_candidate(
            engine, scope=scope,
            manifest=request(scope, sha="cd" * 32),
        )
    assert ex.value.code == "semantic_conflict"
    assert batch_rows(engine, scope)[2:] == (0, 0)


def test_server_existing_account_blocks_import_without_overwriting(context):
    engine, scope = context
    account_id, result = add_account(engine, scope, opening=123456)
    before = get_account_snapshot(engine, scope=scope)
    with pytest.raises(FinanceCommandError) as ex:
        stage_import_manifest_candidate(
            engine, scope=scope, manifest=request(scope, rev=1),
        )
    assert ex.value.code == "semantic_conflict"
    batches, rows, revision, financial = batch_rows(engine, scope)
    assert len(batches) == 0 and len(rows) == 0
    # One account plus its normal commit receipt and change-log entry.
    # These pre-existing rows remain untouched by the rejected import.
    assert revision == 1 and financial == 3
    after = get_account_snapshot(engine, scope=scope)
    # server_at is a read timestamp, not part of the financial transaction.
    # The actual server revision, ETag and account images must be unchanged.
    assert after.etag == before.etag
    assert after.body["revision"] == before.body["revision"]
    assert after.body["entities"] == before.body["entities"]
    assert after.body["entities"][0]["id"] == account_id
    assert after.body["entities"][0]["data"]["balance_minor"] == 123456


def test_stale_server_revision_blocks_manifest_before_any_record_write(context):
    engine, scope = context
    with pytest.raises(FinanceCommandError) as ex:
        stage_import_manifest_candidate(
            engine, scope=scope, manifest=request(scope, rev=3),
        )
    assert ex.value.code == "stale_revision"
    assert batch_rows(engine, scope)[0:2] == ([], [])


def test_guest_source_requires_separate_transfer_consent_and_never_changes_scope(context):
    engine, scope = context
    unconfirmed = request(scope, source="guest:synthetic-guest-2026")
    with pytest.raises(FinanceCommandError) as ex:
        stage_import_manifest_candidate(engine, scope=scope, manifest=unconfirmed)
    assert ex.value.code == "invalid_command"
    assert batch_rows(engine, scope)[0:2] == ([], [])
    confirmed = {**unconfirmed, "explicit_guest_transfer": True}
    result = stage_import_manifest_candidate(engine, scope=scope, manifest=confirmed)
    assert result["status"] == "UNVERIFIED_MANIFEST_STAGED"
    assert result["financial_write"] is False
    assert len(batch_rows(engine, scope)[0]) == 1


def test_other_account_source_is_denied_and_untrusted_user_field_is_rejected(context):
    engine, scope = context
    foreign = request(scope, source="account:" + uuid4().hex)
    with pytest.raises(FinanceCommandError) as ex:
        stage_import_manifest_candidate(engine, scope=scope, manifest=foreign)
    assert ex.value.code == "forbidden"
    with pytest.raises(FinanceCommandError) as ex:
        stage_import_manifest_candidate(
            engine, scope=scope,
            manifest={**request(scope), "profile_id": str(scope.profile_id)},
        )
    assert ex.value.code == "invalid_command"
    assert batch_rows(engine, scope)[0:2] == ([], [])


@pytest.mark.parametrize("invalid", [
    {"source_sha256": "AB" * 32},
    {"source_sha256": "abc"},
    {"external_encrypted_backup_checked": False},
    {"explicit_owner_consent": False},
    {"source_revision": -1},
    {"source_scope": "guest:  bad  "},
    {"rows": [{"record_type": "entries", "source_record_id": ""}]},
    {"rows": [{"record_type": "transactions", "source_record_id": "x"}]},
    {"rows": [{"record_type": "entries", "source_record_id": "a\nsecret"}]},
    {"rows": [{"record_type": "entries", "source_record_id": "abc"}] * 2},
    {"rows": [{"record_type": "entries", "source_record_id": "a"}] * 10_001},
])
def test_broken_manifest_is_never_staged(context, invalid):
    engine, scope = context
    with pytest.raises(FinanceCommandError) as ex:
        stage_import_manifest_candidate(
            engine, scope=scope, manifest={**request(scope), **invalid},
        )
    assert ex.value.code == "invalid_command"
    assert batch_rows(engine, scope)[0:2] == ([], [])


def test_same_manifest_concurrent_requests_map_every_source_only_once(context):
    engine, scope = context
    manifest = request(scope)
    with ThreadPoolExecutor(max_workers=2) as worker:
        responses = list(worker.map(
            lambda _: stage_import_manifest_candidate(
                engine, scope=scope, manifest=manifest,
            ), (0, 1),
        ))
    assert sorted(x["replayed"] for x in responses) == [False, True]
    assert responses[0]["batch_id"] == responses[1]["batch_id"]
    batches, rows, revision, financial = batch_rows(engine, scope)
    assert len(batches) == 1
    assert len(rows) == 2
    assert revision == 0 and financial == 0


def test_manifest_sql_conflict_rolls_back_batch_without_partial_source_map(context):
    engine, scope = context
    manifest = request(scope)
    # Synthetic competing record inventory, not a user financial transaction.
    with finance_transaction(
        engine, verified_user_id=scope.user_id, profile_id=scope.profile_id,
    ) as s:
        s.execute(text("""
            INSERT INTO import_record_map
              (profile_id,source_sha256,record_type,source_record_id,target_id)
            VALUES (:p,:sha,'entries','legacy-entry-1',:target)
        """), {"p": scope.profile_id,
               "sha": bytes.fromhex(manifest["source_sha256"]),
               "target": uuid4()})
    original = batch_rows(engine, scope)
    assert len(original[0]) == 0 and len(original[1]) == 1
    with pytest.raises(IntegrityError):
        stage_import_manifest_candidate(
            engine, scope=scope, manifest=manifest,
        )
    after = batch_rows(engine, scope)
    assert after == original, "failed SQL insertion must not leave partial batch rows"


def test_two_real_postgres_scopes_never_share_staged_legacy_source_ids(context):
    from backend.finance_db.ledger_service import VerifiedFinanceScope
    engine, scope_a = context
    scope_b = VerifiedFinanceScope(user_id=uuid4().hex, profile_id=uuid4())
    with finance_transaction(
        engine, verified_user_id=scope_b.user_id, profile_id=scope_b.profile_id,
    ) as s:
        s.execute(text("""
            INSERT INTO finance_profiles(id,owner_user_id)
            VALUES (:p,:u)
        """), {"p": scope_b.profile_id, "u": scope_b.user_id})
    manifest_a = request(scope_a)
    manifest_b = request(scope_b)
    a = stage_import_manifest_candidate(
        engine, scope=scope_a, manifest=manifest_a,
    )
    b = stage_import_manifest_candidate(
        engine, scope=scope_b, manifest=manifest_b,
    )
    assert a["status"] == b["status"] == "UNVERIFIED_MANIFEST_STAGED"
    assert a["batch_id"] != b["batch_id"]
    batches_a, records_a, revision_a, financial_a = batch_rows(engine, scope_a)
    batches_b, records_b, revision_b, financial_b = batch_rows(engine, scope_b)
    assert len(batches_a) == len(batches_b) == 1
    assert len(records_a) == len(records_b) == 2
    assert {r["target_id"] for r in records_a}.isdisjoint(
        {r["target_id"] for r in records_b})
    assert revision_a == revision_b == 0
    assert financial_a == financial_b == 0
    # The profile A runtime connection cannot even SELECT B's staged records.
    with finance_transaction(
        engine, verified_user_id=scope_a.user_id, profile_id=scope_a.profile_id,
    ) as s:
        assert s.execute(text("""
            SELECT count(*) FROM import_batches WHERE profile_id=:other
        """), {"other": scope_b.profile_id}).scalar_one() == 0
