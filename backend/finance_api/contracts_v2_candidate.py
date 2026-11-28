"""Validated account and reserve-plan command v2 proposal for #33/#6/#67.

The existing v2 router handles transport and verified sessions; these
validators have no standalone storage side effects. Reserve CRUD/allocation
is not a complete #6 release: linked cash payment, void, cycles, migrations
and approved UI still require independent acceptance.
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
    "settlement.payment.record", "loan.payment.record",
    "settlement.payment.void", "loan.payment.void",
    "reserve.create", "reserve.update", "reserve.archive", "reserve.allocate",
    "reserve.skip", "reserve.cycle.close", "reserve.cycle.void",
    "reserve.event.void",
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


class SettlementPaymentRecordV2(Wire):
    obligation_id: str = Field(pattern=UUID_PATTERN)
    account_id: str = Field(pattern=UUID_PATTERN)
    amount_minor: StrictInt = Field(ge=1, le=MAX_MINOR)
    paid_on: str
    occurrence_on: str
    reserve_id: str | None = Field(default=None, pattern=UUID_PATTERN)
    reserved_used_minor: StrictInt | None = Field(default=None, ge=0, le=MAX_MINOR)

    @model_validator(mode="after")
    def reserve_link(self):
        if (self.reserve_id is None) != (self.reserved_used_minor is None):
            raise ValueError("Linked reserve and amount must be supplied together")
        if self.reserved_used_minor is not None and self.reserved_used_minor > self.amount_minor:
            raise ValueError("Reserved amount exceeds paid amount")
        return self

    @field_validator("paid_on", "occurrence_on")
    @classmethod
    def iso_date(cls, value: str) -> str:
        return _date(value)


class LoanPaymentRecordV2(Wire):
    loan_id: str = Field(pattern=UUID_PATTERN)
    account_id: str = Field(pattern=UUID_PATTERN)
    amount_minor: StrictInt = Field(ge=1, le=MAX_MINOR)
    paid_on: str
    strategy: Literal["term", "amount"]

    @field_validator("paid_on")
    @classmethod
    def iso_date(cls, value: str) -> str:
        return _date(value)


class PaymentVoidV2(Wire):
    transaction_id: str = Field(pattern=UUID_PATTERN)
    fact_id: str = Field(pattern=UUID_PATTERN)
    account_id: str = Field(pattern=UUID_PATTERN)
    reason: str = Field(min_length=1, max_length=500)
    reserve_id: str | None = Field(default=None, pattern=UUID_PATTERN)

    @field_validator("reason")
    @classmethod
    def nonblank_reason(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Reason cannot be blank")
        return value


class ReservePlanFields(Wire):
    title: str = Field(min_length=1, max_length=160)
    target_minor: StrictInt = Field(ge=1, le=MAX_MINOR)
    first_due_on: str
    period_months: StrictInt = Field(ge=1, le=60)
    due_day: StrictInt = Field(ge=1, le=31)
    contribution_mode: Literal["auto", "fixed"]
    fixed_monthly_minor: StrictInt | None = Field(default=None, ge=1, le=MAX_MINOR)

    @field_validator("title")
    @classmethod
    def reserve_title(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Reserve title cannot be blank")
        return value

    @field_validator("first_due_on")
    @classmethod
    def due_date(cls, value: str) -> str:
        return _date(value)

    @model_validator(mode="after")
    def check_fixed_amount(self):
        if (self.contribution_mode == "fixed") != (self.fixed_monthly_minor is not None):
            raise ValueError("Fixed contributions require exactly one fixed amount")
        return self


class ReserveCreateV2(ReservePlanFields):
    id: str = Field(pattern=UUID_PATTERN)
    obligation_id: str = Field(pattern=UUID_PATTERN)
    account_id: str = Field(pattern=UUID_PATTERN)
    opened_on: str
    opening_reserved_minor: StrictInt = Field(ge=0, le=MAX_MINOR)

    @field_validator("opened_on")
    @classmethod
    def opening_date(cls, value: str) -> str:
        return _date(value)

class ReserveUpdateV2(ReservePlanFields):
    reserve_id: str = Field(pattern=UUID_PATTERN)
    occurred_on: str | None = None

    @field_validator("occurred_on")
    @classmethod
    def validate_change_date(cls, value: str | None) -> str | None:
        return _date(value) if value is not None else None


class ReserveArchiveV2(Wire):
    reserve_id: str = Field(pattern=UUID_PATTERN)


class ReserveAllocationV2(Wire):
    reserve_id: str = Field(pattern=UUID_PATTERN)
    account_id: str = Field(pattern=UUID_PATTERN)
    delta_minor: StrictInt = Field(ge=-MAX_MINOR, le=MAX_MINOR)
    occurred_on: str | None = None

    @field_validator("occurred_on")
    @classmethod
    def validate_allocation_date(cls, value: str | None) -> str | None:
        return _date(value) if value is not None else None

    @field_validator("delta_minor")
    @classmethod
    def reject_zero(cls, value: int) -> int:
        if value == 0:
            raise ValueError("Reserve change must be nonzero")
        return value



class ReserveSkipV2(Wire):
    reserve_id: str = Field(pattern=UUID_PATTERN)
    slot_on: str
    occurred_on: str

    @field_validator("slot_on", "occurred_on")
    @classmethod
    def check_dates(cls, value: str) -> str:
        return _date(value)


class ReserveCycleCloseV2(Wire):
    reserve_id: str = Field(pattern=UUID_PATTERN)
    occurred_on: str

    @field_validator("occurred_on")
    @classmethod
    def check_date(cls, value: str) -> str:
        return _date(value)




class ReserveCycleVoidV2(Wire):
    reserve_id: str = Field(pattern=UUID_PATTERN)
    occurred_on: str
    reason: str = Field(min_length=1, max_length=500)

    @field_validator("occurred_on")
    @classmethod
    def check_date(cls, value: str) -> str:
        return _date(value)

    @field_validator("reason")
    @classmethod
    def meaningful_reason(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Reason must not be blank")
        return value


class ReserveEventVoidV2(Wire):
    reserve_id: str = Field(pattern=UUID_PATTERN)
    account_id: str = Field(pattern=UUID_PATTERN)
    target_event_id: str = Field(pattern=UUID_PATTERN)
    occurred_on: str
    reason: str = Field(min_length=1, max_length=500)

    @field_validator("occurred_on")
    @classmethod
    def check_date(cls, value: str) -> str:
        return _date(value)

    @field_validator("reason")
    @classmethod
    def meaningful_reason(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Reason must not be blank")
        return value


_PAYLOADS = {
    "account.create": AccountCreateV2,
    "account.update": AccountUpdateV2,
    "account.archive": AccountArchiveV2,
    "account.unarchive": AccountArchiveV2,
    "transaction.record": TransactionRecordV2,
    "settlement.payment.record": SettlementPaymentRecordV2,
    "loan.payment.record": LoanPaymentRecordV2,
    "settlement.payment.void": PaymentVoidV2,
    "loan.payment.void": PaymentVoidV2,
    "reserve.create": ReserveCreateV2,
    "reserve.update": ReserveUpdateV2,
    "reserve.archive": ReserveArchiveV2,
    "reserve.allocate": ReserveAllocationV2,
    "reserve.skip": ReserveSkipV2,
    "reserve.cycle.close": ReserveCycleCloseV2,
    "reserve.cycle.void": ReserveCycleVoidV2,
    "reserve.event.void": ReserveEventVoidV2,
}


class AccountV2Candidate(Wire):
    schema_version: Literal[2]
    client_mutation_id: str = Field(pattern=UUID_PATTERN)
    base_revision: StrictInt = Field(ge=0, le=MAX_JS_INT)
    action: Literal[
        "account.create", "account.update", "account.archive",
        "account.unarchive", "transaction.record",
        "settlement.payment.record", "loan.payment.record",
        "settlement.payment.void", "loan.payment.void",
        "reserve.create", "reserve.update", "reserve.archive", "reserve.allocate",
        "reserve.skip", "reserve.cycle.close", "reserve.cycle.void",
        "reserve.event.void",
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


class BudgetCategoryWriteV2(Wire):
    id: str = Field(pattern=UUID_PATTERN)
    name: str = Field(min_length=1, max_length=40)

    @field_validator("name")
    @classmethod
    def category_name(cls, value):
        if value != value.strip() or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError("Invalid category name")
        return value


class BudgetCategoryArchiveV2(Wire):
    id: str = Field(pattern=UUID_PATTERN)


_MONTH_PATTERN = r"^[0-9]{4}-(0[1-9]|1[0-2])$"


class BudgetCreateV2(Wire):
    id: str = Field(pattern=UUID_PATTERN)
    category_id: str | None = Field(pattern=UUID_PATTERN)
    limit_minor: StrictInt = Field(ge=0, le=MAX_MINOR)
    recurrence: Literal["once", "monthly"]
    from_month: str = Field(pattern=_MONTH_PATTERN)
    ends_before_month: str | None = Field(default=None, pattern=_MONTH_PATTERN)

    @model_validator(mode="after")
    def month_bounds(self):
        if self.from_month.startswith("0000") or (
            self.ends_before_month is not None and self.ends_before_month <= self.from_month
        ):
            raise ValueError("Invalid budget interval")
        return self


class BudgetAmendV2(Wire):
    rule_id: str = Field(pattern=UUID_PATTERN)
    effective_from_month: str = Field(pattern=_MONTH_PATTERN)
    replacement_id: str = Field(pattern=UUID_PATTERN)
    limit_minor: StrictInt = Field(ge=0, le=MAX_MINOR)

    @field_validator("effective_from_month")
    @classmethod
    def valid_month(cls, value):
        if value.startswith("0000"):
            raise ValueError("Invalid budget month")
        return value


class BudgetArchiveV2(Wire):
    rule_id: str = Field(pattern=UUID_PATTERN)
    archived_from_month: str = Field(pattern=_MONTH_PATTERN)

    @field_validator("archived_from_month")
    @classmethod
    def valid_month(cls, value):
        if value.startswith("0000"):
            raise ValueError("Invalid budget month")
        return value


class BudgetAssignmentV2(Wire):
    transaction_id: str = Field(pattern=UUID_PATTERN)
    category_id: str | None = Field(pattern=UUID_PATTERN)


_BUDGET_PAYLOADS = {
    "budget.category.create": BudgetCategoryWriteV2,
    "budget.category.rename": BudgetCategoryWriteV2,
    "budget.category.archive": BudgetCategoryArchiveV2,
    "budget.create": BudgetCreateV2,
    "budget.amend": BudgetAmendV2,
    "budget.archive": BudgetArchiveV2,
    "budget.category.assign": BudgetAssignmentV2,
}


class BudgetV2Candidate(AccountV2Candidate):
    action: Literal[
        "budget.category.create", "budget.category.rename", "budget.category.archive",
        "budget.create", "budget.amend", "budget.archive", "budget.category.assign",
    ]


def validate_v2_budget_candidate(
    command: object, *, if_match: str, idempotency_key: str,
) -> dict[str, Any]:
    candidate = BudgetV2Candidate.model_validate(command)
    if (not isinstance(if_match, str) or re.fullmatch(r'"[^"\r\n]{1,254}"', if_match) is None
            or idempotency_key != candidate.client_mutation_id):
        raise ValueError("Missing budget preconditions")
    payload = _BUDGET_PAYLOADS[candidate.action].model_validate(candidate.payload)
    action = candidate.action
    if action in ("budget.create", "budget.category.create"):
        expected = set()
    elif action in ("budget.amend", "budget.archive"):
        expected = {payload.rule_id}
    elif action == "budget.category.assign":
        expected = {payload.transaction_id}
    else:
        expected = {payload.id}
    if set(candidate.expected_entity_revisions) != expected:
        raise ValueError("Missing or extraneous budget entity revisions")
    return {**candidate.model_dump(), "payload": payload.model_dump(exclude_unset=True)}


class GoalV2Candidate(AccountV2Candidate):
    action: Literal["goal.append"]


def validate_v2_goal_candidate(
    command: object, *, if_match: str, idempotency_key: str,
) -> dict[str, Any]:
    from backend.finance_db.goal_service import validate_goal_payload
    candidate = GoalV2Candidate.model_validate(command)
    if (not isinstance(if_match, str) or re.fullmatch(r'"[^"\r\n]{1,254}"', if_match) is None
            or idempotency_key != candidate.client_mutation_id):
        raise ValueError("Missing goal preconditions")
    body = candidate.model_dump()
    validate_goal_payload(body)
    return body


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
    if candidate.action == "account.create":
        required = set()
    elif candidate.action == "reserve.create":
        required = {payload.account_id, payload.obligation_id}
    elif candidate.action in ("reserve.allocate", "reserve.event.void"):
        required = {payload.account_id, payload.reserve_id}
    elif candidate.action in ("reserve.update", "reserve.archive",
                                   "reserve.skip", "reserve.cycle.close",
                                   "reserve.cycle.void"):
        required = {payload.reserve_id}
    elif candidate.action == "settlement.payment.record":
        required = {payload.account_id, payload.obligation_id}
        if payload.reserve_id is not None:
            required.add(payload.reserve_id)
    elif candidate.action == "loan.payment.record":
        required = {payload.account_id, payload.loan_id}
    elif candidate.action.endswith(".payment.void"):
        required = {payload.account_id, payload.transaction_id, payload.fact_id}
        if payload.reserve_id is not None:
            required.add(payload.reserve_id)
    else:
        required = {payload.account_id}
    if set(candidate.expected_entity_revisions) != required:
        raise ValueError("Missing or extraneous account entity revisions")
    return {
        **candidate.model_dump(),
        "payload": payload.model_dump(exclude_unset=True),
    }

async def parse_v2_account_command(request: Request, *, allow_budget: bool = False,
                                   allow_goal: bool = False) -> dict[str, Any]:
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
    if re.fullmatch(r'"[^"\r\n]{1,254}"', if_match) is None:
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
        validator = (
            validate_v2_goal_candidate if allow_goal and isinstance(raw, dict)
            and raw.get("action") == "goal.append"
            else validate_v2_budget_candidate if allow_budget and isinstance(raw, dict)
            and isinstance(raw.get("action"), str) and raw["action"].startswith("budget.")
            else validate_v2_account_candidate
        )
        return validator(
            raw,
            if_match=request.headers.get("if-match", ""),
            idempotency_key=request.headers.get("idempotency-key", ""),
        )
    except (ValueError, TypeError, UnicodeDecodeError, RecursionError, OverflowError):
        # Never echo malformed JSON or Pydantic validation details.
        raise FinanceCommandError(
            "invalid_command", "Некорректная финансовая команда", 422,
        ) from None
