"""Unpublished account-command v2 proposal for #33/#67.

This module has NO HTTP route, runtime integration or storage side effects.
Accepted finance v1 remains unchanged. Human approval of a versioned API,
the linked-payment void contract and all release gates are still mandatory.
"""
from __future__ import annotations

from datetime import date
import json
import re
from typing import Any, Literal

from fastapi import Request
from pydantic import Field, StrictInt, field_validator, model_validator

from backend.finance_db.ledger_service import FinanceCommandError
from .contracts import (
    MAX_JS_INT, MAX_MINOR, MAX_REQUEST_BYTES, UUID_PATTERN, Wire,
    _reject_duplicate_json_keys,
)

ACCOUNT_KINDS = ("bank", "card", "cash", "savings", "other")
ACTIONS = (
    "account.create", "account.update", "account.archive",
    "account.unarchive", "transaction.record",
)


def _date(value: str) -> str:
    if len(value) != 10:
        raise ValueError("Invalid ISO date")
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        raise ValueError("Invalid ISO date") from None
    if parsed.isoformat() != value:
        raise ValueError("Invalid ISO date")
    return value


class AccountCreateV2(Wire):
    id: str = Field(pattern=UUID_PATTERN)
    name: str = Field(min_length=1, max_length=160)
    kind: Literal["bank", "card", "cash", "savings", "other"]
    currency: Literal["RUB"]
    opening_minor: StrictInt = Field(ge=-MAX_MINOR, le=MAX_MINOR)

    @field_validator("name")
    @classmethod
    def nonblank_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Account name cannot be blank")
        return value


class AccountUpdateV2(Wire):
    account_id: str = Field(pattern=UUID_PATTERN)
    name: str = Field(min_length=1, max_length=160)
    kind: Literal["bank", "card", "cash", "savings", "other"]

    @field_validator("name")
    @classmethod
    def nonblank_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Account name cannot be blank")
        return value


class AccountArchiveV2(Wire):
    # Archive timestamp is always server-minted; never trusted from the client.
    account_id: str = Field(pattern=UUID_PATTERN)


class TransactionRecordV2(Wire):
    id: str = Field(pattern=UUID_PATTERN)
    account_id: str = Field(pattern=UUID_PATTERN)
    kind: Literal["income", "expense", "adjustment"]
    signed_minor: StrictInt = Field(ge=-MAX_MINOR, le=MAX_MINOR)
    occurred_on: str
    note: str | None = Field(default=None, max_length=500)

    @field_validator("occurred_on")
    @classmethod
    def iso_date(cls, value: str) -> str:
        return _date(value)

    @model_validator(mode="after")
    def signed_effect(self):
        if (
            self.signed_minor == 0
            or (self.kind == "income" and self.signed_minor < 0)
            or (self.kind == "expense" and self.signed_minor > 0)
        ):
            raise ValueError("Posted cash movement does not match the action")
        return self


_PAYLOADS = {
    "account.create": AccountCreateV2,
    "account.update": AccountUpdateV2,
    "account.archive": AccountArchiveV2,
    "account.unarchive": AccountArchiveV2,
    "transaction.record": TransactionRecordV2,
}


class AccountV2Candidate(Wire):
    schema_version: Literal[2]
    client_mutation_id: str = Field(pattern=UUID_PATTERN)
    base_revision: StrictInt = Field(ge=0, le=MAX_JS_INT)
    action: Literal[
        "account.create", "account.update", "account.archive",
        "account.unarchive", "transaction.record",
    ]
    expected_entity_revisions: dict[str, StrictInt]
    payload: dict[str, Any]

    @field_validator("schema_version", mode="before")
    @classmethod
    def exact_version(cls, value: Any) -> int:
        if type(value) is not int or value != 2:
            raise ValueError("Expected integer version 2")
        return value

    @field_validator("expected_entity_revisions")
    @classmethod
    def revisions(cls, versions: dict[str, int]) -> dict[str, int]:
        if len(versions) > 100 or any(
            re.fullmatch(UUID_PATTERN, key) is None
            or value < 1 or value > MAX_JS_INT
            for key, value in versions.items()
        ):
            raise ValueError("Invalid account entity revision")
        return versions


def validate_v2_account_candidate(
    command: object, *, if_match: str, idempotency_key: str,
) -> dict[str, Any]:
    """Validate proposed transport ONLY; never run or authorize a DB mutation.

    The eventual authenticated v2 router must also bind a verified session,
    perform RLS/CAS/idempotent SQL COMMIT and preserve the signed request
    fingerprint. It must NOT expose allow_internal=True over public HTTP.
    """
    candidate = AccountV2Candidate.model_validate(command)
    if (
        not isinstance(if_match, str)
        or re.fullmatch(r'"[^"\r\n]{1,254}"', if_match) is None
        or idempotency_key != candidate.client_mutation_id
    ):
        raise ValueError("Missing or inconsistent strong preconditions")
    payload = _PAYLOADS[candidate.action].model_validate(candidate.payload)
    required = (
        set()
        if candidate.action == "account.create"
        else {payload.account_id}
    )
    if set(candidate.expected_entity_revisions) != required:
        raise ValueError("Missing or extraneous account entity revisions")
    return {
        **candidate.model_dump(),
        "payload": payload.model_dump(exclude_unset=True),
    }

async def parse_v2_account_command(request: Request) -> dict[str, Any]:
    """Validate an opt-in candidate with v1-equivalent bounded JSON transport.

    Revalidate the real FH session after the final streamed chunk and before
    the SQL transaction. Never accept client-provided actor/profile metadata.
    """
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        raise FinanceCommandError("invalid_command", "Требуется application/json", 422)
    declared = request.headers.get("content-length")
    if declared is not None and (
        not declared.isascii() or not declared.isdecimal()
        or len(declared) > 12 or int(declared) > MAX_REQUEST_BYTES
    ):
        raise FinanceCommandError("invalid_command", "Слишком большой запрос", 413)
    # Match the accepted v1 precondition contract, without reading or
    # executing a financial command under a missing/weak server ETag.
    if_match = request.headers.get("if-match", "")
    if re.fullmatch(r'"[^"\\r\\n]{1,254}"', if_match) is None:
        raise FinanceCommandError(
            "precondition_required", "Требуется сильный If-Match", 428,
        )
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_REQUEST_BYTES:
            raise FinanceCommandError("invalid_command", "Слишком большой запрос", 413)
        chunks.append(chunk)
    try:
        raw = json.loads(
            b"".join(chunks),
            parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite")),
            object_pairs_hook=_reject_duplicate_json_keys,
        )
        return validate_v2_account_candidate(
            raw,
            if_match=request.headers.get("if-match", ""),
            idempotency_key=request.headers.get("idempotency-key", ""),
        )
    except (ValueError, TypeError, UnicodeDecodeError, RecursionError, OverflowError):
        # Never echo malformed JSON or Pydantic validation details.
        raise FinanceCommandError(
            "invalid_command", "Некорректная финансовая команда", 422,
        ) from None
