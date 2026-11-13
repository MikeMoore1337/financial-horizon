"""#69: RLS-scoped PostgreSQL import source MANIFEST staging - feature OFF.

This is *not* a financial import, authoritative validation of an encrypted
backup or a public HTTP route. It does not change account balances, loan data,
settlements, server revision or original IndexedDB.

A future independently approved importer must verify the actual encrypted
source, mapping and money before atomically committing any financial fact.
"""
from __future__ import annotations

from hashlib import sha256
from uuid import UUID, uuid5
import json
import re

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, field_validator
from sqlalchemy import text
from sqlalchemy.engine import Engine

from .db import finance_transaction
from .ledger_service import FinanceCommandError, VerifiedFinanceScope

_SOURCE_SCOPE = re.compile(r"^(?:account:[0-9a-f]{32}|guest:[A-Za-z0-9_-]{4,64})$")
_HEX_SHA = re.compile(r"^[a-f0-9]{64}$")
_KIND = ("entries", "loans", "settlements", "loanPayments")
_MAX_RECORDS = 10000
_MAX_SAFE_REVISION = 2**53 - 1
_UUID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")


class ImportRowCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    record_type: str
    source_record_id: str = Field(min_length=1, max_length=128)

    @field_validator("record_type")
    @classmethod
    def type_allowed(cls, value: str) -> str:
        if value not in _KIND:
            raise ValueError("unsupported legacy finance type")
        return value

    @field_validator("source_record_id")
    @classmethod
    def stable_identifier(cls, value: str) -> str:
        if value != value.strip() or any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
            raise ValueError("invalid source identifier")
        return value


class ImportSourceManifestCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    schema_version: StrictInt
    source_scope: str
    source_revision: StrictInt = Field(ge=0, le=_MAX_SAFE_REVISION)
    source_sha256: str
    expected_server_revision: StrictInt = Field(ge=0, le=_MAX_SAFE_REVISION)
    external_encrypted_backup_checked: StrictBool
    explicit_owner_consent: StrictBool
    explicit_guest_transfer: StrictBool = False
    preserve_zero_account_id: str | None = Field(default=None, pattern=_UUID.pattern)
    confirm_preserve_zero_account: StrictBool = False
    rows: list[ImportRowCandidate] = Field(max_length=_MAX_RECORDS)

    @field_validator("schema_version")
    @classmethod
    def exact_version(cls, value: int) -> int:
        if value != 1:
            raise ValueError("unsupported manifest schema")
        return value

    @field_validator("source_scope")
    @classmethod
    def source_scope_is_bounded(cls, value: str) -> str:
        if not _SOURCE_SCOPE.fullmatch(value):
            raise ValueError("invalid legacy origin")
        return value

    @field_validator("source_sha256")
    @classmethod
    def hash_is_bounded(cls, value: str) -> str:
        if not _HEX_SHA.fullmatch(value):
            raise ValueError("invalid source hash")
        return value


def _safe_manifest(value: object) -> ImportSourceManifestCandidate:
    try:
        request = ImportSourceManifestCandidate.model_validate(value)
        if (request.external_encrypted_backup_checked is not True
            or request.explicit_owner_consent is not True
            or (request.source_scope.startswith("guest:")
                and request.explicit_guest_transfer is not True)
            or (request.source_scope.startswith("account:")
                and request.explicit_guest_transfer is True)
            or request.confirm_preserve_zero_account !=
                (request.preserve_zero_account_id is not None)):
            raise ValueError("missing explicit verified consent")
        unique = {(row.record_type, row.source_record_id) for row in request.rows}
        if len(unique) != len(request.rows):
            raise ValueError("duplicate import source ID")
        # A SHA from client input is an *unverified claim* until the true
        # encrypted source is recovered and independently matched to it.
        return request
    except (ValueError, TypeError, OverflowError, RecursionError):
        raise FinanceCommandError(
            "invalid_command", "Некорректный предварительный импорт", 422,
        ) from None


def import_batch_id(scope: VerifiedFinanceScope,
                    request: ImportSourceManifestCandidate) -> UUID:
    """Bind the preservation decision to the immutable staged batch identity."""
    identity = (
        "financial-horizon:import-manifest:v1:" + request.source_scope + ":" +
        request.source_sha256 + ":" + str(request.source_revision)
    )
    if request.preserve_zero_account_id is not None:
        identity += ":preserve-zero:" + request.preserve_zero_account_id
    return uuid5(scope.profile_id, identity)


def require_safe_import_target(session, profile_id: UUID,
                               request: ImportSourceManifestCandidate) -> None:
    """Allow only an empty profile or explicit preservation of ONE unused 0-RUB account.

    The original account is never deleted, renamed or reused; the imported
    legacy facts produce no inferred bank balance or postings. Call under
    the locked finance_profiles row in both staging and commit.
    """
    accounts = session.execute(text("""
        SELECT id,opening_minor,entity_revision,currency,archived_at
        FROM accounts WHERE profile_id=:p ORDER BY id LIMIT 2
    """), {"p": profile_id}).mappings().all()
    other_finance = session.execute(text("""
        SELECT EXISTS(SELECT 1 FROM obligations WHERE profile_id=:p)
            OR EXISTS(SELECT 1 FROM loans WHERE profile_id=:p)
            OR EXISTS(SELECT 1 FROM reserves WHERE profile_id=:p)
            OR EXISTS(SELECT 1 FROM settlements WHERE profile_id=:p)
            OR EXISTS(SELECT 1 FROM loan_payments WHERE profile_id=:p)
            OR EXISTS(SELECT 1 FROM ledger_transactions WHERE profile_id=:p)
            OR EXISTS(SELECT 1 FROM ledger_postings WHERE profile_id=:p)
            OR EXISTS(SELECT 1 FROM reserve_allocations WHERE profile_id=:p)
    """), {"p": profile_id}).scalar_one()
    if other_finance:
        raise FinanceCommandError("semantic_conflict",
                                  "Сервер содержит финансовые записи", 409)
    if not accounts:
        if request.preserve_zero_account_id is None:
            return
        raise FinanceCommandError("semantic_conflict",
                                  "Указанный счёт на сервере отсутствует", 409)
    if (len(accounts) != 1 or not request.confirm_preserve_zero_account or
        str(accounts[0]["id"]) != request.preserve_zero_account_id or
        int(accounts[0]["opening_minor"]) != 0 or
        int(accounts[0]["entity_revision"]) != 1 or
        accounts[0]["archived_at"] is not None or
        accounts[0]["currency"].strip() != "RUB"):
        raise FinanceCommandError("semantic_conflict",
                                  "Нельзя объединить действующие серверные финансы", 409)


def stage_import_manifest_candidate(
    engine: Engine, *, scope: VerifiedFinanceScope, manifest: object,
) -> dict[str, object]:
    """Stage a deterministic map under real PostgreSQL RLS; NO financial writes.

    Same canonical source hash/manifest is idempotent. Different source in a
    pending profile needs a human conflict decision. Nothing is imported or
    exposed until a separately accepted versioned import protocol exists.
    """
    request = _safe_manifest(manifest)
    if (request.source_scope.startswith("account:")
        and request.source_scope != "account:" + scope.user_id):
        raise FinanceCommandError(
            "forbidden", "Источник принадлежит другому аккаунту", 403,
        )
    digest_bytes = bytes.fromhex(request.source_sha256)
    canonical_rows = sorted((item.record_type, item.source_record_id) for item in request.rows)
    manifest_fingerprint = sha256(
        json.dumps(canonical_rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    batch_id = import_batch_id(scope, request)
    with finance_transaction(
        engine, verified_user_id=scope.user_id, profile_id=scope.profile_id,
    ) as session:
        # Use the same profile-level row lock as the financial command core,
        # so no concurrent confirmed posting can enter between the empty
        # financial-data check and creation of the staged metadata.
        profile = session.execute(text("""
            SELECT revision FROM finance_profiles WHERE id=:p FOR UPDATE
        """), {"p": scope.profile_id}).mappings().one_or_none()
        if profile is None:
            raise FinanceCommandError("forbidden", "Нет доступа к профилю", 403)
        if int(profile["revision"]) != request.expected_server_revision:
            raise FinanceCommandError(
                "stale_revision", "Серверный финансовый профиль изменился", 412,
                int(profile["revision"]),
            )

        existing = session.execute(text("""
            SELECT id,status,source_sha256,base_revision FROM import_batches
            WHERE profile_id=:p AND id=:id
        """), {"p": scope.profile_id, "id": batch_id}).mappings().one_or_none()
        if existing is not None:
            stored = session.execute(text("""
                SELECT record_type,source_record_id,target_id FROM import_record_map
                WHERE profile_id=:p AND source_sha256=:sha
                ORDER BY record_type,source_record_id
            """), {"p": scope.profile_id, "sha": digest_bytes}).mappings().all()
            expected = [
                (kind, old_id, uuid5(scope.profile_id,
                    "financial-horizon:legacy-record:v1:" +
                    request.source_sha256 + ":" + kind + ":" + old_id))
                for kind, old_id in canonical_rows
            ]
            if (bytes(existing["source_sha256"]) != digest_bytes
                or int(existing["base_revision"]) != request.expected_server_revision
                or [(x["record_type"], x["source_record_id"], x["target_id"])
                    for x in stored] != expected
                or existing["status"] != "staged"):
                raise FinanceCommandError(
                    "semantic_conflict", "Повторный импорт не совпадает с исходным", 409,
                )
            return {"status": "UNVERIFIED_MANIFEST_STAGED",
                    "batch_id": str(batch_id), "record_count": len(canonical_rows),
                    "replayed": True, "financial_write": False,
                    "source_approved": False, "manifest_fingerprint": manifest_fingerprint}

        active = session.execute(text("""
            SELECT 1 FROM import_batches WHERE profile_id=:p
              AND status IN ('staged','reviewed') LIMIT 1
        """), {"p": scope.profile_id}).first()
        if active:
            raise FinanceCommandError(
                "semantic_conflict", "Другой перенос уже ожидает решения", 409,
            )
        # Any existing account requires the exact UUID and a second owner
        # confirmation; only one untouched zero-RUB account is compatible.
        require_safe_import_target(session, scope.profile_id, request)
        session.execute(text("""
            INSERT INTO import_batches
             (profile_id,id,source_sha256,status,base_revision)
            VALUES (:p,:id,:sha,'staged',:r)
        """), {"p": scope.profile_id, "id": batch_id,
               "sha": digest_bytes, "r": request.expected_server_revision})
        for kind, old_id in canonical_rows:
            target = uuid5(scope.profile_id,
                "financial-horizon:legacy-record:v1:" +
                request.source_sha256 + ":" + kind + ":" + old_id)
            session.execute(text("""
                INSERT INTO import_record_map
                 (profile_id,source_sha256,record_type,source_record_id,target_id)
                VALUES (:p,:sha,:kind,:old,:target)
            """), {"p": scope.profile_id, "sha": digest_bytes,
                   "kind": kind, "old": old_id, "target": target})
        return {
            "status": "UNVERIFIED_MANIFEST_STAGED",
            "batch_id": str(batch_id),
            "record_count": len(canonical_rows),
            "replayed": False,
            "financial_write": False,
            "source_approved": False,
            "manifest_fingerprint": manifest_fingerprint,
        }
