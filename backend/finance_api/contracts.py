"""Strict HTTP envelope and bounded streaming for the accepted finance v1 subset.

The database-backed command service is authoritative for monetary invariants.
This module provides only transport validation; never accepts a client principal.
"""
from __future__ import annotations

from datetime import date
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
import json
import re
from typing import Any, Literal

from fastapi import Request
from pydantic import BaseModel, ConfigDict, Field, StrictInt, ValidationError, field_validator

from backend.finance_db.ledger_service import FinanceCommandError

MAX_REQUEST_BYTES = 32_768
MAX_JS_INT = (1 << 53) - 1
MAX_MINOR = 1_000_000_000_000
UUID_PATTERN = r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"


class Wire(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class ObligationCreate(Wire):
    """Accepted ADR-0065 v1: a planned obligation, not an actual cash posting."""

    title: str = Field(min_length=1, max_length=160)
    direction: Literal["income", "expense"]
    amount_minor: StrictInt = Field(ge=0, le=MAX_MINOR)
    starts_on: str
    timezone: str = Field(min_length=1, max_length=64)
    recurrence_unit: Literal["none", "month", "year"]
    recurrence_every: StrictInt = Field(ge=1, le=120)

    @field_validator("title")
    @classmethod
    def nonblank_title(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Blank obligation title")
        return value

    @field_validator("starts_on")
    @classmethod
    def iso_start_date(cls, value: str) -> str:
        if len(value) != 10 or date.fromisoformat(value).isoformat() != value:
            raise ValueError("Invalid date")
        return value

    @field_validator("timezone")
    @classmethod
    def actual_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except (ValueError, KeyError, ZoneInfoNotFoundError):
            raise ValueError("Unrecognized IANA timezone") from None
        return value


class AccountTransfer(Wire):
    from_account_id: str = Field(pattern=UUID_PATTERN)
    to_account_id: str = Field(pattern=UUID_PATTERN)
    amount_minor: StrictInt = Field(ge=1, le=MAX_MINOR)
    occurred_on: str

    @field_validator("occurred_on")
    @classmethod
    def iso_date(cls, value: str) -> str:
        if len(value) != 10 or date.fromisoformat(value).isoformat() != value:
            raise ValueError("Invalid date")
        return value


class ReserveAllocate(Wire):
    """Move a reservation only, never an actual bank account cash posting."""

    reserve_id: str = Field(pattern=UUID_PATTERN)
    account_id: str = Field(pattern=UUID_PATTERN)
    delta_minor: StrictInt = Field(ge=-MAX_MINOR, le=MAX_MINOR)

    @field_validator("delta_minor")
    @classmethod
    def nonzero_delta(cls, value: int) -> int:
        if value == 0:
            raise ValueError("Reservation delta cannot be zero")
        return value


class TransactionReverse(Wire):
    transaction_id: str = Field(pattern=UUID_PATTERN)
    reason: str = Field(min_length=1, max_length=500)

    @field_validator("reason")
    @classmethod
    def meaningful_reason(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Reason cannot be blank")
        return value


class V1Command(Wire):
    schema_version: Literal[1]

    @field_validator("schema_version", mode="before")
    @classmethod
    def exact_schema_version(cls, value: Any) -> int:
        # Pydantic Literal[1] may coerce bool/1.0 into 1 even when the
        # parent model is strict. Reject the raw wire type before coercion.
        if type(value) is not int or value != 1:
            raise ValueError("Invalid schema version type")
        return value

    client_mutation_id: str = Field(pattern=UUID_PATTERN)
    base_revision: StrictInt = Field(ge=0, le=MAX_JS_INT)
    action: Literal["obligation.create", "account.transfer", "reserve.allocate", "transaction.reverse"]
    expected_entity_revisions: dict[str, StrictInt]
    payload: dict[str, Any]

    @field_validator("expected_entity_revisions")
    @classmethod
    def revisions(cls, versions: dict[str, int]) -> dict[str, int]:
        if len(versions) > 100 or any(
            re.fullmatch(UUID_PATTERN, key) is None
            or value < 1 or value > MAX_JS_INT
            for key, value in versions.items()
        ):
            raise ValueError("Invalid entity revisions")
        return versions


def _reject_duplicate_json_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """Reject parser ambiguities at every JSON object nesting level.

    Some downstream JSON decoders use first-wins while Python defaults to
    last-wins. No mutation may depend on which interpretation was selected.
    """
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Ambiguous JSON object")
        result[key] = value
    return result


async def parse_v1_command(request: Request) -> dict[str, Any]:
    """Read <=32KiB even with transfer-encoding: chunked; fail closed on invalid input.

    No financial fields or Pydantic validation diagnostics are ever logged.
    """
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        raise FinanceCommandError("invalid_command", "Требуется application/json", 422)
    declared = request.headers.get("content-length")
    if declared is not None and (not declared.isdecimal() or int(declared) > MAX_REQUEST_BYTES):
        raise FinanceCommandError("invalid_command", "Слишком большой запрос", 413)
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_REQUEST_BYTES:
            raise FinanceCommandError("invalid_command", "Слишком большой запрос", 413)
        chunks.append(chunk)
    try:
        body = json.loads(
            b"".join(chunks),
            parse_constant=lambda _: (_ for _ in ()).throw(ValueError("non finite")),
            object_pairs_hook=_reject_duplicate_json_keys,
        )
        command = V1Command.model_validate(body)
        model = {
            "obligation.create": ObligationCreate,
            "account.transfer": AccountTransfer,
            "reserve.allocate": ReserveAllocate,
            "transaction.reverse": TransactionReverse,
        }[command.action]
        payload = model.model_validate(command.payload)
        return {**command.model_dump(), "payload": payload.model_dump()}
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError, ValidationError, TypeError, RecursionError):
        raise FinanceCommandError("invalid_command", "Некорректная финансовая команда", 422) from None
